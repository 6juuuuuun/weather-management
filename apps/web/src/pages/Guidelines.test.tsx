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
    department_id: null,
    role: "admin",
    phone: null,
    notifiable: false,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function staffEmployee(): Employee {
  return {
    id: "staff-1",
    auth_user_id: "u-staff",
    name: "홍수진",
    email: "hong@example.com",
    department_id: "l1",
    role: "staff",
    phone: null,
    notifiable: false,
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
      { department_id: "l1", employee_id: "staff-1", name: "홍수진", role: "staff", phone: null, notifiable: false },
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

// QA W-30 · 지침 본문은 화면에만 남지 않는다 — 특보 문자 본문에 그대로 실린다.
// 서버가 이제 한 항목 200자 · 최대 20개 · 고객 안내 1000자로 막는데, 화면이 그
// 한계를 말하지 않으면 관리자는 다 쓰고 저장을 누른 뒤에야 거부당한다.
describe("Guidelines 본문 길이 상한 (W-30)", () => {
  async function openEditor() {
    mocks.authState.employee = adminEmployee();
    mocks.listDepartments.mockResolvedValue([
      { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
      { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
    ]);
    mocks.listEmployees.mockResolvedValue([adminEmployee()]);
    render(
      <MemoryRouter>
        <Guidelines />
      </MemoryRouter>,
    );
    await screen.findByText("폭우 대응 지침");
  }

  it("항목 수와 글자 수 상한을 화면에 적는다", async () => {
    await openEditor();
    expect(screen.getByText(/한 항목 200자 · 최대 20개/)).toBeInTheDocument();
    expect(screen.getByText(/1000자까지/)).toBeInTheDocument();
  });

  it("입력칸이 서버와 같은 상한을 스스로 들고 있다", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "+ 항목 추가" }));
    expect(screen.getByPlaceholderText("지침 내용을 입력하세요")).toHaveAttribute("maxlength", "200");
    expect(screen.getByPlaceholderText(/안녕하세요/)).toHaveAttribute("maxlength", "1000");
  });

  // 검증 §신규-1 — "알릴 수 없는데 전부 초록"의 네 번째 경로.
  // 부서 수신자는 특보를 **실제로 받는 사람**인데, 그 명단을 지정하는 유일한 화면인
  // 여기에만 연락 가능 표시가 없었다(특보 기준 화면의 Alert 수신자 칩에는 있다).
  // 전원에게 번호가 없으면 승인해도 그 부서 몫은 0명에게 나간다.
  //
  // **SMS로 바뀌어도 이 표시는 그대로 남는다** — 근거만 카카오워크 연결에서
  // 휴대폰 번호로 옮겨 왔고, 표시가 없을 때 벌어지는 일은 똑같다.
  describe("부서 수신자의 연락 가능 여부 (검증 §신규-1)", () => {
    function renderWithRecipients(recipients: unknown[], employees: unknown[]) {
      mocks.authState.employee = adminEmployee();
      mocks.listDepartments.mockResolvedValue([
        { id: "g1", parent_id: null, name: "리조트", sort_order: 0 },
        { id: "l1", parent_id: "g1", name: "객실", sort_order: 0 },
      ]);
      mocks.listEmployees.mockResolvedValue(employees);
      mocks.listRecipients.mockResolvedValue(recipients);
      render(
        <MemoryRouter>
          <Guidelines />
        </MemoryRouter>,
      );
    }

    const NO_PHONE = {
      ...staffEmployee(),
      id: "emp-unreachable",
      name: "안전일",
      email: "safe1@example.com",
      phone: null,
      notifiable: false,
      department_id: "l1",
    };
    const WITH_PHONE = {
      ...staffEmployee(),
      id: "emp-reachable",
      name: "안전이",
      email: "safe2@example.com",
      phone: "010-4000-0002",
      notifiable: true,
      department_id: "l1",
    };
    // **형식이 깨진 옛 값**을 가진 사람. 칸에는 번호가 보이지만 서버는 보낼 수 없다고
    // 판정한다 — 화면이 `phone !== null`로 스스로 세면 이 사람이 "연락 가능"으로
    // 잡히고, 그 순간 화면은 초록인데 실제 발송은 0명이 된다.
    const BAD_PHONE = {
      ...staffEmployee(),
      id: "emp-badphone",
      name: "안전삼",
      email: "safe3@example.com",
      phone: "02-123-4567",
      notifiable: false,
      department_id: "l1",
    };
    const recipientOf = (e: { id: string; name: string; phone: string | null; notifiable: boolean }) => ({
      department_id: "l1",
      employee_id: e.id,
      name: e.name,
      role: "staff",
      phone: e.phone,
      notifiable: e.notifiable,
    });

    it("번호가 없는 수신자 칩에 '휴대폰 번호 없음'이 붙는다", async () => {
      renderWithRecipients([recipientOf(NO_PHONE), recipientOf(WITH_PHONE)], [NO_PHONE, WITH_PHONE]);
      expect(await screen.findByText(/안전일 · 실무자 · 휴대폰 번호 없음/)).toBeInTheDocument();
      // 번호가 있는 사람에게는 붙지 않는다 — 라벨이 늘 붙어 있으면 아무 정보도 아니다.
      expect(screen.getByText("안전이 · 실무자")).toBeInTheDocument();
    });

    // 번호 문자열이 아니라 **서버의 판정**을 봐야 한다는 것을 못박는다.
    it("번호는 있는데 서버가 못 보낸다고 하면 그 사람도 경고로 표시된다", async () => {
      renderWithRecipients([recipientOf(BAD_PHONE)], [BAD_PHONE]);
      expect(await screen.findByText(/안전삼 · 실무자 · 휴대폰 번호 없음/)).toBeInTheDocument();
    });

    it("부서 트리가 '전원 번호 없음'을 말한다 — 인원 수만 보면 초록으로 읽힌다", async () => {
      renderWithRecipients([recipientOf(NO_PHONE)], [NO_PHONE]);
      expect(await screen.findByText("1명 · 전원 번호 없음")).toBeInTheDocument();
    });

    // 부서 트리의 셈도 서버의 판정을 봐야 한다. `phone !== null`로 세면 형식이 깨진
    // 값을 가진 사람이 "닿을 수 있음"으로 잡혀 **트리는 그냥 "1명"으로 보이는데 그
    // 부서 몫은 승인해도 0명에게 나간다.**
    //
    // 변이로 확인한 자리다: 이 테스트가 없으면 notifiableCountFor를
    // `r.phone !== null`로 바꿔도 웹 스위트가 통째로 통과했다.
    it("번호는 있는데 서버가 못 보낸다고 하면 트리도 '전원 번호 없음'이다", async () => {
      renderWithRecipients([recipientOf(BAD_PHONE)], [BAD_PHONE]);
      expect(await screen.findByText("1명 · 전원 번호 없음")).toBeInTheDocument();
    });

    it("한 명이라도 번호가 있으면 인원 수만 보여 준다", async () => {
      renderWithRecipients([recipientOf(NO_PHONE), recipientOf(WITH_PHONE)], [NO_PHONE, WITH_PHONE]);
      expect(await screen.findByText("2명")).toBeInTheDocument();
      expect(screen.queryByText(/전원 번호 없음/)).not.toBeInTheDocument();
    });

    it("수신자를 고르는 검색 목록에서도 번호 없음이 보인다", async () => {
      renderWithRecipients([], [NO_PHONE, WITH_PHONE]);
      await screen.findByText("폭우 대응 지침");
      fireEvent.click(screen.getByRole("button", { name: "+ 수신자 추가" }));
      expect(await screen.findByText(/safe1@example.com · 휴대폰 번호 없음/)).toBeInTheDocument();
      expect(screen.getByText("safe2@example.com")).toBeInTheDocument();
    });
  });

  // 21번째 항목을 만들 수 있으면 저장 한 번이 통째로 400으로 거부된다 —
  // 그 부서의 지침 편집이 그 자리에서 막힌다.
  it("항목이 20개가 되면 더 추가할 수 없다", async () => {
    await openEditor();
    const add = screen.getByRole("button", { name: "+ 항목 추가" });
    for (let i = 0; i < 25; i++) fireEvent.click(add);

    expect(screen.getAllByPlaceholderText("지침 내용을 입력하세요")).toHaveLength(20);
    expect(add).toBeDisabled();
    expect(screen.getByText(/더 넣을 수 없습니다/)).toBeInTheDocument();
  });
});
