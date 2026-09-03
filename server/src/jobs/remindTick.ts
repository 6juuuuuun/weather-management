// supabase/functions/remind-tick/index.ts 이식. DB 접근만 SQL로 바꾸고 Deno.serve를 걷어냈다.
import { withService } from "../db.ts";
import { KIND_LABEL, GRADE_LABEL } from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import type { Kind, Grade } from "../shared/types.ts";
import { env, envChannel, alertRecipientPhones } from "./common.ts";
import { sendablePhoneSql } from "../phone.ts";
import { todayAccums, upsertHeartbeat } from "./weatherTick.ts";
import { formatObsLine } from "../shared/template.ts";

type PendingEvent = { id: string; kind: Kind; grade: Grade; remind_count: number };

/** 재알림 상한. 이 횟수를 채우면 재알림을 멈추고 관리자에게 넘긴다.
 *
 * 지금까지는 종료 조건이 아예 없어서, 승인자가 휴가면 특보가 해제될 때까지
 * 30분마다 무한히 DM이 갔다 — 그 뒤엔 그 사람도, 옆 사람도 이 봇의 메시지를
 * 읽지 않게 된다. 기본 주기(remind_interval_min = 30분)에서 6회는 **3시간**이다:
 * 야간 근무 교대 한 텀보다 짧고, 사람이 자리를 비웠다고 판단하기에는 충분히 길다.
 * 상한을 시간이 아니라 횟수로 두는 이유는 주기를 관리자가 바꿀 수 있기 때문이다 —
 * 주기를 늘리면 상한까지의 시간도 함께 늘어나는 쪽이 뜻이 맞는다.
 * (사용자 결정: 상한을 두고, 도달하면 관리자에게 따로 알린다.) */
export const REMIND_LIMIT = 6;

export async function runRemindTick(
  deps: { channel?: NotificationChannel } = {},
): Promise<{ reminded: number; escalated: number }> {
  const channel = deps.channel ?? envChannel();

  const { due, alertIds, obs, snowToday, adminIds, intervalMin } = await withService(async (q) => {
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
      // 상한에 도달한 건은 아예 뽑지 않는다 — 이미 관리자에게 넘겼다.
      `select id, kind, grade, remind_count from weather_events
        where status = 'PENDING_APPROVAL'
          and remind_count < $2
          and coalesce(last_reminded_at, detected_at) <= now() - ($1 || ' minutes')::interval`,
      [intervalMin, REMIND_LIMIT],
    );
    // 재알림에 지금 날씨가 없으면 승인자는 상황이 나아졌는지 알 수 없어 매번 링크를
    // 눌러야 한다(QA W-26). 최초 감지 알림·반복 발송과 같은 포맷을 쓴다.
    const { rows: obsRows } = await q.query(
      `select rain_mm_per_hr, temp_c, feels_c, wind_ms, snow_new_cm
         from weather_observations where missing = false order by observed_at desc limit 1`,
    );
    const { snowToday } = await todayAccums(q, new Date());
    const admins = await q.query(
      `select phone from employees where role = 'admin' and ${sendablePhoneSql("phone")}`,
    );
    return {
      due: rows as PendingEvent[],
      alertIds: await alertRecipientPhones(q),
      obs: obsRows[0] ?? null,
      snowToday,
      adminIds: admins.rows.map((r: { phone: string }) => r.phone),
      intervalMin,
    };
  });

  let reminded = 0;
  let escalated = 0;
  for (const e of due) {
    const nth = (e.remind_count ?? 0) + 1;
    const obsLine = obs
      ? formatObsLine(obs) + (e.kind === "snow" ? ` · 신적설 ${obs.snow_new_cm ?? "-"}cm(오늘 누적 ${snowToday ?? "-"}cm)` : "")
      : "관측값 없음";
    // 발송(네트워크)은 트랜잭션 밖에서 한다.
    for (const to of alertIds)
      await channel.send(to,
        `[날씨경영] (재알림 ${nth}/${REMIND_LIMIT}) ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 아직 승인 대기 중입니다.\n현재 관측: ${obsLine}\n검토: ${env("APP_BASE_URL")}/events/${e.id}`);
    // last_reminded_at도 Postgres 시계로 찍는다 — 바로 위 cutoff 비교가 그 값을
    // now()와 견주므로, 여기서 앱 시계를 쓰면 다시 두 시계가 섞인다.
    // remind_count는 발송 회차(repeat_count)와 뜻이 다른 값이다(0016 마이그레이션).
    await withService((q) =>
      q.query(
        "update weather_events set last_reminded_at = now(), remind_count = remind_count + 1 where id = $1",
        [e.id],
      ));
    reminded++;

    // 상한에 도달했다: 재알림을 멈추고 **관리자에게 따로 알린다**(사용자 결정).
    // 승인자가 반응하지 않는다는 사실 자체가 관리자가 알아야 할 정보다 — 여기서
    // 조용히 멈추면 특보는 승인 대기로 굳고 아무도 그 사실을 모른다.
    if (nth >= REMIND_LIMIT) {
      const hours = Math.round((REMIND_LIMIT * Number(intervalMin)) / 60);
      const text =
        `[날씨경영] ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 약 ${hours}시간(재알림 ${REMIND_LIMIT}회) 동안 승인되지 않았습니다.\n` +
        `승인 권한자가 응답하지 않고 있어 재알림을 멈춥니다 — 직접 확인해 주세요.\n현재 관측: ${obsLine}\n검토: ${env("APP_BASE_URL")}/events/${e.id}`;
      if (adminIds.length === 0)
        console.error(`[remind-tick] 재알림 상한에 도달했지만 알릴 관리자가 없습니다 (event=${e.id})`);
      for (const to of adminIds) await channel.send(to, text);
      escalated++;
    }
  }
  await upsertHeartbeat("remind-tick", true, null);
  return { reminded, escalated };
}
