import { describe, expect, it, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import {
  EMAIL_LIMIT,
  EMAIL_WINDOW_SEC,
  IP_LIMIT,
  LoginRateLimiter,
  loginRateLimiter,
} from "../src/auth/rateLimit.ts";

// QA W-17 (Critical) — **로그인 시도에 값이 없었다.**
//
// 검증 실측: 30회 연속 로그인 시도가 전부 통과(속도 제한 0건), 잠금 해제 직후 즉시
// 재잠금. 즉 승인권자의 이메일만 알면 15분마다 요청 5개로 그 사람을 무기한 로그인
// 불가 상태로 둘 수 있었고, 관리자가 풀어 줘도 곧바로 되돌아왔다 — 폭설 새벽에
// 특보를 승인할 사람이 아무도 없게 된다.
//
// 이전 라운드의 판단("보이게 만드는 것이 목적, 잠금 정책 변경은 범위 밖")이 틀렸다:
// **피해가 '값이 싸다'에서 나올 때 보이게 만드는 것은 값을 올리지 못한다.**
//
// 이 파일은 두 방어를 함께 못박는다.
//  (1) 속도 제한 — 자동화된 반복이 사람의 오타와 다른 값을 치른다.
//  (2) 잠긴 계정이라도 **올바른 비밀번호는 통과한다** — 잠금이 본인을 막지 못하게 한다.
//      (2)의 로그인 경로 검증은 auth.test.ts에 있고, 여기서는 (1)이 (2)의 비용을
//      실제로 묶는지를 본다.

const USER = {
  email: "ratelimit@gonjiam.com",
  password: "correct-horse-battery",
  name: "속도제한",
};

async function signup() {
  await request(app).post("/api/auth/signup").send(USER);
}

async function wrongLogin(email = USER.email) {
  return request(app).post("/api/auth/login").send({ email, password: "definitely-wrong" });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null where email = $1", [USER.email]);
    await q.query("delete from auth_accounts where email like $1", ["%ratelimit%"]);
  });
  // 전역 setup이 이미 비우지만, 이 파일은 그 사실 자체에 기대므로 명시한다.
  loginRateLimiter.reset();
});

afterAll(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_accounts where email like $1", ["%ratelimit%"]);
    await q.query("delete from employees where email like $1", ["%ratelimit%"]);
  });
});

describe("로그인 속도 제한 — HTTP 경로", () => {
  it("한 이메일에 실패가 쌓이면 429로 막고 다시 시도할 시각을 알려 준다", async () => {
    await signup();
    // 상한까지는 통과한다(잠금은 그 전에 걸리므로 423이 섞인다 — 둘 다 429는 아니다).
    for (let i = 0; i < EMAIL_LIMIT; i++) {
      const res = await wrongLogin();
      expect(res.status).not.toBe(429);
    }
    const blocked = await wrongLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/시도가 너무 많습니다/);
    expect(blocked.body.retry_after_sec).toBeGreaterThan(0);
    expect(blocked.body.retry_after_sec).toBeLessThanOrEqual(EMAIL_WINDOW_SEC);
    expect(blocked.headers["retry-after"]).toBe(String(blocked.body.retry_after_sec));
  });

  // 잠긴 계정을 계속 두드리는 것이 **완전히 공짜였다.** 423만 돌려주고 아무 흔적도
  // 남지 않아, 잠금이 풀리는 시각에 맞춰 두드리는 공격에 비용이 0이었다.
  it("잠긴 계정을 두드리는 것도 값을 치른다", async () => {
    await signup();
    // 5회로 잠근다.
    for (let i = 0; i < 5; i++) await wrongLogin();
    const locked = await wrongLogin();
    expect(locked.status).toBe(423); // 잠긴 상태 확인

    // 잠긴 뒤의 두드림도 창을 채운다 — 결국 429에 닿아야 한다.
    let sawTooMany = false;
    for (let i = 0; i < EMAIL_LIMIT + 2 && !sawTooMany; i++) {
      const res = await wrongLogin();
      if (res.status === 429) sawTooMany = true;
    }
    expect(sawTooMany).toBe(true);
  });

  // 없는 계정으로 이메일을 바꿔 가며 두드리는 쪽(검증: 이메일 30개, 1초). 이메일별
  // 창은 하나도 차지 않으므로 IP 창이 아니면 아무것도 막지 못한다.
  it("이메일을 바꿔 가며 두드리면 IP 단위로 막힌다", async () => {
    let blocked = 0;
    for (let i = 0; i < IP_LIMIT + 5; i++) {
      const res = await wrongLogin(`ratelimit-sweep-${i}@gonjiam.com`);
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0);
  });

  // 정상 사용자가 오타 몇 번 낸 뒤 제대로 치는 것이 막히면 안 된다. 오타 3회는
  // 사람이 실제로 하는 일이고, 그것으로 429가 나면 이 기능은 공격이 아니라
  // 사용자를 막는 장치가 된다.
  it("오타 3회 뒤 올바른 비밀번호는 그대로 통과한다", async () => {
    await signup();
    for (let i = 0; i < 3; i++) expect((await wrongLogin()).status).toBe(401);
    const ok = await request(app).post("/api/auth/login").send({ email: USER.email, password: USER.password });
    expect(ok.status).toBe(200);
  });

  // 성공했으면 그 사람은 공격자가 아니다. 창을 비우지 않으면 하루에 오타를 몇 번씩
  // 내는 정상 사용자가 스스로를 429로 묶는다.
  it("로그인에 성공하면 그 이메일의 실패 기록이 지워진다", async () => {
    await signup();
    for (let i = 0; i < 4; i++) await wrongLogin();
    expect(
      (await request(app).post("/api/auth/login").send({ email: USER.email, password: USER.password })).status,
    ).toBe(200);
    // 지워지지 않았다면 EMAIL_LIMIT - 4번째에서 429가 났을 것이다.
    for (let i = 0; i < EMAIL_LIMIT - 4; i++) {
      expect((await wrongLogin()).status).not.toBe(429);
    }
  });
});

// 창(窓)이 실제로 시간에 따라 열리는지는 HTTP로는 확인할 수 없다(10분을 기다릴 수
// 없다). 시계를 갈아 끼울 수 있는 클래스 자체를 직접 시험한다.
describe("LoginRateLimiter — 창의 경계", () => {
  it("창을 벗어난 실패는 잊는다", () => {
    let now = 1_000_000;
    const rl = new LoginRateLimiter(() => now);
    for (let i = 0; i < EMAIL_LIMIT; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);

    // 창의 1초 전 — 아직 막힌다(경계를 양쪽에서 고정한다).
    now += (EMAIL_WINDOW_SEC - 1) * 1000;
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);

    // 창을 넘기면 열린다.
    now += 2000;
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(false);
  });

  it("다른 이메일은 서로의 창을 채우지 않는다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < EMAIL_LIMIT; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    // 같은 IP라 IP 창은 공유하지만, IP 상한이 더 크므로 아직 열려 있어야 한다.
    expect(rl.check({ email: "b@x", ip: "1.1.1.1" }).limited).toBe(false);
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);
  });

  it("IP 상한은 이메일 상한보다 커야 한다 — 아니면 이메일 규칙이 죽은 코드가 된다", () => {
    expect(IP_LIMIT).toBeGreaterThan(EMAIL_LIMIT);
  });

  it("사람의 오타 범위(5회)는 어느 쪽 상한에도 닿지 않는다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < 5; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(false);
  });

  it("성공하면 그 이메일만 지우고 IP 기록은 남긴다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < IP_LIMIT; i++) rl.record({ email: `x${i}@x`, ip: "1.1.1.1" });
    rl.clear("x0@x");
    // 한 사람이 성공했다고 그 IP의 대량 시도 기록까지 지워지면, 공격자는 자기
    // 계정으로 한 번 로그인하는 것만으로 창을 비울 수 있다.
    expect(rl.check({ email: "x0@x", ip: "1.1.1.1" }).limited).toBe(true);
  });
});
