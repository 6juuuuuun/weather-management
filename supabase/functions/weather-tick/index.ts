import { serviceClient, loadEngineInputs, todayAccums } from "../_shared/db.ts";
import { fetchObservation, parseKmaResponse } from "../_shared/kma.ts";
import { feelsLikeC, snowNewCm } from "../_shared/derive.ts";
import { evaluate } from "../_shared/engine.ts";
import { composeDraft, renderMessage, formatObsLine, KIND_LABEL, GRADE_LABEL, type DeptBlock } from "../_shared/template.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import type { Kind, Grade, Obs } from "../_shared/types.ts";

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const now = new Date();
  const { criteria, settings, open, site } = await loadEngineInputs(db);

  // 1. 관측
  let obsRow: Record<string, unknown>;
  const mock = req.headers.get("x-mock-kma");
  try {
    const k = mock ? parseKmaResponse(JSON.parse(mock))
      : await fetchObservation(env("KMA_API_KEY")!, site.nx, site.ny, now);
    const feels = (k.tempC !== null && k.humidityPct !== null && k.windMs !== null)
      ? feelsLikeC(k.tempC, k.humidityPct, k.windMs) : null;
    obsRow = { observed_at: k.observedAt.toISOString(), rain_mm_per_hr: k.rainMmPerHr,
      temp_c: k.tempC, wind_ms: k.windMs, humidity_pct: k.humidityPct,
      snow_new_cm: snowNewCm(k.rainMmPerHr, k.pty), feels_c: feels, raw: k, missing: false };
  } catch (e) {
    obsRow = { observed_at: new Date(Math.floor(now.getTime()/3600_000)*3600_000).toISOString(),
      missing: true, raw: { error: String(e) } };
  }
  const { data: saved } = await db.from("weather_observations")
    .upsert(obsRow, { onConflict: "observed_at" }).select().single();

  // 결측 3연속 → admin 알림, 판정 스킵
  if (saved.missing) {
    const { data: last3 } = await db.from("weather_observations")
      .select("missing").order("observed_at", { ascending: false }).limit(3);
    if (last3?.length === 3 && last3.every((r: any) => r.missing)) {
      const { data: admins } = await db.from("employees").select("kakaowork_user_id").eq("role","admin");
      for (const a of admins ?? []) if (a.kakaowork_user_id)
        await channel.send(a.kakaowork_user_id, "[날씨경영] 날씨 수집이 3시간 연속 실패했습니다. 시스템을 확인해 주세요.");
    }
    await db.from("heartbeats").upsert({ name:"weather-tick", last_run_at: now.toISOString(), ok:false, note:"missing" });
    return Response.json({ ok: true, actions: [] });
  }

  // 2~3. 판정
  const acc = await todayAccums(db, now);
  const obs: Obs = { rain: saved.rain_mm_per_hr, snowNew: saved.snow_new_cm,
    snowToday: acc.snowToday, rainToday: acc.rainToday,
    temp: saved.temp_c, feels: saved.feels_c, wind: saved.wind_ms };
  const actions = evaluate(obs, criteria, settings, open);

  const obsLine = formatObsLine(saved);

  async function createEvent(kind: Kind, grade: Grade) {
    const { data: ev } = await db.from("weather_events")
      .insert({ kind, grade, trigger_observation_id: saved.id }).select().single();
    const { data: gRows } = await db.from("action_guidelines")
      .select("department_id, kind, grade, staff_actions, guest_notice, departments(name)")
      .eq("kind", kind).eq("grade", grade);
    const { data: rRows } = await db.from("recipients")
      .select("department_id, employee_id, employees(name, kakaowork_user_id)");
    const blocks = composeDraft(kind, grade,
      (gRows ?? []).map((g: any) => ({ ...g, department_name: g.departments.name })),
      (rRows ?? []).map((r: any) => ({ department_id: r.department_id, employee_id: r.employee_id,
        name: r.employees.name, kakaowork_user_id: r.employees.kakaowork_user_id })));
    await db.from("messages").insert({ event_id: ev.id, content: blocks });
    const { data: alerts } = await db.from("alert_recipients").select("employees(kakaowork_user_id)");
    const deepLink = `${env("APP_BASE_URL")}/events/${ev.id}`;
    for (const a of alerts ?? []) if ((a as any).employees?.kakaowork_user_id)
      await channel.send((a as any).employees.kakaowork_user_id,
        `[날씨경영] ${KIND_LABEL[kind]} ${GRADE_LABEL[grade]} 감지 — 발송 초안이 승인을 기다립니다.\n${obsLine}\n검토: ${deepLink}`);
  }

  for (const a of actions) {
    if (a.type === "create") await createEvent(a.kind, a.grade);
    if (a.type === "escalate") {
      await db.from("weather_events").update({ status:"ESCALATED", closed_at: now.toISOString() }).eq("id", a.eventId);
      await createEvent(a.kind, "warning");
    }
    if (a.type === "repeat") {
      const { data: msg } = await db.from("messages").select("*")
        .eq("event_id", a.eventId).eq("status","approved").single();
      if (msg) {
        const results: unknown[] = [];
        for (const b of (msg.content as DeptBlock[]).filter(b => b.selected))
          for (const r of b.recipients)
            results.push({ employee_id: r.employee_id, name: r.name,
              ...(r.kakaowork_user_id
                ? await channel.send(r.kakaowork_user_id, renderMessage(b, { kindLabel: KIND_LABEL[a.kind],
                    gradeLabel: GRADE_LABEL[a.grade], siteName: site.site_name, obsLine }))
                : { ok: false, error: "카카오워크 미연결" }) });
        // 회차 채번은 weather_events.repeat_count 단일 소스 (승인 발송이 1회차 → 이후 +1씩).
        const { data: ev } = await db.from("weather_events").select("repeat_count").eq("id", a.eventId).single();
        const repeatNo = (ev?.repeat_count ?? 0) + 1;
        await db.from("dispatches").insert({ message_id: msg.id, event_id: a.eventId,
          repeat_no: repeatNo, results, content: (msg.content as DeptBlock[]) });
        await db.from("weather_events").update({ repeat_count: repeatNo }).eq("id", a.eventId);
      }
    }
    if (a.type === "resolve") {
      // 승인된 메시지 존재 여부로 분기 (스펙 오너 추가 결정, 2026-08-12):
      // - approved 메시지 있음 (ACTIVE였던 경우): 기존대로 resolve_notice에 따라 발송받았던 부서에 해제 알림
      // - approved 메시지 없음 (PENDING_APPROVAL 중 자동 종료): alert_recipients 전원에게 초안 자동 종료 알림
      const { data: approvedMsg } = await db.from("messages").select("content")
        .eq("event_id", a.eventId).eq("status","approved").maybeSingle();
      await db.from("weather_events").update({ status:"RESOLVED", closed_at: now.toISOString() }).eq("id", a.eventId);
      if (approvedMsg) {
        if (site.resolve_notice) {
          for (const b of ((approvedMsg.content ?? []) as DeptBlock[]).filter(b => b.selected))
            for (const r of b.recipients) if (r.kakaowork_user_id)
              await channel.send(r.kakaowork_user_id,
                `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되었습니다. 조치해 주셔서 감사합니다.`);
        }
      } else {
        const { data: alerts } = await db.from("alert_recipients").select("employees(kakaowork_user_id)");
        for (const al of alerts ?? []) if ((al as any).employees?.kakaowork_user_id)
          await channel.send((al as any).employees.kakaowork_user_id,
            `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되어 승인 대기 초안이 자동 종료되었습니다`);
      }
    }
  }

  await db.from("heartbeats").upsert({ name:"weather-tick", last_run_at: now.toISOString(), ok:true, note:null });
  return Response.json({ ok: true, actions });
});
