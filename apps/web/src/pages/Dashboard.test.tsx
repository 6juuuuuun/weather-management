import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Dashboard는 이제 supabase 체인이 아니라 이름 있는 api 함수(lib/api/*)를 부른다.
// 각 함수를 개별 vi.fn()으로 목하고, 호출 인자를 기록해 "어떤 조회를 했는지"를 검증한다.
const mocks = vi.hoisted(() => ({
  latestObservation: vi.fn(),
  observationsSinceCalls: [] as string[],
  observationsSinceImpl: (_iso: string): unknown[] => [],
  openEvents: vi.fn(),
  criteria: vi.fn(),
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
  notifyChannel: vi.fn(),
  listDepartments: vi.fn(),
  alertRecipients: vi.fn(),
  listRecipients: vi.fn(),
  guidelines: vi.fn(),
  dispatches: vi.fn(),
  authState: {
    employee: { id: "emp1", name: "김운영", role: "admin", department_id: "d1" },
    loading: false,
    isApprover: true,
  },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));

vi.mock("../lib/api/dashboard", () => ({
  latestObservation: (...args: unknown[]) => mocks.latestObservation(...args),
  observationsSince: (iso: string) => {
    mocks.observationsSinceCalls.push(iso);
    return Promise.resolve(mocks.observationsSinceImpl(iso));
  },
  openEvents: (...args: unknown[]) => mocks.openEvents(...args),
  criteria: (...args: unknown[]) => mocks.criteria(...args),
  siteSettings: (...args: unknown[]) => mocks.siteSettings(...args),
  heartbeat: (...args: unknown[]) => mocks.heartbeat(...args),
  notifyChannel: (...args: unknown[]) => mocks.notifyChannel(...args),
}));

vi.mock("../lib/api/org", () => ({
  listDepartments: (...args: unknown[]) => mocks.listDepartments(...args),
  alertRecipients: (...args: unknown[]) => mocks.alertRecipients(...args),
  listRecipients: (...args: unknown[]) => mocks.listRecipients(...args),
}));

vi.mock("../lib/api/content", () => ({
  guidelines: (...args: unknown[]) => mocks.guidelines(...args),
  dispatches: (...args: unknown[]) => mocks.dispatches(...args),
}));

import { ApiError } from "../lib/api/client";
import Dashboard, { toBoardProps } from "./Dashboard";

const validObs = {
  observed_at: "2026-08-15T02:00:00.000Z",
  rain_mm_per_hr: 35,
  temp_c: 24.5,
  feels_c: 27,
  wind_ms: 6.2,
  snow_new_cm: 0,
  missing: false,
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <Dashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  mocks.observationsSinceCalls = [];
  mocks.latestObservation.mockReset().mockResolvedValue(validObs);
  mocks.observationsSinceImpl = () => [{ snow_new_cm: 0 }];
  mocks.openEvents.mockReset().mockResolvedValue([]);
  mocks.criteria.mockReset().mockResolvedValue([]);
  mocks.siteSettings.mockReset().mockResolvedValue(null);
  mocks.heartbeat.mockReset().mockResolvedValue(null);
  // 기본은 **실채널이 붙은 운영 상태**다. 로그 전용 채널은 그 자체로 체크리스트
  // 미완료 사유이므로(검증 라운드 E의 25번째 경로) 아래 전용 테스트에서만 켠다.
  mocks.notifyChannel.mockReset().mockResolvedValue({ channel: "kakaowork", log_only: false });
  mocks.listDepartments.mockReset().mockResolvedValue([]);
  mocks.alertRecipients.mockReset().mockResolvedValue([]);
  mocks.listRecipients.mockReset().mockResolvedValue([]);
  mocks.guidelines.mockReset().mockResolvedValue([]);
  mocks.dispatches.mockReset().mockResolvedValue([]);
});

describe("Dashboard 관측 카드", () => {
  // 결측 행 제외는 이제 서버(dashboard.ts)가 항상 보장한다(/observations/latest는 항상
  // missing=false만 조회) — 클라이언트가 검증할 것은 latestObservation()을 실제로 불러
  // 썼는지다.
  it("최신 관측을 latestObservation()으로 조회한다", async () => {
    renderDashboard();
    await waitFor(() => expect(mocks.latestObservation).toHaveBeenCalled());
  });

  it("관측 시각을 함께 표시해 값이 언제 기준인지 알 수 있다", async () => {
    renderDashboard();
    expect(await screen.findByText(/관측 기준/)).toBeInTheDocument();
  });

  // 가짜 타이머는 비동기 로드가 끝나기 전에 해제되어 판정 시점의 시각이 어긋난다.
  // 관측 시각을 '현재로부터 상대'로 잡으면 타이머를 건드리지 않고 같은 것을 검증할 수 있다.
  function obsMinutesAgo(min: number) {
    const iso = new Date(Date.now() - min * 60_000).toISOString();
    mocks.latestObservation.mockResolvedValue({ ...validObs, observed_at: iso });
  }

  // 관측은 매시 1회이므로 100분을 넘겼다면 그 뒤로 최소 한 번은 수집에 실패했다는 뜻이다.
  it("마지막 유효 관측이 오래됐으면 갱신되지 않았음을 경고한다", async () => {
    obsMinutesAgo(180);
    renderDashboard();
    expect(await screen.findByText(/값이 갱신되지 않았습니다/)).toBeInTheDocument();
  });

  it("관측이 최신이면 갱신 경고를 띄우지 않는다", async () => {
    obsMinutesAgo(30);
    renderDashboard();
    await screen.findByText(/관측 기준/);
    expect(screen.queryByText(/값이 갱신되지 않았습니다/)).not.toBeInTheDocument();
  });

  // 유효 관측이 하나도 없으면 카드가 전부 "–"인데 이유를 말해 주는 문구가 한 줄도
  // 없었다(QA W-21) — 관측 시각 스탬프 자체가 관측이 있을 때만 렌더링됐기 때문이다.
  // 사용자는 시스템이 고장 났는지 날씨 정보가 없는 건지 알 수 없다.
  it("관측이 하나도 없으면 이유를 말한다 — 수집이 실패한 경우", async () => {
    mocks.latestObservation.mockResolvedValue(null);
    mocks.heartbeat.mockResolvedValue({
      name: "weather-tick",
      last_run_at: new Date().toISOString(),
      ok: false,
      note: "missing",
    });
    renderDashboard();
    expect(await screen.findByText(/표시할 관측값이 없습니다/)).toBeInTheDocument();
    expect(screen.getByText(/마지막 수집.*실패했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/missing/)).toBeInTheDocument();
  });

  it("관측이 하나도 없으면 이유를 말한다 — 수집이 한 번도 안 돈 경우", async () => {
    mocks.latestObservation.mockResolvedValue(null);
    mocks.heartbeat.mockResolvedValue(null);
    renderDashboard();
    expect(await screen.findByText(/한 번도 실행되지 않았습니다/)).toBeInTheDocument();
  });

  // 수집은 도는데 기상청이 값을 안 주는 상태. 운영자가 볼 곳이 다르므로 문구도 달라야 한다.
  it("관측이 하나도 없으면 이유를 말한다 — 수집은 돌았지만 결측인 경우", async () => {
    mocks.latestObservation.mockResolvedValue(null);
    mocks.heartbeat.mockResolvedValue({
      name: "weather-tick",
      last_run_at: new Date().toISOString(),
      ok: true,
      note: null,
    });
    renderDashboard();
    expect(await screen.findByText(/기상청이 값을 주지 않았습니다/)).toBeInTheDocument();
  });

  it("관측이 있으면 그 안내를 띄우지 않는다", async () => {
    renderDashboard();
    await screen.findByText(/관측 기준/);
    expect(screen.queryByText(/표시할 관측값이 없습니다/)).not.toBeInTheDocument();
  });
});

// 항목 1·3(2라운드): 로더가 던지면 화면이 멈추고, 리프 부서 판정이 틀리면
// 셋업 체크리스트가 영원히 완료되지 않는다. 둘 다 화면 테스트가 lib/api를 통째로
// 목하는 탓에 오래 눈에 띄지 않았다.
describe("Dashboard 초기 로드 실패", () => {
  it("조회가 실패하면 오류를 표시한다", async () => {
    mocks.latestObservation.mockRejectedValue(new ApiError(401, "로그인이 필요합니다"));
    renderDashboard();
    expect(await screen.findByText(/로그인이 필요합니다/)).toBeInTheDocument();
  });

  // 30초 폴링 중 일시 오류가 기존 데이터를 지우면 벽걸이 화면이 주기적으로
  // 비워진다 — 마지막으로 알던 값은 남아 있어야 한다.
  it("폴링 중 실패해도 이미 받아 둔 관측을 지우지 않는다", async () => {
    // 폴링 setInterval을 잡으려면 render보다 먼저 가짜 타이머를 깔아야 한다.
    // shouldAdvanceTime을 켜야 findByText(waitFor)가 그대로 동작한다.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderDashboard();
      // 첫 로드는 성공 — 관측 카드가 채워진다.
      expect(await screen.findByText(/관측 기준/)).toBeInTheDocument();

      // 이후 폴링이 실패하도록 바꾸고 30초 주기를 넘긴다.
      mocks.latestObservation.mockRejectedValue(new ApiError(503, "일시적인 오류입니다"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      // 폴링이 실제로 실패했는지 먼저 확인한다 — 이게 없으면 아래 단언이
      // "애초에 폴링이 안 돌았다"로도 통과해 아무것도 증명하지 못한다.
      expect(screen.getByText(/일시적인 오류입니다/)).toBeInTheDocument();
      // 그럼에도 마지막으로 알던 관측은 남아 있어야 한다.
      expect(screen.getByText(/관측 기준/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

// 승인 대기 배지가 언제나 "재알림 0회"였다(QA W-26) — 화면이 repeat_count(발송 회차)를
// 재알림 횟수로 읽고 있었는데, 승인 전에는 그 값이 0에서 움직이지 않는다. 승인자가 얼마나
// 오래 방치했는지가 화면에서 지워진 셈이다.
describe("Dashboard 재알림 배지", () => {
  const pending = {
    id: "ev-1",
    kind: "rain" as const,
    grade: "watch" as const,
    status: "PENDING_APPROVAL" as const,
    detected_at: new Date().toISOString(),
    closed_at: null,
    trigger_observation_id: 1,
    approved_by: null,
    approved_by_name: null,
    approved_at: null,
    last_reminded_at: new Date().toISOString(),
    repeat_count: 0, // 발송 회차 — 승인 전이라 0이다
    remind_count: 3, // 재알림 3회
  };

  it("승인 대기 배너가 remind_count를 보여준다", async () => {
    mocks.openEvents.mockResolvedValue([pending]);
    renderDashboard();
    expect(await screen.findByText(/재알림 3회 발송됨/)).toBeInTheDocument();
    expect(screen.queryByText(/재알림 0회 발송됨/)).toBeNull();
  });

  it("특보 목록 행도 remind_count를 보여준다", async () => {
    mocks.openEvents.mockResolvedValue([pending]);
    const { container } = renderDashboard();
    await screen.findByText(/재알림 3회 발송됨/);
    expect(container.textContent).toMatch(/재알림 3회/);
  });
});

// QA W-10 · 관측 지점 항목이 "행이 저장돼 있는가"만 봐서, nx=-1로 수집이 매시간
// 실패하는 동안에도 체크리스트가 완료로 남았다. 관리자가 화면에서 이상을 알아챌
// 자리가 여기뿐이었다.
describe("Dashboard 셋업 체크리스트 — 관측 지점 좌표 (W-10)", () => {
  async function renderWithSite(site: Record<string, unknown>) {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
    ]);
    mocks.siteSettings.mockResolvedValue(site);
    const out = renderDashboard();
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalled());
    return out;
  }

  it("좌표가 격자 밖이면 완료로 세지 않고 이유를 말한다", async () => {
    const { container } = await renderWithSite({ id: 1, site_name: "곤지암", nx: -1, ny: 121 });
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    // "미지정"이라고만 하면 관리자는 저장 화면에서 값이 들어 있는 것을 보고
    // 정상이라고 판단한다 — 실제로는 그 값 때문에 수집이 죽어 있다.
    expect(container.textContent).toMatch(/관측 지점 좌표가 기상청 격자 범위 밖입니다/);
    expect(container.textContent).toMatch(/날씨 수집이 계속 실패합니다/);
  });

  it("좌표가 범위 안이면 다른 항목이 다 찼을 때 스트립이 사라진다", async () => {
    const { container } = await renderWithSite({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeNull());
  });
});

describe("Dashboard 셋업 체크리스트", () => {
  // 지침(action_guidelines)은 리프 부서에만 단다. 모든 부서를 리프로 세면
  // deptCount가 부풀려져 guidelineDeptCount >= deptCount가 영원히 참이 될 수 없고,
  // 리프를 다 채워도 "지침 미작성 N곳"이 상시 표시된다.
  it("상위 부서를 리프로 세지 않는다 — 리프 지침을 다 채우면 미작성 0곳이다", async () => {
    // 루트 2개 + 각 자식 1개 = 리프 2곳.
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "root2", parent_id: null, name: "사업지원", sort_order: 2 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
      { id: "leaf2", parent_id: "root2", name: "시설", sort_order: 1 },
    ]);
    // 리프 2곳에만 지침이 있다.
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
      { department_id: "leaf2", kind: "rain", grade: "watch", staff_actions: ["점검"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    // 카카오워크에 연결된 수신자여야 "연결" 항목까지 충족된다 — 지정만 되고
    // 연결이 없으면 특보가 아무에게도 안 가므로 체크리스트가 완료되면 안 된다.
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    // 지침을 등록한 부서에는 부서 수신자도 있어야 한다 — 없으면 그 부서 몫이
    // 0명에게 나간다(QA W-02). 체크리스트가 그것까지 본다.
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
      { department_id: "leaf2", employee_id: "e3", name: "시설담당", role: "staff", kakaowork_user_id: "kw-3" },
    ]);

    const { container } = renderDashboard();
    // 7개 항목이 모두 충족되면 스트립 자체가 사라진다(setup.done < setup.total일 때만 렌더).
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeNull());
  });

  // QA W-15 · 자식 없는 최상위 부서 하나를 만들면 체크리스트가 영원히 멈췄다.
  // 체크리스트는 그 부서를 리프로 세는데 지침 화면은 그리지도 않아, 지침을 등록할
  // 방법이 화면 안에 없었다. 지금은 두 화면이 같은 함수(leafDeptIds)를 쓴다 —
  // 그 부서에 지침·수신자를 넣으면 체크리스트가 실제로 완료된다.
  it("자식 없는 최상위 부서도 리프로 세고, 채우면 체크리스트가 완료된다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
      { id: "solo", parent_id: null, name: "안전관리팀", sort_order: 2 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
      { department_id: "solo", kind: "rain", grade: "watch", staff_actions: ["순찰"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
      { department_id: "solo", employee_id: "e3", name: "안전담당", role: "staff", kakaowork_user_id: "kw-3" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeNull());
  });

  // 반대 방향도 못 박는다: 자식 없는 최상위 부서를 리프로 **세지 않으면**, 그
  // 부서에 지침이 없어도 체크리스트가 완료돼 버린다 — 그러면 특보가 떠도 그
  // 부서 몫은 만들어지지 않는데 화면은 다 됐다고 말한다.
  it("자식 없는 최상위 부서에 지침이 없으면 체크리스트가 완료되지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
      { id: "solo", parent_id: null, name: "안전관리팀", sort_order: 2 },
    ]);
    // solo에는 지침이 없다.
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    expect(container.querySelector(".setup-strip")!.textContent).toMatch(/부서별 지침 1개 부서 미등록/);
  });

  // 3단 부서의 말단이 리프다. 중간 단계(2단)는 리프가 아니므로 세면 안 된다 —
  // 세면 지침을 달 수 없는 부서까지 분모에 들어가 체크리스트가 완료되지 않는다.
  it("3단 부서의 말단만 리프로 센다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "mid", parent_id: "root1", name: "객실", sort_order: 1 },
      { id: "leaf", parent_id: "mid", name: "프론트", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf", kind: "rain", grade: "watch", staff_actions: ["안내"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf", employee_id: "e2", name: "프론트담당", role: "staff", kakaowork_user_id: "kw-2" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeNull());
  });

  // "0명에게 성공"의 뿌리(QA W-02). 지침을 다 채워도 그 부서에 수신자가 없으면
  // 승인 발송은 0명에게 나간다 — 그런데 체크리스트는 6/6 초록이었다.
  it("지침은 있는데 부서 수신자가 없으면 체크리스트가 완료되지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([]); // 부서 수신자 0명

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    expect(container.querySelector(".setup-strip")!.textContent).toMatch(/부서 수신자/);
  });

  // 검증 §신규-1 — "알릴 수 없는데 전부 초록"의 **네 번째** 경로.
  // 부서 수신자를 지정만 하고 그 사람들이 전원 카카오워크 미연결이면 승인 발송도
  // 매시간 반복 발송도 0명에게 나간다. 체크리스트는 7/7 초록이었다 —
  // `카카오워크 연결` 항목이 Alert 수신자(승인자)만 세기 때문이다.
  it("부서 수신자가 전원 카카오워크 미연결이면 체크리스트가 완료되지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    // 승인자 쪽은 정상이다 — 그래서 지금까지 전부 초록이었다.
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "안전1", role: "staff", kakaowork_user_id: null },
      { department_id: "leaf1", employee_id: "e3", name: "안전2", role: "staff", kakaowork_user_id: null },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    // "미지정"이 아니라 "미연결"이라고 말해야 한다 — 이미 지정해 둔 관리자는
    // "수신자를 지정하세요"를 자기 이야기가 아니라고 읽고 지나간다.
    expect(container.querySelector(".setup-strip")!.textContent).toMatch(
      /부서 수신자 1개 부서 카카오워크 미연결/,
    );
  });

  // 검증 라운드 E — 표에 없던 **25번째** "아무에게도 못 가는데 전부 초록".
  //
  // 리허설 스택은 실제 직원에게 DM이 가지 않도록 일부러 `NOTIFY_CHANNEL=console`로
  // 돈다. 그 `.env`를 실서버에 복사하면 수신자·승인자가 전부 "연결됨"이고 승인이
  // `{"ok":true,"sent_count":1}`을 돌려주는데 모든 DM은 앱 로그로만 나간다.
  // 체크리스트가 그것을 말하지 않으면 화면에는 아무 이상이 없다.
  it("실효 발송 채널이 로그 전용이면 체크리스트가 완료되지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
    ]);
    // 나머지 일곱 항목은 전부 초록이다 — 이 한 줄만 다르다.
    mocks.notifyChannel.mockResolvedValue({ channel: "console", log_only: true });

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).not.toBeNull());
    const strip = container.querySelector(".setup-strip")!.textContent!;
    // 화면 어딘가가 아니라 **서버 .env**를 고쳐야 한다는 것까지 말해야 한다.
    expect(strip).toMatch(/발송이 로그로만 나갑니다/);
    expect(strip).toMatch(/NOTIFY_CHANNEL/);
  });

  // 위 테스트가 "스트립이 늘 뜬다"로 통과하지 않도록 반대쪽을 함께 고정한다.
  it("부서 수신자 중 한 명이라도 연결돼 있으면 체크리스트가 완료된다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "안전1", role: "staff", kakaowork_user_id: null },
      { department_id: "leaf1", employee_id: "e3", name: "안전2", role: "staff", kakaowork_user_id: "kw-3" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(mocks.guidelines).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeNull());
  });

  // 내용을 비운 지침은 제목만 있는 DM이 된다 — "등록됨"으로 세면 안 된다(QA W-22).
  it("내용이 빈 지침은 등록된 것으로 세지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: [], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);
    mocks.listRecipients.mockResolvedValue([
      { department_id: "leaf1", employee_id: "e2", name: "객실담당", role: "staff", kakaowork_user_id: "kw-2" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    expect(container.querySelector(".setup-strip")!.textContent).toMatch(/부서별 지침 1개 부서 미등록/);
  });

  // 위 테스트가 "항상 스트립이 없다"로 통과하지 않도록, 리프 하나가 비면
  // 실제로 스트립이 뜨는 것을 함께 고정한다.
  it("리프 부서 지침이 빠지면 체크리스트가 남는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
      { id: "leaf2", parent_id: "root1", name: "시설", sort_order: 2 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
  });

  // F-0의 절반: 값을 채우는 경로를 만드는 것만으로는 같은 사고가 다른 이유로
  // 되풀이된다(봇 키 오타, 카카오워크 계정 삭제, 이메일 불일치). 수신자가 지정돼
  // 있어도 아무도 연결돼 있지 않으면 특보는 한 명에게도 가지 않는다 —
  // 그때 체크리스트가 "완료"라고 말하면 운영자는 준비가 끝난 줄 안다.
  it("Alert 수신자가 카카오워크에 연결돼 있지 않으면 체크리스트가 완료되지 않는다", async () => {
    mocks.listDepartments.mockResolvedValue([
      { id: "root1", parent_id: null, name: "리조트", sort_order: 1 },
      { id: "leaf1", parent_id: "root1", name: "객실", sort_order: 1 },
    ]);
    mocks.guidelines.mockResolvedValue([
      { department_id: "leaf1", kind: "rain", grade: "watch", staff_actions: ["제설"], guest_notice: "" },
    ]);
    mocks.siteSettings.mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
    mocks.criteria.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ kind: "rain", grade: i % 2 ? "watch" : "warning", threshold: {} })),
    );
    // 지정은 됐지만 연결이 없다 — 이 상태가 정확히 이관 직후의 실제 상태였다.
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: null },
    ]);

    const { container } = renderDashboard();
    await waitFor(() => expect(container.querySelector(".setup-strip")).toBeTruthy());
    expect(container.querySelector(".setup-strip")!.textContent).toMatch(/카카오워크/);
  });
});

describe("Dashboard 보드 모드", () => {
  it("최근 24시간 관측 이력을 조회한다", async () => {
    renderAt("?board=1");
    // snowToday(자정 이후)용 1건 + 보드 이력(24시간)용 1건, 총 2건의 observationsSince 호출.
    await waitFor(() => expect(mocks.observationsSinceCalls.length).toBe(2));
  });

  it("board=1이면 조작 요소를 렌더링하지 않는다", async () => {
    const { container } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd")).toBeTruthy());
    expect(container.querySelector(".setup-strip")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
  });

  it("board 파라미터가 없으면 기존 대시보드를 렌더링한다", async () => {
    const { container } = renderAt("");
    await waitFor(() => expect(container.querySelector(".obs-grid")).toBeTruthy());
    expect(container.querySelector(".bd")).toBeNull();
  });

  // F1: 이력 쿼리는 월보드 전용이다. 일반 대시보드가 쓰지도 않는 요청을
  // 30초 폴링에 얹지 않기 위해 boardMode일 때만 조회해야 한다.
  it("보드 모드가 아니면 이력을 조회하지 않는다 — snowToday용 1건만 호출된다", async () => {
    renderAt("");
    await waitFor(() => expect(mocks.observationsSinceCalls.length).toBeGreaterThan(0));
    expect(mocks.observationsSinceCalls.length).toBe(1);
  });

  // F2: clock은 렌더 시점(new Date())이 아니라 컴포넌트가 별도 타이머로 넘긴
  // now를 그대로 반영해야 한다. new Date()로 되돌아가면 이 테스트는 실행 시각과
  // fixed가 우연히 같은 분일 확률이 아니고서는 반드시 실패한다.
  it("clock은 호출 시점이 아니라 전달된 now를 반영한다", () => {
    const fixed = new Date("2026-08-15T05:07:00.000Z");
    const props = toBoardProps(null, "곤지암", fixed);
    expect(props.clock).toBe(
      fixed.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }),
    );
  });

  // -------------------------------------------------------------------------
  // QA W-14 · 벽걸이 월보드는 DB가 죽어도, 수집이 사흘 전에 멈춰도 마지막으로
  // 받아 둔 값을 그대로 띄우고 시계만 10초마다 갱신했다. 상단은 `평온`이었고
  // 수집 시각은 `14:00 관측 기준` 한 줄이라 3미터 밖에서는 정상으로 읽혔다.
  // -------------------------------------------------------------------------

  it("관측이 100분을 넘기면 낡음으로 표시하고 며칠 전인지 말한다", () => {
    const now = new Date("2026-08-15T05:00:00.000Z");
    const props = toBoardProps(
      { observation: { ...validObs, observed_at: "2026-08-13T05:00:00.000Z" }, criteria: [], openEvents: [],
        dispatches: [], snowToday: null, heartbeat: null, history: [] } as never,
      "곤지암",
      now,
    );
    expect(props.stale).toBe(true);
    expect(props.collectedAgo).toMatch(/2일 전/);
  });

  it("관측이 최신이면 낡음이 아니고 시:분만 적는다", () => {
    const now = new Date("2026-08-15T02:30:00.000Z");
    const props = toBoardProps(
      { observation: validObs, criteria: [], openEvents: [], dispatches: [],
        snowToday: null, heartbeat: null, history: [] } as never,
      "곤지암",
      now,
    );
    expect(props.stale).toBe(false);
    expect(props.collectedAgo).not.toMatch(/전$/);
  });

  it("관측이 아예 없으면 낡음으로 본다", () => {
    const props = toBoardProps(null, "곤지암", new Date());
    expect(props.stale).toBe(true);
    expect(props.collectedAgo).toBe("관측 없음");
  });

  it("조회 실패 문구를 월보드까지 전달한다", () => {
    const props = toBoardProps(null, "곤지암", new Date(), "일시적인 오류입니다");
    expect(props.loadError).toBe("일시적인 오류입니다");
  });

  it("보드 모드에서 첫 조회가 실패하면 화면이 그 사실을 말한다", async () => {
    mocks.latestObservation.mockRejectedValue(new ApiError(503, "일시적인 오류입니다"));
    const { container } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd-alarm")).toBeTruthy());
    expect(container.querySelector(".bd-alarm")!.textContent).toMatch(/서버 연결 끊김/);
    // 상단 한 마디도 `평온`이 아니어야 한다 — 그게 벽에서 유일하게 읽히는 글자다.
    expect(container.querySelector(".bd-status")!.textContent).not.toBe("평온");
  });

  it("보드 모드에서 관측이 낡으면 수집 중단 띠를 띄운다", async () => {
    mocks.latestObservation.mockResolvedValue({ ...validObs, observed_at: "2026-01-01T00:00:00.000Z" });
    const { container } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd-alarm")).toBeTruthy());
    expect(container.querySelector(".bd-alarm")!.textContent).toMatch(/수집 중단/);
    expect(container.querySelector(".bd-status")!.textContent).toBe("수집 중단");
  });

  it("일반 모드에 전체화면 버튼이 있다", async () => {
    const { findByRole } = renderAt("");
    expect(await findByRole("button", { name: "전체화면" })).toBeTruthy();
  });

  it("보드 모드에는 전체화면 버튼이 없다", async () => {
    const { container, queryByRole } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd")).toBeTruthy());
    expect(queryByRole("button", { name: "전체화면" })).toBeNull();
  });

  it("전체화면 버튼을 누르면 board=1이 URL에 붙는다", async () => {
    const { findByRole, container } = renderAt("");
    fireEvent.click(await findByRole("button", { name: "전체화면" }));
    // URL이 진실의 출처다 — 벽걸이 기기는 이 주소를 북마크해 부팅 직후 바로 들어온다.
    // 전체화면 API는 그 위의 장식이라, 브라우저가 거부해도 레이아웃은 전환돼야 한다.
    await waitFor(() => expect(container.querySelector(".bd")).toBeTruthy());
  });
});

describe("Dashboard 하단 티커", () => {
  // 기준이 설정된 지표가 있어야 티커에 항목이 생긴다. 기본 픽스처는 criteria를
  // 빈 배열로 주므로 threshold가 전부 0(미설정)이고, 그러면 티커는 아무것도 렌더하지 않는다.
  function withCriteria() {
    mocks.criteria.mockResolvedValue([
      { kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20 } },
      { kind: "heat", grade: "watch", threshold: { temp_c: 33, feels_c: 33 } },
    ]);
  }

  it("일반 대시보드에도 티커가 뜨고, 화면 하단에 고정된다", async () => {
    withCriteria();
    const { container } = renderAt("");
    await waitFor(() => expect(container.querySelector(".bt")).toBeTruthy());
    // .bt-fixed가 없으면 티커가 본문 흐름에 끼어 레이아웃을 밀어낸다.
    expect(container.querySelector(".bt-fixed")).toBeTruthy();
  });

  it("고정 티커가 본문 마지막을 가리지 않도록 자리를 비워둔다", async () => {
    withCriteria();
    const { container } = renderAt("");
    await waitFor(() => expect(container.querySelector(".bt-fixed")).toBeTruthy());
    expect(container.querySelector(".dash-ticker-spacer")).toBeTruthy();
  });

  it("카드가 못 말하는 기준까지의 거리를 문구로 준다", async () => {
    withCriteria();
    renderAt("");
    // 강수량 35mm, 폭우 주의보 20mm → 초과 +15.0mm
    expect((await screen.findAllByText(/폭우 주의보 기준 초과 \+15\.0mm/)).length).toBeGreaterThan(0);
    // 기온 24.5℃, 폭염 주의보 33℃ → 8.5℃ 남음
    expect(screen.getAllByText(/폭염 주의보까지 8\.5℃/).length).toBeGreaterThan(0);
  });

  it("월보드의 티커는 고정하지 않는다 — .bd 안에서 흐름 배치로 맨 아래 칸을 차지한다", async () => {
    withCriteria();
    const { container } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bt")).toBeTruthy());
    expect(container.querySelector(".bt-fixed")).toBeNull();
  });

  it("기준이 하나도 설정되지 않았으면 티커를 띄우지 않는다", async () => {
    // 기본 픽스처는 criteria가 빈 배열 → threshold 전부 0(미설정).
    // 이때 항목을 만들면 "폭우 주의보 기준 초과 +0.0mm"라는 거짓 경보를 방송한다.
    const { container } = renderAt("");
    await waitFor(() => expect(container.querySelector(".obs-grid")).toBeTruthy());
    expect(container.querySelector(".bt")).toBeNull();
  });
});
