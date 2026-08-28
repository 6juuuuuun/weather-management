create type event_kind as enum ('rain','snow','wind','heat');
create type event_grade as enum ('watch','warning');
create type event_status as enum ('PENDING_APPROVAL','ACTIVE','RESOLVED','ESCALATED','DISMISSED');
create type emp_role as enum ('admin','approver','staff');

-- 단일 행 전역 설정
create table site_settings (
  id int primary key default 1 check (id = 1),
  site_name text not null default '곤지암',
  address text not null default '경기도 광주시 도척면 도척윗로 278',
  nx int not null default 61,
  ny int not null default 121,
  remind_interval_min int not null default 30,
  resolve_notice boolean not null default true,   -- 상황 해제 알림
  updated_at timestamptz not null default now()
);

create table weather_criteria (
  kind event_kind not null,
  grade event_grade not null,
  -- rain: {"rain_mm_per_hr":20} / snow: {"snow_cm":5} / wind: {"wind_ms":14}
  -- heat: {"temp_c":33,"feels_c":31}  (기온 OR 체감 — 어느 한쪽 충족 시 감지)
  threshold jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, grade)
);

create table alert_settings (
  kind event_kind primary key,
  enabled boolean not null default true,
  -- 'once' | 'hourly_until_below' | 'until_daily_accum_below'
  repeat_policy text not null default 'hourly_until_below'
    check (repeat_policy in ('once','hourly_until_below','until_daily_accum_below')),
  repeat_accum_threshold numeric,     -- until_daily_accum_below일 때 임계값 (mm/cm)
  -- heat 전용: 반복 판정 기준 'temp' | 'feels'
  heat_repeat_basis text check (heat_repeat_basis in ('temp','feels')),
  updated_at timestamptz not null default now()
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references departments(id) on delete restrict,
  name text not null,
  sort_order int not null default 0
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,              -- auth.users 매핑
  name text not null,
  email text unique not null,            -- 카카오워크 계정 이메일
  kakaowork_user_id text unique,         -- 카카오워크 내부 user id (발송용)
  department_id uuid references departments(id) on delete set null,  -- null = 미지정
  role emp_role not null default 'staff',
  created_at timestamptz not null default now()
);

-- 부서별 수신 담당자 (지침 발송 대상)
create table recipients (
  department_id uuid not null references departments(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  primary key (department_id, employee_id)
);

-- 특보 감지 시 승인 요청을 받는 사업부장급
create table alert_recipients (
  employee_id uuid primary key references employees(id) on delete cascade
);

create table action_guidelines (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete cascade,
  kind event_kind not null,
  grade event_grade not null,
  staff_actions text[] not null default '{}',   -- 인력 조정 지침 (불릿)
  guest_notice text not null default '',        -- 고객 안내 멘트
  updated_at timestamptz not null default now(),
  updated_by uuid references employees(id),
  unique (department_id, kind, grade)
);

create table weather_observations (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null unique,      -- 정시
  rain_mm_per_hr numeric, temp_c numeric, wind_ms numeric, humidity_pct numeric,
  snow_new_cm numeric,                          -- 파생: 신적설 환산
  feels_c numeric,                              -- 파생: 체감온도
  raw jsonb,
  missing boolean not null default false        -- 수집 실패 시 true (파생값 null)
);

create table weather_events (
  id uuid primary key default gen_random_uuid(),
  kind event_kind not null,
  grade event_grade not null,
  status event_status not null default 'PENDING_APPROVAL',
  detected_at timestamptz not null default now(),
  closed_at timestamptz,
  trigger_observation_id bigint references weather_observations(id),
  approved_by uuid references employees(id),
  approved_at timestamptz,
  last_reminded_at timestamptz,
  repeat_count int not null default 0
);
-- 동일 종류·등급 열린 특보는 1건만
create unique index one_open_event on weather_events(kind, grade)
  where status in ('PENDING_APPROVAL','ACTIVE');

create table messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references weather_events(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','approved')),
  -- [{department_id, department_name, grade, staff_actions: text[],
  --   guest_notice, recipients: [{employee_id, name, kakaowork_user_id}], selected: bool}]
  content jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references employees(id)
);

create table dispatches (
  id bigint generated always as identity primary key,
  message_id uuid not null references messages(id),
  event_id uuid not null references weather_events(id),
  sent_at timestamptz not null default now(),
  channel text not null default 'kakaowork',
  repeat_no int not null default 1,
  is_test boolean not null default false,
  -- [{employee_id, name, ok: bool, error?: text}]
  results jsonb not null
);

create table heartbeats (
  name text primary key,                -- 'weather-tick' | 'remind-tick'
  last_run_at timestamptz not null,
  ok boolean not null default true,
  note text
);
