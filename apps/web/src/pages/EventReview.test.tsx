import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EventReview from "./EventReview";
import type { AlertSetting, DeptBlock, Employee, WeatherEvent } from "../lib/types";

const mocks = vi.hoisted(() => ({
  openEvents: vi.fn(),
  observationsSinceImpl: (_iso: string): unknown[] => [],
  observation: vi.fn(),
  criteria: vi.fn(),
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
  alertSettings: vi.fn(),
  listRecipients: vi.fn(),
  messagesOf: vi.fn(),
  callSend: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../lib/api/dashboard", () => ({
  openEvents: (...args: unknown[]) => mocks.openEvents(...args),
  observationsSince: (iso: string) => Promise.resolve(mocks.observationsSinceImpl(iso)),
  observation: (...args: unknown[]) => mocks.observation(...args),
  criteria: (...args: unknown[]) => mocks.criteria(...args),
  siteSettings: (...args: unknown[]) => mocks.siteSettings(...args),
  heartbeat: (...args: unknown[]) => mocks.heartbeat(...args),
}));

vi.mock("../lib/api/org", () => ({
  alertSettings: (...args: unknown[]) => mocks.alertSettings(...args),
  listRecipients: (...args: unknown[]) => mocks.listRecipients(...args),
}));

vi.mock("../lib/api/content", () => ({
  messagesOf: (...args: unknown[]) => mocks.messagesOf(...args),
  saveDraftMessage: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/api", () => ({
  callSend: (...args: unknown[]) => mocks.callSend(...args),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => mocks.authState,
}));

const approver: Employee = {
  id: "emp-approver",
  auth_user_id: "u1",
  name: "김운영",
  email: "approver@example.com",
  kakaowork_user_id: "kw-approver",
  department_id: null,
  role: "approver",
  created_at: "2026-01-01T00:00:00Z",
};

const staff: Employee = {
  id: "emp-staff",
  auth_user_id: "u2",
  name: "박세준",
  email: "staff@example.com",
  kakaowork_user_id: null,
  department_id: "dept-b",
  role: "staff",
  created_at: "2026-01-01T00:00:00Z",
};

const admin: Employee = {
  id: "emp-admin",
  auth_user_id: "u3",
  name: "관리자",
  email: "admin@example.com",
  kakaowork_user_id: null,
  department_id: null,
  role: "admin",
  created_at: "2026-01-01T00:00:00Z",
};

const content: DeptBlock[] = [
  {
    department_id: "dept-a",
    department_name: "객실",
    staff_actions: ["수건 추가 배포"],
    guest_notice: "야외 시설 운영이 제한됩니다.",
    recipients: [
      { employee_id: "emp-1", name: "홍수진", kakaowork_user_id: "kw-1" },
      { employee_id: "emp-2", name: "이도현", kakaowork_user_id: "kw-2" },
    ],
    selected: true,
  },
  {
    department_id: "dept-b",
    department_name: "조리",
    staff_actions: ["식자재 점검"],
    guest_notice: "",
    recipients: [{ employee_id: "emp-3", name: "박세준", kakaowork_user_id: "kw-3" }],
    selected: true,
  },
];

const baseEvent: WeatherEvent = {
  id: "event-1",
  kind: "rain",
  grade: "watch",
  status: "PENDING_APPROVAL",
  detected_at: "2026-08-12T06:00:00+09:00",
  closed_at: null,
  trigger_observation_id: 10,
  approved_by: null,
  approved_at: null,
  last_reminded_at: null,
  repeat_count: 0,
};

const baseMessage = {
  id: "msg-1",
  event_id: "event-1",
  status: "draft" as const,
  content,
  updated_at: "2026-08-12T06:00:00Z",
  updated_by: null,
};

// dashboard.ts(OBS_COLS)는 humidity_pct를 select하지 않는다 — id는 /observations/:id
// 전용으로 함께 내려온다(baseEvent.trigger_observation_id와 같은 값).
const baseObservationRow = {
  id: 10,
  observed_at: "2026-08-12T06:00:00+09:00",
  rain_mm_per_hr: 32.5,
  temp_c: 24,
  wind_ms: 9.2,
  snow_new_cm: null,
  feels_c: null,
  missing: false,
};

const baseCriteria = {
  kind: "rain" as const,
  grade: "watch" as const,
  threshold: { rain_mm_per_hr: 20 },
};

const baseAlertSetting: AlertSetting = {
  kind: "rain",
  enabled: true,
  repeat_policy: "hourly_until_below",
  repeat_accum_threshold: null,
  heat_repeat_basis: null,
  updated_at: "2026-01-01T00:00:00Z",
};

// KST 자정 이후 일 누적 합산(observationsSince)용 — 트리거 관측(observation(id))과는
// 별개 호출이다.
const baseAccumRows = [{ rain_mm_per_hr: 32.5 }, { rain_mm_per_hr: 45.5 }]; // 합계 78.0mm

function setupApi(overrides: {
  event?: WeatherEvent | null;
  message?: typeof baseMessage | null;
  observationRow?: unknown | null;
  accumRows?: unknown[];
  criteriaRows?: unknown[];
  alertRows?: AlertSetting[];
  recipientRows?: unknown[];
} = {}) {
  const event = "event" in overrides ? overrides.event : baseEvent;
  const message = "message" in overrides ? overrides.message : baseMessage;
  mocks.openEvents.mockResolvedValue(event ? [event] : []);
  mocks.messagesOf.mockResolvedValue(message ? [message] : []);
  mocks.observation.mockResolvedValue("observationRow" in overrides ? overrides.observationRow : baseObservationRow);
  mocks.criteria.mockResolvedValue(overrides.criteriaRows ?? [baseCriteria]);
  mocks.alertSettings.mockResolvedValue(overrides.alertRows ?? [baseAlertSetting]);
  mocks.listRecipients.mockResolvedValue(overrides.recipientRows ?? []);

  const accumRows = overrides.accumRows ?? baseAccumRows;
  mocks.observationsSinceImpl = () => accumRows;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/events/event-1"]}>
      <Routes>
        <Route path="/events/:id" element={<EventReview />} />
        <Route path="/history" element={<div>이력 화면</div>} />
        <Route path="/" element={<div>대시보드 화면</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.callSend.mockReset();
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
  mocks.authState = { employee: approver, loading: false, isApprover: true };
  setupApi();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("EventReview", () => {
  it("approver에게 부서 블록·관측값·전체 선택을 렌더링한다", async () => {
    renderPage();
    expect(await screen.findByText("객실")).toBeInTheDocument();
    expect(screen.getByText("조리")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "전체 선택" })).toBeInTheDocument();
    expect(screen.getAllByText(/32\.5/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /승인 및 발송/ })).toBeInTheDocument();
  });

  it("rain 트리거 카드에 일 누적 강수량(KST 자정 이후 합산)을 표시한다", async () => {
    renderPage();
    expect(await screen.findByText("일 누적")).toBeInTheDocument();
    expect(screen.getAllByText(/78\.0/).length).toBeGreaterThan(0);
    expect(screen.getByText(/트리거 시간당 강수량 32\.5mm/)).toBeInTheDocument();
  });

  it("승인 및 발송이 성공하면 발송 이력으로 이동한다", async () => {
    mocks.callSend.mockResolvedValue({ ok: true, dispatch_id: 1, fail_count: 0 });
    renderPage();
    const approveBtn = await screen.findByRole("button", { name: /승인 및 발송/ });
    fireEvent.click(approveBtn);
    expect(await screen.findByText("이력 화면")).toBeInTheDocument();
    expect(mocks.callSend).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "approve", event_id: "event-1" }),
    );
  });

  it("fail_count가 있으면 danger 배너를 보여주고 이동하지 않는다", async () => {
    mocks.callSend.mockResolvedValue({ ok: true, dispatch_id: 2, fail_count: 1 });
    renderPage();
    const approveBtn = await screen.findByRole("button", { name: /승인 및 발송/ });
    fireEvent.click(approveBtn);
    expect(await screen.findByText(/1명 발송 실패/)).toBeInTheDocument();
    expect(screen.queryByText("이력 화면")).not.toBeInTheDocument();
  });

  it("특보 무시 확인 후 대시보드로 이동한다", async () => {
    mocks.callSend.mockResolvedValue({ ok: true });
    renderPage();
    const dismissBtn = await screen.findByRole("button", { name: "특보 무시" });
    fireEvent.click(dismissBtn);
    const confirmBtn = await screen.findByRole("button", { name: "무시하기" });
    fireEvent.click(confirmBtn);
    expect(await screen.findByText("대시보드 화면")).toBeInTheDocument();
    expect(mocks.callSend).toHaveBeenCalledWith({ mode: "dismiss", event_id: "event-1" });
  });

  it("임시 저장 클릭 시 저장 완료 메시지를 보여준다", async () => {
    renderPage();
    const saveBtn = await screen.findByRole("button", { name: "임시 저장" });
    fireEvent.click(saveBtn);
    expect(await screen.findByText("임시 저장되었습니다.")).toBeInTheDocument();
  });

  it("PENDING_APPROVAL이 아니면 읽기 전용과 상태 태그를 보여준다", async () => {
    setupApi({ event: { ...baseEvent, status: "ACTIVE" } });
    renderPage();
    expect(await screen.findByText("발송 완료")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "전체 선택" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /승인 및 발송/ })).not.toBeInTheDocument();
    expect(screen.getByText("현재 화면은 읽기 전용입니다.")).toBeInTheDocument();
  });

  it("staff는 체크박스·발송 버튼이 없고 자기 부서가 강조된다", async () => {
    mocks.authState = { employee: staff, loading: false, isApprover: false };
    renderPage();
    expect(await screen.findByText("객실")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /승인 및 발송/ })).not.toBeInTheDocument();
    const ownBlock = screen.getByText("조리").closest(".dept-block");
    expect(ownBlock).toHaveClass("dept-block-own");
    const otherBlock = screen.getByText("객실").closest(".dept-block");
    expect(otherBlock).not.toHaveClass("dept-block-own");
  });

  it("admin은 체크박스·발송 버튼이 보이지 않는다", async () => {
    mocks.authState = { employee: admin, loading: false, isApprover: false };
    renderPage();
    expect(await screen.findByText("객실")).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /승인 및 발송/ })).not.toBeInTheDocument();
  });

  it("부서 블록을 클릭하면 편집 모드가 되어 지침을 추가·삭제할 수 있다", async () => {
    renderPage();
    const card = (await screen.findByText("객실")).closest(".dept-block") as HTMLElement;
    fireEvent.click(card);
    expect(within(card).getByText("✎ 수정 중")).toBeInTheDocument();

    const actionInput = within(card).getByDisplayValue("수건 추가 배포");
    fireEvent.change(actionInput, { target: { value: "수건 추가 배포 및 확인" } });
    expect(within(card).getByDisplayValue("수건 추가 배포 및 확인")).toBeInTheDocument();

    fireEvent.click(within(card).getByText("+ 지침 추가"));
    expect(card.querySelectorAll(".action-input").length).toBe(2);

    const removeButtons = within(card).getAllByLabelText(/삭제/);
    fireEvent.click(removeButtons[removeButtons.length - 1]);
    expect(card.querySelectorAll(".action-input").length).toBe(1);
  });

  it("수신자 가감으로 수신자를 제거하면 수신자 수가 줄어든다", async () => {
    renderPage();
    expect(await screen.findByText(/수신자 · 3명/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "수신자 가감" }));
    const removeChip = await screen.findByRole("button", { name: "홍수진 제거" });
    fireEvent.click(removeChip);
    expect(await screen.findByText(/수신자 · 2명/)).toBeInTheDocument();
  });

  it("이벤트를 찾을 수 없으면 빈 상태를 보여준다", async () => {
    setupApi({ event: null });
    renderPage();
    expect(await screen.findByText("이벤트를 찾을 수 없습니다")).toBeInTheDocument();
  });

  it("Alert 수신자가 아니면 승인 및 발송 버튼이 보이지 않는다", async () => {
    mocks.authState = { employee: { ...approver, role: "approver" }, loading: false, isApprover: false };
    setupApi();
    renderPage();
    expect(await screen.findByText("현재 화면은 읽기 전용입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /승인 및 발송/ })).not.toBeInTheDocument();
  });

  it("역할이 admin이어도 Alert 수신자면 승인 및 발송 버튼이 보인다", async () => {
    mocks.authState = { employee: { ...approver, role: "admin" }, loading: false, isApprover: true };
    setupApi();
    renderPage();
    expect(await screen.findByRole("button", { name: /승인 및 발송/ })).toBeInTheDocument();
  });
});
