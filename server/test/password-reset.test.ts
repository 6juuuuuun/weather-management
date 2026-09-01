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

  // Postgres의 uuid 파서는 하이픈 없는 32자리, 중괄호로 감싼 표기도 같은
  // 값으로 받아들인다. 대소문자만 맞춘 비교로는 이 표기들을 못 잡는다 —
  // 문자열이 다르니 가드는 "다른 계정"이라 오판해 통과시키고, SQL은 같은
  // uuid로 인식해 정확히 자기 행을 갱신해 버린다. 표기를 하나씩 쫓는 대신
  // 정규 형식이 아니면 SQL에 닿기 전에 400으로 거부해야 한다.
  it("자기 id를 하이픈 없이 보내도 막힌다", async () => {
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const adminId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/${adminId.replace(/-/g, "")}/reset-password`);
    expect(res.status).toBe(400);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(login.status).toBe(200);
  });

  it("자기 id를 중괄호로 감싸 보내도 막힌다", async () => {
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const adminId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/{${adminId}}/reset-password`);
    expect(res.status).toBe(400);
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

// 스펙 §6.4 "임시 비밀번호에는 만료 시간을 둔다".
//
// 만료가 없으면 발급된 값이 영구히 유효하다. 발급한 관리자는 그 값을 알고 있으므로
// 당사자가 쓰지 않고 방치하면 몇 달 뒤에도 그 계정으로 로그인해 비밀번호를 바꿔
// 계정을 인수할 수 있다(대상이 Alert 수신자면 특보 승인 권한까지).
describe("임시 비밀번호 만료", () => {
  async function issueTemp() {
    await activeAgent(USER);
    await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin = request.agent(app);
    await admin.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id as string;
    });
    const res = await admin.post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    return { id, temp: res.body.temporary_password as string, body: res.body };
  }

  it("발급하면 만료 시각이 함께 기록되고, 응답이 유효 시간을 알려 준다", async () => {
    const { id, body } = await issueTemp();
    expect(body.expires_in_hours).toBeGreaterThan(0);
    const row = await withService(async (q) => {
      const { rows } = await q.query(
        "select temp_password_expires_at is not null as has_exp, temp_password_expires_at > now() as future from auth_accounts where id=$1",
        [id],
      );
      return rows[0];
    });
    expect(row.has_exp).toBe(true);
    expect(row.future).toBe(true);
  });

  it("만료 전에는 그 값으로 로그인된다", async () => {
    const { temp } = await issueTemp();
    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);
  });

  it("만료된 뒤에는 값이 맞아도 로그인되지 않는다", async () => {
    const { id, temp } = await issueTemp();
    await withService((q) =>
      q.query("update auth_accounts set temp_password_expires_at = now() - interval '1 minute' where id=$1", [id]),
    );
    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(403);
    expect(login.body.error).toMatch(/임시 비밀번호/);
  });

  it("비밀번호를 바꾸면 만료가 지워진다 — 본인이 정한 비밀번호가 만료를 물려받지 않는다", async () => {
    const { id, temp } = await issueTemp();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: USER.email, password: temp });
    expect((await agent.post("/api/auth/change-password").send({ current: temp, next: "brand-new-password" })).status)
      .toBe(204);
    const row = await withService(async (q) => {
      const { rows } = await q.query(
        "select temp_password_expires_at, must_change_password from auth_accounts where id=$1", [id]);
      return rows[0];
    });
    expect(row.temp_password_expires_at).toBe(null);
    expect(row.must_change_password).toBe(false);

    // 만료 시각을 과거로 되돌려 놔도(=옛 발급의 흔적) 본인 비밀번호는 막히면 안 된다.
    await withService((q) =>
      q.query("update auth_accounts set temp_password_expires_at = now() - interval '1 day' where id=$1", [id]));
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: USER.email, password: "brand-new-password" });
    expect(login.status).toBe(200);
  });

  // 이 마이그레이션 이전에 발급된 값은 만료 시각이 null이다. 그것을 "만료됨"으로
  // 취급하면, 지금 그 값으로만 로그인할 수 있는 사람이 갑자기 잠긴다.
  it("만료 시각이 없는(옛) 임시 비밀번호는 그대로 쓸 수 있다", async () => {
    const { id, temp } = await issueTemp();
    await withService((q) =>
      q.query("update auth_accounts set temp_password_expires_at = null where id=$1", [id]));
    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(200);
  });
});

// PATCH /api/admin/users/:id/status — 계정 활성/비활성
//
// 이 엔드포인트는 퇴사자를 막는 유일한 수단이면서, 자기 자신에게 쓰면 제품 안에
// 복구 경로가 없는 유일한 조작이기도 하다: 관리자가 1명뿐인 배포(= 이 제품의
// 기본 상태)에서 자기 행의 "비활성화"를 누르면 상태가 disabled로 바뀌고 자기
// 세션까지 전부 지워진다 → 로그인 403 → 재활성화는 admin만 가능 → DB 직접 개입.
// 같은 라우터의 reset-password는 이미 같은 이유로 자기대상을 막고 있었다.
describe("계정 상태 변경", () => {
  async function adminAgent() {
    await request(app).post("/api/auth/signup").send(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [ADMIN.email]);
      return rows[0].id as string;
    });
    return { agent, id };
  }

  it("남의 계정은 비활성화할 수 있다", async () => {
    await activeAgent(USER);
    const { agent } = await adminAgent();
    const victimId = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id as string;
    });
    const res = await agent.patch(`/api/admin/users/${victimId}/status`).send({ status: "disabled" });
    expect(res.status).toBe(200);
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: USER.email, password: USER.password });
    expect(relogin.status).toBe(403);
  });

  it("자기 계정은 비활성화할 수 없다 — 스스로 잠그면 복구 경로가 없다", async () => {
    const { agent, id } = await adminAgent();
    const res = await agent.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" });
    expect(res.status).toBe(403);
    // 세션도 계정도 그대로 살아 있어야 한다.
    expect((await agent.get("/api/auth/me")).status).toBe(200);
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(relogin.status).toBe(200);
  });

  // 대소문자만 다른 uuid 표기로 가드를 우회할 수 없어야 한다(reset-password와 같은 처방).
  it("대문자 uuid로도 자기 계정을 비활성화할 수 없다", async () => {
    const { agent, id } = await adminAgent();
    const res = await agent.patch(`/api/admin/users/${id.toUpperCase()}/status`).send({ status: "disabled" });
    expect(res.status).toBe(403);
  });

  it("uuid 형식이 아니면 400이다 (예전에는 500이었다)", async () => {
    const { agent } = await adminAgent();
    const res = await agent.patch("/api/admin/users/not-a-uuid/status").send({ status: "disabled" });
    expect(res.status).toBe(400);
  });

  // 없는 id에 200 {"ok":true}를 주면 관리자는 막았다고 믿는다.
  it("없는 계정 id에는 404다 — reset-password와 같은 규약", async () => {
    const { agent } = await adminAgent();
    const res = await agent
      .patch("/api/admin/users/00000000-0000-0000-0000-000000000000/status")
      .send({ status: "disabled" });
    expect(res.status).toBe(404);
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

  // Express는 기본으로 경로 대소문자를 구분하지 않고 끝 슬래시도 무시해
  // 실제 핸들러까지 두 형태 모두 도달한다. 그런데 허용 목록 비교가 정확
  // 일치라면, 강제 변경 중인 세션이 탈출구인 change-password를 대문자나
  // 끝 슬래시가 붙은 형태로 부르는 순간 그 탈출구 자체가 막혀 버려 아무것도
  // 못 하는 상태에 갇힌다. 보안 구멍은 아니지만 실제 장애다.
  it("강제 변경 중에도 대소문자가 다른 change-password 경로는 막히지 않는다", async () => {
    const { admin2 } = await forcedChangeAdminAgent();
    const res = await admin2
      .post("/API/AUTH/Change-Password")
      .send({ current: ADMIN.password, next: "admin-new-password-3" });
    expect(res.status).toBe(204);
  });

  it("강제 변경 중에도 끝 슬래시가 붙은 change-password 경로는 막히지 않는다", async () => {
    const { admin2 } = await forcedChangeAdminAgent();
    const res = await admin2
      .post("/api/auth/change-password/")
      .send({ current: ADMIN.password, next: "admin-new-password-4" });
    expect(res.status).toBe(204);
  });
});
