import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import "./Login.css";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../lib/api/client";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // server/src/auth/routes.ts는 계정이 없을 때와 비밀번호가 틀렸을 때를 401로 같게
  // 묶어(이메일 존재 여부 노출 방지) 이미 사람이 읽을 수 있는 문구를 내려준다.
  // 403(계정 비활성화)만 여기서 고정 문구로 짚어 둔다.
  //
  // 423(잠금)은 **서버 문구를 그대로 쓴다**(QA W-18). 예전에는 여기서
  // "잠시 후 다시 시도해 주세요"로 고정해 버려서, 로그인 실패와 계정 잠금이 화면에서
  // 구분되지 않았다 — 사용자는 비밀번호를 계속 틀렸다고 믿고 계속 시도해 잠금을
  // 연장했고, 15분이라는 정보는 매뉴얼에만 있었다(잠긴 사람은 매뉴얼을 안 본다).
  // 남은 시간은 서버만 알 수 있으므로 문구를 고정하면 그 값을 영영 못 보여 준다.
  async function submit() {
    if (!email || !password || sending) return;
    setSending(true);
    setError(null);
    try {
      const { mustChangePassword } = await login(email, password);
      navigate(mustChangePassword ? "/change-password" : "/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 403) setError("사용할 수 없는 계정입니다. 관리자에게 문의해 주세요");
        else setError(e.message);
      } else {
        setError("로그인에 실패했습니다");
      }
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="login-logo" aria-hidden="true">
          <svg className="login-logo-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M17 8a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 6.1 4 4 0 0 1 17 8Z"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10 3v1.2M6 4.6l.7.9M4 8h1.2M18.3 5.5l-.7.9"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>

        <h1 className="login-title">날씨경영</h1>

        <p className="login-lead">
          날씨 특보 감지부터 행동 지침 발송까지.
          <br />
          한 번의 승인으로 전 부서가 움직입니다.
        </p>

        <form className="login-form" onSubmit={onSubmit}>
          <label className="login-label" htmlFor="login-email">
            이메일
          </label>
          <input
            id="login-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            className="login-input"
            placeholder="회사 이메일"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />

          <label className="login-label" htmlFor="login-password">
            비밀번호
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            className="login-input"
            placeholder="비밀번호"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <button type="submit" className="login-cta" disabled={sending}>
            {sending ? "로그인 중…" : "로그인"}
          </button>
        </form>

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <Link to="/signup" className="login-signup-link">
          계정이 없으신가요? 가입 신청
        </Link>
      </div>
    </div>
  );
}
