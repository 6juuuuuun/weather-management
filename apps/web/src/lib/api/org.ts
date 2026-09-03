// server/src/api/org.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";
import type { AlertSetting, EmpRole, Employee } from "../types";

export type DepartmentRow = { id: string; parent_id: string | null; name: string; sort_order: number };

// EMP_COLS 그대로. 정의는 lib/types.ts의 Employee 하나뿐이다 — 여기서 같은 모양을
// 다시 적으면 한쪽만 필드가 늘어나 조용히 어긋난다(AuthProvider가 이 행을 Employee
// 타입 필드에 담는데, 예전에는 그쪽에 phone·account_status가 없어 useAuth().employee로는
// 두 필드에 접근할 수 없었다). 이름은 다른 …Row들과 맞춰 그대로 둔다.
export type EmployeeRow = Employee;

// GET /recipients, /alert-recipients 모두 평면 형태다 — 예전의
// `{ employee_id, employees: { id, name, role } }` 중첩이 아니라
// `{ employee_id, name, role }`로 바로 온다.
export type RecipientRow = {
  department_id: string;
  employee_id: string;
  name: string;
  role: EmpRole;
  phone: string | null;
  /** 이 번호로 지금 특보를 보낼 수 있는가. **서버가 판정한 값이다** — 아래 주석 참고. */
  notifiable: boolean;
};
// notifiable도 함께 온다 — 화면이 "특보를 받을 수 있는 사람이 실제로 있는가"를
// 이 값으로 센다(대시보드 셋업 체크리스트·알림 설정의 수신자 전화번호 표시).
// 카카오워크 시절 `kakaowork_user_id`가 하던 일이고, 안전망은 그대로 남는다.
//
// **화면은 전화번호 형식 규칙을 한 글자도 갖지 않는다.** `phone !== null`로 화면이
// 스스로 세면, 형식 검증 이전에 저장된 값을 "연락 가능"으로 세는데 서버는 그 사람을
// 발송 대상에서 빼 버린다 — 화면은 초록이고 실제 발송은 0명인 상태다. 규칙은
// server/src/phone.ts 하나에서만 나오고, 화면은 그 판정 결과만 받는다
// (apps/web/src/lib/phone.ts가 서식만 하고 검증은 안 하는 것과 같은 이유다).
// department_id도 함께 온다(QA W-31) — 이 목록은 승인 권한을 지정하는 화면인데
// 그 사람이 어느 부서인지 보이지 않아, 동명이인이 있으면 누구를 빼는지 알 수 없었다.
export type AlertRecipientRow = {
  employee_id: string;
  name: string;
  role: EmpRole;
  phone: string | null;
  /** RecipientRow.notifiable과 같은 값·같은 이유. 서버가 판정한다. */
  notifiable: boolean;
  department_id: string | null;
};

export type AlertSettingRow = AlertSetting;

export const listDepartments = () => apiGet<DepartmentRow[]>("/api/departments");

// 가입 화면 전용. /api/departments는 로그인을 요구하므로 가입하려는 사람은 401만
// 받는다 — 그래서 부서 드롭다운이 영영 비어 있었다(실제 브라우저에서 재현). 서버가
// 이 경로로 id와 이름만 따로 내보낸다. 로그인한 화면은 계속 listDepartments를 쓴다.
export const listDepartmentsForSignup = () =>
  apiGet<{ id: string; name: string }[]>("/api/public/departments");
export const createDepartment = (name: string, opts?: { parentId?: string | null; sortOrder?: number }) =>
  apiSend<DepartmentRow>("POST", "/api/departments", {
    name,
    parent_id: opts?.parentId ?? null,
    sort_order: opts?.sortOrder,
  });
export const renameDepartment = (id: string, name: string) =>
  apiSend<DepartmentRow>("PATCH", `/api/departments/${encodeURIComponent(id)}`, { name });
// 상위 부서 변경. parent_id만 보낸다 — 이름은 서버가 그대로 둔다. null은
// "최상위로 올린다"는 뜻이고, 서버는 자기 자신·자기 자손을 부모로 지정하면 400을 준다.
export const moveDepartment = (id: string, parentId: string | null) =>
  apiSend<DepartmentRow>("PATCH", `/api/departments/${encodeURIComponent(id)}`, { parent_id: parentId });
export const deleteDepartment = (id: string) => apiSend<null>("DELETE", `/api/departments/${encodeURIComponent(id)}`);

export const listEmployees = (opts?: { roles?: EmpRole[] }) => {
  const q = opts?.roles && opts.roles.length > 0 ? `?role=${opts.roles.join(",")}` : "";
  return apiGet<EmployeeRow[]>(`/api/employees${q}`);
};
export const updateEmployee = (
  id: string,
  // email은 가입(POST /api/auth/signup)이 직원 행에 계정을 이어 붙이는 병합 키다 —
  // 서버가 정규화해 저장하고 중복이면 409를 준다(server/src/api/org.ts).
  //
  // 카카오워크 ID 수동 입력(QA W-16)은 사라졌다. 그 칸이 필요했던 이유는 발송
  // 주소를 이메일에서 **유도**했기 때문이다(조회가 실패하면 관리자가 메워야 했다).
  // SMS에는 유도가 없다 — 발송 주소를 넣는 칸은 `phone` 하나뿐이다.
  patch: Partial<
    Pick<EmployeeRow, "name" | "email" | "role" | "department_id" | "phone">
  >,
) => apiSend<EmployeeRow>("PATCH", `/api/employees/${encodeURIComponent(id)}`, patch);
export const deleteEmployee = (id: string) => apiSend<null>("DELETE", `/api/employees/${encodeURIComponent(id)}`);

// 계정(로그인) 없이 관리자가 미리 등록하는 직원 행이다 — 가입(/api/auth/signup)과는
// 별개다. 이메일이 나중에 실제로 가입하면 auth_user_id가 그 계정으로 이어붙는다
// (auth/routes.ts의 signup upsert).
// phone도 함께 보낸다. 예전에는 서버의 insert 목록에 phone이 없어 본문에 실어도
// 말없이 버려졌다 — 관리자는 입력했다고 믿고, 그 직원은 비상 연락처 없이 명부에
// 앉는다. 형식은 서버가 세 쓰기 경로에서 똑같이 검사한다(server/src/phone.ts).
export const createEmployee = (body: {
  name: string;
  email: string;
  department_id: string | null;
  role: EmpRole;
  phone?: string | null;
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
