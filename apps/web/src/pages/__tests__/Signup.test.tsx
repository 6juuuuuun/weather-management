import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Signup from "../Signup";

beforeEach(() => vi.restoreAllMocks());

function renderSignup() {
  return render(
    <MemoryRouter>
      <Signup />
    </MemoryRouter>,
  );
}

describe("회원가입", () => {
  it("가입에 성공하면 완료 안내를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 })),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/가입이 완료/)).toBeInTheDocument();
  });

  // 회귀: 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다.
  it("서버가 거부하면 실패 사유를 보여주고 성공 화면으로 넘어가지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "회사 이메일로만 가입할 수 있습니다" }), { status: 400 }),
      ),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gmail.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/회사 이메일로만/)).toBeInTheDocument();
    expect(screen.queryByText(/가입이 완료/)).not.toBeInTheDocument();
  });

  it("비밀번호가 10자 미만이면 보내지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(screen.getByText(/10자/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
