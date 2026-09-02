import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api/client";
import { signup, signupConfig } from "../lib/api/auth";
import { listDepartmentsForSignup } from "../lib/api/org";
import { formatPhoneInput, PHONE_MAX_LENGTH } from "../lib/phone";
import "./Signup.css";

const MIN_PASSWORD = 10;

export default function Signup() {
  const [email, setEmail] = useState("");
  // 도메인이 하나로 고정된 배포에서 쓰는 "아이디" 칸이다. 위의 email과 따로 둔다 —
  // 한 상태를 두 모드가 나눠 쓰면 모드가 바뀔 때 남은 값이 엉뚱한 자리에 실린다.
  const [emailLocal, setEmailLocal] = useState("");
  const [fixedDomain, setFixedDomain] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [phone, setPhone] = useState("");
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [deptsError, setDeptsError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  // 부서 목록은 로그인 없이도 필요하다. 마운트 시 곧바로 불러온다(리뷰 컨트롤러 판단,
  // task-9-fix1-brief.md 항목 6) — select를 처음 여는 시점까지 지연시켰던 이전 버전은
  // 네이티브 드롭다운이 열리는 순간과 응답 도착이 경합해, 첫 클릭에는 목록이 비어
  // 보이고 닫았다 다시 열어야 채워지는 창을 만들었다. 실패해도 가입 자체는 막지
  // 않지만, 조용히 삼키지 않고 눈에 보이는 오류와 재시도 수단을 준다 — 부서를 못
  // 고른 채 가입하면 department_id: null이 되어 requireDepartment 라우트가 막힌다.
  function loadDepts() {
    setDeptsError(false);
    listDepartmentsForSignup()
      // 응답이 배열이 아니면(예상 밖의 응답 포함) 조용히 빈 목록으로 둔다 — select가
      // 배열이 아닌 값에 .map을 호출해 화면 전체가 무너지는 것보다 안전한 실패다.
      .then((rows) => setDepts(Array.isArray(rows) ? rows : []))
      .catch(() => setDeptsError(true));
  }

  useEffect(() => {
    loadDepts();
  }, []);

  // 사내 이메일 도메인이 **정확히 하나**로 정해진 배포에서만 입력을 아이디와
  // 도메인으로 나눈다. 비어 있거나(제한 없음) 둘 이상이면 지금까지와 똑같은 자유
  // 입력 한 칸이다 — 도메인이 여럿이면 화면이 어느 쪽을 붙일지 정할 수 없다.
  //
  // 조회에 실패하면 자유 입력으로 남긴다. 여기서 가입을 막거나 오류를 띄우지 않는
  // 이유: 이 값은 편의를 위한 것이고, 최종 관문은 어차피 서버의 도메인 규칙이다
  // (server/src/auth/emailDomain.ts). 설정 조회 한 번의 실패로 가입 자체를 막으면
  // 부서 목록보다 훨씬 나쁜 실패가 된다.
  useEffect(() => {
    signupConfig()
      .then((cfg) => {
        const domains = Array.isArray(cfg?.email_domains) ? cfg.email_domains : [];
        setFixedDomain(domains.length === 1 && typeof domains[0] === "string" ? domains[0] : null);
      })
      .catch(() => setFixedDomain(null));
  }, []);

  // 아이디 칸에는 도메인이 섞여 들어오면 안 된다. 공백은 지우고, @가 있으면 그
  // 앞까지만 남긴다 — 주소 전체를 붙여넣는 것이 가장 흔한 동작이고, 도메인은 바로
  // 옆에 고정으로 보이므로 무엇이 제출되는지 화면에 그대로 드러난다.
  // (서버가 최종 관문이라는 사실은 그대로다: 여기를 우회해도 도메인 규칙에 걸린다.)
  function changeLocal(raw: string) {
    const noSpace = raw.replace(/\s/g, "");
    const at = noSpace.indexOf("@");
    setEmailLocal(at === -1 ? noSpace : noSpace.slice(0, at));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // 아이디가 비면 `@dnocorp.com`만 남은 주소가 나간다. 첫 관문은 input의 required라
    // 보통 여기까지 오지 않지만, 그 한 겹에만 기대지 않는다 — 이 값은 계정의 열쇠다.
    if (fixedDomain && !emailLocal) {
      setError("이메일 아이디를 입력해 주세요");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
      return;
    }
    // 확인 칸은 서버로 나가지 않는다 — 화면에서만 비교하고 막는다. 오타 하나로
    // 자기 계정에 못 들어가는 일을 막는 것이 목적이라, 값이 서버에 갈 이유가 없다.
    if (password !== passwordConfirm) {
      setError("비밀번호가 서로 다릅니다. 확인 칸을 다시 입력해 주세요");
      return;
    }
    setBusy(true);
    try {
      await signup({
        email: fixedDomain ? `${emailLocal}@${fixedDomain}` : email,
        password,
        name,
        department_id: departmentId || null,
        phone: phone || null,
      });
      setDone(true);
    } catch (err) {
      // 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다.
      setError(err instanceof ApiError ? err.message : "가입에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="signup">
        <h1>가입이 완료되었습니다</h1>
        <p>로그인 후 바로 이용할 수 있습니다.</p>
        <Link to="/login">로그인 화면으로</Link>
      </div>
    );
  }

  return (
    <div className="signup">
      <h1>가입</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">회사 이메일</label>
        {fixedDomain ? (
          <div className="signup-email-split">
            <input
              id="email"
              value={emailLocal}
              onChange={(e) => changeLocal(e.target.value)}
              autoComplete="username"
              required
            />
            <span className="signup-email-domain">@{fixedDomain}</span>
          </div>
        ) : (
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        )}

        <label htmlFor="password">비밀번호</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

        <label htmlFor="password-confirm">비밀번호 확인</label>
        <input
          id="password-confirm"
          type="password"
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          required
        />

        <label htmlFor="name">이름</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />

        <label htmlFor="department">부서</label>
        <select id="department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">선택하지 않음</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {deptsError && (
          <p className="signup-error">
            부서 목록을 불러오지 못했습니다.{" "}
            <button type="button" className="signup-retry" onClick={loadDepts}>
              다시 시도
            </button>
          </p>
        )}

        {/* 숫자만 남기고 하이픈은 화면이 넣는다(lib/phone.ts). 붙여넣은
            `01012345678`·`010 1234 5678`도 이 자리에서 정규형이 된다.
            형식 판정은 서버가 한다(server/src/phone.ts) — 규칙을 두 벌로 적지 않는다. */}
        <label htmlFor="phone">휴대폰 번호</label>
        <input
          id="phone"
          value={phone}
          inputMode="numeric"
          maxLength={PHONE_MAX_LENGTH}
          onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
          placeholder="010-0000-0000"
        />

        {error && <p className="signup-error">{error}</p>}
        <button type="submit" disabled={busy}>가입하기</button>
      </form>
      <Link to="/login">이미 계정이 있으신가요?</Link>
    </div>
  );
}
