import { assertEquals } from "jsr:@std/assert";
import { serviceClient } from "../_shared/db.ts";
const FN = "http://127.0.0.1:54321/functions/v1/remind-tick";

// dispatches → messages → weather_events 순서로 삭제 (FK 제약)
async function resetEvents(db: ReturnType<typeof serviceClient>) {
  await db.from("dispatches").delete().neq("id", -1);
  await db.from("messages").delete().neq("id", crypto.randomUUID());
  await db.from("weather_events").delete().neq("id", crypto.randomUUID());
}

Deno.test("remind-tick: 간격 경과한 PENDING 특보만 재알림", async () => {
  const db = serviceClient();
  await resetEvents(db);
  const old = new Date(Date.now() - 40 * 60_000).toISOString();   // 40분 전 감지
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString();  // 5분 전 감지
  const { data: e1 } = await db.from("weather_events")
    .insert({ kind:"wind", grade:"watch", detected_at: old }).select().single();
  await db.from("weather_events").insert({ kind:"heat", grade:"watch", detected_at: fresh });
  const res = await fetch(FN, { method:"POST", headers:{ "x-cron-secret":"test-secret" } });
  const body = await res.json();
  assertEquals(body.reminded, 1);
  const { data: after } = await db.from("weather_events").select("last_reminded_at").eq("id", e1.id).single();
  assertEquals(after?.last_reminded_at !== null, true);
});
