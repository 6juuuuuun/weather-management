import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ChangePassword from "./ChangePassword";

beforeEach(() => vi.restoreAllMocks());

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/change-password"]}>
      <Routes>
        <Route path="/change-password" element={<ChangePassword />} />
        <Route path="/" element={<p>홈 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillAndSubmit(current: string, next: string) {
  fireEvent.change(screen.getByLabelText("현재 비밀번호"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: next } });
  fireEvent.click(screen.getByRole("button", { name: /비밀번호 변경/ }));
}

describe("비밀번호 변경", () => {
  it("성공하면 서버에 현재·새 비밀번호를 보내고 홈으로 이동한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fillAndSubmit("old-password-1", "new-password-12345");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/auth/change-password");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ current: "old-password-1", next: "new-password-12345" });

    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
  });

  it("현재 비밀번호가 틀리면(401) 서버 문구를 보여주고 화면에 머문다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "현재 비밀번호가 맞지 않습니다" }), { status: 401 }),
      ),
    );
    renderPage();

    fillAndSubmit("wrong-current", "new-password-12345");

    expect(await screen.findByText("현재 비밀번호가 맞지 않습니다")).toBeInTheDocument();
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });

  it("새 비밀번호가 10자 미만이면 보내지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fillAndSubmit("old-password-1", "short");

    await waitFor(() => expect(screen.getByText(/10자/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
