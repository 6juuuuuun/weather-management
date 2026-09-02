import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GlobalNav, NAV_POLL_MS } from "../GlobalNav";
import type { Employee } from "../../lib/types";

const mocks = vi.hoisted(() => ({
  siteSettings: vi.fn(),
  heartbeat: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));
vi.mock("../../lib/api/dashboard", () => ({
  siteSettings: (...a: unknown[]) => mocks.siteSettings(...a),
  heartbeat: (...a: unknown[]) => mocks.heartbeat(...a),
}));

// 고정 시각을 기준으로 흐르게 한다 — "N분 전"은 조회 결과가 아니라 현재 시각에서
// 나오는 값이라, 시간을 통제하지 않으면 이 결함을 재현할 수 없다.
const T0 = new Date("2026-09-01T09:00:00+09:00").getTime();

beforeEach(() => {
  // shouldAdvanceTime을 켜야 @testing-library의 findBy/waitFor가 가짜 시계 아래에서
  // 멈추지 않는다(그 유틸들은 실제 타이머로 재시도한다).
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(T0);
  mocks.authState = { employee: null, loading: false, isApprover: false };
  mocks.siteSettings.mockReset().mockResolvedValue({ id: 1, site_name: "곤지암", nx: 61, ny: 121 });
  mocks.heartbeat
    .mockReset()
    .mockResolvedValue({ name: "weather-tick", last_run_at: new Date(T0 - 60_000).toISOString(), ok: true, note: null });
});

afterEach(() => {
  vi.useRealTimers();
});

function renderNav() {
  return render(
    <MemoryRouter>
      <GlobalNav />
    </MemoryRouter>,
  );
}

// QA W-32 · useEffect(…, [])가 마운트 시 1회만 조회해서, 탭을 열어 둔 채 하루를
// 보내면 아침 값이 "마지막 수집 1분 전"이라고 계속 말했다. 이 줄은 "수집이 살아
// 있는가"를 알려 주는 유일한 상시 표시다.
describe("GlobalNav 마지막 수집 표시 (W-32)", () => {
  it("처음 열면 그 시점 기준으로 그린다", async () => {
    renderNav();
    expect(await screen.findByText(/마지막 수집 1분 전/)).toBeInTheDocument();
  });

  it("시간이 지나면 다시 조회해 숫자를 갱신한다", async () => {
    renderNav();
    await screen.findByText(/마지막 수집 1분 전/);
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);

    // 10분 뒤: 서버 값(last_run_at)이 그대로여도 화면의 숫자는 달라져야 한다.
    await vi.advanceTimersByTimeAsync(NAV_POLL_MS * 10);
    vi.setSystemTime(T0 + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(NAV_POLL_MS);

    await waitFor(() => expect(screen.getByText(/마지막 수집 11분 전/)).toBeInTheDocument());
    expect(mocks.heartbeat.mock.calls.length).toBeGreaterThan(1);
  });

  it("다시 조회한 값이 새로우면 그 값으로 그린다", async () => {
    renderNav();
    await screen.findByText(/마지막 수집 1분 전/);

    // 그 사이 수집이 한 번 더 돌았다.
    vi.setSystemTime(T0 + 5 * 60_000);
    mocks.heartbeat.mockResolvedValue({
      name: "weather-tick",
      last_run_at: new Date(T0 + 5 * 60_000).toISOString(),
      ok: true,
      note: null,
    });
    await vi.advanceTimersByTimeAsync(NAV_POLL_MS);

    await waitFor(() => expect(screen.getByText(/마지막 수집 0분 전/)).toBeInTheDocument());
  });

  it("화면을 떠나면 폴링을 멈춘다", async () => {
    const { unmount } = renderNav();
    await screen.findByText(/마지막 수집 1분 전/);
    const before = mocks.heartbeat.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(NAV_POLL_MS * 3);
    expect(mocks.heartbeat.mock.calls.length).toBe(before);
  });
});
