import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { changePassword } from "../lib/api/auth";
import { ApiError } from "../lib/api/client";
import "./Signup.css";

const MIN_PASSWORD = 10;

// 임시 비밀번호 발급(관리자) 또는 첫 가입 직후처럼 "비밀번호를 먼저 바꿔야 하는" 세션이
// 오는 화면이다. server/src/auth/middleware.ts는 must_change_password가 참인 세션에서
// 이 화면과 GET /api/auth/me, POST /api/auth/logout을 뺀 모든 /api/*를 403으로 막는다
// — 그래서 이 화면은 RequireRole로 감싸지 않는다(직원 정보 조회 자체가 막혀 있다).
export default function ChangePassword() {
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_PASSWORD) {
      setError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "비밀번호를 바꾸지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signup">
      <h1>비밀번호 변경</h1>
      <p>계속 이용하려면 새 비밀번호를 설정해야 합니다.</p>
      <form onSubmit={submit}>
        <label htmlFor="current-password">현재 비밀번호</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />

        <label htmlFor="next-password">새 비밀번호</label>
        <input
          id="next-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />

        {error && <p className="signup-error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "변경 중…" : "비밀번호 변경"}
        </button>
      </form>
    </div>
  );
}
