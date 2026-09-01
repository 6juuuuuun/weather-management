// 화면 여러 곳이 함께 쓰는 도메인 타입.
//
// 예전에는 db 테이블 전부를 여기에 1:1로 옮겨 적었는데, 이관하면서 각 엔드포인트의
// 응답 모양을 lib/api/{dashboard,org,content}.ts가 `…Row`로 다시 정의했고, 이 파일의
// 테이블 타입 10개(SiteSettings·WeatherCriteria·Department·Recipient·AlertRecipient·
// ActionGuideline·WeatherObservation·Message·Dispatch·Heartbeat)는 참조 0건인 죽은
// 코드가 됐다. 죽은 정의는 그냥 쓸모없는 데서 끝나지 않는다 — 살아 있는 쪽과 조용히
// 어긋나기 시작한다(실제로 Employee가 phone·account_status를 잃은 채 남아 있었고,
// AuthProvider가 그 타입으로 들고 있어 useAuth().employee로는 두 필드에 접근할 수
// 없었다). 그래서 지금 남은 것은 **실제로 참조되는 타입뿐**이고, 서버 응답 모양은
// lib/api/*.ts가 이 파일의 타입을 재사용한다(중복 정의를 만들지 않는다).
//
// 기준이 되는 스키마는 db/migrations/0001_schema.sql이다(자체 호스팅 이관 후).
// DeptBlock은 server/src/shared/template.ts 와 동일 정의.

export type Kind = "rain" | "snow" | "wind" | "heat";
export type Grade = "watch" | "warning";
export type EventStatus =
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "RESOLVED"
  | "ESCALATED"
  | "DISMISSED";
export type EmpRole = "admin" | "approver" | "staff";

export type AlertSetting = {
  kind: Kind;
  enabled: boolean;
  repeat_policy: "once" | "hourly_until_below" | "until_daily_accum_below";
  repeat_accum_threshold: number | null;
  heat_repeat_basis: "temp" | "feels" | null;
  updated_at: string;
};

// GET/POST/PATCH /api/employees가 돌려주는 행 그대로다(server/src/api/org.ts의 EMP_COLS).
// lib/api/org.ts의 EmployeeRow가 이 타입을 그대로 재사용한다 — 두 벌로 적어 두면
// 한쪽만 필드가 늘어나 조용히 어긋난다(실제로 phone·account_status에서 그랬다).
export type Employee = {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  kakaowork_user_id: string | null;
  department_id: string | null;
  role: EmpRole;
  phone: string | null;
  created_at: string;
  // GET /employees에서만 채워진다(server/src/api/org.ts의 withAccountStatus) — 계정이
  // 아예 없는(사전 등록만 된) 직원은 null, PATCH/POST /employees 응답에는 이 필드
  // 자체가 없다(그래서 옵셔널이다).
  account_status?: "active" | "disabled" | null;
};

export type WeatherEvent = {
  id: string;
  kind: Kind;
  grade: Grade;
  status: EventStatus;
  detected_at: string;
  closed_at: string | null;
  trigger_observation_id: number | null;
  approved_by: string | null;
  approved_at: string | null;
  last_reminded_at: string | null;
  repeat_count: number;
};

// action_guidelines/recipients를 조합해 만들어지는, 부서 단위 발송 블록
// (supabase/functions/_shared/template.ts 의 DeptBlock과 동일)
export type DeptBlock = {
  department_id: string;
  department_name: string;
  staff_actions: string[];
  guest_notice: string;
  recipients: { employee_id: string; name: string; kakaowork_user_id: string | null }[];
  selected: boolean;
};

export type DispatchResult = { employee_id: string; name: string; ok: boolean; error?: string };

