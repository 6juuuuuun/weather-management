// 앞으로 48시간. 두 화면이 같은 컴포넌트를 쓰되 밀도만 다르다.
//
// **월보드에는 스크롤을 쓰지 않는다.** 벽에 걸린 화면에는 미는 사람이 없어서,
// 48칸을 스크롤로 두면 앞쪽 몇 칸만 영원히 보이고 나머지는 없는 것과 같다.
// 그래서 spread는 3시간 간격으로 솎아 전부 한 화면에 펼친다.
import { skyLook } from "../lib/weatherIcon";
import type { ForecastHour } from "../lib/api/forecast";
// 배너와 같은 한글 라벨을 쓴다(중복 정의 금지) — 두 벌로 적히면 배너는
// "폭우 경보"라 하는데 스트립은 다른 말을 하는 일이 생긴다.
import { KIND_LABEL, GRADE_LABEL } from "./ForecastBanner";
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
  const hasExceed = cols.some((c) => c.exceeds.length > 0);

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
          // I4: 색만으로 무엇을 넘는지 말하지 않는다(스크린 리더·색약 운영자 모두
          // 배경 틴트를 못 읽는다). 서버가 준 kind+grade를 배너와 같은 한글로
          // 짧게 적는다 — 같은 등급이 여럿이면 겹치지 않게 한 번씩만 적는다.
          const exceedLabel = worst
            ? [...new Set(
                c.exceeds.filter((e) => e.grade === worst).map((e) => KIND_LABEL[e.kind]),
              )].map((k) => `${k} ${GRADE_LABEL[worst]}`).join(" · ")
            : null;
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
              {exceedLabel && <span className="fc-exceed-label">{exceedLabel}</span>}
            </div>
          );
        })}
      </div>
      <div className="fc-legend">
        <span>기온 ℃</span><span>강수확률</span>
        {hasRain && <span>강수량</span>}
        {hasSnow && <span>신적설</span>}
        {/* 색칠된 칸이 무엇을 뜻하는지 범례에도 적는다 — 칸 위 글자를 놓쳐도
            여기서 확인할 수 있다. */}
        {hasExceed && <span className="fc-legend-exceed">색칠된 칸 = 특보 기준 초과 예상</span>}
      </div>
    </section>
  );
}
