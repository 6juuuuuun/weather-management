import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth } from "../auth/middleware.ts";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

// 모든 질의는 withUser를 거친다. 정책 27개가 여기서 적용된다.
const OBS_COLS = "observed_at, rain_mm_per_hr, temp_c, feels_c, wind_ms, snow_new_cm, missing";

dashboardRouter.get("/observations/latest", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ${OBS_COLS} from weather_observations
        where missing = false order by observed_at desc limit 1`,
    );
    return rows;
  });
  res.json(rows[0] ?? null);
});

dashboardRouter.get("/observations", async (req, res) => {
  const since = String(req.query.since ?? "");
  if (!since || Number.isNaN(Date.parse(since))) {
    return res.status(400).json({ error: "since 파라미터가 필요합니다" });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select ${OBS_COLS} from weather_observations
        where observed_at >= $1 and missing = false order by observed_at asc`,
      [since],
    );
    return rows;
  });
  res.json(rows);
});

// 브리프 원문은 "cleared_at is null"로 열린 특보를 걸렀지만 weather_events에는
// cleared_at 컬럼이 없다(실제 컬럼은 closed_at) — 그대로 옮기면 42703으로 매 호출이
// 죽는다. 게다가 closed_at is null만으로는 DISMISSED(반려)도 열린 것으로 잡힌다:
// send 함수는 반려 시 status만 DISMISSED로 바꾸고 closed_at은 비워 둔다(재감지 억제용
// 내부 상태일 뿐 화면에 다시 띄울 대상이 아니다). 지금 화면(Dashboard.tsx)이 실제로
// 쓰는 기준인 status in (PENDING_APPROVAL, ACTIVE)를 그대로 따른다.
dashboardRouter.get("/events/open", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `select id, kind, grade, status, detected_at, closed_at, trigger_observation_id,
              approved_by, approved_at, last_reminded_at, repeat_count
         from weather_events
        where status in ('PENDING_APPROVAL', 'ACTIVE')
        order by detected_at desc`,
    );
    return rows;
  });
  res.json(rows);
});

dashboardRouter.get("/criteria", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select kind, grade, threshold from weather_criteria");
    return rows;
  });
  res.json(rows);
});

dashboardRouter.get("/site-settings", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select id, site_name, nx, ny from site_settings where id = 1");
    return rows;
  });
  res.json(rows[0] ?? null);
});

dashboardRouter.get("/heartbeats/:name", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select name, last_run_at from heartbeats where name = $1", [
      req.params.name,
    ]);
    return rows;
  });
  res.json(rows[0] ?? null);
});
