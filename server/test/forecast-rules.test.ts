import { describe, expect, it } from "vitest";
import { findUpcoming, markExceeds, type ForecastPoint, type CriterionRow, type SettingRow } from "../src/forecastRules.ts";

/** KST 시각으로 예보점을 만든다. */
function p(kstIso: string, v: Partial<ForecastPoint> = {}): ForecastPoint {
  return { fcstAt: new Date(kstIso), tempC: null, pcpMm: null, snoCm: null, wsdMs: null, ...v };
}
const ALL_ON: SettingRow[] = [
  { kind: "rain", enabled: true }, { kind: "snow", enabled: true },
  { kind: "wind", enabled: true }, { kind: "heat", enabled: true },
];
const CRITERIA: CriterionRow[] = [
  { kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20 } },
  { kind: "rain", grade: "warning", threshold: { rain_mm_per_hr: 50 } },
  { kind: "snow", grade: "watch", threshold: { snow_cm: 5 } },
  { kind: "snow", grade: "warning", threshold: { snow_cm: 20 } },
  { kind: "wind", grade: "watch", threshold: { wind_ms: 14 } },
  { kind: "wind", grade: "warning", threshold: { wind_ms: 21 } },
  { kind: "heat", grade: "watch", threshold: { temp_c: 33, feels_c: 31 } },
  { kind: "heat", grade: "warning", threshold: { temp_c: 35, feels_c: 33 } },
];

describe("findUpcoming — 임계 초과가 예상되는 시각", () => {
  it("임계를 넘지 않으면 아무것도 내지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 5 })], CRITERIA, ALL_ON)).toEqual([]);
  });

  it("시간당 강수량이 주의보 임계를 넘으면 잡는다", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 25 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("rain");
    expect(out[0]!.grade).toBe("watch");
    expect(out[0]!.value).toBe(25);
    expect(out[0]!.unit).toBe("mm");
  });

  // 경보를 넘는 예보에 주의보만 말하면 대비 수준이 낮아진다.
  it("경보까지 넘으면 경보를 고르고, 경보를 처음 넘는 시각을 쓴다", () => {
    const out = findUpcoming([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),   // 주의보만
      p("2026-09-07T13:00:00+09:00", { pcpMm: 60 }),   // 경보
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.grade).toBe("warning");
    expect(out[0]!.at.toISOString()).toBe("2026-09-07T04:00:00.000Z"); // 13시 KST
  });

  it("한 종류는 한 건만 낸다", () => {
    const out = findUpcoming([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 30 }),
      p("2026-09-07T12:00:00+09:00", { pcpMm: 40 }),
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
  });

  it("여러 종류는 이른 순으로 정렬한다", () => {
    const out = findUpcoming([
      p("2026-09-07T15:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T10:00:00+09:00", { wsdMs: 16 }),
    ], CRITERIA, ALL_ON);
    expect(out.map((u) => u.kind)).toEqual(["wind", "rain"]);
  });

  // 폭설은 실황이 **일 누적**으로 판정한다. 예보도 같은 기준이어야 한다 —
  // 시간당 값으로 비교하면 5cm 임계를 영영 넘지 않는다.
  it("폭설은 KST 하루 누적으로 판정한다", () => {
    const out = findUpcoming([
      p("2026-09-07T20:00:00+09:00", { snoCm: 2 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: 2 }),
      p("2026-09-07T22:00:00+09:00", { snoCm: 2 }),   // 누적 6cm → 여기서 넘는다
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("snow");
    expect(out[0]!.value).toBe(6);
    expect(out[0]!.unit).toBe("cm");
    expect(out[0]!.at.toISOString()).toBe("2026-09-07T13:00:00.000Z"); // 22시 KST
  });

  // **가장 중요한 줄.** UTC로 끊으면 하루가 9시간 어긋나 밤새 내린 눈이 두
  // 날에 쪼개진다. 이 프로젝트에서 시계 도메인 혼동은 세 번 재발했다.
  it("누적은 KST 자정에서 끊긴다", () => {
    const out = findUpcoming([
      p("2026-09-07T23:00:00+09:00", { snoCm: 4 }),
      p("2026-09-08T00:00:00+09:00", { snoCm: 4 }),   // 다른 날 → 누적 리셋
    ], CRITERIA, ALL_ON);
    expect(out).toEqual([]);
  });

  it("강풍은 풍속으로 판정한다", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { wsdMs: 22 })], CRITERIA, ALL_ON);
    expect(out[0]!.grade).toBe("warning");
    expect(out[0]!.unit).toBe("m/s");
  });

  // 예보에는 체감온도가 없다. 기온만으로 판정하고, 그래서 실제 특보와
  // 어긋날 수 있다 — 스펙 §3 함정 3.
  it("폭염은 기온만으로 판정한다", () => {
    const out = findUpcoming([p("2026-09-07T14:00:00+09:00", { tempC: 34 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.grade).toBe("watch");
    expect(out[0]!.unit).toBe("℃");
  });

  // 껐는데 예고가 뜨면 "예고가 떴으니 특보도 나겠지"가 된다.
  it("꺼둔 종류는 예고하지 않는다", () => {
    const off: SettingRow[] = [{ kind: "rain", enabled: false }, ...ALL_ON.slice(1)];
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, off)).toEqual([]);
  });

  it("알림 설정에 아예 없는 종류도 예고하지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, [])).toEqual([]);
  });

  // null은 "모른다"다. 0으로 보면 "안 온다"는 단언이 되고, 반대로 임계와
  // 비교하면 NaN 비교가 조용히 false가 된다.
  it("값이 null인 시각은 판정하지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: null })], CRITERIA, ALL_ON)).toEqual([]);
  });

  it("null은 누적에서도 건너뛴다(0으로 세지 않는다)", () => {
    const out = findUpcoming([
      p("2026-09-07T20:00:00+09:00", { snoCm: 3 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: null }),
      p("2026-09-07T22:00:00+09:00", { snoCm: 3 }),   // 누적 6cm
    ], CRITERIA, ALL_ON);
    expect(out[0]!.value).toBe(6);
  });

  // 기준이 없는 종류를 판정하면 0과 비교하게 되어 언제나 초과가 된다.
  it("임계가 설정되지 않은 종류는 예고하지 않는다", () => {
    const bad: CriterionRow[] = [{ kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 0 } }];
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 5 })], bad, ALL_ON)).toEqual([]);
  });

  it("임계와 같은 값도 초과로 본다(실황 판정과 같다)", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 20 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
  });
});

// 스트립은 "몇 시가 임계를 넘는가"를 시각마다 칠해야 한다. 그 판정도 서버가
// 한다 — 화면이 임계와 비교하기 시작하면 배너와 스트립과 실제 특보가 각자
// 다른 기준을 갖게 된다.
describe("markExceeds — 시각마다의 초과 표시", () => {
  it("넘는 시각을 모두 낸다(findUpcoming과 달리 첫 건만이 아니다)", () => {
    const out = markExceeds([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 30 }),
      p("2026-09-07T12:00:00+09:00", { pcpMm: 5 }),
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === "rain")).toBe(true);
  });

  it("그 시각에 해당하는 가장 높은 등급을 쓴다", () => {
    const out = markExceeds([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 60 }),
    ], CRITERIA, ALL_ON);
    expect(out.map((m) => m.grade)).toEqual(["watch", "warning"]);
  });

  it("폭설은 누적으로 표시하므로 한 번 넘으면 그날 내내 표시된다", () => {
    const out = markExceeds([
      p("2026-09-07T20:00:00+09:00", { snoCm: 3 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: 3 }),   // 누적 6cm
      p("2026-09-07T22:00:00+09:00", { snoCm: 0 }),   // 누적 그대로 6cm
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(2);
  });

  it("꺼둔 종류는 표시하지 않는다", () => {
    const off: SettingRow[] = [{ kind: "rain", enabled: false }, ...ALL_ON.slice(1)];
    expect(markExceeds([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, off)).toEqual([]);
  });

  it("값이 null인 시각은 표시하지 않는다", () => {
    expect(markExceeds([p("2026-09-07T10:00:00+09:00", { pcpMm: null })], CRITERIA, ALL_ON)).toEqual([]);
  });

  // findUpcoming의 "null은 누적에서도 건너뛴다" 테스트는 값(누적 6cm)만 본다 —
  // 단조 증가하는 누적합에서는 null을 0으로 채우나 건너뛰나 "처음 넘는 시각"이
  // 똑같아서(0을 더해도 이미 넘은 값은 그대로다) 그 테스트로는 이 버그가
  // 드러나지 않는다. markExceeds는 시각마다 표시하므로 여기서 드러난다 —
  // null을 0으로 세면 이미 넘은 누적값을 이어받아 null 시각에도 잘못 표시된다.
  it("폭설 누적에서 null 시각은 이미 넘은 값을 이어받아 표시하지 않는다", () => {
    const out = markExceeds([
      p("2026-09-07T20:00:00+09:00", { snoCm: 3 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: 3 }),   // 누적 6cm → 여기서 넘는다
      p("2026-09-07T22:00:00+09:00", { snoCm: null }), // null: 표시하지 않는다
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.at.toISOString()).toBe("2026-09-07T12:00:00.000Z"); // 21시 KST
  });
});
