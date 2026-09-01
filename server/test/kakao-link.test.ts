import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { linkKakaoworkUserId, relinkUnlinked, LOOKUP_TIMEOUT_MS } from "../src/kakaoLink.ts";
import { runKakaoLinkTick } from "../src/jobs/kakaoLinkTick.ts";

// 이 파일이 닫는 구멍: 이관된 시스템에는 employees.kakaowork_user_id를 채우는 경로가
// 하나도 없었다(매직링크 로그인이 하던 일이 폐기되면서 함께 사라졌다). 모든 알림
// 경로가 그 컬럼을 `is not null`로 거르기 때문에, 특보를 감지해도 승인 요청이
// 아무에게도 가지 않는 상태였다 — 그런데 화면·health·워치독이 전부 초록이었다.
//
// 실제 카카오워크로 나가지 않게 fetch를 갈아 끼운다(test/setup.ts가 봇 키를 비워
// 두므로, 여기서 필요한 동안만 값을 넣고 되돌린다).

/** users.find_by_email 응답을 흉내 낸다. 표에 없는 이메일은 success:false. */
function stubKakaoworkDirectory(byEmail: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const email = decodeURIComponent(String(url).split("email=")[1] ?? "");
      const id = byEmail[email];
      return Promise.resolve(
        new Response(JSON.stringify(id ? { success: true, user: { id } } : { success: false })),
      );
    }),
  );
}

const EMAILS = [
  "link-a@gonjiam.com",
  "link-b@gonjiam.com",
  "link-c@gonjiam.com",
  "link-admin@gonjiam.com",
  "link-new@gonjiam.com",
  "link-moved@gonjiam.com",
];

beforeEach(async () => {
  process.env.KAKAOWORK_BOT_KEY = "test-bot-key";
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null where email = any($1)", [EMAILS]);
    await q.query("delete from auth_accounts where email = any($1)", [EMAILS]);
    await q.query("delete from employees where email = any($1)", [EMAILS]);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  process.env.KAKAOWORK_BOT_KEY = "";
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null where email = any($1)", [EMAILS]);
    await q.query("delete from auth_accounts where email = any($1)", [EMAILS]);
    await q.query("delete from employees where email = any($1)", [EMAILS]);
  });
});

async function kakaoIdOf(email: string): Promise<string | null> {
  return withService(async (q) => {
    const { rows } = await q.query("select kakaowork_user_id from employees where email = $1", [email]);
    return (rows[0]?.kakaowork_user_id ?? null) as string | null;
  });
}

async function adminAgent() {
  const who = { email: "link-admin@gonjiam.com", password: "link-admin-password", name: "관리자" };
  await request(app).post("/api/auth/signup").send(who);
  await withService((q) => q.query("update employees set role='admin' where email=$1", [who.email]));
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

describe("카카오워크 연결 — 값이 채워진다", () => {
  it("가입하면 회사 이메일로 조회해 채운다 (옛 매직링크 로그인이 하던 일)", async () => {
    stubKakaoworkDirectory({ "link-a@gonjiam.com": "kw-A" });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "link-a@gonjiam.com", password: "signup-password-1", name: "가입자" });
    expect(res.status).toBe(201);
    expect(await kakaoIdOf("link-a@gonjiam.com")).toBe("kw-A");
  });

  it("관리자가 직원을 등록하면 그 자리에서 채우고 응답에도 실어 준다", async () => {
    stubKakaoworkDirectory({ "link-b@gonjiam.com": "kw-B", "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const res = await admin
      .post("/api/employees")
      .send({ name: "수신자B", email: "link-b@gonjiam.com", department_id: null, role: "staff" });
    expect(res.status).toBe(201);
    expect(res.body.kakaowork_user_id).toBe("kw-B");
    expect(await kakaoIdOf("link-b@gonjiam.com")).toBe("kw-B");
  });

  it("이메일을 고치면 새 이메일로 다시 조회한다 — 옛 id가 남으면 남의 계정으로 특보가 간다", async () => {
    stubKakaoworkDirectory({
      "link-b@gonjiam.com": "kw-B",
      "link-c@gonjiam.com": "kw-C",
      "link-admin@gonjiam.com": "kw-admin",
    });
    const admin = await adminAgent();
    const created = await admin
      .post("/api/employees")
      .send({ name: "수신자", email: "link-b@gonjiam.com", department_id: null, role: "staff" });
    const res = await admin.patch(`/api/employees/${created.body.id}`).send({ email: "link-c@gonjiam.com" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe("kw-C");
    expect(await kakaoIdOf("link-c@gonjiam.com")).toBe("kw-C");
  });

  // 하루 한 번 도는 재시도. 연결 실패의 흔한 원인들은 나중에 고쳐지므로
  // (봇 키를 늦게 넣음, 카카오워크 계정이 늦게 만들어짐, 이메일 오타 수정)
  // 가입 시점 한 번만 시도하면 그 사람들은 영원히 미연결로 남는다.
  it("미연결 직원을 나중에 다시 조회해 채운다", async () => {
    await withService((q) =>
      q.query(
        `insert into employees (name, email) values ('나중에', 'link-a@gonjiam.com'), ('영영', 'link-b@gonjiam.com')`,
      ),
    );
    stubKakaoworkDirectory({ "link-a@gonjiam.com": "kw-A" }); // b는 아직 카카오워크에 없다
    const out = await relinkUnlinked({ limit: 100 });
    expect(out.linked).toBeGreaterThanOrEqual(1);
    expect(await kakaoIdOf("link-a@gonjiam.com")).toBe("kw-A");
    expect(await kakaoIdOf("link-b@gonjiam.com")).toBe(null);
  });

  it("재시도 작업은 heartbeat을 남긴다 — 돌고 있는지 확인할 수 있어야 한다", async () => {
    stubKakaoworkDirectory({});
    await runKakaoLinkTick();
    const beat = await withService(async (q) => {
      const { rows } = await q.query("select ok from heartbeats where name = 'kakao-link'");
      return rows[0];
    });
    expect(beat?.ok).toBe(true);
    await withService((q) => q.query("delete from heartbeats where name = 'kakao-link'"));
  });
});

// 재리뷰 N-1. 이 라운드가 만든 결함이고, 방향이 나머지와 반대다: 다른 항목들은
// "알림이 안 간다"였는데 이건 **알림이 엉뚱한 사람에게 간다**.
//
// 이메일을 바꾸면 새 이메일로 다시 조회하는데, 조회가 실패하면 예전에는 행을 그대로
// 뒀다 — 옛 이메일로 얻은 id가 남는다. 인사이동으로 이메일이 넘어간 경우라면 그
// 직원의 특보 DM이 옛 주인의 카카오워크 계정으로 간다. 하루 한 번 도는 재시도는
// kakaowork_user_id가 null인 행만 보므로 이 상태를 영원히 고치지 못한다.
//
// 성공 갈래만 테스트하던 자리다(위 "이메일을 고치면 새 이메일로 다시 조회한다"가
// 바로 이 위험을 이름으로 달고 있으면서 실패 갈래를 덮지 않았다). 여기서 덮는다.
describe("이메일이 바뀌었는데 재조회가 실패하면 옛 연결을 지운다", () => {
  /** 옛 이메일(link-b)로 연결된 직원을 하나 만든다. */
  async function linkedEmployee() {
    stubKakaoworkDirectory({ "link-b@gonjiam.com": "kw-OLD-PERSON", "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const created = await admin
      .post("/api/employees")
      .send({ name: "이동자", email: "link-b@gonjiam.com", department_id: null, role: "staff" });
    expect(created.body.kakaowork_user_id).toBe("kw-OLD-PERSON");
    return { admin, id: created.body.id as string };
  }

  it("새 이메일의 카카오워크 계정이 없으면 옛 id가 남지 않는다", async () => {
    const { admin, id } = await linkedEmployee();
    // 새 이메일은 카카오워크 명부에 없다.
    stubKakaoworkDirectory({ "link-b@gonjiam.com": "kw-OLD-PERSON" });
    const res = await admin.patch(`/api/employees/${id}`).send({ email: "link-moved@gonjiam.com" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe(null);
    expect(await kakaoIdOf("link-moved@gonjiam.com")).toBe(null);
  });

  it("조회가 네트워크 오류로 터져도 옛 id가 남지 않는다", async () => {
    const { admin, id } = await linkedEmployee();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNRESET"))));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await admin.patch(`/api/employees/${id}`).send({ email: "link-moved@gonjiam.com" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe(null);
    expect(await kakaoIdOf("link-moved@gonjiam.com")).toBe(null);
    err.mockRestore();
  });

  it("봇 키가 없어도 옛 id가 남지 않는다", async () => {
    const { admin, id } = await linkedEmployee();
    process.env.KAKAOWORK_BOT_KEY = "";
    const res = await admin.patch(`/api/employees/${id}`).send({ email: "link-moved@gonjiam.com" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe(null);
  });

  // 화면의 수정 폼은 바뀌지 않은 이메일도 매번 함께 보낸다. 그때까지 다시 조회하면
  // 무관한 저장 한 번마다 연결이 흔들리고, 관리자가 손으로 넣은 값이 조용히 지워진다.
  it("이메일이 그대로면 연결을 건드리지 않는다", async () => {
    const { admin, id } = await linkedEmployee();
    stubKakaoworkDirectory({}); // 지금 조회하면 반드시 실패한다
    const res = await admin.patch(`/api/employees/${id}`).send({ email: "link-b@gonjiam.com", name: "이름만 수정" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe("kw-OLD-PERSON");
    expect(res.body.name).toBe("이름만 수정");
  });

  // 관리자가 같은 요청에서 값을 직접 지정했다면 그것이 이긴다(수동 교정 경로).
  it("이메일과 kakaowork_user_id를 함께 보내면 관리자가 지정한 값이 남는다", async () => {
    const { admin, id } = await linkedEmployee();
    stubKakaoworkDirectory({});
    const res = await admin
      .patch(`/api/employees/${id}`)
      .send({ email: "link-moved@gonjiam.com", kakaowork_user_id: "kw-MANUAL" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe("kw-MANUAL");
  });
});

// 알림 연결이 안 됐다고 사람이 시스템에 못 들어오게 만들면 안 된다.
describe("카카오워크 연결 실패가 가입·등록을 막지 않는다", () => {
  it("봇 키가 없어도 가입은 성공한다 (값만 비어 있다)", async () => {
    process.env.KAKAOWORK_BOT_KEY = "";
    stubKakaoworkDirectory({ "link-a@gonjiam.com": "kw-A" });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "link-a@gonjiam.com", password: "signup-password-1", name: "가입자" });
    expect(res.status).toBe(201);
    expect(await kakaoIdOf("link-a@gonjiam.com")).toBe(null);
    // 봇 키가 없으면 조회를 시도조차 하지 않는다.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("조회가 네트워크 오류로 터져도 가입은 성공한다", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("ECONNRESET"))));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "link-a@gonjiam.com", password: "signup-password-1", name: "가입자" });
    expect(res.status).toBe(201);
    expect(await kakaoIdOf("link-a@gonjiam.com")).toBe(null);
    err.mockRestore();
  });

  it("카카오워크에 그 이메일이 없어도 직원 등록은 성공한다", async () => {
    stubKakaoworkDirectory({ "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const res = await admin
      .post("/api/employees")
      .send({ name: "미연결자", email: "link-new@gonjiam.com", department_id: null, role: "staff" });
    expect(res.status).toBe(201);
    expect(res.body.kakaowork_user_id).toBe(null);
  });

  it("linkKakaoworkUserId는 어떤 경우에도 던지지 않는다", async () => {
    await expect(
      linkKakaoworkUserId("link-a@gonjiam.com", {
        botKey: "k",
        resolve: () => Promise.reject(new Error("boom")),
      }),
    ).resolves.toEqual({ linked: null, reason: "error" });
  });
});

// 재리뷰 N-2. 이 조회는 가입·직원등록 요청 안에서 동기적으로 일어난다. 상대가 응답을
// 아예 주지 않으면(방화벽이 패킷을 버리는 사내망에서 실제로 그렇다) 제한이 없는 fetch는
// 하염없이 기다리고, 그동안 가입 화면이 멈춘 것처럼 보인다. shared/kakaowork.ts는
// 바이트 동일성 때문에 못 고치므로 그 함수가 받아 주는 fetchFn 자리에서 묶는다.
describe("조회에 시간 제한이 걸려 있다", () => {
  it("응답이 오지 않으면 스스로 끊고 실패로 돌려준다", async () => {
    // 시그널이 오면 그때 끊고, 시그널이 없으면 **영원히 매달린다** — 제한이 사라지면
    // 이 테스트는 통과가 아니라 타임아웃으로 죽는다(변이로 확인함).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      ),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // 제한이 없으면 이 호출은 영영 끝나지 않는다. 그때 스위트를 통째로 매달아 두는
    // 대신, 감시 타이머와 경주시켜 **깔끔한 실패**로 만든다.
    const HUNG = Symbol("hung");
    const out = await Promise.race([
      linkKakaoworkUserId("link-a@gonjiam.com", { botKey: "k", timeoutMs: 60 }),
      new Promise((resolve) => setTimeout(() => resolve(HUNG), 1500)),
    ]);
    expect(out).not.toBe(HUNG); // 스스로 끊지 못하면 여기서 잡힌다
    expect(out).toEqual({ linked: null, reason: "error" });
    err.mockRestore();
  });

  it("기본 제한이 사람이 기다릴 만한 값으로 정해져 있다", () => {
    expect(LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

// 조회가 실패하는 경우가 실제로 있다(카카오워크 계정 이메일이 회사 이메일과 다름 등).
// 그때 관리자가 손으로 넣을 길이 없으면 그 사람은 영원히 특보를 못 받는다.
describe("관리자의 수동 교정", () => {
  async function targetId(admin: request.Agent) {
    const res = await admin
      .post("/api/employees")
      .send({ name: "대상", email: "link-b@gonjiam.com", department_id: null, role: "staff" });
    return res.body.id as string;
  }

  it("PATCH /employees로 kakaowork_user_id를 넣을 수 있다 (예전에는 400이었다)", async () => {
    stubKakaoworkDirectory({ "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const id = await targetId(admin);
    const res = await admin.patch(`/api/employees/${id}`).send({ kakaowork_user_id: "kw-manual" });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe("kw-manual");
    expect(await kakaoIdOf("link-b@gonjiam.com")).toBe("kw-manual");
  });

  // 공백만 든 값이 들어가면 is not null 필터를 통과해 발송이 카카오워크 API 오류로 실패한다.
  it("빈 값을 보내면 연결을 지운다", async () => {
    stubKakaoworkDirectory({ "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const id = await targetId(admin);
    await admin.patch(`/api/employees/${id}`).send({ kakaowork_user_id: "kw-manual" });
    const res = await admin.patch(`/api/employees/${id}`).send({ kakaowork_user_id: "   " });
    expect(res.status).toBe(200);
    expect(res.body.kakaowork_user_id).toBe(null);
  });

  it("문자열도 null도 아니면 400이다", async () => {
    stubKakaoworkDirectory({ "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const id = await targetId(admin);
    expect((await admin.patch(`/api/employees/${id}`).send({ kakaowork_user_id: 123 })).status).toBe(400);
  });

  it("일반 직원은 남의 연결을 바꿀 수 없다", async () => {
    stubKakaoworkDirectory({ "link-admin@gonjiam.com": "kw-admin" });
    const admin = await adminAgent();
    const id = await targetId(admin);
    await request(app)
      .post("/api/auth/signup")
      .send({ email: "link-c@gonjiam.com", password: "staff-password-1", name: "직원" });
    const staff = request.agent(app);
    await staff.post("/api/auth/login").send({ email: "link-c@gonjiam.com", password: "staff-password-1" });
    expect((await staff.patch(`/api/employees/${id}`).send({ kakaowork_user_id: "kw-x" })).status).toBe(403);
  });
});
