import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiSend, ApiError } from "../lib/api/client";
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
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const deptsRequested = useRef(false);

  // 부서 목록은 로그인 없이도 필요하다. 실패해도 가입 자체는 막지 않는다. 마운트 시
  // 곧바로 불러오지 않고 select를 처음 여는 시점(포커스)에 불러온다 — 이름·이메일만
  // 입력하고 부서를 건드리지 않는 사람에게는 불필요한 요청이기도 하고, 이미 끝난
  // 입력 검증(예: 비밀번호 길이 미달)만으로 아무 네트워크 요청도 나가지 않아야 하는
  // 경우와 부서 목록 요청이 뒤섞이는 것도 피한다.
  function loadDeptsOnce() {
    if (deptsRequested.current) return;
    deptsRequested.current = true;
    listDepartments()
      // 응답이 배열이 아니면(예상 밖의 응답 포함) 조용히 빈 목록으로 둔다 — select가
      // 배열이 아닌 값에 .map을 호출해 화면 전체가 무너지는 것보다 "부서 선택
      // 불가"가 훨씬 안전한 실패다.
      .then((rows) => setDepts(Array.isArray(rows) ? rows : []))
      .catch(() => setDepts([]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
      return;
    }
    setBusy(true);
    try {
      await apiSend("POST", "/api/auth/signup", {
        email, password, name, department_id: departmentId || null, phone: phone || null,
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
        <select
          id="department"
          value={departmentId}
          onFocus={loadDeptsOnce}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          <option value="">선택하지 않음</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        <label htmlFor="phone">휴대폰 번호</label>
        <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-0000-0000" />

        {error && <p className="signup-error">{error}</p>}
        <button type="submit" disabled={busy}>가입하기</button>
      </form>
      <Link to="/login">이미 계정이 있으신가요?</Link>
    </div>
  );
}
