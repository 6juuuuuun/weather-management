import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

const SIGNUP = {
  email: "hong@gonjiam.com",
  password: "correct-horse-battery",
  name: "홍길동",
  phone: "010-1234-5678",
};

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
  });
});

describe("가입", () => {
  it("허용 도메인이면 가입되고 바로 로그인할 수 있다", async () => {
    const res = await request(app).post("/api/auth/signup").send(SIGNUP);
    expect(res.status).toBe(201);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(login.status).toBe(200);
  });

  // 가입 자체는 열려 있어도 권한은 없어야 한다. 이게 실제 관문이다.
  it("가입한 계정의 기본 역할은 staff다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const role = await withService(async (q) => {
      const { rows } = await q.query("select role from employees where email = $1", [SIGNUP.email]);
      return rows[0].role;
    });
    expect(role).toBe("staff");
  });

  // 사내 DNS로만 열리지만, 도메인 제한이 없으면 외부 메일로도 계정이 생긴다.
  it("회사 도메인이 아니면 거부한다", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ ...SIGNUP, email: "hong@gmail.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/회사 이메일/);
  });

  it("이미 있는 이메일이면 거부한다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const res = await request(app).post("/api/auth/signup").send(SIGNUP);
    expect(res.status).toBe(409);
  });
});

describe("로그인", () => {
  // 퇴사자를 막는 유일한 수단이다. 비활성화가 안 먹으면 계정을 회수할 방법이 없다.
  it("비활성화된 계정은 로그인할 수 없다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    await withService((q) => q.query("update auth_accounts set status='disabled'"));
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(res.status).toBe(403);
  });

  it("로그인하면 세션 쿠키가 내려온다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });

    expect(res.status).toBe(200);
    const cookie = res.headers["set-cookie"][0];
    // 스크립트가 읽을 수 있으면 XSS 한 번에 세션이 털린다.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("비밀번호가 틀리면 401이고 사유를 구분해 알려주지 않는다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: "wrong" });
    expect(res.status).toBe(401);
    // 이메일 존재 여부가 드러나면 계정 목록을 캐낼 수 있다
    expect(res.body.error).not.toMatch(/비밀번호가/);
  });

  it("5회 실패하면 잠긴다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(res.status).toBe(423);
  });
});

describe("계정 비활성화", () => {
  async function adminAgent() {
    const admin = { email: "boss@gonjiam.com", password: "admin-password-1", name: "관리자" };
    await request(app).post("/api/auth/signup").send(admin);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [admin.email]));
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: admin.email, password: admin.password });
    return agent;
  }

  it("관리자는 계정을 비활성화할 수 있고 즉시 로그인이 막힌다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const admin = await adminAgent();
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [SIGNUP.email]);
      return rows[0].id;
    });

    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" })).status).toBe(200);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(login.status).toBe(403);
  });

  it("비활성화하면 남아 있던 세션도 끊긴다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const victim = request.agent(app);
    await victim.post("/api/auth/login").send({ email: SIGNUP.email, password: SIGNUP.password });
    const admin = await adminAgent();
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [SIGNUP.email]);
      return rows[0].id;
    });

    await admin.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" });
    // 퇴사자를 막는 것이 목적이다. 세션이 남으면 막은 의미가 없다.
    expect((await victim.get("/api/auth/me")).status).toBe(401);
  });

  it("일반 직원은 계정 상태를 바꿀 수 없다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: SIGNUP.email, password: SIGNUP.password });
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [SIGNUP.email]);
      return rows[0].id;
    });
    expect((await agent.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" })).status).toBe(403);
  });
});

describe("세션", () => {
  async function loginAgent() {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: SIGNUP.email, password: SIGNUP.password });
    return agent;
  }

  it("쿠키가 없으면 401이다", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });

  it("로그인 후에는 내 정보를 돌려준다", async () => {
    const agent = await loginAgent();
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(SIGNUP.email);
  });

  it("로그아웃하면 세션이 즉시 무효가 된다", async () => {
    const agent = await loginAgent();
    await agent.post("/api/auth/logout");
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("만료된 세션은 거부한다", async () => {
    const agent = await loginAgent();
    await withService((q) => q.query("update auth_sessions set expires_at = now() - interval '1 second'"));
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });
});
