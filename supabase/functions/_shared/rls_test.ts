import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { assertEquals, assert } from "jsr:@std/assert";

const URL = Deno.env.get("SUPABASE_URL")!;
const SR = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL, SR);

// 하드코딩 이메일로 유저를 만들고 정리하지 않으면 db reset 없이 재실행할 때 전부 실패한다.
// 매 실행마다 랜덤 이메일을 쓰고, 테스트가 끝나면 employees + auth 유저를 반드시 지운다.
function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@rls.test`;
}

async function makeUser(email: string, role: string): Promise<SupabaseClient> {
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password: "pw123456!", email_confirm: true,
  });
  if (error || !u?.user) throw new Error(`createUser 실패: ${error?.message}`);
  const { error: empErr } = await admin.from("employees")
    .insert({ auth_user_id: u.user.id, name: email, email, role });
  if (empErr) throw new Error(`employees insert 실패: ${empErr.message}`);
  const c = createClient(URL, ANON);
  await c.auth.signInWithPassword({ email, password: "pw123456!" });
  return c;
}

async function cleanupUser(email: string) {
  const { data: emp } = await admin.from("employees")
    .select("auth_user_id").eq("email", email).maybeSingle();
  await admin.from("employees").delete().eq("email", email);
  if (emp?.auth_user_id) await admin.auth.admin.deleteUser(emp.auth_user_id);
}

// 테스트 본문을 유저 생성/정리로 감싸 어떤 결과에도 잔여물이 남지 않게 한다(멱등 보장).
async function withUser(prefix: string, role: string, fn: (c: SupabaseClient) => Promise<void>) {
  const email = uniqueEmail(prefix);
  try {
    await fn(await makeUser(email, role));
  } finally {
    await cleanupUser(email);
  }
}

Deno.test("RLS: staff는 기준을 수정할 수 없다", async () => {
  await withUser("staff", "staff", async (staff) => {
    const { data } = await staff.from("weather_criteria")
      .update({ threshold: { rain_mm_per_hr: 1 } }).eq("kind", "rain").eq("grade", "watch").select();
    assertEquals(data, []);   // RLS로 0행 매칭
  });
});

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
  // weather_events(kind, grade)는 열린 건이 1개뿐이어야 하므로(one_open_event),
  // 다음 테스트가 같은 kind/grade로 insert할 수 있도록 반드시 지운다.
  let eventId: string | undefined;
  try {
    await addAlertRecipient(email);
    const { data: ev } = await admin.from("weather_events")
      .insert({ kind: "rain", grade: "watch" }).select().single();
    eventId = ev?.id;
    await admin.from("messages").insert({ event_id: ev!.id, content: [] });
    // error만 보면 0행 매칭도 "에러 없음"으로 통과해버려 승인 거부와 구분이 안 된다.
    // .select()로 실제 영향 행수를 확인해야 승인 허용을 증명할 수 있다.
    const { data, error } = await c.from("messages")
      .update({ content: [{ note: "edited" }] }).eq("event_id", ev!.id).select();
    assertEquals(error, null);
    assertEquals(data?.length ?? 0, 1, "Alert 수신자의 수정은 1행에 적용돼야 한다");
  } finally {
    if (eventId) await admin.from("weather_events").delete().eq("id", eventId);
    await cleanupUser(email);
  }
});

Deno.test("RLS: Alert 수신자가 아니면 messages를 수정할 수 없다 (approver 역할이어도)", async () => {
  const email = uniqueEmail("nonrecip-approver");
  const c = await makeUser(email, "approver");   // 역할은 approver — 그래도 거부돼야 한다
  let eventId: string | undefined;
  try {
    const { data: ev } = await admin.from("weather_events")
      .insert({ kind: "rain", grade: "watch" }).select().single();
    eventId = ev?.id;
    await admin.from("messages").insert({ event_id: ev!.id, content: [] });
    const { data, error } = await c.from("messages")
      .update({ content: [{ note: "edited" }] }).eq("event_id", ev!.id).select();
    // RLS UPDATE 거부는 에러가 아니라 "0행 영향"으로 나타난다
    assertEquals(error, null);
    assertEquals(data?.length ?? 0, 0);
  } finally {
    if (eventId) await admin.from("weather_events").delete().eq("id", eventId);
    await cleanupUser(email);
  }
});

Deno.test("RLS: Alert 수신자도 dispatches에는 쓸 수 없다", async () => {
  const email = uniqueEmail("recip-dispatch");
  const c = await makeUser(email, "staff");
  try {
    await addAlertRecipient(email);
    const { error } = await c.from("dispatches")
      .insert({ message_id: crypto.randomUUID(), event_id: crypto.randomUUID(), results: [] });
    assert(error !== null, "dispatches 쓰기는 거부돼야 한다");
  } finally {
    await cleanupUser(email);
  }
});

Deno.test("RLS: admin은 부서를 생성할 수 있다", async () => {
  await withUser("adm", "admin", async (ad) => {
    const deptName = `테스트부서-${crypto.randomUUID().slice(0, 8)}`;
    const { error } = await ad.from("departments").insert({ name: deptName });
    assertEquals(error, null);
    await admin.from("departments").delete().eq("name", deptName);
  });
});
