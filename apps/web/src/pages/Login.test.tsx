import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Login from "./Login";

const mocks = vi.hoisted(() => ({ requestMagicLink: vi.fn() }));
vi.mock("../lib/api", () => ({ requestMagicLink: mocks.requestMagicLink }));

describe("Login", () => {
  beforeEach(() => {
    mocks.requestMagicLink.mockReset().mockResolvedValue({ ok: true });
  });

  it("이메일 입력 히어로를 렌더링한다", () => {
    render(<Login />);
    expect(screen.getByRole("heading", { name: "날씨경영" })).toBeInTheDocument();
    expect(screen.getByLabelText("카카오워크에 등록된 회사 이메일")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인 링크 받기" })).toBeInTheDocument();
  });

  it("이메일 제출 시 로그인 링크를 요청하고 안내 화면으로 전환한다", async () => {
    render(<Login />);
    fireEvent.change(screen.getByLabelText("카카오워크에 등록된 회사 이메일"), {
      target: { value: "a@t.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인 링크 받기" }));

    await waitFor(() => expect(mocks.requestMagicLink).toHaveBeenCalledWith("a@t.co"));
    expect(await screen.findByText(/카카오워크 앱을 확인해 주세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 보내기" })).toBeInTheDocument();
  });

  it("다시 보내기를 누르면 동일 이메일로 재요청한다", async () => {
    render(<Login />);
    fireEvent.change(screen.getByLabelText("카카오워크에 등록된 회사 이메일"), {
      target: { value: "a@t.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인 링크 받기" }));
    await screen.findByRole("button", { name: "다시 보내기" });

    fireEvent.click(screen.getByRole("button", { name: "다시 보내기" }));
    await waitFor(() => expect(mocks.requestMagicLink).toHaveBeenCalledTimes(2));
  });
});
