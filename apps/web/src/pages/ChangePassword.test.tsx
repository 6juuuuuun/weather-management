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

function fillAndSubmit(current: string, next: string) {
  fireEvent.change(screen.getByLabelText("현재 비밀번호"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: next } });
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
});
