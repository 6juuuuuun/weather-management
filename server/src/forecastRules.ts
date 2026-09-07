// 예보에서 "임계를 넘을 것으로 보이는 가장 이른 시각"을 찾는다.
//
// **임계값은 weather_criteria 하나만 읽는다.** 예고 전용 임계를 따로 두면
// 배너가 말하는 기준과 실제로 특보가 나는 기준이 갈라지고, 그 순간 배너는
// 거짓말이 된다. 그래서 이 파일에는 숫자가 하나도 없다.
//
// 이 파일은 순수 함수다 — DB도 네트워크도 없다. 판정은 여기 한 곳에만 있고
// 화면은 결과만 받는다(phone.ts의 notifiable과 같은 선례).
import { thresholdUsable } from "./criteriaFields.ts";
import type { Kind, Grade } from "./shared/types.ts";

export type ForecastPoint = {
  fcstAt: Date;
  tempC: number | null; pcpMm: number | null; snoCm: number | null; wsdMs: number | null;
};
export type CriterionRow = { kind: Kind; grade: Grade; threshold: Record<string, number> };
export type SettingRow = { kind: Kind; enabled: boolean };
export type Upcoming = { kind: Kind; grade: Grade; at: Date; value: number; unit: string };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 그 시각이 속한 **KST 날짜** 키. UTC로 끊으면 하루가 9시간 어긋나
 *  밤새 내린 눈이 두 날에 쪼개진다. */
function kstDayKey(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 종류마다 "무엇을 비교하는가". 폭설만 누적이고 나머지는 그 시각 값이다. */
const FIELD: Record<Kind, { unit: string; pick: (p: ForecastPoint) => number | null; key: string }> = {
  rain: { unit: "mm",  pick: (p) => p.pcpMm, key: "rain_mm_per_hr" },
  snow: { unit: "cm",  pick: (p) => p.snoCm, key: "snow_cm" },
  wind: { unit: "m/s", pick: (p) => p.wsdMs, key: "wind_ms" },
  // 예보에는 체감온도가 없다. 실황 판정은 기온·체감 둘 다 보므로 여기서는
  // 기온만으로 판정하고, 그래서 예고와 실제 특보가 어긋날 수 있다. 반대
  // 방향도 있다 — thresholdUsable은 heat에 temp_c·feels_c 둘 다 요구하므로
  // feels_c가 빠진 기준 행은 여기서 조용히 판정 제외되어, 실제로는 특보가
  // 뜨는데도 예고가 뜨지 않는 경우가 생길 수 있다.
  heat: { unit: "℃",  pick: (p) => p.tempC, key: "temp_c" },
};

const KINDS: Kind[] = ["rain", "snow", "wind", "heat"];
/** 낮은 등급부터. 뒤에 오는 것이 더 높은 등급이다. */
const GRADES: Grade[] = ["watch", "warning"];

export function findUpcoming(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): Upcoming[] {
  const sorted = [...points].sort((a, b) => a.fcstAt.getTime() - b.fcstAt.getTime());
  const out: Upcoming[] = [];

  for (const kind of KINDS) {
    // 꺼둔 종류를 예고하면 "예고가 떴으니 특보도 나겠지"가 된다.
    // 설정 행이 아예 없는 것도 켜져 있지 않은 것이다.
    if (!settings.find((s) => s.kind === kind)?.enabled) continue;

    const field = FIELD[kind];
    // 폭설만 KST 하루 누적으로 본다 — 실황 판정이 그렇게 하기 때문이다.
    // 기준이 갈라지면 "예고는 떴는데 특보는 안 난다"가 생긴다.
    const series: { at: Date; value: number }[] = [];
    if (kind === "snow") {
      const accum = new Map<string, number>();
      for (const p of sorted) {
        const v = field.pick(p);
        if (v === null) continue;   // null은 "모른다"다. 0으로 세지 않는다.
        const day = kstDayKey(p.fcstAt);
        const next = (accum.get(day) ?? 0) + v;
        accum.set(day, next);
        series.push({ at: p.fcstAt, value: next });
      }
    } else {
      for (const p of sorted) {
        const v = field.pick(p);
        if (v === null) continue;
        series.push({ at: p.fcstAt, value: v });
      }
    }
    if (series.length === 0) continue;

    // 가장 높은 등급부터 본다. 경보를 넘는데 주의보만 말하면 대비가 낮아진다.
    let hit: { grade: Grade; at: Date; value: number } | null = null;
    for (let i = GRADES.length - 1; i >= 0; i--) {
      const grade = GRADES[i]!;
      const crit = criteria.find((c) => c.kind === kind && c.grade === grade);
      // 기준이 없거나 0 이하이면 판정하지 않는다 — 0과 비교하면 모든 값이
      // 초과가 되어 항상 예고가 뜬다(criteriaFields.ts의 같은 처방).
      if (!crit || !thresholdUsable(kind, crit.threshold)) continue;
      const th = crit.threshold[field.key];
      if (th === undefined) continue;
      const first = series.find((s) => s.value >= th);
      if (first) { hit = { grade, at: first.at, value: first.value }; break; }
    }
    if (hit) out.push({ kind, grade: hit.grade, at: hit.at, value: hit.value, unit: field.unit });
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type ExceedMark = { at: Date; kind: Kind; grade: Grade };

/**
 * 시각마다 "무엇을 넘는가"를 낸다. `findUpcoming`이 종류당 첫 건만 내는 것과
 * 다르다 — 스트립은 넘는 구간 전체를 칠해야 한다.
 *
 * 판정 자체는 위와 완전히 같은 계산을 쓴다(같은 필드·같은 누적·같은
 * thresholdUsable). 두 함수가 다른 답을 내면 배너와 스트립이 어긋난다.
 */
export function markExceeds(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): ExceedMark[] {
  const marks: ExceedMark[] = [];
  for (const kind of KINDS) {
    if (!settings.find((s) => s.kind === kind)?.enabled) continue;
    const field = FIELD[kind];
    const usable = GRADES
      .map((grade) => {
        const crit = criteria.find((c) => c.kind === kind && c.grade === grade);
        if (!crit || !thresholdUsable(kind, crit.threshold)) return null;
        const th = crit.threshold[field.key];
        return th === undefined ? null : { grade, th };
      })
      .filter((x): x is { grade: Grade; th: number } => x !== null);
    if (usable.length === 0) continue;

    const sorted = [...points].sort((a, b) => a.fcstAt.getTime() - b.fcstAt.getTime());
    const accum = new Map<string, number>();
    for (const p of sorted) {
      const v = field.pick(p);
      if (v === null) continue;
      let value = v;
      if (kind === "snow") {
        const day = kstDayKey(p.fcstAt);
        value = (accum.get(day) ?? 0) + v;
        accum.set(day, value);
      }
      // 가장 높은 등급부터 본다.
      for (let i = usable.length - 1; i >= 0; i--) {
        const u = usable[i]!;
        if (value >= u.th) { marks.push({ at: p.fcstAt, kind, grade: u.grade }); break; }
      }
    }
  }
  return marks.sort((a, b) => a.at.getTime() - b.at.getTime());
}
