import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

const USER = { email: "kim@gonjiam.com", password: "old-password-here", name: "김직원" };
const OTHER = { email: "park@gonjiam.com", password: "other-password-here", name: "박직원" };
const ADMIN = { email: "boss@gonjiam.com", password: "admin-password-here", name: "관리자" };

async function activeAgent(who: typeof USER) {
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
  });
});

describe("비밀번호 재설정", () => {
  it("관리자가 임시 비밀번호를 발급하면 그것으로 로그인된다", async () => {
    await activeAgent(USER);
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    // 역할이 바뀌었으니 세션을 다시 만든다
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const temp = res.body.temporary_password;
    expect(typeof temp).toBe("string");

    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(200);
    // 임시 비밀번호로 들어온 사람은 반드시 바꿔야 한다
    expect(login.body.must_change_password).toBe(true);
  });

  it("관리자가 아니면 발급할 수 없다", async () => {
    const agent = await activeAgent(USER);
    // 대상을 본인이 아닌 다른 계정으로 둔다 — 본인을 대상으로 하면 아래
    // "관리자도 자기 자신에게는" 가드가 먼저 걸려 403이 나오므로, 이 테스트가
    // 검증하려는 requireAdmin 자체가 빠져도 우연히 통과해 버린다.
    await activeAgent(OTHER);
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [OTHER.email]);
      return rows[0].id;
    });
    expect((await agent.post(`/api/admin/users/${id}/reset-password`)).status).toBe(403);
  });

  // 관리자 권한은 남을 구제하는 용도다. 본인에게 쓰면 현재 비밀번호를 몰라도
  // 비밀번호를 바꿀 수 있게 되어 change-password의 검증을 우회하는 셈이 된다.
  it("관리자도 자기 자신에게는 발급할 수 없다", async () => {
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const adminId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/${adminId}/reset-password`);
    expect(res.status).toBe(403);
    // 발급이 거부됐다면 관리자 본인의 비밀번호는 그대로여야 한다
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(200);
  });

  // uuid 컬럼은 Postgres에서 값으로(대소문자 무시) 비교되지만, 가드의 JS
  // 문자열 비교(===)는 대소문자를 구분한다. 관리자가 자기 accountId를
  // 대문자로 바꿔 보내면 가드는 "다른 계정"이라 오판하고 통과시키지만, SQL은
  // 정확히 자기 행을 찾아 갱신해 버린다 — 가드를 만든 이유 자체가 무력화된다.
  it("자기 accountId를 대문자로 바꿔 보내도 막힌다", async () => {
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const adminId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/${adminId.toUpperCase()}/reset-password`);
    expect(res.status).toBe(403);
    // 발급이 거부됐다면 관리자 본인의 비밀번호는 그대로여야 한다
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(200);
  });

  it("없는 계정을 대상으로 하면 404다", async () => {
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    // 형식은 유효하지만 어떤 계정과도 일치하지 않는 uuid
    const res = await admin2.post("/api/admin/users/00000000-0000-0000-0000-000000000000/reset-password");
    expect(res.status).toBe(404);
  });

  it("발급 즉시 기존 세션이 끊긴다", async () => {
    const victim = await activeAgent(USER);
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id;
    });
    await admin2.post(`/api/admin/users/${id}/reset-password`);
    // 비밀번호를 잃어버린 상황을 가정한 발급이므로, 남아 있던 세션도 함께 끊어야 한다
    expect((await victim.get("/api/auth/me")).status).toBe(401);
  });
});

describe("비밀번호 변경", () => {
  it("현재 비밀번호가 맞아야 바꿀 수 있다", async () => {
    const agent = await activeAgent(USER);
    const bad = await agent.post("/api/auth/change-password").send({ current: "wrong", next: "new-password-x" });
    expect(bad.status).toBe(401);

    const ok = await agent
      .post("/api/auth/change-password")
      .send({ current: USER.password, next: "new-password-x" });
    expect(ok.status).toBe(204);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: USER.email, password: "new-password-x" });
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(false);
  });

  it("너무 짧은 비밀번호는 거부한다", async () => {
    const agent = await activeAgent(USER);
    const res = await agent.post("/api/auth/change-password").send({ current: USER.password, next: "short" });
    expect(res.status).toBe(400);
  });
});

describe("강제 변경 세션 제한", () => {
  // 관리자가 임시 비밀번호를 발급한 계정을 흉내낸다: 비밀번호 해시는 손대지
  // 않고 플래그만 켜서, "임시 비밀번호로 로그인했다"는 상태를 재현한다.
  async function forcedChangeAdminAgent() {
    const admin2 = request.agent(app);
    await request(app).post("/api/auth/signup").send(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });
    const adminId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id;
    });
    await withService((q) =>
      q.query("update auth_accounts set must_change_password = true where id = $1", [adminId]),
    );
    await activeAgent(OTHER);
    const otherId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [OTHER.email]);
      return rows[0].id;
    });
    return { admin2, otherId };
  }

  // requireAuth가 아니라 requireAdmin이 403을 낸 것이면(예: 비관리자 대상)
  // 이 가드가 실제로 작동했는지 알 수 없다 — 그래서 응답 본문의
  // must_change_password 플래그까지 함께 확인한다.
  it("must_change_password가 참인 세션은 일반 API를 쓸 수 없다", async () => {
    const { admin2, otherId } = await forcedChangeAdminAgent();

    const res = await admin2.post(`/api/admin/users/${otherId}/reset-password`);
    expect(res.status).toBe(403);
    expect(res.body.must_change_password).toBe(true);

    // 빠져나갈 길인 /me, /logout은 열려 있어야 한다
    expect((await admin2.get("/api/auth/me")).status).toBe(200);
  });

  it("비밀번호를 바꾸고 나면 같은 세션으로 그 API가 통과한다", async () => {
    const { admin2, otherId } = await forcedChangeAdminAgent();

    const blocked = await admin2.post(`/api/admin/users/${otherId}/reset-password`);
    expect(blocked.status).toBe(403);

    const changed = await admin2
      .post("/api/auth/change-password")
      .send({ current: ADMIN.password, next: "admin-new-password-1" });
    expect(changed.status).toBe(204);

    const after = await admin2.post(`/api/admin/users/${otherId}/reset-password`);
    expect(after.status).toBe(200);
    expect(typeof after.body.temporary_password).toBe("string");
  });
});
