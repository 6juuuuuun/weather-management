// 세 작업(weather-tick·remind-tick·send)이 공통으로 쓰는 조각.
// 원본에서는 각 Edge Function이 같은 코드를 세 번 되풀이했는데, DB 접근을 SQL로
// 바꾸면서 질의문이 두 곳에 갈라지면 한쪽만 고쳐지는 사고가 나므로 여기 모은다.
import type { Querier } from "../db.ts";
import {
  getChannel, ConsoleChannel, KakaoWorkChannel, type NotificationChannel,
} from "../shared/kakaowork.ts";

/** Deno.env.get → process.env. 원본 각 함수 상단의 `const env = (k) => Deno.env.get(k)`에 대응한다. */
export const env = (k: string): string | undefined => process.env[k];

/** 원본과 같은 규칙: NOTIFY_CHANNEL=console이거나 봇 키가 없으면 콘솔로 흘린다. */
export function envChannel(): NotificationChannel {
  return getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL"), KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") });
}

/**
 * 발송 이력(dispatches.channel)에 남길 **실제로 나간 채널** 이름 (QA W-29).
 *
 * 예전에는 이 컬럼을 아무도 쓰지 않아 스키마 기본값 'kakaowork'가 그대로 박혔다
 * (0001_schema.sql:125). 설치 직후 점검 단계에서는 `.env.selfhost.example`이
 * 권하는 대로 NOTIFY_CHANNEL=console로 도는데, 그때 카카오워크로는 **아무것도
 * 나가지 않았는데도** 이력에는 카카오워크로 보냈다고 적혔다. 나중에 이력을
 * 되짚는 사람은 "그때 발송됐다"고 읽는다.
 *
 * 채널 객체 자체에서 이름을 얻는다 — env를 다시 읽으면 주입된 채널(테스트·
 * 향후 다른 채널)과 기록이 어긋나고, 그게 정확히 지금 고치는 결함의 모양이다.
 * shared/는 원본과 바이트 단위로 같아야 하므로 인터페이스에 이름을 넣지 못한다.
 */
export function channelName(ch: NotificationChannel): string {
  if (ch instanceof ConsoleChannel) return "console";
  if (ch instanceof KakaoWorkChannel) return "kakaowork";
  // 주입된 채널(테스트 대역 등). 실제 카카오워크가 아니라는 사실이 이력에
  // 남는 것이 "kakaowork"라고 단정하는 것보다 낫다.
  return "custom";
}

// 원본의 `db.from("alert_recipients").select("employees(kakaowork_user_id)")`에 해당한다.
// alert_recipients.employee_id는 employees(id)를 참조하는 기본키라 조인이 1:1이다.
// withService로만 부른다 — 승인 알림은 특정 사용자를 대신하는 동작이 아니고,
// 정책이 적용되는 통로로 읽으면 조인이 조용히 0행을 돌려줄 수 있다.
export async function alertRecipientKakaoIds(q: Querier): Promise<string[]> {
  const { rows } = await q.query(
    `select e.kakaowork_user_id
       from alert_recipients ar
       join employees e on e.id = ar.employee_id
      where e.kakaowork_user_id is not null`,
  );
  return rows.map((r: { kakaowork_user_id: string }) => r.kakaowork_user_id);
}
