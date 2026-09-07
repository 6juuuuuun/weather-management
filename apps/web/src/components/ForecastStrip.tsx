// 앞으로 48시간. 두 화면이 같은 컴포넌트를 쓰되 밀도만 다르다.
//
// **월보드에는 스크롤을 쓰지 않는다.** 벽에 걸린 화면에는 미는 사람이 없어서,
// 48칸을 스크롤로 두면 앞쪽 몇 칸만 영원히 보이고 나머지는 없는 것과 같다.
// 그래서 spread는 3시간 간격으로 솎아 전부 한 화면에 펼친다.
import { skyLook } from "../lib/weatherIcon";
import type { ForecastHour } from "../lib/api/forecast";
import "./ForecastStrip.css";

export type ForecastStripProps = { hours: ForecastHour[]; density: "scroll" | "spread" };

/** 월보드용 간격. 48시간 ÷ 3시간 = 16칸이면 큰 화면에 한 번에 들어간다. */
const SPREAD_STEP = 3;

export function thin(hours: ForecastHour[], density: "scroll" | "spread"): ForecastHour[] {
  return density === "spread" ? hours.filter((_, i) => i % SPREAD_STEP === 0) : hours;
}

/** KST 시각 조각. 서버는 ISO(UTC)로 주고 화면은 한국 시각으로 읽는다. */
function kst(iso: string): { hour: number; month: number; day: number } {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3);
  return { hour: d.getUTCHours(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function num(v: number | null): string {
  return v === null ? "–" : String(Number(v.toFixed(1)));
}

export function ForecastStrip({ hours, density }: ForecastStripProps) {
  const cols = thin(hours, density);
  // 예보가 없으면 빈 표를 그리지 않는다. 빈 칸을 0이나 -로 채우면
  // "받지 못했다"가 "값이 0이다"로 읽힌다.
  if (cols.length === 0) return null;

  // 값이 하나라도 있는 줄만 그린다. 겨울에는 눈이, 여름에는 비가 저절로 앞에 온다.
  const hasRain = cols.some((c) => c.pcp_mm !== null && c.pcp_mm > 0);
  const hasSnow = cols.some((c) => c.sno_cm !== null && c.sno_cm > 0);

  return (
    <section className={`fc fc-${density}`} aria-label="앞으로 48시간 예보">
      <h2 className="fc-title">앞으로 48시간</h2>
      <div className={density === "scroll" ? "fc-track fc-scroll" : "fc-track"}>
        {cols.map((c) => {
          const t = kst(c.at);
          const look = skyLook(c.sky, c.pty);
          // **화면은 임계와 비교하지 않는다.** 서버가 준 exceeds만 읽는다.
          const worst = c.exceeds.some((e) => e.grade === "warning") ? "warning"
            : c.exceeds.length > 0 ? "watch" : null;
          return (
            <div
              key={c.at}
              className={`fc-col${worst ? ` fc-col-over fc-col-${worst}` : ""}`}
            >
              <span className="fc-time">
                {t.hour === 0 && <span className="fc-date">{t.month}/{t.day}</span>}
                {t.hour}시
              </span>
              <span className="fc-sky">
                <span className="fc-glyph" aria-hidden="true">{look.glyph}</span>
                <span className="fc-skylabel">{look.label}</span>
              </span>
              <span className="fc-temp">{num(c.temp_c)}</span>
              <span className="fc-pop">{c.pop_pct === null ? "–" : `${c.pop_pct}%`}</span>
              {hasRain && <span className="fc-amount">{num(c.pcp_mm)}</span>}
              {hasSnow && <span className="fc-amount">{num(c.sno_cm)}</span>}
            </div>
          );
        })}
      </div>
      <div className="fc-legend">
        <span>기온 ℃</span><span>강수확률</span>
        {hasRain && <span>강수량</span>}
        {hasSnow && <span>신적설</span>}
      </div>
    </section>
  );
}
