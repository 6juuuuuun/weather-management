import "./Login.css";

function goToKakaowork() {
  location.href = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/auth-kakaowork?action=login`;
}

export default function Login() {
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

        <button type="button" className="login-cta" onClick={goToKakaowork}>
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M12 4c-5 0-9 3.2-9 7.1 0 2.5 1.6 4.7 4.1 6-.2.7-.6 2.4-.7 2.8 0 0-.1.3.2.5.2.1.5 0 .5 0 .3-.1 2.9-1.9 3.4-2.3.5.1.9.1 1.5.1 5 0 9-3.2 9-7.1S17 4 12 4Z"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          카카오워크로 계속하기
        </button>

        <p className="login-fineprint">
          회사 카카오워크 계정으로 로그인하면 계정이 자동으로 만들어집니다.
          <br />
          화면 접근 권한은 시스템 관리자가 지정합니다.
        </p>
      </div>
    </div>
  );
}
