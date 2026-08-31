// server/src/api/org.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";
import type { AlertSetting, EmpRole } from "../types";

// departments 테이블에는 parent_id/sort_order도 있지만 org.ts는 id/name만 select하고
// insert/update도 name만 받는다 — 부서 계층(상위/하위)은 이 API로 다룰 수 없다.
// DeptModal.tsx/Employees.tsx/Guidelines.tsx가 쓰던 트리 구조가 평면 목록으로 바뀐 이유.
export type DepartmentRow = { id: string; name: string };

// EMP_COLS 그대로. employees 테이블에는 phone도 있다(브리프에는 없던 필드).
export type EmployeeRow = {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  kakaowork_user_id: string | null;
  department_id: string | null;
  role: EmpRole;
  phone: string | null;
  created_at: string;
};

// GET /recipients, /alert-recipients 모두 평면 형태다 — 예전의
// `{ employee_id, employees: { id, name, role } }` 중첩이 아니라
// `{ employee_id, name, role }`로 바로 온다.
export type RecipientRow = {
  department_id: string;
  employee_id: string;
  name: string;
  role: EmpRole;
  kakaowork_user_id: string | null;
};
export type AlertRecipientRow = { employee_id: string; name: string; role: EmpRole };

export type AlertSettingRow = AlertSetting;

export const listDepartments = () => apiGet<DepartmentRow[]>("/api/departments");
export const createDepartment = (name: string) => apiSend<DepartmentRow>("POST", "/api/departments", { name });
export const renameDepartment = (id: string, name: string) =>
  apiSend<DepartmentRow>("PATCH", `/api/departments/${encodeURIComponent(id)}`, { name });
export const deleteDepartment = (id: string) => apiSend<null>("DELETE", `/api/departments/${encodeURIComponent(id)}`);

export const listEmployees = (opts?: { roles?: EmpRole[] }) => {
  const q = opts?.roles && opts.roles.length > 0 ? `?role=${opts.roles.join(",")}` : "";
  return apiGet<EmployeeRow[]>(`/api/employees${q}`);
};
export const updateEmployee = (
  id: string,
  patch: Partial<Pick<EmployeeRow, "name" | "role" | "department_id" | "phone">>,
) => apiSend<EmployeeRow>("PATCH", `/api/employees/${encodeURIComponent(id)}`, patch);
export const deleteEmployee = (id: string) => apiSend<null>("DELETE", `/api/employees/${encodeURIComponent(id)}`);

// 서버(org.ts)에 직원 "생성" 엔드포인트가 없다 — 가입은 /api/auth/signup 전용이고,
// 관리자는 기존 직원을 고치거나(PATCH) 지울(DELETE) 수만 있다. Employees.tsx의
// "직원 추가"는 이 호출이 404로 실패한다 — task-8-report.md 참고.
export const createEmployee = (body: {
  name: string;
  email: string;
  department_id: string | null;
  role: EmpRole;
}) => apiSend<EmployeeRow>("POST", "/api/employees", body);

// 부서별 지침 수신자 (recipients) — Guidelines.tsx
export const listRecipients = (departmentId?: string) =>
  apiGet<RecipientRow[]>(`/api/recipients${departmentId ? `?department_id=${encodeURIComponent(departmentId)}` : ""}`);
export const saveRecipients = (departmentId: string, employeeIds: string[]) =>
  apiSend<null>("PUT", `/api/recipients/${encodeURIComponent(departmentId)}`, { employee_ids: employeeIds });

// 특보 승인(Alert) 수신자 — Criteria.tsx
export const alertRecipients = () => apiGet<AlertRecipientRow[]>("/api/alert-recipients");
export const saveAlertRecipients = (employeeIds: string[]) =>
  apiSend<null>("PUT", "/api/alert-recipients", { employee_ids: employeeIds });

// 반복 발송 설정 — Settings.tsx
export const alertSettings = () => apiGet<AlertSettingRow[]>("/api/alert-settings");
export const saveAlertSettings = (
  rows: Pick<AlertSettingRow, "kind" | "enabled" | "repeat_policy" | "repeat_accum_threshold" | "heat_repeat_basis">[],
) => apiSend<AlertSettingRow[]>("PUT", "/api/alert-settings", { rows });
