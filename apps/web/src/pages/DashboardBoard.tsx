import { MetricChart } from "../components/MetricChart";
import { BoardTicker } from "../components/BoardTicker";
import type { TickerItem } from "../components/BoardTicker";
import { ForecastStrip } from "../components/ForecastStrip";
import { ForecastDaily } from "../components/ForecastDaily";
import { ForecastBanner } from "../components/ForecastBanner";
import type { ForecastResponse } from "../lib/api/forecast";
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
  /** 앞으로의 예보. 없으면 빈 배열이고, 그때 차트는 지금과 똑같이 그린다. */
  forecast: number[];
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
  /** 마지막 관측이 낡았는가(또는 관측이 아예 없는가). */
  stale: boolean;
  /** 마지막 조회가 실패했으면 그 문구. 성공했으면 null. */
  loadError: string | null;
  metrics: BoardMetric[];
  events: BoardEvent[];
  /** 예보. null이면 예보 블록만 빠지고 나머지는 그대로 그린다. */
  forecast: ForecastResponse | null;
};

/**
 * 벽에 걸린 화면에서 3미터 밖까지 닿는 유일한 한 마디다.
 *
 * 조회가 실패했거나 관측이 낡았으면 날씨보다 **그 사실**을 먼저 말한다. 예전에는
 * 두 경우 모두 `평온`이라고 적혀 있었다 — DB가 죽어도, 수집이 사흘 전에 멈춰도
 * 마지막으로 받아 둔 값을 띄운 채 시계만 돌아서, 멈춘 화면과 정상 화면이
 * 구분되지 않았다(QA W-14). 조용히 틀린 값을 띄우는 것이 이 시스템에서 가장
 * 위험한 실패다.
 */
export function statusHeadline(
  events: BoardEvent[],
  state?: { stale?: boolean; failed?: boolean },
): { text: string; alert: boolean } {
  if (state?.failed) return { text: "연결 끊김", alert: true };
  if (state?.stale) return { text: "수집 중단", alert: true };
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
  siteName, clock, collectedAgo, stale, loadError, metrics, events, forecast,
}: DashboardBoardProps) {
  const status = statusHeadline(events, { stale, failed: !!loadError });
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
          <span className={stale ? "bd-collected bd-collected-stale" : "bd-collected"}>{collectedAgo}</span>
        </div>
      </header>

      {/* 특보 배너보다 위에 둔다. 값이 낡았다면 그 아래 숫자는 전부 못 믿을 값이고,
          그 사실을 알기 전에 숫자를 먼저 읽게 해서는 안 된다. */}
      {(loadError || stale) && (
        <div className="bd-alarm" role="status">
          <span className="bd-alarm-title">{loadError ? "서버 연결 끊김" : "수집 중단"}</span>
          <span className="bd-alarm-detail">
            {loadError
              ? `아래 값은 마지막으로 받아 둔 것입니다 · ${collectedAgo}`
              : `아래 값은 갱신되지 않고 있습니다 · ${collectedAgo}`}
          </span>
        </div>
      )}

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

      {/* 예고 배너보다 먼저 읽혀야 한다(I2) — 예보 자체가 낡았다면 그 아래
          "폭설 예상" 문구도 낡은 값으로 계산된 것이고, 그 사실을 알기 전에
          자신 있는 예고를 먼저 읽게 해서는 안 된다. 위 관측 낡음 띠와 같은
          규칙이지만 색은 다르다(I3) — 이것은 "특보가 뜨지 않는다"는 뜻이
          아니라 "사전 예고만 멈췄다"는 뜻이라 --danger를 쓰지 않는다. */}
      {forecast?.stale && (
        <div className="bd-alarm bd-alarm-warn" role="status">
          <span className="bd-alarm-title">예보를 받지 못하고 있습니다</span>
          <span className="bd-alarm-detail">아래 예보는 갱신되지 않은 값입니다 · 특보 발송은 정상입니다</span>
        </div>
      )}
      {/* 특보 배너와 **같은 줄이 아니라 바로 아래**에 둔다. 나란히 두면 벽에서
          두 배너가 한 덩어리로 읽혀 "예고"와 "실제"의 구분이 사라진다. */}
      {forecast && <ForecastBanner upcoming={forecast.upcoming} compact />}

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
                forecast={m.forecast}
              />
            </div>
          );
        })}
      </div>

      {/* 월보드에는 미는 사람이 없다. density="spread"가 3시간 간격으로 솎아
          48시간을 16칸에 전부 펼친다 — 스크롤 컨테이너가 붙지 않는다. */}
      {forecast && <ForecastStrip hours={forecast.hourly} density="spread" />}
      {forecast && (
        <div className="bd-daily">
          <ForecastDaily days={forecast.daily} />
        </div>
      )}

      <BoardTicker items={tickerItems} />
    </div>
  );
}
