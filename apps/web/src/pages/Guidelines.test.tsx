import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Guidelines from "./Guidelines";
import type { Employee } from "../lib/types";

const { authState, tableData, fromMock } = vi.hoisted(() => {
  const authState: { employee: Employee | null } = { employee: null };
  const tableData: Record<string, { data: unknown; error: unknown }> = {};
  const fromMock = vi.fn();
  return { authState, tableData, fromMock };
});

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ employee: authState.employee, loading: false, signOut: vi.fn() }),
}));

vi.mock("../lib/supabase", () => ({
  supabase: { from: fromMock },
}));

// 체이닝 가능한 쿼리 목: select/eq/order/upsert/delete/insert 어떤 조합으로 호출해도
// 마지막에 await 하면 등록된 결과값으로 resolve 된다.
function makeQuery(result: { data: unknown; error: unknown }) {
  const promise = Promise.resolve(result);
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop in target) {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return () => makeQuery(result);
    },
  });
}

fromMock.mockImplementation((table: string) => makeQuery(tableData[table] ?? { data: [], error: null }));

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

describe("Guidelines", () => {
  it("부서가 0행이면 빈 상태와 admin CTA를 보여준다", async () => {
    authState.employee = adminEmployee();
    tableData.departments = { data: [], error: null };
    tableData.employees = { data: [], error: null };
    tableData.recipients = { data: [], error: null };
    tableData.action_guidelines = { data: [], error: null };

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
    authState.employee = staffEmployee();
    tableData.departments = {
      data: [
        { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
        { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
      ],
      error: null,
    };
    tableData.employees = { data: [staffEmployee()], error: null };
    tableData.recipients = { data: [{ department_id: "l1", employee_id: "staff-1" }], error: null };
    tableData.action_guidelines = { data: [], error: null };

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
