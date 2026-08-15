import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RequireRole } from "./RequireRole";
import type { Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
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
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireRole requireDepartment", () => {
  beforeEach(() => {
    mocks.authState.isApprover = false;
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
