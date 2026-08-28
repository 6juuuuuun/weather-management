# 사내 서버 이식 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supabase와 Cloudflare 의존을 걷어내고, Postgres와 Express 컨테이너 2개로 도는 자립형 시스템으로 이식한다.

**Architecture:** Postgres는 그대로 쓰고 권한 정책(RLS) 27개를 살린다. `auth.uid()`를 자체 정의하고 Express가 트랜잭션마다 `SET LOCAL`로 사용자 ID를 넣어 정책을 그대로 적용한다. Supabase PostgREST가 하던 일은 목적별 REST 엔드포인트로, Supabase Auth는 세션 쿠키 기반 자체 인증으로, Edge Functions는 Express 라우트로, pg_cron은 앱 내부 스케줄러로 옮긴다.

**Tech Stack:** Postgres 16, Node 22, Express 5, node-postgres(`pg`), `argon2`, `node-cron`, Vitest, Supertest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-08-28-self-hosted-migration-design.md`

## Global Constraints

- **권한 정책 27개를 앱 코드로 옮기지 않는다.** DB에 남기고 `auth.uid()`로 통한다. 개인정보 안전망을 코드로 옮기면 검사 누락이 곧 유출이다
- **`SET LOCAL`만 쓴다.** `SET`은 커넥션 풀에서 다음 요청으로 값이 새므로 금지
- 서버 로직(수집·발송)은 정책을 우회해야 하므로 **별도 DB 역할**로 접속한다
- **비밀번호 해싱과 토큰 생성에 검증된 라이브러리를 쓴다.** 암호학을 직접 구현하지 않는다
- **메일을 쓰지 않는다.** 가입 검증은 사내망 접근과 회사 도메인 제한, 비밀번호 재설정은 관리자의 임시 비밀번호 발급
- **가입 승인 절차를 두지 않는다.** 가입하면 바로 쓸 수 있고, 실제 관문은 관리자의 역할 부여다
- 세션은 **httpOnly 쿠키**. 토큰을 `localStorage`에 두지 않는다
- 알림 채널은 **카카오워크를 그대로 유지**한다. SMS 전환은 이 계획의 범위 밖
- 모든 주석과 커밋 메시지는 한국어. 주석은 *무엇*이 아니라 *왜*를 적는다
- 각 태스크는 **기존 테스트를 깨뜨리지 않는다.** 현재 웹앱 114건이 기준선이다

## 디렉터리 구조

```
db/
  migrations/          supabase/migrations 에서 이관 (0001~0007 + 신규)
server/
  package.json
  Dockerfile
  src/
    index.ts           부팅, 미들웨어 조립
    db.ts              커넥션 풀, withUser, withService
    auth/
      routes.ts        가입·로그인·로그아웃·계정 상태
      password.ts      해싱·검증·임시 비밀번호
      session.ts       세션 발급·조회·폐기
      middleware.ts    쿠키 → 사용자 확인 → req.user
    api/
      dashboard.ts     관측·특보·기준·사이트·수집상태
      org.ts           부서·직원·수신자·알림설정
      content.ts       행동지침·메시지·발송이력
    jobs/
      weatherTick.ts   관측 수집과 판정
      remindTick.ts    재알림 점검
      send.ts          승인·발송
      scheduler.ts     주기 실행
    shared/            supabase/functions/_shared 에서 이관
  test/
docker-compose.yml
apps/web/src/lib/api/  화면이 쓰는 데이터 접근 모듈 (신규)
```

---

## Task 1: Postgres 컨테이너와 스키마 이관

지금 스키마는 Supabase가 만들어 주는 `auth` 스키마에 기대고 있다. 그 의존을 끊어야 자체 Postgres에서 뜬다.

**Files:**
- Create: `docker-compose.yml`
- Create: `db/migrations/` — `supabase/migrations/0001~0005,0007` 복사 (0006은 Vault 전용이라 제외)
- Create: `db/migrations/0008_selfhost_auth.sql`
- Create: `db/test/schema.test.ts`
- Create: `db/package.json`

**Interfaces:**
- Produces: `app.current_user_id` 세션 변수 규약, `app_user` / `app_service` DB 역할, 컨테이너 이름 `postgres`

- [ ] **Step 1: compose 파일을 만든다**

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: weather
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5433:5432"   # 로컬 개발용. 서버 배치 시 제거한다
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d weather"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pgdata:
```

- [ ] **Step 2: 마이그레이션을 옮긴다**

```bash
mkdir -p db/migrations
cp supabase/migrations/0001_schema.sql db/migrations/
cp supabase/migrations/0002_rls.sql db/migrations/
cp supabase/migrations/0004_dispatch_snapshot.sql db/migrations/
cp supabase/migrations/0005_dispatch_repeat_no.sql db/migrations/
cp supabase/migrations/0007_approver_from_alert_recipients.sql db/migrations/
```

`0003_cron.sql`과 `0006_cron_vault.sql`은 옮기지 않는다. 스케줄러가 앱으로 이동하므로 pg_cron이 필요 없다(Task 11).

- [ ] **Step 3: auth 스키마를 자체 정의하는 마이그레이션을 쓴다**

```sql
-- db/migrations/0008_selfhost_auth.sql
-- Supabase가 제공하던 auth 스키마를 자체 정의한다. 권한 정책 14개가 auth.uid()
-- 하나에만 의존하므로, 이 함수만 우리가 채우면 정책은 한 줄도 고치지 않아도 된다.
begin;

create schema if not exists auth;

-- Express가 트랜잭션마다 SET LOCAL로 넣는 값을 읽는다.
-- 값이 없으면 null이고, 그때 정책들은 아무 행도 통과시키지 않는다(안전한 기본값).
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- 애플리케이션 역할: 정책을 적용받는다.
create role app_user nologin;
grant usage on schema public, auth to app_user;
grant select, insert, update, delete on all tables in schema public to app_user;
grant usage, select on all sequences in schema public to app_user;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_user;

-- 서버 로직 역할: 수집·발송은 특정 사용자를 대신하는 것이 아니므로 정책을 우회한다.
create role app_service nologin bypassrls;
grant usage on schema public, auth to app_service;
grant select, insert, update, delete on all tables in schema public to app_service;
grant usage, select on all sequences in schema public to app_service;
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_service;

commit;
```

- [ ] **Step 4: auth.users 참조를 끊는다**

`db/migrations/0002_rls.sql`에서 `auth.users`를 참조하는 1곳을 찾아, `employees.auth_user_id`를 직접 쓰도록 고친다. 원본 파일은 그대로 두고 옮긴 사본만 고친다.

```bash
grep -n "auth.users" db/migrations/*.sql
```

`auth.users`에서 이메일을 끌어오는 형태라면, `employees.email`이 이미 같은 값을 갖고 있으므로 그쪽을 쓴다.

- [ ] **Step 5: 마이그레이션 적용 스크립트를 만든다**

```json
// db/package.json
{
  "name": "weather-db",
  "private": true,
  "type": "module",
  "scripts": {
    "migrate": "for f in migrations/*.sql; do echo \"→ $f\"; psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f \"$f\"; done",
    "test": "vitest run"
  }
}
```

- [ ] **Step 6: 정책이 살아 있는지 검증하는 테스트를 쓴다**

```ts
// db/test/schema.test.ts
import { describe, expect, it, beforeAll } from "vitest";
import { Client } from "pg";

const url = process.env.DATABASE_URL!;
let db: Client;

// 마이그레이션에서 뽑은 최종 목록이다(create 29건에서 drop으로 사라진 2건을 뺀 27건).
// 이관 중 마이그레이션이 조용히 실패하면 여기서 걸린다.
const EXPECTED_POLICIES = [
  "action_guidelines.r_guidelines", "action_guidelines.w_admin_all",
  "alert_recipients.r_all", "alert_recipients.w_admin_all",
  "alert_settings.r_all", "alert_settings.w_admin",
  "departments.r_all", "departments.w_admin_del", "departments.w_admin_ins", "departments.w_admin_upd",
  "dispatches.r_all",
  "employees.r_all", "employees.w_admin_del", "employees.w_admin_ins", "employees.w_admin_upd",
  "heartbeats.r_all",
  "messages.r_messages", "messages.w_approver",
  "recipients.r_all", "recipients.w_admin_all",
  "site_settings.r_all", "site_settings.w_admin",
  "weather_criteria.r_all", "weather_criteria.w_admin", "weather_criteria.w_admin_ins",
  "weather_events.r_all",
  "weather_observations.r_all",
];

beforeAll(async () => {
  db = new Client({ connectionString: url });
  await db.connect();
});

describe("자체 호스팅 스키마", () => {
  // 이 시스템의 개인정보 안전망은 DB 안에 있다. 이식하면서 정책이 유실되면
  // 코드에 검사가 없는 상태로 명부가 열린다 — 가장 먼저 확인해야 할 것이다.
  // 개수만 세면 정책 이름이 바뀌어도 통과한다. (테이블, 정책명) 쌍을 통째로 비교한다.
  it("권한 정책 27개가 이름까지 그대로 있다", async () => {
    const { rows } = await db.query(
      "select tablename, policyname from pg_policies where schemaname = 'public' order by tablename, policyname",
    );
    const actual = rows.map((r) => `${r.tablename}.${r.policyname}`);
    expect(actual).toEqual(EXPECTED_POLICIES);
  });

  it("auth.uid()가 세션 변수를 읽는다", async () => {
    await db.query("begin");
    await db.query("set local app.current_user_id = '11111111-1111-1111-1111-111111111111'");
    const { rows } = await db.query("select auth.uid() as uid");
    await db.query("commit");
    expect(rows[0].uid).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("세션 변수가 없으면 auth.uid()가 null이다", async () => {
    const { rows } = await db.query("select auth.uid() as uid");
    expect(rows[0].uid).toBeNull();
  });

  it("app_service는 정책을 우회하고 app_user는 우회하지 않는다", async () => {
    const { rows } = await db.query(
      "select rolname, rolbypassrls from pg_roles where rolname in ('app_user','app_service') order by rolname",
    );
    expect(rows).toEqual([
      { rolname: "app_service", rolbypassrls: true },
      { rolname: "app_user", rolbypassrls: false },
    ]);
  });
});
```

- [ ] **Step 7: 컨테이너를 띄우고 테스트가 통과하는지 본다**

```bash
docker compose up -d postgres
export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:5433/weather"
cd db && npm run migrate && npx vitest run
```

Expected: 4건 통과. 정책 목록이 27개와 다르면 이관이 빠진 것이다 — 맞출 때까지 다음 태스크로 넘어가지 않는다.

- [ ] **Step 8: 커밋**

```bash
git add docker-compose.yml db/
git commit -m "feat(db): 자체 호스팅 Postgres 컨테이너와 스키마 이관

auth.uid()를 자체 정의해 권한 정책 27개를 한 줄도 고치지 않고 살린다.
app_user는 정책을 적용받고, 수집·발송용 app_service만 우회한다.
pg_cron 마이그레이션은 스케줄러가 앱으로 옮겨가므로 이관하지 않는다."
```

---

## Task 2: Express 뼈대와 권한 통로

정책이 실제로 적용되는 통로를 먼저 만든다. 이게 틀리면 이후 모든 API가 권한 없이 도는 셈이 된다.

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`
- Create: `server/src/db.ts`, `server/src/index.ts`
- Create: `server/test/db.test.ts`

**Interfaces:**
- Consumes: Task 1의 `app.current_user_id`, `app_user`, `app_service`
- Produces:
  - `withUser<T>(userId: string, fn: (q: Querier) => Promise<T>): Promise<T>`
  - `withService<T>(fn: (q: Querier) => Promise<T>): Promise<T>`
  - `type Querier = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> }`

- [ ] **Step 1: 서버 패키지를 만든다**

```json
// server/package.json
{
  "name": "weather-server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --experimental-strip-types --watch src/index.ts",
    "start": "node --experimental-strip-types src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "argon2": "^0.41.1",
    "cookie-parser": "^1.4.7",
    "express": "^5.1.0",
    "node-cron": "^3.0.3",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.8",
    "@types/express": "^5.0.0",
    "@types/node": "^22.10.2",
    "@types/pg": "^8.11.10",
    "supertest": "^7.0.0",
    "typescript": "^5.7.2",
    "vitest": "^4.1.10"
  }
}
```

- [ ] **Step 2: 권한 통로 테스트를 먼저 쓴다**

```ts
// server/test/db.test.ts
import { describe, expect, it } from "vitest";
import { withUser, withService } from "../src/db.ts";

describe("권한 통로", () => {
  // SET(LOCAL 없이)을 쓰면 값이 커넥션에 남아 다음 요청이 남의 신분으로 돈다.
  // 풀에서 커넥션을 여러 번 빌려도 값이 새지 않는 것을 확인한다.
  it("트랜잭션이 끝나면 사용자 값이 남지 않는다", async () => {
    const uid = "11111111-1111-1111-1111-111111111111";
    await withUser(uid, async (q) => {
      const { rows } = await q.query("select auth.uid() as uid");
      expect(rows[0].uid).toBe(uid);
    });

    // 같은 풀에서 다시 빌렸을 때 이전 값이 보이면 안 된다
    await withService(async (q) => {
      const { rows } = await q.query("select current_setting('app.current_user_id', true) as v");
      expect(rows[0].v === null || rows[0].v === "").toBe(true);
    });
  });

  it("withUser는 정책을 적용받는 역할로 접속한다", async () => {
    await withUser("11111111-1111-1111-1111-111111111111", async (q) => {
      const { rows } = await q.query("select current_user as who");
      expect(rows[0].who).toBe("app_user");
    });
  });

  it("withService는 정책을 우회하는 역할로 접속한다", async () => {
    await withService(async (q) => {
      const { rows } = await q.query("select current_user as who");
      expect(rows[0].who).toBe("app_service");
    });
  });

  it("사용자 ID가 UUID 형식이 아니면 거부한다", async () => {
    await expect(
      withUser("'; drop table employees; --", async () => undefined),
    ).rejects.toThrow(/사용자 ID/);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/db.test.ts
```

Expected: FAIL — `../src/db.ts`를 찾지 못한다.

- [ ] **Step 4: 권한 통로를 구현한다**

```ts
// server/src/db.ts
import pg from "pg";

export type Querier = {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 정책을 적용받는 풀과 우회하는 풀을 분리한다. 한 풀에서 역할만 바꾸면
// 실수로 우회 상태가 남을 수 있어, 아예 다른 접속으로 갈라 둔다.
const userPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_USER });
const servicePool = new pg.Pool({ connectionString: process.env.DATABASE_URL_SERVICE });

async function inTx<T>(pool: pg.Pool, setup: string | null, fn: (q: Querier) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (setup) await client.query(setup);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** 로그인한 사용자를 대신해 질의한다. 권한 정책 14개가 그대로 적용된다. */
export function withUser<T>(userId: string, fn: (q: Querier) => Promise<T>): Promise<T> {
  // 이 값은 SQL 문자열에 직접 들어가므로 형식을 먼저 막는다.
  // SET LOCAL은 파라미터 바인딩을 지원하지 않는다.
  if (!UUID.test(userId)) return Promise.reject(new Error(`사용자 ID 형식이 올바르지 않다: ${userId}`));
  // SET이 아니라 SET LOCAL이어야 한다 — 커밋과 함께 사라져 다음 요청으로 새지 않는다.
  return inTx(userPool, `set local app.current_user_id = '${userId}'`, fn);
}

/** 수집·발송처럼 특정 사용자를 대신하지 않는 서버 로직용. 정책을 우회한다. */
export function withService<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return inTx(servicePool, null, fn);
}
```

- [ ] **Step 5: 테스트가 통과하는지 본다**

```bash
cd server && npx vitest run test/db.test.ts
```

Expected: 4건 통과.

- [ ] **Step 6: 서버 부팅 파일을 만든다**

```ts
// server/src/index.ts
import express from "express";
import cookieParser from "cookie-parser";

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`[server] listening on ${port}`));
}
```

- [ ] **Step 7: 커밋**

```bash
git add server/
git commit -m "feat(server): Express 뼈대와 권한 통로

withUser는 SET LOCAL로 사용자 ID를 넣어 정책 27개를 그대로 적용받고,
withService만 정책을 우회한다. SET LOCAL은 파라미터 바인딩이 안 되므로
사용자 ID를 UUID 형식으로 먼저 막는다."
```

---

## Task 3: 인증 — 가입·로그인·세션

**Files:**
- Create: `db/migrations/0009_auth_local.sql`
- Create: `server/src/auth/password.ts`, `session.ts`, `middleware.ts`, `routes.ts`
- Create: `server/test/auth.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `withUser`, `withService`
- Produces:
  - `POST /api/auth/signup` `{email,password,name,department_id,phone}` → `201 {ok:true}`
  - `POST /api/auth/login` `{email,password}` → `200 {user}` + `Set-Cookie: sid=...`
  - `POST /api/auth/logout` → `204`
  - `GET /api/auth/me` → `200 {user}` | `401`
  - `PATCH /api/admin/users/:id/status` `{status:"active"|"disabled"}` → `200 {ok:true}` (관리자만)
  - 미들웨어 `requireAuth`, `requireAdmin` — `req.user = { accountId, employeeId, role, email }`

- [ ] **Step 1: 인증용 테이블 마이그레이션을 쓴다**

```sql
-- db/migrations/0009_auth_local.sql
-- Supabase Auth가 갖고 있던 계정 정보를 우리 테이블로 가져온다.
begin;

create table auth_accounts (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  -- 가입하면 바로 쓸 수 있다. 사내 DNS로만 열리므로 가입 화면에 닿는 것 자체가
  -- 1차 관문이고, 가입해도 staff라 조회만 된다. 실제 관문은 관리자의 역할 부여다.
  -- disabled는 퇴사자나 사고 계정을 막기 위해 남긴다.
  status text not null default 'active' check (status in ('active','disabled')),
  -- 관리자가 임시 비밀번호를 발급하면 참이 되고, 다음 로그인에서 변경을 강제한다.
  must_change_password boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create table auth_sessions (
  -- 쿠키에는 원문 토큰이 가고 여기에는 해시만 남긴다. DB가 유출돼도
  -- 세션을 그대로 재사용할 수 없게 한다.
  token_hash text primary key,
  account_id uuid not null references auth_accounts(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index on auth_sessions (account_id);
create index on auth_sessions (expires_at);

-- 기존 employees.auth_user_id가 이 계정을 가리킨다.
alter table employees
  add constraint employees_auth_account_fk
  foreign key (auth_user_id) references auth_accounts(id) on delete set null;

-- 가입 시 본인이 입력한다. 알림톡·SMS는 이 번호로 나가므로 없으면 발송 대상이 없다.
-- 기존 스키마에 없던 컬럼이라 여기서 더한다.
alter table employees add column if not exists phone text;

commit;
```

- [ ] **Step 2: 인증 테스트를 먼저 쓴다**

```ts
// server/test/auth.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

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
    const cookie = res.headers["set-cookie"][0];
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

  it("5회 실패하면 잠긴다", async () => {
    await request(app).post("/api/auth/signup").send(SIGNUP);
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/login").send({ email: SIGNUP.email, password: "wrong" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: SIGNUP.email, password: SIGNUP.password });
    expect(res.status).toBe(423);
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
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/auth.test.ts
```

Expected: FAIL — 라우트가 없어 404가 돌아온다.

- [ ] **Step 4: 비밀번호 모듈을 구현한다**

```ts
// server/src/auth/password.ts
import argon2 from "argon2";
import { randomBytes } from "node:crypto";

/** 해싱은 직접 만들지 않는다. argon2 기본 설정을 그대로 쓴다. */
export function hash(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export async function verify(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plain);
  } catch {
    // 해시 형식이 깨져 있어도 예외 대신 실패로 취급한다
    return false;
  }
}

/** 관리자가 발급하는 임시 비밀번호. 사람이 옮겨 적을 수 있는 길이로 만든다. */
export function temporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}
```

- [ ] **Step 5: 세션 모듈을 구현한다**

```ts
// server/src/auth/session.ts
import { createHash, randomBytes } from "node:crypto";
import { withService } from "../db.ts";

const TTL_HOURS = 12;

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** 원문 토큰을 돌려주고 DB에는 해시만 남긴다. */
export async function issue(accountId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withService((q) =>
    q.query(
      `insert into auth_sessions (token_hash, account_id, expires_at)
       values ($1, $2, now() + ($3 || ' hours')::interval)`,
      [hashToken(token), accountId, String(TTL_HOURS)],
    ),
  );
  return token;
}

export type SessionUser = { accountId: string; employeeId: string | null; role: string | null; email: string };

export async function lookup(token: string): Promise<SessionUser | null> {
  return withService(async (q) => {
    const { rows } = await q.query(
      `select a.id, a.email, e.id as employee_id, e.role
         from auth_sessions s
         join auth_accounts a on a.id = s.account_id
         left join employees e on e.auth_user_id = a.id
        where s.token_hash = $1 and s.expires_at > now() and a.status = 'active'`,
      [hashToken(token)],
    );
    if (rows.length === 0) return null;
    return {
      accountId: rows[0].id,
      employeeId: rows[0].employee_id ?? null,
      role: rows[0].role ?? null,
      email: rows[0].email,
    };
  });
}

export async function revoke(token: string): Promise<void> {
  await withService((q) => q.query("delete from auth_sessions where token_hash = $1", [hashToken(token)]));
}

/** 만료된 세션을 치운다. 스케줄러가 하루 한 번 부른다. */
export async function purgeExpired(): Promise<number> {
  return withService(async (q) => {
    const { rows } = await q.query("delete from auth_sessions where expires_at <= now() returning 1");
    return rows.length;
  });
}
```

- [ ] **Step 6: 미들웨어를 구현한다**

```ts
// server/src/auth/middleware.ts
import type { NextFunction, Request, Response } from "express";
import { lookup, type SessionUser } from "./session.ts";

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export const COOKIE = "sid";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  const user = await lookup(token);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다" });
  req.user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "권한이 없습니다" });
  next();
}
```

- [ ] **Step 7: 라우트를 구현한다**

```ts
// server/src/auth/routes.ts
import { Router } from "express";
import { withService } from "../db.ts";
import { hash, verify } from "./password.ts";
import { issue, lookup, revoke } from "./session.ts";
import { COOKIE, requireAuth, requireAdmin } from "./middleware.ts";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

const allowedDomains = () =>
  (process.env.ALLOWED_EMAIL_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

export const authRouter = Router();

authRouter.post("/signup", async (req, res) => {
  const { email, password, name, department_id, phone } = req.body ?? {};
  if (!email || !password || !name) return res.status(400).json({ error: "필수 항목이 비어 있습니다" });

  const domain = String(email).split("@")[1]?.toLowerCase();
  if (!domain || !allowedDomains().includes(domain)) {
    return res.status(400).json({ error: "회사 이메일로만 가입할 수 있습니다" });
  }

  try {
    await withService(async (q) => {
      const { rows } = await q.query(
        "insert into auth_accounts (email, password_hash) values ($1, $2) returning id",
        [email, await hash(password)],
      );
      // 가입과 동시에 직원 레코드를 만든다. 권한은 staff이고 관리자가 나중에 올린다.
      await q.query(
        `insert into employees (auth_user_id, name, email, phone, department_id, role)
         values ($1, $2, $3, $4, $5, 'staff')`,
        [rows[0].id, name, email, phone ?? null, department_id ?? null],
      );
    });
  } catch (e: any) {
    if (e?.code === "23505") return res.status(409).json({ error: "이미 가입된 이메일입니다" });
    throw e;
  }
  res.status(201).json({ ok: true });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const account = await withService(async (q) => {
    const { rows } = await q.query(
      "select id, password_hash, status, failed_attempts, locked_until, must_change_password from auth_accounts where email = $1",
      [email],
    );
    return rows[0] ?? null;
  });

  // 계정이 없을 때와 비밀번호가 틀렸을 때의 응답을 같게 유지한다.
  // 다르면 어떤 이메일이 가입돼 있는지 캐낼 수 있다.
  const deny = () => res.status(401).json({ error: "로그인할 수 없습니다" });
  if (!account) return deny();

  if (account.locked_until && new Date(account.locked_until) > new Date()) {
    return res.status(423).json({ error: "잠시 후 다시 시도해 주세요" });
  }

  if (!(await verify(account.password_hash, String(password ?? "")))) {
    await withService((q) =>
      q.query(
        `update auth_accounts
            set failed_attempts = failed_attempts + 1,
                locked_until = case when failed_attempts + 1 >= $2
                               then now() + ($3 || ' minutes')::interval else null end
          where id = $1`,
        [account.id, MAX_ATTEMPTS, String(LOCK_MINUTES)],
      ),
    );
    return deny();
  }

  if (account.status !== "active") {
    return res.status(403).json({ error: "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요" });
  }

  await withService((q) =>
    q.query("update auth_accounts set failed_attempts = 0, locked_until = null where id = $1", [account.id]),
  );

  const token = await issue(account.id);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 12 * 60 * 60 * 1000,
  });
  const user = await lookup(token);
  res.json({ user, must_change_password: account.must_change_password });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await revoke(token);
  res.clearCookie(COOKIE);
  res.status(204).end();
});

authRouter.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

export const adminUserRouter = Router();

adminUserRouter.patch("/:id/status", requireAuth, requireAdmin, async (req, res) => {
  const status = String(req.body?.status ?? "");
  if (status !== "active" && status !== "disabled") {
    return res.status(400).json({ error: "status는 active 또는 disabled여야 합니다" });
  }
  await withService(async (q) => {
    await q.query("update auth_accounts set status = $2 where id = $1", [req.params.id, status]);
    // 퇴사자를 막는 것이 목적이다. 남아 있는 세션을 끊지 않으면 막은 의미가 없다.
    if (status === "disabled") {
      await q.query("delete from auth_sessions where account_id = $1", [req.params.id]);
    }
  });
  res.json({ ok: true });
});
```

- [ ] **Step 8: 라우터를 서버에 붙인다**

```ts
// server/src/index.ts 에 추가
import { authRouter, adminUserRouter } from "./auth/routes.ts";

app.use("/api/auth", authRouter);
app.use("/api/admin/users", adminUserRouter);
```

- [ ] **Step 9: 테스트가 통과하는지 본다**

```bash
cd server && npx vitest run test/auth.test.ts
```

Expected: 14건 통과.

- [ ] **Step 10: 커밋**

```bash
git add db/migrations/0009_auth_local.sql server/
git commit -m "feat(server): 자체 인증 — 가입·로그인·세션 쿠키

사내 DNS로만 열리므로 가입 승인 절차를 두지 않는다. 가입해도 staff라
조회만 되고, 실제 관문은 관리자의 역할 부여다. 퇴사자는 계정 비활성화로
막고 이때 남은 세션도 끊는다. 세션 토큰은
httpOnly 쿠키로 내리고 DB에는 해시만 남겨, DB가 유출돼도 세션을 재사용할 수 없다.
로그인 실패 응답은 계정 존재 여부가 드러나지 않도록 사유를 구분하지 않는다."
```

---

## Task 4: 비밀번호 재설정과 변경 강제

메일이 없으므로 관리자가 임시 비밀번호를 발급한다. 발급받은 사람은 다음 로그인에서 반드시 바꾼다.

**Files:**
- Modify: `server/src/auth/routes.ts`
- Create: `server/test/password-reset.test.ts`

**Interfaces:**
- Consumes: `hash`, `verify`, `temporaryPassword`, `requireAuth`, `requireAdmin`
- Produces:
  - `POST /api/admin/users/:id/reset-password` → `200 {temporary_password}` (관리자만)
  - `POST /api/auth/change-password` `{current,next}` → `204`

- [ ] **Step 1: 테스트를 먼저 쓴다**

```ts
// server/test/password-reset.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

const USER = { email: "kim@gonjiam.com", password: "old-password-here", name: "김직원" };
const ADMIN = { email: "boss@gonjiam.com", password: "admin-password-here", name: "관리자" };

async function activeAgent(who: typeof USER) {
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
  });
});

describe("비밀번호 재설정", () => {
  it("관리자가 임시 비밀번호를 발급하면 그것으로 로그인된다", async () => {
    await activeAgent(USER);
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    // 역할이 바뀌었으니 세션을 다시 만든다
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id;
    });

    const res = await admin2.post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const temp = res.body.temporary_password;
    expect(typeof temp).toBe("string");

    const login = await request(app).post("/api/auth/login").send({ email: USER.email, password: temp });
    expect(login.status).toBe(200);
    // 임시 비밀번호로 들어온 사람은 반드시 바꿔야 한다
    expect(login.body.must_change_password).toBe(true);
  });

  it("관리자가 아니면 발급할 수 없다", async () => {
    const agent = await activeAgent(USER);
    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id;
    });
    expect((await agent.post(`/api/admin/users/${id}/reset-password`)).status).toBe(403);
  });

  it("발급 즉시 기존 세션이 끊긴다", async () => {
    const victim = await activeAgent(USER);
    const admin = await activeAgent(ADMIN);
    await withService((q) => q.query("update employees set role='admin' where email=$1", [ADMIN.email]));
    const admin2 = request.agent(app);
    await admin2.post("/api/auth/login").send({ email: ADMIN.email, password: ADMIN.password });

    const id = await withService(async (q) => {
      const { rows } = await q.query("select id from auth_accounts where email=$1", [USER.email]);
      return rows[0].id;
    });
    await admin2.post(`/api/admin/users/${id}/reset-password`);
    // 비밀번호를 잃어버린 상황을 가정한 발급이므로, 남아 있던 세션도 함께 끊어야 한다
    expect((await victim.get("/api/auth/me")).status).toBe(401);
  });
});

describe("비밀번호 변경", () => {
  it("현재 비밀번호가 맞아야 바꿀 수 있다", async () => {
    const agent = await activeAgent(USER);
    const bad = await agent.post("/api/auth/change-password").send({ current: "wrong", next: "new-password-x" });
    expect(bad.status).toBe(401);

    const ok = await agent
      .post("/api/auth/change-password")
      .send({ current: USER.password, next: "new-password-x" });
    expect(ok.status).toBe(204);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: USER.email, password: "new-password-x" });
    expect(login.status).toBe(200);
    expect(login.body.must_change_password).toBe(false);
  });

  it("너무 짧은 비밀번호는 거부한다", async () => {
    const agent = await activeAgent(USER);
    const res = await agent.post("/api/auth/change-password").send({ current: USER.password, next: "short" });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/password-reset.test.ts
```

Expected: FAIL — 두 라우트가 없어 404.

- [ ] **Step 3: 라우트를 구현한다**

```ts
// server/src/auth/routes.ts 에 추가
import { temporaryPassword } from "./password.ts";

const MIN_PASSWORD = 10;

adminUserRouter.post("/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const temp = temporaryPassword();
  await withService(async (q) => {
    await q.query(
      "update auth_accounts set password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = null where id = $1",
      [req.params.id, await hash(temp)],
    );
    // 비밀번호를 잃어버렸다는 전제의 발급이다. 남아 있는 세션도 함께 끊는다.
    await q.query("delete from auth_sessions where account_id = $1", [req.params.id]);
  });
  res.json({ temporary_password: temp });
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { current, next } = req.body ?? {};
  if (typeof next !== "string" || next.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다` });
  }
  const account = await withService(async (q) => {
    const { rows } = await q.query("select id, password_hash from auth_accounts where id = $1", [
      req.user!.accountId,
    ]);
    return rows[0];
  });
  if (!(await verify(account.password_hash, String(current ?? "")))) {
    return res.status(401).json({ error: "현재 비밀번호가 맞지 않습니다" });
  }
  await withService((q) =>
    q.query("update auth_accounts set password_hash = $2, must_change_password = false where id = $1", [
      account.id,
      await hash(next),
    ]),
  );
  res.status(204).end();
});
```

- [ ] **Step 4: 테스트가 통과하는지 본다**

```bash
cd server && npx vitest run test/password-reset.test.ts
```

Expected: 5건 통과.

- [ ] **Step 5: 커밋**

```bash
git add server/
git commit -m "feat(server): 비밀번호 재설정과 변경 강제

메일을 못 쓰므로 관리자가 임시 비밀번호를 발급한다. 발급 시 기존 세션을
끊는다 — 비밀번호를 잃어버렸다는 전제이므로 남은 세션도 신뢰할 수 없다."
```

---

## Task 5: 대시보드 조회 API

여기서 만든 형태를 Task 6·7이 그대로 따른다. 응답은 화면이 지금 받는 모양과 같아야 한다.

**Files:**
- Create: `server/src/api/dashboard.ts`
- Create: `server/test/api-dashboard.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `withUser`, `requireAuth`, `req.user`
- Produces: 아래 엔드포인트. 모든 응답은 배열 또는 객체를 그대로 돌려주고 감싸지 않는다

| 메서드 · 경로 | 대신하는 현재 질의 |
|---|---|
| `GET /api/observations/latest` | `.from("weather_observations").select(...).eq("missing",false).order("observed_at",desc).limit(1).maybeSingle()` |
| `GET /api/observations?since=<ISO>` | `.from("weather_observations").select(...).gte("observed_at", since).eq("missing",false).order(...)` |
| `GET /api/events/open` | `.from("weather_events").select(...).is("cleared_at", null)` |
| `GET /api/criteria` | `.from("weather_criteria").select("kind,grade,threshold")` |
| `GET /api/site-settings` | `.from("site_settings").select(...).eq("id",1).single()` |
| `GET /api/heartbeats/:name` | `.from("heartbeats").select("last_run_at").eq("name",name).single()` |

- [ ] **Step 1: 테스트를 먼저 쓴다**

```ts
// server/test/api-dashboard.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function loggedIn() {
  const who = { email: "view@gonjiam.com", password: "view-password-1", name: "조회자" };
  await request(app).post("/api/auth/signup").send(who);
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: who.email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from weather_observations");
  });
});

describe("관측 조회", () => {
  it("로그인하지 않으면 401이다", async () => {
    expect((await request(app).get("/api/observations/latest")).status).toBe(401);
  });

  // 회귀: 예전에는 결측 여부를 보지 않고 '가장 최근 행'을 읽었다. 기상청이 한 번만
  // 실패해도 빈 행이 최신이 되어 전 카드가 비었다.
  it("최신 관측에서 결측 행을 제외한다", async () => {
    await withService(async (q) => {
      await q.query(
        `insert into weather_observations (observed_at, temp_c, missing)
         values (now() - interval '2 hours', 21.5, false), (now() - interval '1 hour', null, true)`,
      );
    });
    const agent = await loggedIn();
    const res = await agent.get("/api/observations/latest");
    expect(res.status).toBe(200);
    expect(res.body.temp_c).toBe(21.5);
  });

  it("이력 조회는 since 이후만 돌려주고 오래된 순으로 정렬한다", async () => {
    await withService((q) =>
      q.query(
        `insert into weather_observations (observed_at, temp_c, missing) values
         (now() - interval '30 hours', 10, false),
         (now() - interval '3 hours', 20, false),
         (now() - interval '1 hour', 30, false)`,
      ),
    );
    const agent = await loggedIn();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await agent.get(`/api/observations?since=${encodeURIComponent(since)}`);
    expect(res.body.map((r: any) => r.temp_c)).toEqual([20, 30]);
  });

  it("since가 없으면 400이다", async () => {
    const agent = await loggedIn();
    expect((await agent.get("/api/observations")).status).toBe(400);
  });
});

describe("기준·설정 조회", () => {
  it("특보 기준을 돌려준다", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/criteria");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("사이트 설정을 돌려준다", async () => {
    const agent = await loggedIn();
    const res = await agent.get("/api/site-settings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("site_name");
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/api-dashboard.test.ts
```

Expected: FAIL — 라우트가 없어 404.

- [ ] **Step 3: 라우트를 구현한다**

```ts
// server/src/api/dashboard.ts
import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth } from "../auth/middleware.ts";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

// 모든 질의는 withUser를 거친다. 정책 27개가 여기서 적용된다.
const OBS_COLS = "observed_at, rain_mm_per_hr, temp_c, feels_c, wind_ms, snow_new_cm, missing";

dashboardRouter.get("/observations/latest", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ${OBS_COLS} from weather_observations
        where missing = false order by observed_at desc limit 1`,
    );
    return rows;
  });
  res.json(rows[0] ?? null);
});

dashboardRouter.get("/observations", async (req, res) => {
  const since = String(req.query.since ?? "");
  if (!since || Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: "since 파라미터가 필요합니다" });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ${OBS_COLS} from weather_observations
        where observed_at >= $1 and missing = false order by observed_at asc`,
      [since],
    );
    return rows;
  });
  res.json(rows);
});

dashboardRouter.get("/events/open", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, kind, grade, status, detected_at, repeat_count, cleared_at
         from weather_events where cleared_at is null order by detected_at desc`,
    );
    return rows;
  });
  res.json(rows);
});

dashboardRouter.get("/criteria", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select kind, grade, threshold from weather_criteria");
    return rows;
  });
  res.json(rows);
});

dashboardRouter.get("/site-settings", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select id, site_name, nx, ny from site_settings where id = 1");
    return rows;
  });
  res.json(rows[0] ?? null);
});

dashboardRouter.get("/heartbeats/:name", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select name, last_run_at from heartbeats where name = $1", [
      req.params.name,
    ]);
    return rows;
  });
  res.json(rows[0] ?? null);
});
```

- [ ] **Step 4: 서버에 붙이고 테스트가 통과하는지 본다**

```ts
// server/src/index.ts 에 추가
import { dashboardRouter } from "./api/dashboard.ts";
app.use("/api", dashboardRouter);
```

```bash
cd server && npx vitest run test/api-dashboard.test.ts
```

Expected: 6건 통과.

- [ ] **Step 5: 커밋**

```bash
git add server/
git commit -m "feat(server): 대시보드 조회 API

모든 질의를 withUser로 감싸 권한 정책이 그대로 적용되게 한다.
최신 관측은 결측 행을 제외한다 — 수집이 한 번 실패했을 때 빈 행이
최신이 되어 화면이 비는 회귀가 있었다."
```

---

## Task 6: 조직 관리 API

**Files:**
- Create: `server/src/api/org.ts`
- Create: `server/test/api-org.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `withUser`, `requireAuth`, `requireAdmin`
- Produces:

| 메서드 · 경로 | 대신하는 현재 질의 |
|---|---|
| `GET /api/departments` | `.from("departments").select("*").order("name")` |
| `POST /api/departments` `{name}` | `.insert({name})` |
| `PATCH /api/departments/:id` `{name}` | `.update({name}).eq("id",id)` |
| `DELETE /api/departments/:id` | `.delete().eq("id",id)` |
| `GET /api/employees?role=admin,approver` | `.select(...)`, `.in("role",[...])` |
| `PATCH /api/employees/:id` `{name,role,department_id,phone}` | `.update(...).eq("id",id)` |
| `DELETE /api/employees/:id` | `.delete().eq("id",id)` |
| `GET /api/recipients?department_id=` | `.from("recipients").select("department_id, employee_id, employees(...)")` |
| `PUT /api/recipients/:departmentId` `{employee_ids:[]}` | 기존 행 삭제 후 일괄 삽입 |
| `GET /api/alert-recipients` | `.from("alert_recipients").select("employee_id, employees(id,name,role)")` |
| `PUT /api/alert-recipients` `{employee_ids:[]}` | 기존 행 삭제 후 일괄 삽입 |
| `GET /api/alert-settings` | `.from("alert_settings").select("*")` |
| `PUT /api/alert-settings` `{rows:[...]}` | `.upsert(rows)` |

- [ ] **Step 1: 테스트를 먼저 쓴다**

```ts
// server/test/api-org.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function agentAs(role: "staff" | "admin", email: string) {
  const who = { email, password: "some-password-1", name: "테스트" };
  await request(app).post("/api/auth/signup").send(who);
  await withService(async (q) => {
    await q.query("update employees set role=$2 where email=$1", [email, role]);
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("delete from alert_recipients");
    await q.query("delete from recipients");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
    await q.query("delete from departments");
  });
});

describe("부서", () => {
  it("목록을 이름순으로 돌려준다", async () => {
    await withService((q) => q.query("insert into departments (name) values ('시설'),('객실')"));
    const agent = await agentAs("staff", "a@gonjiam.com");
    const res = await agent.get("/api/departments");
    expect(res.body.map((d: any) => d.name)).toEqual(["객실", "시설"]);
  });

  it("일반 직원은 부서를 만들 수 없다", async () => {
    const agent = await agentAs("staff", "b@gonjiam.com");
    expect((await agent.post("/api/departments").send({ name: "신규" })).status).toBe(403);
  });

  it("관리자는 부서를 만들 수 있다", async () => {
    const agent = await agentAs("admin", "c@gonjiam.com");
    const res = await agent.post("/api/departments").send({ name: "신규" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("신규");
  });
});

describe("알림 수신자", () => {
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

  it("일반 직원은 수신자를 바꿀 수 없다", async () => {
    const agent = await agentAs("staff", "e@gonjiam.com");
    expect((await agent.put("/api/alert-recipients").send({ employee_ids: [] })).status).toBe(403);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/api-org.test.ts
```

Expected: FAIL — 404.

- [ ] **Step 3: 라우트를 구현한다**

부서 라우트를 아래 형태로 쓰고, 표에 적은 나머지 엔드포인트도 같은 형태로 이어서 구현한다. 조회는 `requireAuth`만, 변경은 `requireAdmin`까지 건다.

```ts
// server/src/api/org.ts
import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";

export const orgRouter = Router();
orgRouter.use(requireAuth);

orgRouter.get("/departments", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select id, name from departments order by name");
    return rows;
  });
  res.json(rows);
});

orgRouter.post("/departments", requireAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "부서 이름이 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("insert into departments (name) values ($1) returning id, name", [name]);
    return rows;
  });
  res.status(201).json(rows[0]);
});

// 수신자는 화면이 '전체 선택 상태'를 넘기므로 부분 갱신이 아니라 통째로 교체한다.
// 부분 갱신으로 만들면 화면과 서버의 상태가 어긋날 때 조용히 남는 행이 생긴다.
orgRouter.put("/alert-recipients", requireAdmin, async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.employee_ids) ? req.body.employee_ids : [];
  await withUser(req.user!.accountId, async (q) => {
    await q.query("delete from alert_recipients");
    for (const id of ids) {
      await q.query("insert into alert_recipients (employee_id) values ($1)", [id]);
    }
  });
  res.status(204).end();
});

orgRouter.get("/alert-recipients", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ar.employee_id, e.name, e.role
         from alert_recipients ar join employees e on e.id = ar.employee_id
        order by e.name`,
    );
    return rows;
  });
  res.json(rows);
});
```

- [ ] **Step 4: 나머지 엔드포인트를 표대로 구현한다**

`departments` PATCH·DELETE, `employees` GET·PATCH·DELETE, `recipients` GET·PUT, `alert-settings` GET·PUT을 위와 같은 형태로 추가한다. 관계를 끌어오는 응답(`employees(...)`)은 SQL `join`으로 같은 모양을 만든다.

- [ ] **Step 5: 서버에 붙이고 테스트가 통과하는지 본다**

```ts
// server/src/index.ts 에 추가
import { orgRouter } from "./api/org.ts";
app.use("/api", orgRouter);
```

```bash
cd server && npx vitest run test/api-org.test.ts
```

Expected: 5건 통과.

- [ ] **Step 6: 커밋**

```bash
git add server/
git commit -m "feat(server): 조직 관리 API

수신자 저장은 전체 교체 방식이다. 화면이 선택 상태 전체를 넘기므로
부분 갱신으로 만들면 화면과 서버가 어긋날 때 조용히 남는 행이 생긴다."
```

---

## Task 7: 지침·메시지·발송이력 API

**Files:**
- Create: `server/src/api/content.ts`
- Create: `server/test/api-content.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**

| 메서드 · 경로 | 대신하는 현재 질의 |
|---|---|
| `GET /api/guidelines` | `.from("action_guidelines").select("*")` |
| `PUT /api/guidelines` `{rows:[...]}` | `.upsert(rows, {onConflict:"department_id,kind,grade"})` |
| `GET /api/messages?event_id=` | `.from("messages").select(...).eq("event_id", id)` |
| `GET /api/dispatches?limit=&since=` | `.from("dispatches").select(...).order("created_at",desc)` |

- [ ] **Step 1: 테스트를 먼저 쓴다**

```ts
// server/test/api-content.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";

async function agentAs(role: "staff" | "admin", email: string) {
  const who = { email, password: "some-password-1", name: "테스트" };
  await request(app).post("/api/auth/signup").send(who);
  await withService(async (q) => {
    await q.query("update employees set role=$2 where email=$1", [email, role]);
  });
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email, password: who.password });
  return agent;
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from auth_sessions");
    await q.query("delete from action_guidelines");
    await q.query("update employees set auth_user_id = null");
    await q.query("delete from auth_accounts");
    await q.query("delete from employees");
    await q.query("delete from departments");
  });
});

describe("행동지침", () => {
  it("저장하면 같은 키의 기존 지침을 덮어쓴다", async () => {
    const agent = await agentAs("admin", "g@gonjiam.com");
    const deptId = await withService(async (q) => {
      const { rows } = await q.query("insert into departments (name) values ('시설') returning id");
      return rows[0].id;
    });

    const row = { department_id: deptId, kind: "rain", grade: "watch", body: "배수로 점검" };
    await agent.put("/api/guidelines").send({ rows: [row] });
    await agent.put("/api/guidelines").send({ rows: [{ ...row, body: "배수로 점검 후 보고" }] });

    const res = await agent.get("/api/guidelines");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe("배수로 점검 후 보고");
  });

  it("일반 직원은 지침을 바꿀 수 없다", async () => {
    const agent = await agentAs("staff", "h@gonjiam.com");
    expect((await agent.put("/api/guidelines").send({ rows: [] })).status).toBe(403);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/api-content.test.ts
```

Expected: FAIL — 404.

- [ ] **Step 3: 라우트를 구현한다**

```ts
// server/src/api/content.ts
import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";

export const contentRouter = Router();
contentRouter.use(requireAuth);

contentRouter.get("/guidelines", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      "select department_id, kind, grade, body from action_guidelines order by department_id, kind, grade",
    );
    return rows;
  });
  res.json(rows);
});

contentRouter.put("/guidelines", requireAdmin, async (req, res) => {
  const rows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  await withUser(req.user!.accountId, async (q) => {
    for (const r of rows) {
      await q.query(
        `insert into action_guidelines (department_id, kind, grade, body)
         values ($1,$2,$3,$4)
         on conflict (department_id, kind, grade) do update set body = excluded.body`,
        [r.department_id, r.kind, r.grade, r.body],
      );
    }
  });
  res.status(204).end();
});

contentRouter.get("/messages", async (req, res) => {
  const eventId = String(req.query.event_id ?? "");
  if (!eventId) return res.status(400).json({ error: "event_id가 필요합니다" });
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      "select id, event_id, status, content, created_at from messages where event_id = $1 order by created_at",
      [eventId],
    );
    return rows;
  });
  res.json(rows);
});

contentRouter.get("/dispatches", async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const since = String(req.query.since ?? "");
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, message_id, repeat_no, snapshot, fail_count, created_at
         from dispatches
        where ($1 = '' or created_at >= $1::timestamptz)
        order by created_at desc limit $2`,
      [since, limit],
    );
    return rows;
  });
  res.json(rows);
});
```

- [ ] **Step 4: 서버에 붙이고 테스트가 통과하는지 본다**

```ts
// server/src/index.ts 에 추가
import { contentRouter } from "./api/content.ts";
app.use("/api", contentRouter);
```

```bash
cd server && npx vitest run
```

Expected: Task 2~7의 테스트가 모두 통과.

- [ ] **Step 5: 커밋**

```bash
git add server/
git commit -m "feat(server): 지침·메시지·발송이력 API"
```

---

## Task 8: 웹앱 데이터 접근 계층 교체

지금은 화면 13개 파일이 `supabase.from(...)`으로 DB를 직접 부른다. 이걸 이름 있는 함수로 모아 한 곳에서만 서버와 이야기하게 만든다. 나중에 API가 바뀌어도 화면을 다시 뒤지지 않아도 된다.

**Files:**
- Create: `apps/web/src/lib/api/client.ts`, `dashboard.ts`, `org.ts`, `content.ts`
- Create: `apps/web/src/lib/api/__tests__/client.test.ts`
- Modify: `apps/web/src/pages/*.tsx`, `apps/web/src/components/GlobalNav.tsx`, `apps/web/src/lib/setup.ts`
- Delete: `apps/web/src/lib/supabase.ts`
- Modify: `apps/web/package.json` — `@supabase/supabase-js` 제거

**Interfaces:**
- Consumes: Task 5~7의 엔드포인트
- Produces:
  - `apiGet<T>(path: string): Promise<T>` / `apiSend<T>(method, path, body): Promise<T>`
  - `class ApiError extends Error { status: number }`
  - `listDepartments()`, `latestObservation()`, `observationsSince(iso)`, `openEvents()`, `criteria()`, `siteSettings()`, `heartbeat(name)`, `listEmployees(opts)`, `alertRecipients()`, `saveAlertRecipients(ids)`, `guidelines()`, `saveGuidelines(rows)`, `messagesOf(eventId)`, `dispatches(opts)`

- [ ] **Step 1: 클라이언트 테스트를 먼저 쓴다**

```ts
// apps/web/src/lib/api/__tests__/client.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { apiGet, apiSend, ApiError } from "../client";

beforeEach(() => vi.restoreAllMocks());

describe("API 클라이언트", () => {
  // 세션이 httpOnly 쿠키에 있으므로 요청에 쿠키가 실려야 한다.
  // credentials를 빼면 로그인해도 모든 요청이 401로 떨어진다.
  it("항상 쿠키를 함께 보낸다", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/departments");
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });

  it("실패하면 상태 코드를 담은 ApiError를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "권한이 없습니다" }), { status: 403 })),
    );
    await expect(apiGet("/api/departments")).rejects.toMatchObject({
      status: 403,
      message: "권한이 없습니다",
    });
  });

  it("본문이 없는 204에도 터지지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(apiSend("PUT", "/api/guidelines", { rows: [] })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd apps/web && npx vitest run src/lib/api/__tests__/client.test.ts
```

Expected: FAIL — `../client`를 찾지 못한다.

- [ ] **Step 3: 클라이언트를 구현한다**

```ts
// apps/web/src/lib/api/client.ts
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    // 세션이 httpOnly 쿠키에 있다. 이걸 빼면 로그인해도 전부 401이 된다.
    credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let message = `요청이 실패했습니다 (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) message = j.error;
    } catch {
      /* 본문이 JSON이 아니면 기본 문구를 쓴다 */
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string) => call<T>("GET", path);
export const apiSend = <T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) =>
  call<T>(method, path, body);
```

- [ ] **Step 4: 자원별 모듈을 만든다**

```ts
// apps/web/src/lib/api/dashboard.ts
import { apiGet } from "./client";
import type { WeatherCriteria, WeatherEvent, WeatherObservation } from "../types";

export const latestObservation = () => apiGet<WeatherObservation | null>("/api/observations/latest");
export const observationsSince = (iso: string) =>
  apiGet<WeatherObservation[]>(`/api/observations?since=${encodeURIComponent(iso)}`);
export const openEvents = () => apiGet<WeatherEvent[]>("/api/events/open");
export const criteria = () => apiGet<WeatherCriteria[]>("/api/criteria");
export const siteSettings = () => apiGet<{ id: number; site_name: string; nx: number; ny: number } | null>("/api/site-settings");
export const heartbeat = (name: string) => apiGet<{ name: string; last_run_at: string } | null>(`/api/heartbeats/${name}`);
```

`org.ts`와 `content.ts`도 같은 형태로 만든다. Task 6·7의 엔드포인트 표에 있는 것을 빠짐없이 함수로 노출한다.

- [ ] **Step 5: 화면을 하나씩 옮긴다**

파일 하나를 옮길 때마다 그 파일의 테스트를 돌린다. 한 번에 다 바꾸면 어디서 깨졌는지 알 수 없다.

옮기는 순서와 각 파일이 쓰던 테이블:

| 파일 | 쓰던 테이블 |
|---|---|
| `lib/setup.ts` | departments, employees, alert_recipients, weather_criteria, action_guidelines |
| `components/GlobalNav.tsx` | site_settings, heartbeats |
| `pages/Dashboard.tsx` | weather_observations, weather_events, weather_criteria, site_settings, dispatches |
| `pages/Criteria.tsx` | weather_criteria, alert_recipients, employees |
| `pages/Employees.tsx` | employees, departments |
| `pages/Guidelines.tsx` | action_guidelines, departments |
| `pages/History.tsx` | dispatches |
| `pages/EventReview.tsx` | weather_events, messages, action_guidelines, recipients |
| `pages/Settings.tsx` | alert_settings, site_settings |

```bash
cd apps/web && npx vitest run src/pages/Dashboard.test.tsx
```

- [ ] **Step 6: supabase 흔적을 지운다**

```bash
cd apps/web
rm src/lib/supabase.ts
npm uninstall @supabase/supabase-js
grep -rn "supabase" src/ && echo "남은 참조가 있다 — 전부 지울 것" || echo "정리 완료"
```

`main.tsx`의 `MissingConfigError` 처리도 함께 정리한다. 설정 누락 화면은 남기되, 확인하는 값을 `VITE_SUPABASE_*`에서 API 기준 주소로 바꾼다.

- [ ] **Step 7: 웹앱 전체 테스트가 통과하는지 본다**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit && npm run build
```

Expected: 기존 114건 + 신규 3건. **테스트 수가 줄었다면 옮기다 빠뜨린 것이다.**

- [ ] **Step 8: 커밋**

```bash
git add apps/web/
git commit -m "refactor(web): 데이터 접근을 API 모듈로 모으고 supabase-js를 제거한다

화면 13개 파일이 DB를 직접 부르던 것을 이름 있는 함수로 모았다.
서버와 이야기하는 곳이 lib/api 한 군데뿐이라, API가 바뀌어도 화면을
다시 뒤지지 않아도 된다."
```

---

## Task 9: 로그인·회원가입 화면

**Files:**
- Modify: `apps/web/src/pages/Login.tsx`, `apps/web/src/auth/AuthProvider.tsx`
- Create: `apps/web/src/pages/Signup.tsx`, `apps/web/src/pages/ChangePassword.tsx`
- Create: `apps/web/src/pages/__tests__/Signup.test.tsx`
- Modify: `apps/web/src/routes.tsx`
- Delete: `apps/web/src/pages/AuthCallback.tsx` — 매직링크 콜백이 필요 없어진다

**Interfaces:**
- Consumes: `/api/auth/*`
- Produces: `useAuth()` → `{ employee, loading, isApprover, login(email,password), logout(), mustChangePassword }`

- [ ] **Step 1: 가입 화면 테스트를 먼저 쓴다**

```tsx
// apps/web/src/pages/__tests__/Signup.test.tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Signup from "../Signup";

beforeEach(() => vi.restoreAllMocks());

function renderSignup() {
  return render(
    <MemoryRouter>
      <Signup />
    </MemoryRouter>,
  );
}

describe("회원가입", () => {
  it("가입에 성공하면 완료 안내를 보여준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 })),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/가입이 완료/)).toBeInTheDocument();
  });

  // 회귀: 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다.
  it("서버가 거부하면 실패 사유를 보여주고 성공 화면으로 넘어가지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "회사 이메일로만 가입할 수 있습니다" }), { status: 400 }),
      ),
    );
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gmail.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "password12345" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    expect(await screen.findByText(/회사 이메일로만/)).toBeInTheDocument();
    expect(screen.queryByText(/가입이 완료/)).not.toBeInTheDocument();
  });

  it("비밀번호가 10자 미만이면 보내지 않는다", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSignup();
    fireEvent.change(screen.getByLabelText("회사 이메일"), { target: { value: "a@gonjiam.com" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("이름"), { target: { value: "홍길동" } });
    fireEvent.click(screen.getByRole("button", { name: "가입하기" }));

    await waitFor(() => expect(screen.getByText(/10자/)).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd apps/web && npx vitest run src/pages/__tests__/Signup.test.tsx
```

Expected: FAIL — `../Signup`을 찾지 못한다.

- [ ] **Step 3: 가입 화면을 만든다**

```tsx
// apps/web/src/pages/Signup.tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiSend, ApiError } from "../lib/api/client";
import { listDepartments } from "../lib/api/org";
import "./Signup.css";

const MIN_PASSWORD = 10;

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [phone, setPhone] = useState("");
  const [depts, setDepts] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 부서 목록은 로그인 없이도 필요하다. 실패해도 가입 자체는 막지 않는다.
    listDepartments().then(setDepts).catch(() => setDepts([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(`비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다`);
      return;
    }
    setBusy(true);
    try {
      await apiSend("POST", "/api/auth/signup", {
        email, password, name, department_id: departmentId || null, phone: phone || null,
      });
      setDone(true);
    } catch (err) {
      // 예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여줬다.
      setError(err instanceof ApiError ? err.message : "가입에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="signup">
        <h1>가입이 완료되었습니다</h1>
        <p>로그인 후 바로 이용할 수 있습니다.</p>
        <Link to="/login">로그인 화면으로</Link>
      </div>
    );
  }

  return (
    <div className="signup">
      <h1>가입</h1>
      <form onSubmit={submit}>
        <label htmlFor="email">회사 이메일</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <label htmlFor="password">비밀번호</label>
        <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />

        <label htmlFor="name">이름</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />

        <label htmlFor="department">부서</label>
        <select id="department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">선택하지 않음</option>
          {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>

        <label htmlFor="phone">휴대폰 번호</label>
        <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="010-0000-0000" />

        {error && <p className="signup-error">{error}</p>}
        <button type="submit" disabled={busy}>가입하기</button>
      </form>
      <Link to="/login">이미 계정이 있으신가요?</Link>
    </div>
  );
}
```

`Signup.css`는 기존 화면들과 같은 토큰만 쓴다(`DESIGN-apple.md`). 장식 띠·그림자·그라데이션을 넣지 않고, 반경은 18px 또는 pill만 쓴다.

- [ ] **Step 4: 로그인 화면을 비밀번호 방식으로 바꾼다**

이메일·비밀번호 입력과 "계정이 없으신가요? 가입 신청" 링크를 둔다. 매직링크 요청 코드와 `requestMagicLink` 호출을 지운다.

`403`이면 "사용할 수 없는 계정입니다. 관리자에게 문의해 주세요", `423`이면 "잠시 후 다시 시도해 주세요"를 보여준다. `must_change_password`가 참이면 `/change-password`로 보낸다.

- [ ] **Step 5: AuthProvider를 세션 쿠키 기준으로 바꾼다**

`supabase.auth.getUser()` 대신 `/api/auth/me`를 부른다. `onAuthStateChange` 구독을 없애고, `login`·`logout`을 컨텍스트에 노출한다. `employee`와 `isApprover`는 지금처럼 **한 번에 함께** 설정한다 — 따로 설정하면 둘이 어긋난 순간이 생긴다.

- [ ] **Step 6: 직원 관리 화면에 계정 관리를 붙인다**

`Employees.tsx`의 각 직원 줄에 두 가지를 더한다.

- **역할 바꾸기** — `PATCH /api/employees/:id {role}`. 가입은 열려 있고 권한만 관리자가 준다.
  **이것이 실제 관문이므로 화면이 없으면 아무도 특보를 승인할 수 없다**
- **계정 비활성화** — `PATCH /api/admin/users/:id/status {status:"disabled"}`.
  퇴사자를 막는 유일한 수단이다. 비활성화된 계정은 목록에서 흐리게 표시한다
- **임시 비밀번호 발급** — `POST /api/admin/users/:id/reset-password`.
  응답으로 온 임시 비밀번호를 화면에 한 번 보여주고, 당사자에게 전달하도록 안내한다.
  화면을 벗어나면 다시 볼 수 없다고 함께 적는다

- [ ] **Step 7: 라우트를 정리한다**

`/signup`, `/change-password`를 추가하고 `/auth/callback`을 제거한다. `AuthCallback.tsx`를 지운다.

- [ ] **Step 8: 웹앱 전체 테스트가 통과하는지 본다**

```bash
cd apps/web && npx vitest run && npx tsc --noEmit
```

Expected: 기존 테스트 중 매직링크를 검증하던 것들은 비밀번호 흐름으로 고쳐져 있어야 하고, 전체가 통과해야 한다.

- [ ] **Step 9: 커밋**

```bash
git add apps/web/
git commit -m "feat(web): 이메일·비밀번호 로그인과 회원가입 화면

매직링크 콜백을 걷어내고 세션 쿠키 기반으로 바꾼다. 가입하면 바로 쓸 수 있고,
권한은 직원 관리 화면에서 관리자가 부여한다. 실패 응답은 사유를 그대로 보여준다 —
예전 로그인 화면은 catch가 없어 실패해도 성공 화면을 보여주는 결함이 있었다."
```

---

## Task 10: 서버 로직 이식

`supabase/functions`의 순수 로직은 그대로 옮기고, DB 접근부만 바꾼다.

**Files:**
- Create: `server/src/shared/` — `engine.ts`, `derive.ts`, `kma.ts`, `template.ts`, `kakaowork.ts`, `channel.ts`, `types.ts` 이관
- Create: `server/src/jobs/weatherTick.ts`, `remindTick.ts`, `send.ts`
- Create: `server/test/jobs.test.ts`
- Create: `server/test/shared/` — 기존 Deno 테스트 6종을 Vitest로 이관
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `withService`
- Produces:
  - `runWeatherTick(): Promise<{ collected: boolean; events: number }>`
  - `runRemindTick(): Promise<{ reminded: number }>`
  - `runSend(body: SendBody, actorEmployeeId: string): Promise<SendResult>`
  - `POST /api/send` — 화면이 부르던 `functions.invoke("send")`를 대신한다

- [ ] **Step 1: 순수 로직을 옮기고 테스트를 이관한다**

`supabase/functions/_shared/`의 `engine.ts`·`derive.ts`·`kma.ts`·`template.ts`·`kakaowork.ts`·`channel.ts`·`types.ts`를 `server/src/shared/`로 복사한다. Deno 전용 import(`Deno.env`)만 `process.env`로 바꾸고 로직은 건드리지 않는다.

기존 Deno 테스트 6종(`engine_test.ts`, `derive_test.ts`, `kma_test.ts`, `template_test.ts`, `kakaowork_test.ts`, `cors_test.ts`)을 Vitest 형식으로 옮긴다. `cors_test.ts`는 CORS가 필요 없어지므로 옮기지 않는다 — 화면과 API가 같은 출처에서 뜬다.

```bash
cd server && npx vitest run test/shared/
```

Expected: 이관한 테스트가 모두 통과. **판정 엔진 테스트가 하나라도 줄면 이식이 실패한 것이다.**

- [ ] **Step 2: 작업 실행 테스트를 쓴다**

```ts
// server/test/jobs.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { withService } from "../src/db.ts";
import { runWeatherTick } from "../src/jobs/weatherTick.ts";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from weather_events");
    await q.query("delete from weather_observations");
    await q.query("delete from heartbeats");
  });
});

describe("관측 수집", () => {
  it("수집에 성공하면 관측을 저장하고 수집 시각을 남긴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: [] } } } })),
      ),
    );
    const out = await runWeatherTick();
    expect(out.collected).toBe(true);

    const beat = await withService(async (q) => {
      const { rows } = await q.query("select last_run_at from heartbeats where name = 'weather-tick'");
      return rows[0];
    });
    expect(beat).toBeTruthy();
  });

  // 기상청이 실패했을 때 조용히 넘어가면 화면은 옛 값을 최신인 양 보여준다.
  it("수집에 실패하면 결측으로 기록한다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    const out = await runWeatherTick();
    expect(out.collected).toBe(false);

    const rows = await withService(async (q) => {
      const { rows } = await q.query("select missing from weather_observations order by observed_at desc limit 1");
      return rows;
    });
    expect(rows[0]?.missing).toBe(true);
  });
});
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/jobs.test.ts
```

Expected: FAIL — `../src/jobs/weatherTick.ts`가 없다.

- [ ] **Step 4: 작업 세 개를 이식한다**

`supabase/functions/weather-tick/index.ts`(132줄), `remind-tick/index.ts`(34줄), `send/index.ts`(113줄)의 로직을 각각 `runWeatherTick`·`runRemindTick`·`runSend` 함수로 옮긴다.

바꾸는 것은 두 가지뿐이다.

- DB 접근을 `_shared/db.ts`의 Supabase 클라이언트에서 `withService`의 SQL로
- HTTP 진입점(`Deno.serve`)을 제거하고 순수 함수로

**`send`의 권한 검사는 반드시 유지한다.** 지금은 `isAlertRecipient(db, emp.id)`로 알림 수신자만 승인할 수 있고, `mode === "test"`는 관리자만 가능하다. 이 두 검사가 빠지면 아무나 전 직원에게 발송할 수 있게 된다.

- [ ] **Step 5: 발송 엔드포인트를 붙인다**

```ts
// server/src/index.ts 에 추가
import { requireAuth } from "./auth/middleware.ts";
import { runSend } from "./jobs/send.ts";

app.post("/api/send", requireAuth, async (req, res) => {
  if (!req.user!.employeeId) return res.status(403).json({ error: "직원 정보가 없습니다" });
  const out = await runSend(req.body, req.user!.employeeId);
  res.status(out.ok ? 200 : 403).json(out);
});
```

- [ ] **Step 6: 테스트가 통과하는지 본다**

```bash
cd server && npx vitest run
```

Expected: 전체 통과.

- [ ] **Step 7: 커밋**

```bash
git add server/
git commit -m "feat(server): 서버 로직 3종 이식

판정 엔진·수집·템플릿은 로직을 건드리지 않고 옮긴다. DB 접근만 SQL로 바꾸고
HTTP 진입점을 걷어낸다. send의 권한 검사 두 가지(알림 수신자만 승인,
테스트 발송은 관리자만)는 그대로 유지한다."
```

---

## Task 11: 스케줄러

**Files:**
- Create: `server/src/jobs/scheduler.ts`
- Create: `server/test/scheduler.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `runWeatherTick`, `runRemindTick`, `purgeExpired`
- Produces: `startScheduler(): void`, `catchUpIfMissed(): Promise<boolean>`

- [ ] **Step 1: 테스트를 먼저 쓴다**

```ts
// server/test/scheduler.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";
import { withService } from "../src/db.ts";
import { catchUpIfMissed } from "../src/jobs/scheduler.ts";

beforeEach(async () => {
  await withService((q) => q.query("delete from heartbeats"));
});

describe("기동 시 따라잡기", () => {
  // 컨테이너가 재시작하면 그 사이 주기를 놓친다. 안전 경보 시스템에서
  // 한 시간 공백은 특보를 통째로 놓친다는 뜻이다.
  it("마지막 수집이 오래됐으면 즉시 한 번 수집한다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '3 hours')"),
    );
    expect(await catchUpIfMissed()).toBe(true);
  });

  it("방금 수집했으면 중복 실행하지 않는다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '2 minutes')"),
    );
    expect(await catchUpIfMissed()).toBe(false);
  });

  it("기록이 없으면 첫 실행으로 보고 수집한다", async () => {
    expect(await catchUpIfMissed()).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/scheduler.test.ts
```

Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 스케줄러를 구현한다**

```ts
// server/src/jobs/scheduler.ts
import cron from "node-cron";
import { withService } from "../db.ts";
import { runWeatherTick } from "./weatherTick.ts";
import { runRemindTick } from "./remindTick.ts";
import { purgeExpired } from "../auth/session.ts";

// 관측은 매시 1회다. 70분이 지났다면 최소 한 번은 놓친 것이다.
const STALE_MINUTES = 70;

export async function catchUpIfMissed(): Promise<boolean> {
  const last = await withService(async (q) => {
    const { rows } = await q.query("select last_run_at from heartbeats where name = 'weather-tick'");
    return rows[0]?.last_run_at ? new Date(rows[0].last_run_at) : null;
  });

  const stale = !last || Date.now() - last.getTime() > STALE_MINUTES * 60_000;
  if (stale) await runWeatherTick();
  return stale;
}

async function guarded(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    // 한 번의 실패로 스케줄러가 멈추면 이후 모든 주기가 사라진다.
    console.error(`[scheduler] ${name} 실패:`, e);
  }
}

export function startScheduler(): void {
  cron.schedule("5 * * * *", () => guarded("weather-tick", runWeatherTick));
  cron.schedule("*/10 * * * *", () => guarded("remind-tick", runRemindTick));
  cron.schedule("0 4 * * *", () => guarded("session-purge", purgeExpired));
  void guarded("catch-up", catchUpIfMissed);
}
```

- [ ] **Step 4: 부팅에 연결한다**

```ts
// server/src/index.ts 에 추가
import { startScheduler } from "./jobs/scheduler.ts";

if (process.env.NODE_ENV !== "test") {
  startScheduler();
}
```

- [ ] **Step 5: 테스트가 통과하는지 본다**

```bash
cd server && npx vitest run test/scheduler.test.ts
```

Expected: 3건 통과.

- [ ] **Step 6: 커밋**

```bash
git add server/
git commit -m "feat(server): 앱 내부 스케줄러

pg_cron이 pg_net으로 앱을 HTTP 호출하던 구조를 걷어낸다. 앱이 상시 떠 있으므로
안에서 돌리면 되고, 실행 로그도 앱 로그에 함께 남는다. 컨테이너 재시작으로
주기를 놓쳤으면 기동 시 한 번 따라잡는다."
```

---

## Task 12: 정적 서빙과 단일 기동

**Files:**
- Create: `server/Dockerfile`
- Modify: `docker-compose.yml`, `server/src/index.ts`
- Create: `.env.selfhost.example`
- Create: `server/test/static.test.ts`
- Delete: `apps/web/wrangler.jsonc`

- [ ] **Step 1: 정적 서빙 테스트를 쓴다**

```ts
// server/test/static.test.ts
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";

describe("화면 서빙", () => {
  // 화면 전환이 브라우저에서 일어나므로, /criteria에서 새로고침하면
  // 서버는 그런 파일이 없다고 404를 준다. index.html로 넘겨야 한다.
  it("알 수 없는 경로는 index.html로 넘긴다", async () => {
    const res = await request(app).get("/criteria");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  // 위 폴백이 API에도 걸리면, 없는 엔드포인트가 200 HTML을 돌려줘
  // 클라이언트가 JSON 파싱에서 엉뚱하게 터진다.
  it("없는 API 경로는 404 JSON이다", async () => {
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
```

- [ ] **Step 2: 정적 서빙과 폴백을 구현한다**

```ts
// server/src/index.ts 에 추가 — 반드시 모든 API 라우터 뒤에 온다
import express from "express";
import path from "node:path";

const webRoot = process.env.WEB_ROOT ?? path.resolve("public");

// API 폴백이 먼저다. 이게 없으면 없는 엔드포인트가 index.html을 200으로 돌려준다.
app.use("/api", (_req, res) => res.status(404).json({ error: "없는 경로입니다" }));

app.use(express.static(webRoot));
app.get("*", (_req, res) => res.sendFile(path.join(webRoot, "index.html")));
```

- [ ] **Step 3: Dockerfile을 만든다**

```dockerfile
# server/Dockerfile
FROM node:22-alpine AS web
WORKDIR /build
COPY apps/web/package*.json ./apps/web/
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
RUN cd apps/web && npm run build

FROM node:22-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src
COPY --from=web /build/apps/web/dist ./public
ENV NODE_ENV=production WEB_ROOT=/app/public
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/index.ts"]
```

- [ ] **Step 4: compose에 앱을 추가한다**

```yaml
# docker-compose.yml 에 추가
  app:
    build:
      context: .
      dockerfile: server/Dockerfile
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL_USER: postgres://app_user@postgres:5432/weather
      DATABASE_URL_SERVICE: postgres://app_service@postgres:5432/weather
      ALLOWED_EMAIL_DOMAINS: ${ALLOWED_EMAIL_DOMAINS}
      KMA_API_KEY: ${KMA_API_KEY}
      KAKAOWORK_BOT_KEY: ${KAKAOWORK_BOT_KEY}
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
    ports:
      - "8080:3000"
    restart: unless-stopped
```

- [ ] **Step 5: 환경변수 예시를 만든다**

```bash
# .env.selfhost.example
POSTGRES_PASSWORD=여기에_긴_임의문자열
ALLOWED_EMAIL_DOMAINS=gonjiam.com
KMA_API_KEY=공공데이터포털_일반인증키_Decoding
KAKAOWORK_BOT_KEY=카카오워크_봇_앱키
COOKIE_SECURE=false   # HTTPS로 서비스할 때 true
```

- [ ] **Step 6: 전체를 띄워 확인한다**

```bash
docker compose up -d --build
curl -s localhost:8080/api/health
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/criteria    # 200
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/nope    # 404
```

- [ ] **Step 7: Cloudflare 설정을 지운다**

```bash
git rm apps/web/wrangler.jsonc
```

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "feat(deploy): 정적 서빙과 컨테이너 2개 단일 기동

Express가 화면 파일도 서빙한다. API 폴백을 정적 폴백보다 먼저 둬,
없는 엔드포인트가 index.html을 200으로 돌려주는 일을 막는다.
docker compose up -d 하나로 전체가 뜬다."
```

---

## Task 13: 백업·감시와 운영 문서

운영은 서비스 기획 담당자가 맡는다. 서버 운영 지식을 전제하지 않고, 명령을 그대로 따라 할 수 있게 쓴다.

**Files:**
- Create: `ops/backup.sh`, `ops/restore.sh`
- Create: `server/src/jobs/watchdog.ts`
- Create: `server/test/watchdog.test.ts`
- Create: `docs/운영.md`
- Modify: `server/src/jobs/scheduler.ts`

**Interfaces:**
- Produces: `checkHealth(): Promise<{ ok: boolean; reasons: string[] }>`, `GET /api/health/deep`

- [ ] **Step 1: 감시 테스트를 먼저 쓴다**

```ts
// server/test/watchdog.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { withService } from "../src/db.ts";
import { checkHealth } from "../src/jobs/watchdog.ts";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from heartbeats");
    await q.query("delete from weather_observations");
  });
});

describe("상태 점검", () => {
  // 자체 서버는 조용히 죽는다. 관리형과 달리 아무도 안 알려준다.
  it("수집이 오래 멈췄으면 문제로 본다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now() - interval '5 hours')"),
    );
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/수집/);
  });

  it("최근에 수집했으면 정상으로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query("insert into weather_observations (observed_at, temp_c, missing) values (now(), 20, false)");
    });
    expect((await checkHealth()).ok).toBe(true);
  });

  it("수집은 돌지만 결측만 쌓이면 문제로 본다", async () => {
    await withService(async (q) => {
      await q.query("insert into heartbeats (name, last_run_at) values ('weather-tick', now())");
      await q.query(
        `insert into weather_observations (observed_at, missing) values
         (now() - interval '1 hour', true), (now(), true)`,
      );
    });
    const out = await checkHealth();
    expect(out.ok).toBe(false);
    expect(out.reasons.join()).toMatch(/결측/);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

```bash
cd server && npx vitest run test/watchdog.test.ts
```

Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 감시를 구현한다**

```ts
// server/src/jobs/watchdog.ts
import { withService } from "../db.ts";
import { getChannel } from "../shared/kakaowork.ts";

const COLLECT_STALE_MIN = 130;   // 매시 수집이므로 2회 이상 놓친 상태
const MISSING_STREAK = 3;

export async function checkHealth(): Promise<{ ok: boolean; reasons: string[] }> {
  return withService(async (q) => {
    const reasons: string[] = [];

    const { rows: beat } = await q.query(
      "select last_run_at from heartbeats where name = 'weather-tick'",
    );
    const last = beat[0]?.last_run_at ? new Date(beat[0].last_run_at) : null;
    if (!last || Date.now() - last.getTime() > COLLECT_STALE_MIN * 60_000) {
      reasons.push(`관측 수집이 ${COLLECT_STALE_MIN}분 넘게 멈춰 있습니다`);
    }

    const { rows: recent } = await q.query(
      "select missing from weather_observations order by observed_at desc limit $1",
      [MISSING_STREAK],
    );
    if (recent.length >= MISSING_STREAK && recent.every((r: any) => r.missing)) {
      reasons.push(`최근 ${MISSING_STREAK}회 관측이 모두 결측입니다`);
    }

    return { ok: reasons.length === 0, reasons };
  });
}

/** 문제가 있으면 알림 수신자에게 알린다. 조용히 죽는 것이 최악이다. */
export async function reportIfUnhealthy(): Promise<void> {
  const health = await checkHealth();
  if (health.ok) return;

  const targets = await withService(async (q) => {
    const { rows } = await q.query(
      `select e.kakaowork_user_id from alert_recipients ar
         join employees e on e.id = ar.employee_id
        where e.kakaowork_user_id is not null`,
    );
    return rows.map((r: any) => r.kakaowork_user_id);
  });

  const channel = getChannel({
    NOTIFY_CHANNEL: process.env.NOTIFY_CHANNEL,
    KAKAOWORK_BOT_KEY: process.env.KAKAOWORK_BOT_KEY,
  });
  const text = `[날씨경영 점검]\n${health.reasons.join("\n")}`;
  for (const to of targets) await channel.send(to, text);
}
```

- [ ] **Step 4: 스케줄러와 엔드포인트에 연결한다**

```ts
// server/src/jobs/scheduler.ts 에 추가
import { reportIfUnhealthy } from "./watchdog.ts";
cron.schedule("0 */6 * * *", () => guarded("watchdog", reportIfUnhealthy));
```

```ts
// server/src/index.ts 에 추가 — /api 폴백보다 앞에 둔다
import { checkHealth } from "./jobs/watchdog.ts";
app.get("/api/health/deep", async (_req, res) => {
  const h = await checkHealth();
  res.status(h.ok ? 200 : 503).json(h);
});
```

- [ ] **Step 5: 백업과 복구 스크립트를 만든다**

```bash
# ops/backup.sh — 매일 새벽에 돈다. 서버가 통째로 죽어도 복구할 수 있게 밖에 둔다.
#!/bin/sh
set -eu
STAMP=$(date +%Y%m%d-%H%M)
OUT="${BACKUP_DIR:?BACKUP_DIR를 지정하세요}/weather-${STAMP}.sql.gz"
docker compose exec -T postgres pg_dump -U postgres weather | gzip > "$OUT"
# 30일이 지난 백업은 지운다
find "$BACKUP_DIR" -name 'weather-*.sql.gz' -mtime +30 -delete
echo "백업 완료: $OUT"
```

```bash
# ops/restore.sh — 복구는 실제로 해봐야 백업이다.
#!/bin/sh
set -eu
FILE="${1:?복구할 파일 경로를 넘기세요}"
echo "경고: 현재 데이터를 모두 덮어씁니다. 5초 후 시작합니다."
sleep 5
gunzip -c "$FILE" | docker compose exec -T postgres psql -U postgres -d weather
echo "복구 완료"
```

- [ ] **Step 6: 백업을 뜨고 복구를 실제로 해본다**

```bash
chmod +x ops/backup.sh ops/restore.sh
BACKUP_DIR=/tmp/wbackup mkdir -p /tmp/wbackup && BACKUP_DIR=/tmp/wbackup ./ops/backup.sh
# 데이터를 하나 지우고 복구되는지 확인한다
docker compose exec -T postgres psql -U postgres -d weather -c "delete from departments"
./ops/restore.sh /tmp/wbackup/weather-*.sql.gz
docker compose exec -T postgres psql -U postgres -d weather -c "select count(*) from departments"
```

Expected: 지웠던 부서가 되돌아온다. **되돌아오지 않으면 백업이 아니다.**

- [ ] **Step 7: 운영 문서를 쓴다**

`docs/운영.md`에 다음을 적는다. 명령을 그대로 붙여 넣을 수 있어야 하고, 배경 지식을 요구하지 않는다.

- 처음 올릴 때: `.env` 만들기 → `docker compose up -d --build` → 마이그레이션 적용 → 첫 관리자 지정 방법(가입 후 DB에서 role을 admin으로 한 번 올린다)
- 껐다 켜기: `docker compose restart app`
- 로그 보기: `docker compose logs -f app`
- 상태 확인: `curl localhost:8080/api/health/deep`이 무엇을 뜻하는지
- 백업·복구: 위 두 스크립트 사용법
- 자주 겪는 문제: 컨테이너가 안 뜰 때, 수집이 멈췄을 때, 로그인이 안 될 때
- 환경변수 목록과 각각이 무엇인지

- [ ] **Step 8: 커밋**

```bash
git add ops/ docs/운영.md server/ docker-compose.yml
git commit -m "feat(ops): 백업·복구와 상태 감시

자체 서버는 관리형과 달리 조용히 죽는다. 6시간마다 수집 상태를 점검해
문제가 있으면 알림 수신자에게 알린다. 복구 스크립트는 실제로 돌려
데이터가 되돌아오는 것을 확인했다."
```

---

## 이 계획의 범위 밖

- **서버 배치와 데이터 이관** — 하드웨어 도착 후 별도 계획으로 다룬다.
  옮길 것: 특보 기준, 행동지침, 부서, 사이트 설정. 새로 시작할 것: 발송 이력, 직원 명부, 계정
- **SMS 전환** — 이식 완료 후 사내 발송 시스템 연계 요건을 정리해 별도 진행
- **개인정보 접속기록** — 필요하지만 이식과 분리한다
- `supabase/` 디렉터리 삭제 — 이관이 끝나 운영이 안정된 뒤에 지운다. 그때까지는 참고용으로 남긴다
