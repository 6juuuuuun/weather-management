import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import ChangePassword from "./ChangePassword";
import { jsonResponse, makeFetchQueue } from "../test-support/fetchQueue";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ChangePassword는 이제 lib/api/auth를 직접 부르지 않고 useAuth().changePassword를
// 거친다(리뷰 F1 수정) — 그 함수가 서버 호출 뒤 컨텍스트까지 갱신하므로, 단독으로
// ChangePassword만 렌더하면 이 결선 자체가 검증에서 빠진다. AuthProvider로 감싸서
// 렌더한다.
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/change-password"]}>
      <AuthProvider>
        <Routes>
          <Route path="/change-password" element={<ChangePassword />} />
          <Route path="/" element={<p>홈 화면</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

// confirm을 따로 받는다 — 기본값은 next와 같은 값이다. 확인 칸은 서버로 나가지
// 않으므로(화면에서만 비교한다) 대부분의 시나리오에서는 "제대로 옮겨 적은" 경우를
// 재현하면 되고, 오타 시나리오만 다른 값을 넘긴다.
function fillAndSubmit(current: string, next: string, confirm: string = next) {
  fireEvent.change(screen.getByLabelText("현재 비밀번호"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: /비밀번호 변경/ }));
}

const meMustChange = () =>
  jsonResponse({
    user: { accountId: "acc-1", employeeId: "emp-1", role: "staff", email: "a@gonjiam.com", mustChangePassword: true },
  });

const meOk = () =>
  jsonResponse({
    user: { accountId: "acc-1", employeeId: "emp-1", role: "staff", email: "a@gonjiam.com", mustChangePassword: false },
  });

describe("비밀번호 변경", () => {
  it("성공하면 서버에 현재·새 비밀번호를 보내고 홈으로 이동한다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    // 호출 순서: 마운트 refresh → change-password 제출 → 그 뒤의 refresh(me·employees·recipients).
    push("/api/auth/me", meMustChange);
    push("/api/auth/change-password", () => jsonResponse(null, 204));
    push("/api/auth/me", meOk);
    push("/api/employees", () => jsonResponse([]));
    push("/api/alert-recipients", () => jsonResponse([]));
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("old-password-1", "new-password-12345");

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/change-password")).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([path]) => path === "/api/auth/change-password")!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ current: "old-password-1", next: "new-password-12345" });

    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
  });

  it("현재 비밀번호가 틀리면(401) 서버 문구를 보여주고 화면에 머문다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/auth/me", meMustChange);
    push("/api/auth/change-password", () => jsonResponse({ error: "현재 비밀번호가 맞지 않습니다" }, 401));
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("wrong-current", "new-password-12345");

    expect(await screen.findByText("현재 비밀번호가 맞지 않습니다")).toBeInTheDocument();
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });

  it("새 비밀번호가 10자 미만이면 서버에 변경 요청을 보내지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    // 마운트 시 AuthProvider가 항상 /api/auth/me를 부른다 — 이 검증은 "아무 fetch도
    // 없다"가 아니라 "change-password 요청이 없다"여야 한다(부서 select 지연 로드와
    // 같은 함정: 컨텍스트 자체의 마운트 조회까지 0회로 요구하면 실제 동작과 어긋난다).
    push("/api/auth/me", meMustChange);
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("old-password-1", "short");

    await waitFor(() => expect(screen.getByText(/10자/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/change-password")).toBe(false);
  });

  // 임시 비밀번호를 받은 사람이 쪽지의 값을 두 칸에 그대로 옮겨 적는 것이 가장 쉬운
  // 길이었고, 예전에는 그게 통과했다(QA W-05a) — 비밀번호는 임시 값 그대로인데
  // must_change_password가 풀리고 72시간 만료가 지워져 그 값이 영구히 유효해졌다.
  it("현재 비밀번호와 같은 값이면 서버에 변경 요청을 보내지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/auth/me", meMustChange);
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("W_OATBWhFGtt", "W_OATBWhFGtt");

    await waitFor(() => expect(screen.getByText(/다른 값이어야 합니다/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/change-password")).toBe(false);
  });

  // 화면에도 서버에도 안내가 없어서 사용자가 그 길로 걸어갔다. 안내를 화면에 둔다.
  it("임시 비밀번호와 다른 값이어야 한다는 것과 다른 기기가 끊긴다는 것을 안내한다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/auth/me", meMustChange);
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    expect(screen.getByText(/다른 값/)).toBeInTheDocument();
    expect(screen.getByText(/다른 기기에 남아 있는/)).toBeInTheDocument();
  });
  // 이 화면이 특히 위험한 자리다: 관리자에게 임시 비밀번호를 받아 처음 들어온 사람이
  // 새 값을 정하는 곳이라, 여기서 오타가 나면 **본인도 모르는 값**이 저장되고 그
  // 사람은 자기 계정에서 잠긴다(복구 경로는 관리자의 재발급뿐이다).
  it("새 비밀번호와 확인이 다르면 서버에 변경 요청을 보내지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/auth/me", meMustChange);
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("old-password-1", "new-password-12345", "new-password-12346");

    await waitFor(() => expect(screen.getByText(/서로 다릅니다/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/change-password")).toBe(false);
  });

  // 확인 칸은 화면에서만 비교한다 — 서버로 나갈 이유가 없다.
  it("확인 칸의 값은 서버로 나가지 않는다", async () => {
    const { fetchMock, push } = makeFetchQueue();
    vi.stubGlobal("fetch", fetchMock);
    push("/api/auth/me", meMustChange);
    push("/api/auth/change-password", () => jsonResponse(null, 204));
    push("/api/auth/me", meOk);
    push("/api/employees", () => jsonResponse([]));
    push("/api/alert-recipients", () => jsonResponse([]));
    renderPage();

    await screen.findByLabelText("현재 비밀번호");
    fillAndSubmit("old-password-1", "new-password-12345");

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([path]) => path === "/api/auth/change-password")).toBe(true),
    );
    const init = fetchMock.mock.calls.find(([path]) => path === "/api/auth/change-password")![1] as RequestInit;
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(["current", "next"]);
  });
});
