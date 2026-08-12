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
Deno.test("열린 watch 존재 시 중복 생성 없음 + 약한 비·누적 미달이면 repeat도 resolve도 없음", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:5, rainToday:40 }, CRIT, SET, open), []);
});
Deno.test("기준 이상이면 누적과 무관하게 repeat", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:25, rainToday:40 }, CRIT, SET, open),
    [{ type:"repeat", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("약한 비여도 일 누적 초과면 repeat", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:2, rainToday:90 }, CRIT, SET, open),
    [{ type:"repeat", eventId:"e1", kind:"rain", grade:"watch" }]);
});
// 회귀 방지: 일 누적은 KST 자정까지 단조 증가만 하므로 해제 기준이 될 수 없다.
// 비가 그쳤는데 누적이 임계 위라는 이유로 자정까지 미해제·매시간 재발송되던 결함(2026-08-12).
Deno.test("비가 그쳤으면 일 누적이 임계 위여도 resolve", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:0, rainToday:90 }, CRIT, SET, open),
    [{ type:"resolve", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("warning 돌파 시 watch escalate (repeat/resolve 미발행)", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:55, rainToday:90 }, CRIT, SET, open),
    [{ type:"escalate", eventId:"e1", kind:"rain" }]);
});
Deno.test("강수 중단(rain=0)이면 resolve", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"ACTIVE" }];
  assertEquals(evaluate({ ...base, rain:0, rainToday:50 }, CRIT, SET, open),
    [{ type:"resolve", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("DISMISSED-open은 재감지 금지, 해제조건 충족 시 resolve만", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"DISMISSED", dismissedOpen:true }];
  assertEquals(evaluate({ ...base, rain:25, rainToday:90 }, CRIT, SET, open), []);
  assertEquals(evaluate({ ...base, rain:0, rainToday:50 }, CRIT, SET, open),
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
Deno.test("PENDING 특보도 기준 미달이면 resolve (자동 종료 정책)", () => {
  const open: OpenEvent[] = [{ id:"e1", kind:"rain", grade:"watch", status:"PENDING_APPROVAL" }];
  assertEquals(evaluate({ ...base, rain:0, rainToday:10 }, CRIT, SET, open),
    [{ type:"resolve", eventId:"e1", kind:"rain", grade:"watch" }]);
});
Deno.test("snow: snowToday 기준 감지", () => {
  const crit = [...CRIT, { kind:"snow", grade:"watch", threshold:{ snow_cm:5 } } as Criterion];
  const set = [...SET, { kind:"snow", enabled:true, repeatPolicy:"hourly_until_below", repeatAccumThreshold:null, heatRepeatBasis:null } as AlertSetting];
  assertEquals(evaluate({ ...base, snowNew:2, snowToday:6 }, crit, set, []),
    [{ type:"create", kind:"snow", grade:"watch" }]);
});
Deno.test("wind: wind_ms 기준 감지", () => {
  const crit = [...CRIT, { kind:"wind", grade:"watch", threshold:{ wind_ms:14 } } as Criterion];
  const set = [...SET, { kind:"wind", enabled:true, repeatPolicy:"hourly_until_below", repeatAccumThreshold:null, heatRepeatBasis:null } as AlertSetting];
  assertEquals(evaluate({ ...base, wind:15 }, crit, set, []),
    [{ type:"create", kind:"wind", grade:"watch" }]);
});
