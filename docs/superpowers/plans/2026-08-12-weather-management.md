# 날씨경영 (특보 발송 시스템) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기상청 관측값으로 위험기상(폭우·폭설·강풍·폭염) 특보를 감지하고, 사업부장 승인 후 부서별 행동 지침을 카카오워크로 발송하는 Supabase 서버리스 시스템 + React 관리 콘솔.

**Architecture:** Supabase 올인 — Postgres(+RLS)가 데이터·권한, pg_cron→Edge Functions(Deno)가 감지·재알림·발송, React SPA(Vite)가 콘솔. 판정·조합 로직은 순수 함수로 분리해 Deno test로 검증. 외부 연동(기상청·카카오워크)은 어댑터 인터페이스 뒤에 둔다.

**Tech Stack:** Supabase (Postgres, Auth, Edge Functions, pg_cron, pg_net) · Deno/TypeScript · React 18 + Vite + TypeScript + Tailwind CSS v4 + react-router-dom · @supabase/supabase-js v2 · 기상청 단기예보 조회서비스(초단기실황) · 카카오워크 Web API

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-12-weather-management-design.md` — 결정 1~15가 규범. 충돌 시 스펙 우선.
- UI 용어는 "특보" (이벤트 금지). 코드 식별자는 영문 (`weather_events` 등).
- 인증은 카카오워크 OAuth 전용. 이메일 로그인 없음. 최초 관리자는 env `ADMIN_KAKAOWORK_ID`.
- 역할 3종: `admin`(시스템관리자) / `approver`(사업부장) / `staff`(실무자). RLS는 스펙 §6 CRUD 매트릭스 그대로.
- 발송 이력(`dispatches`) 삭제 기능 금지 (감사 보존).
- 메시지는 발송 시점 스냅샷(`messages.content` JSON) 기준. 마스터 수정과 격리.
- 특보 상태기계: `PENDING_APPROVAL → ACTIVE → RESOLVED | ESCALATED`, 무시 시 `DISMISSED`(해제 조건 충족까지 동일 종류·등급 재감지 금지).
- 디자인: `design/weather-management.pen` + `DESIGN-apple.md` 토큰. Action Blue #0066CC 단일 액센트(세브리티 주황/빨강/초록은 뱃지·점 소면적만), 폰트 Noto Sans KR + Inter, 웨이트 300/400/600.
- 모든 비밀키는 env로만: `KMA_API_KEY`, `KAKAOWORK_BOT_KEY`, `ADMIN_KAKAOWORK_ID`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.
- Edge Function 핸들러는 얇게, 로직은 `supabase/functions/_shared/`의 순수 함수로. 순수 함수엔 반드시 Deno test.
- 모든 페이지 반응형 필수 (Tailwind 브레이크포인트, 콘텐츠 1120px→모바일 단일 컬럼 스택). 특히 ③ 초안 검토·발송은 모바일(390px)에서 승인 CTA가 접근 가능해야 한다 — 사업부장 야간 폰 승인이 핵심 시나리오.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (전체 조감)

```
Weather/
├── apps/web/                          # React 콘솔 (Vite)
│   ├── index.html  vite.config.ts  tailwind.config.ts  package.json
│   └── src/
│       ├── main.tsx  App.tsx  routes.tsx
│       ├── styles/tokens.css          # DESIGN-apple 토큰 (CSS 변수)
│       ├── lib/supabase.ts            # 클라이언트 싱글턴
│       ├── lib/api.ts                 # Edge Function 호출 (send/test-send)
│       ├── lib/types.ts               # DB row 타입
│       ├── auth/AuthProvider.tsx  auth/RequireRole.tsx
│       ├── components/ (GlobalNav, SubNav, Button, Badge, Toggle, Chip,
│       │                SegmentPill, EmptyState, StatusDot, Modal)
│       └── pages/ (Login, Dashboard, Criteria, Guidelines, EventReview,
│                   History, Settings, Employees)
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 0001_schema.sql  0002_rls.sql  0003_cron.sql
│   ├── seed.sql
│   └── functions/
│       ├── _shared/ (types.ts, db.ts, kma.ts, derive.ts, engine.ts,
│       │             template.ts, channel.ts, kakaowork.ts, auth.ts)
│       │   └── *_test.ts              # Deno tests
│       ├── weather-tick/index.ts
│       ├── remind-tick/index.ts
│       ├── send/index.ts              # 승인·발송 + 테스트발송(mode=test)
│       └── auth-kakaowork/index.ts
├── .env.example
└── README.md
```

---

### Task 1: 레포 스캐폴드 + Supabase 프로젝트 초기화

**Files:**
- Create: `supabase/config.toml` (supabase init 산출물), `.env.example`, `README.md`(뼈대), `.gitignore`(보강)

**Interfaces:**
- Produces: 로컬 스택 구동 명령 `supabase start`, env 키 이름 전체 목록 (Global Constraints의 5개 + `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`)

- [ ] **Step 1: Supabase CLI 확인 및 초기화**

Run: `command -v supabase || brew install supabase/tap/supabase` 후 `supabase init`
Expected: `supabase/config.toml` 생성

- [ ] **Step 2: .env.example 작성**

```bash
# --- Supabase (supabase start 출력값 / 프로덕션은 대시보드에서) ---
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
# --- 기상청 공공데이터포털 (data.go.kr, 단기예보 조회서비스 일반 인증키) ---
KMA_API_KEY=<decoding key>
# --- 카카오워크 봇 (워크스페이스 관리자 콘솔에서 발급) ---
KAKAOWORK_BOT_KEY=<bot app key>
KAKAOWORK_CLIENT_ID=<oauth client id>
KAKAOWORK_CLIENT_SECRET=<oauth client secret>
# 최초 시스템 관리자의 카카오워크 계정 이메일
ADMIN_KAKAOWORK_ID=admin@company.com
# pg_cron → edge function 호출 인증용 임의 랜덤 문자열
CRON_SECRET=<random string>
# 웹 콘솔 URL (OAuth 리다이렉트·딥링크 생성용)
APP_BASE_URL=http://localhost:5173
```

- [ ] **Step 3: .gitignore 보강**

기존 `.gitignore`에 추가: `supabase/.temp/`, `apps/web/dist/`, `.env`

- [ ] **Step 4: 로컬 스택 기동 확인**

Run: `supabase start`
Expected: API URL/anon key/service_role key 출력 (README에 기록할 값)

- [ ] **Step 5: Commit**

```bash
git add supabase/config.toml .env.example .gitignore README.md
git commit -m "chore: supabase 프로젝트 초기화 및 env 스캐폴드"
```

---

### Task 2: DB 스키마 마이그레이션 + 시드

**Files:**
- Create: `supabase/migrations/0001_schema.sql`, `supabase/seed.sql`

**Interfaces:**
- Produces: 아래 테이블·enum 전부. 이후 모든 태스크가 이 스키마를 전제.
  - enum `event_kind`: `'rain'|'snow'|'wind'|'heat'`
  - enum `event_grade`: `'watch'|'warning'` (주의보/경보)
  - enum `event_status`: `'PENDING_APPROVAL'|'ACTIVE'|'RESOLVED'|'ESCALATED'|'DISMISSED'`
  - enum `emp_role`: `'admin'|'approver'|'staff'`

- [ ] **Step 1: 0001_schema.sql 작성**

```sql
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
```

- [ ] **Step 2: seed.sql 작성 (PPT 조직 + 기상청 특보 기준 프리셋)**

```sql
insert into site_settings (id) values (1) on conflict do nothing;

insert into weather_criteria (kind, grade, threshold) values
 ('rain','watch','{"rain_mm_per_hr":20}'), ('rain','warning','{"rain_mm_per_hr":50}'),
 ('snow','watch','{"snow_cm":5}'),         ('snow','warning','{"snow_cm":20}'),
 ('wind','watch','{"wind_ms":14}'),        ('wind','warning','{"wind_ms":21}'),
 ('heat','watch','{"temp_c":33,"feels_c":31}'), ('heat','warning','{"temp_c":35,"feels_c":33}');

insert into alert_settings (kind, repeat_policy, repeat_accum_threshold, heat_repeat_basis) values
 ('rain','until_daily_accum_below',80,null), ('snow','hourly_until_below',null,null),
 ('wind','hourly_until_below',null,null),    ('heat','hourly_until_below',null,'feels');

-- 부서 트리 (PPT 조직도)
with roots as (
  insert into departments (name, sort_order) values
   ('사업지원',1),('리조트',2),('레포츠 · 화담숲',3),('골프',4)
  returning id, name
)
insert into departments (parent_id, name, sort_order)
select r.id, c.name, c.ord from roots r
join (values
 ('사업지원','안전',1),('사업지원','인프라 운영',2),
 ('리조트','객실',1),('리조트','영업',2),('리조트','식음',3),('리조트','조리',4),
 ('레포츠 · 화담숲','레포츠',1),('레포츠 · 화담숲','화담숲',2),
 ('골프','운영기획',1),('골프','경기',2),('골프','조리',3),('골프','서비스 운영',4)
) as c(root, name, ord) on c.root = r.name;

-- 예시 지침 (곤지암 목업 — 객실/조리(리조트)/안전 × 폭우 주의보)
-- 주의: '조리'는 리조트·골프 두 곳에 존재하므로 반드시 부모 부서로 한정해 조인한다
insert into action_guidelines (department_id, kind, grade, staff_actions, guest_notice)
select d.id, 'rain', 'watch', a.actions, a.notice
from departments d
join departments p on p.id = d.parent_id
join (values
 ('리조트','객실', array['비에 젖은 고객을 위해 객실 별 추가 수건 2개 배포','고객 지연 도착에 대비하여 체크인 혼잡 예상 시간 인력 추가 투입'],
  '안녕하세요, 곤지암리조트입니다. 오늘 호우 예보로 야외 시설 운영이 제한됩니다. 실내 편의시설은 정상 운영 중입니다.'),
 ('리조트','조리', array['외부 음식 구매가 어려워짐에 따라 내부 식사 인원 증가 예상, 전처리 식자재 점검','우천 시 배송 지연 대비 당일 필수 식자재 우선 발주'], ''),
 ('사업지원','안전', array['옥외 배수로 및 맨홀 점검, 침수 취약 구역 안전선 설치','우천 시 미끄럼 주의 안내판 주요 동선 배치'], '')
) as a(root, dept, actions, notice) on d.name = a.dept and p.name = a.root;
```

- [ ] **Step 3: 마이그레이션 적용 및 검증**

Run: `supabase db reset` (migrations+seed 적용)
Expected: 에러 없음. `psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" -c "select count(*) from departments"` → 16

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_schema.sql supabase/seed.sql
git commit -m "feat: DB 스키마 및 시드 (부서 트리·특보 기준 프리셋·예시 지침)"
```

---

### Task 3: RLS 정책 + 역할 헬퍼 + 정책 테스트

**Files:**
- Create: `supabase/migrations/0002_rls.sql`, `supabase/functions/_shared/rls_test.ts`

**Interfaces:**
- Produces: SQL 함수 `current_emp_role() returns emp_role`, `current_emp_id() returns uuid` — 이후 모든 정책·쿼리에서 사용

- [ ] **Step 1: 0002_rls.sql 작성**

```sql
create function current_emp_id() returns uuid
language sql stable security definer set search_path = public as
$$ select id from employees where auth_user_id = auth.uid() $$;

create function current_emp_role() returns emp_role
language sql stable security definer set search_path = public as
$$ select role from employees where auth_user_id = auth.uid() $$;

alter table site_settings enable row level security;
alter table weather_criteria enable row level security;
alter table alert_settings enable row level security;
alter table departments enable row level security;
alter table employees enable row level security;
alter table recipients enable row level security;
alter table alert_recipients enable row level security;
alter table action_guidelines enable row level security;
alter table weather_observations enable row level security;
alter table weather_events enable row level security;
alter table messages enable row level security;
alter table dispatches enable row level security;
alter table heartbeats enable row level security;

-- 읽기: 로그인한 전 역할 (지침은 staff는 자기 부서만)
create policy r_all on site_settings for select using (auth.uid() is not null);
create policy r_all on weather_criteria for select using (auth.uid() is not null);
create policy r_all on alert_settings for select using (auth.uid() is not null);
create policy r_all on departments for select using (auth.uid() is not null);
create policy r_all on employees for select using (auth.uid() is not null);
create policy r_all on recipients for select using (auth.uid() is not null);
create policy r_all on alert_recipients for select using (auth.uid() is not null);
create policy r_all on weather_observations for select using (auth.uid() is not null);
create policy r_all on weather_events for select using (auth.uid() is not null);
create policy r_all on dispatches for select using (auth.uid() is not null);
create policy r_all on heartbeats for select using (auth.uid() is not null);
create policy r_guidelines on action_guidelines for select using (
  current_emp_role() in ('admin','approver')
  or department_id = (select department_id from employees where id = current_emp_id())
);
create policy r_messages on messages for select using (auth.uid() is not null);

-- 쓰기: admin = 마스터 전체
create policy w_admin on site_settings for update using (current_emp_role() = 'admin');
create policy w_admin on weather_criteria for update using (current_emp_role() = 'admin');
create policy w_admin on alert_settings for update using (current_emp_role() = 'admin');
create policy w_admin_ins on departments for insert with check (current_emp_role() = 'admin');
create policy w_admin_upd on departments for update using (current_emp_role() = 'admin');
create policy w_admin_del on departments for delete using (current_emp_role() = 'admin');
create policy w_admin_ins on employees for insert with check (current_emp_role() = 'admin');
create policy w_admin_upd on employees for update using (current_emp_role() = 'admin');
create policy w_admin_del on employees for delete using (current_emp_role() = 'admin');
create policy w_admin_all on recipients for all using (current_emp_role() = 'admin');
create policy w_admin_all on alert_recipients for all using (current_emp_role() = 'admin');
create policy w_admin_all on action_guidelines for all using (current_emp_role() = 'admin');

-- approver: 초안 수정만 (발송·상태 전이는 send Edge Function이 service role로 수행)
create policy w_approver on messages for update
  using (current_emp_role() = 'approver') with check (current_emp_role() = 'approver');

-- dispatches: 클라이언트 쓰기 전면 금지 (Edge Function 전용) — insert/update/delete 정책 없음
```

- [ ] **Step 2: RLS 테스트 작성 (`rls_test.ts`)**

로컬 스택 대상. service role로 사용자 3명(admin/approver/staff) + employees 매핑을 만들고, 각자의 JWT 클라이언트로 금지 동작이 거부되는지 확인.

```typescript
import { createClient } from "npm:@supabase/supabase-js@2";
import { assertEquals, assert } from "jsr:@std/assert";

const URL = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL, SR);

async function makeUser(email: string, role: string) {
  const { data: u } = await admin.auth.admin.createUser({ email, password: "pw123456!", email_confirm: true });
  await admin.from("employees").insert({ auth_user_id: u.user!.id, name: email, email, role });
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: "pw123456!" });
  return c;
}

Deno.test("RLS: staff는 기준을 수정할 수 없다", async () => {
  const staff = await makeUser("staff@t.co", "staff");
  const { data } = await staff.from("weather_criteria")
    .update({ threshold: { rain_mm_per_hr: 1 } }).eq("kind", "rain").eq("grade", "watch").select();
  assertEquals(data, []);   // RLS로 0행 매칭
});

Deno.test("RLS: approver는 messages를 수정할 수 있으나 dispatches는 쓸 수 없다", async () => {
  const ap = await makeUser("ap@t.co", "approver");
  const { error } = await ap.from("dispatches")
    .insert({ message_id: crypto.randomUUID(), event_id: crypto.randomUUID(), results: [] });
  assert(error !== null);
});

Deno.test("RLS: admin은 부서를 생성할 수 있다", async () => {
  const ad = await makeUser("adm@t.co", "admin");
  const { error } = await ad.from("departments").insert({ name: "테스트부서" });
  assertEquals(error, null);
});
```

- [ ] **Step 3: 테스트 실행 — 실패 확인 (마이그레이션 미적용 상태라면) 후 적용·통과**

Run: `supabase db reset && supabase status -o env > .env.test`
Run: `set -a; source .env.test; set +a; deno test --allow-net --allow-env supabase/functions/_shared/rls_test.ts`
Expected: 3 tests PASS

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_rls.sql supabase/functions/_shared/rls_test.ts
git commit -m "feat: RLS 정책 (역할 3종 CRUD 매트릭스) + 정책 테스트"
```

---

### Task 4: 기상청 초단기실황 클라이언트 (`kma.ts`)

**Files:**
- Create: `supabase/functions/_shared/kma.ts`, `supabase/functions/_shared/kma_test.ts`

**Interfaces:**
- Produces:
  - `type KmaObservation = { observedAt: Date; rainMmPerHr: number|null; tempC: number|null; windMs: number|null; humidityPct: number|null; pty: number|null }`
  - `baseDateTime(now: Date): { baseDate: string; baseTime: string }` — 초단기실황은 정시 관측·10분 후 제공이므로 now가 정시+10분 이전이면 한 시간 전 정시 사용
  - `parseKmaResponse(json: unknown): KmaObservation` — 카테고리 RN1/T1H/WSD/REH/PTY 추출
  - `fetchObservation(apiKey: string, nx: number, ny: number, now: Date, fetchFn?: typeof fetch): Promise<KmaObservation>` — 재시도 2회, 최종 실패 시 throw

- [ ] **Step 1: 실패하는 테스트 작성 (`kma_test.ts`)**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { baseDateTime, parseKmaResponse } from "./kma.ts";

Deno.test("baseDateTime: 정시+10분 전이면 이전 시각", () => {
  assertEquals(baseDateTime(new Date("2026-08-12T08:05:00+09:00")),
    { baseDate: "20260812", baseTime: "0700" });
  assertEquals(baseDateTime(new Date("2026-08-12T08:20:00+09:00")),
    { baseDate: "20260812", baseTime: "0800" });
  assertEquals(baseDateTime(new Date("2026-08-12T00:05:00+09:00")),
    { baseDate: "20260811", baseTime: "2300" });
});

Deno.test("parseKmaResponse: 카테고리 추출", () => {
  const json = { response: { header: { resultCode: "00" }, body: { items: { item: [
    { category: "RN1", obsrValue: "32.5", baseDate: "20260812", baseTime: "0800" },
    { category: "T1H", obsrValue: "28.4" }, { category: "WSD", obsrValue: "9.2" },
    { category: "REH", obsrValue: "83" },  { category: "PTY", obsrValue: "1" },
  ] } } } };
  const o = parseKmaResponse(json);
  assertEquals(o.rainMmPerHr, 32.5);
  assertEquals(o.tempC, 28.4);
  assertEquals(o.windMs, 9.2);
  assertEquals(o.humidityPct, 83);
  assertEquals(o.pty, 1);
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `deno test supabase/functions/_shared/kma_test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: `kma.ts` 구현**

```typescript
export type KmaObservation = {
  observedAt: Date; rainMmPerHr: number|null; tempC: number|null;
  windMs: number|null; humidityPct: number|null; pty: number|null;
};

const KST = 9 * 60 * 60 * 1000;

export function baseDateTime(now: Date): { baseDate: string; baseTime: string } {
  const kst = new Date(now.getTime() + KST);
  if (kst.getUTCMinutes() < 10) kst.setUTCHours(kst.getUTCHours() - 1);
  const y = kst.getUTCFullYear(), m = String(kst.getUTCMonth()+1).padStart(2,"0"),
        d = String(kst.getUTCDate()).padStart(2,"0"), h = String(kst.getUTCHours()).padStart(2,"0");
  return { baseDate: `${y}${m}${d}`, baseTime: `${h}00` };
}

function num(items: Array<{category:string; obsrValue:string}>, cat: string): number|null {
  const v = items.find(i => i.category === cat)?.obsrValue;
  return v === undefined ? null : Number(v);
}

export function parseKmaResponse(json: any): KmaObservation {
  if (json?.response?.header?.resultCode !== "00") {
    throw new Error(`KMA error: ${JSON.stringify(json?.response?.header)}`);
  }
  const items = json.response.body.items.item as Array<{category:string; obsrValue:string; baseDate?:string; baseTime?:string}>;
  const bd = items[0]?.baseDate, bt = items[0]?.baseTime ?? "0000";
  const observedAt = bd
    ? new Date(`${bd.slice(0,4)}-${bd.slice(4,6)}-${bd.slice(6,8)}T${bt.slice(0,2)}:00:00+09:00`)
    : new Date();
  return { observedAt, rainMmPerHr: num(items,"RN1"), tempC: num(items,"T1H"),
           windMs: num(items,"WSD"), humidityPct: num(items,"REH"), pty: num(items,"PTY") };
}

const BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";

export async function fetchObservation(
  apiKey: string, nx: number, ny: number, now: Date, fetchFn: typeof fetch = fetch,
): Promise<KmaObservation> {
  const { baseDate, baseTime } = baseDateTime(now);
  const url = `${BASE}?serviceKey=${encodeURIComponent(apiKey)}&dataType=JSON&numOfRows=10&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseKmaResponse(await res.json());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test supabase/functions/_shared/kma_test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/kma.ts supabase/functions/_shared/kma_test.ts
git commit -m "feat: 기상청 초단기실황 클라이언트 (base_time 계산·파싱·재시도)"
```

---

### Task 5: 파생값 계산 (`derive.ts`) — 체감온도·신적설 환산

**Files:**
- Create: `supabase/functions/_shared/derive.ts`, `supabase/functions/_shared/derive_test.ts`

**Interfaces:**
- Produces:
  - `feelsLikeC(tempC: number, humidityPct: number, windMs: number): number` — 기온 20℃ 이상이면 기상청 여름철 체감온도(Stull 습구온도 기반), 미만이면 풍속 기반 체감온도(풍속 4.8km/h 미만은 기온 그대로). 소수 1자리 반올림
  - `snowNewCm(rainMmPerHr: number|null, pty: number|null): number|null` — PTY가 눈 계열(2,3,6,7)일 때 강수량 1mm ≈ 신적설 1cm 근사(파일럿 단순화 가정 명시), 그 외 0, 입력 null이면 null

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { feelsLikeC, snowNewCm } from "./derive.ts";

Deno.test("여름 체감온도: 33℃/60%/2m·s ≈ 33.5±0.5", () => {
  assertAlmostEquals(feelsLikeC(33, 60, 2), 33.5, 0.5);
});
Deno.test("겨울 체감온도: -10℃/풍속 5m·s ≈ -17.4±0.5", () => {
  assertAlmostEquals(feelsLikeC(-10, 50, 5), -17.4, 0.5);
});
Deno.test("신적설 환산: 눈(PTY=3)이면 3mm→3cm, 비(PTY=1)면 0, null이면 null", () => {
  assertEquals(snowNewCm(3, 3), 3);
  assertEquals(snowNewCm(3, 1), 0);
  assertEquals(snowNewCm(null, 3), null);
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `deno test supabase/functions/_shared/derive_test.ts`
Expected: FAIL

- [ ] **Step 3: `derive.ts` 구현**

```typescript
// 기상청 여름철 체감온도 (Stull 습구온도 근사 기반)
function wetBulbStull(t: number, rh: number): number {
  return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(t + rh) - Math.atan(rh - 1.67633)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
}

export function feelsLikeC(tempC: number, humidityPct: number, windMs: number): number {
  let v: number;
  if (tempC >= 20) {
    const tw = wetBulbStull(tempC, humidityPct);
    v = -0.2442 + 0.55399 * tw + 0.45535 * tempC - 0.0022 * tw * tw + 0.00278 * tw * tempC + 3.0;
  } else {
    const vKmh = windMs * 3.6;
    v = vKmh >= 4.8
      ? 13.12 + 0.6215 * tempC - 11.37 * Math.pow(vKmh, 0.16) + 0.3965 * tempC * Math.pow(vKmh, 0.16)
      : tempC;
  }
  return Math.round(v * 10) / 10;
}

const SNOW_PTY = new Set([2, 3, 6, 7]); // 진눈깨비·눈·빗방울눈날림·눈날림

export function snowNewCm(rainMmPerHr: number|null, pty: number|null): number|null {
  if (rainMmPerHr === null) return null;
  return SNOW_PTY.has(pty ?? 0) ? rainMmPerHr : 0; // 1mm ≈ 1cm 근사 (파일럿 가정)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test supabase/functions/_shared/derive_test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/derive.ts supabase/functions/_shared/derive_test.ts
git commit -m "feat: 체감온도·신적설 파생값 계산"
```

---

### Task 6: 특보 판정 엔진 (`engine.ts`) — 시스템의 심장

**Files:**
- Create: `supabase/functions/_shared/types.ts`, `supabase/functions/_shared/engine.ts`, `supabase/functions/_shared/engine_test.ts`

**Interfaces:**
- Consumes: Task 5의 파생값이 포함된 관측 스냅샷
- Produces (weather-tick이 그대로 실행할 액션 목록):

```typescript
// types.ts
export type Kind = "rain"|"snow"|"wind"|"heat";
export type Grade = "watch"|"warning";
export type Status = "PENDING_APPROVAL"|"ACTIVE"|"RESOLVED"|"ESCALATED"|"DISMISSED";

export type Obs = { rain: number|null; snowNew: number|null; snowToday: number|null;
  rainToday: number|null; temp: number|null; feels: number|null; wind: number|null };

export type Criterion = { kind: Kind; grade: Grade; threshold: Record<string, number> };
export type AlertSetting = { kind: Kind; enabled: boolean;
  repeatPolicy: "once"|"hourly_until_below"|"until_daily_accum_below";
  repeatAccumThreshold: number|null; heatRepeatBasis: "temp"|"feels"|null };
export type OpenEvent = { id: string; kind: Kind; grade: Grade; status: Status;
  dismissedOpen?: boolean };  // DISMISSED이지만 해제조건 미충족 → 재감지 금지 대상

export type Action =
  | { type: "create"; kind: Kind; grade: Grade }
  | { type: "escalate"; eventId: string; kind: Kind }
  | { type: "repeat"; eventId: string; kind: Kind; grade: Grade }
  | { type: "resolve"; eventId: string; kind: Kind; grade: Grade };
```

  - `evaluate(obs: Obs, criteria: Criterion[], settings: AlertSetting[], open: OpenEvent[]): Action[]`

**판정 규칙 (스펙 §5 그대로 — 아래 테스트가 이 규칙의 사양):**
1. `enabled=false`인 종류는 어떤 액션도 내지 않는다.
2. 측정값 `null`(결측)인 종류는 판정하지 않는다 (오탐 방지).
3. 초과 판정: rain→`obs.rain ≥ threshold.rain_mm_per_hr`, snow→`obs.snowToday ≥ threshold.snow_cm`, wind→`obs.wind ≥ threshold.wind_ms`, heat→`obs.temp ≥ threshold.temp_c` OR `obs.feels ≥ threshold.feels_c`.
4. warning 기준 충족: 같은 kind의 열린 watch가 있으면 `escalate`, 열린 warning이 없으면 `create(warning)`. watch만 충족 시 열린 것 없으면 `create(watch)`.
5. 같은 kind·grade가 PENDING/ACTIVE로 열려 있으면 `create` 금지. DISMISSED이고 해제조건 미충족(`dismissedOpen`)이어도 `create` 금지.
6. `repeat`: ACTIVE + 정책 once 아님 + 반복조건 충족. `hourly_until_below`=현재도 기준 이상(heat는 `heatRepeatBasis` 기준값만 비교), `until_daily_accum_below`=일 누적(rainToday/snowToday)이 `repeatAccumThreshold` 초과.
7. `resolve`: 열린(PENDING_APPROVAL·ACTIVE·DISMISSED-open 모두) 특보의 해제조건 충족 — `hourly_until_below`·`once`=기준 미달, `until_daily_accum_below`=누적 임계 이하 그리고 기준 미달. PENDING이 resolve되는 경우의 알림 분기는 weather-tick(Task 10)이 담당: 승인된 메시지가 있으면 부서 해제 알림, 없으면(초안 대기 중 자동 종료) alert_recipients에게 자동 종료 알림.
8. 같은 tick에서 `escalate`된 watch에는 `repeat`/`resolve`를 내지 않는다.

- [ ] **Step 1: 실패하는 테스트 작성 (`engine_test.ts`) — 규칙 1~8 각 1케이스 이상**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { evaluate } from "./engine.ts";
import type { Obs, Criterion, AlertSetting, OpenEvent } from "./types.ts";

const CRIT: Criterion[] = [
  { kind:"rain", grade:"watch",   threshold:{ rain_mm_per_hr:20 } },
  { kind:"rain", grade:"warning", threshold:{ rain_mm_per_hr:50 } },
  { kind:"heat", grade:"watch",   threshold:{ temp_c:33, feels_c:31 } },
];
const SET: AlertSetting[] = [
  { kind:"rain", enabled:true, repeatPolicy:"until_daily_accum_below", repeatAccumThreshold:80, heatRepeatBasis:null },
  { kind:"heat", enabled:true, repeatPolicy:"hourly_until_below", repeatAccumThreshold:null, heatRepeatBasis:"feels" },
];
const base: Obs = { rain:null, snowNew:null, snowToday:null, rainToday:null, temp:null, feels:null, wind:null };

Deno.test("기준 초과 시 watch 생성", () => {
  assertEquals(evaluate({ ...base, rain:32.5, rainToday:40 }, CRIT, SET, []),
    [{ type:"create", kind:"rain", grade:"watch" }]);
});
Deno.test("열린 watch 존재 시 중복 생성 없음 + 누적 미달이면 repeat도 없음", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:25, rainToday:40 }, CRIT, SET, open), []);
});
Deno.test("누적 초과면 repeat", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:25, rainToday:90 }, CRIT, SET, open),
    [{ type:"repeat", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("warning 돌파 시 watch escalate (repeat/resolve 미발행)", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:55, rainToday:90 }, CRIT, SET, open),
    [{ type:"escalate", eventId:"e1", kind:"rain" }]);
});
Deno.test("기준 미달 + 누적 이하면 resolve", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:2, rainToday:50 }, CRIT, SET, open),
    [{ type:"resolve", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("DISMISSED-open은 재감지 금지, 해제조건 충족 시 resolve만", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"DISMISSED", dismissedOpen:true }];
  assertEquals(evaluate({ ...base, rain:25, rainToday:90 }, CRIT, SET, open), []);
  assertEquals(evaluate({ ...base, rain:2, rainToday:50 }, CRIT, SET, open),
    [{ type:"resolve", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("heat는 기온 OR 체감 — 체감만 초과해도 감지", () => {
  assertEquals(evaluate({ ...base, temp:30, feels:31.5 }, CRIT, SET, []),
    [{ type:"create", kind:"heat", grade:"watch" }]);
});
Deno.test("결측은 판정 안 함 / enabled=false는 무시", () => {
  assertEquals(evaluate(base, CRIT, SET, []), []);
  const off = SET.map(s => s.kind==="rain" ? { ...s, enabled:false } : s);
  assertEquals(evaluate({ ...base, rain:99, rainToday:99 }, CRIT, off, []), []);
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `deno test supabase/functions/_shared/engine_test.ts`
Expected: FAIL

- [ ] **Step 3: `engine.ts` 구현**

```typescript
import type { Obs, Criterion, AlertSetting, OpenEvent, Action, Kind, Grade } from "./types.ts";

function exceeds(kind: Kind, obs: Obs, th: Record<string, number>): boolean|null {
  switch (kind) {
    case "rain": return obs.rain === null ? null : obs.rain >= th.rain_mm_per_hr;
    case "snow": return obs.snowToday === null ? null : obs.snowToday >= th.snow_cm;
    case "wind": return obs.wind === null ? null : obs.wind >= th.wind_ms;
    case "heat": {
      if (obs.temp === null && obs.feels === null) return null;
      return (obs.temp !== null && obs.temp >= th.temp_c)
          || (obs.feels !== null && obs.feels >= th.feels_c);
    }
  }
}

function repeatConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "once") return false;
  if (s.repeatPolicy === "until_daily_accum_below") {
    const accum = s.kind === "snow" ? obs.snowToday : obs.rainToday;
    return accum !== null && s.repeatAccumThreshold !== null && accum > s.repeatAccumThreshold;
  }
  if (s.kind === "heat") {
    const th = crit.threshold, basis = s.heatRepeatBasis ?? "temp";
    const v = basis === "feels" ? obs.feels : obs.temp;
    const t = basis === "feels" ? th.feels_c : th.temp_c;
    return v !== null && v >= t;
  }
  return exceeds(s.kind, obs, crit.threshold) === true;
}

function resolveConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "until_daily_accum_below") {
    const accum = s.kind === "snow" ? obs.snowToday : obs.rainToday;
    return accum !== null && s.repeatAccumThreshold !== null
      && accum <= s.repeatAccumThreshold && exceeds(s.kind, obs, crit.threshold) === false;
  }
  return exceeds(s.kind, obs, crit.threshold) === false;
}

export function evaluate(obs: Obs, criteria: Criterion[], settings: AlertSetting[], open: OpenEvent[]): Action[] {
  const actions: Action[] = [];
  const kinds: Kind[] = ["rain","snow","wind","heat"];
  for (const kind of kinds) {
    const s = settings.find(x => x.kind === kind);
    if (!s || !s.enabled) continue;
    const watch = criteria.find(c => c.kind === kind && c.grade === "watch");
    const warning = criteria.find(c => c.kind === kind && c.grade === "warning");
    const openOf = (g: Grade) => open.find(e => e.kind === kind && e.grade === g
      && (e.status === "PENDING_APPROVAL" || e.status === "ACTIVE"
          || (e.status === "DISMISSED" && e.dismissedOpen)));

    const warnHit = warning ? exceeds(kind, obs, warning.threshold) : null;
    const watchHit = watch ? exceeds(kind, obs, watch.threshold) : null;
    if (watchHit === null && warnHit === null) continue;

    const openWatch = openOf("watch"), openWarning = openOf("warning");
    let escalated = false;

    if (warnHit === true) {
      if (openWatch && openWatch.status !== "DISMISSED") {
        actions.push({ type:"escalate", eventId: openWatch.id, kind }); escalated = true;
      } else if (!openWarning) actions.push({ type:"create", kind, grade:"warning" });
    } else if (watchHit === true && !openWatch && !openWarning) {
      actions.push({ type:"create", kind, grade:"watch" });
    }

    for (const [ev, crit] of [[openWatch, watch], [openWarning, warning]] as const) {
      if (!ev || !crit) continue;
      if (escalated && ev.grade === "watch") continue;
      if (ev.status === "ACTIVE" && repeatConditionMet(s, obs, crit)) {
        actions.push({ type:"repeat", eventId: ev.id, kind, grade: ev.grade });
      } else if (resolveConditionMet(s, obs, crit)) {
        actions.push({ type:"resolve", eventId: ev.id, kind, grade: ev.grade });
      }
    }
  }
  return actions;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test supabase/functions/_shared/engine_test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/types.ts supabase/functions/_shared/engine.ts supabase/functions/_shared/engine_test.ts
git commit -m "feat: 특보 판정 엔진 (감지·격상·반복·해제·무시 규칙)"
```

---

### Task 7: 초안 조합 (`template.ts`)

**Files:**
- Create: `supabase/functions/_shared/template.ts`, `supabase/functions/_shared/template_test.ts`

**Interfaces:**
- Consumes: `action_guidelines`·`recipients` 조회 결과
- Produces:
  - `type DeptBlock = { department_id: string; department_name: string; staff_actions: string[]; guest_notice: string; recipients: { employee_id: string; name: string; kakaowork_user_id: string|null }[]; selected: boolean }` — `messages.content` JSON의 원소 타입
  - `composeDraft(kind: Kind, grade: Grade, guidelines: GuidelineRow[], recipients: RecipientRow[]): DeptBlock[]`
  - `renderMessage(block: DeptBlock, ctx: { kindLabel: string; gradeLabel: string; siteName: string; obsLine: string }): string`
  - `KIND_LABEL: Record<Kind,string>` (폭우/폭설/강풍/폭염), `GRADE_LABEL: Record<Grade,string>` (주의보/경보)

- [ ] **Step 1: 실패하는 테스트 작성**

```typescript
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { composeDraft, renderMessage, KIND_LABEL, GRADE_LABEL } from "./template.ts";

const G = [{ department_id:"d1", department_name:"객실", kind:"rain", grade:"watch",
  staff_actions:["수건 2개 배포"], guest_notice:"안내문" }];
const R = [{ department_id:"d1", employee_id:"e1", name:"홍수진", kakaowork_user_id:"kw1" }];

Deno.test("composeDraft: 지침 있는 부서만 블록 생성 + 수신자 병합 + selected 기본 true", () => {
  const blocks = composeDraft("rain", "watch", G as any, R as any);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0].recipients[0].name, "홍수진");
  assertEquals(blocks[0].selected, true);
});
Deno.test("renderMessage: 부서·등급·지침·멘트 포함", () => {
  const [b] = composeDraft("rain", "watch", G as any, R as any);
  const msg = renderMessage(b, { kindLabel: KIND_LABEL.rain, gradeLabel: GRADE_LABEL.watch,
    siteName: "곤지암", obsLine: "시간당 32.5mm" });
  assertStringIncludes(msg, "폭우 주의보");
  assertStringIncludes(msg, "객실");
  assertStringIncludes(msg, "• 수건 2개 배포");
  assertStringIncludes(msg, "안내문");
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `deno test supabase/functions/_shared/template_test.ts`
Expected: FAIL

- [ ] **Step 3: `template.ts` 구현**

```typescript
import type { Kind, Grade } from "./types.ts";

export const KIND_LABEL: Record<Kind,string> = { rain:"폭우", snow:"폭설", wind:"강풍", heat:"폭염" };
export const GRADE_LABEL: Record<Grade,string> = { watch:"주의보", warning:"경보" };

export type GuidelineRow = { department_id: string; department_name: string;
  kind: Kind; grade: Grade; staff_actions: string[]; guest_notice: string };
export type RecipientRow = { department_id: string; employee_id: string;
  name: string; kakaowork_user_id: string|null };
export type DeptBlock = { department_id: string; department_name: string;
  staff_actions: string[]; guest_notice: string;
  recipients: { employee_id: string; name: string; kakaowork_user_id: string|null }[];
  selected: boolean };

export function composeDraft(kind: Kind, grade: Grade,
    guidelines: GuidelineRow[], recipients: RecipientRow[]): DeptBlock[] {
  return guidelines.filter(g => g.kind === kind && g.grade === grade).map(g => ({
    department_id: g.department_id, department_name: g.department_name,
    staff_actions: g.staff_actions, guest_notice: g.guest_notice,
    recipients: recipients.filter(r => r.department_id === g.department_id)
      .map(({ employee_id, name, kakaowork_user_id }) => ({ employee_id, name, kakaowork_user_id })),
    selected: true,
  }));
}

export function renderMessage(b: DeptBlock,
    ctx: { kindLabel: string; gradeLabel: string; siteName: string; obsLine: string }): string {
  const lines = [
    `[${ctx.siteName}] ${ctx.kindLabel} ${ctx.gradeLabel} — ${b.department_name} 행동 지침`,
    `현재 관측: ${ctx.obsLine}`, "",
    "인력 조정 지침",
    ...b.staff_actions.map(a => `• ${a}`),
  ];
  if (b.guest_notice) lines.push("", "고객 안내 멘트", b.guest_notice);
  return lines.join("\n");
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test supabase/functions/_shared/template_test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/template.ts supabase/functions/_shared/template_test.ts
git commit -m "feat: 부서 지침 초안 조합 및 메시지 렌더링"
```

---

### Task 8: 알림 채널 어댑터 (`channel.ts`, `kakaowork.ts`)

**Files:**
- Create: `supabase/functions/_shared/channel.ts`, `supabase/functions/_shared/kakaowork.ts`, `supabase/functions/_shared/kakaowork_test.ts`, `scripts/smoke-kakaowork.ts`

**Interfaces:**
- Produces:
  - `interface NotificationChannel { send(kakaoworkUserId: string, text: string): Promise<{ ok: boolean; error?: string }> }`
  - `class KakaoWorkChannel implements NotificationChannel` — `conversations.open`(1:1 방) → `messages.send`. 생성자 `(botKey: string, fetchFn?: typeof fetch)`
  - `class ConsoleChannel implements NotificationChannel` — 콘솔 로그 (로컬·CI)
  - `getChannel(env: { NOTIFY_CHANNEL?: string; KAKAOWORK_BOT_KEY?: string }): NotificationChannel` — `NOTIFY_CHANNEL=console` 또는 키 없으면 ConsoleChannel
  - `resolveKakaoworkUserIdByEmail(botKey: string, email: string, fetchFn?): Promise<string|null>` — `users.find_by_email` (가입 시 매핑)

- [ ] **Step 1: 실패하는 테스트 작성 (fetch 목)**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { KakaoWorkChannel, ConsoleChannel, getChannel } from "./kakaowork.ts";

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return ((url: string) => {
    const key = Object.keys(routes).find(k => String(url).includes(k))!;
    return Promise.resolve(new Response(JSON.stringify(routes[key]), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("KakaoWorkChannel: 방 열고 메시지 전송", async () => {
  const ch = new KakaoWorkChannel("key", mockFetch({
    "conversations.open": { success: true, conversation: { id: "c1" } },
    "messages.send": { success: true },
  }));
  assertEquals(await ch.send("kw1", "hello"), { ok: true });
});
Deno.test("KakaoWorkChannel: API 실패 시 ok=false + error", async () => {
  const ch = new KakaoWorkChannel("key", mockFetch({
    "conversations.open": { success: false, error: { message: "invalid user" } },
  }));
  const r = await ch.send("bad", "hello");
  assertEquals(r.ok, false);
});
Deno.test("getChannel: NOTIFY_CHANNEL=console이면 ConsoleChannel", () => {
  assertEquals(getChannel({ NOTIFY_CHANNEL: "console" }) instanceof ConsoleChannel, true);
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `deno test supabase/functions/_shared/kakaowork_test.ts`
Expected: FAIL

- [ ] **Step 3: 구현**

```typescript
// channel.ts
export interface NotificationChannel {
  send(kakaoworkUserId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}
```

```typescript
// kakaowork.ts
import type { NotificationChannel } from "./channel.ts";
export type { NotificationChannel };

const API = "https://api.kakaowork.com/v1";

export class KakaoWorkChannel implements NotificationChannel {
  constructor(private botKey: string, private fetchFn: typeof fetch = fetch) {}
  private async call(path: string, body: unknown): Promise<any> {
    const res = await this.fetchFn(`${API}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }
  async send(userId: string, text: string) {
    const open = await this.call("conversations.open", { user_id: userId });
    if (!open.success) return { ok: false, error: open.error?.message ?? "conversations.open failed" };
    const sent = await this.call("messages.send", { conversation_id: open.conversation.id, text });
    return sent.success ? { ok: true } : { ok: false, error: sent.error?.message ?? "messages.send failed" };
  }
}

export class ConsoleChannel implements NotificationChannel {
  async send(userId: string, text: string) {
    console.log(`[console-channel] to=${userId}\n${text}`);
    return { ok: true };
  }
}

export function getChannel(env: { NOTIFY_CHANNEL?: string; KAKAOWORK_BOT_KEY?: string }): NotificationChannel {
  if (env.NOTIFY_CHANNEL === "console" || !env.KAKAOWORK_BOT_KEY) return new ConsoleChannel();
  return new KakaoWorkChannel(env.KAKAOWORK_BOT_KEY);
}

export async function resolveKakaoworkUserIdByEmail(
  botKey: string, email: string, fetchFn: typeof fetch = fetch,
): Promise<string|null> {
  const res = await fetchFn(`${API}/users.find_by_email?email=${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${botKey}` },
  });
  const json = await res.json();
  return json.success ? String(json.user.id) : null;
}
```

`scripts/smoke-kakaowork.ts` (실키 수동 검증 — 스파이크 항목 1):

```typescript
import { KakaoWorkChannel, resolveKakaoworkUserIdByEmail } from "../supabase/functions/_shared/kakaowork.ts";
const key = Deno.env.get("KAKAOWORK_BOT_KEY")!;
const email = Deno.args[0];
const uid = await resolveKakaoworkUserIdByEmail(key, email);
if (!uid) { console.error("user not found:", email); Deno.exit(1); }
console.log(await new KakaoWorkChannel(key).send(uid, "[날씨경영] 스모크 테스트 메시지입니다."));
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test supabase/functions/_shared/kakaowork_test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: 실키 스모크 (수동 — 봇 키 발급 후)**

Run: `KAKAOWORK_BOT_KEY=<실키> deno run --allow-net --allow-env scripts/smoke-kakaowork.ts <내 카카오워크 이메일>`
Expected: `{ ok: true }` + 카카오워크 수신 확인. 무료 플랜 봇 API 가동 검증(스파이크 1). 실패 시 스펙 §10에 기록하고 채널 재협의.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/channel.ts supabase/functions/_shared/kakaowork.ts supabase/functions/_shared/kakaowork_test.ts scripts/smoke-kakaowork.ts
git commit -m "feat: 알림 채널 어댑터 (카카오워크·콘솔) + 스모크 스크립트"
```

---

### Task 9: DB 액세스 헬퍼 (`db.ts`)

**Files:**
- Create: `supabase/functions/_shared/db.ts`

**Interfaces:**
- Produces (모든 Edge Function이 사용, service role 클라이언트):
  - `serviceClient(): SupabaseClient` — env `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  - `loadEngineInputs(db): Promise<{ criteria: Criterion[]; settings: AlertSetting[]; open: OpenEvent[]; site: SiteSettings }>` — DB 행을 Task 6 타입으로 변환 (snake→camel, DISMISSED는 `closed_at is null`인 것만 `dismissedOpen:true`)
  - `todayAccums(db, now: Date): Promise<{ rainToday: number|null; snowToday: number|null }>` — KST 자정 이후 `weather_observations` 합계 (결측 행 제외, 전부 결측이면 null)
  - `type SiteSettings = { site_name: string; nx: number; ny: number; remind_interval_min: number; resolve_notice: boolean }`

- [ ] **Step 1: 구현** (순수 변환 로직이 얇아 통합 테스트는 Task 10에서 커버)

```typescript
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Criterion, AlertSetting, OpenEvent } from "./types.ts";

export type SiteSettings = { site_name: string; nx: number; ny: number;
  remind_interval_min: number; resolve_notice: boolean };

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function loadEngineInputs(db: SupabaseClient) {
  const [{ data: crit }, { data: sets }, { data: events }, { data: site }] = await Promise.all([
    db.from("weather_criteria").select("*"),
    db.from("alert_settings").select("*"),
    db.from("weather_events").select("*")
      .or("status.in.(PENDING_APPROVAL,ACTIVE),and(status.eq.DISMISSED,closed_at.is.null)"),
    db.from("site_settings").select("*").single(),
  ]);
  const criteria: Criterion[] = (crit ?? []).map((c: any) => ({ kind: c.kind, grade: c.grade, threshold: c.threshold }));
  const settings: AlertSetting[] = (sets ?? []).map((s: any) => ({
    kind: s.kind, enabled: s.enabled, repeatPolicy: s.repeat_policy,
    repeatAccumThreshold: s.repeat_accum_threshold, heatRepeatBasis: s.heat_repeat_basis }));
  const open: OpenEvent[] = (events ?? []).map((e: any) => ({
    id: e.id, kind: e.kind, grade: e.grade, status: e.status,
    dismissedOpen: e.status === "DISMISSED" && e.closed_at === null }));
  return { criteria, settings, open, site: site as SiteSettings };
}

export async function todayAccums(db: SupabaseClient, now: Date) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const midnightKst = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
  const { data } = await db.from("weather_observations")
    .select("rain_mm_per_hr, snow_new_cm, missing")
    .gte("observed_at", midnightKst.toISOString()).eq("missing", false);
  if (!data || data.length === 0) return { rainToday: null, snowToday: null };
  const sum = (k: string) => data.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
  return { rainToday: sum("rain_mm_per_hr"), snowToday: sum("snow_new_cm") };
}
```

- [ ] **Step 2: 타입체크**

Run: `deno check supabase/functions/_shared/db.ts`
Expected: OK

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/_shared/db.ts
git commit -m "feat: Edge Function용 DB 액세스 헬퍼"
```

---

### Task 10: `weather-tick` Edge Function (매시 감지)

**Files:**
- Create: `supabase/functions/weather-tick/index.ts`, `supabase/functions/weather-tick/index_test.ts`

**Interfaces:**
- Consumes: Task 4~9 전부
- Produces: HTTP POST 핸들러. 헤더 `x-cron-secret`이 env `CRON_SECRET`과 다르면 401. 응답 `{ ok: true, actions: Action[] }`. 테스트용 env `MOCK_KMA_JSON`(설정 시 실호출 대신 파싱)

**처리 순서 (스펙 §3):**
1. 기상청 관측 조회 (실패 시 `missing:true` 행 저장, 최근 3연속 결측이면 admin 전원에게 채널로 시스템 알림, 판정 스킵)
2. 파생값 계산 → `weather_observations` upsert (observed_at unique)
3. `loadEngineInputs` + `todayAccums` → `evaluate`
4. 액션 실행:
   - `create`: `weather_events` insert(PENDING_APPROVAL) → `composeDraft`로 `messages` insert(draft) → `alert_recipients` 전원에게 승인 요청 알림 (딥링크 `${APP_BASE_URL}/events/{id}`)
   - `escalate`: watch를 `ESCALATED`+`closed_at` → warning으로 `create` 로직 재사용
   - `repeat`: 승인된 messages 스냅샷의 selected 블록 재발송 → `dispatches` insert(repeat_no 증가) → `repeat_count` 갱신
   - `resolve`: `RESOLVED`+`closed_at`. `site.resolve_notice`면 마지막 발송 수신자에게 "[해제] {종류} {등급} 상황이 해제되었습니다" 발송
5. `heartbeats` upsert(`weather-tick`)

- [ ] **Step 1: 통합 테스트 작성 (로컬 스택 + ConsoleChannel + MOCK_KMA_JSON)**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + `supabase functions serve` 실행 중
// env: NOTIFY_CHANNEL=console, CRON_SECRET=test-secret
const FN = "http://127.0.0.1:54321/functions/v1/weather-tick";

Deno.test("weather-tick: 폭우 관측 → 특보 생성 + 초안 생성", async () => {
  const db = serviceClient();
  await db.from("weather_events").delete().neq("id", crypto.randomUUID()); // 초기화
  const mock = JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: [
    { category:"RN1", obsrValue:"32.5", baseDate:"20260812", baseTime:"0800" },
    { category:"T1H", obsrValue:"22.0" }, { category:"WSD", obsrValue:"3.0" },
    { category:"REH", obsrValue:"80" }, { category:"PTY", obsrValue:"1" } ] } } } });
  const res = await fetch(FN, { method: "POST",
    headers: { "x-cron-secret": "test-secret", "x-mock-kma": mock } });
  assertEquals(res.status, 200);
  const { data: ev } = await db.from("weather_events").select("*").eq("kind","rain").eq("grade","watch").single();
  assertEquals(ev.status, "PENDING_APPROVAL");
  const { data: msg } = await db.from("messages").select("*").eq("event_id", ev.id).single();
  assertEquals(msg.status, "draft");
});

Deno.test("weather-tick: cron secret 불일치 시 401", async () => {
  const res = await fetch(FN, { method: "POST", headers: { "x-cron-secret": "wrong" } });
  await res.body?.cancel();
  assertEquals(res.status, 401);
});
```

- [ ] **Step 2: 실행해 실패 확인**

Run: `supabase functions serve --env-file .env.test &` 후 `deno test --allow-net --allow-env supabase/functions/weather-tick/index_test.ts`
Expected: FAIL (404 — 함수 없음)

- [ ] **Step 3: `index.ts` 구현**

```typescript
import { serviceClient, loadEngineInputs, todayAccums } from "../_shared/db.ts";
import { fetchObservation, parseKmaResponse } from "../_shared/kma.ts";
import { feelsLikeC, snowNewCm } from "../_shared/derive.ts";
import { evaluate } from "../_shared/engine.ts";
import { composeDraft, renderMessage, KIND_LABEL, GRADE_LABEL, type DeptBlock } from "../_shared/template.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import type { Kind, Grade, Obs } from "../_shared/types.ts";

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const now = new Date();
  const { criteria, settings, open, site } = await loadEngineInputs(db);

  // 1. 관측
  let obsRow: Record<string, unknown>;
  const mock = req.headers.get("x-mock-kma");
  try {
    const k = mock ? parseKmaResponse(JSON.parse(mock))
      : await fetchObservation(env("KMA_API_KEY")!, site.nx, site.ny, now);
    const feels = (k.tempC !== null && k.humidityPct !== null && k.windMs !== null)
      ? feelsLikeC(k.tempC, k.humidityPct, k.windMs) : null;
    obsRow = { observed_at: k.observedAt.toISOString(), rain_mm_per_hr: k.rainMmPerHr,
      temp_c: k.tempC, wind_ms: k.windMs, humidity_pct: k.humidityPct,
      snow_new_cm: snowNewCm(k.rainMmPerHr, k.pty), feels_c: feels, raw: k, missing: false };
  } catch (e) {
    obsRow = { observed_at: new Date(Math.floor(now.getTime()/3600_000)*3600_000).toISOString(),
      missing: true, raw: { error: String(e) } };
  }
  const { data: saved } = await db.from("weather_observations")
    .upsert(obsRow, { onConflict: "observed_at" }).select().single();

  // 결측 3연속 → admin 알림, 판정 스킵
  if (saved.missing) {
    const { data: last3 } = await db.from("weather_observations")
      .select("missing").order("observed_at", { ascending: false }).limit(3);
    if (last3?.length === 3 && last3.every((r: any) => r.missing)) {
      const { data: admins } = await db.from("employees").select("kakaowork_user_id").eq("role","admin");
      for (const a of admins ?? []) if (a.kakaowork_user_id)
        await channel.send(a.kakaowork_user_id, "[날씨경영] 날씨 수집이 3시간 연속 실패했습니다. 시스템을 확인해 주세요.");
    }
    await db.from("heartbeats").upsert({ name:"weather-tick", last_run_at: now.toISOString(), ok:false, note:"missing" });
    return Response.json({ ok: true, actions: [] });
  }

  // 2~3. 판정
  const acc = await todayAccums(db, now);
  const obs: Obs = { rain: saved.rain_mm_per_hr, snowNew: saved.snow_new_cm,
    snowToday: acc.snowToday, rainToday: acc.rainToday,
    temp: saved.temp_c, feels: saved.feels_c, wind: saved.wind_ms };
  const actions = evaluate(obs, criteria, settings, open);

  const obsLine = `시간당 ${saved.rain_mm_per_hr ?? "-"}mm · ${saved.temp_c ?? "-"}℃(체감 ${saved.feels_c ?? "-"}) · 풍속 ${saved.wind_ms ?? "-"}m/s`;

  async function createEvent(kind: Kind, grade: Grade) {
    const { data: ev } = await db.from("weather_events")
      .insert({ kind, grade, trigger_observation_id: saved.id }).select().single();
    const { data: gRows } = await db.from("action_guidelines")
      .select("department_id, kind, grade, staff_actions, guest_notice, departments(name)")
      .eq("kind", kind).eq("grade", grade);
    const { data: rRows } = await db.from("recipients")
      .select("department_id, employee_id, employees(name, kakaowork_user_id)");
    const blocks = composeDraft(kind, grade,
      (gRows ?? []).map((g: any) => ({ ...g, department_name: g.departments.name })),
      (rRows ?? []).map((r: any) => ({ department_id: r.department_id, employee_id: r.employee_id,
        name: r.employees.name, kakaowork_user_id: r.employees.kakaowork_user_id })));
    await db.from("messages").insert({ event_id: ev.id, content: blocks });
    const { data: alerts } = await db.from("alert_recipients").select("employees(kakaowork_user_id)");
    const deepLink = `${env("APP_BASE_URL")}/events/${ev.id}`;
    for (const a of alerts ?? []) if ((a as any).employees?.kakaowork_user_id)
      await channel.send((a as any).employees.kakaowork_user_id,
        `[날씨경영] ${KIND_LABEL[kind]} ${GRADE_LABEL[grade]} 감지 — 발송 초안이 승인을 기다립니다.\n${obsLine}\n검토: ${deepLink}`);
  }

  for (const a of actions) {
    if (a.type === "create") await createEvent(a.kind, a.grade);
    if (a.type === "escalate") {
      await db.from("weather_events").update({ status:"ESCALATED", closed_at: now.toISOString() }).eq("id", a.eventId);
      await createEvent(a.kind, "warning");
    }
    if (a.type === "repeat") {
      const { data: msg } = await db.from("messages").select("*")
        .eq("event_id", a.eventId).eq("status","approved").single();
      if (msg) {
        const results: unknown[] = [];
        for (const b of (msg.content as DeptBlock[]).filter(b => b.selected))
          for (const r of b.recipients)
            results.push({ employee_id: r.employee_id, name: r.name,
              ...(r.kakaowork_user_id
                ? await channel.send(r.kakaowork_user_id, renderMessage(b, { kindLabel: KIND_LABEL[a.kind],
                    gradeLabel: GRADE_LABEL[a.grade], siteName: site.site_name, obsLine }))
                : { ok: false, error: "카카오워크 미연결" }) });
        const { data: ev } = await db.from("weather_events").select("repeat_count").eq("id", a.eventId).single();
        await db.from("dispatches").insert({ message_id: msg.id, event_id: a.eventId,
          repeat_no: (ev?.repeat_count ?? 0) + 1, results });
        await db.from("weather_events").update({ repeat_count: (ev?.repeat_count ?? 0) + 1 }).eq("id", a.eventId);
      }
    }
    if (a.type === "resolve") {
      await db.from("weather_events").update({ status:"RESOLVED", closed_at: now.toISOString() }).eq("id", a.eventId);
      if (site.resolve_notice) {
        const { data: msg } = await db.from("messages").select("content")
          .eq("event_id", a.eventId).eq("status","approved").maybeSingle();
        for (const b of ((msg?.content ?? []) as DeptBlock[]).filter(b => b.selected))
          for (const r of b.recipients) if (r.kakaowork_user_id)
            await channel.send(r.kakaowork_user_id,
              `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되었습니다. 조치해 주셔서 감사합니다.`);
      }
    }
  }

  await db.from("heartbeats").upsert({ name:"weather-tick", last_run_at: now.toISOString(), ok:true });
  return Response.json({ ok: true, actions });
});
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `deno test --allow-net --allow-env supabase/functions/weather-tick/index_test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/weather-tick/
git commit -m "feat: weather-tick — 매시 관측·감지·초안·알림·반복·해제"
```

---

### Task 11: `remind-tick` Edge Function (승인 재알림)

**Files:**
- Create: `supabase/functions/remind-tick/index.ts`, `supabase/functions/remind-tick/index_test.ts`

**Interfaces:**
- Produces: POST 핸들러 (`x-cron-secret` 검증 동일). PENDING_APPROVAL 상태에서 `now - coalesce(last_reminded_at, detected_at) >= remind_interval_min`인 특보마다 `alert_recipients`에게 재알림 발송 후 `last_reminded_at` 갱신. `heartbeats('remind-tick')` upsert. 응답 `{ ok: true, reminded: number }`

- [ ] **Step 1: 통합 테스트 작성**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";
const FN = "http://127.0.0.1:54321/functions/v1/remind-tick";

Deno.test("remind-tick: 간격 경과한 PENDING 특보만 재알림", async () => {
  const db = serviceClient();
  const old = new Date(Date.now() - 40 * 60_000).toISOString();   // 40분 전 감지
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString();  // 5분 전 감지
  const { data: e1 } = await db.from("weather_events")
    .insert({ kind:"wind", grade:"watch", detected_at: old }).select().single();
  await db.from("weather_events").insert({ kind:"heat", grade:"watch", detected_at: fresh });
  const res = await fetch(FN, { method:"POST", headers:{ "x-cron-secret":"test-secret" } });
  const body = await res.json();
  assertEquals(body.reminded, 1);
  const { data: after } = await db.from("weather_events").select("last_reminded_at").eq("id", e1.id).single();
  assertEquals(after.last_reminded_at !== null, true);
});
```

- [ ] **Step 2: 실행해 실패 확인** → FAIL (404)

- [ ] **Step 3: `index.ts` 구현**

```typescript
import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { KIND_LABEL, GRADE_LABEL } from "../_shared/template.ts";

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const { data: site } = await db.from("site_settings").select("remind_interval_min").single();
  const cutoff = new Date(Date.now() - (site?.remind_interval_min ?? 30) * 60_000).toISOString();
  const { data: pend } = await db.from("weather_events").select("*").eq("status","PENDING_APPROVAL");
  const due = (pend ?? []).filter((e: any) => (e.last_reminded_at ?? e.detected_at) <= cutoff);
  const { data: alerts } = await db.from("alert_recipients").select("employees(kakaowork_user_id)");
  let reminded = 0;
  for (const e of due) {
    for (const a of alerts ?? []) if ((a as any).employees?.kakaowork_user_id)
      await channel.send((a as any).employees.kakaowork_user_id,
        `[날씨경영] (재알림) ${KIND_LABEL[e.kind]} ${GRADE_LABEL[e.grade]} 초안이 아직 승인 대기 중입니다.\n검토: ${env("APP_BASE_URL")}/events/${e.id}`);
    await db.from("weather_events").update({ last_reminded_at: new Date().toISOString() }).eq("id", e.id);
    reminded++;
  }
  await db.from("heartbeats").upsert({ name:"remind-tick", last_run_at: new Date().toISOString(), ok:true });
  return Response.json({ ok: true, reminded });
});
```

- [ ] **Step 4: 테스트 통과 확인** → PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/remind-tick/
git commit -m "feat: remind-tick — 승인 대기 재알림"
```

---

### Task 12: `send` Edge Function (승인·발송 / 재발송 / 무시 / 테스트 발송)

**Files:**
- Create: `supabase/functions/send/index.ts`, `supabase/functions/send/index_test.ts`

**Interfaces:**
- Consumes: 웹에서 사용자 JWT로 호출 (`Authorization: Bearer <access_token>`)
- Produces: POST 핸들러, body 4종:
  - `{ mode:"approve", event_id, content: DeptBlock[] }` — approver 전용. messages를 content로 갱신·approved, 특보 ACTIVE, selected 블록 발송, dispatches(repeat_no=1) 기록. 응답 `{ ok, dispatch_id, fail_count }`
  - `{ mode:"resend", message_id, content: DeptBlock[] }` — approver 전용. 이력 화면의 수정 재발송 (특보 상태 불변, repeat_no 증가)
  - `{ mode:"dismiss", event_id }` — approver 전용. 특보 DISMISSED (closed_at은 null 유지 → 해제조건 충족 시 weather-tick이 닫음)
  - `{ mode:"test" }` — admin 전용. 호출자 본인에게 테스트 메시지 1건 (`dispatches.is_test=true`)
  - 역할 검증: JWT의 auth.uid로 employees 조회. 권한 없으면 403

- [ ] **Step 1: 통합 테스트 작성**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";

const URL = "http://127.0.0.1:54321";
const FN = `${URL}/functions/v1/send`;

async function loginAs(role: string, email: string) {
  const admin = serviceClient();
  const { data: u } = await admin.auth.admin.createUser({ email, password:"pw123456!", email_confirm:true });
  await admin.from("employees").insert({ auth_user_id: u.user!.id, name: email, email, role });
  const c = createClient(URL, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data } = await c.auth.signInWithPassword({ email, password:"pw123456!" });
  return data.session!.access_token;
}

Deno.test("send approve: approver가 승인하면 ACTIVE + dispatches 기록", async () => {
  const db = serviceClient();
  const { data: ev } = await db.from("weather_events").insert({ kind:"rain", grade:"watch" }).select().single();
  const content = [{ department_id:"d", department_name:"객실", staff_actions:["a"],
    guest_notice:"", recipients:[{ employee_id:"e", name:"홍", kakaowork_user_id:"kw1" }], selected:true }];
  await db.from("messages").insert({ event_id: ev.id, content });
  const token = await loginAs("approver", "ap2@t.co");
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content }) });
  assertEquals(res.status, 200);
  const { data: after } = await db.from("weather_events").select("status").eq("id", ev.id).single();
  assertEquals(after.status, "ACTIVE");
  const { data: d } = await db.from("dispatches").select("*").eq("event_id", ev.id);
  assertEquals(d!.length, 1);
});

Deno.test("send approve: staff는 403", async () => {
  const token = await loginAs("staff", "st2@t.co");
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: crypto.randomUUID(), content: [] }) });
  await res.body?.cancel();
  assertEquals(res.status, 403);
});
```

- [ ] **Step 2: 실행해 실패 확인** → FAIL (404)

- [ ] **Step 3: `index.ts` 구현**

```typescript
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";
import { getChannel } from "../_shared/kakaowork.ts";
import { renderMessage, KIND_LABEL, GRADE_LABEL, type DeptBlock } from "../_shared/template.ts";

const env = (k: string) => Deno.env.get(k);

async function currentEmployee(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const anon = createClient(env("SUPABASE_URL")!, env("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await anon.auth.getUser();
  if (!user) return null;
  const db = serviceClient();
  const { data } = await db.from("employees").select("*").eq("auth_user_id", user.id).single();
  return data;
}

async function dispatch(db: any, channel: any, msg: any, blocks: DeptBlock[],
    ctx: { kind: string; grade: string; site: string }, repeatNo: number, isTest = false) {
  const results: unknown[] = [];
  for (const b of blocks.filter(b => b.selected))
    for (const r of b.recipients)
      results.push({ employee_id: r.employee_id, name: r.name,
        ...(r.kakaowork_user_id
          ? await channel.send(r.kakaowork_user_id, renderMessage(b, {
              kindLabel: KIND_LABEL[ctx.kind as never], gradeLabel: GRADE_LABEL[ctx.grade as never],
              siteName: ctx.site, obsLine: "발송 시점 상세는 대시보드 참조" }))
          : { ok: false, error: "카카오워크 미연결" }) });
  const { data: d } = await db.from("dispatches").insert({
    message_id: msg.id, event_id: msg.event_id, repeat_no: repeatNo, is_test: isTest, results,
  }).select().single();
  return { dispatch_id: d.id, fail_count: (results as any[]).filter(r => !r.ok).length };
}

Deno.serve(async (req) => {
  const emp = await currentEmployee(req);
  if (!emp) return new Response("unauthorized", { status: 401 });
  const body = await req.json();
  const db = serviceClient();
  const channel = getChannel({ NOTIFY_CHANNEL: env("NOTIFY_CHANNEL") ?? undefined,
                               KAKAOWORK_BOT_KEY: env("KAKAOWORK_BOT_KEY") ?? undefined });
  const { data: site } = await db.from("site_settings").select("site_name").single();

  if (body.mode === "test") {
    if (emp.role !== "admin") return new Response("forbidden", { status: 403 });
    if (!emp.kakaowork_user_id) return Response.json({ ok:false, error:"카카오워크 미연결" }, { status: 400 });
    const r = await channel.send(emp.kakaowork_user_id, `[날씨경영] 테스트 메시지입니다. 설정이 정상 동작합니다.`);
    return Response.json({ ok: r.ok, error: r.error });
  }

  if (emp.role !== "approver" && emp.role !== "admin") return new Response("forbidden", { status: 403 });
  if (emp.role !== "approver") return new Response("forbidden", { status: 403 }); // 승인은 approver 전용

  if (body.mode === "approve") {
    const { data: ev } = await db.from("weather_events").select("*").eq("id", body.event_id).single();
    if (!ev || ev.status !== "PENDING_APPROVAL") return Response.json({ ok:false, error:"승인 가능한 상태가 아닙니다" }, { status: 409 });
    const { data: msg } = await db.from("messages").update({
      content: body.content, status:"approved", updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("event_id", ev.id).select().single();
    await db.from("weather_events").update({ status:"ACTIVE", approved_by: emp.id,
      approved_at: new Date().toISOString() }).eq("id", ev.id);
    const out = await dispatch(db, channel, msg, body.content, { kind: ev.kind, grade: ev.grade, site: site.site_name }, 1);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "resend") {
    const { data: msg } = await db.from("messages").update({
      content: body.content, updated_by: emp.id, updated_at: new Date().toISOString(),
    }).eq("id", body.message_id).select().single();
    const { data: ev } = await db.from("weather_events").select("*").eq("id", msg.event_id).single();
    const { count } = await db.from("dispatches").select("*", { count:"exact", head:true }).eq("event_id", ev.id);
    const out = await dispatch(db, channel, msg, body.content, { kind: ev.kind, grade: ev.grade, site: site.site_name }, (count ?? 0) + 1);
    return Response.json({ ok: true, ...out });
  }

  if (body.mode === "dismiss") {
    await db.from("weather_events").update({ status:"DISMISSED" }).eq("id", body.event_id).eq("status","PENDING_APPROVAL");
    return Response.json({ ok: true });
  }

  return new Response("bad request", { status: 400 });
});
```

- [ ] **Step 4: 테스트 통과 확인** → 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/send/
git commit -m "feat: send — 승인·발송, 수정 재발송, 무시, 테스트 발송"
```

---

### Task 13: `auth-kakaowork` Edge Function + pg_cron 마이그레이션

**Files:**
- Create: `supabase/functions/auth-kakaowork/index.ts`, `supabase/functions/auth-kakaowork/index_test.ts`, `supabase/migrations/0003_cron.sql`

**Interfaces:**
- Produces:
  - `GET /auth-kakaowork?action=login` → 카카오워크 OAuth authorize URL로 302 (client_id, redirect_uri=`{FN_URL}?action=callback`, state)
  - `GET /auth-kakaowork?action=callback&code=...` → 토큰 교환 → 프로필(email, user_id) 조회 → employees upsert(신규면 role='staff'·department null, `ADMIN_KAKAOWORK_ID`와 email 일치 시 role='admin') → auth.users 없으면 `admin.createUser` → `admin.generateLink({type:'magiclink'})` → `{APP_BASE_URL}/auth/callback#token_hash=...`로 302 (웹이 verifyOtp로 세션 확립)
  - 테스트용: env `MOCK_KAKAO_PROFILE`(JSON) 설정 시 OAuth 교환 생략

- [ ] **Step 1: 통합 테스트 작성**

```typescript
import { assertEquals } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";
const FN = "http://127.0.0.1:54321/functions/v1/auth-kakaowork";

Deno.test("callback: 신규 사용자는 staff·부서 미지정으로 자동 가입", async () => {
  // functions serve의 env: MOCK_KAKAO_PROFILE={"email":"new@t.co","user_id":"kw-new","name":"신규"}
  const res = await fetch(`${FN}?action=callback&code=x`, { redirect: "manual" });
  assertEquals(res.status, 302);
  const loc = res.headers.get("location")!;
  assertEquals(loc.includes("token_hash="), true);
  const db = serviceClient();
  const { data: emp } = await db.from("employees").select("*").eq("email","new@t.co").single();
  assertEquals(emp.role, "staff");
  assertEquals(emp.department_id, null);
  assertEquals(emp.kakaowork_user_id, "kw-new");
});

Deno.test("callback: ADMIN_KAKAOWORK_ID와 일치하면 admin", async () => {
  // env: ADMIN_KAKAOWORK_ID=boss@t.co, MOCK_KAKAO_PROFILE 해당 이메일로 교체 후 재기동해 실행
  // (subagent: functions serve를 env 바꿔 재실행)
});
```

- [ ] **Step 2: 실행해 실패 확인** → FAIL (404)

- [ ] **Step 3: `index.ts` 구현**

```typescript
import { serviceClient } from "../_shared/db.ts";

const env = (k: string) => Deno.env.get(k);
const AUTH_URL = "https://auth.kakaowork.com/oauth2/authorize";
const TOKEN_URL = "https://auth.kakaowork.com/oauth2/token";

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");
  const selfUrl = `${env("SUPABASE_URL")}/functions/v1/auth-kakaowork?action=callback`;

  if (action === "login") {
    const q = new URLSearchParams({ client_id: env("KAKAOWORK_CLIENT_ID")!,
      redirect_uri: selfUrl, response_type: "code", state: crypto.randomUUID() });
    return Response.redirect(`${AUTH_URL}?${q}`, 302);
  }

  if (action === "callback") {
    let profile: { email: string; user_id: string; name?: string };
    const mock = env("MOCK_KAKAO_PROFILE");
    if (mock) {
      profile = JSON.parse(mock);
    } else {
      const code = u.searchParams.get("code")!;
      const tokenRes = await fetch(TOKEN_URL, { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code,
          client_id: env("KAKAOWORK_CLIENT_ID")!, client_secret: env("KAKAOWORK_CLIENT_SECRET")!,
          redirect_uri: selfUrl }) });
      const { access_token } = await tokenRes.json();
      const me = await (await fetch("https://api.kakaowork.com/v1/users.me",
        { headers: { Authorization: `Bearer ${access_token}` } })).json();
      profile = { email: me.user.email, user_id: String(me.user.id), name: me.user.display_name };
    }

    const db = serviceClient();
    const role = profile.email === env("ADMIN_KAKAOWORK_ID") ? "admin" : "staff";
    const { data: existing } = await db.from("employees").select("*").eq("email", profile.email).maybeSingle();
    let authUserId = existing?.auth_user_id;
    if (!authUserId) {
      const { data: created } = await db.auth.admin.createUser({
        email: profile.email, email_confirm: true });
      authUserId = created.user!.id;
    }
    await db.from("employees").upsert({
      email: profile.email, auth_user_id: authUserId,
      name: existing?.name ?? profile.name ?? profile.email,
      kakaowork_user_id: profile.user_id,
      role: existing?.role ?? role,
      department_id: existing?.department_id ?? null,
    }, { onConflict: "email" });

    const { data: link } = await db.auth.admin.generateLink({ type: "magiclink", email: profile.email });
    const tokenHash = link.properties.hashed_token;
    return Response.redirect(`${env("APP_BASE_URL")}/auth/callback#token_hash=${tokenHash}`, 302);
  }

  return new Response("bad request", { status: 400 });
});
```

- [ ] **Step 4: `0003_cron.sql` 작성 (pg_cron + pg_net)**

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 프로덕션 배포 후 실제 값으로 갱신: select vault 또는 alter database ... set
-- 로컬에선 functions serve URL 사용
create or replace function call_edge(fn text) returns void language plpgsql as $$
declare
  base text := current_setting('app.edge_base_url', true);
  secret text := current_setting('app.cron_secret', true);
begin
  perform net.http_post(
    url := base || '/' || fn,
    headers := jsonb_build_object('x-cron-secret', secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb);
end $$;

select cron.schedule('weather-tick-hourly', '5 * * * *',  $$select call_edge('weather-tick')$$);
select cron.schedule('remind-tick-10min',  '*/10 * * * *', $$select call_edge('remind-tick')$$);
```

배포 시 1회 실행 (README에 기재): `alter database postgres set app.edge_base_url = 'https://<ref>.supabase.co/functions/v1'; alter database postgres set app.cron_secret = '<CRON_SECRET>';`

- [ ] **Step 5: 테스트 통과 확인**

Run: `MOCK_KAKAO_PROFILE='{"email":"new@t.co","user_id":"kw-new","name":"신규"}' supabase functions serve --env-file .env.test` 재기동 후 `deno test --allow-net --allow-env supabase/functions/auth-kakaowork/index_test.ts`
Expected: PASS. `supabase db reset`로 0003 마이그레이션 에러 없음 확인

- [ ] **Step 5b: 실계정 스파이크 (수동 — 스펙 §10 착수 조건)**

카카오워크 개발자 콘솔에서 OAuth 앱(redirect_uri = 배포된 함수 URL) 등록 후, MOCK 없이 실제 로그인 왕복 1회 검증. 실패 시 즉시 사용자에게 보고하고 인증 방식 재협의 (이 스파이크가 막히면 전체 인증이 막힌다).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/auth-kakaowork/ supabase/migrations/0003_cron.sql
git commit -m "feat: 카카오워크 OAuth 로그인·자동 가입 + pg_cron 스케줄"
```

---

### Task 14: 웹 스캐폴드 — Vite + 디자인 토큰 + 인증 + 로그인 화면

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/routes.tsx`, `apps/web/src/styles/tokens.css`, `apps/web/src/lib/supabase.ts`, `apps/web/src/lib/types.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/auth/AuthProvider.tsx`, `apps/web/src/auth/RequireRole.tsx`, `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/AuthCallback.tsx`

**Interfaces:**
- Produces (이후 모든 페이지 태스크가 사용):
  - `supabase: SupabaseClient` (lib/supabase.ts 싱글턴)
  - `useAuth(): { employee: Employee|null; loading: boolean; signOut(): void }` — employee는 `employees` 행 (role 포함)
  - `<RequireRole roles={["admin"]}>` 라우트 가드 — 권한 없으면 대시보드로 리다이렉트
  - `callSend(body: SendBody): Promise<SendResult>` (lib/api.ts — `supabase.functions.invoke("send")`)
  - `Employee`, `DeptBlock`, `WeatherEvent`, `Dispatch` 등 타입 (lib/types.ts — Task 2 스키마와 1:1)
  - 라우트: `/login`, `/auth/callback`, `/`, `/criteria`, `/guidelines`, `/events/:id`, `/history`, `/settings`, `/employees`
  - CSS 토큰 (DESIGN-apple.md 그대로): `--primary:#0066cc; --primary-focus:#0071e3; --primary-on-dark:#2997ff; --ink:#1d1d1f; --ink-muted-80:#333333; --ink-muted-48:#7a7a7a; --hairline:#e0e0e0; --divider-soft:#f0f0f0; --canvas:#ffffff; --parchment:#f5f5f7; --pearl:#fafafc; --tile-dark:#272729; --warn:#a65a00; --warn-strong:#ff9500; --danger:#d70015; --danger-strong:#ff3b30; --success:#248a3d; --radius-card:18px; --radius-ctl:8px` + 폰트 `Noto Sans KR`(UI)·`Inter`(수치, Google Fonts link)

- [ ] **Step 1: 스캐폴드 생성**

Run: `npm create vite@latest apps/web -- --template react-ts && cd apps/web && npm i @supabase/supabase-js react-router-dom && npm i -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/jest-dom jsdom`
`vite.config.ts`에 `@tailwindcss/vite` 플러그인, `index.html`에 Google Fonts(Noto Sans KR 300/400/600, Inter 400/600) link 추가.

- [ ] **Step 2: tokens.css + supabase.ts + types.ts + api.ts 작성**

```typescript
// lib/supabase.ts
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

// lib/api.ts
import { supabase } from "./supabase";
import type { DeptBlock } from "./types";
export type SendBody =
  | { mode: "approve"; event_id: string; content: DeptBlock[] }
  | { mode: "resend"; message_id: string; content: DeptBlock[] }
  | { mode: "dismiss"; event_id: string }
  | { mode: "test" };
export async function callSend(body: SendBody) {
  const { data, error } = await supabase.functions.invoke("send", { body });
  if (error) throw error;
  return data as { ok: boolean; dispatch_id?: number; fail_count?: number; error?: string };
}
```

`lib/types.ts`는 Task 2 스키마의 행 타입 + Task 7 `DeptBlock`을 그대로 옮긴다 (동일 필드명).

- [ ] **Step 3: AuthProvider + 콜백 + 가드 작성**

```tsx
// auth/AuthProvider.tsx — 세션 변화 구독, employees 행 로드
import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Employee } from "../lib/types";

const Ctx = createContext<{ employee: Employee|null; loading: boolean; signOut(): void }>(
  { employee: null, loading: true, signOut: () => {} });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [employee, setEmployee] = useState<Employee|null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const load = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setEmployee(null); setLoading(false); return; }
      const { data } = await supabase.from("employees").select("*").eq("auth_user_id", user.id).single();
      setEmployee(data); setLoading(false);
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);
  return <Ctx.Provider value={{ employee, loading, signOut: () => supabase.auth.signOut() }}>{children}</Ctx.Provider>;
}
```

```tsx
// pages/AuthCallback.tsx — auth-kakaowork가 준 token_hash로 세션 확립
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
export default function AuthCallback() {
  const nav = useNavigate();
  useEffect(() => {
    const hash = new URLSearchParams(location.hash.slice(1)).get("token_hash");
    if (!hash) { nav("/login"); return; }
    supabase.auth.verifyOtp({ type: "email", token_hash: hash })
      .then(({ error }) => nav(error ? "/login" : "/"));
  }, []);
  return <p style={{ padding: 40 }}>로그인 중…</p>;
}
```

```tsx
// auth/RequireRole.tsx
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
export function RequireRole({ roles, children }: { roles: string[]; children: React.ReactNode }) {
  const { employee, loading } = useAuth();
  if (loading) return null;
  if (!employee) return <Navigate to="/login" replace />;
  if (!roles.includes(employee.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 4: Login 페이지 (디자인 ⑦ 그대로 — 카카오워크 전용)**

```tsx
// pages/Login.tsx — 히어로: 로고마크(64) / "날씨경영" 48px 600 -0.5px / 리드 21px /
// 블루 필 CTA "카카오워크로 계속하기" → `${VITE_SUPABASE_URL}/functions/v1/auth-kakaowork?action=login`으로 location 이동 /
// 파인프린트 "회사 카카오워크 계정으로 로그인하면 계정이 자동으로 만들어집니다."
```

(마크업은 `design/previews/07-login.png`·`design/weather-management.pen`의 ⑦ 프레임 수치를 그대로 따른다)

- [ ] **Step 5: 빌드·기동 확인**

Run: `cd apps/web && npm run build && npm run dev` → `http://localhost:5173/login` 렌더 확인 (Pencil ⑦과 대조)

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): 스캐폴드 — 토큰·인증·라우팅·로그인 화면"
```

---

### Task 15: 공통 UI 컴포넌트 (디자인 시스템 시트 구현)

**Files:**
- Create: `apps/web/src/components/GlobalNav.tsx`, `SubNav.tsx`, `Button.tsx`, `Badge.tsx`, `Toggle.tsx`, `Chip.tsx`, `FilterPill.tsx`, `EmptyState.tsx`, `StatusDot.tsx`, `Modal.tsx`, `AppLayout.tsx`
- Test: `apps/web/src/components/__tests__/components.test.tsx`

**Interfaces:**
- Produces (`design/previews/99-components.png`의 각 요소와 1:1):
  - `<AppLayout title={string} actions={ReactNode}>{children}</AppLayout>` — GlobalNav(56px 블랙: 브랜드+6링크+지점·수집상태+사용자, 활성 링크 흰색 600) + SubNav(72px 파치먼트+하단 헤어라인: 타이틀 21px 600 + actions) + 센터 1120px 콘텐츠. 링크 표기: 대시보드/발송 이력/행동 지침/특보 기준/알림 설정/직원 관리 (알림 설정·직원 관리는 admin에게만 노출)
  - `<Button variant="primary"|"ghost"|"hero" onClick>` — primary=블루 필(10×22), ghost=투명+블루 보더 필, hero=18px/300(14×28)
  - `<Badge grade="watch"|"warning">` — 주의보(warn 톤)/경보(danger 톤) 필, 도트+라벨 12px 600
  - `<Toggle checked onChange>` — 44×26, on=#34C759
  - `<Chip label onRemove?>` — 파치먼트 필 칩(수신자), X 원형 20px
  - `<FilterPill selected label count?>` — 선택 시 2px `--primary-focus` 보더
  - `<EmptyState icon title desc cta?>` — ②-1 패턴
  - `<StatusDot ok label>` — 6px 도트+라벨 (성공/실패/연결됨)
  - `<Modal title desc onClose footer>{children}</Modal>` — 560px, radius 18 (⑥-1 패턴)

- [ ] **Step 1: 실패하는 컴포넌트 테스트 작성** (vitest + testing-library)

```tsx
import { render, screen } from "@testing-library/react";
import { Badge } from "../Badge";
import { FilterPill } from "../FilterPill";

test("Badge: 등급 라벨 렌더", () => {
  render(<Badge grade="watch" />);
  expect(screen.getByText("주의보")).toBeInTheDocument();
});
test("FilterPill: count 뱃지 렌더", () => {
  render(<FilterPill selected label="부서 미지정" count={2} />);
  expect(screen.getByText("2")).toBeInTheDocument();
});
```

- [ ] **Step 2: 실행해 실패 확인** → `cd apps/web && npx vitest run` FAIL

- [ ] **Step 3: 컴포넌트 구현** — 수치·색은 전부 tokens.css 변수 참조, 인라인 hex 금지. GlobalNav의 지점·수집상태는 `heartbeats`·`site_settings` 조회(`마지막 수집 N분 전`), 사용자명·역할은 `useAuth()`

- [ ] **Step 4: 테스트 통과 확인** → `npx vitest run` PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): 공통 UI 컴포넌트 (Apple 디자인 시스템)"
```

---

### Task 16: ⓪ 대시보드

**Files:**
- Create: `apps/web/src/pages/Dashboard.tsx`, `apps/web/src/lib/setup.ts`
- Test: `apps/web/src/lib/__tests__/setup.test.ts`

**Interfaces:**
- Consumes: AppLayout, Badge, Button, StatusDot
- Produces: `computeSetupChecklist(input: { site: boolean; criteria: boolean; deptCount: number; guidelineDeptCount: number; alertRecipientCount: number }): { done: number; total: 5; items: { label: string; ok: boolean }[] }` (lib/setup.ts — 셋업 스트립 로직)

**화면 구성 (`design/previews/00-dashboard.png` 순서 그대로):**
1. PageDesc(오늘 날짜·설명)
2. 셋업 체크리스트 스트립 — admin에게만, 5/5 완료 시 미표시. 진행률 링 + 미완료 항목 나열 + "설정 계속하기"→`/settings`
3. 승인 대기 배너 — `weather_events.status=PENDING_APPROVAL` 존재 시. 종류·등급, 감지 시각, 재알림 횟수 + [초안 검토하기]→`/events/:id` (approver에게만 버튼 노출)
4. 관측값 카드 4개 — 최신 `weather_observations` (수치 40px Inter 600, 임계 초과 카드는 값·뱃지만 warn 톤). 기준값은 `weather_criteria`에서 캡션으로
5. 진행 중 특보 리스트(디바이더 리스트, ACTIVE/PENDING) + 최근 발송 5건(`dispatches` 최신순, 실패 건 danger 표기)

- [ ] **Step 1: setup.ts 테스트 작성**

```typescript
import { computeSetupChecklist } from "../setup";
test("모두 완료면 done=5", () => {
  const r = computeSetupChecklist({ site:true, criteria:true, deptCount:3, guidelineDeptCount:3, alertRecipientCount:1 });
  expect(r.done).toBe(5);
});
test("지침 미등록 부서가 있으면 해당 항목 미완료", () => {
  const r = computeSetupChecklist({ site:true, criteria:true, deptCount:4, guidelineDeptCount:2, alertRecipientCount:0 });
  expect(r.items.find(i => i.label.includes("지침"))!.ok).toBe(false);
  expect(r.done).toBe(3);
});
```

- [ ] **Step 2: 실패 확인 → 구현 → 통과** (`computeSetupChecklist`는 순수 함수: site=관측지점 저장됨, criteria=기준 8행 존재, deptCount>0, guidelineDeptCount≥deptCount(리프 부서 기준), alertRecipientCount>0)

- [ ] **Step 3: Dashboard.tsx 구현** — 데이터는 `Promise.all`로 supabase 5쿼리(observations 최신 1, events open, dispatches 5, criteria, setup 입력), 30초 폴링(`setInterval`)

- [ ] **Step 4: 수동 확인** — 시드 상태에서 렌더가 `00-dashboard.png`와 동일 구조인지 확인

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/Dashboard.tsx apps/web/src/lib/setup.ts apps/web/src/lib/__tests__/setup.test.ts
git commit -m "feat(web): 대시보드 (셋업 체크리스트·승인 배너·관측값·진행 특보)"
```

---

### Task 17: ① 특보 기준

**Files:**
- Create: `apps/web/src/pages/Criteria.tsx`

**Interfaces:**
- Consumes: AppLayout(actions: [기상청 특보 기준 불러오기(ghost)] [변경사항 저장(primary)]), Badge, Chip
- Produces: 없음 (말단 화면)

**동작 (`01-criteria.png`):**
- 주의보/경보 카드 2열 × 종류 4행. 값 입력은 로컬 state, [저장] 시 `weather_criteria` 8행 upsert (admin만 — RLS가 최종 방어, UI는 admin 아니면 입력 disabled+저장 버튼 숨김)
- [기상청 특보 기준 불러오기] = 시드와 동일한 프리셋 상수로 로컬 state 리셋
- Alert 수신자: `alert_recipients` + employees 조인 → Chip 나열, [수신자 추가] = 직원 검색 셀렉트(approver·admin 역할 직원만 후보), X로 삭제
- 저장 성공 시 상단에 성공 배너 3초 (System Status Visibility)

- [ ] **Step 1: 구현** (프리셋 상수는 Task 2 시드와 동일 값 — 불일치 금지)
- [ ] **Step 2: 수동 확인** — staff 계정으로 접속 시 입력 disabled 확인
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 특보 기준 화면"`

---

### Task 18: ② 행동 지침 (+ 빈 상태)

**Files:**
- Create: `apps/web/src/pages/Guidelines.tsx`

**Interfaces:**
- Consumes: AppLayout, FilterPill(종류 탭·등급 스위치), Chip, EmptyState, Button

**동작 (`02-guidelines.png`, `02a-guidelines-empty.png`):**
- 상단: 종류 칩 4개(폭우/폭설/강풍/폭염) + 좌측 부서 트리(그룹=부모 부서, 행=리프 부서, 주의보·경보 등록 여부 도트, 수신자 수. 미지정 부서는 "미지정" danger 텍스트) + 우측 편집 패널
- 편집 패널: 선택 부서 × 등급(주의보/경보 칩 스위치) → `action_guidelines` 단건 로드. 인력 조정 지침(문자열 배열: 추가/수정/삭제), 고객 안내 멘트(textarea), 수신 담당자(`recipients` Chip — 해당 부서 소속 직원 검색 추가)
- [지침 저장] = `action_guidelines` upsert + `recipients` 갱신 (admin만 편집, approver/staff는 읽기 전용 — staff는 자기 부서만 RLS로 조회됨)
- `departments`가 0행이면 본문 전체를 EmptyState로 교체: admin이면 CTA [부서 관리 열기]→`/employees?dept=open`, 그 외 "관리자에게 부서 구성을 요청하세요"

- [ ] **Step 1: 구현**
- [ ] **Step 2: 수동 확인** — 시드 삭제 후 빈 상태 렌더 확인(`delete from departments` 임시 실행 후 복원)
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 행동 지침 화면 + 부서 미구성 빈 상태"`

---

### Task 19: ③ 초안 검토·발송

**Files:**
- Create: `apps/web/src/pages/EventReview.tsx`

**Interfaces:**
- Consumes: `callSend({mode:"approve"|"dismiss"})`, AppLayout, Badge, Button(hero), Chip

**동작 (`03-event-review.png`):**
- `/events/:id` — `weather_events` + `messages`(draft) + 트리거 관측값 로드
- 좌측: 전체 선택 체크박스 + 부서 블록 리스트 (체크박스, 지침 불릿 인라인 편집, 고객 안내 멘트 인용 편집, 수신자 표시). 블록 클릭 시 편집 모드(2px focus blue 보더)
- 우측 레일: 트리거 관측값 다크 카드 / 발송 설정(채널: 카카오워크 고정 표시, SMS "채널 미연동" disabled) / 수신자 요약+가감(Chip) / 반복 정책 안내 캡션 / [승인 및 발송](hero) / [임시 저장(ghost, messages.content만 update)] [특보 무시(ghost, danger 텍스트, confirm 모달)]
- 역할 분기: approver만 편집·발송·무시 가능. admin/staff는 읽기 전용(체크박스·버튼 미노출, staff는 자기 부서 블록만 강조)
- 발송 결과: `fail_count>0`이면 상단 danger 배너 "N명 발송 실패 — 발송 이력에서 확인", 성공이면 이력으로 이동
- 상태가 PENDING이 아니면 읽기 전용 + 상태 태그 표시 (409 대응)

- [ ] **Step 1: 구현**
- [ ] **Step 2: 수동 확인** — weather-tick 목 호출로 특보 생성 후 승인 흐름 실행, ConsoleChannel 로그로 메시지 확인
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 초안 검토·승인·발송 화면"`

---

### Task 20: ④ 발송 이력

**Files:**
- Create: `apps/web/src/pages/History.tsx`

**Interfaces:**
- Consumes: `callSend({mode:"resend"})`, AppLayout, Badge, Modal, FilterPill

**동작 (`04-history.png`):**
- 검색(특보·수신처) + 필터(종류/등급/기간) + 테이블: 번호/특보(종류+등급 뱃지)/특보 발생/메시지 발송/수신처 요약("리조트 외 3곳 · 12명")/상태(성공 N·실패 N StatusDot 필)/반복 회차/[재발송](approver만)
- 행 클릭 → Modal: 발송 당시 `messages.content` 스냅샷을 ③과 같은 블록 뷰(읽기 전용)로 표시. approver에겐 [수정 후 재발송] — 블록 편집 상태로 전환 후 `callSend({mode:"resend"})`
- 페이지네이션 20행. 삭제 UI 없음 (Global Constraints)

- [ ] **Step 1: 구현**
- [ ] **Step 2: 수동 확인** — Task 19에서 만든 발송 건이 목록·모달에 나타나는지
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 발송 이력 + 원본 보기·수정 재발송"`

---

### Task 21: ⑤ 알림 설정 + ⑥ 직원 관리 + ⑥-1 부서 모달

**Files:**
- Create: `apps/web/src/pages/Settings.tsx`, `apps/web/src/pages/Employees.tsx`, `apps/web/src/components/DeptModal.tsx`

**Interfaces:**
- Consumes: `callSend({mode:"test"})`, AppLayout, Toggle, FilterPill, Modal, StatusDot

**Settings 동작 (`05-settings.png`):** admin 전용(RequireRole). 좌: 특보 알림 활성화(종류 4행 Toggle→`alert_settings.enabled`) + 반복 알림 정책(종류별 라디오 필 3옵션 — `repeat_policy` 매핑: 최초 1회만=`once`/기준 미달까지 매시간=`hourly_until_below`/일 누적 기준 이하까지=`until_daily_accum_below`+임계 입력, heat는 기온·체감 기준 선택=`heat_repeat_basis`). 우: 관측 지점(주소·nx·ny→`site_settings`) + 재알림 간격 + 상황 해제 알림 Toggle(`resolve_notice`) + 수집 상태 다크 카드(`heartbeats` 조회: 기상청 API·수집 결측·마지막 수집) + [나에게 테스트 메시지 보내기]→`callSend({mode:"test"})` 결과 토스트

**Employees 동작 (`06-employees.png`, ⑥-1):** admin 전용. 검색+필터(부서/역할) + **[부서 미지정 N]** FilterPill(카운트=department_id null인 직원 수, 선택 시 해당 직원만) + 테이블(이름·가입일 "오늘 가입" 표시/부서(미지정=danger)/역할 태그/이메일/카카오워크 연결 StatusDot/수정·삭제). 미지정 행에 [부서 지정] 인라인 버튼→부서 셀렉트. [직원 추가] 모달(이름·이메일·부서·역할 — 사전 등록용, 가입 시 email 매칭 병합). [부서 편집]→`<DeptModal>`: 부서 트리 CRUD(이름 변경 인라인, 하위 추가는 1단계, 삭제 confirm "소속 직원은 미지정으로 이동합니다"→`employees.department_id=null`은 FK `on delete set null`이 처리, 단 recipients는 cascade 삭제됨을 안내문에 포함)

- [ ] **Step 1: Settings 구현 → 수동 확인(테스트 발송 ConsoleChannel 로그)**
- [ ] **Step 2: Employees + DeptModal 구현 → 수동 확인(부서 삭제 시 미지정 이동)**
- [ ] **Step 3: Commit** — `git commit -m "feat(web): 알림 설정·직원 관리·부서 모달"`

---

### Task 22: README 온보딩 + 전 구간 시나리오 검증

**Files:**
- Create: `scripts/scenario-test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: 전체 시스템

- [ ] **Step 1: 시나리오 스크립트 작성 (`scripts/scenario-test.ts`)** — 로컬 스택에서 시각 조작 없이 목 관측 헤더로 전 구간 실행:

```typescript
// 흐름: (1) weather-tick(mock 32.5mm) → PENDING 생성 확인
// (2) send approve → ACTIVE + dispatches 1건 확인
// (3) weather-tick(mock 25mm, 누적 90) → repeat → dispatches 2건 확인
// (4) weather-tick(mock 55mm) → escalate → watch=ESCALATED + warning PENDING 확인
// (5) warning approve 후 weather-tick(mock 2mm, 누적 50) → 둘 다 RESOLVED 확인
// 각 단계 assert 실패 시 exit 1. Deno.test 8개로 구성.
```

- [ ] **Step 2: 실행해 통과 확인**

Run: `deno test --allow-net --allow-env scripts/scenario-test.ts`
Expected: 전 단계 PASS

- [ ] **Step 3: README 작성** — 다음 섹션 필수:
  1. 소개 + 아키텍처 다이어그램(스펙 §3 텍스트 다이어그램 재사용) + 스크린샷(`design/previews/`)
  2. 사전 준비: 공공데이터포털 단기예보 조회서비스 활용신청(자동승인, 인증키 복사), 카카오워크 봇·OAuth 앱 등록, Supabase 프로젝트 생성
  3. 설치: `supabase link` → `supabase db push` → `supabase functions deploy` → `alter database ... set app.edge_base_url/app.cron_secret` → `apps/web` Vercel/Netlify 배포 (env 표 포함)
  4. 최초 로그인: `ADMIN_KAKAOWORK_ID` 계정으로 로그인 → 대시보드 셋업 체크리스트 순서대로
  5. 로컬 개발: `supabase start` + `functions serve --env-file` + `npm run dev`, 테스트 명령 목록
  6. 라이선스(MIT) + 채널 어댑터 확장 가이드(NotificationChannel 구현 방법 3줄)

- [ ] **Step 4: 최종 전체 테스트**

Run: `deno test --allow-net --allow-env supabase/ scripts/ && cd apps/web && npx vitest run && npm run build`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add README.md scripts/scenario-test.ts
git commit -m "docs: 온보딩 README + 전 구간 시나리오 테스트"
```
