import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { renderMessage, formatObsLine, OBS_LINE_FALLBACK, KIND_LABEL, GRADE_LABEL,
  type DeptBlock } from "../_shared/template.ts";
import { withCors } from "../_shared/cors.ts";

const env = (k: string) => Deno.env.get(k);

async function currentEmployee(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const anon = createClient(env("SUPABASE_URL")!, env("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return null;
  const db = serviceClient();
  const { data } = await db.from("employees").select("*").eq("auth_user_id", user.id).single();
  return data;
}

// 승인 권한은 역할이 아니라 alert_recipients 등록 여부가 결정한다(스펙 2026-08-13).
// send는 service role로 동작해 RLS를 우회하므로 current_emp_is_approver()를 쓰지 않고 직접 조회한다.
async function isAlertRecipient(db: any, employeeId: string): Promise<boolean> {
  const { data } = await db.from("alert_recipients")
    .select("employee_id").eq("employee_id", employeeId).maybeSingle();
  return data !== null;
}

// 특보를 발생시킨 관측 행을 읽어 weather-tick의 반복 발송과 동일한 포맷의 "현재 관측" 줄을 만든다
// (스펙 결정 11 — 사람이 승인한 최초 발송이 자동 반복 발송보다 빈약해서는 안 됨).
// 관측 조회에 실패한 경우에만 폴백 문구를 쓴다.
async function obsLineFor(db: any, ev: { trigger_observation_id?: number|null }): Promise<string> {
  if (!ev?.trigger_observation_id) return OBS_LINE_FALLBACK;
  const { data: obs } = await db.from("weather_observations")
    .select("rain_mm_per_hr, temp_c, feels_c, wind_ms")
    .eq("id", ev.trigger_observation_id).maybeSingle();
  return formatObsLine(obs);
}

async function dispatch(db: any, channel: any, msg: any, blocks: DeptBlock[],
    ctx: { kind: string; grade: string; site: string; obsLine: string }, repeatNo: number, isTest = false) {
  const results: unknown[] = [];
  for (const b of blocks.filter(b => b.selected))
    for (const r of b.recipients)
      results.push({ employee_id: r.employee_id, name: r.name,
        ...(r.kakaowork_user_id
          ? await channel.send(r.kakaowork_user_id, renderMessage(b, {
              kindLabel: KIND_LABEL[ctx.kind as never], gradeLabel: GRADE_LABEL[ctx.grade as never],
              siteName: ctx.site, obsLine: ctx.obsLine }))
          : { ok: false, error: "카카오워크 미연결" }) });
  const { data: d } = await db.from("dispatches").insert({
    message_id: msg.id, event_id: msg.event_id, repeat_no: repeatNo, is_test: isTest, results,
    content: blocks,
  }).select().single();
  return { dispatch_id: d.id, repeat_no: repeatNo, obs_line: ctx.obsLine,
    fail_count: (results as any[]).filter(r => !r.ok).length };
}

Deno.serve(withCors(async (req) => {
  const emp = await currentEmployee(req);
  if (!emp) return new Response("unauthorized", { status: 401 });
  const body = await req.json();
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const { data: site } = await db.from("site_settings").select("site_name").single();
  const siteName: string = site?.site_name ?? "날씨경영";   // 단일 행 시드가 항상 존재하지만 타입상 null 가드

  if (body.mode === "test") {
    if (emp.role !== "admin") return new Response("forbidden", { status: 403 });
    if (!emp.kakaowork_user_id) return Response.json({ ok:false, error:"카카오워크 미연결" }, { status: 400 });
    const r = await channel.send(emp.kakaowork_user_id, `[날씨경영] 테스트 메시지입니다. 설정이 정상 동작합니다.`);
    return Response.json({ ok: r.ok, error: r.error });
  }

  if (!(await isAlertRecipient(db, emp.id))) return new Response("forbidden", { status: 403 }); // 승인은 Alert 수신자 전용

  if (body.mode === "approve") {
    const { data: ev } = await db.from("weather_events").select("*").eq("id", body.event_id).single();
    if (!ev || ev.status !== "PENDING_APPROVAL") return Response.json({ ok:false, error:"승인 가능한 상태가 아닙니다" }, { status: 409 });
    const { data: msg } = await db.from("messages").update({
      content: body.content, status:"approved", updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("event_id", ev.id).select().single();
    // 회차 채번은 weather_events.repeat_count 단일 소스 — 승인 발송이 1회차.
    await db.from("weather_events").update({ status:"ACTIVE", approved_by: emp.id,
      repeat_count: 1, approved_at: new Date().toISOString() }).eq("id", ev.id);
    const out = await dispatch(db, channel, msg, body.content,
      { kind: ev.kind, grade: ev.grade, site: siteName, obsLine: await obsLineFor(db, ev) }, 1);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "resend") {
    const { data: msg } = await db.from("messages").update({
      content: body.content, updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("id", body.message_id).select().single();
    const { data: ev } = await db.from("weather_events").select("*").eq("id", msg.event_id).single();
    // 재발송도 회차를 증가시킨다(이력상 자연스러움) — dispatches 건수가 아닌 repeat_count 기준.
    const repeatNo = (ev.repeat_count ?? 0) + 1;
    await db.from("weather_events").update({ repeat_count: repeatNo }).eq("id", ev.id);
    const out = await dispatch(db, channel, msg, body.content,
      { kind: ev.kind, grade: ev.grade, site: siteName, obsLine: await obsLineFor(db, ev) }, repeatNo);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "dismiss") {
    const { data: updated } = await db.from("weather_events").update({ status:"DISMISSED" })
      .eq("id", body.event_id).eq("status","PENDING_APPROVAL").select();
    if (!updated || updated.length === 0) return Response.json({ ok:false, error:"무시 가능한 상태가 아닙니다" }, { status: 409 });
    return Response.json({ ok: true });
  }

  return new Response("bad request", { status: 400 });
}));
