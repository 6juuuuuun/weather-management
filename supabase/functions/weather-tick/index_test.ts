import { assertEquals, assertExists } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";

// 전제: supabase start + db reset + `supabase functions serve --env-file .env.test` 실행 중
// env: NOTIFY_CHANNEL=console, CRON_SECRET=test-secret
const FN = "http://127.0.0.1:54321/functions/v1/weather-tick";

function kmaMock(items: Array<{ category: string; obsrValue: string; baseDate?: string; baseTime?: string }>) {
  return JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: items } } } });
}

async function tick(mock: string) {
  const res = await fetch(FN, { method: "POST",
    headers: { "x-cron-secret": "test-secret", "x-mock-kma": mock } });
  const body = await res.json();
  return { res, body };
}

// dispatches → messages → weather_events 순서로 삭제 (FK 제약)
async function resetEvents(db: ReturnType<typeof serviceClient>) {
  await db.from("dispatches").delete().neq("id", -1);
  await db.from("messages").delete().neq("id", crypto.randomUUID());
  await db.from("weather_events").delete().neq("id", crypto.randomUUID());
}

async function upsertEmployee(db: ReturnType<typeof serviceClient>, email: string, kakaoId: string, role = "staff") {
  await db.from("employees").delete().eq("email", email);
  const { data } = await db.from("employees")
    .insert({ name: email, email, kakaowork_user_id: kakaoId, role }).select().single();
  return data;
}

Deno.test("weather-tick: 폭우 관측 → 특보 생성 + 초안 생성", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const mock = kmaMock([
    { category:"RN1", obsrValue:"32.5", baseDate:"20260812", baseTime:"0800" },
    { category:"T1H", obsrValue:"22.0" }, { category:"WSD", obsrValue:"3.0" },
    { category:"REH", obsrValue:"80" }, { category:"PTY", obsrValue:"1" } ]);
  const { res } = await tick(mock);
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

Deno.test("weather-tick: 관측 실패 시 missing 행 저장 + 판정 스킵", async () => {
  const db = serviceClient();
  await resetEvents(db);
  // resultCode !== "00" → parseKmaResponse가 throw → missing:true 경로
  const mock = JSON.stringify({ response: { header: { resultCode: "03" } } });
  const { res, body } = await tick(mock);
  assertEquals(res.status, 200);
  assertEquals(body.actions, []);
  const { data: rows } = await db.from("weather_observations")
    .select("missing").order("observed_at", { ascending: false }).limit(1);
  assertEquals(rows?.[0]?.missing, true);
});

Deno.test("weather-tick: 경보 관측 → 기존 주의보 ESCALATED + 신규 경보 초안", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: watchEv } = await db.from("weather_events")
    .insert({ kind:"rain", grade:"watch", status:"ACTIVE", approved_at: new Date().toISOString() })
    .select().single();
  const mock = kmaMock([
    { category:"RN1", obsrValue:"62.0", baseDate:"20260812", baseTime:"1100" },
    { category:"T1H", obsrValue:"21.0" }, { category:"WSD", obsrValue:"3.0" },
    { category:"REH", obsrValue:"75" }, { category:"PTY", obsrValue:"1" } ]);
  const { res } = await tick(mock);
  assertEquals(res.status, 200);
  const { data: escalated } = await db.from("weather_events").select("*").eq("id", watchEv.id).single();
  assertEquals(escalated.status, "ESCALATED");
  assertExists(escalated.closed_at);
  const { data: warnEv } = await db.from("weather_events").select("*").eq("kind","rain").eq("grade","warning").single();
  assertEquals(warnEv.status, "PENDING_APPROVAL");
  const { data: msg } = await db.from("messages").select("*").eq("event_id", warnEv.id).single();
  assertEquals(msg.status, "draft");
});

Deno.test("weather-tick: 승인된 메시지 있는 ACTIVE 특보 → 반복 발송 (dispatches insert + repeat_count 증가)", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events")
    .insert({ kind:"wind", grade:"watch", status:"ACTIVE", approved_at: new Date().toISOString(), repeat_count: 0 })
    .select().single();
  const content = [{ department_id: crypto.randomUUID(), department_name: "테스트부서",
    staff_actions: ["강풍 대비 실외 시설물 고정"], guest_notice: "",
    recipients: [{ employee_id: crypto.randomUUID(), name: "repeat-담당자", kakaowork_user_id: "repeat-uid-1" }],
    selected: true }];
  const { data: msg } = await db.from("messages").insert({ event_id: ev.id, status:"approved", content }).select().single();

  // 주의보 임계 14 이상, 경보 임계 21 미만 → repeat만 발생 (escalate/create 없음)
  const mock = kmaMock([
    { category:"WSD", obsrValue:"18.0", baseDate:"20260812", baseTime:"0900" },
    { category:"RN1", obsrValue:"0.0" }, { category:"T1H", obsrValue:"20.0" },
    { category:"REH", obsrValue:"70" }, { category:"PTY", obsrValue:"0" } ]);
  const { res } = await tick(mock);
  assertEquals(res.status, 200);

  const { data: updatedEv } = await db.from("weather_events").select("repeat_count").eq("id", ev.id).single();
  assertEquals(updatedEv?.repeat_count, 1);
  const { data: disp } = await db.from("dispatches").select("*").eq("event_id", ev.id).eq("message_id", msg.id).single();
  assertEquals(disp.repeat_no, 1);
  assertEquals((disp.results as any[])[0].ok, true);
});

Deno.test("weather-tick: 해제 — 승인된 메시지 있는 경우 부서 수신자에게 해제 알림", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const { data: ev } = await db.from("weather_events")
    .insert({ kind:"wind", grade:"watch", status:"ACTIVE", approved_at: new Date().toISOString() })
    .select().single();
  const content = [{ department_id: crypto.randomUUID(), department_name: "테스트부서",
    staff_actions: ["강풍 대비 실외 시설물 고정"], guest_notice: "",
    recipients: [{ employee_id: crypto.randomUUID(), name: "resolve-담당자", kakaowork_user_id: "resolve-uid-approved" }],
    selected: true }];
  await db.from("messages").insert({ event_id: ev.id, status:"approved", content });

  // 임계 미만 → resolve
  const mock = kmaMock([
    { category:"WSD", obsrValue:"2.0", baseDate:"20260812", baseTime:"1000" },
    { category:"RN1", obsrValue:"0.0" }, { category:"T1H", obsrValue:"20.0" },
    { category:"REH", obsrValue:"70" }, { category:"PTY", obsrValue:"0" } ]);
  const { res } = await tick(mock);
  assertEquals(res.status, 200);

  const { data: resolved } = await db.from("weather_events").select("*").eq("id", ev.id).single();
  assertEquals(resolved.status, "RESOLVED");
  assertExists(resolved.closed_at);
});

Deno.test("weather-tick: 해제 — 승인된 메시지 없는 경우(자동 종료) alert_recipients 전원에게 알림", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const emp = await upsertEmployee(db, "alertrecv@t.co", "alert-recv-uid", "approver");
  await db.from("alert_recipients").delete().eq("employee_id", emp.id);
  await db.from("alert_recipients").insert({ employee_id: emp.id });

  const { data: ev } = await db.from("weather_events")
    .insert({ kind:"heat", grade:"watch", status:"PENDING_APPROVAL" })
    .select().single();
  // 이 이벤트에는 approved 메시지가 없음 (draft조차 없음) → 자동 종료 분기

  // 임계(temp_c 33 / feels_c 31) 미만 관측 → resolve
  const mock = kmaMock([
    { category:"T1H", obsrValue:"20.0", baseDate:"20260812", baseTime:"1200" },
    { category:"WSD", obsrValue:"2.0" }, { category:"REH", obsrValue:"60" },
    { category:"RN1", obsrValue:"0.0" }, { category:"PTY", obsrValue:"0" } ]);
  const { res } = await tick(mock);
  assertEquals(res.status, 200);

  const { data: resolved } = await db.from("weather_events").select("*").eq("id", ev.id).single();
  assertEquals(resolved.status, "RESOLVED");
  assertExists(resolved.closed_at);
  // approved 메시지가 없었음을 재확인 (분기 전제 검증)
  const { data: approvedMsg } = await db.from("messages").select("*").eq("event_id", ev.id).eq("status","approved").maybeSingle();
  assertEquals(approvedMsg, null);

  await db.from("alert_recipients").delete().eq("employee_id", emp.id);
});

Deno.test("weather-tick: 3연속 결측 관측 시 admin 전원에게 시스템 알림 + heartbeat ok:false", async () => {
  const db = serviceClient();
  await resetEvents(db);
  // 이 테스트는 관측 시각의 상대적 순서(직전 2시간이 모두 missing)에 의존하므로,
  // 이전 테스트들이 남긴 weather_observations와 섞이지 않도록 전체 초기화한다.
  await db.from("weather_observations").delete().neq("id", -1);

  const admin = await upsertEmployee(db, "admin-alert@t.co", "admin-alert-uid", "admin");

  // missing 경로의 observed_at은 벽시계 현재 시각을 시 단위로 절삭한 값이므로,
  // 동일한 절삭 규칙으로 직전 2시간에 결측 행을 미리 심어둔다.
  const hourMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  await db.from("weather_observations").insert([
    { observed_at: new Date(hourMs - 2 * 3_600_000).toISOString(), missing: true, raw: { seed: true } },
    { observed_at: new Date(hourMs - 1 * 3_600_000).toISOString(), missing: true, raw: { seed: true } },
  ]);

  // resultCode !== "00" → parseKmaResponse가 throw → 현재 시(3번째)도 missing으로 저장됨
  const mock = JSON.stringify({ response: { header: { resultCode: "03" } } });
  const { res, body } = await tick(mock);
  assertEquals(res.status, 200);
  assertEquals(body.actions, []);

  const { data: obsRows } = await db.from("weather_observations")
    .select("missing").order("observed_at", { ascending: false }).limit(3);
  assertEquals(obsRows?.length, 3);
  assertEquals(obsRows?.every((r) => r.missing === true), true);

  const { data: hb } = await db.from("heartbeats").select("*").eq("name", "weather-tick").single();
  assertEquals(hb.ok, false);
  assertEquals(hb.note, "missing");

  await db.from("employees").delete().eq("id", admin.id);
});
