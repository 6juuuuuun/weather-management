import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeptBlock } from "../lib/types";
import { jsonResponse, makeFetchQueue } from "../test-support/fetchQueue";

// 절대 날짜(예: "2026-07-16")는 History.tsx의 기본 기간 필터("최근 30일") 경계를
// 시간이 지나며 넘어서게 되어 테스트가 저절로 실패하는 시한폭탄이 된다.
// 따라서 테스트 실행 시각(now) 기준 상대 날짜로 계산해 항상 필터 창 안에 들어오도록 한다.
const now = Date.now();
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000);

const sentAtDate = daysAgo(5);
// 감지(detected_at)는 발송(sent_at)보다 항상 먼저 있어야 하므로 10분 앞선 시각으로 고정
const detectedAtDate = new Date(sentAtDate.getTime() - 10 * 60 * 1000);
const detected_at = detectedAtDate.toISOString();
const sent_at = sentAtDate.toISOString();

const content: DeptBlock[] = [
  {
    department_id: "d1",
    department_name: "리조트",
    staff_actions: ["수건 추가 배포"],
    guest_notice: "야외 시설 운영이 제한됩니다",
    recipients: [{ employee_id: "e1", name: "홍수진", kakaowork_user_id: "k1" }],
    selected: true,
  },
  {
    // 선택 해제된 블록 — 실제 발송 수신처가 아니므로 이 부서명으로 검색해도 매치되면 안 됨
    department_id: "d2",
    department_name: "조리",
    staff_actions: ["식자재 점검"],
    guest_notice: "",
    recipients: [{ employee_id: "e2", name: "박세준", kakaowork_user_id: "k2" }],
    selected: false,
  },
];

// messages.content는 재발송으로 갱신된 "현재" 초안 — 발송 당시 스냅샷(content)과 달라야
// 스냅샷 우선 폴백 로직(d.content ?? d.messages?.content)이 검증됨
const staleMessagesContent: DeptBlock[] = content.map((b) => ({ ...b, guest_notice: "재발송으로 갱신된 최신 내용" }));

const dispatchRow = {
  id: 12,
  message_id: "m1",
  event_id: "ev1",
  sent_at,
  channel: "kakaowork",
  repeat_no: 3,
  is_test: false,
  results: [{ employee_id: "e1", name: "홍수진", ok: true }],
  content,
  message_content: staleMessagesContent,
  kind: "rain" as const,
  grade: "watch" as const,
  detected_at,
};

// content 스냅샷 컬럼이 없던(0004 이전) 과거 이력 — messages.content로 폴백되어야 함
// (recipientSummary 텍스트 충돌을 피하기 위해 dispatchRow와 다른 부서/인원 사용)
const legacyContent: DeptBlock[] = [
  {
    department_id: "d3",
    department_name: "프론트오피스",
    staff_actions: ["체크인 안내 문구 게시"],
    guest_notice: "폭설로 도로 상황이 지연될 수 있습니다",
    recipients: [{ employee_id: "e3", name: "이설아", kakaowork_user_id: "k3" }],
    selected: true,
  },
];

// 기본 기간 필터("최근 30일")에 걸리지 않도록 dispatchRow와 근접한 날짜를 사용하되,
// 절대 날짜 상수는 시간이 지나면 필터 경계를 넘어 만료되므로 dispatchRow와 마찬가지로
// 테스트 실행 시각(now) 기준 상대 날짜로 계산한다. dispatchRow와는 다른 날(4일 차이)로 두어
// 두 이력이 같은 시각으로 우연히 겹치지 않게 한다.
const legacySentAtDate = daysAgo(9);
const legacyDetectedAtDate = new Date(legacySentAtDate.getTime() - 10 * 60 * 1000);
const legacySentAt = legacySentAtDate.toISOString();
const legacyDetectedAt = legacyDetectedAtDate.toISOString();

const legacyDispatchRow = {
  id: 7,
  message_id: "m0",
  event_id: "ev0",
  sent_at: legacySentAt,
  channel: "kakaowork",
  repeat_no: 1,
  is_test: false,
  // dispatchRow와 statusSummary 텍스트("성공 1")가 겹치지 않도록 실패 1건 포함
  results: [
    { employee_id: "e3", name: "이설아", ok: true },
    { employee_id: "e4", name: "박은비", ok: false, error: "미연결" },
  ],
  content: null,
  message_content: legacyContent,
  kind: "snow" as const,
  grade: "warning" as const,
  detected_at: legacyDetectedAt,
};

const mocks = vi.hoisted(() => ({
  authState: {
    employee: { id: "emp1", name: "김운영", role: "approver" },
    loading: false,
    isApprover: true,
  },
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => mocks.authState,
}));

// callSend는 목하지 않는다 — 모듈을 통째로 목하면 경로·메서드·본문이 틀려도 통과한다.
let send: ReturnType<typeof makeFetchQueue>;
const sendRequests = () =>
  send.fetchMock.mock.calls
    .filter(([path]) => path === "/api/send")
    .map(([, init]) => ({ method: init!.method, body: JSON.parse(String(init!.body)) }));

beforeEach(() => {
  mocks.authState = {
    employee: { id: "emp1", name: "김운영", role: "approver" },
    loading: false,
    isApprover: true,
  };
  send = makeFetchQueue();
  vi.stubGlobal("fetch", send.fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// vi.mock 팩토리는 파일 최상단으로 호이스팅되므로, 그 안에서 아래에 선언된
// dispatchRow/legacyDispatchRow를 직접 참조할 수 없다 — 팩토리 안에서 지연 평가한다.
vi.mock("../lib/api/content", () => ({
  dispatches: vi.fn(() => Promise.resolve([dispatchRow, legacyDispatchRow])),
}));

// AppLayout이 항상 GlobalNav를 그리고, GlobalNav는 dashboard api를 부른다.
vi.mock("../lib/api/dashboard", () => ({
  siteSettings: vi.fn().mockResolvedValue(null),
  heartbeat: vi.fn().mockResolvedValue(null),
}));

import History from "./History";

describe("History", () => {
  it("발송 이력 목록을 렌더링한다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    expect(screen.getByText("주의보")).toBeInTheDocument();
    expect(screen.getByText("리조트 · 1명")).toBeInTheDocument();
    expect(screen.getByText("성공 1")).toBeInTheDocument();
    expect(screen.getByText("3회차")).toBeInTheDocument();
    expect(screen.getAllByText("재발송").length).toBeGreaterThan(0);
  });

  it("행 클릭 시 모달에 발송 당시 내용이 표시된다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    screen.getByText("리조트 · 1명").closest("tr")?.click();
    expect(await screen.findByText("수건 추가 배포")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "수정 후 재발송" })).toBeInTheDocument();
  });

  it("재발송으로 messages.content가 갱신되어도 발송 당시 content 스냅샷이 우선 표시된다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("리조트 · 1명")).toBeInTheDocument());
    screen.getByText("리조트 · 1명").closest("tr")?.click();
    expect(await screen.findByText("야외 시설 운영이 제한됩니다")).toBeInTheDocument();
    expect(screen.queryByText("재발송으로 갱신된 최신 내용")).not.toBeInTheDocument();
  });

  it("content 스냅샷이 없는 과거 이력은 messages.content로 폴백 표시된다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("프론트오피스 · 1명")).toBeInTheDocument());
    screen.getByText("프론트오피스 · 1명").closest("tr")?.click();
    expect(await screen.findByText("체크인 안내 문구 게시")).toBeInTheDocument();
  });

  it("선택 해제된 부서명으로 검색하면 결과에 나타나지 않는다", async () => {
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("특보 · 수신처 검색"), { target: { value: "조리" } });

    await waitFor(() => expect(screen.queryByText("폭우")).not.toBeInTheDocument());
    expect(screen.getByText("발송 이력이 없습니다")).toBeInTheDocument();
  });

  // 재발송은 서버의 POST /api/send(mode:"resend")를 탄다. event_id가 아니라
  // message_id를 보내야 서버가 messages를 갱신한다 — 여기가 어긋나면 조용히 실패한다.
  it("빠른 재발송은 POST /api/send에 { mode: 'resend', message_id, content }를 보낸다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    send.push("/api/send", () => jsonResponse({ ok: true, dispatch_id: 9, repeat_no: 4, fail_count: 0 }));
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("재발송")[0]!);

    await waitFor(() => expect(sendRequests()).toHaveLength(1));
    const [req] = sendRequests();
    expect(req!.method).toBe("POST");
    expect(req!.body.mode).toBe("resend");
    expect(req!.body.message_id).toBe("m1");
    expect(req!.body.content).toEqual(content);
  });

  // 재발송도 alert_recipients 게이트를 탄다 — 거부는 예외로 온다. catch가 없으면
  // 모달이 "재발송 중…"에 묶인 채 아무 설명도 나오지 않는다.
  // 재발송도 alert_recipients 게이트를 탄다 — 거부는 예외로 온다. catch가 없으면
  // 모달이 "재발송 중…"에 묶인 채 아무 설명도 나오지 않는다.
  it("수정 후 재발송이 거부되면 모달에 사유를 보여주고 버튼을 다시 쓸 수 있게 둔다", async () => {
    send.push("/api/send", () => jsonResponse({ ok: false, error: "권한이 없습니다" }, 403));
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    screen.getByText("리조트 · 1명").closest("tr")?.click();
    fireEvent.click(await screen.findByRole("button", { name: "수정 후 재발송" }));
    // 목록 행에도 같은 이름의 버튼이 있으므로 모달 안에서만 찾는다.
    const modal = screen.getByRole("dialog");
    fireEvent.click(within(modal).getByRole("button", { name: "재발송" }));
    expect(await screen.findByText("권한이 없습니다")).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "재발송" })).not.toBeDisabled();
  });

  // 빠른 재발송은 모달을 열지 않는다 — sendError를 모달 안에서만 그리면 이 경로의
  // 실패가 화면에 전혀 남지 않아 사용자는 발송된 줄 안다.
  it("빠른 재발송이 실패하면 목록 화면에 사유를 보여준다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    send.push("/api/send", () => jsonResponse({ ok: false, error: "권한이 없습니다" }, 403));
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("재발송")[0]!);
    expect(await screen.findByText("권한이 없습니다")).toBeInTheDocument();
  });

  it("role이 approver여도 Alert 수신자가 아니면 재발송 버튼이 보이지 않는다", async () => {
    mocks.authState = {
      employee: { id: "emp1", name: "김운영", role: "approver" },
      loading: false,
      isApprover: false,
    };
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText("폭우")).toBeInTheDocument());
    expect(screen.queryByText("재발송")).not.toBeInTheDocument();
  });
});
