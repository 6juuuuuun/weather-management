import { MetricChart } from "../components/MetricChart";
import { BoardTicker } from "../components/BoardTicker";
import type { TickerItem } from "../components/BoardTicker";
import "./DashboardBoard.css";

/** 특보 배너를 가로로 눕혀도 읽히는 최대 개수. 넘으면 접는다. */
const MAX_EVENTS = 3;

export type BoardMetric = {
  key: "rain" | "temp" | "wind" | "feels";
  label: string;
  unit: string;
  value: number | null;
  threshold: number;
  gradeLabel: string;
  allowNegative: boolean;
  history: number[];
};

export type BoardEvent = {
  id: string;
  title: string;
  tag: string;
  detail: string;
  severe: boolean;
};

export type DashboardBoardProps = {
  siteName: string;
  clock: string;
  collectedAgo: string;
  metrics: BoardMetric[];
  events: BoardEvent[];
};

export function statusHeadline(events: BoardEvent[]): { text: string; alert: boolean } {
  if (events.length === 0) return { text: "평온", alert: false };
  const waiting = events.some((e) => e.tag === "승인 대기");
  return { text: waiting ? "특보 발생" : "대응 중", alert: true };
}

function toneOf(m: BoardMetric): "calm" | "near" | "over" {
  // threshold가 0이면 아직 기준이 설정되지 않은 지표다(Criteria.tsx가 DB에
  // 행이 없을 때 채우는 값). 0과 비교하면 0 이상인 모든 값이 "초과"로
  // 오판되어 실제로는 특보 기준이 없는 카드가 항상 빨갛게 뜬다 —
  // 3미터 밖에서 보는 관망용 화면에서 이건 거짓 경보다.
  if (m.value === null || m.threshold <= 0) return "calm";
  if (m.value >= m.threshold) return "over";
  if (m.value >= m.threshold * 0.9) return "near";
  return "calm";
}

/** 지표를 티커 항목으로 바꾼다. 월보드와 운영 대시보드가 같은 함수를 쓴다 —
 *  "기준 미설정" 판정이 두 곳에 복제되면 한쪽만 고쳐지는 일이 실제로 있었다.
 *  threshold<=0(기준 미설정)인 지표는 뺀다 — gapPhrase가 "…기준 초과 +0.0mm"
 *  처럼 존재하지 않는 기준까지의 거리를 말해버려 티커가 거짓 경보를 낸다. */
export function toTickerItems(metrics: BoardMetric[]): TickerItem[] {
  return metrics
    .filter((m): m is BoardMetric & { value: number } => m.value !== null && m.threshold > 0)
    .map((m) => ({
      label: m.label, value: m.value, unit: m.unit,
      threshold: m.threshold, gradeLabel: m.gradeLabel,
    }));
}

export function DashboardBoard({
  siteName, clock, collectedAgo, metrics, events,
}: DashboardBoardProps) {
  const status = statusHeadline(events);
  const shown = events.slice(0, MAX_EVENTS);
  const hidden = events.length - shown.length;
  const tickerItems = toTickerItems(metrics);

  return (
    <div className="bd">
      <header className="bd-head">
        <div className="bd-head-left">
          <span className={status.alert ? "bd-status bd-status-alert" : "bd-status"}>{status.text}</span>
          <span className="bd-site">{siteName}</span>
        </div>
        <div className="bd-head-right">
          <span className="bd-clock">{clock}</span>
          <span className="bd-collected">{collectedAgo}</span>
        </div>
      </header>

      {events.length > 0 && (
        <div className={events.length > 1 ? "bd-events bd-events-row" : "bd-events"}>
          {shown.map((e) => (
            <div className="bd-event" key={e.id}>
              {/* 배지는 진행 상태만 말한다. 심각도는 제목 색과 "주의보/경보" 글자가
                  이미 전달한다(F2: #8a4b00↔--danger는 ΔE 1.5로 뭉개져 --warn과
                  같은 실패를 반복한다). */}
              <span className="bd-tag">{e.tag}</span>
              <span className={e.severe ? "bd-event-title bd-event-severe" : "bd-event-title"}>{e.title}</span>
              <span className="bd-event-detail">{e.detail}</span>
            </div>
          ))}
          {hidden > 0 && <span className="bd-more">외 {hidden}건</span>}
        </div>
      )}

      <div className="bd-cards">
        {metrics.map((m) => {
          const tone = toneOf(m);
          return (
            <div className="bd-card" key={m.key}>
              <span className="bd-card-label">{m.label}</span>
              <span className={`bd-card-value bd-value-${tone}`}>
                {m.value === null ? "–" : Number(m.value.toFixed(1))}
                <span className="bd-card-unit">{m.unit}</span>
              </span>
              <MetricChart
                values={m.history}
                // threshold<=0은 "기준 미설정"이다. 그대로 넘기면 값 0이 임계
                // 0과 같아져 차트가 거짓 기준선("주의보 0mm")을 그린다.
                threshold={m.threshold > 0 ? m.threshold : null}
                unit={m.unit}
                gradeLabel="주의보"
                allowNegative={m.allowNegative}
                tone={tone}
              />
            </div>
          );
        })}
      </div>

      <BoardTicker items={tickerItems} />
    </div>
  );
}
