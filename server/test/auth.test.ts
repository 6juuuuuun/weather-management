import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
import { MIN_PASSWORD } from "../src/auth/routes.ts";

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
    // 아래 "관리자가 미리 등록해 둔 직원 행에 가입하면..." 테스트가 고정 id로
    // 부서를 하나 심는다(on conflict do nothing이라 재실행에도 늘어나진 않지만,
    // 지우지 않으면 시드 소유가 아닌 이 행이 개발 DB에 영구히 남아 부서 개수를
    // 세는 다른 검증(Task 6 등)을 어긋나게 한다). 시드 16개는 이름이 겹치지
    // 않으니 이 delete가 그 행들을 건드릴 일은 없다.
    await q.query("delete from departments where id = $1", ["eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"]);
  });
});

// 비밀번호 최소 길이는 세 곳에 각각 하드코딩돼 있다(서버 auth/routes.ts,
// 웹 Signup.tsx, 웹 ChangePassword.tsx). 웹과 서버는 별개 npm 패키지라 상수를
// 공유할 자연스러운 통로가 없어서, 무리하게 구조를 만드는 대신 세 값이 어긋나면
// 실패하는 테스트로 묶는다. 실제로 예전에는 서버의 **가입 경로만** 그 값을 안 써서
// 1자 비밀번호로 가입하고 로그인까지 됐다.
describe("비밀번호 최소 길이", () => {
  it("서버와 화면 두 곳이 같은 값을 쓴다", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const web = join(here, "..", "..", "apps", "web", "src", "pages");
    const read = (f: string) => {
      const text = readFileSync(f, "utf8");
      const m = /MIN_PASSWORD\s*=\s*(\d+)/.exec(text);
      if (!m) throw new Error(`MIN_PASSWORD를 찾지 못했습니다: ${f}`);
      return Number(m[1]);
    };
    expect(read(join(web, "Signup.tsx"))).toBe(MIN_PASSWORD);
    expect(read(join(web, "ChangePassword.tsx"))).toBe(MIN_PASSWORD);
  });

  it("서버 가입 경로가 짧은 비밀번호를 거부한다 — 그 계정은 만들어지지 않는다", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "shorty@gonjiam.com", password: "1", name: "짧은이" });
    expect(res.status).toBe(400);
    // 브라우저를 거치지 않는 요청이라 화면의 10자 검사는 방벽이 아니다.
    // 계정이 실제로 안 만들어졌는지까지 본다 — 만들어졌다면 로그인이 200이 된다.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "shorty@gonjiam.com", password: "1" });
    expect(login.status).toBe(401);
    const n = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from auth_accounts where email = $1", [
        "shorty@gonjiam.com",
      ]);
      return rows[0].n as number;
    });
    expect(n).toBe(0);
  });

  it("정확히 최소 길이면 가입된다 (경계)", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "edge@gonjiam.com", password: "a".repeat(MIN_PASSWORD), name: "경계" });
    expect(res.status).toBe(201);
  });

  it("한 글자 모자라면 거부한다 (경계)", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "edge2@gonjiam.com", password: "a".repeat(MIN_PASSWORD - 1), name: "경계" });
    expect(res.status).toBe(400);
  });

  // 이 describe가 만든 직원 행은 여기서 치운다 — employees는 모든 테스트 파일이
  // 공유하는 작업 DB의 실제 명부라, 남겨 두면 개수를 세는 다른 검증이 어긋난다.
  afterAll(async () => {
    await withService((q) =>
      q.query("delete from employees where email in ('edge@gonjiam.com','edge2@gonjiam.com','shorty@gonjiam.com')"),
    );
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

  // 대소문자만 다른 이메일을 다른 계정으로 취급하면 같은 사람이 명부에 두 번
  // 올라가고, 부서 수신자 목록에도 중복으로 들어가 발송 대상이 어긋난다.
  it("이메일 대소문자만 다른 재가입도 거부한다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ ...SIGNUP, email: "HONG@Gonjiam.com" });
    expect(res.status).toBe(409);
  });

  // 관리자가 부서 배정을 위해 로그인 계정 없이 미리 만들어 둔 employees 행에
  // 본인이 나중에 가입해 계정을 이어 붙이는 흐름. role·부서·전화번호처럼
  // 가입자가 비워 둔 값은 기존 값이 살아 있어야 한다.
  it("관리자가 미리 등록해 둔 직원 행에 가입하면 기존 값을 덮어쓰지 않는다", async () => {
    const deptId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await withService(async (q) => {
      await q.query("insert into departments (id, name) values ($1, $2) on conflict (id) do nothing", [
        deptId,
        "테스트부서",
      ]);
      await q.query(
        `insert into employees (name, email, phone, department_id, role)
         values ($1, $2, $3, $4, $5)
         on conflict (email) do update
           set name = excluded.name, phone = excluded.phone,
               department_id = excluded.department_id, role = excluded.role`,
        ["기존기록", "yoon@gonjiam.com", "010-9999-9999", deptId, "approver"],
      );
    });

    const res = await request(app).post("/api/auth/signup").send({
      email: "yoon@gonjiam.com",
      password: "self-signup-pass-1",
      name: "윤가입", // 본인이 입력한 이름 — 관리자가 적어 둔 이름과 다르다
      // department_id, phone은 일부러 비워서 보낸다
    });
    expect(res.status).toBe(201);

    const row = await withService(async (q) => {
      const { rows } = await q.query(
        "select role, department_id, phone, auth_user_id, name from employees where email = $1",
        ["yoon@gonjiam.com"],
      );
      return rows[0];
    });
    const account = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email = $1", ["yoon@gonjiam.com"]);
      return rows[0];
    });

    expect(row.role).toBe("approver"); // 미리 부여된 역할이 유지된다
    expect(row.department_id).toBe(deptId); // 비워 보낸 부서는 기존 값이 남는다
    expect(row.phone).toBe("010-9999-9999"); // 비워 보낸 전화번호도 기존 값이 남는다
    expect(row.name).toBe("윤가입"); // 본인이 입력한 이름으로는 갱신된다
    expect(row.auth_user_id).toBe(account.id); // 새 계정에 이어 붙는다
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
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
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

  it("5회 실패하면 잠겨 더 이상 찍어 볼 수 없다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    // 잠금이 막는 것은 **틀린 비밀번호**다 — 그것이 잠금의 목적(찍어 맞히기 방지)이다.
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: "wrong-again" });
    expect(res.status).toBe(423);
  });

  // QA W-17(Critical) — 잠금이 **본인**을 막으면 그 잠금 자체가 공격 도구가 된다.
  // 이메일만 알면 15분마다 요청 5개로 승인권자를 무기한 로그인 불가 상태로 둘 수
  // 있었고, 관리자가 풀어 줘도 즉시 되돌아왔다. 폭설 새벽에 승인할 사람이 없어진다.
  it("잠겨 있어도 올바른 비밀번호는 통과하고 잠금이 풀린다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(res.status).toBe(200);

    // 잠금 상태가 실제로 지워져야 한다 — 다음 오타 한 번에 다시 잠기면 안 된다.
    const row = await withService(async (q) => {
      const { rows } = await q.query(
        "select failed_attempts, locked_until from auth_accounts where email = $1",
        [SIGNUP.email],
      );
      return rows[0];
    });
    expect(row.failed_attempts).toBe(0);
    expect(row.locked_until).toBeNull();
  });

  // 잠금 시간이 지난 뒤 실패 횟수를 이어서 올리면, 풀리자마자 한 번만 틀려도
  // failed_attempts(이미 5 이상) + 1 >= 5가 다시 참이 되어 계속 재잠금된다 —
  // 이메일만 알면 그 계정을 사실상 영원히 잠글 수 있다. 잠금 창이 지나면
  // 이전 실패는 잊고 1부터 다시 세야 한다.
  it("잠금이 풀린 뒤에는 한 번 틀려도 다시 잠기지 않고 올바른 비밀번호로 로그인된다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    await withService((q) =>
      q.query("update auth_accounts set locked_until = now() - interval '1 second' where email = $1", [
        SIGNUP.email,
      ]),
    );

    await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(res.status).toBe(200);
  });

  // locked_until은 Postgres 시계로 쓰인다(now() + interval). 만료 여부를 Node의
  // new Date()로 비교하면 두 시계가 어긋난 만큼 판정이 틀린다 — 개발 환경에서
  // 실제로 컨테이너 시계가 호스트보다 앞서 위 테스트가 조기에 423을 받은 적이 있다.
  // 여기서는 Node 시계만 5초 뒤로 돌려 그 드리프트를 재현한다. 만료 판정이 SQL
  // 안에 있으면(시계 도메인이 하나면) 이 조작에 영향받지 않아야 한다.
  it("잠금 만료 판정은 Node 프로세스 시계가 어긋나도 흔들리지 않는다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    await withService((q) =>
      q.query("update auth_accounts set locked_until = now() - interval '1 second' where email = $1", [
        SIGNUP.email,
      ]),
    );

    // Date만 가짜로 바꾼다 — 타이머까지 잡으면 supertest/pg의 I/O가 멈춘다.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      vi.setSystemTime(new Date(Date.now() - 5000));
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: SIGNUP.email, password: SIGNUP.password });
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
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

// 빈 ALLOWED_EMAIL_DOMAINS를 "전부 거부"로 해석하던 시절, 설정을 비워 둔 운영자는
// 아무도 가입할 수 없는 시스템을 받았다 — 게다가 화면에 나가는 문구가 "회사
// 이메일로만 가입할 수 있습니다"라, 원인이 설정 누락이라는 걸 알 방법이 없었다.
// 실제로 사내 도메인이 gonjiam.com이 아닌 곳에서 가입을 시도하다 발견했다.
describe("가입 허용 도메인", () => {
  const saved = process.env.ALLOWED_EMAIL_DOMAINS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = saved;
  });

  it("목록을 비워 두면 제한 없이 가입된다", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "";
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "nodomain@dnocorp.com", password: "a".repeat(MIN_PASSWORD), name: "무제한" });
    expect(res.status).toBe(201);
  });

  it("목록에 값이 있으면 그 도메인만 가입된다", async () => {
    process.env.ALLOWED_EMAIL_DOMAINS = "gonjiam.com";
    const ok = await request(app)
      .post("/api/auth/signup")
      .send({ email: "indomain@gonjiam.com", password: "a".repeat(MIN_PASSWORD), name: "허용" });
    expect(ok.status).toBe(201);

    const no = await request(app)
      .post("/api/auth/signup")
      .send({ email: "outdomain@other.com", password: "a".repeat(MIN_PASSWORD), name: "거부" });
    expect(no.status).toBe(400);
  });

  afterAll(async () => {
    await withService((q) =>
      q.query(
        "delete from employees where email in ('nodomain@dnocorp.com','indomain@gonjiam.com','outdomain@other.com')",
      ),
    );
  });
});

// 가입 화면은 로그인 전이라 /api/departments(orgRouter, requireAuth)를 부르면 401만
// 받는다. 그래서 부서 드롭다운이 영영 비어 있었고, 모두가 부서 없이 가입해
// requireDepartment가 지키는 화면들이 통째로 막혔다 — 실제 브라우저에서 재현했다.
describe("가입 화면용 공개 부서 목록", () => {
  it("로그인 없이도 부서를 내려준다", async () => {
    const res = await request(app).get("/api/public/departments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("id");
    expect(res.body[0]).toHaveProperty("name");
  });

  it("id와 이름 말고는 내보내지 않는다", async () => {
    const res = await request(app).get("/api/public/departments");
    expect(Object.keys(res.body[0]).sort()).toEqual(["id", "name"]);
  });

  // 인증이 걸린 원래 경로는 그대로여야 한다 — 공개 경로를 만들면서 조직도 전체가
  // 열려 버리면 고친 것보다 잃은 것이 크다.
  it("인증이 걸린 /api/departments는 여전히 로그인을 요구한다", async () => {
    const res = await request(app).get("/api/departments");
    expect(res.status).toBe(401);
  });
});

// 가입 본문에도 검증이 반쯤만 있었다: 이메일은 정규화·형식·도메인을 전부 보는데
// 이름은 trim조차 하지 않았고(QA W-30), department_id는 uuid 형식을 보지 않아
// 잘못된 값 하나에 500이 나갔다(QA W-24).
describe("가입 본문 검증 (W-24 · W-30)", () => {
  async function exists(email: string) {
    return withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from auth_accounts where email = $1", [email]);
      return rows[0].n as number;
    });
  }

  it("이름이 상한을 넘으면 400이고 계정도 만들어지지 않는다", async () => {
    const email = "signup-longname@gonjiam.com";
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "some-password-1", name: "가".repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/40자/);
    expect(await exists(email)).toBe(0);
  });

  it("이름의 앞뒤 공백은 지워서 저장한다", async () => {
    const email = "signup-trim@gonjiam.com";
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "some-password-1", name: "  홍길동  " });
    expect(res.status).toBe(201);
    const name = await withService(async (q) => {
      const { rows } = await q.query("select name from employees where email = $1", [email]);
      return rows[0].name as string;
    });
    expect(name).toBe("홍길동");
  });

  it("공백만 있는 이름은 400이다", async () => {
    const email = "signup-blank@gonjiam.com";
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "some-password-1", name: "   " });
    expect(res.status).toBe(400);
    expect(await exists(email)).toBe(0);
  });

  it("department_id가 uuid 형식이 아니면 500이 아니라 400이다", async () => {
    const email = "signup-baddept@gonjiam.com";
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "some-password-1", name: "부서오류", department_id: "garbage" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/department_id/);
    // 계정만 만들어지고 직원 행이 없는 반쪽 상태가 남으면 안 된다.
    expect(await exists(email)).toBe(0);
  });
});
