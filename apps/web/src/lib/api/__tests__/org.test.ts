import { describe, expect, it, beforeEach, vi } from "vitest";
import { record } from "./contract";
import {
  listDepartments,
  listDepartmentsForSignup,
  createDepartment,
  renameDepartment,
  moveDepartment,
  deleteDepartment,
  listEmployees,
  updateEmployee,
  deleteEmployee,
  createEmployee,
  listRecipients,
  saveRecipients,
  alertRecipients,
  saveAlertRecipients,
  alertSettings,
  saveAlertSettings,
} from "../org";

beforeEach(() => vi.restoreAllMocks());

// 대응하는 서버 라우트는 server/src/api/org.ts에 있다.
describe("lib/api/org HTTP 계약", () => {
  it("listDepartments는 GET /api/departments다", async () => {
    const req = await record(() => listDepartments());
    expect(req).toEqual({ path: "/api/departments", method: "GET", body: undefined });
  });

  // 가입 화면은 로그인 전이라 /api/departments를 부르면 401만 받는다 — 그래서 부서
  // 드롭다운이 영영 비어 있었다(실제 브라우저에서 재현). 공개 경로를 부르는지 고정한다.
  it("listDepartmentsForSignup은 인증이 필요 없는 GET /api/public/departments다", async () => {
    const req = await record(() => listDepartmentsForSignup());
    expect(req).toEqual({ path: "/api/public/departments", method: "GET", body: undefined });
  });

  // 부서 계층(2라운드에 복원)을 서버가 parent_id로 받는다. 이름만 보내면 자식 부서를
  // 만들 수 없다.
  it("createDepartment는 POST /api/departments에 name·parent_id·sort_order를 보낸다", async () => {
    const req = await record(() => createDepartment("객실", { parentId: "p1", sortOrder: 3 }));
    expect(req).toEqual({
      path: "/api/departments",
      method: "POST",
      body: { name: "객실", parent_id: "p1", sort_order: 3 },
    });
  });

  // 최상위 부서는 parent_id가 명시적으로 null이어야 한다 — 키 자체가 빠지면 서버의
  // 부분 갱신 규약("본문에 있는 키만")에서 의미가 달라진다.
  it("createDepartment는 상위 부서를 생략하면 parent_id를 null로 보낸다", async () => {
    const req = await record(() => createDepartment("리조트"));
    expect((req.body as any).parent_id).toBeNull();
  });

  it("renameDepartment는 PATCH /api/departments/:id에 { name }을 보낸다", async () => {
    const req = await record(() => renameDepartment("d1", "새이름"));
    expect(req).toEqual({ path: "/api/departments/d1", method: "PATCH", body: { name: "새이름" } });
  });

  // 이름을 함께 보내면 안 된다 — 서버는 보낸 키만 바꾸므로, 이동만 하려는 요청에
  // 이름이 끼면 화면이 들고 있던 옛 이름으로 되돌려 쓴다.
  it("moveDepartment는 PATCH /api/departments/:id에 { parent_id }만 보낸다", async () => {
    const req = await record(() => moveDepartment("d1", "d2"));
    expect(req).toEqual({ path: "/api/departments/d1", method: "PATCH", body: { parent_id: "d2" } });
  });

  it("moveDepartment(null)은 최상위로 올린다는 뜻으로 parent_id: null을 보낸다", async () => {
    const req = await record(() => moveDepartment("d1", null));
    expect(req).toEqual({ path: "/api/departments/d1", method: "PATCH", body: { parent_id: null } });
  });

  it("deleteDepartment는 DELETE /api/departments/:id다", async () => {
    const req = await record(() => deleteDepartment("d1"));
    expect(req).toEqual({ path: "/api/departments/d1", method: "DELETE", body: undefined });
  });

  it("listEmployees는 GET /api/employees다", async () => {
    const req = await record(() => listEmployees());
    expect(req).toEqual({ path: "/api/employees", method: "GET", body: undefined });
  });

  // 서버는 role을 콤마로 여러 개 받는다. 형식이 어긋나면 필터가 통째로 빗나가
  // Criteria.tsx의 승인자 후보 목록이 비거나 staff까지 섞인다.
  it("listEmployees는 role 필터를 콤마로 이어 붙인다", async () => {
    const req = await record(() => listEmployees({ roles: ["admin", "approver"] }));
    expect(req.path).toBe("/api/employees?role=admin,approver");
  });

  it("listEmployees는 role 배열이 비면 쿼리를 붙이지 않는다", async () => {
    const req = await record(() => listEmployees({ roles: [] }));
    expect(req.path).toBe("/api/employees");
  });

  it("updateEmployee는 PATCH /api/employees/:id에 부분 본문을 보낸다", async () => {
    const req = await record(() => updateEmployee("e1", { name: "홍길동", department_id: null }));
    expect(req).toEqual({
      path: "/api/employees/e1",
      method: "PATCH",
      body: { name: "홍길동", department_id: null },
    });
  });

  // 이메일은 가입이 직원 행에 계정을 이어 붙이는 병합 키다 — 보내지 않으면
  // 서버가 고칠 방법이 없다(2라운드 항목 2).
  it("updateEmployee는 email도 보낼 수 있다", async () => {
    const req = await record(() => updateEmployee("e1", { email: "fixed@gonjiam.com" }));
    expect(req.body).toEqual({ email: "fixed@gonjiam.com" });
  });

  it("deleteEmployee는 DELETE /api/employees/:id다", async () => {
    const req = await record(() => deleteEmployee("e1"));
    expect(req).toEqual({ path: "/api/employees/e1", method: "DELETE", body: undefined });
  });

  it("createEmployee는 POST /api/employees다", async () => {
    const body = { name: "홍길동", email: "hong@gonjiam.com", department_id: "d1", role: "staff" as const };
    const req = await record(() => createEmployee(body));
    expect(req).toEqual({ path: "/api/employees", method: "POST", body });
  });

  it("listRecipients는 GET /api/recipients다", async () => {
    const req = await record(() => listRecipients());
    expect(req).toEqual({ path: "/api/recipients", method: "GET", body: undefined });
  });

  it("listRecipients는 부서를 주면 department_id 쿼리를 붙인다", async () => {
    const req = await record(() => listRecipients("d1"));
    expect(req.path).toBe("/api/recipients?department_id=d1");
  });

  // 서버 라우트는 /recipients/:departmentId다(부서가 경로에 있다). 본문에만 넣고
  // /api/recipients로 보내면 404가 된다.
  it("saveRecipients는 PUT /api/recipients/:departmentId에 { employee_ids }를 보낸다", async () => {
    const req = await record(() => saveRecipients("d1", ["e1", "e2"]), null);
    expect(req).toEqual({
      path: "/api/recipients/d1",
      method: "PUT",
      body: { employee_ids: ["e1", "e2"] },
    });
  });

  it("alertRecipients는 GET /api/alert-recipients다", async () => {
    const req = await record(() => alertRecipients());
    expect(req).toEqual({ path: "/api/alert-recipients", method: "GET", body: undefined });
  });

  // 이쪽은 부서가 없는 전역 목록이라 경로에 id가 붙지 않는다 — recipients와 헷갈리기 쉽다.
  it("saveAlertRecipients는 PUT /api/alert-recipients에 { employee_ids }를 보낸다", async () => {
    const req = await record(() => saveAlertRecipients(["e1"]), null);
    expect(req).toEqual({ path: "/api/alert-recipients", method: "PUT", body: { employee_ids: ["e1"] } });
  });

  it("alertSettings는 GET /api/alert-settings다", async () => {
    const req = await record(() => alertSettings());
    expect(req).toEqual({ path: "/api/alert-settings", method: "GET", body: undefined });
  });

  it("saveAlertSettings는 PUT /api/alert-settings에 { rows }를 보낸다", async () => {
    const rows = [
      {
        kind: "rain" as const,
        enabled: true,
        repeat_policy: "until_daily_accum_below" as const,
        repeat_accum_threshold: 10,
        heat_repeat_basis: "feels" as const,
      },
    ];
    const req = await record(() => saveAlertSettings(rows));
    expect(req).toEqual({ path: "/api/alert-settings", method: "PUT", body: { rows } });
  });
});
