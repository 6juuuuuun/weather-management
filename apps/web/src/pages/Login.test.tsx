import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "./Login";
import { ApiError } from "../lib/api/client";

const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ login: mocks.login }) }));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/change-password" element={<p>비밀번호 변경 화면</p>} />
        <Route path="/" element={<p>홈 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillAndSubmit(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("이메일"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "로그인" }));
}

describe("Login", () => {
  beforeEach(() => {
    mocks.login.mockReset().mockResolvedValue({ mustChangePassword: false });
  });

  it("이메일·비밀번호 입력 폼과 가입 신청 링크를 렌더링한다", () => {
    renderLogin();
    expect(screen.getByRole("heading", { name: "날씨경영" })).toBeInTheDocument();
    expect(screen.getByLabelText("이메일")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
    const signupLink = screen.getByRole("link", { name: "계정이 없으신가요? 가입 신청" });
    expect(signupLink).toHaveAttribute("href", "/signup");
  });

  it("이메일·비밀번호로 로그인을 요청하고 성공하면 홈으로 이동한다", async () => {
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "password12345");

    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith("a@gonjiam.com", "password12345"));
    expect(await screen.findByText("홈 화면")).toBeInTheDocument();
  });

  // 임시 비밀번호로 로그인한 세션은 비밀번호부터 바꿔야 한다(server/src/auth/middleware.ts가
  // 이 상태에서 대부분의 /api/*를 403으로 막는다) — 화면이 그 경로로 곧장 보내야 한다.
  it("must_change_password가 참이면 비밀번호 변경 화면으로 이동한다", async () => {
    mocks.login.mockResolvedValue({ mustChangePassword: true });
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "temp-password-1");

    expect(await screen.findByText("비밀번호 변경 화면")).toBeInTheDocument();
  });

  // 서버 문구가 아니라 상태 코드로 직접 분기해 고정 문구를 보여준다는 것을 증명하려면
  // 서버가 실제로 보내는 문구와 다른 raw 메시지를 던져야 한다 — e.message를 그대로
  // 보여주기만 해도 우연히 통과하는 테스트가 되지 않도록 한다.
  it("403이면 서버 문구와 무관하게 계정을 쓸 수 없다는 고정 문구를 보여주고 화면을 벗어나지 않는다", async () => {
    mocks.login.mockRejectedValue(new ApiError(403, "Forbidden"));
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "password12345");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요",
    );
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
  });

  // 잠금(423)만은 서버 문구를 그대로 보여준다(QA W-18). 예전에는 여기서도 고정
  // 문구("잠시 후 다시 시도해 주세요")를 썼는데, 그 문구는 잠겼다는 말도 15분이라는
  // 말도 하지 않는다 — 사용자는 서버가 바쁜 줄 알고 계속 시도해 잠금을 연장했다.
  // 남은 시간은 서버만 아는 값이라 화면이 문구를 고정하면 영영 보여줄 수 없다.
  it("423이면 서버가 준 잠금 문구(남은 시간 포함)를 그대로 보여준다", async () => {
    mocks.login.mockRejectedValue(
      new ApiError(423, "비밀번호를 5회 잘못 입력해 계정이 잠겼습니다. 약 12분 뒤에 다시 시도하거나 관리자에게 문의해 주세요"),
    );
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "wrong-password");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("계정이 잠겼습니다");
    expect(alert).toHaveTextContent("12분");
    // 옛 고정 문구가 남아 있으면 남은 시간이 사라진다.
    expect(alert).not.toHaveTextContent("잠시 후 다시 시도해 주세요");
  });

  // 계정 존재 여부를 감추기 위해 서버가 401에 이미 사람이 읽을 수 있는 문구를 준다
  // (server/src/auth/routes.ts: "로그인할 수 없습니다"). 그 문구를 그대로 보여준다.
  it("401이면 서버가 준 문구를 그대로 보여준다", async () => {
    mocks.login.mockRejectedValue(new ApiError(401, "로그인할 수 없습니다"));
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "wrong-password");

    expect(await screen.findByRole("alert")).toHaveTextContent("로그인할 수 없습니다");
  });

  // 회귀: 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다. 여기서는
  // 실패 후 버튼이 다시 눌릴 수 있는 상태(spinner에 걸리지 않음)까지 함께 확인한다.
  it("로그인이 실패하면 홈으로 이동하지 않고 버튼이 다시 활성화된다", async () => {
    mocks.login.mockRejectedValue(new Error("네트워크 오류"));
    renderLogin();
    fillAndSubmit("a@gonjiam.com", "password12345");

    await screen.findByRole("alert");
    expect(screen.queryByText("홈 화면")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toBeEnabled();
  });
});
