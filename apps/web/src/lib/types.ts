// supabase/migrations/0001_schema.sql 의 테이블과 1:1 대응 (필드명 = 컬럼명 그대로).
// DeptBlock은 supabase/functions/_shared/template.ts 와 동일 정의.

export type Kind = "rain" | "snow" | "wind" | "heat";
export type Grade = "watch" | "warning";
export type EventStatus =
  | "PENDING_APPROVAL"
  | "ACTIVE"
  | "RESOLVED"
  | "ESCALATED"
  | "DISMISSED";
export type EmpRole = "admin" | "approver" | "staff";

export type SiteSettings = {
  id: number;
  site_name: string;
  address: string;
  nx: number;
  ny: number;
  remind_interval_min: number;
  resolve_notice: boolean;
  updated_at: string;
};

export type WeatherCriteria = {
  kind: Kind;
  grade: Grade;
  threshold: Record<string, number>;
  updated_at: string;
};

export type AlertSetting = {
  kind: Kind;
  enabled: boolean;
  repeat_policy: "once" | "hourly_until_below" | "until_daily_accum_below";
  repeat_accum_threshold: number | null;
  heat_repeat_basis: "temp" | "feels" | null;
  updated_at: string;
};

export type Department = {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
};

export type Employee = {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  kakaowork_user_id: string | null;
  department_id: string | null;
  role: EmpRole;
  created_at: string;
};

export type Recipient = {
  department_id: string;
  employee_id: string;
};

export type AlertRecipient = {
  employee_id: string;
};

export type ActionGuideline = {
  id: string;
  department_id: string;
  kind: Kind;
  grade: Grade;
  staff_actions: string[];
  guest_notice: string;
  updated_at: string;
  updated_by: string | null;
};

export type WeatherObservation = {
  id: number;
  observed_at: string;
  rain_mm_per_hr: number | null;
  temp_c: number | null;
  wind_ms: number | null;
  humidity_pct: number | null;
  snow_new_cm: number | null;
  feels_c: number | null;
  raw: Record<string, unknown> | null;
  missing: boolean;
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

export type Message = {
  id: string;
  event_id: string;
  status: "draft" | "approved";
  content: DeptBlock[];
  updated_at: string;
  updated_by: string | null;
};

export type DispatchResult = { employee_id: string; name: string; ok: boolean; error?: string };

export type Dispatch = {
  id: number;
  message_id: string;
  event_id: string;
  sent_at: string;
  channel: string;
  repeat_no: number;
  is_test: boolean;
  results: DispatchResult[];
};

export type Heartbeat = {
  name: string;
  last_run_at: string;
  ok: boolean;
  note: string | null;
};
