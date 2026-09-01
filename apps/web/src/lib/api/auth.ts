// server/src/auth/routes.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";

export type SessionUser = {
  accountId: string;
  employeeId: string | null;
  role: string | null;
  email: string;
  mustChangePassword: boolean;
};

export type LoginResult = { user: SessionUser; must_change_password: boolean };

export const login = (email: string, password: string) =>
  apiSend<LoginResult>("POST", "/api/auth/login", { email, password });

// server/src/auth/routes.ts의 authRouter.post("/signup")에 대응한다. department_id가
// 빠지면 전원이 부서 미지정으로 가입되고 requireDepartment가 지키는 라우트가 통째로
// 막히는데도 화면은 "가입이 완료되었습니다"를 보여준다 — 그래서 이 계약(경로·메서드·
// 본문)에 테스트가 반드시 있어야 한다(Signup.tsx가 이 함수를 거치지 않고 apiSend를
// 직접 부르던 것이 리뷰 F2였다).
export type SignupBody = {
  email: string;
  password: string;
  name: string;
  department_id: string | null;
  phone: string | null;
};

export const signup = (body: SignupBody) => apiSend<{ ok: boolean }>("POST", "/api/auth/signup", body);

export const logout = () => apiSend<null>("POST", "/api/auth/logout");

export const me = () => apiGet<{ user: SessionUser }>("/api/auth/me");

export const changePassword = (current: string, next: string) =>
  apiSend<null>("POST", "/api/auth/change-password", { current, next });

// 관리자 전용 계정 관리 — server/src/auth/routes.ts의 adminUserRouter.
// 이메일/비밀번호 계정(auth_accounts)을 대상으로 하며, employees 행과는 별개다.
export const setAccountStatus = (accountId: string, status: "active" | "disabled") =>
  apiSend<{ ok: boolean }>("PATCH", `/api/admin/users/${encodeURIComponent(accountId)}/status`, { status });

// 응답의 temporary_password는 이 호출 한 번에만 내려온다 — 화면을 벗어나면 다시 볼 수 없다.
// expires_in_hours는 그 값의 유효 시간이다(스펙 §6.4, server/src/auth/routes.ts의
// TEMP_PASSWORD_HOURS). 만료가 있다는 사실이 화면에 안 보이면 관리자는 "왜 로그인이
// 안 되죠"라는 문의로만 만료를 알게 된다.
export const resetPassword = (accountId: string) =>
  apiSend<{ temporary_password: string; expires_in_hours: number }>(
    "POST",
    `/api/admin/users/${encodeURIComponent(accountId)}/reset-password`,
  );
