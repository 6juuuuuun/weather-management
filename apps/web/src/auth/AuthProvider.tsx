import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, logout as apiLogout, me } from "../lib/api/auth";
import { listEmployees, alertRecipients } from "../lib/api/org";
import type { Employee } from "../lib/types";

type AuthState = {
  employee: Employee | null;
  loading: boolean;
  isApprover: boolean;
  /** 로그인 성공은 했지만 임시 비밀번호 등으로 비밀번호를 먼저 바꿔야 하는 세션. */
  mustChangePassword: boolean;
  login(email: string, password: string): Promise<{ mustChangePassword: boolean }>;
  logout(): Promise<void>;
};

const Ctx = createContext<AuthState>({
  employee: null,
  loading: true,
  isApprover: false,
  mustChangePassword: false,
  login: async () => ({ mustChangePassword: false }),
  logout: async () => {},
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [isApprover, setIsApprover] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  // 승인 권한은 역할이 아니라 Alert 수신자 등록 여부가 결정한다(스펙 2026-08-13).
  // 서버가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
  // employee와 isApprover를 따로 set하면 두 번째 조회가 끝날 때까지 새 employee가
  // 이전 isApprover와 짝지어지는 창이 생긴다 — 이 계획이 없애려는 불일치가 형태만
  // 바꿔 되살아나므로, 둘 다 구한 뒤 함께 반영한다(React 18 배칭으로 한 번의 렌더).
  const refresh = useCallback(async () => {
    try {
      const { user } = await me();
      // auth/middleware.ts는 must_change_password가 참인 세션에서 /api/auth/me와
      // /api/auth/change-password, /api/auth/logout을 뺀 모든 /api/*를 403으로
      // 막는다. employees·alert-recipients를 여기서 더 부르면 그 자체가 실패하므로,
      // 비밀번호를 바꾸기 전까지는 직원 정보 없이 mustChangePassword만 반영한다.
      if (!user.employeeId || user.mustChangePassword) {
        setEmployee(null);
        setIsApprover(false);
        setMustChangePassword(user.mustChangePassword);
        return;
      }
      const [emps, recips] = await Promise.all([listEmployees(), alertRecipients()]);
      const mine = emps.find((e) => e.id === user.employeeId) ?? null;
      const approver = recips.some((r) => r.employee_id === user.employeeId);
      setEmployee(mine);
      setIsApprover(approver);
      setMustChangePassword(false);
    } catch {
      // 세션이 없거나(401) 조회가 실패하면 로그아웃 상태로 취급한다.
      setEmployee(null);
      setIsApprover(false);
      setMustChangePassword(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function login(email: string, password: string) {
    const res = await apiLogin(email, password);
    await refresh();
    return { mustChangePassword: res.must_change_password };
  }

  async function logout() {
    try {
      await apiLogout();
    } finally {
      setEmployee(null);
      setIsApprover(false);
      setMustChangePassword(false);
    }
  }

  return (
    <Ctx.Provider value={{ employee, loading, isApprover, mustChangePassword, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}
