import { describe, expect, it, beforeEach, vi } from "vitest";
import { record } from "./contract";
import { login, logout, me, changePassword, setAccountStatus, resetPassword, signup } from "../auth";

beforeEach(() => vi.restoreAllMocks());

// 대응하는 서버 라우트는 server/src/auth/routes.ts에 있다.
describe("lib/api/auth HTTP 계약", () => {
  it("login은 POST /api/auth/login에 email·password를 보낸다", async () => {
    const req = await record(() => login("a@gonjiam.com", "password12345"), {
      user: { accountId: "acc-1" },
      must_change_password: false,
    });
    expect(req).toEqual({
      path: "/api/auth/login",
      method: "POST",
      body: { email: "a@gonjiam.com", password: "password12345" },
    });
  });

  // 리뷰 F2: Signup.tsx가 이 모듈을 거치지 않고 apiSend를 직접 불러 계약 테스트가
  // 하나도 없었다. 경로·메서드·department_id를 포함한 본문 전체를 단언한다 —
  // department_id가 누락되면 전원이 부서 미지정으로 가입되고 requireDepartment
  // 라우트가 통째로 막히는데도 화면은 성공을 보여준다.
  it("signup은 POST /api/auth/signup에 email·password·name·department_id·phone을 보낸다", async () => {
    const req = await record(
      () =>
        signup({
          email: "a@gonjiam.com",
          password: "password12345",
          name: "홍길동",
          department_id: "dept-1",
          phone: "010-0000-0000",
        }),
      { ok: true },
    );
    expect(req).toEqual({
      path: "/api/auth/signup",
      method: "POST",
      body: {
        email: "a@gonjiam.com",
        password: "password12345",
        name: "홍길동",
        department_id: "dept-1",
        phone: "010-0000-0000",
      },
    });
  });

  it("signup은 부서를 선택하지 않으면 department_id를 null로 보낸다", async () => {
    const req = await record(
      () => signup({ email: "a@gonjiam.com", password: "password12345", name: "홍길동", department_id: null, phone: null }),
      { ok: true },
    );
    expect((req.body as any).department_id).toBeNull();
  });

  it("logout은 POST /api/auth/logout이고 본문이 없다", async () => {
    const req = await record(() => logout());
    expect(req).toEqual({ path: "/api/auth/logout", method: "POST", body: undefined });
  });

  it("me는 GET /api/auth/me다", async () => {
    const req = await record(() => me(), { user: { accountId: "acc-1" } });
    expect(req).toEqual({ path: "/api/auth/me", method: "GET", body: undefined });
  });

  it("changePassword는 POST /api/auth/change-password에 current·next를 보낸다", async () => {
    const req = await record(() => changePassword("old-pass-1234", "new-pass-12345"));
    expect(req).toEqual({
      path: "/api/auth/change-password",
      method: "POST",
      body: { current: "old-pass-1234", next: "new-pass-12345" },
    });
  });

  it("setAccountStatus는 PATCH /api/admin/users/:id/status에 status를 보낸다", async () => {
    const req = await record(() => setAccountStatus("acc-1", "disabled"), { ok: true });
    expect(req).toEqual({
      path: "/api/admin/users/acc-1/status",
      method: "PATCH",
      body: { status: "disabled" },
    });
  });

  it("resetPassword는 POST /api/admin/users/:id/reset-password이고 본문이 없다", async () => {
    const req = await record(() => resetPassword("acc-1"), { temporary_password: "temp123" });
    expect(req).toEqual({
      path: "/api/admin/users/acc-1/reset-password",
      method: "POST",
      body: undefined,
    });
  });
});
