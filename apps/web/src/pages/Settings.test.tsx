import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../lib/api/client";
import Settings from "./Settings";
import type { AlertSetting, Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  alertSettings: vi.fn(),
  saveAlertSettings: vi.fn(),
  siteSettings: vi.fn(),
  saveSiteSettings: vi.fn(),
  heartbeat: vi.fn(),
  callSend: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));

vi.mock("../lib/api/org", () => ({
  alertSettings: (...a: unknown[]) => mocks.alertSettings(...a),
  saveAlertSettings: (...a: unknown[]) => mocks.saveAlertSettings(...a),
}));

vi.mock("../lib/api/dashboard", () => ({
  siteSettings: (...a: unknown[]) => mocks.siteSettings(...a),
  saveSiteSettings: (...a: unknown[]) => mocks.saveSiteSettings(...a),
  heartbeat: (...a: unknown[]) => mocks.heartbeat(...a),
}));

vi.mock("../lib/api", () => ({ callSend: (...a: unknown[]) => mocks.callSend(...a) }));

const admin: Employee = {
  id: "admin-1",
  auth_user_id: "u-admin",
  name: "김운영",
  email: "kim@gonjiam.com",
  kakaowork_user_id: null,
  department_id: null,
  role: "admin",
  created_at: "2026-01-01T00:00:00Z",
};

const KINDS = ["rain", "snow", "wind", "heat"] as const;
const alertRows: AlertSetting[] = KINDS.map((kind) => ({
  kind,
  enabled: true,
  repeat_policy: "once",
  repeat_accum_threshold: null,
  heat_repeat_basis: null,
  updated_at: "2026-01-01T00:00:00Z",
}));

const site = {
  id: 1,
  site_name: "곤지암",
  address: "경기도 광주시",
  nx: 61,
  ny: 121,
  remind_interval_min: 30,
  resolve_notice: true,
  updated_at: "2026-01-01T00:00:00Z",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.authState = { employee: admin, loading: false, isApprover: false };
  mocks.alertSettings.mockReset().mockResolvedValue(alertRows);
  mocks.saveAlertSettings.mockReset().mockResolvedValue(alertRows);
  mocks.siteSettings.mockReset().mockResolvedValue(site);
  mocks.saveSiteSettings.mockReset().mockResolvedValue(site);
  mocks.heartbeat.mockReset().mockResolvedValue({
    name: "weather-tick",
    last_run_at: new Date().toISOString(),
    ok: true,
    note: null,
  });
  mocks.callSend.mockReset().mockResolvedValue({});
});

describe("Settings 초기 로드", () => {
  // 로드 실패 시 alertSettings·siteSettings가 null로 남는데, 렌더 가드가
  // loadError를 함께 보지 않으면 "불러오는 중…"을 영구히 붙잡는다.
  it("조회가 실패하면 불러오는 중에 멈추지 않고 오류를 보여준다", async () => {
    mocks.alertSettings.mockRejectedValue(new ApiError(401, "로그인이 필요합니다"));
    renderPage();

    expect(await screen.findByText(/로그인이 필요합니다/)).toBeInTheDocument();
    expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
  });
});

describe("Settings 수집 건전성", () => {
  // 서버의 /observations는 missing=false를 무조건 강제해 결측 행을 받을 방법이 없다.
  // 예전에는 하드코딩된 0을 초록 "정상"으로 칠해, 기상청 API가 밤새 실패해도 이 화면이
  // "정상"이라고 적극적으로 거짓 보고했다. 수집 건전성을 확인하러 들어오는 유일한
  // 화면이므로, 모르는 것은 모른다고 말해야 한다.
  it("결측 횟수를 알 수 없으므로 '확인 불가'로 표시하고 초록 정상을 쓰지 않는다", async () => {
    const { container } = renderPage();

    const label = await screen.findByText("수집 결측");
    const row = label.parentElement!;
    expect(row.textContent).toMatch(/확인 불가/);
    // 없는 정보를 "정상"이라고 단언하지 않는다.
    expect(row.textContent).not.toMatch(/최근 24시간 0회/);

    // 초록(ok) 스타일이 붙으면 문구와 무관하게 시각적으로는 여전히 "정상"이다.
    const value = row.querySelector(".settings-heartbeat-value")!;
    expect(value.classList.contains("ok")).toBe(false);
    expect(value.classList.contains("unknown")).toBe(true);
    expect(container).toBeTruthy();
  });
});
