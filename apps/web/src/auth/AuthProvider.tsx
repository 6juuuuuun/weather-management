import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "../lib/supabase";
import type { Employee } from "../lib/types";

type AuthState = { employee: Employee | null; loading: boolean; signOut(): void };

const Ctx = createContext<AuthState>({
  employee: null,
  loading: true,
  signOut: () => {},
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setEmployee(null);
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("employees")
        .select("*")
        .eq("auth_user_id", user.id)
        .single();
      setEmployee(data);
      setLoading(false);
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <Ctx.Provider value={{ employee, loading, signOut: () => void supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
