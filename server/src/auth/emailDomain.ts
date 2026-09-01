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
