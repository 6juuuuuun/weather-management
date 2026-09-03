import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./AuthProvider";
import { RequireRole } from "./RequireRole";
import Login from "../pages/Login";
import ChangePassword from "../pages/ChangePassword";
import { jsonResponse, makeFetchQueue } from "../test-support/fetchQueue";

// 리뷰 F1·F4·F5는 컴포넌트 경계 "사이"에 있다 — Login/ChangePassword/RequireRole을
// 각각 단독으로 렌더하는 테스트로는 잡히지 않는다(useAuth를 통째로 목하면 그
// 배선 자체가 검증에서 빠진다). 그래서 여기서는 AuthProvider + 실제 라우팅을 함께
// 렌더하고 fetch만 스텁해, 서버 응답이 화면까지 실제로 흘러가는 경로를 끝까지 태운다.
// "/" 는 실제 Dashboard 대신 가벼운 마커로 대체한다 — GlobalNav의 부수 호출까지
// 끌어들이지 않고 RequireRole의 실제 판정만 확인하기 위해서다.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ initialPath }: { initialPath: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route
            path="/"
            element={
              <RequireRole roles={["admin", "approver", "staff"]}>
                <p>홈 화면</p>
              </RequireRole>
            }
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

const meMustChange = () =>
  jsonResponse({
    user: {
      accountId: "acc-1",
      employeeId: "emp-1",
      role: "staff",
      email: "a@gonjiam.com",
      mustChangePassword: true,
    },
  });

const meOk = () =>
  jsonResponse({
    user: {
      accountId: "acc-1",
      employeeId: "emp-1",
      role: "staff",
      email: "a@gonjiam.com",
      mustChangePassword: false,
    },
  });

const employeeRow = {
  id: "emp-1",
  auth_user_id: "acc-1",
  name: "홍길동",
  email: "a@gonjiam.com",
  notifiable: false,
  department_id: null,
  role: "staff",
  created_at: "2026-01-01T00:00:00Z",
};

describe("F1 — 비밀번호 변경 성공 후 홈에 도착한다", () => {
  it("must-change-password 세션에서 비밀번호를 바꾸면 로그인 화면이 아니라 홈으로 간다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);

    // 호출 순서: 1) 마운트 refresh() → me(must-change) · 2) 제출 → change-password(204) ·
    // 3) changePassword()가 이어서 부르는 refresh() → me(ok) → employees · alert-recipients.
    // FIFO라 반드시 이 순서로 미리 채워 둔다.
    push("/api/auth/me", meMustChange);
    push("/api/auth/change-password", () => jsonResponse(null, 204));
    push("/api/auth/me", meOk);
    push("/api/employees", () => jsonResponse([employeeRow]));
    push("/api/alert-recipients", () => jsonResponse([]));

    render(<Harness initialPath="/change-password" />);

    // ChangePassword 화면이 실제로 뜬다(라우트가 must-change-password를 막지 않는다).
    await screen.findByLabelText("현재 비밀번호");

    fireEvent.change(screen.getByLabelText("현재 비밀번호"), { target: { value: "temp-password-1" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "new-password-12345" } });
    fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: "new-password-12345" } });
    fireEvent.click(screen.getByRole("button", { name: /비밀번호 변경/ }));

    // 회귀: 예전에는 여기서 "날씨경영"/로그인 폼이 다시 떴다(F1) — 세션 쿠키는
    // 살아 있는데도 컨텍스트가 갱신되지 않아 RequireRole이 /login으로 돌려보냈다.
    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "날씨경영" })).not.toBeInTheDocument();
  });
});

describe("F4 — 로그인 후 부수 조회가 실패하면 오류를 보여주고 로그인 폼으로 되돌아가지 않는다", () => {
  it("로그인은 성공했지만 GET /api/employees가 500이면 설명이 있는 오류 화면을 보여준다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);

    // 호출 순서: 1) 마운트 refresh() → me(아직 로그인 전, 401) · 2) 로그인 제출 →
    // /api/auth/login(200) · 3) login()이 이어서 부르는 refresh() → me(ok) →
    // employees(500)·alert-recipients. FIFO라 미리 순서대로 채워 둔다.
    push("/api/auth/me", () => jsonResponse({ error: "로그인이 필요합니다" }, 401));
    push("/api/auth/login", () =>
      jsonResponse({
        user: { accountId: "acc-1", employeeId: "emp-1", role: "staff", email: "a@gonjiam.com", mustChangePassword: false },
        must_change_password: false,
      }),
    );
    push("/api/auth/me", meOk);
    push("/api/employees", () => jsonResponse({ error: "서버 오류가 발생했습니다" }, 500));
    push("/api/alert-recipients", () => jsonResponse([]));

    render(<Harness initialPath="/login" />);

    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "correct-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));

    // 회귀: 예전에는 이 경우도 employee=null로 뭉개져 "오류 메시지 한 줄 없이 로그인
    // 폼이 다시 뜨는" 무한 루프로 보였다(F4) — 비밀번호가 틀린 건지 서버가 아픈 건지
    // 구분할 단서가 전혀 없었다.
    await waitFor(() => expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "날씨경영" })).not.toBeInTheDocument();
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });
});

describe("F5 — 비밀번호 변경이 필요한 세션은 어디서 진입하든 변경 화면으로 간다", () => {
  it("보호된 라우트를 새로고침으로 직접 열어도 /login이 아니라 /change-password로 간다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);

    // 로그인 절차를 거치지 않고 곧장 "/"를 마운트한다 — must_change_password
    // 세션으로 새로고침한 상황을 흉내낸다.
    push("/api/auth/me", meMustChange);
    render(<Harness initialPath="/" />);

    // 회귀: 예전에는 mustChangePassword가 죽은 필드라 employee=null만 보고 /login으로
    // 갔다(F5) — 서버가 최종 게이트라 보안 구멍은 아니었지만 사용자는 임시 비밀번호를
    // 또 입력해 로그인부터 다시 해야 했다.
    expect(await screen.findByLabelText("현재 비밀번호")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "날씨경영" })).not.toBeInTheDocument();
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });
});


describe("항목 2 — status가 loading에 영원히 머물지 않는다", () => {
  it("/api/auth/me가 200이지만 user가 없는 본문을 주면 백지가 아니라 오류 화면에 도달한다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);

    // 서버 계약 위반을 흉내낸다 — 실제 서버(auth/routes.ts)는 항상 { user }를 주지만,
    // 라운드 1 리팩터로 이 접근이 어떤 try 안에도 없어서(수정 전) TypeError가 나면
    // useEffect의 떠 있는 프로미스가 unhandled로 죽어 status가 "loading"에 영원히
    // 머물렀다 — RequireRole이 계속 null을 반환하는 영구 백지 화면이었다.
    push("/api/auth/me", () => jsonResponse({}));

    const { container } = render(<Harness initialPath="/" />);

    // 백지(빈 body)로 멈추지 않고 결국 오류 화면(재시도 버튼)에 도달해야 한다.
    await waitFor(() => expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument());
    expect(container.textContent).not.toBe("");
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });
});

describe("항목 3 — 직원 행이 삭제된 계정은 /change-password가 아니라 안내 화면으로 간다", () => {
  it("employeeId가 없으면 거짓 '비밀번호 변경' 안내 대신 관리자 문의 안내와 로그아웃을 보여준다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);

    // 관리자가 employees 행을 지워도 auth_accounts는 남는다(server/src/auth/session.ts의
    // left join employees가 employeeId: null을 준다) — must_change_password는 거짓인데도
    // employeeId가 없는 상태다.
    push("/api/auth/me", () =>
      jsonResponse({
        user: {
          accountId: "acc-1",
          employeeId: null,
          role: null,
          email: "a@gonjiam.com",
          mustChangePassword: false,
        },
      }),
    );

    render(<Harness initialPath="/" />);

    // 회귀: 예전에는 이 상태가 must-change-password와 한 갈래로 묶여 /change-password로
    // 보내졌다 — 비밀번호를 바꿔도 employeeId는 여전히 null이라 같은 화면에 다시 갇혔다.
    expect(await screen.findByText(/관리자에게 문의해 주세요/)).toBeInTheDocument();
    expect(screen.queryByLabelText("현재 비밀번호")).not.toBeInTheDocument();

    // 빠져나갈 수단(로그아웃)이 실제로 동작한다.
    push("/api/auth/logout", () => jsonResponse(null, 204));
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));

    expect(await screen.findByRole("heading", { name: "날씨경영" })).toBeInTheDocument();
  });
});
