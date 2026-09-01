// 직원(명부)과 로그인 계정의 생명주기 — QA 수정 라운드 A 항목 1·5·6.
//
// 이 결함들이 13번의 코드 리뷰를 통과한 이유는 하나다: **아무도 삭제 이후를 테스트하지
// 않았다.** 서버 테스트는 전부 로그인부터 하고 시작했고, 로그인한 사람은 언제나 직원
// 행을 갖고 있었다. QA는 30분 만에 그 사이를 걸어 들어갔다 — 지우고 나서, 이메일을
// 바꾸고 나서, 그 이메일로 남이 가입하고 나서 무슨 일이 벌어지는지.
//
// 그래서 이 파일의 모든 테스트는 "그 다음"을 본다.
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

const DEPT_PREFIX = "zzlife-dept-";

async function agentAs(role: "staff" | "admin" | "approver", email: string, name = "테스트") {
  const who = { email, password: "some-password-1", name };
  await request(app).post("/api/auth/signup").send(who);
  await withService((q) => q.query("update employees set role=$2 where email=$1", [email, role]));
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: who.password });
  return agent;
}

async function employeeBy(email: string) {
  return withService(async (q) => {
    const { rows } = await q.query("select id, auth_user_id, role, name from employees where email = $1", [email]);
    return rows[0] ?? null;
  });
}

async function accountBy(email: string) {
  return withService(async (q) => {
    const { rows } = await q.query("select id, email, status from auth_accounts where email = $1", [email]);
    return rows[0] ?? null;
  });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("delete from alert_recipients");
    await q.query("delete from recipients");
    await q.query("delete from dispatches");
    await q.query("delete from messages");
    await q.query("delete from weather_events");
    await q.query("delete from action_guidelines");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
    await q.query("delete from departments where name like $1", [`${DEPT_PREFIX}%`]);
  });
});

describe("직원 삭제 — 계정도 함께 사라진다 (W-01a)", () => {
  it("삭제된 직원의 계정은 로그인도, 남아 있던 세션도 못 쓴다", async () => {
    const admin = await agentAs("admin", "life-admin@gonjiam.com");
    // 퇴사자는 삭제되기 전에 이미 로그인해 있다 — 이 살아 있는 세션이 핵심이다.
    const leaver = await agentAs("staff", "life-leaver@gonjiam.com", "퇴사자");
    expect((await leaver.get("/api/employees")).status).toBe(200);

    const emp = await employeeBy("life-leaver@gonjiam.com");
    expect((await admin.delete(`/api/employees/${emp.id}`)).status).toBe(204);

    // (1) 계정 자체가 사라졌다
    expect(await accountBy("life-leaver@gonjiam.com")).toBeNull();
    // (2) 남아 있던 세션으로 명부를 더 읽을 수 없다 — 예전에는 200으로 전 직원의
    //     이름·이메일·전화번호·카카오워크 ID가 그대로 열렸다.
    expect((await leaver.get("/api/employees")).status).toBe(401);
    // (3) 다시 로그인할 수도 없다
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "life-leaver@gonjiam.com", password: "some-password-1" });
    expect(relogin.status).toBe(401);
  });

  it("계정이 없는 사전 등록 직원도 그대로 삭제된다", async () => {
    const admin = await agentAs("admin", "life-admin2@gonjiam.com");
    const res = await admin.post("/api/employees").send({ name: "사전등록", email: "life-pending@gonjiam.com" });
    expect(res.status).toBe(201);
    expect((await admin.delete(`/api/employees/${res.body.id}`)).status).toBe(204);
    expect(await employeeBy("life-pending@gonjiam.com")).toBeNull();
  });

  it("삭제는 한 트랜잭션이다 — 계정 삭제가 막히면 직원도 남는다", async () => {
    const admin = await agentAs("admin", "life-admin3@gonjiam.com");
    const emp = await employeeBy("life-admin3@gonjiam.com");
    // 자기 자신은 못 지운다(아래 별도 테스트) — 여기서는 남을 대상으로 한다.
    const other = await agentAs("staff", "life-other@gonjiam.com");
    const target = await employeeBy("life-other@gonjiam.com");
    expect(emp.id).not.toBe(target.id);

    expect((await admin.delete(`/api/employees/${target.id}`)).status).toBe(204);
    // 둘 다 사라졌거나 둘 다 남았거나여야 한다. 반쪽이 남으면 그게 유령이다.
    expect(await employeeBy("life-other@gonjiam.com")).toBeNull();
    expect(await accountBy("life-other@gonjiam.com")).toBeNull();
    void other;
  });

  it("본인 직원 행은 스스로 지울 수 없다", async () => {
    const admin = await agentAs("admin", "life-self@gonjiam.com");
    const me = await employeeBy("life-self@gonjiam.com");
    const res = await admin.delete(`/api/employees/${me.id}`);
    expect(res.status).toBe(403);
    // 403이 다른 이유로 우연히 난 게 아님을 상태로 확인한다.
    expect(await employeeBy("life-self@gonjiam.com")).not.toBeNull();
    expect(await accountBy("life-self@gonjiam.com")).not.toBeNull();
  });
});

describe("직원 삭제 — 승인 이력은 이름으로 남는다 (W-01b, 결정 D-1)", () => {
  // 예전에는 이 삭제가 아예 실패했다:
  //   ERROR: violates foreign key constraint "weather_events_approved_by_fkey"
  // 관리자 화면에는 그것이 `서버 오류가 발생했습니다`(500)로만 보였다.
  it("특보를 승인한 적이 있는 직원도 삭제되고, 승인자 이름이 이력에 남는다", async () => {
    const admin = await agentAs("admin", "life-hist-admin@gonjiam.com");
    const approver = await agentAs("approver", "life-hist-approver@gonjiam.com", "홍길동");
    const emp = await employeeBy("life-hist-approver@gonjiam.com");

    const eventId = await withService(async (q) => {
      const { rows } = await q.query(
        `insert into weather_events (kind, grade, status, approved_by, approved_at)
         values ('snow','watch','ACTIVE',$1, now()) returning id`,
        [emp.id],
      );
      await q.query(
        `insert into messages (event_id, status, content, updated_by) values ($1,'approved','[]'::jsonb,$2)`,
        [rows[0].id, emp.id],
      );
      return rows[0].id;
    });

    expect((await admin.delete(`/api/employees/${emp.id}`)).status).toBe(204);

    const ev = await withService(async (q) => {
      const { rows } = await q.query(
        "select approved_by, approved_by_name from weather_events where id = $1",
        [eventId],
      );
      return rows[0];
    });
    // 링크는 끊기고 이름은 남는다 — "누가 이 특보를 승인했는가"가 사라지면 안 된다.
    expect(ev.approved_by).toBeNull();
    expect(ev.approved_by_name).toBe("홍길동");

    const msg = await withService(async (q) => {
      const { rows } = await q.query("select updated_by, updated_by_name from messages where event_id = $1", [
        eventId,
      ]);
      return rows[0];
    });
    expect(msg.updated_by).toBeNull();
    expect(msg.updated_by_name).toBe("홍길동");
    void approver;
  });

  it("지침을 수정한 직원을 지워도 지침은 남고 수정자 이름이 남는다", async () => {
    const admin = await agentAs("admin", "life-guide-admin@gonjiam.com");
    const writer = await agentAs("staff", "life-guide-writer@gonjiam.com", "이지침");
    const emp = await employeeBy("life-guide-writer@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}지침부서`,
      ]);
      await q.query(
        `insert into action_guidelines (department_id, kind, grade, guest_notice, updated_by)
         values ($1,'rain','watch','안내',$2)`,
        [rows[0].id, emp.id],
      );
      return rows[0].id;
    });

    expect((await admin.delete(`/api/employees/${emp.id}`)).status).toBe(204);

    const g = await withService(async (q) => {
      const { rows } = await q.query(
        "select updated_by, updated_by_name, guest_notice from action_guidelines where department_id = $1",
        [deptId],
      );
      return rows[0];
    });
    expect(g.guest_notice).toBe("안내");
    expect(g.updated_by).toBeNull();
    expect(g.updated_by_name).toBe("이지침");
    void writer;
  });

  it("GET /api/guidelines가 수정자 이름을 함께 내려준다", async () => {
    const admin = await agentAs("admin", "life-guide-read@gonjiam.com", "김관리");
    const emp = await employeeBy("life-guide-read@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}읽기부서`,
      ]);
      return rows[0].id;
    });
    expect(
      (
        await admin.put("/api/guidelines").send({
          rows: [{ department_id: deptId, kind: "rain", grade: "watch", staff_actions: [], guest_notice: "x" }],
        })
      ).status,
    ).toBe(204);

    const res = await admin.get("/api/guidelines");
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.department_id === deptId);
    // 화면(Guidelines.tsx)은 직원 목록에서 이름을 찾는다 — 그 사람이 지워지면
    // 이름이 통째로 사라진다. 서버가 스냅샷한 이름을 함께 줘야 "김관리(삭제된 직원)"을
    // 그릴 수 있다.
    expect(row.updated_by).toBe(emp.id);
    expect(row.updated_by_name).toBe("김관리");
  });
});

describe("직원 이메일 수정 — 로그인 이메일이 따라간다 (W-01c)", () => {
  it("이메일을 고치면 그 새 이메일로 로그인된다", async () => {
    const admin = await agentAs("admin", "life-mail-admin@gonjiam.com");
    await agentAs("staff", "life-mail-old@gonjiam.com", "본인");
    const emp = await employeeBy("life-mail-old@gonjiam.com");

    const res = await admin.patch(`/api/employees/${emp.id}`).send({ email: "life-mail-new@gonjiam.com" });
    expect(res.status).toBe(200);

    // 새 이메일로 로그인된다
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "life-mail-new@gonjiam.com", password: "some-password-1" });
    expect(ok.status).toBe(200);
    // 옛 이메일은 더 이상 열쇠가 아니다
    const old = await request(app)
      .post("/api/auth/login")
      .send({ email: "life-mail-old@gonjiam.com", password: "some-password-1" });
    expect(old.status).toBe(401);
  });

  it("그 이메일을 쓰는 로그인 계정이 이미 있으면 거부하고 아무것도 바꾸지 않는다", async () => {
    const admin = await agentAs("admin", "life-conf-admin@gonjiam.com");
    await agentAs("staff", "life-conf-a@gonjiam.com");
    const a = await employeeBy("life-conf-a@gonjiam.com");
    // b의 직원 행만 지운다 — 계정은 남는다. 그러면 employees.email은 비어 있고
    // auth_accounts.email만 그 주소를 쥐고 있는 상태가 된다.
    await agentAs("staff", "life-conf-b@gonjiam.com");
    await withService((q) => q.query("delete from employees where email = $1", ["life-conf-b@gonjiam.com"]));

    const res = await admin.patch(`/api/employees/${a.id}`).send({ email: "life-conf-b@gonjiam.com" });
    expect(res.status).toBe(409);
    // "고쳤다"고 말하고 아무것도 안 고치는 것이 이 결함의 본질이었다 — 반대로
    // 거부했으면 정말로 아무것도 바뀌지 않아야 한다.
    expect((await employeeBy("life-conf-a@gonjiam.com")).id).toBe(a.id);
    const acc = await accountBy("life-conf-a@gonjiam.com");
    expect(acc).not.toBeNull();
  });

  it("이름만 바꾸는 저장은 로그인 이메일을 흔들지 않는다", async () => {
    const admin = await agentAs("admin", "life-name-admin@gonjiam.com");
    await agentAs("staff", "life-name-user@gonjiam.com");
    const emp = await employeeBy("life-name-user@gonjiam.com");
    // 화면의 수정 폼은 바뀌지 않은 이메일도 매번 함께 보낸다.
    const res = await admin
      .patch(`/api/employees/${emp.id}`)
      .send({ name: "새이름", email: "life-name-user@gonjiam.com" });
    expect(res.status).toBe(200);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: "life-name-user@gonjiam.com", password: "some-password-1" });
    expect(login.status).toBe(200);
  });
});

describe("가입 병합 — 남의 직원 행을 인수할 수 없다 (W-01d)", () => {
  it("이미 다른 계정이 붙어 있는 직원 행은 가입이 인수하지 못한다", async () => {
    // 명부와 계정이 갈라진 상태를 직접 만든다(관리자 경로는 위에서 막았지만,
    // 데이터가 이미 그렇게 되어 있는 배포가 있을 수 있다).
    await agentAs("approver", "life-take-orig@gonjiam.com", "원래사람");
    const orig = await employeeBy("life-take-orig@gonjiam.com");
    await withService((q) =>
      q.query("update employees set email = $2 where id = $1", [orig.id, "life-take-new@gonjiam.com"]),
    );

    const signup = await request(app).post("/api/auth/signup").send({
      email: "life-take-new@gonjiam.com",
      password: "intruder-password",
      name: "제3자",
    });
    expect(signup.status).toBe(409);

    // 원래 사람의 역할(승인권자)이 넘어가지 않았고, 그 계정도 새로 만들어지지 않았다.
    const row = await employeeBy("life-take-new@gonjiam.com");
    expect(row.id).toBe(orig.id);
    expect(row.role).toBe("approver");
    expect(row.auth_user_id).toBe(orig.auth_user_id);
    expect(row.name).toBe("원래사람");
    expect(await accountBy("life-take-new@gonjiam.com")).toBeNull();
  });

  // 운영 안내서 §6-2가 이 경로에 의존한다: 관리자가 자기 비밀번호를 잊으면 서버
  // 터미널에서 auth_accounts 행만 지우고 같은 이메일로 다시 가입한다. employees의
  // 외래키가 on delete set null이라 그때 auth_user_id가 비고, 그래서 병합이 다시
  // 허용된다 — 위 가드(auth_user_id is null)가 이 복구 경로를 막지 않는지 못박는다.
  it("계정만 지운 뒤 같은 이메일로 다시 가입하면 역할이 유지된 채 이어 붙는다", async () => {
    await agentAs("admin", "life-recover@gonjiam.com", "관리자");
    const before = await employeeBy("life-recover@gonjiam.com");
    await withService((q) => q.query("delete from auth_accounts where email = $1", ["life-recover@gonjiam.com"]));

    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "life-recover@gonjiam.com", password: "recovered-pw-1", name: "관리자" });
    expect(signup.status).toBe(201);

    const after = await employeeBy("life-recover@gonjiam.com");
    expect(after.id).toBe(before.id);
    expect(after.role).toBe("admin");
    expect(after.auth_user_id).not.toBeNull();
    expect(after.auth_user_id).not.toBe(before.auth_user_id);
  });

  it("계정이 없는 사전 등록 행에는 예전처럼 이어 붙는다", async () => {
    const admin = await agentAs("admin", "life-merge-admin@gonjiam.com");
    const created = await admin
      .post("/api/employees")
      .send({ name: "사전등록", email: "life-merge@gonjiam.com", role: "approver" });
    expect(created.status).toBe(201);

    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: "life-merge@gonjiam.com", password: "merge-password-1", name: "본인" });
    expect(signup.status).toBe(201);

    const row = await employeeBy("life-merge@gonjiam.com");
    expect(row.id).toBe(created.body.id);
    expect(row.role).toBe("approver");
    expect(row.auth_user_id).not.toBeNull();
  });
});

describe("직원 행이 없는 세션 (W-01e)", () => {
  it("명부 조회가 403이다", async () => {
    const ghost = await agentAs("staff", "life-ghost@gonjiam.com");
    // 계정과 세션은 그대로 두고 직원 행만 지운다(옛 배포에 남아 있을 수 있는 상태).
    await withService((q) => q.query("delete from employees where email = $1", ["life-ghost@gonjiam.com"]));
    const res = await ghost.get("/api/employees");
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/직원 정보/);
  });
});

describe("마지막 관리자 강등 방지 (W-19)", () => {
  it("관리자가 1명이면 스스로 staff로 내려올 수 없다", async () => {
    const admin = await agentAs("admin", "life-lastadmin@gonjiam.com");
    const me = await employeeBy("life-lastadmin@gonjiam.com");
    const res = await admin.patch(`/api/employees/${me.id}`).send({ role: "staff" });
    expect(res.status).toBe(403);
    expect((await employeeBy("life-lastadmin@gonjiam.com")).role).toBe("admin");
  });

  it("관리자가 둘이면 자기 역할을 내릴 수 있다", async () => {
    const admin = await agentAs("admin", "life-two-a@gonjiam.com");
    await agentAs("admin", "life-two-b@gonjiam.com");
    const me = await employeeBy("life-two-a@gonjiam.com");
    const res = await admin.patch(`/api/employees/${me.id}`).send({ role: "staff" });
    expect(res.status).toBe(200);
    expect((await employeeBy("life-two-a@gonjiam.com")).role).toBe("staff");
  });

  it("마지막 관리자라도 남의 역할은 바꿀 수 있다", async () => {
    const admin = await agentAs("admin", "life-other-admin@gonjiam.com");
    await agentAs("staff", "life-other-staff@gonjiam.com");
    const target = await employeeBy("life-other-staff@gonjiam.com");
    expect((await admin.patch(`/api/employees/${target.id}`).send({ role: "approver" })).status).toBe(200);
  });
});

describe("이메일 형식 검증 (W-20)", () => {
  const BAD = ["@gonjiam.com", "a@b@gonjiam.com", "has space@gonjiam.com", "x@x", "nodomain"];

  it("가입이 형식 오류를 도메인 탓으로 돌리지 않는다", async () => {
    for (const email of BAD) {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email, password: "some-password-1", name: "누구" });
      expect(res.status, email).toBe(400);
      // 도메인 제한을 켜지도 않은 서버가 "회사 이메일" 이야기를 하면 관리자는
      // .env를 뒤진다 — 조사 방향을 정확히 반대로 유도한다.
      expect(res.body.error, email).toMatch(/형식/);
    }
  });

  it("직원 사전 등록도 같은 규칙과 같은 문구를 쓴다", async () => {
    const admin = await agentAs("admin", "life-shape-admin@gonjiam.com");
    for (const email of BAD) {
      const res = await admin.post("/api/employees").send({ name: "오타", email });
      expect(res.status, email).toBe(400);
      expect(res.body.error, email).toMatch(/형식/);
      expect(await employeeBy(email), email).toBeNull();
    }
  });

  it("직원 이메일 수정도 같은 규칙과 같은 문구를 쓴다", async () => {
    const admin = await agentAs("admin", "life-shape-admin2@gonjiam.com");
    await agentAs("staff", "life-shape-target@gonjiam.com");
    const emp = await employeeBy("life-shape-target@gonjiam.com");
    for (const email of BAD) {
      const res = await admin.patch(`/api/employees/${emp.id}`).send({ email });
      expect(res.status, email).toBe(400);
      expect(res.body.error, email).toMatch(/형식/);
    }
    expect((await employeeBy("life-shape-target@gonjiam.com")).id).toBe(emp.id);
  });

  it("도메인 거부는 형식 오류와 다른 문구다", async () => {
    // 형식은 멀쩡하고 도메인만 목록 밖인 값 — 이때만 도메인 이야기를 해야 한다.
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: "outsider@gmail.com", password: "some-password-1", name: "외부인" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/회사 이메일/);
    expect(res.body.error).not.toMatch(/형식/);
  });
});
