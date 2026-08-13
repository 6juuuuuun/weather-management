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

  // 회귀: 예전에는 finally에서 무조건 안내 화면으로 넘어가, 요청이 실패해도
  // "카카오워크 앱을 확인해 주세요"가 떴다. 오지 않을 DM을 기다리게 되는 실패다.
  it("요청이 실패하면 안내 화면으로 넘어가지 않고 오류를 표시한다", async () => {
    mocks.requestMagicLink.mockRejectedValue(new Error("Failed to send a request to the Edge Function"));
    render(<Login />);
    fireEvent.change(screen.getByLabelText("카카오워크에 등록된 회사 이메일"), {
      target: { value: "a@t.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인 링크 받기" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/링크를 보내지 못했습니다/);
    expect(screen.queryByText(/카카오워크 앱을 확인해 주세요/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인 링크 받기" })).toBeEnabled();
  });

  it("실패 후 재시도가 성공하면 오류가 사라지고 안내 화면으로 전환한다", async () => {
    mocks.requestMagicLink.mockRejectedValueOnce(new Error("네트워크 오류"));
    render(<Login />);
    fireEvent.change(screen.getByLabelText("카카오워크에 등록된 회사 이메일"), {
      target: { value: "a@t.co" },
    });
    fireEvent.click(screen.getByRole("button", { name: "로그인 링크 받기" }));
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "로그인 링크 받기" }));
    expect(await screen.findByText(/카카오워크 앱을 확인해 주세요/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
