// 로그인·비밀번호 경로의 안전장치 — QA 수정 라운드 A 항목 2·3·4·7·8.
//
// 이 파일은 **로그인 전후의 이상 상태**만 본다: 잠긴 계정, 비활성 계정, 없는 계정,
// 임시 비밀번호를 그대로 다시 쓰는 사람, 다른 기기에 남아 있는 세션. 기존 서버
// 테스트는 전부 "정상 로그인"에서 시작했고, QA가 찾아낸 것은 전부 그 바깥이었다.
import { describe, expect, it, beforeEach, vi } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { verify } from "../src/auth/password.ts";

// verify를 실제 구현 그대로 쓰되 호출 횟수만 관찰한다(W-28). 타이밍을 재는 대신
// "없는 계정에도 해시 검증을 한 번 하는가"를 직접 본다 — 시간 측정은 CI에서 흔들린다.
vi.mock("../src/auth/password.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/password.ts")>();
  return { ...actual, verify: vi.fn(actual.verify) };
});

const USER = { email: "hard-user@gonjiam.com", password: "user-password-1", name: "사용자" };
const ADMIN = { email: "hard-admin@gonjiam.com", password: "admin-password-1", name: "관리자" };

async function signIn(who: { email: string; password: string; name: string }) {
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

async function adminAgent() {
  await request(app).post("/api/auth/signup").send(ADMIN);
  await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });
  return agent;
}

async function accountId(email: string): Promise<string> {
  return withService(async (q) => {
    const { rows } = await q.query("select id from auth_accounts where email = $1", [email]);
    return rows[0].id;
  });
}

async function sessionCount(email: string): Promise<number> {
  return withService(async (q) => {
    const { rows } = await q.query(
      `select count(*)::int as n from auth_sessions s
         join auth_accounts a on a.id = s.account_id where a.email = $1`,
      [email],
    );
    return rows[0].n;
  });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees where email like 'hard-%'");
  });
  vi.mocked(verify).mockClear();
});

describe("본인 비밀번호 변경 (W-05)", () => {
  // 임시 비밀번호를 쪽지에 적힌 그대로 두 칸에 옮겨 적으면 204가 나갔고,
  // 비밀번호는 임시 값 그대로인데 만료가 지워져 **영구히 유효**해졌다.
  it("같은 값으로는 바꿀 수 없다 — 임시 비밀번호의 만료가 사라지지 않는다", async () => {
    await signIn(USER);
    const admin = await adminAgent();
    const id = await accountId(USER.email);
    const issued = await admin.post(`/api/admin/users/${id}/reset-password`);
    expect(issued.status).toBe(200);
    const temp: string = issued.body.temporary_password;

    const me = request.agent(app);
    const login = await me.post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);

    const res = await me.post("/api/auth/change-password").send({ current: temp, next: temp });
    expect(res.status).toBe(400);

    // 상태가 그대로여야 한다 — 예전에는 여기서 must_change_password가 풀리고
    // temp_password_expires_at이 null이 되어 임시 비밀번호가 영구 백도어가 됐다.
    const acc = await withService(async (q) => {
      const { rows } = await q.query(
        "select must_change_password, temp_password_expires_at from auth_accounts where id = $1",
        [id],
      );
      return rows[0];
    });
    expect(acc.must_change_password).toBe(true);
    expect(acc.temp_password_expires_at).not.toBeNull();
  });

  it("다른 값으로는 바꿀 수 있다", async () => {
    const me = await signIn(USER);
    const res = await me
      .post("/api/auth/change-password")
      .send({ current: USER.password, next: "brand-new-password" });
    expect(res.status).toBe(204);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: USER.email, password: "brand-new-password" });
    expect(login.status).toBe(200);
  });

  // 비밀번호가 샜다고 판단해 스스로 바꾼 사람이, 실제로는 침입자의 세션(최대 12시간)을
  // 그대로 두게 된다. 관리자 재설정 경로에는 이 정리가 있고 본인 경로에만 없었다.
  it("다른 기기의 세션을 끊고 지금 쓰는 세션은 남긴다", async () => {
    const first = await signIn(USER);
    const second = request.agent(app);
    await second.post("/api/auth/login").send({ email: USER.email, password: USER.password });
    expect(await sessionCount(USER.email)).toBe(2);

    expect(
      (await first.post("/api/auth/change-password").send({ current: USER.password, next: "another-password" }))
        .status,
    ).toBe(204);

    // 바꾼 사람은 그 자리에서 계속 쓴다 — 튕겨 나가면 아무도 이 기능을 안 쓴다.
    expect((await first.get("/api/auth/me")).status).toBe(200);
    // 다른 기기는 끊긴다.
    expect((await second.get("/api/auth/me")).status).toBe(401);
    expect(await sessionCount(USER.email)).toBe(1);
  });
});

describe("계정 잠금을 알리고 보이게 한다 (W-17, W-18)", () => {
  async function lockOut(email: string) {
    let last;
    for (let i = 0; i < 5; i++) {
      last = await request(app).post("/api/auth/login").send({ email, password: "definitely-wrong" });
    }
    return last!;
  }

  it("잠기면 잠겼다고 말하고 남은 시간을 함께 준다", async () => {
    await signIn(USER);
    await lockOut(USER.email);
    const res = await request(app).post("/api/auth/login").send({ email: USER.email, password: USER.password });
    expect(res.status).toBe(423);
    // "잠시 후 다시 시도해 주세요"만으로는 사용자가 비밀번호를 계속 틀렸다고 믿고
    // 계속 시도해 잠금을 연장한다.
    expect(res.body.error).toMatch(/잠겼/);
    expect(res.body.error).toMatch(/분/);
    expect(res.body.locked_minutes).toBeGreaterThan(0);
    expect(res.body.locked_minutes).toBeLessThanOrEqual(15);
  });

  it("관리자 화면이 잠긴 계정과 누적 잠금 횟수를 볼 수 있다", async () => {
    await signIn(USER);
    const admin = await adminAgent();
    await lockOut(USER.email);

    const res = await admin.get("/api/employees");
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.email === USER.email);
    // 예전에는 이 화면이 잠긴 계정을 여전히 "사용 중"이라고 적극적으로 말했다.
    expect(row.account_locked).toBe(true);
    expect(row.account_lock_count).toBe(1);
  });

  it("계정을 다시 활성화하면 잠금도 함께 풀린다", async () => {
    await signIn(USER);
    const admin = await adminAgent();
    const id = await accountId(USER.email);
    await lockOut(USER.email);

    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" })).status).toBe(200);
    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "active" })).status).toBe(200);

    // 관리자는 풀어 줬다고 믿는데 직원은 계속 못 들어오던 상태를 막는다.
    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: USER.password });
    expect(login.status).toBe(200);

    // 누적 횟수는 지우지 않는다 — 몇 번 잠겼는지는 계속 보여야 한다.
    const row = (await admin.get("/api/employees")).body.find((r: any) => r.email === USER.email);
    expect(row.account_locked).toBe(false);
    expect(row.account_lock_count).toBe(1);
  });
});

describe("비활성 계정에는 임시 비밀번호를 발급하지 않는다 (W-27)", () => {
  it("발급을 거부하고 이유를 말한다", async () => {
    await signIn(USER);
    const admin = await adminAgent();
    const id = await accountId(USER.email);
    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" })).status).toBe(200);

    const res = await admin.post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/활성/);
    expect(res.body.temporary_password).toBeUndefined();

    // 거부했으면 비밀번호도 바뀌지 않아야 한다 — "발급했다고 믿는" 상태가 문제였으므로
    // 반대로 조용히 바꿔 두는 것도 안 된다.
    const acc = await withService(async (q) => {
      const { rows } = await q.query("select must_change_password from auth_accounts where id = $1", [id]);
      return rows[0];
    });
    expect(acc.must_change_password).toBe(false);
  });

  it("활성 계정에는 그대로 발급된다", async () => {
    await signIn(USER);
    const admin = await adminAgent();
    const id = await accountId(USER.email);
    const res = await admin.post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    expect(typeof res.body.temporary_password).toBe("string");
  });
});

describe("없는 계정도 같은 비용을 치른다 (W-28)", () => {
  it("존재하지 않는 이메일로 로그인해도 해시 검증을 한 번 한다", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody-here@gonjiam.com", password: "whatever-1" });
    expect(res.status).toBe(401);
    // 예전에는 `if (!account) return deny()`가 argon2 검증을 통째로 건너뛰어
    // 없는 계정만 즉시 응답했다 — 문구는 같아도 시간이 계정 존재 여부를 알려 줬다.
    expect(vi.mocked(verify)).toHaveBeenCalledTimes(1);
  });

  it("있는 계정에 틀린 비밀번호를 넣을 때와 검증 횟수가 같다", async () => {
    await signIn(USER);
    vi.mocked(verify).mockClear();
    await request(app).post("/api/auth/login").send({ email: USER.email, password: "wrong-password-1" });
    const withAccount = vi.mocked(verify).mock.calls.length;
    vi.mocked(verify).mockClear();
    await request(app).post("/api/auth/login").send({ email: "no-such@gonjiam.com", password: "wrong-password-1" });
    expect(vi.mocked(verify).mock.calls.length).toBe(withAccount);
  });
});
