import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { login as apiLogin, logout as apiLogout, me, changePassword as apiChangePassword } from "../lib/api/auth";
import { listEmployees, alertRecipients } from "../lib/api/org";
import { ApiError } from "../lib/api/client";
import type { Employee } from "../lib/types";

// 수정 라운드 1(F1·F4·F5)의 근본 원인: employee=null 하나가 "인증 안 됨"·
// "비밀번호 변경 필요"·"부수 조회 실패" 세 가지를 동시에 뜻해 RequireRole이 셋을
// 구분하지 못하고 전부 /login으로 보냈다. status를 명시적으로 나눠 각 화면이
// 서로 다르게 반응할 수 있게 한다.
export type AuthStatus = "loading" | "anonymous" | "must-change-password" | "authenticated" | "error";

type AuthState = {
  status: AuthStatus;
  employee: Employee | null;
  /** status === "loading"과 동일 — 기존 소비처(RequireRole 등) 호환용으로 남겨 둔다. */
  loading: boolean;
  isApprover: boolean;
  /** status === "must-change-password"와 동일 — 브리프 Interfaces 블록이 요구한 필드. */
  mustChangePassword: boolean;
  /** status === "error"일 때 사용자에게 보여줄 문구. */
  authError: string | null;
  login(email: string, password: string): Promise<{ mustChangePassword: boolean }>;
  logout(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  /** 세션 상태를 서버에서 다시 읽는다. F4의 "다시 시도" 버튼과 로그인 직후 갱신에 쓰인다. */
  refresh(): Promise<void>;
};

const Ctx = createContext<AuthState>({
  status: "loading",
  employee: null,
  loading: true,
  isApprover: false,
  mustChangePassword: false,
  authError: null,
  login: async () => ({ mustChangePassword: false }),
  logout: async () => {},
  changePassword: async () => {},
  refresh: async () => {},
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [isApprover, setIsApprover] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // 승인 권한은 역할이 아니라 Alert 수신자 등록 여부가 결정한다(스펙 2026-08-13).
  // 서버가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
  // employee와 isApprover를 따로 set하면 두 번째 조회가 끝날 때까지 새 employee가
  // 이전 isApprover와 짝지어지는 창이 생긴다 — 이 계획이 없애려는 불일치가 형태만
  // 바꿔 되살아나므로, 둘 다 구한 뒤 함께 반영한다(React 18 배칭으로 한 번의 렌더).
  const refresh = useCallback(async () => {
    let meResult: Awaited<ReturnType<typeof me>>;
    try {
      meResult = await me();
    } catch {
      // me()의 실패는 "세션이 없다"(401)로만 온다 — auth/middleware.ts에서 /api/auth/me는
      // requireAuth만 거치고 must_change_password 화이트리스트에도 있어 다른 이유로
      // 막힐 일이 없다. 그러니 이 catch는 곧 anonymous다.
      setEmployee(null);
      setIsApprover(false);
      setAuthError(null);
      setStatus("anonymous");
      return;
    }

    const { user } = meResult;
    // auth/middleware.ts는 must_change_password가 참인 세션에서 /api/auth/me와
    // /api/auth/change-password, /api/auth/logout을 뺀 모든 /api/*를 403으로
    // 막는다. employees·alert-recipients를 여기서 더 부르면 그 자체가 실패하므로,
    // 비밀번호를 바꾸기 전까지는 직원 정보 없이 must-change-password 상태만 반영한다.
    if (!user.employeeId || user.mustChangePassword) {
      setEmployee(null);
      setIsApprover(false);
      setAuthError(null);
      setStatus("must-change-password");
      return;
    }

    // 여기부터는 인증 자체는 끝났다(로그인 200 + 쿠키 확인됨) — 아래 조회가 실패해도
    // "로그인 실패"가 아니라 "인증 후 부수 조회 실패"로 구분해야 한다(F4). 그래서
    // 이 블록만의 별도 try/catch를 둔다 — 위의 me() catch(=anonymous)와 절대 합치지 않는다.
    try {
      const [emps, recips] = await Promise.all([listEmployees(), alertRecipients()]);
      const mine = emps.find((e) => e.id === user.employeeId) ?? null;
      const approver = recips.some((r) => r.employee_id === user.employeeId);
      setEmployee(mine);
      setIsApprover(approver);
      setAuthError(null);
      setStatus("authenticated");
    } catch (err) {
      // 로그인은 됐는데 직원 정보를 못 읽는 상태다. anonymous로 뭉개면 "오류 메시지 없이
      // 로그인 폼이 다시 뜨는" 무한 루프로 보인다(F4) — 서버가 죽은 건지 비밀번호가
      // 틀린 건지 구분할 단서가 아예 없어진다. error로 남겨 화면이 설명을 보여주게 한다.
      setEmployee(null);
      setIsApprover(false);
      setAuthError(
        err instanceof ApiError ? err.message : "직원 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
      setStatus("error");
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
      setAuthError(null);
      setStatus("anonymous");
    }
  }

  // ChangePassword.tsx가 성공 후 이 함수를 부른다 — 서버에 비밀번호를 바꾼 뒤 곧바로
  // refresh()까지 마쳐서, 호출부가 navigate("/")할 때는 이미 status가 authenticated로
  // 바뀌어 있다. 예전에는 ChangePassword가 컨텍스트를 갱신하지 않고 navigate만 해서,
  // RequireRole이 여전히 must-change-password(구현으로는 employee=null)를 보고
  // /login으로 되돌렸다(F1).
  async function changePassword(current: string, next: string) {
    await apiChangePassword(current, next);
    await refresh();
  }

  return (
    <Ctx.Provider
      value={{
        status,
        employee,
        loading: status === "loading",
        isApprover,
        mustChangePassword: status === "must-change-password",
        authError,
        login,
        logout,
        changePassword,
        refresh,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
