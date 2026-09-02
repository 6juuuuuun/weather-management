import { describe, expect, it, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import {
  EMAIL_IP_LIMIT,
  EMAIL_IP_WINDOW_SEC,
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
//
// 그리고 **둘이 동시에 켜져 있을 때 서로를 죽이지 않는지**를 본다(검증 라운드 E).
// 각각은 동작했는데 합치자 (1)의 429 관문이 (2)보다 앞에 있어 (2)를 무력화했다:
// 공격자가 승인권자 이메일로 10분마다 오입력 12회를 유지하면 **본인의 정답 로그인까지**
// 429가 됐고, 안내서가 알려 주는 관리자 복구(비활성화→활성화)는 메모리 버킷을 비우지
// 않아 듣지 않았다. 아래 "이메일 창은 출처별이다"·"관리자 복구" 두 묶음이 그 자리다.

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

async function correctLogin(email = USER.email, password = USER.password) {
  return request(app).post("/api/auth/login").send({ email, password });
}

/** 안내서 §6-3의 웹 복구 경로를 실제로 밟을 관리자. 이 파일의 정리 규칙에 맞는 이메일을 쓴다. */
const RL_ADMIN = { email: "ratelimit-admin@gonjiam.com", password: "admin-password-here", name: "복구관리자" };

async function adminAgent() {
  await request(app).post("/api/auth/signup").send(RL_ADMIN);
  await withService((q) => q.query("update employees set role='admin' where email=$1", [RL_ADMIN.email]));
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: RL_ADMIN.email, password: RL_ADMIN.password });
  return agent;
}

async function accountId(email: string): Promise<string> {
  return withService(async (q) => {
    const { rows } = await q.query("select id from auth_accounts where email = $1", [email]);
    return rows[0].id as string;
  });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null where email like $1", ["%ratelimit%"]);
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
    for (let i = 0; i < EMAIL_IP_LIMIT; i++) {
      const res = await wrongLogin();
      expect(res.status).not.toBe(429);
    }
    const blocked = await wrongLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/시도가 너무 많습니다/);
    expect(blocked.body.retry_after_sec).toBeGreaterThan(0);
    expect(blocked.body.retry_after_sec).toBeLessThanOrEqual(EMAIL_IP_WINDOW_SEC);
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
    for (let i = 0; i < EMAIL_IP_LIMIT + 2 && !sawTooMany; i++) {
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
    // 지워지지 않았다면 EMAIL_IP_LIMIT - 4번째에서 429가 났을 것이다.
    for (let i = 0; i < EMAIL_IP_LIMIT - 4; i++) {
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
    for (let i = 0; i < EMAIL_IP_LIMIT; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);

    // 창의 1초 전 — 아직 막힌다(경계를 양쪽에서 고정한다).
    now += (EMAIL_IP_WINDOW_SEC - 1) * 1000;
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);

    // 창을 넘기면 열린다.
    now += 2000;
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(false);
  });

  it("다른 이메일은 서로의 창을 채우지 않는다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < EMAIL_IP_LIMIT; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    // 같은 IP라 IP 창은 공유하지만, IP 상한이 더 크므로 아직 열려 있어야 한다.
    expect(rl.check({ email: "b@x", ip: "1.1.1.1" }).limited).toBe(false);
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);
  });

  it("IP 상한은 이메일 상한보다 커야 한다 — 아니면 이메일 규칙이 죽은 코드가 된다", () => {
    expect(IP_LIMIT).toBeGreaterThan(EMAIL_IP_LIMIT);
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

// ---------------------------------------------------------------------------
// 두 방어가 **동시에** 켜져 있을 때 — 검증 라운드 E 항목 1(PARTIAL)
// ---------------------------------------------------------------------------
//
// "잠겨 있어도 정답은 통과"(routes.ts)와 "속도 제한 429"(rateLimit.ts)는 각각 동작했다.
// 그런데 429 관문이 앞에 있어서, 공격자가 승인권자의 **이메일만 알고** 10분마다 오입력
// 12회를 유지하면 본인의 정답 로그인까지 429가 됐다 — W-17이 비용만 오른 채 살아 있었다.
// 그래서 여기서는 **둘을 함께 켜 놓고** 본다: 잠금과 속도 제한이 동시에 걸린 계정에
// 본인이 정답을 넣는 자리, 그리고 안내서가 알려 주는 관리자 복구가 실제로 듣는 자리.
describe("잠금과 속도 제한이 동시에 걸려 있을 때", () => {
  // 제3자의 실패는 **그 사람의 자리(IP)** 에 쌓인다. 승인권자가 자기 PC에서 넣는
  // 정답은 실패 0회짜리 자기 칸으로 들어오므로 429에 닿지 않는다.
  //
  // 이것만은 HTTP로 재현할 수 없다 — supertest는 언제나 루프백에서 접속하므로 출처를
  // 바꿀 수 없다. 그래서 관문이 보는 판정 자체를 직접 시험한다. HTTP 쪽은 아래
  // "관리자 복구" 테스트가 같은 상호작용을 끝까지 밟는다.
  it("다른 자리에서 온 실패 12회는 본인 자리의 로그인을 막지 못한다", () => {
    const rl = new LoginRateLimiter(() => 0);
    const victim = "approver@gonjiam.com";
    // 공격자가 승인권자의 이메일로 창을 가득 채운다(자동화로 사실상 공짜).
    for (let i = 0; i < EMAIL_IP_LIMIT * 3; i++) rl.record({ email: victim, ip: "10.0.0.66" });
    // 공격자 자리에서는 막힌다 — 비용은 그것을 만든 쪽이 낸다.
    expect(rl.check({ email: victim, ip: "10.0.0.66" }).limited).toBe(true);
    // 승인권자 자리에서는 열려 있다. 폭설 새벽에 승인해야 하는 사람이 이 사람이다.
    expect(rl.check({ email: victim, ip: "10.0.0.7" }).limited).toBe(false);
  });

  // 같은 자리에서 쏟아지는 자동화는 여전히 막아야 한다 — 키를 (이메일,IP)로 바꾼 것이
  // "속도 제한을 없앤 것"이 되면 안 된다.
  it("같은 자리에서 쏟아지는 실패는 그대로 막는다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < EMAIL_IP_LIMIT; i++) rl.record({ email: "a@x", ip: "1.1.1.1" });
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(true);
  });

  // 복구는 출처를 가리지 않고 그 이메일의 기록을 전부 지워야 한다. 한 자리만 지우면
  // 관리자가 풀어 준 뒤에도 다른 자리의 기록이 남아 같은 증상이 반복된다.
  it("복구는 출처를 가리지 않고 그 이메일의 기록을 지운다", () => {
    const rl = new LoginRateLimiter(() => 0);
    for (let i = 0; i < EMAIL_IP_LIMIT; i++) {
      rl.record({ email: "a@x", ip: "1.1.1.1" });
      rl.record({ email: "a@x", ip: "2.2.2.2" });
    }
    rl.clear("a@x");
    expect(rl.check({ email: "a@x", ip: "1.1.1.1" }).limited).toBe(false);
    expect(rl.check({ email: "a@x", ip: "2.2.2.2" }).limited).toBe(false);
  });

  // **안내서 §6-3이 약속하는 복구가 실제로 듣는가.** 예전에는 듣지 않았다: 관리자가
  // 비활성화→활성화를 눌러도 DB의 failed_attempts·locked_until만 지워지고 프로세스
  // 메모리의 속도 제한 버킷은 그대로라 그 사람은 **여전히 429**였다(검증 실측).
  // 유일한 실질 복구가 앱 재시작이었고, 그것은 문서에 없다.
  //
  // 이 테스트는 두 방어가 **동시에** 걸린 상태에서 시작한다:
  // 12회 오입력이면 계정 잠금(5회)도 속도 제한(12회)도 함께 걸려 있다.
  it("관리자의 비활성화→활성화가 잠금과 속도 제한을 함께 푼다", async () => {
    await signup();
    const admin = await adminAgent();
    const id = await accountId(USER.email);

    for (let i = 0; i < EMAIL_IP_LIMIT; i++) await wrongLogin();
    // 잠금과 속도 제한이 함께 걸린 상태 — 이 자리에서는 정답도 429다.
    expect((await correctLogin()).status).toBe(429);

    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "disabled" })).status).toBe(200);
    expect((await admin.patch(`/api/admin/users/${id}/status`).send({ status: "active" })).status).toBe(200);

    // 복구 뒤에는 곧바로 들어갈 수 있어야 한다. 10분을 기다리라는 답은 폭설 새벽에
    // 쓸 수 없고, 안내서는 그렇게 약속하지도 않았다.
    const after = await correctLogin();
    expect(after.status).toBe(200);
  });

  // 임시 비밀번호 발급도 §6-3이 알려 주는 복구다. 새 비밀번호를 손에 쥔 사람이 그것을
  // 넣지도 못하고 429를 만나면 발급 자체가 헛일이 된다.
  it("임시 비밀번호 발급도 속도 제한을 함께 푼다", async () => {
    await signup();
    const admin = await adminAgent();
    const id = await accountId(USER.email);

    for (let i = 0; i < EMAIL_IP_LIMIT; i++) await wrongLogin();
    expect((await correctLogin()).status).toBe(429);

    const issued = await admin.post(`/api/admin/users/${id}/reset-password`);
    expect(issued.status).toBe(200);
    const login = await correctLogin(USER.email, issued.body.temporary_password);
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(true);
  });
});
