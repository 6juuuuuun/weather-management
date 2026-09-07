import { describe, expect, it } from "vitest";
import { summarizeDaily, type DailyPoint } from "../src/forecastSummary.ts";

function d(kstIso: string, v: Partial<DailyPoint> = {}): DailyPoint {
  return {
    fcstAt: new Date(kstIso), tempC: null, pcpMm: null, snoCm: null, wsdMs: null,
    popPct: null, sky: null, tmnC: null, tmxC: null, ...v,
  };
}

describe("summarizeDaily", () => {
  it("KST 날짜로 묶는다", () => {
    const out = summarizeDaily([
      d("2026-09-07T23:00:00+09:00", { tempC: 18 }),
      d("2026-09-08T00:00:00+09:00", { tempC: 17 }),
    ]);
    expect(out.map((x) => x.date)).toEqual(["2026-09-07", "2026-09-08"]);
  });

  it("기상청이 준 TMN·TMX를 우선 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { tempC: 20, tmnC: 16 }),
      d("2026-09-07T15:00:00+09:00", { tempC: 25, tmxC: 27 }),
    ]);
    expect(out[0]!.tmn_c).toBe(16);
    expect(out[0]!.tmx_c).toBe(27);
    expect(out[0]!.derived).toBe(false);
  });

  // TMN·TMX는 하루 중 특정 시각에만 온다. 없는 날은 시간별 기온으로 대신하되
  // 그 사실을 derived로 남긴다 — 어긋남을 조사할 때 필요하다.
  it("TMN·TMX가 없으면 시간별 기온의 최소·최대로 대신하고 derived로 표시한다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { tempC: 18 }),
      d("2026-09-07T15:00:00+09:00", { tempC: 26 }),
    ]);
    expect(out[0]!.tmn_c).toBe(18);
    expect(out[0]!.tmx_c).toBe(26);
    expect(out[0]!.derived).toBe(true);
  });

  it("강수확률은 그 날 최대를 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { popPct: 20 }),
      d("2026-09-07T15:00:00+09:00", { popPct: 80 }),
    ]);
    expect(out[0]!.pop_max).toBe(80);
  });

  it("강수·적설은 그 날 합이다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { pcpMm: 3, snoCm: 1 }),
      d("2026-09-07T15:00:00+09:00", { pcpMm: 4, snoCm: 2 }),
    ]);
    expect(out[0]!.pcp_sum).toBe(7);
    expect(out[0]!.sno_sum).toBe(3);
  });

  // 값이 하나도 없으면 0이 아니라 null이다. 0은 "안 온다"는 단언이다.
  it("값이 하나도 없는 항목은 0이 아니라 null이다", () => {
    const out = summarizeDaily([d("2026-09-07T06:00:00+09:00", { tempC: 18 })]);
    expect(out[0]!.pcp_sum).toBeNull();
    expect(out[0]!.sno_sum).toBeNull();
    expect(out[0]!.pop_max).toBeNull();
  });

  // 새벽까지 넣으면 맑은 날이 흐림으로 뒤집힌다. 사람이 "그날 날씨"라고
  // 말할 때 뜻하는 구간은 낮이다.
  it("대표 하늘상태는 09~18시(KST) 최빈값이다", () => {
    const out = summarizeDaily([
      d("2026-09-07T03:00:00+09:00", { sky: 4 }),
      d("2026-09-07T04:00:00+09:00", { sky: 4 }),
      d("2026-09-07T05:00:00+09:00", { sky: 4 }),
      d("2026-09-07T10:00:00+09:00", { sky: 1 }),
      d("2026-09-07T13:00:00+09:00", { sky: 1 }),
      d("2026-09-07T16:00:00+09:00", { sky: 3 }),
    ]);
    expect(out[0]!.sky).toBe(1);
  });

  it("최빈값이 동률이면 더 흐린 쪽을 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T10:00:00+09:00", { sky: 1 }),
      d("2026-09-07T16:00:00+09:00", { sky: 4 }),
    ]);
    expect(out[0]!.sky).toBe(4);
  });

  it("낮 시간대 값이 없으면 하늘상태는 null이다", () => {
    const out = summarizeDaily([d("2026-09-07T03:00:00+09:00", { sky: 4 })]);
    expect(out[0]!.sky).toBeNull();
  });

  it("날짜 오름차순이다", () => {
    const out = summarizeDaily([
      d("2026-09-09T10:00:00+09:00", { tempC: 1 }),
      d("2026-09-07T10:00:00+09:00", { tempC: 2 }),
    ]);
    expect(out.map((x) => x.date)).toEqual(["2026-09-07", "2026-09-09"]);
  });
});
