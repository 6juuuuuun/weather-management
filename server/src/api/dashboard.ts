import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

// 모든 질의는 withUser를 거친다. 정책 27개가 여기서 적용된다.
const OBS_COLS =
  "observed_at, rain_mm_per_hr, temp_c, feels_c, wind_ms, humidity_pct, snow_new_cm, missing";

// org.ts/content.ts와 같은 이유(0001_schema.sql의 enum)로 DB에 닿기 전에 막는다.
const EVENT_KINDS = ["rain", "snow", "wind", "heat"] as const;
const EVENT_GRADES = ["watch", "warning"] as const;

const SITE_SETTINGS_COLS = "id, site_name, address, nx, ny, remind_interval_min, resolve_notice, updated_at";

const isText = (v: unknown) => typeof v === "string";
const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);
// Record<string, ...>로 못박지 않고 satisfies를 쓴다 — 그러면 키가 리터럴 유니온으로
// 남아, 아래 PATCH의 SITE_SETTINGS_TYPES[key] 조회가 "없을 수도 있는 값"이 되지 않는다
// (tsconfig의 noUncheckedIndexedAccess는 인덱스 시그니처에만 걸린다). 허용 키 목록도
// 여기 하나로 모인다 — 예전에는 이 객체와 PATCH의 배열 두 곳에 따로 적혀 있어,
// 한쪽에만 컬럼을 추가하면 조용히 어긋났다.
const SITE_SETTINGS_TYPES = {
  site_name: isText,
  address: isText,
  nx: isInt,
  ny: isInt,
  remind_interval_min: isInt,
  resolve_notice: (v: unknown) => typeof v === "boolean",
} satisfies Record<string, (v: unknown) => boolean>;
const SITE_SETTINGS_KEYS = Object.keys(SITE_SETTINGS_TYPES) as (keyof typeof SITE_SETTINGS_TYPES)[];

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

// EventReview.tsx(apps/web)가 특보의 trigger_observation_id로 "그 특보를 일으킨
// 관측 1건"을 정확히 짚어야 하는데, 위 두 엔드포인트로는 안 된다 — /latest는
// 최신 1건만, /observations?since=는 id를 아예 select하지 않는다(구간 조회용).
// /observations/latest·/observations와 경로가 겹치므로 반드시 그 둘 다음에
// 등록해야 한다 — 먼저 오면 "latest"가 :id로 잡혀 버린다.
dashboardRouter.get("/observations/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "id 형식이 올바르지 않습니다" });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(`select id, ${OBS_COLS} from weather_observations where id = $1`, [id]);
    return rows;
  });
  // 같은 파일의 다른 단건 조회(PATCH /site-settings 등)가 없는 행에 404를 주므로
  // 규약을 맞춘다. 200 + null이면 호출부가 "조회는 됐는데 값이 없다"와
  // "그런 관측이 없다"를 구분할 수 없다.
  if (rows.length === 0) return res.status(404).json({ error: "관측을 찾을 수 없습니다" });
  res.json(rows[0]);
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
      // approved_by_name은 승인 시점에 함께 저장한 이름 스냅샷이다
      // (0013_actor_name_snapshot.sql) — 승인자가 퇴사해 삭제되면 approved_by는
      // null이 되지만 "누가 승인했는가"는 남아야 한다.
      `select id, kind, grade, status, detected_at, closed_at, trigger_observation_id,
              approved_by, approved_by_name, approved_at, last_reminded_at, repeat_count
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

// weather_criteria는 (kind,grade)가 기본키다 — w_admin(update)과 0004가 얹은
// w_admin_ins(insert) 정책이 둘 다 있어 upsert가 가능하다. 배치 하나라도
// kind/grade가 잘못되면 DB에 닿기 전에 전부 거부한다(다른 쓰기 엔드포인트와 같은 이유).
dashboardRouter.put("/criteria", requireAdmin, async (req, res) => {
  const inRows: any[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const bad = inRows.find(
    (r) =>
      !EVENT_KINDS.includes(r?.kind) ||
      !EVENT_GRADES.includes(r?.grade) ||
      typeof r?.threshold !== "object" ||
      r.threshold === null ||
      Array.isArray(r.threshold),
  );
  if (bad) {
    return res.status(400).json({
      error: `kind는 ${EVENT_KINDS.join(", ")} 중, grade는 ${EVENT_GRADES.join(", ")} 중이어야 하고 threshold는 객체여야 합니다`,
    });
  }
  const rows = await withUser(req.user!.accountId, async (q) => {
    const out: any[] = [];
    for (const r of inRows) {
      const { rows } = await q.query(
        `insert into weather_criteria (kind, grade, threshold, updated_at)
         values ($1, $2, $3, now())
         on conflict (kind, grade) do update
           set threshold = excluded.threshold, updated_at = excluded.updated_at
         returning kind, grade, threshold`,
        [r.kind, r.grade, JSON.stringify(r.threshold)],
      );
      out.push(...rows);
    }
    return out;
  });
  res.json(rows);
});

dashboardRouter.get("/site-settings", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(`select ${SITE_SETTINGS_COLS} from site_settings where id = 1`);
    return rows;
  });
  res.json(rows[0] ?? null);
});

// site_settings는 시드 1행(id=1)만 있고 RLS는 admin에게 update만 허용한다(insert
// 정책 없음, alert_settings와 같은 제약) — PUT이 아니라 update-only PATCH로 구현한다.
// employees PATCH와 같은 이유로 부분 갱신이다: 본문에 실제로 있는 키만 SET한다.
dashboardRouter.patch("/site-settings", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of SITE_SETTINGS_KEYS) {
    if (key in body) {
      // enum을 허용 목록으로 선검증하는 것과 같은 이유로 타입도 DB에 닿기 전에 막는다 —
      // 그냥 넘기면 Postgres가 22P02(잘못된 입력 구문)를 던져 클라이언트 잘못이
      // 500(서버 잘못)으로 보고된다. 컬럼 타입은 0001_schema.sql 기준이다.
      const v = body[key];
      const ok = SITE_SETTINGS_TYPES[key](v);
      if (!ok) {
        return res.status(400).json({ error: `${key} 값의 형식이 올바르지 않습니다` });
      }
      vals.push(v);
      sets.push(`${key} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "변경할 값이 없습니다" });
  sets.push("updated_at = now()");
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query(
      `update site_settings set ${sets.join(", ")} where id = 1 returning ${SITE_SETTINGS_COLS}`,
      vals,
    );
    return rows;
  });
  // insert 정책이 없으므로 행이 없으면(시드가 안 된 환경) update가 0건이다 —
  // 이때 조용히 200을 돌려주면 "저장됐다"고 착각하게 된다.
  if (rows.length === 0) return res.status(404).json({ error: "사이트 설정을 찾을 수 없습니다" });
  res.json(rows[0]);
});

dashboardRouter.get("/heartbeats/:name", async (req, res) => {
  const rows = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select name, last_run_at, ok, note from heartbeats where name = $1", [
      req.params.name,
    ]);
    return rows;
  });
  res.json(rows[0] ?? null);
});
