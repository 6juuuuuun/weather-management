import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// 대시보드는 한 번에 여러 테이블을 Promise.all로 조회한다. 체인 모양이 테이블마다 달라
// (select→eq→order→limit→maybeSingle, select→gte→eq, …) 개별 스텁을 쓰면 금방 깨진다.
// 어떤 메서드를 불러도 자기 자신을 돌려주고 await 시 결과를 내놓는 프록시로 받아,
// 호출된 체인을 테이블별로 기록해 검증에 쓴다.
type Call = { table: string; chain: string[]; args: unknown[][] };

const mocks = vi.hoisted(() => ({
  calls: [] as { table: string; chain: string[]; args: unknown[][] }[],
  dataFor: (_table: string, _chain: string[]): unknown => null,
  authState: {
    employee: { id: "emp1", name: "김운영", role: "admin", department_id: "d1" },
    loading: false,
    isApprover: true,
  },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const call: Call = { table, chain: [], args: [] };
      mocks.calls.push(call);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void) =>
                resolve({ data: mocks.dataFor(table, call.chain), error: null });
            }
            return (...args: unknown[]) => {
              call.chain.push(prop);
              call.args.push(args);
              return proxy;
            };
          },
        },
      ) as Record<string, unknown>;
      return proxy;
    },
  },
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
  mocks.calls = [];
  vi.useRealTimers();
  mocks.dataFor = (table, chain) => {
    if (table === "weather_observations") {
      // 누적 조회(gte 포함)는 배열, 최신 1건 조회는 단건
      return chain.includes("gte") ? [{ snow_new_cm: 0 }] : validObs;
    }
    return chain.includes("maybeSingle") || chain.includes("single") ? null : [];
  };
});

describe("Dashboard 관측 카드", () => {
  // 회귀: 예전에는 결측 여부를 보지 않고 '가장 최근 행'을 읽었다. 기상청이 한 번만 실패해도
  // 빈 행이 최신이 되어 전 카드가 비었는데, 상단 "마지막 수집 N분 전"은 heartbeat 기준이라
  // 최신으로 표시돼 "방금 수집했다는데 값이 없다"는 모순이 생겼다.
  it("최신 관측 조회 시 결측 행을 제외한다", async () => {
    renderDashboard();
    await waitFor(() => expect(mocks.calls.length).toBeGreaterThan(0));

    const latestObs = mocks.calls.find(
      (c) => c.table === "weather_observations" && c.chain.includes("maybeSingle"),
    );
    expect(latestObs, "최신 관측 단건 조회가 있어야 한다").toBeDefined();

    const eqArgs = latestObs!.chain
      .map((m, i) => (m === "eq" ? latestObs!.args[i] : null))
      .filter(Boolean) as unknown[][];
    expect(eqArgs).toContainEqual(["missing", false]);
  });

  it("관측 시각을 함께 표시해 값이 언제 기준인지 알 수 있다", async () => {
    renderDashboard();
    expect(await screen.findByText(/관측 기준/)).toBeInTheDocument();
  });

  // 가짜 타이머는 비동기 로드가 끝나기 전에 해제되어 판정 시점의 시각이 어긋난다.
  // 관측 시각을 '현재로부터 상대'로 잡으면 타이머를 건드리지 않고 같은 것을 검증할 수 있다.
  function obsMinutesAgo(min: number) {
    const iso = new Date(Date.now() - min * 60_000).toISOString();
    mocks.dataFor = (table, chain) => {
      if (table === "weather_observations") {
        return chain.includes("gte") ? [{ snow_new_cm: 0 }] : { ...validObs, observed_at: iso };
      }
      return chain.includes("maybeSingle") || chain.includes("single") ? null : [];
    };
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
    await waitFor(() => expect(mocks.calls.length).toBeGreaterThan(0));
    const history = mocks.calls.find(
      (c) => c.table === "weather_observations" && c.chain.includes("gte") && c.chain.includes("order"),
    );
    expect(history, "이력 조회가 있어야 한다").toBeDefined();
    const eqArgs = history!.chain
      .map((m, i) => (m === "eq" ? history!.args[i] : null))
      .filter(Boolean) as unknown[][];
    expect(eqArgs).toContainEqual(["missing", false]);
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
  it("보드 모드가 아니면 이력을 조회하지 않는다", async () => {
    renderAt("");
    await waitFor(() => expect(mocks.calls.length).toBeGreaterThan(0));
    const history = mocks.calls.find(
      (c) => c.table === "weather_observations" && c.chain.includes("gte") && c.chain.includes("order"),
    );
    expect(history).toBeUndefined();
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
});
