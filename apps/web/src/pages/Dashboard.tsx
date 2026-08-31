import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { useAuth } from "../auth/AuthProvider";
import { latestObservation, observationsSince, openEvents, criteria as fetchCriteria, siteSettings } from "../lib/api/dashboard";
import type { CriteriaRow, ObservationRow } from "../lib/api/dashboard";
import { listDepartments, alertRecipients } from "../lib/api/org";
import { guidelines as fetchGuidelines, dispatches as fetchDispatches } from "../lib/api/content";
import type { DispatchRow } from "../lib/api/content";
import { computeSetupChecklist } from "../lib/setup";
import type { SetupChecklist } from "../lib/setup";
import type { Kind, WeatherEvent } from "../lib/types";
import { DashboardBoard, toTickerItems } from "./DashboardBoard";
import type { BoardEvent, BoardMetric } from "./DashboardBoard";
import { BoardTicker } from "../components/BoardTicker";
import "./Dashboard.css";

const POLL_MS = 30_000;

const KIND_LABEL: Record<Kind, string> = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" };

type ObservationPoint = Pick<ObservationRow, "observed_at" | "rain_mm_per_hr" | "temp_c" | "feels_c" | "wind_ms">;

type DashboardData = {
  observation: ObservationRow | null;
  criteria: CriteriaRow[];
  openEvents: WeatherEvent[];
  dispatches: DispatchRow[];
  snowToday: number | null; // 판정 엔진과 동일: 당일(KST) snow_new_cm 합산, 관측 없으면 null
  /** 월보드 차트용 최근 24시간 유효 관측 (오래된 것부터) */
  history: ObservationPoint[];
};

function formatDate(d: Date): string {
  return d.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function num(v: number | null | undefined, digits = 1): string {
  return v == null ? "–" : v.toFixed(digits);
}

// 관측은 매시 1회이므로, 마지막 유효 관측이 100분을 넘겼다면 그 뒤로 최소 한 번은
// 수집에 실패했다는 뜻이다(정시 수집 지연을 감안해 60분이 아니라 100분).
const STALE_OBSERVATION_MIN = 100;

function isStaleObservation(iso: string): boolean {
  return (Date.now() - new Date(iso).getTime()) / 60000 > STALE_OBSERVATION_MIN;
}

// KST 자정(UTC 전날 15:00) — supabase/functions/_shared/db.ts의 todayAccums와 동일 로직
function kstMidnightISO(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const midnightKst = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
  return midnightKst.toISOString();
}

function criteriaFor(criteria: CriteriaRow[], kind: Kind) {
  const watch = criteria.find((c) => c.kind === kind && c.grade === "watch");
  const warning = criteria.find((c) => c.kind === kind && c.grade === "warning");
  return { watch, warning };
}

function gradeBySingleValue(
  value: number | null | undefined,
  watchThreshold: number | undefined,
  warningThreshold: number | undefined,
): "watch" | "warning" | undefined {
  if (value == null) return undefined;
  if (warningThreshold != null && value >= warningThreshold) return "warning";
  if (watchThreshold != null && value >= watchThreshold) return "watch";
  return undefined;
}

function dispatchScope(row: DispatchRow): { label: string; failCount: number; total: number } {
  const results = row.results ?? [];
  const failCount = results.filter((r) => !r.ok).length;
  // 발송 시점 스냅샷(content) 우선, 스냅샷 이전 이력은 message_content로 폴백 — History.tsx와 동일 규칙.
  const blocks = row.content ?? row.message_content ?? [];
  const selected = blocks.filter((b) => b.selected);
  let label = "";
  if (selected.length === 0) label = "-";
  else if (selected.length === blocks.length) label = "전체 부서";
  else if (selected.length === 1) label = selected[0].department_name;
  else label = `${selected[0].department_name} 외 ${selected.length - 1}곳`;
  return { label, failCount, total: results.length };
}

export default function Dashboard() {
  const { employee, isApprover } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [setup, setSetup] = useState<SetupChecklist | null>(null);
  const [setupDetail, setSetupDetail] = useState<{ missingDeptCount: number }>({ missingDeptCount: 0 });
  const [siteName, setSiteName] = useState("곤지암");
  const [searchParams, setSearchParams] = useSearchParams();
  const boardMode = searchParams.get("board") === "1";
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const isAdmin = employee?.role === "admin";

    const [obs, openEventRows, dispatchRows, criteriaRows, site, snowTodayRows, historyRows] = await Promise.all([
      // 결측 행(기상청 조회 실패로 기록되는 빈 행)을 제외하고 마지막 '유효' 관측을 읽는다.
      // 이 필터는 서버(dashboard.ts)가 항상 적용한다 — 제외하지 않으면 기상청이 한 번만
      // 삐끗해도 전 카드가 빈 값이 되는데, 상단의 "마지막 수집 N분 전"은 heartbeat(함수
      // 실행 여부) 기준이라 그대로 최신으로 표시돼 "방금 수집했다는데 값이 없다"는
      // 모순이 생긴다. 바로 아래 적설 누적 조회도 같은 기준이다.
      latestObservation(),
      openEvents(),
      fetchDispatches({ limit: 5 }),
      fetchCriteria(),
      siteSettings(),
      // 판정 엔진(todayAccums)과 동일 기준: KST 자정 이후 시간 신적설 합산
      observationsSince(kstMidnightISO(new Date())),
      // 이력은 월보드 차트 전용이다. 일반 대시보드는 쓰지 않으므로 조회하지 않는다 —
      // 운영 화면의 30초 폴링에 쓰지도 않는 요청을 얹지 않기 위해서다.
      boardMode ? observationsSince(new Date(Date.now() - 24 * 3600_000).toISOString()) : Promise.resolve([]),
    ]);

    const snowToday =
      snowTodayRows.length === 0
        ? null
        : snowTodayRows.reduce((acc, r) => acc + Number(r.snow_new_cm ?? 0), 0);

    setSiteName(site?.site_name ?? "곤지암");
    setData({
      observation: obs,
      criteria: criteriaRows,
      openEvents: openEventRows,
      dispatches: dispatchRows,
      snowToday,
      history: historyRows,
    });

    if (isAdmin) {
      // departments API는 id/name만 내려준다(parent_id/sort_order 없음) — 부서 계층을
      // 알 수 없어 "리프 부서"를 가릴 수 없다. 모든 부서를 리프로 취급한다(report 참고).
      const [depts, guidelineRows, alertRecipientRows] = await Promise.all([
        listDepartments(),
        fetchGuidelines(),
        alertRecipients(),
      ]);
      const leafIds = new Set(depts.map((d) => d.id));
      const guidelineDeptIds = new Set(
        guidelineRows.map((g) => g.department_id).filter((id) => leafIds.has(id)),
      );

      const checklist = computeSetupChecklist({
        site: !!site,
        criteria: criteriaRows.length >= 8,
        deptCount: leafIds.size,
        guidelineDeptCount: guidelineDeptIds.size,
        alertRecipientCount: alertRecipientRows.length,
      });
      setSetup(checklist);
      setSetupDetail({ missingDeptCount: Math.max(0, leafIds.size - guidelineDeptIds.size) });
    } else {
      setSetup(null);
    }
  }, [employee?.role, boardMode]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!boardMode) return;
    // 시계는 데이터 폴링(30초)과 분리해서 돌린다. 같이 묶으면 폴링 위상에 따라
    // 분 표시가 최대 1분 가까이 뒤처진 채 벽에 걸린다.
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, [boardMode]);

  // 보드 모드에서 ESC로 전체화면을 빠져나오면 파라미터도 함께 정리해서
  // 다음 새로고침에서 다시 월보드로 들어가지 않게 한다. 이 훅은 boardMode가
  // false에서 true로 바뀔 때도 항상 호출돼야 하므로(훅 개수 불변) 이른 반환보다 위에 둔다.
  useEffect(() => {
    if (!boardMode) return;
    function onFsChange() {
      // fullscreenchange는 진입/종료 모두에서 발생한다. fullscreenElement가 비어있을
      // 때만 "빠져나왔다"고 볼 수 있으므로, 이 조건으로 두 경우를 가른다.
      if (!document.fullscreenElement) {
        const next = new URLSearchParams(searchParams);
        next.delete("board");
        setSearchParams(next, { replace: true });
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [boardMode, searchParams, setSearchParams]);

  // 벽걸이 기기가 이 주소를 북마크하면 부팅 후 바로 월보드로 들어간다.
  // 그래서 전체화면 API와 별개로 URL에 상태를 남긴다 — API가 거부돼도 레이아웃은 바뀐다.
  function enterBoard() {
    const next = new URLSearchParams(searchParams);
    next.set("board", "1");
    setSearchParams(next);
    // requestFullscreen이 없는 환경(구형 브라우저·jsdom)에서는 optional chaining이
    // .catch()까지 포함한 나머지 체인 전체를 건너뛰므로 별도 존재 확인이 필요 없다.
    void document.documentElement.requestFullscreen?.().catch(() => {
      /* 브라우저 정책으로 거부될 수 있다. 레이아웃 전환만으로도 쓸 수 있으므로 무시한다. */
    });
  }

  const today = formatDate(new Date());

  const pendingEvent = data?.openEvents.find((e) => e.status === "PENDING_APPROVAL") ?? null;

  // 하단 티커는 월보드와 같은 항목을 쓴다 — 카드가 못 말하는 "기준까지 얼마 남았나"를
  // 운영 화면에서도 읽을 수 있게 한다. `now`는 보드 모드에서만 틱하므로(시계 훅이
  // 조기 반환한다) 여기서 리렌더가 늘지 않는다.
  const tickerItems = toTickerItems(toBoardProps(data, siteName, now).metrics);

  // 월보드는 운영 화면(AppLayout: 네비게이션 + 조작 버튼)을 감싸지 않는다.
  // .bd는 자체적으로 position:fixed 전체화면 레이아웃이라 GlobalNav/SubNav를
  // 씌우면 운영자가 아닌 관망 화면에 조작 요소가 그대로 노출된다.
  if (boardMode) {
    return <DashboardBoard {...toBoardProps(data, siteName, now)} />;
  }

  return (
    <AppLayout
      title="대시보드"
      actions={
        <>
          <button type="button" className="dash-fullscreen" onClick={enterBoard}>
            전체화면
          </button>
          <span className="dash-date">{today}</span>
        </>
      }
    >
      <p className="dash-desc">실시간 날씨 모니터링과 특보 현황</p>

      <div className="dash-stack">
        {employee?.role === "staff" && employee.department_id === null && (
          <div className="dept-banner">
            부서가 아직 지정되지 않았습니다. 관리자에게 부서 지정을 요청해 주세요.
          </div>
        )}

        {employee?.role === "admin" && setup && setup.done < setup.total && (
          <div className="setup-strip">
            <div className="setup-strip-main">
              <span className="setup-strip-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M17 8a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 6.1 4 4 0 0 1 17 8Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <h3 className="setup-strip-title">
                  초기 설정 {setup.done}/{setup.total} 완료 — 시스템이 아직 발송을 시작할 수 없습니다
                </h3>
                <p className="setup-strip-detail">
                  {setup.items.map((item, i) => (
                    <span key={item.label}>
                      {i > 0 && " · "}
                      {item.ok ? (
                        <span className="setup-strip-detail-ok">{item.label}✓</span>
                      ) : item.label === "부서별 지침" ? (
                        `부서별 지침 ${setupDetail.missingDeptCount}개 부서 미등록`
                      ) : (
                        `${item.label} 미지정`
                      )}
                    </span>
                  ))}
                </p>
              </div>
            </div>
            <Link to="/settings" className="setup-strip-cta">
              설정 계속하기 &gt;
            </Link>
          </div>
        )}

        {pendingEvent && (
          <div className="approval-banner">
            <div className="approval-banner-main">
              <span className="approval-banner-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 4a5 5 0 0 0-5 5v3.5l-1.5 3h13L17 12.5V9a5 5 0 0 0-5-5Zm-2 14a2 2 0 0 0 4 0"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <h3 className="approval-banner-title">
                  {KIND_LABEL[pendingEvent.kind]} {pendingEvent.grade === "warning" ? "경보" : "주의보"} 초안이
                  승인을 기다리고 있습니다
                </h3>
                <p className="approval-banner-detail">
                  오늘 {formatTime(pendingEvent.detected_at)} 감지 · 재알림 {pendingEvent.repeat_count}회 발송됨 ·
                  승인 전까지 부서 발송이 보류됩니다
                </p>
              </div>
            </div>
            {isApprover && (
              <Link to={`/events/${pendingEvent.id}`}>
                <Button variant="primary">초안 검토하기</Button>
              </Link>
            )}
          </div>
        )}

        {/* 카드가 보여주는 값이 '마지막 유효 관측'이므로 그 시각을 함께 밝힌다.
            이게 없으면 수집이 계속 실패해도 옛 수치가 현재값처럼 읽힌다. */}
        {data?.observation && (
          <p className="obs-stamp">
            {formatTime(data.observation.observed_at)} 관측 기준
            {isStaleObservation(data.observation.observed_at) && (
              <span className="obs-stamp-warn"> · 이후 수집이 실패해 값이 갱신되지 않았습니다</span>
            )}
          </p>
        )}

        <div className="obs-grid">
          {(() => {
            const obs = data?.observation ?? null;
            const rain = criteriaFor(data?.criteria ?? [], "rain");
            const wind = criteriaFor(data?.criteria ?? [], "wind");
            const snow = criteriaFor(data?.criteria ?? [], "snow");
            const heat = criteriaFor(data?.criteria ?? [], "heat");

            const rainGrade = gradeBySingleValue(
              obs?.rain_mm_per_hr,
              rain.watch?.threshold.rain_mm_per_hr,
              rain.warning?.threshold.rain_mm_per_hr,
            );
            const windGrade = gradeBySingleValue(
              obs?.wind_ms,
              wind.watch?.threshold.wind_ms,
              wind.warning?.threshold.wind_ms,
            );
            // 판정 엔진과 동일하게 시간 신적설이 아닌 당일 누적(snowToday)을 기준으로 비교
            const snowGrade = gradeBySingleValue(
              data?.snowToday,
              snow.watch?.threshold.snow_cm,
              snow.warning?.threshold.snow_cm,
            );
            const heatByTemp = gradeBySingleValue(
              obs?.temp_c,
              heat.watch?.threshold.temp_c,
              heat.warning?.threshold.temp_c,
            );
            const heatByFeels = gradeBySingleValue(
              obs?.feels_c,
              heat.watch?.threshold.feels_c,
              heat.warning?.threshold.feels_c,
            );
            const heatGrade =
              heatByTemp === "warning" || heatByFeels === "warning"
                ? "warning"
                : heatByTemp === "watch" || heatByFeels === "watch"
                  ? "watch"
                  : undefined;

            return (
              <>
                <div className={`obs-card ${rainGrade ? "obs-card-warn" : ""}`}>
                  <div className="obs-card-head">
                    <span className="obs-card-label">
                      <svg className="obs-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M8 13a4 4 0 1 1 .8-7.9A5 5 0 0 1 18 7a4 4 0 0 1-1 7.9H8Z"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinejoin="round"
                        />
                        <path d="M9 17v2M12 17v3M15 17v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      시간당 강수량
                    </span>
                    {rainGrade && <Badge grade={rainGrade} />}
                  </div>
                  <div className="obs-card-value">
                    <span className="obs-card-num">{num(obs?.rain_mm_per_hr)}</span>
                    <span className="obs-card-unit">mm</span>
                  </div>
                  <p className="obs-card-caption">
                    주의보 {num(rain.watch?.threshold.rain_mm_per_hr, 0)} · 경보{" "}
                    {num(rain.warning?.threshold.rain_mm_per_hr, 0)}
                  </p>
                </div>

                <div className={`obs-card ${heatGrade ? "obs-card-warn" : ""}`}>
                  <div className="obs-card-head">
                    <span className="obs-card-label">
                      <svg className="obs-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 3v11.5M9.5 15a2.5 2.5 0 1 0 5 0c0-1-.5-1.5-1.25-2.25a2 2 0 0 1-.75-1.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                      기온 · 체감
                    </span>
                    {heatGrade && <Badge grade={heatGrade} />}
                  </div>
                  <div className="obs-card-value">
                    <span className="obs-card-num">{num(obs?.temp_c)}</span>
                    <span className="obs-card-unit">℃</span>
                  </div>
                  <p className="obs-card-caption">
                    체감 {num(obs?.feels_c)}℃ · 폭염 기준 {num(heat.watch?.threshold.temp_c, 0)}℃
                  </p>
                </div>

                <div className={`obs-card ${windGrade ? "obs-card-warn" : ""}`}>
                  <div className="obs-card-head">
                    <span className="obs-card-label">
                      <svg className="obs-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M4 8h9a2.5 2.5 0 1 0-2.5-2.5M4 12h13a2.5 2.5 0 1 1-2.5 2.5M4 16h7a2 2 0 1 1-2 2"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                      풍속
                    </span>
                    {windGrade && <Badge grade={windGrade} />}
                  </div>
                  <div className="obs-card-value">
                    <span className="obs-card-num">{num(obs?.wind_ms)}</span>
                    <span className="obs-card-unit">m/s</span>
                  </div>
                  <p className="obs-card-caption">
                    주의보 {num(wind.watch?.threshold.wind_ms, 0)} · 경보 {num(wind.warning?.threshold.wind_ms, 0)}
                  </p>
                </div>

                <div className={`obs-card ${snowGrade ? "obs-card-warn" : ""}`}>
                  <div className="obs-card-head">
                    <span className="obs-card-label">
                      <svg className="obs-card-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path
                          d="M12 3v18M4.5 6.75l15 10.5M19.5 6.75l-15 10.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                      적설량
                    </span>
                    {snowGrade && <Badge grade={snowGrade} />}
                  </div>
                  <div className="obs-card-value">
                    <span className="obs-card-num">{num(data?.snowToday)}</span>
                    <span className="obs-card-unit">cm</span>
                  </div>
                  <p className="obs-card-caption">
                    {/* num()은 결측값에 "–"를 돌려주므로 "+"를 그대로 붙이면 "+–cm"이 된다.
                        값이 없을 때는 증분 표기 자체를 접는다. */}
                    오늘 누적 · 이번 시간{" "}
                    {obs?.snow_new_cm == null ? "–" : `+${num(obs.snow_new_cm)}cm`}
                  </p>
                </div>
              </>
            );
          })()}
        </div>

        <div className="dash-panels">
          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">진행 중 특보</h3>
              <span className="panel-count">{data?.openEvents.length ?? 0}건</span>
            </div>
            {!data || data.openEvents.length === 0 ? (
              <p className="event-row-line">진행 중인 특보가 없습니다.</p>
            ) : (
              data.openEvents.map((ev) => (
                <div className="event-row" key={ev.id}>
                  <div className="event-row-main">
                    <div className="event-row-head">
                      <span className="event-row-kind">{KIND_LABEL[ev.kind]}</span>
                      <Badge grade={ev.grade} />
                      {ev.status === "PENDING_APPROVAL" && <span className="badge-pending">승인 대기</span>}
                    </div>
                    {ev.status === "PENDING_APPROVAL" ? (
                      <p className="event-row-line">
                        오늘 {formatTime(ev.detected_at)} 감지 · 승인 대기
                        <br />
                        재알림 {ev.repeat_count}회
                        {ev.last_reminded_at ? ` · 마지막 ${formatTime(ev.last_reminded_at)}` : ""}
                      </p>
                    ) : (
                      <p className="event-row-line">
                        오늘 {formatTime(ev.detected_at)} 발생
                        {ev.last_reminded_at ? ` · ${formatTime(ev.last_reminded_at)} 발송 완료` : ""}
                        <br />
                        반복 발송 {ev.repeat_count}회차
                      </p>
                    )}
                  </div>
                  <div className="event-row-cta">
                    <Link to={`/events/${ev.id}`}>
                      <Button variant={ev.status === "PENDING_APPROVAL" ? "primary" : "ghost"}>
                        {ev.status === "PENDING_APPROVAL" ? "초안 검토" : "상세 보기"}
                      </Button>
                    </Link>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3 className="panel-title">최근 발송</h3>
              <Link to="/history" className="panel-link">
                전체 보기
              </Link>
            </div>
            {!data || data.dispatches.length === 0 ? (
              <p className="event-row-line">발송 이력이 없습니다.</p>
            ) : (
              data.dispatches.map((d) => {
                const kind = d.kind;
                const grade = d.grade;
                const scope = dispatchScope(d);
                return (
                  <div className="dispatch-row" key={d.id}>
                    <div className="dispatch-row-head">
                      <span className="dispatch-row-title">
                        {kind ? KIND_LABEL[kind] : "-"} {grade === "warning" ? "경보" : "주의보"}
                      </span>
                      <span className="dispatch-row-time">{formatTime(d.sent_at)}</span>
                    </div>
                    <p className={`dispatch-row-scope ${scope.failCount > 0 ? "dispatch-row-scope-fail" : ""}`}>
                      {scope.label} · {scope.total}명{scope.failCount > 0 ? ` (${scope.failCount}명 실패)` : ""}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 티커가 position:fixed로 본문 위에 떠 있으므로, 스크롤 끝에서 마지막
            내용이 가려지지 않도록 티커 높이만큼 자리를 비워둔다. */}
        <div className="dash-ticker-spacer" />
      </div>
      <BoardTicker items={tickerItems} fixed />
    </AppLayout>
  );
}

// 월보드 표시용 변환. 컴포넌트 밖 순수 함수로 둬야 테스트하기 쉽고,
// (렌더 시 호출되긴 하지만) 이 컴포넌트 상태 변화 없이는 재계산될 일이 없다.
const KIND_OF_METRIC: Record<BoardMetric["key"], Kind> = {
  rain: "rain",
  temp: "heat",
  wind: "wind",
  feels: "heat",
};

const METRIC_DEFS: Omit<BoardMetric, "value" | "threshold" | "history">[] = [
  { key: "rain", label: "시간당 강수량", unit: "mm", gradeLabel: "폭우 주의보", allowNegative: false },
  { key: "temp", label: "기온", unit: "℃", gradeLabel: "폭염 주의보", allowNegative: true },
  { key: "wind", label: "풍속", unit: "m/s", gradeLabel: "강풍 주의보", allowNegative: false },
  { key: "feels", label: "체감온도", unit: "℃", gradeLabel: "폭염 주의보", allowNegative: true },
];

const THRESHOLD_KEY: Record<BoardMetric["key"], string> = {
  rain: "rain_mm_per_hr",
  temp: "temp_c",
  wind: "wind_ms",
  feels: "feels_c",
};

const OBS_FIELD: Record<BoardMetric["key"], keyof ObservationPoint> = {
  rain: "rain_mm_per_hr",
  temp: "temp_c",
  wind: "wind_ms",
  feels: "feels_c",
};

export function toBoardProps(data: DashboardData | null, siteName: string, now: Date) {
  const obs = data?.observation ?? null;
  const history = data?.history ?? [];

  const metrics: BoardMetric[] = METRIC_DEFS.map((def) => {
    const watch = (data?.criteria ?? []).find(
      (c) => c.kind === KIND_OF_METRIC[def.key] && c.grade === "watch",
    );
    // threshold 0은 "기준 미설정"이다(DashboardBoard가 그렇게 해석한다) — 폴백을
    // 지우면 기준 없는 지표가 0으로 취급돼 항상 초과로 오판된다.
    const threshold = watch?.threshold?.[THRESHOLD_KEY[def.key]] ?? 0;
    const field = OBS_FIELD[def.key];
    const raw = obs ? (obs[field] as number | null) : null;
    return {
      ...def,
      threshold,
      value: raw ?? null,
      history: history
        .map((h) => h[field] as number | null | undefined)
        // 실제 Supabase 응답은 선택된 컬럼을 항상 null로 채우지만, 테스트 하네스는
        // 필드 자체가 없는 행을 돌려줄 수 있어 undefined도 걸러야 한다.
        .filter((v): v is number => v !== null && v !== undefined),
    };
  });

  const events: BoardEvent[] = (data?.openEvents ?? []).map((e) => ({
    id: e.id,
    title: `${KIND_LABEL[e.kind]} ${e.grade === "warning" ? "경보" : "주의보"}`,
    tag: e.status === "PENDING_APPROVAL" ? "승인 대기" : "발송 완료",
    detail:
      e.status === "PENDING_APPROVAL"
        ? `${formatTime(e.detected_at)} 감지 · 재알림 ${e.repeat_count}회`
        : `${formatTime(e.detected_at)} 발생 · 반복 ${e.repeat_count}회차`,
    severe: e.grade === "warning",
  }));

  return {
    siteName,
    clock: now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }),
    collectedAgo: obs ? `${formatTime(obs.observed_at)} 관측 기준` : "관측 없음",
    metrics,
    events,
  };
}
