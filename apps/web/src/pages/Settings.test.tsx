import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../lib/api/client";
import { jsonResponse, makeFetchQueue } from "../test-support/fetchQueue";
import Settings from "./Settings";
import type { AlertSetting, Employee } from "../lib/types";

const mocks = vi.hoisted(() => ({
  alertSettings: vi.fn(),
  alertRecipients: vi.fn(),
  saveAlertSettings: vi.fn(),
  siteSettings: vi.fn(),
  saveSiteSettings: vi.fn(),
  heartbeat: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));

vi.mock("../auth/AuthProvider", () => ({ useAuth: () => mocks.authState }));

vi.mock("../lib/api/org", () => ({
  alertSettings: (...a: unknown[]) => mocks.alertSettings(...a),
  saveAlertSettings: (...a: unknown[]) => mocks.saveAlertSettings(...a),
  alertRecipients: (...a: unknown[]) => mocks.alertRecipients(...a),
}));

vi.mock("../lib/api/dashboard", () => ({
  siteSettings: (...a: unknown[]) => mocks.siteSettings(...a),
  saveSiteSettings: (...a: unknown[]) => mocks.saveSiteSettings(...a),
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

// callSend는 목하지 않는다 — 모듈을 통째로 목하면 경로·메서드·본문이 틀려도 통과한다.
let send: ReturnType<typeof makeFetchQueue>;
const sendRequests = () =>
  send.fetchMock.mock.calls
    .filter(([path]) => path === "/api/send")
    .map(([, init]) => ({ method: init!.method, body: JSON.parse(String(init!.body)) }));

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
  // 기본값은 "연결된 수신자 1명" — 각 테스트가 필요하면 이 값만 바꾼다.
  mocks.alertRecipients
    .mockReset()
    .mockResolvedValue([{ employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" }]);
  mocks.saveAlertSettings.mockReset().mockResolvedValue(alertRows);
  mocks.siteSettings.mockReset().mockResolvedValue(site);
  mocks.saveSiteSettings.mockReset().mockResolvedValue(site);
  mocks.heartbeat.mockReset().mockResolvedValue({
    name: "weather-tick",
    last_run_at: new Date().toISOString(),
    ok: true,
    note: null,
  });
  send = makeFetchQueue();
  vi.stubGlobal("fetch", send.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

// 예전에는 이 자리에 "카카오워크 봇 · 연결됨 · 봇 이름 날씨경영"이 조건 없이
// 초록으로 하드코딩돼 있었다. 정보 부재가 아니라 반대 사실의 적극적 주장이라,
// 특보가 한 명에게도 전달되지 않는 상태에서 화면이 "연결됨"이라고 말했다.
describe("Settings 카카오워크 연결 표시", () => {
  function kakaoRow() {
    const label = screen.getByText("카카오워크 연결");
    return label.parentElement!;
  }

  it("연결된 Alert 수신자가 0명이면 초록이 아니라 경고로 보여준다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: null },
    ]);
    renderPage();
    await screen.findByText("카카오워크 연결");
    const value = kakaoRow().querySelector(".settings-heartbeat-value")!;
    expect(value.classList.contains("ok")).toBe(false);
    expect(value.classList.contains("fail")).toBe(true);
    expect(kakaoRow().textContent).toMatch(/특보가 전달되지 않습니다/);
  });

  it("수신자가 아예 없어도 경고로 보여준다", async () => {
    mocks.alertRecipients.mockResolvedValue([]);
    renderPage();
    await screen.findByText("카카오워크 연결");
    expect(kakaoRow().textContent).toMatch(/Alert 수신자가 없습니다/);
    expect(kakaoRow().querySelector(".settings-heartbeat-value")!.classList.contains("ok")).toBe(false);
  });

  it("연결된 사람이 있으면 몇 명인지 보여준다", async () => {
    mocks.alertRecipients.mockResolvedValue([
      { employee_id: "e1", name: "김승인", role: "approver", kakaowork_user_id: "kw-1" },
      { employee_id: "e2", name: "박승인", role: "approver", kakaowork_user_id: null },
    ]);
    renderPage();
    await screen.findByText("카카오워크 연결");
    expect(kakaoRow().textContent).toMatch(/2명 중 1명 연결됨/);
    expect(kakaoRow().querySelector(".settings-heartbeat-value")!.classList.contains("ok")).toBe(true);
  });

  // 조회가 실패했을 때 초록으로 칠하면 예전의 거짓 초록으로 되돌아간다.
  it("수신자 조회가 실패하면 '확인 안 됨'이고, 화면 자체는 뜬다", async () => {
    mocks.alertRecipients.mockRejectedValue(new ApiError(500, "서버 오류"));
    renderPage();
    await screen.findByText("카카오워크 연결");
    const value = kakaoRow().querySelector(".settings-heartbeat-value")!;
    expect(kakaoRow().textContent).toMatch(/확인 안 됨/);
    expect(value.classList.contains("ok")).toBe(false);
    expect(value.classList.contains("unknown")).toBe(true);
  });

  // "연결됨"이라는 무조건 초록 문구가 다시 들어오면 잡는다.
  it("봇이 연결됐다는 단정을 화면에 쓰지 않는다", async () => {
    mocks.alertRecipients.mockResolvedValue([]);
    const { container } = renderPage();
    await screen.findByText("카카오워크 연결");
    expect(container.textContent).not.toMatch(/봇 이름 날씨경영/);
  });
});

describe("Settings 테스트 발송", () => {
  // 서버는 mode:"test"를 admin에게만 허용한다(server/src/jobs/send.ts). 화면이 부르는
  // 경로·메서드·본문이 어긋나면 버튼이 조용히 아무 일도 하지 않는다.
  it("POST /api/send에 { mode: 'test' }를 보내고 성공 토스트를 띄운다", async () => {
    send.push("/api/send", () => jsonResponse({ ok: true }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /테스트 메시지 보내기/ }));
    expect(await screen.findByText("테스트 메시지를 발송했습니다")).toBeInTheDocument();
    expect(sendRequests()).toEqual([{ method: "POST", body: { mode: "test" } }]);
  });

  // 채널이 실패하면 서버는 200에 { ok:false, error }를 싣는다 — throw가 아니다.
  it("ok:false로 오면 서버가 준 사유를 그대로 보여준다", async () => {
    send.push("/api/send", () => jsonResponse({ ok: false, error: "카카오워크 미연결" }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /테스트 메시지 보내기/ }));
    expect(await screen.findByText("카카오워크 미연결")).toBeInTheDocument();
  });

  // 권한 거부(403)는 예외로 온다. catch가 없으면 버튼이 "발송 중…"에 영구히 묶인다.
  it("HTTP 오류에도 오류를 띄우고 버튼을 다시 쓸 수 있게 둔다", async () => {
    send.push("/api/send", () => jsonResponse({ ok: false, error: "권한이 없습니다" }, 403));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /테스트 메시지 보내기/ }));
    expect(await screen.findByText(/테스트 발송 실패: 권한이 없습니다/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /테스트 메시지 보내기/ })).not.toBeDisabled();
  });
});

// QA W-10 · 관측 지점에 값 검증이 화면에도 서버에도 없었다. `nx=-1`을 저장하면
// 기상청 호출이 매시간 실패해 관측 수집이 통째로 멈추는데, 화면은 아무 말도 하지
// 않았고 셋업 체크리스트는 계속 완료로 보였다. 서버는 이제 400으로 막는다 —
// 이 테스트가 못 박는 것은 **화면이 그 400을 미리 설명하는가**이다.
// QA W-30 · 길이 상한도 같은 자리에서 화면이 먼저 알려야 한다.
describe("Settings 관측 지점·재알림 값 검증 (W-10 · W-30)", () => {
  const nxInput = () => screen.getByLabelText("격자 X (nx)");
  const nyInput = () => screen.getByLabelText("격자 Y (ny)");
  const remindInput = () => screen.getByLabelText("재알림 간격");
  const save = () => screen.getByRole("button", { name: "변경사항 저장" });

  async function loaded() {
    renderPage();
    await screen.findByText("관측 지점");
  }

  it("격자 범위를 벗어난 nx는 저장하지 않고 이유와 범위를 말한다", async () => {
    await loaded();
    fireEvent.change(nxInput(), { target: { value: "200" } });
    fireEvent.click(save());

    expect(await screen.findByText(/격자 X \(nx\)는 1~149 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
    // 저장 버튼 하나가 두 카드를 함께 저장한다 — 좌표가 잘못됐는데 알림 설정만
    // 저장되면 "일부만 저장됐다"는 상태가 남는다.
    expect(mocks.saveAlertSettings).not.toHaveBeenCalled();
  });

  // 입력칸을 비우면 Number("")가 0이 된다 — 예전에는 그 0이 그대로 저장됐다.
  it("입력칸을 비워 0이 된 좌표도 막는다", async () => {
    await loaded();
    fireEvent.change(nxInput(), { target: { value: "" } });
    fireEvent.click(save());

    expect(await screen.findByText(/격자 X \(nx\)는 1~149 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  it("음수 ny를 막는다", async () => {
    await loaded();
    fireEvent.change(nyInput(), { target: { value: "-1" } });
    fireEvent.click(save());

    expect(await screen.findByText(/격자 Y \(ny\)는 1~253 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  it("ny 상한(253)을 넘는 값을 막는다", async () => {
    await loaded();
    fireEvent.change(nyInput(), { target: { value: "254" } });
    fireEvent.click(save());

    expect(await screen.findByText(/격자 Y \(ny\)는 1~253 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  // 0이나 음수면 스케줄러가 매 tick 재알림을 보내 승인자에게 DM이 쏟아진다.
  it("서버 하한(5분)보다 짧은 재알림 간격을 막는다", async () => {
    await loaded();
    fireEvent.change(remindInput(), { target: { value: "1" } });
    fireEvent.click(save());

    expect(await screen.findByText(/재알림 간격은 5~1440분 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  it("하루(1440분)를 넘는 재알림 간격을 막는다", async () => {
    await loaded();
    fireEvent.change(remindInput(), { target: { value: "1441" } });
    fireEvent.click(save());

    expect(await screen.findByText(/재알림 간격은 5~1440분 사이의 정수여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  it("서버 상한(200자)을 넘는 주소를 막는다", async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText("지점 주소"), { target: { value: "가".repeat(201) } });
    fireEvent.click(save());

    expect(await screen.findByText(/지점 주소는 200자 이하여야 합니다/)).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  // 검사가 "항상 막는다"로 굳어 버리면 관측 지점을 영영 못 고친다.
  it("범위 안의 값은 그대로 저장한다", async () => {
    await loaded();
    fireEvent.change(nxInput(), { target: { value: "149" } });
    fireEvent.change(nyInput(), { target: { value: "253" } });
    fireEvent.change(remindInput(), { target: { value: "1440" } });
    fireEvent.click(save());

    await screen.findByText("변경사항이 저장되었습니다");
    expect(mocks.saveSiteSettings).toHaveBeenCalledWith(
      expect.objectContaining({ nx: 149, ny: 253, remind_interval_min: 1440 }),
    );
  });

  // 화면이 서버보다 관대하면 사용자는 다 입력한 뒤에야 400을 본다.
  it("입력칸이 서버와 같은 한계를 스스로 들고 있다", async () => {
    await loaded();
    expect(nxInput()).toHaveAttribute("max", "149");
    expect(nyInput()).toHaveAttribute("max", "253");
    expect(remindInput()).toHaveAttribute("min", "5");
    expect(remindInput()).toHaveAttribute("max", "1440");
    expect(screen.getByLabelText("지점 주소")).toHaveAttribute("maxlength", "200");
  });

  // 상한을 화면이 말해 주지 않으면 사용자는 저장에 실패하고 나서야 알게 된다.
  it("좌표 범위와 재알림 범위를 화면에 적는다", async () => {
    await loaded();
    expect(screen.getByText(/nx는 1~149, ny는 1~253/)).toBeInTheDocument();
    expect(screen.getByText(/간격은 5~1440분/)).toBeInTheDocument();
  });
});

// QA W-23 · 운영 안내서 §1-6의 1번은 "설정 화면에서 격자좌표와 **지점명**을 입력"하라고
// 지시하는데 그 입력란이 화면에 없었다. 서버는 처음부터 이 컬럼을 받았고 이번 라운드에
// 검증(비어 있지 않음·40자)까지 넣었는데, 그 값을 보내는 화면이 없었다 — W-16과 같은
// 모양이다: 문서가 앞서 있고 화면이 없다. 지점 이름은 네비게이션과 대시보드에 실린다.
describe("Settings 지점 이름 (W-23)", () => {
  const nameInput = () => screen.getByLabelText("지점 이름");
  const save = () => screen.getByRole("button", { name: "변경사항 저장" });

  async function loaded() {
    renderPage();
    await screen.findByText("관측 지점");
  }

  it("관측 지점 카드에서 지점 이름을 고쳐 저장한다", async () => {
    await loaded();
    fireEvent.change(nameInput(), { target: { value: "곤지암리조트" } });
    fireEvent.click(save());

    await screen.findByText("변경사항이 저장되었습니다");
    expect(mocks.saveSiteSettings).toHaveBeenCalledWith(
      expect.objectContaining({ site_name: "곤지암리조트" }),
    );
  });

  // 고치지 않아도 값은 함께 나가야 한다 — 빠뜨리면 서버가 옛 값을 그대로 두는 데
  // 기대게 되고, 그 기대는 PATCH가 부분 갱신이라는 사실에 묶여 조용히 깨진다.
  it("고치지 않아도 현재 지점 이름을 함께 보낸다", async () => {
    await loaded();
    fireEvent.click(save());

    await screen.findByText("변경사항이 저장되었습니다");
    expect(mocks.saveSiteSettings).toHaveBeenCalledWith(expect.objectContaining({ site_name: "곤지암" }));
  });

  it("비어 있는 지점 이름은 서버에 보내지 않는다", async () => {
    await loaded();
    fireEvent.change(nameInput(), { target: { value: "   " } });
    fireEvent.click(save());

    expect(await screen.findByText("지점 이름이 비어 있습니다")).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });

  it("서버 상한(40자)을 넘는 지점 이름을 막고 그 한계를 입력칸이 들고 있다", async () => {
    await loaded();
    expect(nameInput()).toHaveAttribute("maxlength", "40");
    fireEvent.change(nameInput(), { target: { value: "가".repeat(41) } });
    fireEvent.click(save());

    expect(await screen.findByText("지점 이름은 40자 이하여야 합니다")).toBeInTheDocument();
    expect(mocks.saveSiteSettings).not.toHaveBeenCalled();
  });
});
