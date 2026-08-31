import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../lib/api/client";
import Employees from "./Employees";
import type { Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  listEmployees: vi.fn(),
  listDepartments: vi.fn(),
  updateEmployee: vi.fn(),
  deleteEmployee: vi.fn(),
  createEmployee: vi.fn(),
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));

vi.mock("../lib/api/org", () => ({
  listEmployees: (...a: unknown[]) => mocks.listEmployees(...a),
  listDepartments: (...a: unknown[]) => mocks.listDepartments(...a),
  updateEmployee: (...a: unknown[]) => mocks.updateEmployee(...a),
  deleteEmployee: (...a: unknown[]) => mocks.deleteEmployee(...a),
  createEmployee: (...a: unknown[]) => mocks.createEmployee(...a),
}));

// AppLayout이 항상 GlobalNav를 그리고, GlobalNav는 dashboard api를 부른다.
vi.mock("../lib/api/dashboard", () => ({
  siteSettings: (...a: unknown[]) => mocks.siteSettings(...a),
  heartbeat: (...a: unknown[]) => mocks.heartbeat(...a),
}));

const admin: Employee = {
  id: "admin-1",
  auth_user_id: "u-admin",
  name: "김운영",
  email: "kim@gonjiam.com",
  kakaowork_user_id: null,
  department_id: null,
  role: "admin",
  created_at: "2026-01-01T00:00:00Z",
};

const target = {
  id: "emp-1",
  auth_user_id: null,
  name: "홍길동",
  email: "hong-typo@gonjiam.com",
  kakaowork_user_id: null,
  department_id: "d1",
  role: "staff" as const,
  phone: null,
  created_at: "2026-02-01T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <Employees />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.authState = { employee: admin, loading: false, isApprover: false };
  mocks.listEmployees.mockReset().mockResolvedValue([target]);
  mocks.listDepartments.mockReset().mockResolvedValue([
    { id: "d1", parent_id: null, name: "객실", sort_order: 1 },
  ]);
  mocks.updateEmployee.mockReset().mockResolvedValue(target);
  mocks.deleteEmployee.mockReset().mockResolvedValue(null);
  mocks.createEmployee.mockReset().mockResolvedValue(target);
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
});

describe("Employees 초기 로드", () => {
  // 새 API 클라이언트는 HTTP 오류에 throw한다(supabase-js는 resolve했다). 로더에
  // try/catch가 없으면 setLoading(false)에 닿지 못해 "불러오는 중…"이 영구히 남는다.
  it("조회가 실패하면 불러오는 중에 멈추지 않고 오류를 보여준다", async () => {
    mocks.listEmployees.mockRejectedValue(new ApiError(401, "로그인이 필요합니다"));
    renderPage();

    expect(await screen.findByText(/로그인이 필요합니다/)).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });
});

describe("Employees 직원 수정", () => {
  async function openEditModal() {
    renderPage();
    const editBtn = await screen.findByLabelText("홍길동 수정");
    fireEvent.click(editBtn);
    return await screen.findByText("직원 수정");
  }

  // 이메일은 가입(POST /api/auth/signup)이 이 직원 행에 계정을 이어 붙이는 병합 키다.
  // 보내지 않으면 관리자는 "수정했습니다" 토스트를 보고 고쳤다고 믿는데 값은 버려지고,
  // 그 직원은 가입해도 부서·역할이 유실된 별도 계정이 된다.
  it("수정한 이메일을 updateEmployee에 실어 보낸다", async () => {
    await openEditModal();

    const emailInput = screen.getByDisplayValue("hong-typo@gonjiam.com");
    fireEvent.change(emailInput, { target: { value: "hong@gonjiam.com" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(mocks.updateEmployee).toHaveBeenCalled());
    const [id, patch] = mocks.updateEmployee.mock.calls[0];
    expect(id).toBe("emp-1");
    expect(patch.email).toBe("hong@gonjiam.com");
  });

  // 서버는 employees.email의 unique 위반을 409 + 사람이 읽을 수 있는 문구로 준다.
  // 그걸 삼키고 성공 토스트를 띄우면 중복 저장이 성공한 것처럼 보인다.
  it("중복 이메일(409)이면 성공이 아니라 서버 문구를 보여준다", async () => {
    mocks.updateEmployee.mockRejectedValue(new ApiError(409, "이미 등록된 이메일입니다"));
    await openEditModal();

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("이미 등록된 이메일입니다")).toBeInTheDocument();
    expect(screen.queryByText("직원 정보를 수정했습니다")).not.toBeInTheDocument();
  });
});
