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

/**
 * 이 채널이 **사람에게 닿지 않고 로그로만 흘리는** 채널인가 (검증 라운드 E, 25번째 경로).
 *
 * `NOTIFY_CHANNEL=console`은 설치 점검·시연을 위해 일부러 있는 값이고 그 자체는
 * 정당하다. 위험한 것은 **그 값이 운영에 남는 것**이다: 봇 키가 유효하면
 * kakaoLinkTick이 직원의 kakaowork_user_id를 채우므로 수신자도 승인자도 전부
 * "연결됨"이 되고, 셋업 체크리스트·`/api/health/deep`·워치독이 모두 초록이며,
 * 승인은 `{"ok":true,"sent_count":1}`을 돌려준다 — 그런데 그 DM은 전부 앱 로그로만
 * 갔다. 이 프로젝트가 네 번 고친 "아무에게도 못 알리는데 전부 초록"의 다섯 번째
 * 모양이고, 이번 것은 **지표가 도달 가능성만 보고 실제 도착지를 보지 않아서** 생긴다.
 *
 * 리허설 스택의 .env를 그대로 실서버에 복사하는 것이 가장 흔한 경로다.
 * 그래서 "닿을 수 있는가" 옆에 "어디로 가는가"를 묻는 자리를 만든다.
 * 봇 키가 비어 있을 때도 같은 결과가 되므로(getChannel이 콘솔로 떨어뜨린다)
 * 원인을 가리지 않고 **실효 채널 하나로** 판정한다.
 */
export function isLogOnlyChannel(ch: NotificationChannel): boolean {
  return channelName(ch) === "console";
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
