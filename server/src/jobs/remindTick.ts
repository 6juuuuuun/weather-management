// supabase/functions/remind-tick/index.ts 이식. DB 접근만 SQL로 바꾸고 Deno.serve를 걷어냈다.
import { withService } from "../db.ts";
import { KIND_LABEL, GRADE_LABEL } from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import type { Kind, Grade } from "../shared/types.ts";
import { env, envChannel, alertRecipientKakaoIds } from "./common.ts";
import { upsertHeartbeat } from "./weatherTick.ts";

type PendingEvent = { id: string; kind: Kind; grade: Grade };

export async function runRemindTick(
  deps: { channel?: NotificationChannel } = {},
): Promise<{ reminded: number }> {
  const channel = deps.channel ?? envChannel();
  const now = new Date();

  const { due, alertIds } = await withService(async (q) => {
    const { rows: siteRows } = await q.query("select remind_interval_min from site_settings limit 1");
    const cutoff = new Date(now.getTime() - (siteRows[0]?.remind_interval_min ?? 30) * 60_000);
    // 원본은 PENDING 전체를 받아 와 JS에서 (last_reminded_at ?? detected_at) <= cutoff로 걸렀다.
    // pg는 timestamptz를 Date로 돌려주므로 문자열 비교를 그대로 옮기면 뜻이 달라진다 —
    // 같은 판정을 SQL의 coalesce로 옮겨 시각 비교를 Postgres 한쪽에 맡긴다.
    const { rows } = await q.query(
      `select id, kind, grade from weather_events
        where status = 'PENDING_APPROVAL' and coalesce(last_reminded_at, detected_at) <= $1`,
      [cutoff],
    );
    return { due: rows as PendingEvent[], alertIds: await alertRecipientKakaoIds(q) };
  });

  let reminded = 0;
  for (const e of due) {
    // 발송(네트워크)은 트랜잭션 밖에서 한다.
    for (const kw of alertIds)
      await channel.send(kw,
        `[날씨경영] (재알림) ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 아직 승인 대기 중입니다.\n검토: ${env("APP_BASE_URL")}/events/${e.id}`);
    await withService((q) =>
      q.query("update weather_events set last_reminded_at = $2 where id = $1", [e.id, new Date()]));
    reminded++;
  }
  await upsertHeartbeat("remind-tick", new Date(), true, null);
  return { reminded };
}
