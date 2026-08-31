import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  listDepartments: vi.fn(),
  alertRecipients: vi.fn(),
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
}));

vi.mock("../lib/api/org", () => ({
  listDepartments: (...args: unknown[]) => mocks.listDepartments(...args),
  alertRecipients: (...args: unknown[]) => mocks.alertRecipients(...args),
}));

vi.mock("../lib/api/content", () => ({
  guidelines: (...args: unknown[]) => mocks.guidelines(...args),
  dispatches: (...args: unknown[]) => mocks.dispatches(...args),
}));

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
  mocks.listDepartments.mockReset().mockResolvedValue([]);
  mocks.alertRecipients.mockReset().mockResolvedValue([]);
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
