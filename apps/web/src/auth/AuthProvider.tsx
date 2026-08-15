import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { Employee } from "../lib/types";

type AuthState = { employee: Employee | null; loading: boolean; isApprover: boolean; signOut(): void };

const Ctx = createContext<AuthState>({
  employee: null,
  loading: true,
  isApprover: false,
  signOut: () => {},
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [isApprover, setIsApprover] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setEmployee(null);
        setIsApprover(false);
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("employees")
        .select("*")
        .eq("auth_user_id", user.id)
        .single();
      // 승인 권한은 역할이 아니라 Alert 수신자 등록 여부가 결정한다(스펙 2026-08-13).
      // 서버가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
      // employee와 isApprover를 따로 set하면 두 번째 조회가 끝날 때까지 새 employee가
      // 이전 isApprover와 짝지어지는 창이 생긴다 — 이 계획이 없애려는 불일치가 형태만
      // 바꿔 되살아나므로, 둘 다 구한 뒤 함께 반영한다(React 18 배칭으로 한 번의 렌더).
      let approver = false;
      if (data) {
        const { data: recip } = await supabase
          .from("alert_recipients")
          .select("employee_id")
          .eq("employee_id", data.id)
          .maybeSingle();
        approver = recip !== null;
      }
      setEmployee(data);
      setIsApprover(approver);
      setLoading(false);
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <Ctx.Provider
      value={{ employee, loading, isApprover, signOut: () => void supabase.auth.signOut() }}
    >
      {children}
    </Ctx.Provider>
  );
}
