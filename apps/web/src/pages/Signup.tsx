import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api/client";
import { signup } from "../lib/api/auth";
import { listDepartments } from "../lib/api/org";
import "./Signup.css";

const MIN_PASSWORD = 10;

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    listDepartments()
      // 응답이 배열이 아니면(예상 밖의 응답 포함) 조용히 빈 목록으로 둔다 — select가
      // 배열이 아닌 값에 .map을 호출해 화면 전체가 무너지는 것보다 안전한 실패다.
      .then((rows) => setDepts(Array.isArray(rows) ? rows : []))
      .catch(() => setDeptsError(true));
  }

  useEffect(() => {
    loadDepts();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
      return;
    }
    setBusy(true);
    try {
      await signup({
        email,
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
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label htmlFor="password">비밀번호</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

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

        <label htmlFor="phone">휴대폰 번호</label>
        <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-0000-0000" />

        {error && <p className="signup-error">{error}</p>}
        <button type="submit" disabled={busy}>가입하기</button>
      </form>
      <Link to="/login">이미 계정이 있으신가요?</Link>
    </div>
  );
}
