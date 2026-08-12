// 전 구간 시나리오 테스트: 감지 → 승인 → 반복발송 → 격상 → 해제
//
// 전제: `supabase start` + `supabase db reset` + `supabase functions serve --env-file .env.test` 실행 중
// 실행: deno test --allow-net --allow-env scripts/scenario-test.ts
// 순서 의존 테스트 — --parallel 실행 금지 (Deno.test들이 같은 특보/누적 상태를 이어받아 진행함)
//
// 시각 조작 없이 x-mock-kma 헤더로 관측값을 주입해 로컬 스택 그대로 전 구간을 검증한다.
// 흐름:
//   1) weather-tick(32.5mm) → 폭우 주의보 PENDING_APPROVAL 생성 + 초안(draft) 확인
//   2) send approve(로그인 사용자 JWT) → ACTIVE + dispatches 1건
//   3) 당일 누적을 반복 임계(80mm) 위로 올린 뒤 weather-tick(25mm) → repeat → dispatches 2건
//   4) weather-tick(55mm, 경보 기준 돌파) → 기존 주의보 ESCALATED + 신규 경보 PENDING_APPROVAL
//   5) send approve(경보) → ACTIVE + dispatches 1건
//   6) 당일 누적을 반복 임계 이하로 되돌린 뒤 weather-tick(2mm) → 경보 RESOLVED
//   7) 최종 상태 확인 — 주의보 ESCALATED · 경보 RESOLVED 모두 종료 상태
//
// 반복(repeat)/해제(resolve) 판정은 시간당 관측치가 아니라 "당일 누적"(KST 자정 기준,
// weather_observations 합산)으로 이뤄지므로(seed.sql: rain 반복정책=until_daily_accum_below, 임계 80mm),
// 단일 mock 값만으로는 임계를 넘기거나 되돌리기 어렵다. 이 스크립트는 이전 시간대 관측 행을
// 직접 시드/조정해 당일 누적을 원하는 값으로 만든 뒤 마지막에 weather-tick을 호출하는 방식을 쓴다.

import { assertEquals, assertExists } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { serviceClient } from "../supabase/functions/_shared/db.ts";

const BASE_URL = "http://127.0.0.1:54321";
const TICK_FN = `${BASE_URL}/functions/v1/weather-tick`;
const SEND_FN = `${BASE_URL}/functions/v1/send`;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "test-secret";

const db = serviceClient();

// --- 헬퍼 -------------------------------------------------------------

function kmaMock(rainMm: number, baseDate: string, baseTime: string): string {
  const items = [
    { category: "RN1", obsrValue: String(rainMm), baseDate, baseTime },
    { category: "T1H", obsrValue: "21.0" },
    { category: "WSD", obsrValue: "3.0" },
    { category: "REH", obsrValue: "75" },
    { category: "PTY", obsrValue: "1" },
  ];
  return JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: items } } } });
}

async function tick(mock: string) {
  const res = await fetch(TICK_FN, {
    method: "POST",
    headers: { "x-cron-secret": CRON_SECRET, "x-mock-kma": mock },
  });
  const body = await res.json();
  return { res, body };
}

async function loginAsApprover(email: string): Promise<string> {
  const admin = serviceClient();
  const { data: created } = await admin.auth.admin.createUser({
    email, password: "pw123456!", email_confirm: true,
  });
  let userId = created?.user?.id;
  if (!userId) {
    const { data: list } = await admin.auth.admin.listUsers();
    userId = list.users.find((u) => u.email === email)?.id;
  }
  if (!userId) throw new Error(`cannot create or find auth user for ${email}`);
  await admin.from("employees").delete().eq("email", email);
  await admin.from("employees").insert({ auth_user_id: userId, name: email, email, role: "approver" });
  const c = createClient(BASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data } = await c.auth.signInWithPassword({ email, password: "pw123456!" });
  return data.session!.access_token;
}

// KST 기준 오늘 날짜(yyyymmdd) — todayAccums(_shared/db.ts)가 쓰는 KST 자정 경계와 맞춘다.
function todayKstBaseDate(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

// weather-tick의 parseKmaResponse와 동일한 방식으로 baseDate/baseTime → observed_at(ISO) 변환.
function observedAtIso(baseDate: string, baseTime: string): string {
  const y = baseDate.slice(0, 4), m = baseDate.slice(4, 6), d = baseDate.slice(6, 8);
  const h = baseTime.slice(0, 2);
  return new Date(`${y}-${m}-${d}T${h}:00:00+09:00`).toISOString();
}

async function seedObservation(baseDate: string, baseTime: string, rainMm: number) {
  await db.from("weather_observations").upsert({
    observed_at: observedAtIso(baseDate, baseTime),
    rain_mm_per_hr: rainMm, temp_c: 20, wind_ms: 2, humidity_pct: 70,
    snow_new_cm: 0, feels_c: 19.5, missing: false, raw: { seed: true },
  }, { onConflict: "observed_at" });
}

async function lowerObservation(baseDate: string, baseTime: string, rainMm: number) {
  await db.from("weather_observations").update({ rain_mm_per_hr: rainMm })
    .eq("observed_at", observedAtIso(baseDate, baseTime));
}

function deptBlock(deptName: string, uid: string, actions: string[], guestNotice: string) {
  return [{
    department_id: crypto.randomUUID(), department_name: deptName,
    staff_actions: actions, guest_notice: guestNotice,
    recipients: [{ employee_id: crypto.randomUUID(), name: `${deptName}-담당자`, kakaowork_user_id: uid }],
    selected: true,
  }];
}

// --- 시나리오 상태 -------------------------------------------------------

const baseDate = todayKstBaseDate();
let approverToken: string;
let watchEventId: string;
let warningEventId: string;

// --- 0. 환경 초기화 -------------------------------------------------------

Deno.test("시나리오 0: 환경 초기화 — 특보/발송 이력/관측값을 비우고 승인자 계정을 준비한다", async () => {
  await db.from("dispatches").delete().neq("id", -1);
  await db.from("messages").delete().neq("id", crypto.randomUUID());
  await db.from("weather_events").delete().neq("id", crypto.randomUUID());
  await db.from("weather_observations").delete().neq("id", -1);
  approverToken = await loginAsApprover("scenario-approver@t.co");
  assertExists(approverToken);
});

// --- 1. 감지 -------------------------------------------------------------

Deno.test("시나리오 1: weather-tick(시간당 32.5mm) → 폭우 주의보 PENDING_APPROVAL 생성 + 초안(draft)", async () => {
  const { res } = await tick(kmaMock(32.5, baseDate, "0100"));
  assertEquals(res.status, 200);

  const { data: ev } = await db.from("weather_events")
    .select("*").eq("kind", "rain").eq("grade", "watch").eq("status", "PENDING_APPROVAL").single();
  assertExists(ev);
  watchEventId = ev!.id;

  const { data: msg } = await db.from("messages").select("*").eq("event_id", watchEventId).single();
  assertEquals(msg!.status, "draft");
});

// --- 2. 승인·발송 ---------------------------------------------------------

Deno.test("시나리오 2: send approve(승인자 JWT) → 주의보 ACTIVE + dispatches 1건", async () => {
  const content = deptBlock("객실팀", "scenario-uid-watch",
    ["우산 비치", "미끄럼 주의 안내판 설치"], "우천으로 일부 야외 시설 운영이 제한될 수 있습니다.");
  const res = await fetch(SEND_FN, {
    method: "POST",
    headers: { Authorization: `Bearer ${approverToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "approve", event_id: watchEventId, content }),
  });
  assertEquals(res.status, 200);

  const { data: ev } = await db.from("weather_events").select("status").eq("id", watchEventId).single();
  assertEquals(ev!.status, "ACTIVE");

  const { data: d } = await db.from("dispatches").select("*").eq("event_id", watchEventId);
  assertEquals(d!.length, 1);
});

// --- 3. 반복발송 -----------------------------------------------------------

Deno.test("시나리오 3: 당일 누적 시드 + weather-tick(25mm) → 반복 임계(80mm) 초과 → repeat → dispatches 2건", async () => {
  // 이전 시간대에 60mm를 직접 시드해, 이번 tick의 25mm를 더하면 당일 누적이 80mm를 넘도록 만든다.
  await seedObservation(baseDate, "0200", 60);

  const { res } = await tick(kmaMock(25, baseDate, "0300"));
  assertEquals(res.status, 200);

  const { data: ev } = await db.from("weather_events").select("status, repeat_count").eq("id", watchEventId).single();
  assertEquals(ev!.status, "ACTIVE");
  assertEquals(ev!.repeat_count, 1);

  const { data: d } = await db.from("dispatches").select("*").eq("event_id", watchEventId);
  assertEquals(d!.length, 2);
});

// --- 4. 격상 ---------------------------------------------------------------

Deno.test("시나리오 4: weather-tick(55mm, 경보 기준 돌파) → 주의보 ESCALATED + 경보 PENDING_APPROVAL 신규", async () => {
  const { res } = await tick(kmaMock(55, baseDate, "0400"));
  assertEquals(res.status, 200);

  const { data: escalated } = await db.from("weather_events").select("*").eq("id", watchEventId).single();
  assertEquals(escalated!.status, "ESCALATED");
  assertExists(escalated!.closed_at);

  const { data: warn } = await db.from("weather_events")
    .select("*").eq("kind", "rain").eq("grade", "warning").eq("status", "PENDING_APPROVAL").single();
  assertExists(warn);
  warningEventId = warn!.id;

  const { data: msg } = await db.from("messages").select("status").eq("event_id", warningEventId).single();
  assertEquals(msg!.status, "draft");
});

// --- 5. 경보 승인·발송 -------------------------------------------------------

Deno.test("시나리오 5: send approve(경보) → 경보 ACTIVE + dispatches 1건", async () => {
  const content = deptBlock("시설팀", "scenario-uid-warning",
    ["침수 취약 구역 배수로 점검", "출입 통제선 설치"], "폭우 경보 발효로 일부 시설 이용이 중단됩니다.");
  const res = await fetch(SEND_FN, {
    method: "POST",
    headers: { Authorization: `Bearer ${approverToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "approve", event_id: warningEventId, content }),
  });
  assertEquals(res.status, 200);

  const { data: ev } = await db.from("weather_events").select("status").eq("id", warningEventId).single();
  assertEquals(ev!.status, "ACTIVE");

  const { data: d } = await db.from("dispatches").select("*").eq("event_id", warningEventId);
  assertEquals(d!.length, 1);
});

// --- 6. 해제 ---------------------------------------------------------------

Deno.test("시나리오 6: 당일 누적 완화 + weather-tick(2mm) → 반복 임계 이하 → 경보 RESOLVED", async () => {
  // 앞서 쌓아둔 시간대별 관측치를 낮춰 당일 누적을 80mm 임계 아래로 되돌린다(12*4=48, +2mm=50 ≤ 80).
  await lowerObservation(baseDate, "0100", 12);
  await lowerObservation(baseDate, "0200", 12);
  await lowerObservation(baseDate, "0300", 12);
  await lowerObservation(baseDate, "0400", 12);

  const { res } = await tick(kmaMock(2, baseDate, "0500"));
  assertEquals(res.status, 200);

  const { data: resolved } = await db.from("weather_events").select("*").eq("id", warningEventId).single();
  assertEquals(resolved!.status, "RESOLVED");
  assertExists(resolved!.closed_at);
});

// --- 7. 전 구간 최종 상태 확인 ------------------------------------------------

Deno.test("시나리오 7: 전 구간 종료 상태 확인 — 주의보 ESCALATED · 경보 RESOLVED 모두 종료 상태", async () => {
  const { data: watch } = await db.from("weather_events").select("status, closed_at").eq("id", watchEventId).single();
  assertEquals(watch!.status, "ESCALATED");
  assertExists(watch!.closed_at);

  const { data: warn } = await db.from("weather_events").select("status, closed_at").eq("id", warningEventId).single();
  assertEquals(warn!.status, "RESOLVED");
  assertExists(warn!.closed_at);
});
