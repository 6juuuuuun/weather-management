import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireRole } from "./RequireRole";
import type { Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  authState: {
    status: "authenticated" as
      | "loading"
      | "anonymous"
      | "must-change-password"
      | "authenticated"
      | "error",
    employee: null as Employee | null,
    loading: false,
    isApprover: false,
    authError: null as string | null,
    refresh: () => Promise.resolve(),
  },
}));

vi.mock("./AuthProvider", () => ({
  useAuth: () => mocks.authState,
}));

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-1",
    auth_user_id: "u1",
    name: "테스터",
    email: "t@example.com",
    kakaowork_user_id: "kw-1",
    department_id: null,
    role: "staff",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderAt(path: string, requireDepartment?: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/guarded"
          element={
            <RequireRole roles={["admin", "approver", "staff"]} requireDepartment={requireDepartment}>
              <div>보호된 화면</div>
            </RequireRole>
          }
        />
        <Route path="/" element={<div>대시보드</div>} />
        <Route path="/login" element={<div>로그인 화면</div>} />
        <Route path="/change-password" element={<div>비밀번호 변경 화면</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireRole requireDepartment", () => {
  beforeEach(() => {
    mocks.authState.isApprover = false;
    mocks.authState.status = "authenticated";
  });

  it("부서 미지정 실무자는 requireDepartment 화면에서 대시보드로 리다이렉트된다", () => {
    mocks.authState.employee = makeEmployee({ role: "staff", department_id: null });
    renderAt("/guarded", true);
    expect(screen.queryByText("보호된 화면")).not.toBeInTheDocument();
    expect(screen.getByText("대시보드")).toBeInTheDocument();
  });

  it("부서가 지정된 실무자는 requireDepartment 화면에 접근할 수 있다", () => {
    mocks.authState.employee = makeEmployee({ role: "staff", department_id: "dept-1" });
    renderAt("/guarded", true);
    expect(screen.getByText("보호된 화면")).toBeInTheDocument();
  });

  it("requireDepartment가 없으면 부서 미지정 실무자도 접근할 수 있다", () => {
    mocks.authState.employee = makeEmployee({ role: "staff", department_id: null });
    renderAt("/guarded", false);
    expect(screen.getByText("보호된 화면")).toBeInTheDocument();
  });

  it("관리자는 부서 미지정이어도 requireDepartment 화면에 접근할 수 있다", () => {
    mocks.authState.employee = makeEmployee({ role: "admin", department_id: null });
    renderAt("/guarded", true);
    expect(screen.getByText("보호된 화면")).toBeInTheDocument();
  });

  it("부서 미지정 staff라도 Alert 수신자면 통과시킨다", () => {
    mocks.authState.employee = makeEmployee({ role: "staff", department_id: null });
    mocks.authState.isApprover = true;
    renderAt("/guarded", true);
    expect(screen.getByText("보호된 화면")).toBeInTheDocument();
  });
});

// F1·F4·F5의 근본 원인: employee=null 하나가 "인증 안 됨"·"비밀번호 변경 필요"·
// "부수 조회 실패" 세 가지를 동시에 뜻해 여기서 셋을 구분하지 못하고 전부 /login으로
// 보냈다. status를 직접 조작해 RequireRole이 넷을 서로 다르게 처리하는지 확인한다.
describe("RequireRole 상태 분기", () => {
  beforeEach(() => {
    mocks.authState.employee = null;
    mocks.authState.isApprover = false;
    mocks.authState.authError = null;
  });

  it("loading이면 아무것도 렌더하지 않는다(리다이렉트하지 않는다)", () => {
    mocks.authState.status = "loading";
    const { container } = renderAt("/guarded");
    expect(container.textContent).toBe("");
  });

  it("anonymous면 /login으로 보낸다", () => {
    mocks.authState.status = "anonymous";
    renderAt("/guarded");
    expect(screen.getByText("로그인 화면")).toBeInTheDocument();
  });

  it("must-change-password면 /login이 아니라 /change-password로 보낸다", () => {
    mocks.authState.status = "must-change-password";
    renderAt("/guarded");
    expect(screen.getByText("비밀번호 변경 화면")).toBeInTheDocument();
    expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
  });

  it("error면 리다이렉트하지 않고 화면에 오류와 재시도 버튼을 보여준다", () => {
    mocks.authState.status = "error";
    mocks.authState.authError = "직원 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    renderAt("/guarded");
    expect(screen.getByText("직원 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
    expect(screen.queryByText("로그인 화면")).not.toBeInTheDocument();
    expect(screen.queryByText("보호된 화면")).not.toBeInTheDocument();
  });
});
