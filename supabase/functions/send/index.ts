import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { renderMessage, KIND_LABEL, GRADE_LABEL, type DeptBlock } from "../_shared/template.ts";

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

async function dispatch(db: any, channel: any, msg: any, blocks: DeptBlock[],
    ctx: { kind: string; grade: string; site: string }, repeatNo: number, isTest = false) {
  const results: unknown[] = [];
  for (const b of blocks.filter(b => b.selected))
    for (const r of b.recipients)
      results.push({ employee_id: r.employee_id, name: r.name,
        ...(r.kakaowork_user_id
          ? await channel.send(r.kakaowork_user_id, renderMessage(b, {
              kindLabel: KIND_LABEL[ctx.kind as never], gradeLabel: GRADE_LABEL[ctx.grade as never],
              siteName: ctx.site, obsLine: "발송 시점 상세는 대시보드 참조" }))
          : { ok: false, error: "카카오워크 미연결" }) });
  const { data: d } = await db.from("dispatches").insert({
    message_id: msg.id, event_id: msg.event_id, repeat_no: repeatNo, is_test: isTest, results,
  }).select().single();
  return { dispatch_id: d.id, fail_count: (results as any[]).filter(r => !r.ok).length };
}

Deno.serve(async (req) => {
  const emp = await currentEmployee(req);
  if (!emp) return new Response("unauthorized", { status: 401 });
  const body = await req.json();
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const { data: site } = await db.from("site_settings").select("site_name").single();

  if (body.mode === "test") {
    if (emp.role !== "admin") return new Response("forbidden", { status: 403 });
    if (!emp.kakaowork_user_id) return Response.json({ ok:false, error:"카카오워크 미연결" }, { status: 400 });
    const r = await channel.send(emp.kakaowork_user_id, `[날씨경영] 테스트 메시지입니다. 설정이 정상 동작합니다.`);
    return Response.json({ ok: r.ok, error: r.error });
  }

  if (emp.role !== "approver" && emp.role !== "admin") return new Response("forbidden", { status: 403 });
  if (emp.role !== "approver") return new Response("forbidden", { status: 403 }); // 승인은 approver 전용

  if (body.mode === "approve") {
    const { data: ev } = await db.from("weather_events").select("*").eq("id", body.event_id).single();
    if (!ev || ev.status !== "PENDING_APPROVAL") return Response.json({ ok:false, error:"승인 가능한 상태가 아닙니다" }, { status: 409 });
    const { data: msg } = await db.from("messages").update({
      content: body.content, status:"approved", updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("event_id", ev.id).select().single();
    await db.from("weather_events").update({ status:"ACTIVE", approved_by: emp.id,
      approved_at: new Date().toISOString() }).eq("id", ev.id);
    const out = await dispatch(db, channel, msg, body.content, { kind: ev.kind, grade: ev.grade, site: site.site_name }, 1);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "resend") {
    const { data: msg } = await db.from("messages").update({
      content: body.content, updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("id", body.message_id).select().single();
    const { data: ev } = await db.from("weather_events").select("*").eq("id", msg.event_id).single();
    const { count } = await db.from("dispatches").select("*", { count:"exact", head:true }).eq("event_id", ev.id);
    const out = await dispatch(db, channel, msg, body.content, { kind: ev.kind, grade: ev.grade, site: site.site_name }, (count ?? 0) + 1);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "dismiss") {
    await db.from("weather_events").update({ status:"DISMISSED" }).eq("id", body.event_id).eq("status","PENDING_APPROVAL");
    return Response.json({ ok: true });
  }

  return new Response("bad request", { status: 400 });
});
