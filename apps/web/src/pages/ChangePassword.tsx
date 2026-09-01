import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../lib/api/client";
import "./Signup.css";

const MIN_PASSWORD = 10;

// 임시 비밀번호 발급(관리자) 또는 첫 가입 직후처럼 "비밀번호를 먼저 바꿔야 하는" 세션이
// 오는 화면이다. server/src/auth/middleware.ts는 must_change_password가 참인 세션에서
// 이 화면과 GET /api/auth/me, POST /api/auth/logout을 뺀 모든 /api/*를 403으로 막는다
// — 그래서 이 화면은 RequireRole로 감싸지 않는다(직원 정보 조회 자체가 막혀 있다).
export default function ChangePassword() {
  const navigate = useNavigate();
  const { changePassword } = useAuth();
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
    // 서버도 거부하지만(QA W-05a) 화면이 먼저 말해 주는 편이 낫다. 임시 비밀번호를
    // 받은 사람이 쪽지의 값을 두 칸에 그대로 옮겨 적는 것이 가장 쉬운 길이었고,
    // 예전에는 그게 통과해 임시 비밀번호가 영구히 유효해졌다.
    if (next === current) {
      setError("지금 쓰는 비밀번호와 다른 값이어야 합니다");
      return;
    }
    setBusy(true);
    try {
      // AuthProvider.changePassword가 서버 호출 뒤 refresh()까지 마친다 — 그래서
      // navigate("/")할 때는 컨텍스트가 이미 authenticated 상태다. 예전에는 이 화면이
      // 서버만 부르고 navigate만 해서, RequireRole이 여전히 must-change-password로
      // 보고 있는 컨텍스트를 보고 다시 /login으로 돌려보냈다(리뷰 F1).
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
      <p>
        받은 임시 비밀번호와 <strong>다른 값</strong>으로 정하세요. 바꾸면 다른 기기에 남아 있는
        로그인은 모두 끊깁니다.
      </p>
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
