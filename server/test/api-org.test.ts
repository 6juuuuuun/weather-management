import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function agentAs(role: "staff" | "admin" | "approver", email: string) {
  const who = { email, password: "some-password-1", name: "테스트" };
  await request(app).post("/api/auth/signup").send(who);
  await withService(async (q) => {
    await q.query("update employees set role=$2 where email=$1", [email, role]);
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: who.password });
  return agent;
}

// 부서는 db/seed.sql이 4루트+12자식(총 16개)을 심어 둔다. beforeEach가
// departments를 통째로 지우면 재시딩 전까지 실 화면에 부서가 하나도 안 보이는
// 상태가 된다(과거 Task 5가 weather_criteria에서 겪은 것과 같은 문제) — 테스트가
// 만든 행만 이 접두사로 골라 지운다. 시드 부서 이름(사업지원·리조트·객실 등)과는
// 절대 겹치지 않는다.
const DEPT_PREFIX = "zztest-dept-";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("delete from alert_recipients");
    await q.query("delete from recipients");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    // employees·recipients·alert_recipients·auth_*는 seed.sql이 아무 행도 넣지
    // 않는다 — 통째로 지워도 시드를 건드리지 않는다.
    await q.query("delete from employees");
    await q.query("delete from departments where name like $1", [`${DEPT_PREFIX}%`]);
  });
});

describe("부서", () => {
  it("목록을 이름순으로 돌려주고, 시드 부서도 함께 내려온다", async () => {
    await withService((q) =>
      q.query(`insert into departments (name) values ('${DEPT_PREFIX}시설'),('${DEPT_PREFIX}객실')`),
    );
    const agent = await agentAs("staff", "a@gonjiam.com");
    const res = await agent.get("/api/departments");
    expect(res.status).toBe(200);
    // 시드 트리(16개)를 지우지 않았으니 그보다 많아야 한다 — 여기가 비어 있으면
    // "이름 필터 없이 전체를 조회한다"는 동작이 깨진 것이다.
    expect(res.body.length).toBeGreaterThanOrEqual(18);
    const names: string[] = res.body.map((d: any) => d.name);
    // order by name이 실제로 걸려 있는지: DB collation(en_US.utf8)로 직접 정렬한
    // 결과와 API 응답 전체를 통째로 비교한다. JS 쪽에서 별도 정렬 기준(로케일 등)을
    // 흉내 내면 collation 차이로 오탐이 나므로, 같은 DB에 같은 order by를 걸어
    // 비교 기준 자체를 만든다 — order by를 지우면(삽입 순서 그대로 나오면) 깨진다.
    const expected = await withService(async (q) => {
      const { rows } = await q.query("select name from departments order by name");
      return rows.map((r: any) => r.name);
    });
    expect(names).toEqual(expected);
    // 삽입 순서(시설, 객실)가 아니라 실제로 정렬돼 나왔는지도 별도로 확인한다.
    expect(names.indexOf(`${DEPT_PREFIX}객실`)).toBeLessThan(names.indexOf(`${DEPT_PREFIX}시설`));
  });

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/departments")).status).toBe(401);
  });

  it("일반 직원은 부서를 만들 수 없다", async () => {
    const agent = await agentAs("staff", "b@gonjiam.com");
    const res = await agent.post("/api/departments").send({ name: `${DEPT_PREFIX}신규` });
    expect(res.status).toBe(403);
    // 403이 role 게이트가 아니라 다른 이유(예: 이름 검증)로 우연히 난 게 아님을
    // 확인한다 — 실제로 행이 생기지 않았어야 한다.
    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from departments where name = $1", [
        `${DEPT_PREFIX}신규`,
      ]);
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  it("관리자는 부서를 만들 수 있다", async () => {
    const agent = await agentAs("admin", "c@gonjiam.com");
    const res = await agent.post("/api/departments").send({ name: `${DEPT_PREFIX}신규` });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${DEPT_PREFIX}신규`);
  });

  it("이름이 비어 있으면 400이다", async () => {
    const agent = await agentAs("admin", "c2@gonjiam.com");
    expect((await agent.post("/api/departments").send({ name: "  " })).status).toBe(400);
  });

  it("관리자는 부서 이름을 바꿀 수 있고, 일반 직원은 바꿀 수 없다", async () => {
    const id = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}구명`,
      ]);
      return rows[0].id;
    });

    const staff = await agentAs("staff", "d@gonjiam.com");
    const denied = await staff.patch(`/api/departments/${id}`).send({ name: `${DEPT_PREFIX}가로챔` });
    expect(denied.status).toBe(403);

    const admin = await agentAs("admin", "e@gonjiam.com");
    const ok = await admin.patch(`/api/departments/${id}`).send({ name: `${DEPT_PREFIX}새이름` });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe(`${DEPT_PREFIX}새이름`);

    // DB에도 실제로 반영됐는지 — 200만 보고 실제 update가 빠진 핸들러를 놓치지 않는다.
    const name = await withService(async (q) => {
      const { rows } = await q.query("select name from departments where id = $1", [id]);
      return rows[0].name;
    });
    expect(name).toBe(`${DEPT_PREFIX}새이름`);
  });

  it("없는 부서를 수정하면 404다", async () => {
    const admin = await agentAs("admin", "f@gonjiam.com");
    const res = await admin.patch("/api/departments/00000000-0000-0000-0000-000000000000").send({
      name: `${DEPT_PREFIX}유령`,
    });
    expect(res.status).toBe(404);
  });

  // Employees.tsx/Guidelines.tsx/DeptModal.tsx가 부서 트리(상위·하위)를 그리는 데
  // parent_id/sort_order가 필요하다 — 컬럼은 있는데 예전에는 select에서 빠져 있었다.
  it("목록 조회가 parent_id·sort_order도 함께 돌려준다", async () => {
    const parentId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into departments (name, sort_order) values ($1, 3) returning id",
        [`${DEPT_PREFIX}상위`],
      );
      return rows[0].id;
    });
    const childId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into departments (name, parent_id, sort_order) values ($1, $2, 1) returning id",
        [`${DEPT_PREFIX}하위`, parentId],
      );
      return rows[0].id;
    });

    const agent = await agentAs("staff", "dept-tree-staff@gonjiam.com");
    const res = await agent.get("/api/departments");
    expect(res.status).toBe(200);
    const parentRow = res.body.find((d: any) => d.id === parentId);
    const childRow = res.body.find((d: any) => d.id === childId);
    expect(parentRow).toEqual(
      expect.objectContaining({ id: parentId, name: `${DEPT_PREFIX}상위`, parent_id: null, sort_order: 3 }),
    );
    expect(childRow).toEqual(
      expect.objectContaining({ id: childId, name: `${DEPT_PREFIX}하위`, parent_id: parentId, sort_order: 1 }),
    );
  });

  it("관리자는 parent_id를 지정해 하위 부서를 만들 수 있다", async () => {
    const admin = await agentAs("admin", "dept-child-admin@gonjiam.com");
    const parentId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}부모`,
      ]);
      return rows[0].id;
    });

    const res = await admin.post("/api/departments").send({
      name: `${DEPT_PREFIX}자식`,
      parent_id: parentId,
      sort_order: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ name: `${DEPT_PREFIX}자식`, parent_id: parentId, sort_order: 2 }),
    );

    const row = await withService(async (q) => {
      const { rows } = await q.query("select parent_id, sort_order from departments where id = $1", [
        res.body.id,
      ]);
      return rows[0];
    });
    expect(row.parent_id).toBe(parentId);
    expect(row.sort_order).toBe(2);
  });

  it("parent_id 형식이 잘못되면 400이고, 실존하지 않는 parent_id면 400이다", async () => {
    const admin = await agentAs("admin", "dept-badparent-admin@gonjiam.com");
    const bad = await admin.post("/api/departments").send({ name: `${DEPT_PREFIX}나쁜형식`, parent_id: "nope" });
    expect(bad.status).toBe(400);

    const ghost = await admin.post("/api/departments").send({
      name: `${DEPT_PREFIX}유령부모`,
      parent_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(ghost.status).toBe(400);

    const count = await withService(async (q) => {
      const { rows } = await q.query(
        "select count(*)::int as n from departments where name in ($1, $2)",
        [`${DEPT_PREFIX}나쁜형식`, `${DEPT_PREFIX}유령부모`],
      );
      return rows[0].n;
    });
    expect(count).toBe(0);
  });

  it("관리자는 부서를 삭제할 수 있고, 일반 직원은 삭제할 수 없다", async () => {
    const [keepId, deleteTargetId] = await withService(async (q) => {
      const { rows } = await q.query(
        `insert into departments (name) values ($1),($2) returning id`,
        [`${DEPT_PREFIX}유지`, `${DEPT_PREFIX}삭제대상`],
      );
      return rows.map((r: any) => r.id);
    });

    const staff = await agentAs("staff", "g@gonjiam.com");
    expect((await staff.delete(`/api/departments/${deleteTargetId}`)).status).toBe(403);

    const admin = await agentAs("admin", "h@gonjiam.com");
    expect((await admin.delete(`/api/departments/${deleteTargetId}`)).status).toBe(204);

    const remaining = await withService(async (q) => {
      const { rows } = await q.query("select id from departments where id in ($1,$2)", [keepId, deleteTargetId]);
      return rows.map((r: any) => r.id);
    });
    // 지운 것만 사라지고 나머지는 남아 있어야 한다 — delete에 where가 빠지면
    // (또는 잘못된 조건이면) 이 비교가 깨진다.
    expect(remaining).toEqual([keepId]);
  });
});

describe("직원", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/employees")).status).toBe(401);
  });

  it("role 필터가 없으면 전체를 돌려준다", async () => {
    await agentAs("staff", "emp-all-staff@gonjiam.com");
    await agentAs("admin", "emp-all-admin@gonjiam.com");
    const agent = await agentAs("approver", "emp-all-approver@gonjiam.com");
    const res = await agent.get("/api/employees");
    expect(res.status).toBe(200);
    const roles = res.body.map((e: any) => e.role).sort();
    expect(roles).toEqual(["admin", "approver", "staff"]);
  });

  it("role 필터를 콤마로 여러 개 주면 그 역할만 돌려준다", async () => {
    await agentAs("staff", "emp-f-staff@gonjiam.com");
    await agentAs("admin", "emp-f-admin@gonjiam.com");
    const agent = await agentAs("approver", "emp-f-approver@gonjiam.com");
    const res = await agent.get("/api/employees?role=admin,approver");
    expect(res.status).toBe(200);
    const roles = res.body.map((e: any) => e.role).sort();
    // staff가 섞여 나오면(필터가 안 걸리면) 실패하고, admin·approver 중 하나라도
    // 빠지면(필터가 너무 좁으면) 역시 실패한다.
    expect(roles).toEqual(["admin", "approver"]);
  });

  it("일반 직원은 직원 정보를 바꿀 수 없다", async () => {
    const staff = await agentAs("staff", "emp-patch-staff@gonjiam.com");
    const targetId = await withService(async (q) => {
      const { rows } = await q.query(
        "select id from employees where email = 'emp-patch-staff@gonjiam.com'",
      );
      return rows[0].id;
    });
    const res = await staff.patch(`/api/employees/${targetId}`).send({ name: "가로챈이름" });
    expect(res.status).toBe(403);
    const name = await withService(async (q) => {
      const { rows } = await q.query("select name from employees where id = $1", [targetId]);
      return rows[0].name;
    });
    expect(name).not.toBe("가로챈이름");
  });

  it("부분 갱신이다 — department_id만 보내면 나머지는 그대로다", async () => {
    const admin = await agentAs("admin", "emp-partial-admin@gonjiam.com");
    const targetId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role, phone) values ('원본이름','emp-partial-target@gonjiam.com','staff','010-0000-0000') returning id",
      );
      return rows[0].id;
    });
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}배정용`,
      ]);
      return rows[0].id;
    });

    const res = await admin.patch(`/api/employees/${targetId}`).send({ department_id: deptId });
    expect(res.status).toBe(200);
    expect(res.body.department_id).toBe(deptId);
    // 요청에 없던 name·phone이 지워지거나 null이 되면 안 된다 — 이게 이 테스트의
    // 핵심이다. 핸들러가 "본문에 없는 키도 매번 SET"하는 방식으로 바뀌면 깨진다.
    expect(res.body.name).toBe("원본이름");
    expect(res.body.phone).toBe("010-0000-0000");
  });

  it("department_id를 명시적으로 null로 보내면 미지정으로 바뀐다", async () => {
    const admin = await agentAs("admin", "emp-unassign-admin@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}해제용`,
      ]);
      return rows[0].id;
    });
    const targetId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role, department_id) values ('배정됨','emp-unassign-target@gonjiam.com','staff',$1) returning id",
        [deptId],
      );
      return rows[0].id;
    });

    const res = await admin.patch(`/api/employees/${targetId}`).send({ department_id: null });
    expect(res.status).toBe(200);
    expect(res.body.department_id).toBeNull();
  });

  it("없는 직원을 수정하면 404다", async () => {
    const admin = await agentAs("admin", "emp-404-admin@gonjiam.com");
    const res = await admin
      .patch("/api/employees/00000000-0000-0000-0000-000000000000")
      .send({ name: "유령" });
    expect(res.status).toBe(404);
  });

  // role은 Postgres enum(emp_role)이다. 검증 없이 그대로 바인딩하면 DB가
  // "invalid input value for enum..."으로 죽고 그 예외가 잡히지 않아 Express
  // 기본 핸들러가 스택트레이스와 서버 파일 경로가 담긴 HTML을 그대로 응답으로
  // 내보낸다(실제로 재현해 확인한 버그) — 400 JSON으로 막혔는지, 그리고 그
  // 내부 정보가 새지 않는지를 함께 확인한다.
  it("잘못된 role이면 400이고 스택트레이스나 파일 경로가 새지 않는다", async () => {
    const admin = await agentAs("admin", "emp-badrole-admin@gonjiam.com");
    const targetId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role) values ('원본','emp-badrole-target@gonjiam.com','staff') returning id",
      );
      return rows[0].id;
    });
    const res = await admin.patch(`/api/employees/${targetId}`).send({ role: "superadmin" });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.text).not.toMatch(/\/Users\/|\bat \/|node_modules/);
    // 값이 실제로 안 바뀌었는지도 확인한다 — 검증이 응답만 400이고 DB는
    // 이미 건드린 뒤라면 의미가 없다.
    const role = await withService(async (q) => {
      const { rows } = await q.query("select role from employees where id = $1", [targetId]);
      return rows[0].role;
    });
    expect(role).toBe("staff");
  });

  it("관리자는 직원을 미리 등록할 수 있고, 일반 직원은 할 수 없다", async () => {
    const staff = await agentAs("staff", "emp-create-staff@gonjiam.com");
    const denied = await staff.post("/api/employees").send({
      name: "가로챈직원",
      email: "emp-create-blocked@gonjiam.com",
      role: "staff",
    });
    expect(denied.status).toBe(403);

    const admin = await agentAs("admin", "emp-create-admin@gonjiam.com");
    const res = await admin.post("/api/employees").send({
      name: "사전등록",
      email: "emp-create-target@gonjiam.com",
      role: "staff",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(
      expect.objectContaining({ name: "사전등록", email: "emp-create-target@gonjiam.com", role: "staff" }),
    );
    // 계정 없이 미리 등록된 행이라 auth_user_id는 아직 없어야 한다.
    expect(res.body.auth_user_id).toBeNull();

    const count = await withService(async (q) => {
      const { rows } = await q.query("select count(*)::int as n from employees where email = $1", [
        "emp-create-blocked@gonjiam.com",
      ]);
      return rows[0].n;
    });
    // 403이 실제 게이트에서 났는지 — 거부된 요청은 행을 만들지 않았어야 한다.
    expect(count).toBe(0);
  });

  it("이름이나 이메일이 없으면 400이다", async () => {
    const admin = await agentAs("admin", "emp-create-empty-admin@gonjiam.com");
    expect((await admin.post("/api/employees").send({ email: "only-email@gonjiam.com" })).status).toBe(400);
    expect((await admin.post("/api/employees").send({ name: "이름만" })).status).toBe(400);
  });

  it("이미 등록된 이메일이면 409다", async () => {
    const admin = await agentAs("admin", "emp-create-dup-admin@gonjiam.com");
    const first = await admin.post("/api/employees").send({ name: "첫번째", email: "emp-dup@gonjiam.com" });
    expect(first.status).toBe(201);
    const second = await admin.post("/api/employees").send({ name: "두번째", email: "emp-dup@gonjiam.com" });
    expect(second.status).toBe(409);
  });

  it("잘못된 role이면 400이고, 존재하지 않는 department_id면 400이다", async () => {
    const admin = await agentAs("admin", "emp-create-bad-admin@gonjiam.com");
    const badRole = await admin.post("/api/employees").send({
      name: "나쁜역할",
      email: "emp-badrole@gonjiam.com",
      role: "superadmin",
    });
    expect(badRole.status).toBe(400);

    const badDept = await admin.post("/api/employees").send({
      name: "나쁜부서",
      email: "emp-baddept@gonjiam.com",
      department_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(badDept.status).toBe(400);
  });

  it("관리자는 직원을 삭제할 수 있고, 일반 직원은 삭제할 수 없다", async () => {
    const targetId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role) values ('삭제대상','emp-del-target@gonjiam.com','staff') returning id",
      );
      return rows[0].id;
    });

    const staff = await agentAs("staff", "emp-del-staff@gonjiam.com");
    expect((await staff.delete(`/api/employees/${targetId}`)).status).toBe(403);
    const stillThere = await withService(async (q) => {
      const { rows } = await q.query("select id from employees where id = $1", [targetId]);
      return rows.length;
    });
    expect(stillThere).toBe(1);

    const admin = await agentAs("admin", "emp-del-admin@gonjiam.com");
    expect((await admin.delete(`/api/employees/${targetId}`)).status).toBe(204);
    const gone = await withService(async (q) => {
      const { rows } = await q.query("select id from employees where id = $1", [targetId]);
      return rows.length;
    });
    expect(gone).toBe(0);
  });
});

describe("지침 수신자 (부서별)", () => {
  it("부서별로 전체 교체 방식으로 저장하고, 다른 부서의 지정은 건드리지 않는다", async () => {
    const admin = await agentAs("admin", "rec-admin@gonjiam.com");
    const [deptA, deptB] = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into departments (name) values ($1),($2) returning id",
        [`${DEPT_PREFIX}A`, `${DEPT_PREFIX}B`],
      );
      return rows.map((r: any) => r.id);
    });
    const [emp1, emp2, emp3] = await withService(async (q) => {
      const { rows } = await q.query(
        `insert into employees (name, email, role) values
         ('갑','rec-갑@gonjiam.com','staff'),('을','rec-을@gonjiam.com','staff'),('병','rec-병@gonjiam.com','staff')
         returning id`,
      );
      return rows.map((r: any) => r.id);
    });

    // deptB에 emp3을 미리 심어 둔다 — deptA를 교체할 때 이게 사라지면 안 된다.
    await withService((q) =>
      q.query("insert into recipients (department_id, employee_id) values ($1,$2)", [deptB, emp3]),
    );

    await admin.put(`/api/recipients/${deptA}`).send({ employee_ids: [emp1, emp2] });
    let res = await admin.get(`/api/recipients?department_id=${deptA}`);
    expect(res.body.map((r: any) => r.employee_id).sort()).toEqual([emp1, emp2].sort());

    // deptA만 emp1 하나로 다시 교체 — emp2는 사라지고 emp1만 남아야 한다.
    await admin.put(`/api/recipients/${deptA}`).send({ employee_ids: [emp1] });
    res = await admin.get(`/api/recipients?department_id=${deptA}`);
    expect(res.body.map((r: any) => r.employee_id)).toEqual([emp1]);

    // deptB는 건드리지 않았으니 emp3이 그대로 있어야 한다 — PUT이 전체
    // recipients 테이블을 지우는 식으로(전 부서를 건드리는 방식으로) 잘못
    // 구현되면 여기서 깨진다.
    res = await admin.get(`/api/recipients?department_id=${deptB}`);
    expect(res.body.map((r: any) => r.employee_id)).toEqual([emp3]);
  });

  it("department_id 필터 없이 조회하면 전체 부서의 지정을 돌려준다", async () => {
    const admin = await agentAs("admin", "rec-all-admin@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}전체조회`,
      ]);
      return rows[0].id;
    });
    const empId = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role) values ('정','rec-정@gonjiam.com','staff') returning id",
      );
      return rows[0].id;
    });
    await admin.put(`/api/recipients/${deptId}`).send({ employee_ids: [empId] });

    const res = await admin.get("/api/recipients");
    expect(res.status).toBe(200);
    expect(res.body.some((r: any) => r.employee_id === empId && r.department_id === deptId)).toBe(true);
    // join이 실제로 이름을 붙였는지 — department_id/employee_id만 있고 employees
    // 조인이 빠지면 이 필드가 undefined가 된다.
    const row = res.body.find((r: any) => r.employee_id === empId);
    expect(row.name).toBe("정");
  });

  it("일반 직원은 수신자를 바꿀 수 없다", async () => {
    const admin = await agentAs("admin", "rec-guard-admin@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ($1) returning id", [
        `${DEPT_PREFIX}가드`,
      ]);
      return rows[0].id;
    });
    const staff = await agentAs("staff", "rec-guard-staff@gonjiam.com");
    const res = await staff.put(`/api/recipients/${deptId}`).send({ employee_ids: [] });
    expect(res.status).toBe(403);
    void admin;
  });
});

describe("특보 승인 수신자 (alert_recipients)", () => {
  it("전체 교체 방식으로 저장한다", async () => {
    const agent = await agentAs("admin", "d@gonjiam.com");
    const ids = await withService(async (q) => {
      const { rows } = await q.query(
        "insert into employees (name, email, role) values ('갑','g@gonjiam.com','approver'),('을','u@gonjiam.com','approver') returning id",
      );
      return rows.map((r: any) => r.id);
    });

    await agent.put("/api/alert-recipients").send({ employee_ids: ids });
    expect((await agent.get("/api/alert-recipients")).body).toHaveLength(2);

    // 하나만 남기고 다시 저장하면 나머지는 사라져야 한다
    await agent.put("/api/alert-recipients").send({ employee_ids: [ids[0]] });
    const after = (await agent.get("/api/alert-recipients")).body;
    expect(after).toHaveLength(1);
    expect(after[0].employee_id).toBe(ids[0]);
  });

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/alert-recipients")).status).toBe(401);
  });

  it("일반 직원은 수신자를 바꿀 수 없다", async () => {
    const agent = await agentAs("staff", "e@gonjiam.com");
    expect((await agent.put("/api/alert-recipients").send({ employee_ids: [] })).status).toBe(403);
  });
});

describe("특보 반복 발송 설정 (alert_settings)", () => {
  // alert_settings는 seed.sql이 심어 둔 4행(kind별 1행)뿐이고 admin에게 update
  // 권한만 있다(insert/delete 정책 없음) — 이 스위트가 실제로 그 4행을 수정하므로
  // 매 테스트가 끝나면 원래 값으로 되돌려 둔다. 지우거나 새로 넣을 수 없어(RLS가
  // 막는다) departments처럼 delete로 정리할 수 없다.
  async function restoreSeedAlertSettings() {
    await withService((q) =>
      q.query(`
        update alert_settings set enabled=true, repeat_policy='until_daily_accum_below',
          repeat_accum_threshold=80, heat_repeat_basis=null where kind='rain';
        update alert_settings set enabled=true, repeat_policy='hourly_until_below',
          repeat_accum_threshold=null, heat_repeat_basis=null where kind='snow';
        update alert_settings set enabled=true, repeat_policy='hourly_until_below',
          repeat_accum_threshold=null, heat_repeat_basis=null where kind='wind';
        update alert_settings set enabled=true, repeat_policy='hourly_until_below',
          repeat_accum_threshold=null, heat_repeat_basis='feels' where kind='heat';
      `),
    );
  }

  it("시드된 4개 kind 설정을 돌려준다", async () => {
    const agent = await agentAs("staff", "as-read-staff@gonjiam.com");
    const res = await agent.get("/api/alert-settings");
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.kind).sort()).toEqual(["heat", "rain", "snow", "wind"]);
  });

  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/alert-settings")).status).toBe(401);
  });

  it("update만 가능하다 — 행 개수는 그대로 4개이고, 값은 실제로 바뀐다", async () => {
    const admin = await agentAs("admin", "as-write-admin@gonjiam.com");
    try {
      const res = await admin.put("/api/alert-settings").send({
        rows: [{ kind: "rain", enabled: false, repeat_policy: "once", repeat_accum_threshold: null, heat_repeat_basis: null }],
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({ kind: "rain", enabled: false, repeat_policy: "once" }),
      ]);

      const all = await withService(async (q) => {
        const { rows } = await q.query("select kind from alert_settings");
        return rows;
      });
      // upsert였다면(insert 절이 RLS를 통과했다면) 5행이 됐을 것이다 — 4행 그대로인
      // 것이 "update-only로 구현했다"는 이 테스트의 핵심 주장이다.
      expect(all).toHaveLength(4);

      const rainRow = await withService(async (q) => {
        const { rows } = await q.query("select enabled, repeat_policy from alert_settings where kind='rain'");
        return rows[0];
      });
      expect(rainRow).toEqual({ enabled: false, repeat_policy: "once" });
    } finally {
      await restoreSeedAlertSettings();
    }
  });

  it("일반 직원은 설정을 바꿀 수 없다", async () => {
    const staff = await agentAs("staff", "as-guard-staff@gonjiam.com");
    const res = await staff.put("/api/alert-settings").send({
      rows: [{ kind: "rain", enabled: false, repeat_policy: "once" }],
    });
    expect(res.status).toBe(403);
    // 403이 실제 role 게이트임을 확인 — DB 값이 그대로 시드값(rain=until_daily_accum_below)이어야 한다.
    const rainRow = await withService(async (q) => {
      const { rows } = await q.query("select repeat_policy from alert_settings where kind='rain'");
      return rows[0].repeat_policy;
    });
    expect(rainRow).toBe("until_daily_accum_below");
  });

  // kind는 Postgres enum(event_kind)이다. employees의 role과 같은 버그가 여기도
  // 있었다 — 존재하지 않는 kind를 그대로 바인딩하면 DB 예외가 잡히지 않고
  // 스택트레이스·서버 파일 경로가 담긴 HTML로 샜다(실제로 재현해 확인함).
  it("잘못된 kind면 400이고 스택트레이스나 파일 경로가 새지 않는다", async () => {
    const admin = await agentAs("admin", "as-badkind-admin@gonjiam.com");
    const res = await admin.put("/api/alert-settings").send({
      rows: [{ kind: "does-not-exist", enabled: false, repeat_policy: "once" }],
    });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.text).not.toMatch(/\/Users\/|\bat \/|node_modules/);

    // 유효한 kind와 무효한 kind가 한 요청에 섞여도, 유효한 쪽까지 일부 반영되고
    // 무효한 쪽만 실패하는 "부분 성공"이 없어야 한다 — 전체를 먼저 검증하고
    // 하나라도 잘못되면 아무것도 건드리지 않는다.
    const res2 = await admin.put("/api/alert-settings").send({
      rows: [
        { kind: "rain", enabled: false, repeat_policy: "once" },
        { kind: "does-not-exist", enabled: false, repeat_policy: "once" },
      ],
    });
    expect(res2.status).toBe(400);
    const rainRow = await withService(async (q) => {
      const { rows } = await q.query("select repeat_policy from alert_settings where kind='rain'");
      return rows[0].repeat_policy;
    });
    expect(rainRow).toBe("until_daily_accum_below");
  });
});
