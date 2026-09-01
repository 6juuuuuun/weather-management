// 사내 이메일 도메인 규칙. 가입(POST /api/auth/signup)과 직원 이메일 수정·사전등록
// (PATCH/POST /api/employees)이 반드시 같은 규칙을 써야 해서 한 곳에만 둔다.
//
// employees.email은 가입이 미리 만들어 둔 직원 행에 계정을 이어 붙일 때 쓰는 병합
// 키다(auth/routes.ts의 on conflict (email)). 가입만 도메인을 검사하고 관리자 경로가
// 검사하지 않으면, 관리자가 사내 도메인이 아닌 주소를 직원 행에 박아 둘 수 있고 그
// 직원은 아무리 가입해도 그 행에 붙지 못한다 — 부서·역할이 유실된 별도 계정이 생기고,
// 원래 행은 영영 계정 없는 유령으로 남는다.
export const allowedDomains = (): string[] =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

/**
 * 이미 정규화된(trim + toLowerCase) 이메일을 받는다. 정규화하지 않은 값을 넣으면
 * 대문자 도메인이 부당하게 거부된다 — 호출부는 반드시 먼저 정규화할 것.
 *
 * 목록이 비어 있으면 **제한 없음**으로 본다. 예전에는 빈 목록이 includes()에서 전부
 * false가 되어 "아무도 가입할 수 없는" 상태였다 — 그런데 화면에 나가는 문구는
 * "회사 이메일로만 가입할 수 있습니다"라, 설정을 비워 둔 운영자는 자기 도메인이
 * 거부됐다고 읽지 시스템이 잠겼다고는 읽지 못한다. 설정하지 않은 것을 "전부 거부"로
 * 해석하는 것은 안전한 기본값이 아니라 원인을 숨기는 함정이다.
 * 도메인을 제한하려면 ALLOWED_EMAIL_DOMAINS에 실제로 값을 적는다.
 */
export function isAllowedEmailDomain(email: string): boolean {
  const domain = email.split("@")[1];
  if (!domain) return false;
  const allowed = allowedDomains();
  return allowed.length === 0 || allowed.includes(domain);
}

/**
 * 최소한의 형식 검증(QA W-20). 도메인 규칙과 **의도적으로 분리**한다.
 *
 * 예전에는 검사가 isAllowedEmailDomain() 하나뿐이었다. 그 함수는 @ 뒤에 무엇이든
 * 있으면 통과시키므로 `a@b@gonjiam.com`·`has space@gonjiam.com`·`x@x`가 전부
 * 저장됐고, @가 아예 없으면 목록을 보기도 전에 false로 빠져 호출부가
 * "회사 이메일만 등록할 수 있습니다"라고 답했다 — **도메인 제한을 켜지도 않은
 * 배포에서 도메인 탓을 하는** 문구다. 관리자는 .env를 뒤지게 된다.
 *
 * employees.email은 가입이 직원 행에 계정을 이어 붙이는 병합 키다. 오타가 든 행은
 * 그 주소로 아무도 가입할 수 없으므로 **영원히 계정과 못 붙는 유령 행**이 된다.
 * 그래서 형식은 저장 전에 막는다.
 *
 * 규칙은 일부러 좁게 잡지 않는다(RFC 전체를 흉내 내면 멀쩡한 주소를 거부한다):
 *   - @가 정확히 하나, 앞뒤가 모두 비어 있지 않을 것
 *   - 공백이 없을 것
 *   - 도메인에 점이 하나 이상 있을 것(`x@x` 같은 값을 막는다)
 *   - 전체 길이 254자 이하(메일 주소의 실질적 상한)
 * 이미 정규화된(trim + toLowerCase) 값을 받는 것은 위 함수와 같다.
 */
export function isValidEmailShape(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
