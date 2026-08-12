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

Deno.test("send: dispatches.content는 발송 시점 스냅샷이며 재발송으로 messages.content가 바뀌어도 불변", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events").insert({ kind:"snow", grade:"watch" }).select().single();
  const approveContent = [{ department_id:"d", department_name:"객실", staff_actions:["a"],
    guest_notice:"승인 시점 내용", recipients:[{ employee_id:"e", name:"홍", kakaowork_user_id:"kw1" }], selected:true }];
  await db.from("messages").insert({ event_id: ev.id, content: approveContent });
  const token = await loginAs("approver", "ap5@t.co");

  const approveRes = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content: approveContent }) });
  assertEquals(approveRes.status, 200);

  const { data: msgAfterApprove } = await db.from("messages").select("id").eq("event_id", ev.id).single();
  const { data: dispatchAfterApprove } = await db.from("dispatches")
    .select("content").eq("event_id", ev.id).eq("repeat_no", 1).single();
  assertEquals(dispatchAfterApprove!.content, approveContent);

  // 재발송으로 messages.content 변경
  const resendContent = [{ department_id:"d", department_name:"객실", staff_actions:["a"],
    guest_notice:"재발송으로 수정된 내용", recipients:[{ employee_id:"e", name:"홍", kakaowork_user_id:"kw1" }], selected:true }];
  const resendRes = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"resend", message_id: msgAfterApprove!.id, content: resendContent }) });
  assertEquals(resendRes.status, 200);

  // 과거(1회차) dispatch의 content는 승인 시점 그대로 불변
  const { data: dispatchAfterResend } = await db.from("dispatches")
    .select("content").eq("event_id", ev.id).eq("repeat_no", 1).single();
  assertEquals(dispatchAfterResend!.content, approveContent);

  // 새(2회차) dispatch의 content는 재발송 시점 내용
  const { data: newDispatch } = await db.from("dispatches")
    .select("content").eq("event_id", ev.id).eq("repeat_no", 2).single();
  assertEquals(newDispatch!.content, resendContent);
});

Deno.test("send approve: 발송 본문에 트리거 관측 수치가 들어가고 회차는 repeat_count 기준으로 1", async () => {
  const db = serviceClient();
  await resetEvents(db);
  // 특보를 발생시킨 관측 — weather-tick의 자동 반복 발송과 같은 포맷으로 본문에 실려야 한다.
  // 다른 테스트의 "최근 관측" 정렬을 흔들지 않도록 과거 시각에 심고 끝나면 지운다.
  const observedAt = "2026-01-01T00:00:00.000Z";
  await db.from("weather_observations").delete().eq("observed_at", observedAt);
  const { data: obs } = await db.from("weather_observations").insert({
    observed_at: observedAt, rain_mm_per_hr: 32.5, temp_c: 21,
    feels_c: 24.3, wind_ms: 3, humidity_pct: 75, snow_new_cm: 0, missing: false,
  }).select().single();
  const { data: ev } = await db.from("weather_events")
    .insert({ kind:"rain", grade:"watch", trigger_observation_id: obs!.id }).select().single();
  const content = [{ department_id:"d", department_name:"객실", staff_actions:["a"],
    guest_notice:"", recipients:[{ employee_id:"e", name:"홍", kakaowork_user_id:"kw1" }], selected:true }];
  await db.from("messages").insert({ event_id: ev.id, content });
  const token = await loginAs("approver", "ap6@t.co");

  const res = await fetch(FN, { method:"POST",
    headers: { Authorization:`Bearer ${token}`, "Content-Type":"application/json" },
    body: JSON.stringify({ mode:"approve", event_id: ev.id, content }) });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.obs_line, "시간당 32.5mm · 21℃(체감 24.3) · 풍속 3m/s");
  assertEquals(body.repeat_no, 1);

  // 회차 채번의 단일 소스가 갱신되었는지 (승인 = 1회차)
  const { data: after } = await db.from("weather_events").select("repeat_count").eq("id", ev.id).single();
  assertEquals(after!.repeat_count, 1);
  const { data: d } = await db.from("dispatches").select("repeat_no").eq("event_id", ev.id).single();
  assertEquals(d!.repeat_no, 1);

  await resetEvents(db);   // 관측 행 삭제 전에 FK(weather_events.trigger_observation_id) 해제
  await db.from("weather_observations").delete().eq("observed_at", observedAt);
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
