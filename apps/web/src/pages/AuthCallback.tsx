import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";

export default function AuthCallback() {
  const nav = useNavigate();

  useEffect(() => {
    const hash = new URLSearchParams(location.hash.slice(1)).get("token_hash");
    if (!hash) {
      nav("/login");
      return;
    }
    supabase.auth
      .verifyOtp({ type: "email", token_hash: hash })
      .then(({ error }) => nav(error ? "/login" : "/"));
  }, [nav]);

  return <p style={{ padding: 40 }}>로그인 중…</p>;
}
