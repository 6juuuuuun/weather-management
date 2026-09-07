// server/test/forecast-tick.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { withService } from "../src/db.ts";
import { runForecastTick, FORECAST_STALE_HOURS } from "../src/jobs/forecastTick.ts";

// 실제 문자가 나가지 않게 못박는다(다른 스위트와 같은 처방).
process.env.SMS_PROVIDER = "";

const NOW = new Date("2026-09-07T00:30:00Z"); // 09:30 KST

/** 지정한 시각들에 대한 예보를 돌려주는 가짜 기상청. */
function fakeKma(times: { date: string; time: string; tmp: string; pcp?: string; sno?: string }[]) {
  const item = (t: (typeof times)[number], category: string, fcstValue: string) => ({
    baseDate: "20260907", baseTime: "0800", category,
    fcstDate: t.date, fcstTime: t.time, fcstValue, nx: 61, ny: 121,
  });
  const items = times.flatMap((t) => [
    item(t, "TMP", t.tmp),
    item(t, "PCP", t.pcp ?? "강수없음"),
    item(t, "SNO", t.sno ?? "적설없음"),
  ]);
  return async () =>
    new Response(JSON.stringify({
      response: { header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" }, body: { items: { item: items } } },
    }), { status: 200 });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from weather_forecasts");
    await q.query("delete from heartbeats where name = 'forecast-tick'");
  });
});

describe("runForecastTick", () => {
  it("받은 예보를 저장한다", async () => {
    const out = await runForecastTick({
      now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    expect(out.saved).toBe(1);
    const rows = await withService(async (q) =>
      (await q.query("select fcst_at, temp_c, pcp_mm, sno_cm from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].temp_c)).toBe(23);
    expect(Number(rows[0].pcp_mm)).toBe(0);
  });

  // 같은 시각을 다시 예보하면 최신 발표로 덮어야 한다. 안 그러면 3시간 전
  // 예보가 화면에 남아 "비 안 온다"고 말한다.
  it("같은 시각은 최신 발표로 덮는다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "27" }]) as unknown as typeof fetch });
    const rows = await withService(async (q) =>
      (await q.query("select temp_c from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].temp_c)).toBe(27);
  });

  it("지난 예보를 지운다", async () => {
    await withService(async (q) =>
      q.query(`insert into weather_forecasts (fcst_at, base_at) values (now() - interval '3 days', now())`));
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const rows = await withService(async (q) =>
      (await q.query("select fcst_at from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
  });

  it("heartbeat를 남긴다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const beat = await withService(async (q) =>
      (await q.query("select ok from heartbeats where name = 'forecast-tick'")).rows[0]);
    expect(beat.ok).toBe(true);
  });

  // **가장 중요한 줄.** 기상청이 죽었다고 마지막 예보를 지우면 화면이 빈다.
  // 낡은 값을 "낡았다"고 말하며 보여주는 것이 아무것도 없는 것보다 낫다.
  it("수집이 실패해도 마지막 예보를 지우지 않는다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const out = await runForecastTick({
      now: NOW,
      fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    const rows = await withService(async (q) =>
      (await q.query("select temp_c from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
  });

  it("수집이 실패하면 heartbeat도 실패로 남는다", async () => {
    await runForecastTick({
      now: NOW,
      fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    const beat = await withService(async (q) =>
      (await q.query("select ok, note from heartbeats where name = 'forecast-tick'")).rows[0]);
    expect(beat.ok).toBe(false);
    expect(beat.note).toBeTruthy();
  });

  it("낡음 기준은 6시간이다", () => {
    expect(FORECAST_STALE_HOURS).toBe(6);
  });

  // I1: HTTP는 성공(resultCode "00")했지만 items가 비어 오면 saved:0이다.
  // 이걸 ok:true로 기록하면 이 실패가 heartbeat 어디에도 남지 않는다 —
  // observation 쪽 watchdog.ts:98-101에는 있는 안전망이 예보 쪽에는 없었다.
  it("성공했지만 빈 응답이면 heartbeat를 실패로 남긴다", async () => {
    const out = await runForecastTick({
      now: NOW,
      fetchFn: fakeKma([]) as unknown as typeof fetch,
    });
    expect(out.saved).toBe(0);
    const beat = await withService(async (q) =>
      (await q.query("select ok, note from heartbeats where name = 'forecast-tick'")).rows[0]);
    expect(beat.ok).toBe(false);
    expect(beat.note).toMatch(/비어/);
  });
});
