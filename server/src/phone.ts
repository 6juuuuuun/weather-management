// 휴대폰 번호 규칙. auth/emailDomain.ts와 **같은 이유로** 한 파일에만 둔다.
//
// employees.phone을 채우는 쓰기 경로는 셋이다:
//   1. 가입           POST  /api/auth/signup      (auth/routes.ts)
//   2. 사전 등록      POST  /api/employees        (api/org.ts)
//   3. 직원 수정      PATCH /api/employees/:id    (api/org.ts)
// 이메일 도메인 규칙이 한 경로에만 있던 시절에 무슨 일이 벌어졌는지는
// emailDomain.ts의 주석에 그대로 적혀 있다 — 규칙이 형제 경로에서 갈라지면 한쪽으로
// 들어온 값이 다른 쪽의 전제를 깬다. 전화번호도 같은 컬럼이므로 같은 자리에 둔다.
//
// **왜 서버에서도 보는가:** 가입 화면(apps/web/src/pages/Signup.tsx)이 입력을
// 숫자만 남겨 하이픈까지 넣어 주지만, 화면은 방벽이 아니다 — 브라우저를 거치지 않는
// 요청은 그 서식을 통째로 건너뛴다. 이 값은 관리자 명부와 비상 연락에 쓰인다.
//
// **휴대폰만 받는다.** 입력란 이름이 "휴대폰 번호"이고(사용자 확인), 유선 번호·
// 내선은 범위 밖이다. 010은 11자리, 011/016/017/018/019는 10자리 또는 11자리다.
//
// **빈 값은 그대로 허용한다.** 전화번호는 지금도 선택 입력이고 그대로 둔다 —
// 여기서 필수로 바꾸면 이미 전화번호 없이 등록된 직원의 행을 관리자가 이름만
// 고치려 해도 저장할 수 없게 된다.
//
// **이미 저장된 값은 건드리지 않는다.** 규칙은 새로 들어오는 쓰기에만 건다.
// 조회(EMP_COLS)는 컬럼을 그대로 내보내므로 어떤 모양이 들어 있든 계속 보인다.

// 010은 11자리, 나머지 구 번호대는 10 또는 11자리.
const ELEVEN_ONLY = /^010\d{8}$/;
const TEN_OR_ELEVEN = /^01[16789]\d{7,8}$/;

export const PHONE_ERROR = "휴대폰 번호 형식이 올바르지 않습니다 (예: 010-1234-5678)";

/**
 * 정규화 결과. 예외 대신 판별 가능한 값으로 돌려준다 — 호출부 셋이 모두
 * "400으로 거절"과 "정규형을 그대로 저장" 두 갈래만 필요로 하기 때문이다.
 *   { ok: true, phone: null }            → 미입력(선택 항목이므로 정상)
 *   { ok: true, phone: "010-1234-5678" } → 하이픈이 든 정규형
 *   { ok: false }                        → 형식 위반. 호출부가 PHONE_ERROR로 거절한다
 */
export type PhoneResult = { ok: true; phone: string | null } | { ok: false };

/**
 * 어떤 타입이든 받는다 — 세 경로 모두 검증되지 않은 JSON 본문에서 값을 꺼내므로,
 * 숫자·객체·배열이 그대로 들어올 수 있다. String()으로 뭉개면 `[object Object]`가
 * 숫자 검사에 걸려 거절되긴 하지만, 배열 `["010","1234","5678"]`은 콤마가 끼어
 * 우연히 통과하는 모양이 나올 수 있다. 문자열이 아닌 값은 명시적으로 거절한다.
 *
 * 입력에서 허용하는 구분자는 하이픈·공백·점뿐이다. 붙여넣기로 들어오는 실제
 * 모양들(`01012345678`, `010 1234 5678`, `010.1234.5678`)을 받아 주되, 숫자만
 * 남기고 무엇이든 지우는 방식은 쓰지 않는다 — 그렇게 하면 `abc010def12345678`도
 * 통과해 관리자 명부에 "정상"으로 앉는다.
 */
export function normalizePhone(raw: unknown): PhoneResult {
  if (raw === null || raw === undefined) return { ok: true, phone: null };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, phone: null };
  if (!/^[0-9 .-]+$/.test(trimmed)) return { ok: false };
  const digits = trimmed.replace(/[ .-]/g, "");
  if (!ELEVEN_ONLY.test(digits) && !TEN_OR_ELEVEN.test(digits)) return { ok: false };
  return { ok: true, phone: hyphenate(digits) };
}

/** 10자리는 3-3-4, 11자리는 3-4-4. 위 검사를 통과한 값만 들어온다. */
function hyphenate(digits: string): string {
  const mid = digits.length === 11 ? 4 : 3;
  return `${digits.slice(0, 3)}-${digits.slice(3, 3 + mid)}-${digits.slice(3 + mid)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 여기서부터는 **발송 주소로서의** 전화번호다 (카카오워크 → SMS(LMS) 전환).
//
// 카카오워크 시절에는 "이 사람에게 보낼 수 있는가"가 employees.kakaowork_user_id로
// 판정됐다. 그 값은 이메일 조회로 채워졌으므로 조회·재연결·수동 입력·미연결 표시라는
// 기계 장치가 통째로 필요했다. 전화번호는 **번호 자체가 주소**라 조회가 없다.
// 그래서 그 기계는 사라지지만, 그것이 지고 있던 안전망 —
// "이 수신자에게는 특보가 아무에게도 가지 않는다" — 은 그대로 여기로 옮겨 온다.
//
// **"값이 있다"가 아니라 "보낼 수 있는 형식이다"로 센다.**
// employees.phone에는 위 검증이 생기기 전에 저장된 값이 남아 있을 수 있다(주석 22행).
// 그런 값을 "연락 가능"으로 세면 지표는 초록인데 LMS 제공자가 발송을 거절한다 —
// 이 프로젝트가 네 번 고친 "아무에게도 못 알리는데 전부 초록"의 정확히 같은 모양이다.
// 세는 기준과 실제로 보낼 수 있는 기준이 어긋나면 안 되므로 둘 다 아래 하나를 본다.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이 값이 지금 그대로 LMS 수신번호로 쓸 수 있는가.
 *
 * normalizePhone을 그대로 쓴다 — 쓰기 경로가 통과시키는 값과 발송이 보낼 수 있는
 * 값이 같아야 한다. 빈 값(ok:true, phone:null)은 "보낼 수 없음"이다: 가입에서는
 * 선택 항목이라 정상이지만(판정 3), 발송 주소로서는 없는 것과 같다.
 */
export function isSendablePhone(raw: unknown): boolean {
  const r = normalizePhone(raw);
  return r.ok && r.phone !== null;
}

/**
 * 로그·화면에 남길 때 쓰는 가린 형태. `010-1234-5678` → `010-****-5678`.
 *
 * **왜 필요한가:** 문자 발송이 아직 로그로만 나가는 동안 `docker logs`에 수신자
 * 번호가 그대로 쌓인다. 로그는 장애 조사 때 복사돼 돌아다니고, 백업·모니터링으로
 * 흘러가며, 지워야 할 곳이 늘어난다. 발송 자체에는 원본이 필요하지만 **기록에는
 * 필요 없다** — 어느 번호였는지 구분할 수 있으면 조사에는 충분하다.
 *
 * 가리는 자리를 가운데로 잡은 이유: 앞 3자리(통신사 대역)와 뒤 4자리가 남아야
 * "이 사람이 맞나"를 확인할 수 있고, 그 둘만으로는 번호를 복원할 수 없다.
 *
 * 형식이 어긋난 값은 통째로 가린다 — 무엇이 들어 있는지 모르는 값을 일부라도
 * 흘리지 않는다.
 */
export function maskPhone(raw: unknown): string {
  const r = normalizePhone(raw);
  if (!r.ok) return "***";
  if (r.phone === null) return "(번호 없음)";
  const parts = r.phone.split("-");
  return `${parts[0]}-${"*".repeat(parts[1]!.length)}-${parts[2]}`;
}

/**
 * 위 판정과 같은 뜻의 SQL 조건. `col`은 전화번호 컬럼의 정규화된 참조
 * (`"e.phone"`처럼 **코드에 적힌 식별자**만 넣는다 — 사용자 입력이 아니다).
 *
 * guidelineContent.ts의 effectiveGuidelineSql과 같은 처방이다: 한 규칙이 JS와 SQL
 * 두 언어로 적히는 것을 피할 수 없으면, **두 벌을 적지 말고 한 벌에서 뽑아 쓴다.**
 * 아래는 위 정규식 두 개의 `source`를 그대로 가져다 붙이므로, 규칙을 고치면 SQL도
 * 함께 바뀐다 — 규칙이 갈라질 자리가 없다.
 *
 * Postgres의 ARE는 `\d`와 `{7,8}` 바운드를 JS와 같은 뜻으로 읽는다. 구분자 제거도
 * normalizePhone과 같은 집합(` .-`)이다. 숫자·구분자 외의 문자는 제거 뒤에도 남아
 * 정규식에서 걸리므로, JS 쪽의 `^[0-9 .-]+$` 선검사를 따로 옮길 필요가 없다
 * (`abc010...`은 제거 후 `abc010...`이라 `^010\d{8}$`에 맞지 않는다).
 *
 * 실제로 두 언어가 같은 판정을 내는지는 test/phone-sendable.test.ts가 진짜 DB에
 * 물어본다 — 그 대조가 없으면 "한 곳에서 뽑았다"는 말은 주석일 뿐이다.
 */
export function sendablePhoneSql(col: string): string {
  const digits = `regexp_replace(${col}, '[ .-]', '', 'g')`;
  return `(${col} is not null and (${digits} ~ '${ELEVEN_ONLY.source}'` +
    ` or ${digits} ~ '${TEN_OR_ELEVEN.source}'))`;
}
