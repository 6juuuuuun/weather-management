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
// 수정 라운드 2(항목 3): employeeId가 없는 경우를 must-change-password에서 떼어
// no-employee로 따로 둔다 — 관리자가 employees 행을 지워도 auth_accounts는 남아
// 세션 조회가 employeeId: null을 주는데(server/src/auth/session.ts), 예전에는 이
// 사용자가 비밀번호를 정상적으로 바꿔도 refresh()가 다시 employeeId: null을 보고
// /change-password로 되돌아가 "비밀번호를 바꿔야 한다"는 거짓 설명에 갇혔다.
export type AuthStatus =
  | "loading"
  | "anonymous"
  | "must-change-password"
  | "no-employee"
  | "authenticated"
  | "error";

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
  // 수정 라운드 2(항목 2): 이 함수 전체를 바깥 try/catch로 한 번 더 감싼다. 안쪽의
  // 두 try/catch(아래)는 "왜 실패했는지"를 구분하려고 있는 것이지, 구조적 안전망이
  // 아니다 — 예전(라운드 1 이전) 코드는 하나의 try/catch/finally가 어떤 예외에도
  // 반드시 setLoading(false)에 닿았는데, 갈래가 여럿으로 나뉘면서 그 보장이
  // 사라졌다. 예를 들어 /api/auth/me가 200을 주면서도 본문에 user가 없으면
  // 아래 `if (!user)` 체크 전에는 살아 있던 과거 코드의 구조화 비구조(`const { user } =
  // meResult`)가 어떤 try 안에도 없어 TypeError가 던져지고, useEffect의 떠 있는
  // 프로미스가 unhandled로 죽어 setStatus가 한 번도 불리지 않는다 — status가 영원히
  // "loading"에 머물고 RequireRole은 계속 null을 반환한다(영구 백지 화면). 지금은
  // 서버가 항상 { user }를 주므로 실무에서 재현되지는 않지만, 다음에 갈래가 하나 더
  // 추가될 때 같은 실수가 반복되지 않도록 바깥 안전망을 구조로 박아 둔다 — 어떤 경로로도
  // status가 loading에 머무르지 않는다는 것을 이 함수의 불변식으로 삼는다.
  const refresh = useCallback(async () => {
    try {
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

      const user = meResult?.user;
      if (!user) {
        // 서버 계약 위반(200인데 user가 없음)이다 — 바깥 catch로 던져 error 상태로
        // 떨어뜨린다. 여기서 직접 처리하지 않는 이유는 아래와 동일한 처리(문구·상태)를
        // 바깥 catch가 이미 하고 있어 중복을 피하기 위해서다.
        throw new Error("서버 응답에 user가 없습니다");
      }

      // auth/middleware.ts는 must_change_password가 참인 세션에서 /api/auth/me와
      // /api/auth/change-password, /api/auth/logout을 뺀 모든 /api/*를 403으로
      // 막는다. employees·alert-recipients를 여기서 더 부르면 그 자체가 실패하므로,
      // 비밀번호를 바꾸기 전까지는 직원 정보 없이 must-change-password 상태만 반영한다.
      if (user.mustChangePassword) {
        setEmployee(null);
        setIsApprover(false);
        setAuthError(null);
        setStatus("must-change-password");
        return;
      }

      // employeeId가 없는 경우는 must-change-password와 다른 문제다(항목 3) — 관리자가
      // employees 행을 지워도 auth_accounts는 남아 세션 조회가 employeeId: null을 준다.
      // must-change-password로 뭉개면 "비밀번호를 바꿔야 한다"는 거짓 설명과 함께
      // /change-password에 갇힌다(비밀번호를 바꿔도 employeeId는 여전히 null이니 다시
      // 같은 화면으로 돌아온다). no-employee로 따로 두고, 화면이 관리자 문의 안내와
      // 로그아웃 수단을 주게 한다.
      if (!user.employeeId) {
        setEmployee(null);
        setIsApprover(false);
        setAuthError(null);
        setStatus("no-employee");
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
    } catch (err) {
      // 바깥 안전망 — 위 어떤 블록에서도 예상 밖의 예외가 새면 여기로 떨어진다.
      // status가 loading에 영원히 머무는 것(영구 백지 화면)보다는 오류 화면 쪽이
      // 훨씬 안전한 실패다.
      setEmployee(null);
      setIsApprover(false);
      setAuthError(
        err instanceof ApiError ? err.message : "인증 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
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
