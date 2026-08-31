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
 */
export function isAllowedEmailDomain(email: string): boolean {
  const domain = email.split("@")[1];
  return !!domain && allowedDomains().includes(domain);
}
