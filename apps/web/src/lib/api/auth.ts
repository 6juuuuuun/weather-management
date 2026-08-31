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

export const logout = () => apiSend<null>("POST", "/api/auth/logout");

export const me = () => apiGet<{ user: SessionUser }>("/api/auth/me");

export const changePassword = (current: string, next: string) =>
  apiSend<null>("POST", "/api/auth/change-password", { current, next });

// 관리자 전용 계정 관리 — server/src/auth/routes.ts의 adminUserRouter.
// 이메일/비밀번호 계정(auth_accounts)을 대상으로 하며, employees 행과는 별개다.
export const setAccountStatus = (accountId: string, status: "active" | "disabled") =>
  apiSend<{ ok: boolean }>("PATCH", `/api/admin/users/${encodeURIComponent(accountId)}/status`, { status });

// 응답의 temporary_password는 이 호출 한 번에만 내려온다 — 화면을 벗어나면 다시 볼 수 없다.
export const resetPassword = (accountId: string) =>
  apiSend<{ temporary_password: string }>(
    "POST",
    `/api/admin/users/${encodeURIComponent(accountId)}/reset-password`,
  );
