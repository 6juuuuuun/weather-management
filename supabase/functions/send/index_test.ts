import { assertEquals } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + `supabase functions serve --env-file .env.test` 실행 중
const URL = "http://127.0.0.1:54321";
const FN = `${URL}/functions/v1/send`;

// dispatches → messages → weather_events 순서로 삭제 (FK 제약)
async function resetEvents(db: ReturnType<typeof serviceClient>) {
  await db.from("dispatches").delete().neq("id", -1);
  await db.from("messages").delete().neq("id", crypto.randomUUID());
  await db.from("weather_events").delete().neq("id", crypto.randomUUID());
}

async function loginAs(role: string, email: string) {
  const admin = serviceClient();
  const { data: created } = await admin.auth.admin.createUser({ email, password:"pw123456!", email_confirm:true });
  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find(u => u.email === email)?.id;
  }
  if (!userId) throw new Error(`cannot create or find auth user for ${email}`);
  await admin.from("employees").delete().eq("email", email);
  await admin.from("employees").insert({ auth_user_id: userId, name: email, email, role });
  const c = createClient(URL, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data } = await c.auth.signInWithPassword({ email, password:"pw123456!" });
  return data.session!.access_token;
}

Deno.test("send approve: approver가 승인하면 ACTIVE + dispatches 기록", async () => {
  const db = serviceClient();
  await resetEvents(db);
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
  assertEquals(after!.status, "ACTIVE");
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

Deno.test("send dismiss: approver가 무시하면 DISMISSED + closed_at은 null 유지", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events").insert({ kind:"wind", grade:"watch" }).select().single();
  const token = await loginAs("approver", "ap3@t.co");
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"dismiss", event_id: ev.id }) });
  assertEquals(res.status, 200);
  const { data: after } = await db.from("weather_events").select("status, closed_at").eq("id", ev.id).single();
  assertEquals(after!.status, "DISMISSED");
  assertEquals(after!.closed_at, null);
});

Deno.test("send dismiss: PENDING_APPROVAL이 아니면 409 + 상태 불변", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events")
    .insert({ kind:"heat", grade:"watch", status:"ACTIVE" }).select().single();
  const token = await loginAs("approver", "ap4@t.co");
  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"dismiss", event_id: ev.id }) });
  assertEquals(res.status, 409);
  const { data: after } = await db.from("weather_events").select("status").eq("id", ev.id).single();
  assertEquals(after!.status, "ACTIVE");
});
