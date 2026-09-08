// 특보 발송 통로 — SMS(LMS).
//
// **지금 이 파일에 실제 발송은 없다.** 인프라에서 LMS 제공자 계정 자료를 아직 받지
// 못했고, 그래서 이번 작업은 "실제 발송 직전까지"만 만든다. 나가는 것은 앱 로그뿐이다.
// 그 사실은 숨기지 않는다 — `/api/health/deep`은 503으로 남고, 셋업 체크리스트의
// "실제 발송" 항목은 빨간불이며, 사유는 "SMS 발송 설정이 아직 없습니다 — 인프라
// 연동 대기 중"이라고 정확히 말한다. 이 시스템은 "아무에게도 못 알리는데 전부 초록"을
// 네 번 고쳤다. 로그로만 나가는 상태를 초록으로 칠하는 것이 정확히 그 다섯 번째다.
//
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ ▶▶ 실제 LMS 제공자를 붙이는 사람에게 — 고칠 곳은 이 파일 안 두 군데다.    │
// │                                                                          │
// │   1. `LmsChannel`  (아래 "제공자 자리" 절)                                │
// │      NotificationChannel을 구현하는 클래스 하나를 만든다. 할 일은          │
// │      `send(전화번호, 본문)`에서 제공자 HTTP API를 부르고                   │
// │      `{ ok, error }`를 돌려주는 것뿐이다. **절대 던지지 않는다** —         │
// │      발송 루프(jobs/send.ts·weatherTick.ts)는 예외가 아니라 ok:false로     │
// │      실패를 센다. 본문은 이미 `fitToLms`를 지나 2,000바이트 안이다.        │
// │                                                                          │
// │   2. `getChannel`  (이 파일 맨 아래)                                      │
// │      `case "여기에-제공자-이름":`을 하나 늘리고 1번 클래스를 돌려준다.      │
// │                                                                          │
// │   그 밖에 손댈 곳은 없다. 지표·화면·이력은 채널의 `name`만 보므로          │
// │   (`channelName`·`isLogOnlyChannel` — jobs/common.ts) 이름이 "log"가       │
// │   아니게 되는 순간 빨간불이 저절로 풀린다.                                 │
// │                                                                          │
// │   필요한 환경변수는 `.env.example`·`.env.selfhost.example`·                │
// │   `docker-compose.yml`의 `SMS_` 항목에 자리만 만들어 두었다.               │
// └──────────────────────────────────────────────────────────────────────────┘
import type { NotificationChannel } from "./channel.ts";
import { maskPhone } from "../phone.ts";
export type { NotificationChannel };

// ─────────────────────────────────────────────────────────────────────────────
// 1. LMS 2,000바이트
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LMS 한 통의 최대 크기. **글자 수가 아니라 바이트다.**
 *
 * 한글은 UTF-8에서 글자당 3바이트이므로 2,000바이트는 한글 약 666자다. 이 시스템의
 * 발송 본문에는 부서별 행동지침이 통째로 들어간다(인력 조정 지침 최대 20개 ×
 * 200자 + 고객 안내 1,000자 — api/content.ts). 최악의 경우 15,000바이트가 넘는다.
 * 즉 **넘칠 수 있는 정도가 아니라 넘치도록 허용된 구조**다.
 */
export const LMS_MAX_BYTES = 2000;

/** UTF-8 바이트 수. 글자 수(`text.length`)와 혼동하지 않으려고 함수로 둔다. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 넘칠 때 본문 끝에 붙는 표시.
 *
 * **왜 조용히 자르지 않는가:** 잘려 나가는 것은 언제나 본문의 **뒤쪽**이고, 이
 * 메시지에서 뒤쪽은 고객 안내 멘트와 인력 조정 지침의 마지막 항목들이다. 받는
 * 사람은 자기가 받은 것이 전부인 줄 안다 — "제설차 배치" 다음에 있던 "리프트
 * 운행 중단"을 못 본 채 현장에 나간다. 잘렸다는 사실 자체가 정보이고, 전체를
 * 어디서 볼 수 있는지까지 함께 말해야 잘림이 복구 가능한 상태가 된다.
 */
export function truncationNotice(appBaseUrl?: string): string {
  const where = appBaseUrl ? `\n${appBaseUrl}` : "";
  return `\n\n[본문이 길어 여기까지만 전송됐습니다 — 전체 지침은 날씨경영에서 확인해 주세요]${where}`;
}

export type FitResult = {
  /** 실제로 보낼 본문. 언제나 LMS_MAX_BYTES 이하다. */
  text: string;
  /** 잘렸는가. 호출부가 이 값으로 로그를 남긴다(조용히 지나가지 않게). */
  truncated: boolean;
  /** 자르기 **전** 크기. 얼마나 넘쳤는지가 로그에 남아야 원인을 찾을 수 있다. */
  originalBytes: number;
};

/**
 * 본문을 LMS 한 통에 담기게 맞춘다.
 *
 * 자를 때는 **글자 경계**에서 자른다. 바이트로 그냥 자르면 한글 한 글자의 3바이트
 * 중 2바이트만 남아 깨진 문자가 마지막에 붙는다. `Array.from`은 서로게이트 쌍까지
 * 한 덩어리로 다루므로 이모지가 섞여 있어도 쪼개지지 않는다.
 *
 * 자른 자리에는 반드시 truncationNotice가 붙는다 — 그 표시까지 포함해 2,000바이트
 * 안이어야 하므로 표시 몫을 **먼저 빼고** 본문을 채운다.
 */
export function fitToLms(text: string, appBaseUrl?: string): FitResult {
  const originalBytes = byteLength(text);
  if (originalBytes <= LMS_MAX_BYTES) return { text, truncated: false, originalBytes };

  const notice = truncationNotice(appBaseUrl);
  const budget = LMS_MAX_BYTES - byteLength(notice);
  // 표시 자체가 한 통을 넘을 만큼 긴 경우는 없지만(고정 문구다), 방어로 남긴다 —
  // 여기서 budget이 음수가 되면 아래 루프가 빈 문자열을 돌려주고 표시만 나간다.
  let used = 0;
  let cut = "";
  for (const ch of Array.from(text)) {
    const n = byteLength(ch);
    if (used + n > budget) break;
    cut += ch;
    used += n;
  }
  return { text: cut + notice, truncated: true, originalBytes };
}

/**
 * 행동지침 **내용**(인력 조정 지침 + 고객 안내)에 허용되는 바이트.
 *
 * 지표가 폭설이 오기 **전에** 넘침을 말할 수 있어야 하므로(발송 순간에 잘리는 것을
 * 확인하는 것은 이미 늦다) checkHealth가 이 값으로 지침 행을 미리 잰다. 본문에는
 * 내용 말고도 고정 부분이 붙으므로 그만큼을 빼 둔다:
 *
 *   제목 줄  `[리조트이름] 폭설 경보 — 부서이름 행동 지침`   최대 ~110바이트
 *   관측 줄  `현재 관측: 시간당 30mm · -3℃(체감 -8) · 풍속 …`  최대 ~120바이트
 *   구획 문구 `인력 조정 지침`·`고객 안내 멘트`·`• `·개행       최대 ~120바이트
 *   잘림 표시 truncationNotice(링크 포함)                      최대 ~130바이트
 *                                                             ─────────────
 *                                                              합 ~480 → 400으로
 *
 * 400으로 **적게** 잡는 쪽을 고른다. 예비가 모자라면 지표가 실제 잘림보다 **먼저**
 * 울린다(경고가 이르다 = 안전한 방향). 반대로 넉넉히 잡으면 지표는 초록인데 발송에서
 * 잘리는 상태가 생긴다 — 이 프로젝트가 계속 없애 온 바로 그 어긋남이다.
 */
export const LMS_CONTENT_BUDGET_BYTES = LMS_MAX_BYTES - 400;

// ─────────────────────────────────────────────────────────────────────────────
// 2. 로그 전용 채널 — 지금 유일한 구현
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 사람에게 보내지 않고 앱 로그에만 떨어뜨린다.
 *
 * 이름이 `"log"`인 것이 중요하다 — 지표(`isLogOnlyChannel`)가 이 이름 하나로
 * "이 시스템은 지금 아무에게도 못 알린다"를 판정한다.
 */
export class LogOnlyChannel implements NotificationChannel {
  readonly name = "log";
  async send(to: string, text: string) {
    // **번호를 그대로 찍지 않는다.** 이 채널이 도는 동안 docker logs에 수신자
    // 번호가 통째로 쌓이고, 로그는 장애 조사 때 복사돼 돌아다닌다. 발송에는
    // 원본이 필요하지만 기록에는 가린 형태로 충분하다(phone.ts의 maskPhone).
    console.log(`[log-channel] to=${maskPhone(to)}\n${text}`);
    return { ok: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 제공자 자리 — 여기에 실제 LMS 구현을 추가한다
// ─────────────────────────────────────────────────────────────────────────────
//
// 예시 뼈대다. 주석을 풀고 제공자 API에 맞게 채운 뒤 아래 getChannel의 switch에
// 이름을 하나 늘리면 끝난다. 지금 자리만 두는 이유는 제공자가 정해지지 않아서다 —
// 계정 자료 없이 아무 SDK나 골라 두면 다음 사람이 그것부터 걷어내야 한다.
// (package.json 의존성도 그래서 손대지 않았다. 제공자가 정해지면 그때 추가한다.)
//
// export class LmsChannel implements NotificationChannel {
//   readonly name = "lms";
//   // 파라미터 프로퍼티를 쓴다 — server/Dockerfile과 npm 스크립트가
//   // --experimental-transform-types로 도는 이유가 이 문법이다(test/run-scripts.test.ts).
//   constructor(
//     private apiKey: string,
//     private senderNumber: string,   // 발신번호. 사전 등록된 번호여야 한다.
//     private fetchFn: typeof fetch = fetch,
//   ) {}
//
//   async send(to: string, text: string): Promise<{ ok: boolean; error?: string }> {
//     // to는 `010-1234-5678` 정규형이다. 제공자가 하이픈을 싫어하면 여기서 지운다.
//     // text는 이미 fitToLms를 지나 2,000바이트 이하다(호출부가 보장한다).
//     try {
//       const res = await this.fetchFn("https://제공자/…/messages", {
//         method: "POST",
//         headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
//         body: JSON.stringify({ type: "LMS", from: this.senderNumber, to: to.replace(/-/g, ""), text }),
//       });
//       const json = await res.json();
//       return json?.성공여부 ? { ok: true } : { ok: false, error: String(json?.오류문구 ?? "발송 실패") };
//     } catch (e) {
//       // **던지지 않는다.** 발송 루프는 ok:false로 실패를 센다.
//       return { ok: false, error: `network/parse error: ${String(e)}` };
//     }
//   }
// }

/** 제공자를 고르는 환경변수 이름. 비어 있으면 로그 전용이다. */
export const SMS_PROVIDER_ENV = "SMS_PROVIDER";

/**
 * 실효 발송 채널을 고른다.
 *
 * 카카오워크 시절의 조건(`NOTIFY_CHANNEL=console` 이거나 봇 키 없음)은 통째로
 * 사라졌다. 봇 키가 없어졌고, `NOTIFY_CHANNEL`이라는 두 번째 손잡이도 없앴다 —
 * 손잡이가 둘이면 "왜 로그로만 나가는가"의 답이 둘이 되고, 실제로 그 둘이 서로를
 * 가리는 사고가 있었다(리허설 .env를 실서버에 복사). 이제 손잡이는 하나다:
 * **`SMS_PROVIDER`에 붙일 제공자 이름이 적혀 있는가.**
 *
 * 모르는 이름이면 조용히 로그로 떨어뜨리되 **반드시 소리를 낸다.** 오타 하나로
 * 발송이 통째로 로그가 되는 상태를 아무도 모르게 두지 않는다.
 */
export function getChannel(env: { SMS_PROVIDER?: string }): NotificationChannel {
  const provider = (env.SMS_PROVIDER ?? "").trim().toLowerCase();
  switch (provider) {
    // ▶▶ 제공자를 붙일 때 여기에 한 줄 추가한다:
    // case "lms":
    //   return new LmsChannel(process.env.SMS_API_KEY!, process.env.SMS_SENDER_NUMBER!);
    case "":
    case "log":
      return new LogOnlyChannel();
    default:
      console.error(
        `[sms] ${SMS_PROVIDER_ENV}="${env.SMS_PROVIDER}"는 모르는 제공자입니다 — ` +
          `발송이 사람 대신 앱 로그로만 나갑니다. shared/sms.ts의 getChannel을 확인하세요`,
      );
      return new LogOnlyChannel();
  }
}
