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
  setAccountStatus: vi.fn(),
  resetPassword: vi.fn(),
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

vi.mock("../lib/api/auth", () => ({
  setAccountStatus: (...a: unknown[]) => mocks.setAccountStatus(...a),
  resetPassword: (...a: unknown[]) => mocks.resetPassword(...a),
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
  phone: null,
  created_at: "2026-01-01T00:00:00Z",
};

const target = {
  id: "emp-1",
  auth_user_id: "u-target",
  name: "홍길동",
  email: "hong-typo@gonjiam.com",
  kakaowork_user_id: null,
  department_id: "d1",
  role: "staff" as const,
  phone: null,
  created_at: "2026-02-01T00:00:00Z",
  account_status: "active" as const,
};

const unregistered = {
  id: "emp-2",
  auth_user_id: null,
  name: "미가입자",
  email: "pending@gonjiam.com",
  kakaowork_user_id: null,
  department_id: "d1",
  role: "staff" as const,
  phone: null,
  created_at: "2026-02-01T00:00:00Z",
  account_status: null,
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
  mocks.setAccountStatus.mockReset().mockResolvedValue({ ok: true });
  mocks.resetPassword.mockReset().mockResolvedValue({ temporary_password: "temp-abc123" });
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

describe("Employees 계정 관리", () => {
  // 가입은 열려 있고 권한만 관리자가 준다 — 이 역할 변경 select가 실제 승인 권한을
  // 여닫는 관문이다. 화면이 없으면 아무도 특보를 승인할 수 없다.
  it("역할을 바꾸면 updateEmployee에 role만 실어 보낸다", async () => {
    renderPage();
    const roleSelect = await screen.findByLabelText("홍길동 역할");
    fireEvent.change(roleSelect, { target: { value: "approver" } });

    await waitFor(() => expect(mocks.updateEmployee).toHaveBeenCalledWith("emp-1", { role: "approver" }));
  });

  // 리뷰 F7: select는 <select value={e.role}>로 React 상태에 묶여 있지만, 네이티브
  // select 엘리먼트는 change 이벤트가 발생하는 즉시 스스로 표시값을 바꾼다. 실패
  // 처리에서 다시 렌더를 트리거하지 않으면 그 값이 그대로 남아, 토스트는 실패를
  // 말해도 셀에는 사용자가 고른 새 역할(승인자)이 남는다 — 관리자는 권한을 준
  // 줄 안다(브리프가 "이것이 실제 관문"이라 못 박은 지점).
  it("역할 변경이 실패하면 select가 서버의 실제 값(원래 역할)으로 되돌아간다", async () => {
    mocks.updateEmployee.mockRejectedValue(new ApiError(403, "권한이 없습니다"));
    renderPage();
    const roleSelect = await screen.findByLabelText("홍길동 역할");
    fireEvent.change(roleSelect, { target: { value: "approver" } });

    expect(await screen.findByText("권한이 없습니다")).toBeInTheDocument();
    // loadAll()이 다시 불려 listEmployees가 재호출되는지(=서버 값을 다시 읽는지)까지
    // 함께 확인한다 — 재호출 없이 select만 우연히 원상태처럼 보이는 거짓 통과를 막는다.
    await waitFor(() => expect(mocks.listEmployees).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(roleSelect).toHaveValue("staff"));
  });

  // 퇴사자를 막는 유일한 수단이다. 서버 호출 없이 화면 상태만 바꾸면 실제로는
  // 계정이 살아 있는데 관리자만 비활성화됐다고 믿게 된다.
  it("계정을 비활성화하면 setAccountStatus를 부르고, 다시 불러온 목록에서 흐리게 표시한다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    // 수정 라운드 1 · 리뷰 F3: 비활성화 표시는 이제 로컬 상태가 아니라 서버가 다시
    // 내려주는 account_status를 그대로 읽는다 — 그래서 이 목이 "요청이 실제로
    // 서버 상태를 바꿨고, 화면이 그걸 다시 불러왔다"를 흉내 낸다. loadAll()을 부르지
    // 않으면(또는 setAccountStatus를 부르지 않으면) 이 목의 상태가 안 바뀌어 아래
    // 단언이 실패한다.
    let currentStatus: "active" | "disabled" = "active";
    mocks.listEmployees.mockImplementation(() => Promise.resolve([{ ...target, account_status: currentStatus }]));
    mocks.setAccountStatus.mockImplementation(async (_id: string, status: "active" | "disabled") => {
      currentStatus = status;
      return { ok: true };
    });
    renderPage();
    const disableBtn = await screen.findByRole("button", { name: "비활성화" });
    fireEvent.click(disableBtn);

    await waitFor(() => expect(mocks.setAccountStatus).toHaveBeenCalledWith("u-target", "disabled"));
    expect(await screen.findByText("비활성화됨")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "활성화" })).toBeInTheDocument();
  });

  it("확인 대화상자를 취소하면 아무 요청도 보내지 않는다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    const disableBtn = await screen.findByRole("button", { name: "비활성화" });
    fireEvent.click(disableBtn);

    await waitFor(() => expect(disableBtn).toBeInTheDocument());
    expect(mocks.setAccountStatus).not.toHaveBeenCalled();
  });

  // 응답의 temporary_password는 이 호출 한 번에만 내려온다 — 화면에 보여주지 않으면
  // 관리자가 당사자에게 전달할 방법이 없다.
  it("임시 비밀번호를 발급하면 응답값을 화면에 보여준다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    const issueBtn = await screen.findByRole("button", { name: "임시 비밀번호 발급" });
    fireEvent.click(issueBtn);

    await waitFor(() => expect(mocks.resetPassword).toHaveBeenCalledWith("u-target"));
    expect(await screen.findByText("temp-abc123")).toBeInTheDocument();
  });

  // 임시 비밀번호는 만료된다(스펙 §6.4). 만료가 있다는 사실이 화면에 안 보이면
  // 관리자는 "왜 로그인이 안 되죠"라는 문의로만 만료를 알게 된다.
  it("임시 비밀번호의 만료 시간을 함께 안내한다", async () => {
    mocks.resetPassword.mockResolvedValue({ temporary_password: "temp-abc123", expires_in_hours: 72 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "임시 비밀번호 발급" }));

    expect(await screen.findByText(/72시간 뒤에 만료/)).toBeInTheDocument();
  });

  // 계정이 없는(사전 등록만 된) 직원에게는 계정 관리 버튼을 보여줄 수 없다 — 대상 계정이
  // 없다.
  it("계정이 없는 직원은 미가입으로 표시하고 계정 관리 버튼을 보여주지 않는다", async () => {
    mocks.listEmployees.mockResolvedValue([target, unregistered]);
    renderPage();

    await screen.findByText("미가입자");
    expect(screen.getByText("미가입")).toBeInTheDocument();
  });

  // 관리자가 자기 자신을 비활성화하면 서버가 다음 요청부터 그 세션을 즉시 무효화한다
  // (auth/session.ts의 lookup이 status='active'를 요구) — 관리자 자신을 잠글 수
  // 있는 버튼을 보여주면 안 된다. reset-password도 서버가 자기 자신은 403으로
  // 거부한다(auth/routes.ts).
  it("본인 계정에는 비활성화·임시 비밀번호 버튼을 보여주지 않는다", async () => {
    mocks.listEmployees.mockResolvedValue([admin, target]);
    renderPage();

    await screen.findByText("김운영");
    // "홍길동"(target) 행의 버튼은 존재해야 하고, 본인(admin) 행에는 없어야 한다 —
    // 버튼 이름만으로는 행을 구분할 수 없으므로 개수로 확인한다(직원이 1명일 때만 존재).
    expect(screen.getAllByRole("button", { name: "비활성화" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "임시 비밀번호 발급" })).toHaveLength(1);
  });
});
