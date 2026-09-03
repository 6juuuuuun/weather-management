import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Criteria from "./Criteria";
import type { Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  criteria: vi.fn(),
  saveCriteria: vi.fn(),
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
  listEmployees: vi.fn(),
  listDepartments: vi.fn(),
  alertRecipients: vi.fn(),
  saveAlertRecipients: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));
vi.mock("../lib/api/dashboard", () => ({
  criteria: (...a: unknown[]) => mocks.criteria(...a),
  saveCriteria: (...a: unknown[]) => mocks.saveCriteria(...a),
  siteSettings: (...a: unknown[]) => mocks.siteSettings(...a),
  heartbeat: (...a: unknown[]) => mocks.heartbeat(...a),
}));
vi.mock("../lib/api/org", () => ({
  listEmployees: (...a: unknown[]) => mocks.listEmployees(...a),
  listDepartments: (...a: unknown[]) => mocks.listDepartments(...a),
  alertRecipients: (...a: unknown[]) => mocks.alertRecipients(...a),
  saveAlertRecipients: (...a: unknown[]) => mocks.saveAlertRecipients(...a),
}));

const admin: Employee = {
  id: "admin-1",
  auth_user_id: "u-admin",
  name: "김운영",
  email: "kim@gonjiam.com",
  department_id: null,
  role: "admin",
  phone: null,
  notifiable: false,
  created_at: "2026-01-01T00:00:00Z",
};

const SEED_CRITERIA = [
  { kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20 } },
  { kind: "rain", grade: "warning", threshold: { rain_mm_per_hr: 50 } },
  { kind: "snow", grade: "watch", threshold: { snow_cm: 5 } },
  { kind: "snow", grade: "warning", threshold: { snow_cm: 20 } },
  { kind: "wind", grade: "watch", threshold: { wind_ms: 14 } },
  { kind: "wind", grade: "warning", threshold: { wind_ms: 21 } },
  { kind: "heat", grade: "watch", threshold: { temp_c: 33, feels_c: 31 } },
  { kind: "heat", grade: "warning", threshold: { temp_c: 35, feels_c: 33 } },
];

const DEPTS = [
  { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
  { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
];

beforeEach(() => {
  vi.restoreAllMocks();
  mocks.authState = { employee: admin, loading: false, isApprover: true };
  mocks.criteria.mockReset().mockResolvedValue(SEED_CRITERIA);
  mocks.saveCriteria.mockReset().mockResolvedValue([]);
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
  mocks.listDepartments.mockReset().mockResolvedValue(DEPTS);
  mocks.alertRecipients.mockReset().mockResolvedValue([]);
  mocks.saveAlertRecipients.mockReset().mockResolvedValue(null);
  mocks.listEmployees.mockReset().mockResolvedValue([]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Criteria />
    </MemoryRouter>,
  );
}

function inputFor(grade: "주의보" | "경보", label: string) {
  return screen.getByLabelText(new RegExp(`^${grade} ${label} 기준`));
}

// QA W-10 · 화면이 빈 입력칸을 0으로 바꿔 보냈다. 0은 `>= 0`이 언제나 참이라
// 매시간 특보가 뜬다. 그리고 경보가 주의보보다 낮아도 아무도 말해 주지 않았다.
describe("Criteria 기준 값 검증 (W-10)", () => {
  it("입력칸을 비우면 0을 보내지 않고 저장을 막는다", async () => {
    renderPage();
    const input = await waitFor(() => inputFor("주의보", "폭우"));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));

    expect(await screen.findByText(/폭우 주의보 기준이 비어 있습니다/)).toBeInTheDocument();
    expect(mocks.saveCriteria).not.toHaveBeenCalled();
    // 빈 칸이 화면에서도 0으로 바뀌면 안 된다 — 관리자는 자기가 0을 넣은 줄 모른다.
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("0이나 음수는 저장하지 않는다", async () => {
    renderPage();
    const input = await waitFor(() => inputFor("주의보", "강풍"));
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));
    expect(await screen.findByText(/강풍 주의보 기준은 0보다 커야 합니다/)).toBeInTheDocument();
    expect(mocks.saveCriteria).not.toHaveBeenCalled();
  });

  it("경보가 주의보보다 낮으면 저장하지 않고 이유를 말한다", async () => {
    renderPage();
    const warning = await waitFor(() => inputFor("경보", "폭우"));
    fireEvent.change(warning, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));

    expect(await screen.findByText(/경보는 주의보보다 높아야 합니다/)).toBeInTheDocument();
    expect(mocks.saveCriteria).not.toHaveBeenCalled();
  });

  it("올바른 값은 그대로 저장한다", async () => {
    renderPage();
    const input = await waitFor(() => inputFor("주의보", "폭우"));
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));

    await waitFor(() => expect(mocks.saveCriteria).toHaveBeenCalled());
    const rows = mocks.saveCriteria.mock.calls[0]![0] as {
      kind: string; grade: string; threshold: Record<string, number>;
    }[];
    expect(rows.find((r) => r.kind === "rain" && r.grade === "watch")!.threshold).toEqual({
      rain_mm_per_hr: 25,
    });
  });

  // 옛 결함으로 저장된 오타 키(rain_mm 등)가 화면 상태에 남아 있으면 다시 저장해도
  // 지워지지 않았다 — 그 종류의 특보는 영원히 뜨지 않는데 화면은 정상으로 보인다.
  it("서버가 준 알 수 없는 키는 다시 보내지 않는다", async () => {
    mocks.criteria.mockResolvedValue([
      ...SEED_CRITERIA.filter((r) => !(r.kind === "rain" && r.grade === "watch")),
      { kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20, rain_mm: 99 } },
    ]);
    renderPage();
    await waitFor(() => inputFor("주의보", "폭우"));
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));

    await waitFor(() => expect(mocks.saveCriteria).toHaveBeenCalled());
    const rows = mocks.saveCriteria.mock.calls[0]![0] as {
      kind: string; grade: string; threshold: Record<string, number>;
    }[];
    expect(rows.find((r) => r.kind === "rain" && r.grade === "watch")!.threshold).toEqual({
      rain_mm_per_hr: 20,
    });
  });

  // 값이 빠진 채 저장된 행(폭염의 feels_c 등)은 입력칸이 빈 채로 보인다. 예전에는
  // 그 상태로 저장하면 0이 들어갔다.
  it("서버가 준 값에 필수 키가 없으면 빈 칸으로 두고 저장을 막는다", async () => {
    mocks.criteria.mockResolvedValue([
      ...SEED_CRITERIA.filter((r) => !(r.kind === "heat" && r.grade === "watch")),
      { kind: "heat", grade: "watch", threshold: { temp_c: 33 } },
    ]);
    renderPage();
    // 폭염은 입력칸이 둘이라(기온·체감) 접근명 앞부분이 같다 — feels_c 쪽만 고른다.
    await waitFor(() => screen.getByLabelText(/^주의보 폭염 기준.*℃ 이상/));
    expect((screen.getByLabelText(/^주의보 폭염 기준.*℃ 이상/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "변경사항 저장" }));
    expect(await screen.findByText(/폭염 주의보 기준이 비어 있습니다/)).toBeInTheDocument();
    expect(mocks.saveCriteria).not.toHaveBeenCalled();
  });
});

// QA W-08 · 승인 권한은 오직 이 목록의 등록 여부에서 나오고 역할과 무관하다
// (스펙 2026-08-13). 규칙은 옳은데 화면 어디에도 적혀 있지 않았고, 후보 목록이
// admin·approver만 보여 줘서 오히려 반대를 가르쳤다.
describe("Criteria 승인 권한 안내 (W-08)", () => {
  it("이 목록이 승인 권한의 유일한 출처라고 적는다", async () => {
    renderPage();
    expect(await screen.findByText(/이 목록이 특보 승인 권한의/)).toBeInTheDocument();
    // <strong>이 문장을 쪼개므로 노드 하나로는 잡히지 않는다 — 카드 전체 텍스트로 본다.
    const card = document.querySelector(".criteria-recipients")!;
    expect(card.textContent).toMatch(/여기 있는 사람만 승인·발송할 수 있고/);
    expect(card.textContent).toMatch(/역할\(관리자·승인자·실무자\)은 승인 권한과 아무 관계가 없습니다/);
    expect(card.textContent).toMatch(/권한을 주거나 회수하려면 역할이 아니라\s*이 목록에서 넣고 빼세요/);
  });

  it("수신자 후보를 역할로 거르지 않는다", async () => {
    mocks.listEmployees.mockResolvedValue([
      { id: "e9", name: "박실무", role: "staff", department_id: "leaf1", phone: "010-5000-0009", notifiable: true },
    ]);
    renderPage();
    await waitFor(() => expect(mocks.listEmployees).toHaveBeenCalled());
    // 인자 없이 부른다 = 전체 직원. roles 필터를 다시 넣으면 여기서 깨진다.
    expect(mocks.listEmployees.mock.calls[0]![0]).toBeUndefined();

    fireEvent.click(await screen.findByRole("button", { name: "+ 수신자 추가" }));
    expect(await screen.findByRole("option", { name: /박실무/ })).toBeInTheDocument();
  });

  it("수신자가 한 명도 없으면 아무도 승인할 수 없다고 말한다", async () => {
    renderPage();
    expect(await screen.findByText(/승인할 수 있는 사람이 아무도 없습니다/)).toBeInTheDocument();
  });
});

// QA W-31 · 승인권자를 지정하는 화면인데 그 사람이 어느 부서인지, 연락이 되는지
// 보이지 않았다. 번호가 없는 사람은 승인 요청 문자를 받지 못한다.
//
// **SMS로 바뀌어도 이 표시는 그대로 남는다** — 근거만 카카오워크 연결에서
// 휴대폰 번호로 옮겨 왔다.
describe("Criteria 수신자 목록의 부서·연락 가능 여부 (W-31)", () => {
  it("이름과 함께 부서 경로를 그린다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", department_id: "leaf1", phone: "010-5000-0001", notifiable: true },
    ]);
    renderPage();
    expect(await screen.findByText(/김승인 · 리조트 · 객실/)).toBeInTheDocument();
  });

  it("휴대폰 번호가 없는 사람은 그 사실을 함께 보여준다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e2", name: "이번호", role: "staff", department_id: "leaf1", phone: null, notifiable: false },
    ]);
    renderPage();
    expect(await screen.findByText(/이번호 · 리조트 · 객실 · 휴대폰 번호 없음/)).toBeInTheDocument();
  });

  // 번호 문자열이 아니라 **서버의 판정**을 봐야 한다. 형식 검증 이전에 저장된 값은
  // 칸에는 보이지만 발송 대상이 아니다 — 화면이 스스로 세면 "지정 끝났다"고 읽는다.
  it("번호는 있는데 서버가 못 보낸다고 하면 그 사람도 경고로 표시된다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e4", name: "옛번호", role: "staff", department_id: "leaf1", phone: "02-123-4567", notifiable: false },
    ]);
    renderPage();
    expect(await screen.findByText(/옛번호 · 리조트 · 객실 · 휴대폰 번호 없음/)).toBeInTheDocument();
  });

  it("부서가 없는 사람은 미지정으로 표시한다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e3", name: "무소속", role: "staff", department_id: null, phone: "010-5000-0003", notifiable: true },
    ]);
    renderPage();
    expect(await screen.findByText(/무소속 · 부서 미지정/)).toBeInTheDocument();
  });
});
