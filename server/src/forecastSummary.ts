// 시간별 예보를 "그 날 하루"로 접는다. 판정은 하지 않는다 —
// 임계 비교는 forecastRules.ts 하나에만 있다.
import type { ForecastPoint } from "./forecastRules.ts";

export type DailyPoint = ForecastPoint & {
  popPct: number | null; sky: number | null; tmnC: number | null; tmxC: number | null;
};

export type DailySummary = {
  date: string;               // YYYY-MM-DD (KST)
  tmn_c: number | null; tmx_c: number | null;
  pop_max: number | null; pcp_sum: number | null; sno_sum: number | null;
  sky: number | null;
  /** 최저·최고를 기상청 값이 아니라 시간별 기온에서 유도했는가. */
  derived: boolean;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 사람이 "그날 날씨"라고 할 때 뜻하는 구간. 새벽을 넣으면 맑은 날이 흐림이 된다. */
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 18;
/** 흐린 정도. 동률일 때 더 흐린 쪽을 고른다. */
const SKY_CLOUDINESS: Record<number, number> = { 1: 0, 3: 1, 4: 2 };

function kstParts(d: Date): { date: string; hour: number } {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return { date: k.toISOString().slice(0, 10), hour: k.getUTCHours() };
}

/** 값이 하나도 없으면 null. 0을 돌려주면 "없다"가 "0이다"라는 단언이 된다. */
function sum(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}
function max(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.max(...nums);
}
function min(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.min(...nums);
}

export function summarizeDaily(points: DailyPoint[]): DailySummary[] {
  const byDay = new Map<string, DailyPoint[]>();
  for (const p of points) {
    const { date } = kstParts(p.fcstAt);
    const bucket = byDay.get(date);
    if (bucket) bucket.push(p); else byDay.set(date, [p]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, ps]) => {
      const givenMin = min(ps.map((p) => p.tmnC));
      const givenMax = max(ps.map((p) => p.tmxC));
      const derived = givenMin === null || givenMax === null;

      // 낮 시간대의 하늘상태 최빈값. 동률이면 더 흐린 쪽.
      const daySkies = ps
        .filter((p) => { const h = kstParts(p.fcstAt).hour;
                         return h >= DAY_START_HOUR && h <= DAY_END_HOUR; })
        .map((p) => p.sky)
        .filter((s): s is number => s !== null);
      let sky: number | null = null;
      if (daySkies.length > 0) {
        const count = new Map<number, number>();
        for (const s of daySkies) count.set(s, (count.get(s) ?? 0) + 1);
        sky = [...count.entries()].sort(
          (a, b) => b[1] - a[1] || (SKY_CLOUDINESS[b[0]] ?? 0) - (SKY_CLOUDINESS[a[0]] ?? 0),
        )[0]![0];
      }

      // snake_case인 이유는 위 타입 주석 참고 — 이 값이 그대로 API의 daily가 된다.
      return {
        date,
        tmn_c: givenMin ?? min(ps.map((p) => p.tempC)),
        tmx_c: givenMax ?? max(ps.map((p) => p.tempC)),
        pop_max: max(ps.map((p) => p.popPct)),
        pcp_sum: sum(ps.map((p) => p.pcpMm)),
        sno_sum: sum(ps.map((p) => p.snoCm)),
        sky,
        derived,
      };
    });
}
