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
