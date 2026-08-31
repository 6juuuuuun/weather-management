import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Guidelines from "./Guidelines";
import type { Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  authState: { employee: null as Employee | null },
  listDepartments: vi.fn(),
  listEmployees: vi.fn(),
  listRecipients: vi.fn(),
  saveRecipients: vi.fn(),
  guidelines: vi.fn(),
  saveGuidelines: vi.fn(),
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ employee: mocks.authState.employee, loading: false, signOut: vi.fn() }),
}));

vi.mock("../lib/api/org", () => ({
  listDepartments: (...args: unknown[]) => mocks.listDepartments(...args),
  listEmployees: (...args: unknown[]) => mocks.listEmployees(...args),
  listRecipients: (...args: unknown[]) => mocks.listRecipients(...args),
  saveRecipients: (...args: unknown[]) => mocks.saveRecipients(...args),
}));

vi.mock("../lib/api/content", () => ({
  guidelines: (...args: unknown[]) => mocks.guidelines(...args),
  saveGuidelines: (...args: unknown[]) => mocks.saveGuidelines(...args),
}));

// AppLayout이 항상 GlobalNav를 그리고, GlobalNav는 dashboard api를 부른다.
vi.mock("../lib/api/dashboard", () => ({
  siteSettings: (...args: unknown[]) => mocks.siteSettings(...args),
  heartbeat: (...args: unknown[]) => mocks.heartbeat(...args),
}));

function adminEmployee(): Employee {
  return {
    id: "admin-1",
    auth_user_id: "u-admin",
    name: "김운영",
    email: "kim@example.com",
    kakaowork_user_id: null,
    department_id: null,
    role: "admin",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function staffEmployee(): Employee {
  return {
    id: "staff-1",
    auth_user_id: "u-staff",
    name: "홍수진",
    email: "hong@example.com",
    kakaowork_user_id: null,
    department_id: "l1",
    role: "staff",
    created_at: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  mocks.listDepartments.mockReset().mockResolvedValue([]);
  mocks.listEmployees.mockReset().mockResolvedValue([]);
  mocks.listRecipients.mockReset().mockResolvedValue([]);
  mocks.saveRecipients.mockReset().mockResolvedValue(null);
  mocks.guidelines.mockReset().mockResolvedValue([]);
  mocks.saveGuidelines.mockReset().mockResolvedValue(null);
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
});

describe("Guidelines", () => {
  it("부서가 0행이면 빈 상태와 admin CTA를 보여준다", async () => {
    mocks.authState.employee = adminEmployee();

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    expect(await screen.findByText("아직 등록된 부서가 없습니다")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /부서 관리 열기/ });
    expect(cta).toHaveAttribute("href", "/employees?dept=open");
  });

  it("staff는 부서 트리를 보되 저장 버튼은 숨겨진다", async () => {
    mocks.authState.employee = staffEmployee();
    // departments API는 id/name만 내려준다(parent_id 없음) — 평면 목록.
    mocks.listDepartments.mockResolvedValue([{ id: "l1", name: "객실" }]);
    mocks.listEmployees.mockResolvedValue([staffEmployee()]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "l1", employee_id: "staff-1", name: "홍수진", role: "staff", kakaowork_user_id: null },
    ]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    expect(await screen.findByText("객실")).toBeInTheDocument();
    expect(await screen.findByText("폭우 대응 지침")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "지침 저장" })).not.toBeInTheDocument();
  });
});
