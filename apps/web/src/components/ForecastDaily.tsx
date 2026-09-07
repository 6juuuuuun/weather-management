// 5일 요약. **오늘은 그리지 않는다** — 관측 카드와 48시간 스트립이 이미
// 오늘을 말하고 있어서, 여기서 또 그리면 같은 정보가 세 번 나온다.
import { skyLook } from "../lib/weatherIcon";
import type { ForecastDay } from "../lib/api/forecast";
import "./ForecastDaily.css";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 오늘(KST) 날짜 문자열. 서버의 date와 같은 형식이다. */
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

export function ForecastDaily({ days }: { days: ForecastDay[] }) {
  const today = todayKst();
  const rows = days.filter((d) => d.date > today);
  if (rows.length === 0) return null;

  return (
    <section className="fd" aria-label="5일 예보">
      <h2 className="fd-title">5일</h2>
      <ul className="fd-list">
        {rows.map((d) => {
          const dt = new Date(`${d.date}T00:00:00+09:00`);
          const wd = WEEKDAY[new Date(dt.getTime() + 9 * 3600e3).getUTCDay()];
          const look = skyLook(d.sky, null);
          return (
            <li className="fd-item" key={d.date}>
              <span className="fd-day">
                {Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))} ({wd})
              </span>
              <span className="fd-sky">
                <span aria-hidden="true">{look.glyph}</span>
                <span className="fd-skylabel">{look.label}</span>
              </span>
              <span className="fd-temp">
                {d.tmn_c === null ? "–" : Math.round(d.tmn_c)}~{d.tmx_c === null ? "–" : Math.round(d.tmx_c)}℃
              </span>
              {d.pop_max !== null && <span className="fd-pop">{d.pop_max}%</span>}
              {/* 값이 없는 항목은 그리지 않는다. 0으로 채우면 "안 온다"는 단언이 된다. */}
              {d.pcp_sum !== null && d.pcp_sum > 0 && (
                <span className="fd-amount">{Number(d.pcp_sum.toFixed(1))}mm</span>
              )}
              {d.sno_sum !== null && d.sno_sum > 0 && (
                <span className="fd-amount fd-snow">{Number(d.sno_sum.toFixed(1))}cm</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
