import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../lib/api/client";
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
  deleteGuideline: vi.fn(),
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
  deleteGuideline: (...args: unknown[]) => mocks.deleteGuideline(...args),
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
    phone: null,
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
    phone: null,
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
  mocks.deleteGuideline.mockReset().mockResolvedValue(null);
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
});

describe("Guidelines", () => {
  // 새 API 클라이언트는 HTTP 오류에 throw한다(supabase-js는 resolve했다). 로더에
  // try/catch가 없으면 setLoading(false)에 닿지 못해 "불러오는 중…"이 영구히 남는다.
  it("조회가 실패하면 불러오는 중에 멈추지 않고 오류를 보여준다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockRejectedValue(new ApiError(401, "로그인이 필요합니다"));

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/로그인이 필요합니다/)).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });

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
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
    ]);
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

  // 직원 삭제가 이제 로그인 계정까지 지운다(QA W-01, 결정 D-1). 그 대신 서버가
  // 수정 시점의 이름을 스냅샷해 준다 — 화면이 그 이름을 쓰지 않으면 "마지막 수정"
  // 옆이 그냥 비어, 누가 고쳤는지가 통째로 사라진다.
  it("수정자가 명부에 없으면 스냅샷된 이름에 (삭제된 직원)을 붙여 보여준다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
    ]);
    // 명부에는 관리자만 남아 있다 — 지침을 고친 emp-gone은 지워졌다.
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);
    mocks.guidelines.mockResolvedValue([
      {
        id: "g-1",
        department_id: "l1",
        kind: "rain",
        grade: "watch",
        staff_actions: [],
        guest_notice: "",
        updated_at: "2026-03-01T00:00:00Z",
        updated_by: "emp-gone",
        updated_by_name: "홍길동",
      },
    ]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/홍길동\(삭제된 직원\)/)).toBeInTheDocument();
  });

  // 등록한 지침을 지울 수단이 아예 없었다(QA W-22). 부서를 재편하면 쓰지 않는 지침이
  // 영구히 남아 초안에 계속 블록으로 끼고, 무력화하려고 내용을 비우면 제목만 있는 DM이 나간다.
  const RAIN_WATCH_GUIDELINE = {
    id: "g-1",
    department_id: "l1",
    kind: "rain",
    grade: "watch",
    staff_actions: ["수건 배포"],
    guest_notice: "안내문",
    updated_at: "2026-03-01T00:00:00Z",
    updated_by: "admin-1",
    updated_by_name: "김운영",
  };

  function renderWithGuideline(rows: unknown[] = [RAIN_WATCH_GUIDELINE]) {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);
    mocks.guidelines.mockResolvedValue(rows);
    return render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );
  }

  it("등록된 지침은 삭제할 수 있다", async () => {
    renderWithGuideline();
    fireEvent.click(await screen.findByRole("button", { name: "지침 삭제" }));
    // 확인 없이 지우면 승인 대상 부서가 조용히 사라진다.
    expect(await screen.findByText("이 지침을 삭제할까요?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(mocks.deleteGuideline).toHaveBeenCalledWith("g-1"));
    // 지운 뒤 목록을 다시 읽어야 화면과 서버가 어긋나지 않는다(초기 로드 + 갱신 = 2회).
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalledTimes(2));
  });

  // 부서 목록의 점은 "이 부서에 지침이 등록됐다"는 표시다. 예전에는 종류(kind)를 보지
  // 않아 폭우 탭에서 등록한 지침이 폭설 탭에서도 등록된 것처럼 보였고, 내용이 빈 지침도
  // 등록으로 셌다(QA W-22) — 실제로는 제목만 있는 DM이 나간다.
  it("부서 목록의 지침 표시는 지금 선택한 종류의, 내용이 있는 지침만 센다", async () => {
    const { container } = renderWithGuideline([
      RAIN_WATCH_GUIDELINE,
      { ...RAIN_WATCH_GUIDELINE, id: "g-2", kind: "snow", staff_actions: [], guest_notice: "" },
    ]);
    await screen.findByText("객실");
    // 폭우 탭: 주의보 지침이 등록돼 있다.
    expect(container.querySelector(".tree-dot-watch")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "폭설" }));
    // 폭설 탭: 행은 있지만 내용이 비어 있으므로 등록으로 세지 않는다.
    await waitFor(() => expect(container.querySelector(".tree-dot-watch")).toBeNull());
  });

  it("지침이 없는 부서·종류에는 삭제 버튼이 없다", async () => {
    renderWithGuideline([]);
    expect(await screen.findByRole("button", { name: "지침 저장" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "지침 삭제" })).toBeNull();
  });

  it("삭제가 실패하면 사유를 보여주고 목록을 그대로 둔다", async () => {
    mocks.deleteGuideline.mockRejectedValue(new ApiError(404, "지침을 찾을 수 없습니다"));
    renderWithGuideline();
    fireEvent.click(await screen.findByRole("button", { name: "지침 삭제" }));
    fireEvent.click(await screen.findByRole("button", { name: "삭제" }));
    expect(await screen.findByText(/지침을 찾을 수 없습니다/)).toBeInTheDocument();
  });

  it("수정자가 명부에 있으면 명부의 이름을 그대로 보여준다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);
    mocks.guidelines.mockResolvedValue([
      {
        id: "g-1",
        department_id: "l1",
        kind: "rain",
        grade: "watch",
        staff_actions: [],
        guest_notice: "",
        updated_at: "2026-03-01T00:00:00Z",
        updated_by: "admin-1",
        updated_by_name: "김운영",
      },
    ]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/김운영/)).toBeInTheDocument();
    expect(screen.queryByText(/삭제된 직원/)).not.toBeInTheDocument();
  });
  // ---------------------------------------------------------------------------
  // QA W-15 · 화면이 정확히 2단만 그려서 3단 부서와 자식 없는 최상위 부서는
  // 데이터에 있는데도 목록에 나타나지 않았다 — 지침을 등록할 방법 자체가 없었다.
  // ---------------------------------------------------------------------------

  it("3단 부서를 지침 등록 가능한 리프로 보여준다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
      { id: "l2", parent_id: "l1", name: "프론트", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    // 3단 부서가 보이고, 클릭 가능한 리프여야 한다(중간 단계인 '객실'은 접기 헤더).
    const front = await screen.findByRole("button", { name: /프론트/ });
    expect(front).toHaveClass("guidelines-leaf");
    fireEvent.click(front);
    // 빵부스러기가 루트부터의 전체 경로를 말한다.
    expect(await screen.findByText("리조트 · 객실 · 프론트")).toBeInTheDocument();
  });

  it("자식 없는 최상위 부서도 지침을 등록할 수 있는 리프다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "solo", parent_id: null, name: "안전관리팀", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    const solo = await screen.findByRole("button", { name: /안전관리팀/ });
    expect(solo).toHaveClass("guidelines-leaf");
    // 기본 선택이 그 부서로 잡혀 편집기가 열린다 — 예전에는 좌측이 통째로 비어
    // "좌측에서 부서를 선택하세요."에서 더 나아갈 수 없었다.
    expect(await screen.findByText("폭우 대응 지침")).toBeInTheDocument();
    expect(screen.queryByText("좌측에서 부서를 선택하세요.")).not.toBeInTheDocument();
  });

  it("중간 단계 부서는 접기 헤더이고 접으면 그 아래가 전부 사라진다", async () => {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
      { id: "l2", parent_id: "l1", name: "프론트", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);

    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );

    const room = await screen.findByRole("button", { name: /객실/ });
    expect(room).toHaveClass("guidelines-group-toggle");
    fireEvent.click(room);
    await waitFor(() => expect(screen.queryByRole("button", { name: /프론트/ })).not.toBeInTheDocument());
    // 그 위 단계는 그대로 남아 있어야 한다.
    expect(screen.getByRole("button", { name: /객실/ })).toBeInTheDocument();
  });
});
