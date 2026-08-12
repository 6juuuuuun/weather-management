import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Login from "./Login";

describe("Login", () => {
  it("카카오워크 로그인 히어로를 렌더링한다", () => {
    render(<Login />);
    expect(screen.getByRole("heading", { name: "날씨경영" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /카카오워크로 계속하기/ })).toBeInTheDocument();
  });
});
