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

  const { due, alertIds } = await withService(async (q) => {
    const { rows: siteRows } = await q.query("select remind_interval_min from site_settings limit 1");
    const intervalMin = String(siteRows[0]?.remind_interval_min ?? 30);
    // 원본은 PENDING 전체를 받아 와 JS에서 (last_reminded_at ?? detected_at) <= cutoff로 걸렀다.
    // pg는 timestamptz를 Date로 돌려주므로 문자열 비교를 그대로 옮기면 뜻이 달라진다 —
    // 같은 판정을 SQL의 coalesce로 옮겨 시각 비교를 Postgres 한쪽에 맡긴다.
    //
    // 기준 시각(cutoff)도 Node의 new Date()가 아니라 Postgres의 now()로 만든다.
    // detected_at·last_reminded_at은 Postgres가 찍은 값이라, 앱 컨테이너 시계가
    // DB와 어긋나면 그 차이만큼 재알림이 이르거나 늦는다 — 비교하는 두 값이 같은
    // 시계에서 나와야 한다(scheduler.ts·watchdog.ts와 같은 처방).
    const { rows } = await q.query(
      `select id, kind, grade from weather_events
        where status = 'PENDING_APPROVAL'
          and coalesce(last_reminded_at, detected_at) <= now() - ($1 || ' minutes')::interval`,
      [intervalMin],
    );
    return { due: rows as PendingEvent[], alertIds: await alertRecipientKakaoIds(q) };
  });

  let reminded = 0;
  for (const e of due) {
    // 발송(네트워크)은 트랜잭션 밖에서 한다.
    for (const kw of alertIds)
      await channel.send(kw,
        `[날씨경영] (재알림) ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 아직 승인 대기 중입니다.\n검토: ${env("APP_BASE_URL")}/events/${e.id}`);
    // last_reminded_at도 Postgres 시계로 찍는다 — 바로 위 cutoff 비교가 그 값을
    // now()와 견주므로, 여기서 앱 시계를 쓰면 다시 두 시계가 섞인다.
    await withService((q) =>
      q.query("update weather_events set last_reminded_at = now() where id = $1", [e.id]));
    reminded++;
  }
  await upsertHeartbeat("remind-tick", true, null);
  return { reminded };
}
