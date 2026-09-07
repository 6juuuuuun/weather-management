// 두 화면(일반 대시보드·월보드)이 같은 응답을 쓴다. 판정과 낡음은 여기서
// 끝내고 화면은 결과만 받는다 — phone.ts의 notifiable과 같은 선례다.
import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth } from "../auth/middleware.ts";
import { findUpcoming, markExceeds, type CriterionRow, type SettingRow } from "../forecastRules.ts";
import { summarizeDaily, type DailyPoint } from "../forecastSummary.ts";
import { FORECAST_STALE_HOURS } from "../jobs/forecastTick.ts";

export const forecastRouter = Router();
forecastRouter.use(requireAuth);

/** 스트립이 그리는 구간. 일별 요약은 이 창 밖까지 본다. */
const HOURLY_WINDOW_HOURS = 48;

forecastRouter.get("/forecast", async (req, res) => {
  const out = await withUser(req.user!.accountId, async (q) => {
    // 지난 예보는 빼고 지금부터 앞만 본다. 낡음 판정도 Postgres 안에서
    // 끝낸다 — Node와 DB 두 시계를 섞지 않는다.
    const { rows } = await q.query(
      `select fcst_at, temp_c, pop_pct, pty, sky, pcp_mm, sno_cm, wsd_ms, reh_pct,
              tmn_c, tmx_c, base_at, fetched_at
         from weather_forecasts
        where fcst_at >= date_trunc('hour', now())
        order by fcst_at`,
    );
    const { rows: criteria } = await q.query("select kind, grade, threshold from weather_criteria");
    const { rows: settings } = await q.query("select kind, enabled from alert_settings");
    // heartbeats.last_run_at이 아니라 weather_forecasts.fetched_at을 본다.
    // upsertHeartbeat는 실패해도 last_run_at을 now()로 찍는다(ok만 false로
    // 남는다) — last_run_at으로 재면 수집이 계속 실패해도 이 값은 항상
    // "방금"이라 화면이 영원히 stale:false를 받는다. watchdog.ts의 같은
    // 판정과 반드시 같은 모양이어야 한다(두 벌로 적히면 한쪽만 낡음을 안다).
    const { rows: staleRow } = await q.query(
      `select coalesce(
         (select now() - max(fetched_at) > ($1 || ' hours')::interval
            from weather_forecasts),
         false
       ) as stale`,
      [String(FORECAST_STALE_HOURS)],
    );
    return { rows, criteria, settings, stale: staleRow[0].stale as boolean };
  });

  const points: DailyPoint[] = out.rows.map((r: any) => ({
    fcstAt: new Date(r.fcst_at),
    tempC: r.temp_c === null ? null : Number(r.temp_c),
    pcpMm: r.pcp_mm === null ? null : Number(r.pcp_mm),
    snoCm: r.sno_cm === null ? null : Number(r.sno_cm),
    wsdMs: r.wsd_ms === null ? null : Number(r.wsd_ms),
    popPct: r.pop_pct === null ? null : Number(r.pop_pct),
    sky: r.sky === null ? null : Number(r.sky),
    tmnC: r.tmn_c === null ? null : Number(r.tmn_c),
    tmxC: r.tmx_c === null ? null : Number(r.tmx_c),
  }));

  // 시각별 초과 표시. **판정은 전부 여기서 끝난다** — 화면은 칠할지 말지만 받는다.
  // 누적으로 판정하는 폭설 때문에 전체 예보로 계산한 뒤 창을 자른다.
  const marks = markExceeds(points, out.criteria as CriterionRow[], out.settings as SettingRow[]);
  const marksAt = new Map<number, { kind: string; grade: string }[]>();
  for (const m of marks) {
    const k = m.at.getTime();
    const bucket = marksAt.get(k);
    if (bucket) bucket.push({ kind: m.kind, grade: m.grade });
    else marksAt.set(k, [{ kind: m.kind, grade: m.grade }]);
  }

  const cutoff = Date.now() + HOURLY_WINDOW_HOURS * 3600e3;
  const hourly = out.rows
    .filter((r: any) => new Date(r.fcst_at).getTime() <= cutoff)
    .map((r: any) => ({
      at: r.fcst_at, temp_c: r.temp_c === null ? null : Number(r.temp_c),
      pop_pct: r.pop_pct === null ? null : Number(r.pop_pct),
      pty: r.pty === null ? null : Number(r.pty),
      sky: r.sky === null ? null : Number(r.sky),
      pcp_mm: r.pcp_mm === null ? null : Number(r.pcp_mm),
      sno_cm: r.sno_cm === null ? null : Number(r.sno_cm),
      wsd_ms: r.wsd_ms === null ? null : Number(r.wsd_ms),
      exceeds: marksAt.get(new Date(r.fcst_at).getTime()) ?? [],
    }));

  // 예고 판정은 48시간 창이 아니라 **받은 예보 전체**로 한다. 내일모레
  // 폭설이 예상되는데 창 밖이라 말하지 않으면 미리 준비할 시간을 잃는다.
  const upcoming = findUpcoming(
    points,
    out.criteria as CriterionRow[],
    out.settings as SettingRow[],
  ).map((u) => ({ kind: u.kind, grade: u.grade, at: u.at.toISOString(), value: u.value, unit: u.unit }));

  res.json({
    fetched_at: out.rows[0]?.fetched_at ?? null,
    base_at: out.rows[0]?.base_at ?? null,
    stale: out.stale,
    hourly,
    daily: summarizeDaily(points),
    upcoming,
  });
});
