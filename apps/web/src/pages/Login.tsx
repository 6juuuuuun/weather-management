import { useState } from "react";
import type { FormEvent } from "react";
import "./Login.css";
import { requestMagicLink } from "../lib/api";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);

  // 서버는 가입 여부와 무관하게 항상 ok를 돌려준다(이메일 열거 방지). 그러니 여기서 감출
  // 정보는 없고, 요청 자체가 실패한 경우는 반드시 드러내야 한다 — 아니면 오지 않을 DM을
  // 계속 기다리게 된다(운영 배포 직후 CORS 차단으로 실제 발생).
  async function send() {
    if (!email || sending) return;
    setSending(true);
    setFailed(false);
    try {
      await requestMagicLink(email);
      setSubmitted(true);
    } catch (e) {
      console.error("매직링크 요청 실패", e);
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send();
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

        {submitted ? (
          <>
            <p className="login-lead">
              카카오워크 앱을 확인해 주세요.
              <br />
              5분 내 도착하지 않으면 카카오워크에 등록된 이메일 주소가 맞는지 확인해 주세요.
            </p>
            <button type="button" className="login-cta login-cta-ghost" onClick={send} disabled={sending}>
              {sending ? "전송 중…" : "다시 보내기"}
            </button>
            {failed && (
              <p className="login-error" role="alert">
                다시 보내지 못했습니다. 네트워크 상태를 확인한 뒤 시도해 주세요.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="login-lead">
              날씨 특보 감지부터 행동 지침 발송까지.
              <br />
              한 번의 승인으로 전 부서가 움직입니다.
            </p>

            <form className="login-form" onSubmit={onSubmit}>
              <label className="login-label" htmlFor="login-email">
                카카오워크에 등록된 회사 이메일
              </label>
              <input
                id="login-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                className="login-input"
                placeholder="카카오워크에 등록된 회사 이메일"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" className="login-cta" disabled={sending}>
                {sending ? "전송 중…" : "로그인 링크 받기"}
              </button>
            </form>

            {failed && (
              <p className="login-error" role="alert">
                링크를 보내지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.
                <br />
                계속 실패하면 시스템 관리자에게 알려 주세요.
              </p>
            )}

            <p className="login-fineprint">
              입력한 이메일로 카카오워크 DM에 로그인 링크가 도착합니다.
              <br />
              계정은 최초 로그인 시 자동으로 생성되며, 화면 접근 권한은 시스템 관리자가 지정합니다.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
