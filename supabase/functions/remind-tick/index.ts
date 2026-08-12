import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { KIND_LABEL, GRADE_LABEL } from "../_shared/template.ts";

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const { data: site } = await db.from("site_settings").select("remind_interval_min").single();
  const cutoff = new Date(Date.now() - (site?.remind_interval_min ?? 30) * 60_000).toISOString();
  const { data: pend } = await db.from("weather_events").select("*").eq("status","PENDING_APPROVAL");
  const due = (pend ?? []).filter((e: any) => (e.last_reminded_at ?? e.detected_at) <= cutoff);
  const { data: alerts } = await db.from("alert_recipients").select("employees(kakaowork_user_id)");
  let reminded = 0;
  for (const e of due) {
    for (const a of alerts ?? []) if ((a as any).employees?.kakaowork_user_id)
      await channel.send((a as any).employees.kakaowork_user_id,
        `[날씨경영] (재알림) ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 아직 승인 대기 중입니다.\n검토: ${env("APP_BASE_URL")}/events/${e.id}`);
    await db.from("weather_events").update({ last_reminded_at: new Date().toISOString() }).eq("id", e.id);
    reminded++;
  }
  await db.from("heartbeats").upsert({ name:"remind-tick", last_run_at: new Date().toISOString(), ok:true });
  return Response.json({ ok: true, reminded });
});
