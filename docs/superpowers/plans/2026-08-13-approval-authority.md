# 승인 권한 단일화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 승인·발송 권한의 출처를 `employees.role = 'approver'`에서 `alert_recipients` 등록 여부로 단일화한다.

**Architecture:** 승인 권한을 묻는 지점이 DB(RLS)·Edge Function·프런트 3계층에 흩어져 있다. 각 계층이 같은 질문("이 사람이 Alert 수신자인가?")을 하도록 바꾼다. DB는 `current_emp_is_approver()` 헬퍼를, 프런트는 `AuthProvider`의 `isApprover` 하나를 진실의 출처로 삼아 판정 로직이 다시 흩어지지 않게 한다.

**Tech Stack:** Postgres RLS (Supabase), Deno Edge Functions, React 18 + TypeScript, Vitest, `deno test`

**Spec:** `docs/superpowers/specs/2026-08-13-approval-authority-design.md`

## Global Constraints

- 마이그레이션은 새 파일로만 추가한다. 기존 `0001`~`0006`은 수정하지 않는다(운영 DB에 이미 적용됨).
- UI 표기는 "특보"를 쓴다. 코드·테이블명은 영문 유지(`weather_events` 등). — 원 스펙 결정 14
- 역할 표시 라벨: `admin` = "시스템 관리자", `approver` = "부서장", `staff` = "실무자". `사업부장`은 더 이상 쓰지 않는다.
- `emp_role` enum 자체는 이번 범위에서 변경하지 않는다.
- 통합 테스트 실행 전제: `supabase start` → `supabase db reset` → `supabase functions serve --env-file .env.test` 가 떠 있어야 하고, 실행 전 `set -a && source .env.test && set +a` 필요.
- 배포는 마이그레이션 → Edge Function → 웹 순서로 한 번에 나간다. 중간 상태로 운영에 남기지 않는다.

---

### Task 1: DB 헬퍼 + messages RLS 정책 교체

`messages` UPDATE(초안 임시저장) 권한을 역할이 아니라 Alert 수신자 등록 여부로 판정하게 바꾼다.

**Files:**
- Create: `supabase/migrations/0007_approver_from_alert_recipients.sql`
- Test: `supabase/functions/_shared/rls_test.ts` (기존 파일 수정 — 53행 테스트 교체 + 신규 2건)

**Interfaces:**
- Produces: SQL 함수 `current_emp_is_approver() returns boolean` — 이후 정책에서 사용. Task 2의 Edge Function은 이 함수를 쓰지 않고 직접 조회한다(service role로 동작해 RLS를 우회하므로).

- [ ] **Step 1: 기존 RLS 테스트가 무엇을 검증하는지 확인**

`supabase/functions/_shared/rls_test.ts:53` 의 현재 테스트:

```ts
Deno.test("RLS: approver는 messages를 수정할 수 있으나 dispatches는 쓸 수 없다", async () => {
  await withUser("ap", "approver", async (ap) => {
```

이 테스트는 `role='approver'`만으로 messages를 수정할 수 있다고 단언한다. 변경 후에는 **거짓이 되어야 한다.** 아래에서 교체한다.

- [ ] **Step 2: 실패하는 테스트를 먼저 쓴다**

`supabase/functions/_shared/rls_test.ts`의 53행 테스트 전체를 아래 3개로 교체한다.
`withUser`/`makeUser`/`uniqueEmail`/`admin` 은 같은 파일 상단에 이미 있는 헬퍼다.

```ts
// Alert 수신자로 등록해 주는 헬퍼 — 승인 권한의 유일한 출처
async function addAlertRecipient(email: string) {
  const { data: emp } = await admin.from("employees")
    .select("id").eq("email", email).single();
  const { error } = await admin.from("alert_recipients").insert({ employee_id: emp!.id });
  if (error) throw new Error(`alert_recipients insert 실패: ${error.message}`);
}

Deno.test("RLS: Alert 수신자는 messages를 수정할 수 있다 (역할과 무관)", async () => {
  const email = uniqueEmail("recip-staff");
  const c = await makeUser(email, "staff");   // 역할은 staff — 그래도 승인 가능해야 한다
  try {
    await addAlertRecipient(email);
    const { data: ev } = await admin.from("weather_events")
      .insert({ kind: "rain", grade: "watch" }).select().single();
    await admin.from("messages").insert({ event_id: ev!.id, content: [] });
    const { error } = await c.from("messages")
      .update({ content: [{ note: "edited" }] }).eq("event_id", ev!.id);
    assertEquals(error, null);
  } finally {
    await cleanupUser(email);
  }
});

Deno.test("RLS: Alert 수신자가 아니면 messages를 수정할 수 없다 (approver 역할이어도)", async () => {
  const email = uniqueEmail("nonrecip-approver");
  const c = await makeUser(email, "approver");   // 역할은 approver — 그래도 거부돼야 한다
  try {
    const { data: ev } = await admin.from("weather_events")
      .insert({ kind: "rain", grade: "watch" }).select().single();
    await admin.from("messages").insert({ event_id: ev!.id, content: [] });
    const { data, error } = await c.from("messages")
      .update({ content: [{ note: "edited" }] }).eq("event_id", ev!.id).select();
    // RLS UPDATE 거부는 에러가 아니라 "0행 영향"으로 나타난다
    assertEquals(error, null);
    assertEquals(data?.length ?? 0, 0);
  } finally {
    await cleanupUser(email);
  }
});

Deno.test("RLS: Alert 수신자도 dispatches에는 쓸 수 없다", async () => {
  const email = uniqueEmail("recip-dispatch");
  const c = await makeUser(email, "staff");
  try {
    await addAlertRecipient(email);
    const { error } = await c.from("dispatches").insert({ message_id: null, results: [] });
    assert(error !== null, "dispatches 쓰기는 거부돼야 한다");
  } finally {
    await cleanupUser(email);
  }
});
```

- [ ] **Step 3: 테스트를 돌려 실패를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
set -a && source .env.test && set +a
deno test --allow-net --allow-env supabase/functions/_shared/rls_test.ts
```

Expected: FAIL — "Alert 수신자는 messages를 수정할 수 있다" 가 0행 영향으로 실패하고, "Alert 수신자가 아니면 …" 이 1행 수정되어 실패한다. 아직 정책이 `role='approver'`를 보고 있기 때문이다.

- [ ] **Step 4: 마이그레이션을 작성한다**

`supabase/migrations/0007_approver_from_alert_recipients.sql`:

```sql
-- 승인 권한의 출처를 employees.role='approver'에서 alert_recipients 등록 여부로 옮긴다.
--
-- 배경: 화면(Criteria.tsx)은 Alert 수신자를 "승인 권한자"라고 안내하는데 실제 승인 게이트는
-- role='approver'를 보고 있었다. 두 목록이 어긋나 "승인 요청 DM은 받는데 승인은 못 하는"
-- 상태가 운영에서 발생했다(2026-08-13). 승인 요청을 받는 사람과 승인할 수 있는 사람은
-- 정의상 같아야 하므로 alert_recipients를 유일한 출처로 삼는다.
--
-- security definer가 필요한 이유는 기존 current_emp_id()/current_emp_role()과 같다 —
-- 정책 평가 중 employees·alert_recipients를 읽어야 하는데 그 조회 자체가 RLS에 걸리면 순환한다.

create or replace function current_emp_is_approver() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
     select 1 from alert_recipients where employee_id = current_emp_id()
   ) $$;

drop policy if exists w_approver on messages;
create policy w_approver on messages for update
  using (current_emp_is_approver()) with check (current_emp_is_approver());
```

- [ ] **Step 5: 로컬 DB에 적용하고 테스트를 다시 돌린다**

Run:
```bash
cd /Users/ojun/orca/Weather
supabase db reset
set -a && source .env.test && set +a
deno test --allow-net --allow-env supabase/functions/_shared/rls_test.ts
```

Expected: PASS — 3건 모두 통과.

- [ ] **Step 6: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add supabase/migrations/0007_approver_from_alert_recipients.sql supabase/functions/_shared/rls_test.ts
git commit -m "feat(db): messages 수정 권한을 alert_recipients 기준으로 전환

역할(approver)이 아니라 Alert 수신자 등록 여부가 승인 권한을 결정하도록
current_emp_is_approver() 헬퍼를 추가하고 w_approver 정책을 교체했다.
회귀 테스트로 'approver지만 수신자가 아니면 거부', 'staff지만 수신자면 허용'을 고정한다."
```

---

### Task 2: send Edge Function 승인 게이트 교체

`send`의 approve/resend/dismiss 게이트를 Alert 수신자 기준으로 바꾼다. `send`는 service role로 동작해 RLS를 우회하므로 함수 안에서 직접 조회한다.

**Files:**
- Modify: `supabase/functions/send/index.ts:67`
- Test: `supabase/functions/send/index_test.ts` (기존 파일 — `loginAs` 헬퍼 수정 + 신규 2건)

**Interfaces:**
- Consumes: Task 1의 `alert_recipients` 테이블 (스키마 변경 없음 — `employee_id uuid primary key`)
- Produces: `send/index.ts` 내부 함수 `isAlertRecipient(db, employeeId): Promise<boolean>` — 이 파일 안에서만 쓴다

- [ ] **Step 1: 기존 테스트가 전부 깨지는 이유를 확인한다**

`supabase/functions/send/index_test.ts`의 모든 승인 테스트는 `loginAs("approver", ...)`만 하고 `alert_recipients`에는 등록하지 않는다. 게이트를 바꾸면 이 테스트들이 403으로 전부 실패한다. 따라서 `loginAs`가 Alert 수신자 등록까지 하도록 먼저 고친다.

- [ ] **Step 2: `loginAs` 헬퍼를 수정하고 실패 테스트를 추가한다**

`supabase/functions/send/index_test.ts`의 `loginAs`(16~30행)를 아래로 교체한다:

```ts
// asApprover=true면 alert_recipients에도 등록한다 — 승인 권한의 유일한 출처이므로
// 역할만 approver로 줘서는 승인이 되지 않는다.
async function loginAs(role: string, email: string, asApprover = true) {
  const admin = serviceClient();
  const { data: created } = await admin.auth.admin.createUser({ email, password:"pw123456!", email_confirm:true });
  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find(u => u.email === email)?.id;
  }
  if (!userId) throw new Error(`cannot create or find auth user for ${email}`);
  await admin.from("employees").delete().eq("email", email);
  const { data: emp } = await admin.from("employees")
    .insert({ auth_user_id: userId, name: email, email, role }).select().single();
  if (asApprover) {
    await admin.from("alert_recipients").upsert({ employee_id: emp!.id });
  }
  const c = createClient(URL, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data } = await c.auth.signInWithPassword({ email, password:"pw123456!" });
  return data.session!.access_token;
}
```

기존 `Deno.test("send approve: staff는 403", ...)`(124행)은 이제 의미가 달라진다 — staff여도 수신자면 승인 가능해야 한다. 아래 2건을 파일 끝에 추가한다:

```ts
Deno.test("send approve: Alert 수신자가 아니면 approver 역할이어도 403", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events").insert({ kind:"rain", grade:"watch" }).select().single();
  await db.from("messages").insert({ event_id: ev.id, content: [] });
  const token = await loginAs("approver", "nonrecip@t.co", false);   // 수신자 등록 안 함
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content: [] }) });
  assertEquals(res.status, 403);
  const { data: after } = await db.from("weather_events").select("status").eq("id", ev.id).single();
  assertEquals(after!.status, "PENDING_APPROVAL");
});

// 2026-08-13 운영에서 실제로 막혔던 경로의 재현 — admin이 Alert 수신자인데 승인을 못 했다.
Deno.test("send approve: admin이 Alert 수신자면 승인할 수 있다", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events").insert({ kind:"rain", grade:"watch" }).select().single();
  const content = [{ department_id:"d", department_name:"객실", staff_actions:["a"],
    guest_notice:"", recipients:[{ employee_id:"e", name:"홍", kakaowork_user_id:"kw1" }], selected:true }];
  await db.from("messages").insert({ event_id: ev.id, content });
  const token = await loginAs("admin", "adminrecip@t.co");
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content }) });
  assertEquals(res.status, 200);
  const { data: after } = await db.from("weather_events").select("status").eq("id", ev.id).single();
  assertEquals(after!.status, "ACTIVE");
});
```

그리고 124행의 기존 `"send approve: staff는 403"` 테스트를 아래로 교체한다:

```ts
Deno.test("send approve: Alert 수신자가 아닌 staff는 403", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events").insert({ kind:"rain", grade:"watch" }).select().single();
  await db.from("messages").insert({ event_id: ev.id, content: [] });
  const token = await loginAs("staff", "st1@t.co", false);
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content: [] }) });
  assertEquals(res.status, 403);
});
```

- [ ] **Step 3: 테스트를 돌려 실패를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
set -a && source .env.test && set +a
deno test --allow-net --allow-env supabase/functions/send/index_test.ts
```

Expected: FAIL — "admin이 Alert 수신자면 승인할 수 있다"가 403으로 실패하고, "Alert 수신자가 아니면 approver 역할이어도 403"이 200으로 실패한다.

- [ ] **Step 4: 게이트를 교체한다**

`supabase/functions/send/index.ts` — `currentEmployee` 함수 바로 아래(10행대)에 헬퍼를 추가한다:

```ts
// 승인 권한은 역할이 아니라 alert_recipients 등록 여부가 결정한다(스펙 2026-08-13).
// send는 service role로 동작해 RLS를 우회하므로 current_emp_is_approver()를 쓰지 않고 직접 조회한다.
async function isAlertRecipient(db: any, employeeId: string): Promise<boolean> {
  const { data } = await db.from("alert_recipients")
    .select("employee_id").eq("employee_id", employeeId).maybeSingle();
  return data !== null;
}
```

그리고 67행을 교체한다:

```ts
  if (!(await isAlertRecipient(db, emp.id))) return new Response("forbidden", { status: 403 }); // 승인은 Alert 수신자 전용
```

주의: `emp.role !== "admin"`으로 게이트하는 `mode === "test"` 블록(62행)은 **그대로 둔다.** 테스트 발송은 설정 점검이라 관리자 기능이 맞다.

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
set -a && source .env.test && set +a
deno test --allow-net --allow-env supabase/functions/send/index_test.ts
deno check supabase/functions/send/index.ts
```

Expected: 전 테스트 PASS, 타입체크 통과.

- [ ] **Step 6: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add supabase/functions/send/index.ts supabase/functions/send/index_test.ts
git commit -m "feat(send): 승인 게이트를 Alert 수신자 기준으로 전환

role='approver' 대신 alert_recipients 등록 여부로 승인·발송 권한을 판정한다.
운영에서 admin이 승인 요청 DM을 받고도 403으로 막혔던 경로를 회귀 테스트로 고정했다."
```

---

### Task 3: 프런트 승인 권한 판정 단일화

`isApprover`를 `AuthProvider` 한 곳에서 계산해 화면들이 같은 값을 쓰게 한다. 화면마다 조건을 쓰면 이번 같은 어긋남이 다시 생긴다.

**Files:**
- Modify: `apps/web/src/auth/AuthProvider.tsx`
- Modify: `apps/web/src/pages/Dashboard.tsx:251`
- Modify: `apps/web/src/pages/EventReview.tsx:387`
- Test: `apps/web/src/pages/EventReview.test.tsx` (기존 파일 — 모킹 보강 + 신규 2건)

**Interfaces:**
- Produces: `useAuth()` 반환값에 `isApprover: boolean` 추가. 기존 `employee`, `loading`, `signOut`은 그대로. Task 4가 이 값을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/pages/EventReview.test.tsx`의 `mocks.authState`는 현재 `{ employee, loading }`만 갖는다. `isApprover`를 추가하고 테스트 2건을 파일 끝의 `describe` 안에 넣는다.

먼저 hoisted 모킹을 수정한다:

```ts
const mocks = vi.hoisted(() => ({
  fromImpl: (_table: string): any => ({ then: (resolve: any) => resolve({ data: null, error: null }) }),
  callSend: vi.fn(),
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));
```

그리고 테스트 2건을 추가한다(`approver` 상수와 렌더 헬퍼는 같은 파일에 이미 있다 — 파일의 기존 렌더 헬퍼 이름을 그대로 쓴다):

```ts
it("Alert 수신자가 아니면 승인 및 발송 버튼이 보이지 않는다", async () => {
  mocks.authState.employee = { ...approver, role: "approver" };
  mocks.authState.isApprover = false;
  renderEventReview();
  expect(await screen.findByText(/폭우/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /승인 및 발송/ })).not.toBeInTheDocument();
});

it("역할이 admin이어도 Alert 수신자면 승인 및 발송 버튼이 보인다", async () => {
  mocks.authState.employee = { ...approver, role: "admin" };
  mocks.authState.isApprover = true;
  renderEventReview();
  expect(await screen.findByRole("button", { name: /승인 및 발송/ })).toBeInTheDocument();
});
```

기존 테스트들은 `mocks.authState.isApprover = true`를 `beforeEach`에서 세팅해 준다:

```ts
beforeEach(() => {
  mocks.authState.isApprover = true;
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run src/pages/EventReview.test.tsx
```

Expected: FAIL — "역할이 admin이어도 …"에서 버튼을 못 찾는다. `canEdit`이 아직 `role === "approver"`를 보기 때문이다.

- [ ] **Step 3: AuthProvider에 isApprover를 추가한다**

`apps/web/src/auth/AuthProvider.tsx` — 타입과 상태, 조회를 함께 수정한다:

```tsx
type AuthState = { employee: Employee | null; loading: boolean; isApprover: boolean; signOut(): void };

const Ctx = createContext<AuthState>({
  employee: null,
  loading: true,
  isApprover: false,
  signOut: () => {},
});
```

`AuthProvider` 본문:

```tsx
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [isApprover, setIsApprover] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        setEmployee(null);
        setIsApprover(false);
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("employees")
        .select("*")
        .eq("auth_user_id", user.id)
        .single();
      setEmployee(data);
      // 승인 권한은 역할이 아니라 Alert 수신자 등록 여부가 결정한다(스펙 2026-08-13).
      // 서버가 최종 게이트이므로 이 값은 화면 노출 제어용이다.
      if (data) {
        const { data: recip } = await supabase
          .from("alert_recipients")
          .select("employee_id")
          .eq("employee_id", data.id)
          .maybeSingle();
        setIsApprover(recip !== null);
      } else {
        setIsApprover(false);
      }
      setLoading(false);
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <Ctx.Provider
      value={{ employee, loading, isApprover, signOut: () => void supabase.auth.signOut() }}
    >
      {children}
    </Ctx.Provider>
  );
```

- [ ] **Step 4: 두 화면의 조건을 교체한다**

`apps/web/src/pages/EventReview.tsx:387` — `useAuth()` 구조분해에 `isApprover`를 추가하고(파일 상단의 기존 `const { employee } = useAuth();`를 `const { employee, isApprover } = useAuth();`로) 387행을 바꾼다:

```tsx
  const canEdit = isApprover && event?.status === "PENDING_APPROVAL";
```

`apps/web/src/pages/Dashboard.tsx:251` — 마찬가지로 `useAuth()`에서 `isApprover`를 받고 조건을 바꾼다:

```tsx
            {isApprover && (
              <Link to={`/events/${pendingEvent.id}`}>
                <Button variant="primary">초안 검토하기</Button>
              </Link>
            )}
```

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run
npx tsc -b
```

Expected: 전 테스트 PASS, 타입 오류 없음.

- [ ] **Step 6: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/auth/AuthProvider.tsx apps/web/src/pages/Dashboard.tsx apps/web/src/pages/EventReview.tsx apps/web/src/pages/EventReview.test.tsx
git commit -m "feat(web): 승인 권한 판정을 AuthProvider의 isApprover로 단일화

Dashboard와 EventReview가 각자 role==='approver'를 검사하던 것을
Alert 수신자 등록 여부 한 곳으로 모았다. 화면마다 조건을 두면 이번처럼
서버 게이트와 어긋난다."
```

---

### Task 4: 부서 미지정 Alert 수신자의 승인 화면 접근 허용

`/events/:id`는 `requireDepartment`를 요구하고, `RequireRole`은 `role === 'staff' && department_id === null`을 막는다. 승인은 부서 단위 업무가 아니므로 Alert 수신자는 통과시킨다.

**Files:**
- Modify: `apps/web/src/auth/RequireRole.tsx`
- Test: `apps/web/src/auth/RequireRole.test.tsx` (기존 파일 — 모킹 보강 + 신규 1건)

**Interfaces:**
- Consumes: Task 3의 `useAuth().isApprover`

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/auth/RequireRole.test.tsx`의 hoisted 모킹에 `isApprover`를 추가한다:

```ts
const mocks = vi.hoisted(() => ({
  authState: { employee: null as Employee | null, loading: false, isApprover: false },
}));
```

기존 테스트가 깨지지 않도록 `beforeEach`에서 기본값을 리셋하고(파일에 `beforeEach`가 없으면 `describe` 안에 추가), 신규 테스트를 넣는다:

```ts
beforeEach(() => {
  mocks.authState.isApprover = false;
});

it("부서 미지정 staff라도 Alert 수신자면 통과시킨다", () => {
  mocks.authState.employee = makeEmployee({ role: "staff", department_id: null });
  mocks.authState.isApprover = true;
  renderAt("/protected", true);
  expect(screen.getByText("보호된 화면")).toBeInTheDocument();
});
```

`renderAt`의 두 번째 인자가 `requireDepartment`이고, 통과 시 렌더되는 문구는 파일 상단 `renderAt` 정의에 있는 것을 그대로 쓴다. `beforeEach`를 새로 넣는 경우 `vitest`에서 import 한다.

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run src/auth/RequireRole.test.tsx
```

Expected: FAIL — 대시보드로 리다이렉트되어 "보호된 화면"을 찾지 못한다.

- [ ] **Step 3: 부서 게이트에 예외를 추가한다**

`apps/web/src/auth/RequireRole.tsx`:

```tsx
export function RequireRole({
  roles,
  requireDepartment = false,
  children,
}: {
  roles: string[];
  /** true면 부서 미지정 실무자(staff, department_id null)의 접근을 차단하고 대시보드로 되돌린다.
   *  단 Alert 수신자는 예외 — 승인은 부서 단위 업무가 아니라 전사 판단이다. */
  requireDepartment?: boolean;
  children: ReactNode;
}) {
  const { employee, loading, isApprover } = useAuth();
  if (loading) return null;
  if (!employee) return <Navigate to="/login" replace />;
  if (!roles.includes(employee.role)) return <Navigate to="/" replace />;
  if (
    requireDepartment &&
    !isApprover &&
    employee.role === "staff" &&
    employee.department_id === null
  ) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run
```

Expected: 전 테스트 PASS.

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/auth/RequireRole.tsx apps/web/src/auth/RequireRole.test.tsx
git commit -m "feat(web): Alert 수신자는 부서 미지정이어도 승인 화면에 접근한다

승인은 부서 단위 업무가 아니라 전사 판단이므로 requireDepartment 게이트에서
Alert 수신자를 예외 처리한다."
```

---

### Task 5: 역할 라벨 단일화 + `사업부장` → `부서장`

`ROLE_LABEL`이 4개 파일에 각각 정의되어 있다. `사업부장`을 고치는 김에 한 곳으로 합친다 — 흩어진 채로 두면 다음에 또 어긋난다.

**Files:**
- Create: `apps/web/src/lib/roles.ts`
- Modify: `apps/web/src/components/GlobalNav.tsx:8`
- Modify: `apps/web/src/pages/Employees.tsx:14`
- Modify: `apps/web/src/pages/Guidelines.tsx:18`
- Modify: `apps/web/src/pages/Criteria.tsx:26`
- Test: `apps/web/src/lib/__tests__/roles.test.ts`

**Interfaces:**
- Produces: `export const ROLE_LABEL: Record<EmpRole, string>` — 위 4개 파일이 import 한다

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/lib/__tests__/roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ROLE_LABEL } from "../roles";

describe("ROLE_LABEL", () => {
  it("세 역할의 표시 이름을 제공한다", () => {
    expect(ROLE_LABEL.admin).toBe("시스템 관리자");
    expect(ROLE_LABEL.approver).toBe("부서장");
    expect(ROLE_LABEL.staff).toBe("실무자");
  });

  // '사업부장'은 직급 예시였을 뿐이고, 승인 권한이 alert_recipients로 옮겨간 뒤
  // 이 역할이 실제로 하는 일은 '전 부서 지침 열람'이다. 옛 라벨이 되살아나지 않게 고정한다.
  it("사업부장이라는 표현을 쓰지 않는다", () => {
    expect(Object.values(ROLE_LABEL)).not.toContain("사업부장");
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run src/lib/__tests__/roles.test.ts
```

Expected: FAIL — `../roles` 모듈을 찾지 못한다.

- [ ] **Step 3: 공용 상수를 만든다**

`apps/web/src/lib/roles.ts`:

```ts
import type { EmpRole } from "./types";

// 역할 표시 이름의 단일 출처. 화면마다 각자 정의하면 어긋난다(2026-08-13에 실제로 어긋났다).
//
// approver는 원래 '사업부장'으로 표기했으나, 사업부장은 이 자리에 앉힐 사람의 직급 예시였을 뿐이다.
// 승인 권한이 alert_recipients로 옮겨간 뒤 이 역할이 실제로 하는 일은 전 부서 지침 열람이므로
// 직급 색을 뺀 '부서장'으로 표기한다.
export const ROLE_LABEL: Record<EmpRole, string> = {
  admin: "시스템 관리자",
  approver: "부서장",
  staff: "실무자",
};
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run src/lib/__tests__/roles.test.ts
```

Expected: PASS.

- [ ] **Step 5: 4개 파일의 중복 정의를 제거하고 import로 바꾼다**

각 파일에서 로컬 `const ROLE_LABEL: Record<EmpRole, string> = { ... };` 정의를 삭제하고 import를 추가한다.

- `apps/web/src/components/GlobalNav.tsx` — 8행의 정의 블록 삭제
- `apps/web/src/pages/Employees.tsx` — 14행의 정의 블록 삭제
- `apps/web/src/pages/Guidelines.tsx` — 18행의 정의 한 줄 삭제
- `apps/web/src/pages/Criteria.tsx` — 26행의 정의 블록 삭제

네 파일 모두 상단 import에 아래를 추가한다(상대 경로는 파일 위치에 맞춘다 — `pages/`와 `components/`는 둘 다 `../lib/roles`):

```ts
import { ROLE_LABEL } from "../lib/roles";
```

`EmpRole` 타입 import가 `ROLE_LABEL` 정의에만 쓰였다면 함께 제거한다. `npx tsc -b`가 미사용 import를 잡아준다.

- [ ] **Step 6: 전체 테스트와 타입체크를 돌린다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx tsc -b
npx vitest run
```

Expected: 타입 오류 없음, 전 테스트 PASS.

- [ ] **Step 7: 화면에 '사업부장'이 남아있지 않은지 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
grep -rn "사업부장" apps/web/src || echo "남아있지 않음"
```

Expected: "남아있지 않음". (`docs/`와 `design/`의 과거 문서는 그대로 두어도 된다 — 당시 결정의 기록이다.)

- [ ] **Step 8: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/lib/roles.ts apps/web/src/lib/__tests__/roles.test.ts \
  apps/web/src/components/GlobalNav.tsx apps/web/src/pages/Employees.tsx \
  apps/web/src/pages/Guidelines.tsx apps/web/src/pages/Criteria.tsx
git commit -m "refactor(web): 역할 라벨을 lib/roles.ts로 단일화하고 사업부장→부서장

4개 파일에 중복 정의돼 있던 ROLE_LABEL을 한 곳으로 모았다.
'사업부장'은 직급 예시였고 승인 권한이 분리된 뒤 이 역할이 하는 일은
전 부서 지침 열람뿐이므로 '부서장'으로 바꿨다."
```

---

### Task 6: 전체 회귀 + 운영 배포

**Files:**
- Modify: `docs/superpowers/specs/2026-08-12-weather-management-design.md` (결정 8 갱신)

- [ ] **Step 1: 백엔드 전체 테스트**

Run:
```bash
cd /Users/ojun/orca/Weather
supabase db reset
set -a && source .env.test && set +a
deno test --allow-env \
  supabase/functions/_shared/engine_test.ts \
  supabase/functions/_shared/derive_test.ts \
  supabase/functions/_shared/kma_test.ts \
  supabase/functions/_shared/template_test.ts \
  supabase/functions/_shared/kakaowork_test.ts \
  supabase/functions/_shared/cors_test.ts
deno test --allow-net --allow-env supabase/functions/_shared/rls_test.ts
deno test --allow-net --allow-env supabase/functions/send/index_test.ts
deno check supabase/functions/_shared/*.ts supabase/functions/*/index.ts
```

Expected: 전부 PASS, 타입 오류 없음.

- [ ] **Step 2: 웹 전체 테스트 + 빌드**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx tsc -b
npx vitest run
npm run build
```

Expected: 전부 PASS, 빌드 성공.

- [ ] **Step 3: 원 스펙의 결정 8을 갱신한다**

`docs/superpowers/specs/2026-08-12-weather-management-design.md`의 결정 8 행을 아래로 교체한다:

```
| 8 | 권한 | 화면 접근은 3역할: 시스템관리자(설정) / 부서장(전 부서 열람) / 실무자(자기 부서 조회). **승인·발송 권한은 역할이 아니라 `alert_recipients` 등록 여부가 결정한다** (2026-08-13 갱신, `2026-08-13-approval-authority-design.md` 참조) |
```

- [ ] **Step 4: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add docs/superpowers/specs/2026-08-12-weather-management-design.md
git commit -m "docs(spec): 결정 8을 승인 권한 단일화 결과로 갱신"
```

- [ ] **Step 5: 운영 배포 (마이그레이션 → 함수 → 웹 순서)**

Run:
```bash
cd /Users/ojun/orca/Weather
set -a && source .env; set +a
psql "postgresql://postgres.appkkuihlkbkvllsvymx:${SUPABASE_DB_PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres" \
  -f supabase/migrations/0007_approver_from_alert_recipients.sql
npx supabase functions deploy send --project-ref appkkuihlkbkvllsvymx
git push origin main   # Cloudflare가 웹을 자동 빌드·배포
```

Expected: 마이그레이션 `CREATE FUNCTION` + `CREATE POLICY` 성공, 함수 배포 성공, 푸시 성공.

- [ ] **Step 6: 운영에서 승인 권한이 실제로 바뀌었는지 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
set -a && source .env; set +a
psql "postgresql://postgres.appkkuihlkbkvllsvymx:${SUPABASE_DB_PASSWORD}@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres" -c \
"select e.email, e.role,
        (ar.employee_id is not null) as 승인가능
 from employees e left join alert_recipients ar on ar.employee_id = e.id;"
```

Expected: 관리자 계정의 `승인가능`이 `t`. 이 값이 `t`인 사람이 최소 1명 있어야 시스템이 승인을 처리할 수 있다.

- [ ] **Step 7: 배포된 웹에서 승인 버튼이 보이는지 확인한다**

`https://weather.gonjiam.workers.dev` 에 로그인해 대시보드를 연다. 승인 대기 중인 특보가 있으면 배너에 **[초안 검토하기]** 버튼이 보여야 하고, 없으면 `⑥ 직원 관리`에서 본인 역할이 `시스템 관리자`로 표시되는지와 `① 특보 기준` 하단의 Alert 수신자 칩이 `부서장`/`시스템 관리자`로 표기되는지 확인한다(`사업부장` 문구가 사라졌는지).

브라우저 캐시가 남아 있으면 `Cmd+Shift+R`로 하드 리로드한다.

---

## Self-Review

**1. 스펙 커버리지**

| 스펙 항목 | 담당 태스크 |
|---|---|
| 3번 표 #1 `send/index.ts:67` | Task 2 |
| 3번 표 #2 `0002_rls.sql:56` | Task 1 |
| 3번 표 #3 `Dashboard.tsx:251`, `EventReview.tsx:387` | Task 3 |
| 3.1 `current_emp_is_approver()` | Task 1 Step 4 |
| 3.2 프런트 단일 판정 지점 | Task 3 (`AuthProvider.isApprover`) |
| 3.3 부서 미지정 승인자 접근 | Task 4 |
| 4.1 체크리스트 의미 회복 | 코드 변경 불필요 — `lib/setup.ts`가 이미 `alertRecipientCount > 0`을 검사하고, 그 값이 이제 "승인 가능한 사람 수"를 뜻하게 된다 |
| 4.2 라벨 `사업부장`→`부서장` + 4곳 중복 제거 | Task 5 |
| 5 엣지 케이스 | Task 1·2의 회귀 테스트가 "수신자 아님→거부", "역할 무관→허용"을 고정. 수신자 0명은 4.1의 체크리스트가 담당 |
| 6 테스트 목록 | Task 1(RLS 3건), Task 2(Edge 3건), Task 3(프런트 2건), Task 4(1건), Task 5(2건) |
| 7 범위 밖 | enum 개명·A′ 트랙·감사 로그는 어떤 태스크에도 없음 (의도됨) |

**2. 플레이스홀더 스캔** — "TBD"/"적절히 처리"/"위 내용에 대한 테스트 작성" 없음. 모든 코드 단계에 실제 코드 블록 있음.

**3. 타입 일관성** — `isApprover: boolean`이 Task 3에서 정의되고 Task 4에서 소비된다. `ROLE_LABEL: Record<EmpRole, string>`이 Task 5에서 정의되고 같은 태스크의 4개 파일이 소비한다. `isAlertRecipient(db, employeeId)`는 Task 2 내부에서만 쓰인다. `current_emp_is_approver()`는 Task 1의 정책에서만 쓰인다(Task 2는 service role이라 사용하지 않음 — 명시함).

**발견해 수정한 것:** Task 2에서 기존 `loginAs` 헬퍼가 `alert_recipients`를 등록하지 않아 기존 승인 테스트 6건이 전부 403으로 깨진다는 점을 놓칠 뻔했다. Step 2에 헬퍼 수정을 먼저 넣었다.
