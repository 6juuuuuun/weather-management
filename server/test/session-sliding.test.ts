import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

// ---------------------------------------------------------------------------
// QA W-14 · 결정 D-4(a) — 슬라이딩 만료
//
// 세션 TTL이 고정 12시간이고 활동에 따른 갱신이 없어서, 관제실 벽에 걸린 무인
// 월보드는 **하루 두 번 사람이 걸어가서 로그인해야** 했고 꺼지는 시각은 마지막
// 로그인 시각에 따라 제멋대로였다(새벽 3시에 로그인 폼이 걸린 채 아침을 맞는다).
//
// 여기서 못 박는 계약은 셋이다.
//   1) 활동이 있으면 만료가 뒤로 밀린다 → 30초 폴링하는 월보드는 영원히 살아 있다.
//   2) 그래도 **활동이 끊기면 만료된다** → 자리를 뜬 화면·도난 노트북은 죽는다.
//   3) 매 요청마다 update를 쏘지는 않는다 → 30초 폴링이 DB 쓰기 폭을 만들지 않는다.
// ---------------------------------------------------------------------------

const USER = { email: "board@gonjiam.com", password: "correct-horse-battery", name: "월보드" };

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees where email = $1", [USER.email]);
  });
});

async function loginAgent() {
  await request(app).post("/api/auth/signup").send(USER);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: USER.email, password: USER.password });
  return agent;
}

/** 남은 수명(분). 만료를 직접 읽지 않고 "지금부터 몇 분 남았나"로 본다. */
async function minutesLeft(): Promise<number> {
  return withService(async (q) => {
    const { rows } = await q.query(
      "select extract(epoch from (expires_at - now())) / 60 as m from auth_sessions",
    );
    return Number(rows[0].m);
  });
}

/** 세션이 이미 N분 방치된 것처럼 만든다(만료를 앞으로 당긴다). */
async function idleFor(minutes: number): Promise<void> {
  await withService((q) =>
    q.query("update auth_sessions set expires_at = expires_at - ($1 || ' minutes')::interval", [
      String(minutes),
    ]),
  );
}

describe("세션 슬라이딩 만료 (W-14 · D-4)", () => {
  it("로그인 직후 수명은 8시간이다", async () => {
    await loginAgent();
    const left = await minutesLeft();
    expect(left).toBeGreaterThan(8 * 60 - 2);
    expect(left).toBeLessThanOrEqual(8 * 60);
  });

  it("만료가 다가온 세션은 요청 한 번에 다시 8시간으로 밀린다", async () => {
    const agent = await loginAgent();
    // 7시간 50분을 방치한 상태(남은 수명 10분).
    await idleFor(7 * 60 + 50);
    expect(await minutesLeft()).toBeLessThan(15);

    expect((await agent.get("/api/auth/me")).status).toBe(200);

    expect(await minutesLeft()).toBeGreaterThan(8 * 60 - 2);
  });

  it("만료를 밀 때 쿠키 수명도 함께 민다", async () => {
    // DB만 밀고 쿠키를 그대로 두면, 브라우저가 원래 만료 시각에 쿠키를 버려
    // 사용자는 그대로 로그아웃된다 — 벽걸이 화면에는 그 차이가 보이지 않는다.
    const agent = await loginAgent();
    await idleFor(7 * 60 + 50);
    const res = await agent.get("/api/auth/me");
    const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith("sid="))).toBe(true);
    expect(setCookie!.find((c) => c.startsWith("sid="))).toMatch(/Max-Age=28800/);
  });

  it("아직 넉넉하면 만료를 건드리지 않는다 — 30초 폴링이 DB 쓰기가 되지 않는다", async () => {
    const agent = await loginAgent();
    const before = await minutesLeft();
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    // 밀지 않았으므로 남은 수명은 (시간이 흐른 만큼) 줄기만 하고, 쿠키도 다시 심지 않는다.
    expect(await minutesLeft()).toBeLessThanOrEqual(before);
    const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;
    expect(setCookie?.some((c) => c.startsWith("sid="))).toBeFalsy();
  });

  it("30초 폴링을 이어 가면 원래 12시간 벽을 넘어서도 살아 있다", async () => {
    // 월보드가 실제로 하는 일을 시간만 압축해 흉내 낸다: 만료가 다가올 때마다
    // 요청이 한 번 들어온다. 세 바퀴면 24시간을 넘긴다 — 예전 고정 TTL(12시간)로는
    // 두 번째 바퀴 전에 로그인 폼이 벽에 걸렸을 지점이다.
    const agent = await loginAgent();
    for (let i = 0; i < 3; i++) {
      await idleFor(7 * 60 + 55);
      expect((await agent.get("/api/auth/me")).status).toBe(200);
    }
    expect(await minutesLeft()).toBeGreaterThan(8 * 60 - 2);
  });

  it("활동이 끊긴 세션은 그대로 만료된다 — 무한 세션이 아니다", async () => {
    // 방치된 화면·도난당한 노트북은 죽어야 한다. 상한이 없다는 것과
    // 만료가 없다는 것은 다르다.
    const agent = await loginAgent();
    await idleFor(8 * 60 + 1);
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("이미 만료된 세션은 되살아나지 않는다", async () => {
    const agent = await loginAgent();
    await withService((q) => q.query("update auth_sessions set expires_at = now() - interval '1 second'"));
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    // 조회와 연장을 한 문장에서 하므로, 만료된 행을 먼저 밀어 놓고 뒤늦게
    // 401을 내는 순서가 될 수 없다.
    expect(await minutesLeft()).toBeLessThan(0);
  });
});
