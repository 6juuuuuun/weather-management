// 세 작업(weather-tick·remind-tick·send)이 공통으로 쓰는 조각.
// 원본에서는 각 Edge Function이 같은 코드를 세 번 되풀이했는데, DB 접근을 SQL로
// 바꾸면서 질의문이 두 곳에 갈라지면 한쪽만 고쳐지는 사고가 나므로 여기 모은다.
import type { Querier } from "../db.ts";
import { getChannel, fitToLms, LMS_MAX_BYTES, type NotificationChannel } from "../shared/sms.ts";
import { renderMessage, type DeptBlock } from "../shared/template.ts";
import { sendablePhoneSql } from "../phone.ts";

/** Deno.env.get → process.env. 원본 각 함수 상단의 `const env = (k) => Deno.env.get(k)`에 대응한다. */
export const env = (k: string): string | undefined => process.env[k];

/** 손잡이는 하나다: `SMS_PROVIDER`. 비어 있으면 로그 전용이다(shared/sms.ts). */
export function envChannel(): NotificationChannel {
  return getChannel({ SMS_PROVIDER: env("SMS_PROVIDER") });
}

/**
 * 발송 이력(dispatches.channel)에 남길 **실제로 나간 채널** 이름 (QA W-29).
 *
 * 예전에는 이 컬럼을 아무도 쓰지 않아 스키마 기본값 'kakaowork'가 그대로 박혔다
 * (0001_schema.sql:125). 설치 직후 점검 단계에서는 아무것도 나가지 않았는데도
 * 이력에는 보냈다고 적혔고, 나중에 이력을 되짚는 사람은 "그때 발송됐다"고 읽는다.
 *
 * 이름은 **채널 본인에게 묻는다.** 예전에는 `instanceof`로 알아냈다 — shared/가
 * 원본과 바이트 단위로 같아야 해서 인터페이스에 이름을 넣을 수 없었기 때문이다.
 * 그 제약이 풀렸으므로 채널이 스스로 답한다. env를 다시 읽지 않는 것은 그대로다:
 * 주입된 채널과 기록이 어긋나는 것이 정확히 W-29의 모양이다.
 */
export function channelName(ch: NotificationChannel): string {
  // 이름이 없는 채널은 테스트가 주입한 대역이다. 실채널인 척하는 것보다
  // "정체를 모르는 채널이었다"가 이력에 남는 편이 낫다.
  return ch.name ?? "custom";
}

/**
 * 이 채널이 **사람에게 닿지 않고 로그로만 흘리는** 채널인가 (검증 라운드 E, 25번째 경로).
 *
 * 지금은 로그 전용 채널이 **유일한 구현**이다 — LMS 제공자 자료를 아직 받지 못했다.
 * 그러니 운영에서 이 값은 언제나 참이고, `/api/health/deep`은 계속 503이며 셋업
 * 체크리스트의 "실제 발송"은 계속 빨간불이다. **그것이 지금의 정상 상태이고,
 * 그래도 초록으로 바꾸지 않는다**(사용자 판정 2): 시스템이 진짜로 아무에게도 못
 * 알리는 것이 사실이기 때문이다. 이 프로젝트가 여섯 라운드 내내 없앤 결함이
 * 전부 "못 알리는데 초록"이었고, 여기서 초록으로 칠하면 그것을 스스로 다시 만든다.
 *
 * 제공자가 붙는 순간(shared/sms.ts의 getChannel에 case 한 줄) 채널 이름이 "log"가
 * 아니게 되고 이 판정이 저절로 풀린다 — 지표를 따로 고칠 필요가 없다.
 */
export function isLogOnlyChannel(ch: NotificationChannel): boolean {
  return channelName(ch) === "log";
}

/**
 * 특보 승인 요청을 받을 사람들의 **휴대폰 번호**.
 *
 * 예전에는 `employees.kakaowork_user_id is not null`로 걸렀다. 이제 주소는 번호
 * 자체이므로 컬럼이 `phone`으로 바뀌는데, **"값이 있다"가 아니라 "보낼 수 있는
 * 형식이다"로 거른다**(phone.ts의 sendablePhoneSql). 형식 검증이 생기기 전에
 * 저장된 값이 남아 있을 수 있고, 그런 값을 대상에 넣으면 지표는 "N명에게 보낼 수
 * 있다"고 세는데 제공자는 그 번호를 거절한다 — 세는 기준과 보낼 수 있는 기준이
 * 어긋나는 순간 "전부 초록인데 아무도 못 받는" 상태가 다시 생긴다.
 *
 * withService로만 부른다 — 승인 알림은 특정 사용자를 대신하는 동작이 아니고,
 * 정책이 적용되는 통로로 읽으면 조인이 조용히 0행을 돌려줄 수 있다.
 */
export async function alertRecipientPhones(q: Querier): Promise<string[]> {
  const { rows } = await q.query(
    `select e.phone
       from alert_recipients ar
       join employees e on e.id = ar.employee_id
      where ${sendablePhoneSql("e.phone")}`,
  );
  return rows.map((r: { phone: string }) => r.phone);
}

/**
 * 부서 블록 하나를 **LMS 한 통에 실제로 담기는** 본문으로 만든다.
 *
 * 발송 경로가 둘(승인 발송 jobs/send.ts · 자동 반복 발송 jobs/weatherTick.ts)이라
 * 자르기를 각자 하게 두면 한쪽만 고쳐지는 사고가 난다. 이 프로젝트가 질의문을
 * 이 파일에 모은 것과 같은 이유로 여기 하나만 둔다 — **renderMessage의 결과를 그대로
 * channel.send에 넘기는 경로는 이제 없어야 한다.**
 *
 * 잘렸으면 서버 로그에 남긴다. 잘림은 "행동지침의 뒷부분이 사라진 채 나갔다"는
 * 뜻이고, 그것이 아무 데도 안 남으면 왜 현장이 마지막 지침을 몰랐는지 나중에
 * 아무도 설명할 수 없다. 넘친 정도(원래 바이트)까지 함께 적어야 얼마나 줄여야
 * 하는지 알 수 있다.
 */
export function renderLmsBody(
  b: DeptBlock,
  ctx: { kindLabel: string; gradeLabel: string; siteName: string; obsLine: string },
): string {
  const fitted = fitToLms(renderMessage(b, ctx), env("APP_BASE_URL"));
  if (fitted.truncated) {
    console.error(
      `[lms] ${b.department_name} 부서 본문이 ${fitted.originalBytes}바이트로 ` +
        `LMS 한도(${LMS_MAX_BYTES}바이트)를 넘어 잘렸습니다 — 행동 지침 화면에서 내용을 줄여 주세요`,
    );
  }
  return fitted.text;
}

/**
 * Alert 수신자(승인자) 중 **실제로 특보를 받을 수 있는 사람**이 몇 명인지 센다.
 *
 * 카카오워크 시절 kakaoLink.ts의 `alertRecipientLinkCounts`가 있던 자리다. 세는
 * 대상만 "카카오워크 연결"에서 "보낼 수 있는 휴대폰 번호"로 바뀌었고, 이 값이
 * 0이면 특보 승인 요청이 아무에게도 가지 않는다는 뜻은 그대로다 — 상태 점검
 * (watchdog)과 화면(셋업 체크리스트·알림 설정)이 같은 사실을 이 함수 하나로 본다.
 *
 * `reachable`을 `count(e.phone)`이 아니라 sendablePhoneSql로 세는 이유는
 * alertRecipientPhones와 같다: 값이 있는 것과 보낼 수 있는 것은 다르고, 이 둘이
 * 갈라지면 지표가 초록인 채로 발송이 0명이 된다.
 */
export async function alertRecipientReachCounts(
  q: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
): Promise<{ total: number; reachable: number }> {
  const { rows } = await q.query(
    `select count(*)::int as total,
            count(*) filter (where ${sendablePhoneSql("e.phone")})::int as reachable
       from alert_recipients ar join employees e on e.id = ar.employee_id`,
  );
  return { total: rows[0].total as number, reachable: rows[0].reachable as number };
}
