import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppLayout } from "../components/AppLayout";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import { computeSetupChecklist } from "../lib/setup";
import type { SetupChecklist } from "../lib/setup";
import type { Dispatch, Kind, WeatherCriteria, WeatherEvent, WeatherObservation } from "../lib/types";
import "./Dashboard.css";

const POLL_MS = 30_000;

const KIND_LABEL: Record<Kind, string> = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" };

type DispatchRow = Dispatch & {
  weather_events: { kind: Kind; grade: "watch" | "warning" } | null;
  messages: { content: { department_name: string; selected: boolean }[] } | null;
};

type DashboardData = {
  observation: WeatherObservation | null;
  criteria: WeatherCriteria[];
  openEvents: WeatherEvent[];
  dispatches: DispatchRow[];
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

function criteriaFor(criteria: WeatherCriteria[], kind: Kind) {
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
  const blocks = row.messages?.content ?? [];
  const selected = blocks.filter((b) => b.selected);
  let label = "";
  if (selected.length === 0) label = "-";
  else if (selected.length === blocks.length) label = "전체 부서";
  else if (selected.length === 1) label = selected[0].department_name;
  else label = `${selected[0].department_name} 외 ${selected.length - 1}곳`;
  return { label, failCount, total: results.length };
}

export default function Dashboard() {
  const { employee } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [setup, setSetup] = useState<SetupChecklist | null>(null);
  const [setupDetail, setSetupDetail] = useState<{ missingDeptCount: number }>({ missingDeptCount: 0 });

  const load = useCallback(async () => {
    const isAdmin = employee?.role === "admin";

    const [obsRes, eventsRes, dispatchesRes, criteriaRes, siteRes] = await Promise.all([
      supabase
        .from("weather_observations")
        .select("*")
        .order("observed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("weather_events")
        .select("*")
        .in("status", ["PENDING_APPROVAL", "ACTIVE"])
        .order("detected_at", { ascending: false }),
      supabase
        .from("dispatches")
        .select("*, weather_events(kind,grade), messages(content)")
        .order("sent_at", { ascending: false })
        .limit(5),
      supabase.from("weather_criteria").select("*"),
      supabase.from("site_settings").select("*").eq("id", 1).maybeSingle(),
    ]);

    setData({
      observation: (obsRes.data as WeatherObservation | null) ?? null,
      criteria: (criteriaRes.data as WeatherCriteria[] | null) ?? [],
      openEvents: (eventsRes.data as WeatherEvent[] | null) ?? [],
      dispatches: (dispatchesRes.data as unknown as DispatchRow[] | null) ?? [],
    });

    if (isAdmin) {
      const [deptRes, guidelineRes, alertRes] = await Promise.all([
        supabase.from("departments").select("id,parent_id"),
        supabase.from("action_guidelines").select("department_id"),
        supabase.from("alert_recipients").select("employee_id"),
      ]);
      const depts = deptRes.data ?? [];
      const parentIds = new Set(depts.map((d) => d.parent_id).filter(Boolean));
      const leafIds = new Set(depts.filter((d) => !parentIds.has(d.id)).map((d) => d.id));
      const guidelineDeptIds = new Set(
        (guidelineRes.data ?? []).map((g) => g.department_id).filter((id) => leafIds.has(id)),
      );

      const checklist = computeSetupChecklist({
        site: !!siteRes.data,
        criteria: (criteriaRes.data?.length ?? 0) >= 8,
        deptCount: leafIds.size,
        guidelineDeptCount: guidelineDeptIds.size,
        alertRecipientCount: (alertRes.data ?? []).length,
      });
      setSetup(checklist);
      setSetupDetail({ missingDeptCount: Math.max(0, leafIds.size - guidelineDeptIds.size) });
    } else {
      setSetup(null);
    }
  }, [employee?.role]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const today = formatDate(new Date());

  const pendingEvent = data?.openEvents.find((e) => e.status === "PENDING_APPROVAL") ?? null;

  return (
    <AppLayout title="대시보드" actions={<span className="dash-date">{today}</span>}>
      <p className="dash-desc">실시간 날씨 모니터링과 특보 현황</p>

      <div className="dash-stack">
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
            {employee?.role === "approver" && (
              <Link to={`/events/${pendingEvent.id}`}>
                <Button variant="primary">초안 검토하기</Button>
              </Link>
            )}
          </div>
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
            const snowGrade = gradeBySingleValue(
              obs?.snow_new_cm,
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
                    <span className="obs-card-num">{num(obs?.snow_new_cm)}</span>
                    <span className="obs-card-unit">cm</span>
                  </div>
                  <p className="obs-card-caption">
                    주의보 {num(snow.watch?.threshold.snow_cm, 0)} · 경보 {num(snow.warning?.threshold.snow_cm, 0)}
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
                const kind = d.weather_events?.kind;
                const grade = d.weather_events?.grade;
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
      </div>
    </AppLayout>
  );
}
