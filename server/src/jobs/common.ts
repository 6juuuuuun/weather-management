// 세 작업(weather-tick·remind-tick·send)이 공통으로 쓰는 조각.
// 원본에서는 각 Edge Function이 같은 코드를 세 번 되풀이했는데, DB 접근을 SQL로
// 바꾸면서 질의문이 두 곳에 갈라지면 한쪽만 고쳐지는 사고가 나므로 여기 모은다.
import type { Querier } from "../db.ts";
import { getChannel, type NotificationChannel } from "../shared/kakaowork.ts";

/** Deno.env.get → process.env. 원본 각 함수 상단의 `const env = (k) => Deno.env.get(k)`에 대응한다. */
export const env = (k: string): string | undefined => process.env[k];

/** 원본과 같은 규칙: NOTIFY_CHANNEL=console이거나 봇 키가 없으면 콘솔로 흘린다. */
export function envChannel(): NotificationChannel {
  return getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL"), KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") });
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
