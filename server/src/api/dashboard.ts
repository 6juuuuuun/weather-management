import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth, requireAdmin } from "../auth/middleware.ts";
import { GRID_NX_MAX, GRID_NY_MAX } from "../kmaGrid.ts";
import { CRITERIA_FIELDS } from "../criteriaFields.ts";

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
const overLength = (v: string, max: number) => [...v].length > max;

// 기상청 단기예보 격자의 실제 범위(nx 1~149, ny 1~253).
//
// 여기에 범위 검사가 없던 동안 `nx: -1`이 그대로 저장됐고, 그 순간부터 기상청
// 호출이 매시간 실패해 **관측 수집이 통째로 멈췄다**(QA W-10). 그런데 화면의
// 셋업 체크리스트는 "관측 지점"을 "행이 저장돼 있는가"로만 보아 계속 완료로
// 표시했다 — 이 프로젝트가 반복해서 물린 "고장났는데 초록불"이다.
// 그래서 두 겹으로 막는다: 여기서 저장을 거부하고(방벽),
// jobs/watchdog.ts가 이미 저장된 잘못된 좌표를 사유로 드러낸다(가시성).
// 범위 자체는 두 곳이 같은 값을 봐야 하므로 ../kmaGrid.ts 하나에만 적혀 있다.
// 재알림 간격. 0이나 음수면 스케줄러가 매 tick 재알림을 보내고(승인자에게 DM 폭탄),
// 지나치게 크면 재알림이 사실상 없는 것과 같다. 하루(1440분)를 상한으로 둔다.
export const REMIND_INTERVAL_RANGE = [5, 1440] as const;
export const MAX_SITE_NAME = 40;
export const MAX_ADDRESS = 200;

// 키 → 검증기. 오류 문구를 돌려주면 그것이 거부 사유이고, null이면 통과다.
//
// Record<string, ...>로 못박지 않고 satisfies를 쓴다 — 그러면 키가 리터럴 유니온으로
// 남아, 아래 PATCH의 SITE_SETTINGS_RULES[key] 조회가 "없을 수도 있는 값"이 되지 않는다
// (tsconfig의 noUncheckedIndexedAccess는 인덱스 시그니처에만 걸린다). 허용 키 목록도
// 여기 하나로 모인다 — 예전에는 이 객체와 PATCH의 배열 두 곳에 따로 적혀 있어,
// 한쪽에만 컬럼을 추가하면 조용히 어긋났다.
const SITE_SETTINGS_RULES = {
  site_name: (v: unknown) =>
    !isText(v)
      ? "site_name 값의 형식이 올바르지 않습니다"
      : String(v).trim() === ""
        ? "지점 이름이 비어 있습니다"
        : overLength(String(v).trim(), MAX_SITE_NAME)
          ? `지점 이름은 ${MAX_SITE_NAME}자 이하여야 합니다`
          : null,
  address: (v: unknown) =>
    !isText(v)
      ? "address 값의 형식이 올바르지 않습니다"
      : overLength(String(v), MAX_ADDRESS)
        ? `주소는 ${MAX_ADDRESS}자 이하여야 합니다`
        : null,
  nx: (v: unknown) =>
    !isInt(v)
      ? "nx 값의 형식이 올바르지 않습니다"
      : (v as number) < 1 || (v as number) > GRID_NX_MAX
        ? `nx는 1~${GRID_NX_MAX} 사이여야 합니다 (기상청 격자 범위를 벗어나면 날씨 수집이 멈춥니다)`
        : null,
  ny: (v: unknown) =>
    !isInt(v)
      ? "ny 값의 형식이 올바르지 않습니다"
      : (v as number) < 1 || (v as number) > GRID_NY_MAX
        ? `ny는 1~${GRID_NY_MAX} 사이여야 합니다 (기상청 격자 범위를 벗어나면 날씨 수집이 멈춥니다)`
        : null,
  remind_interval_min: (v: unknown) =>
    !isInt(v)
      ? "remind_interval_min 값의 형식이 올바르지 않습니다"
      : (v as number) < REMIND_INTERVAL_RANGE[0] || (v as number) > REMIND_INTERVAL_RANGE[1]
        ? `재알림 간격은 ${REMIND_INTERVAL_RANGE[0]}~${REMIND_INTERVAL_RANGE[1]}분 사이여야 합니다`
        : null,
  resolve_notice: (v: unknown) =>
    typeof v === "boolean" ? null : "resolve_notice 값의 형식이 올바르지 않습니다",
} satisfies Record<string, (v: unknown) => string | null>;
const SITE_SETTINGS_KEYS = Object.keys(SITE_SETTINGS_RULES) as (keyof typeof SITE_SETTINGS_RULES)[];

// 종류별 임계값의 필수 키와 허용 범위.
//
// 키 이름은 shared/engine.ts의 exceeds()가 실제로 읽는 이름과 **정확히** 같아야
// 한다. 예전에는 아무 검증도 없어서 오타 난 키(`rain_mm` 등)가 그대로 저장됐고,
// 그러면 exceeds가 undefined와 비교해 그 종류의 특보가 **영원히 뜨지 않는데**
// 화면에는 빈칸으로만 보였다(QA W-10). 그래서 모르는 키는 거부한다.
// 0도 거부한다 — `>= 0`은 언제나 참이라 매시간 특보가 뜬다(QA가 실제로 겪었다).
// 목록 자체는 ../criteriaFields.ts 한 곳에 있다 — **저장을 막는 여기**와 **이미
// 저장된 잘못된 값을 드러내는 jobs/watchdog.ts**가 반드시 같은 것을 봐야 한다.

const GRADE_LABEL = { watch: "주의보", warning: "경보" } as const;
const KIND_LABEL = { rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염" } as const;

function validateThreshold(kind: keyof typeof CRITERIA_FIELDS, threshold: Record<string, unknown>): string | null {
  const fields = CRITERIA_FIELDS[kind];
  for (const f of fields) {
    const v = threshold[f.key];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return `${KIND_LABEL[kind]} 기준의 ${f.key} 값이 숫자가 아닙니다`;
    }
    if (v <= 0) {
      return `${KIND_LABEL[kind]} 기준의 ${f.key}은(는) 0보다 커야 합니다 (0이면 매시간 특보가 뜹니다)`;
    }
    if (v > f.max) {
      return `${KIND_LABEL[kind]} 기준의 ${f.key}은(는) ${f.max}${f.unit} 이하여야 합니다`;
    }
  }
  const unknown = Object.keys(threshold).find((k) => !fields.some((f) => f.key === k));
  if (unknown) {
    return `${KIND_LABEL[kind]} 기준에 알 수 없는 항목 '${unknown}'이(가) 있습니다 (허용: ${fields
      .map((f) => f.key)
      .join(", ")})`;
  }
  return null;
}

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
              approved_by, approved_by_name, approved_at, last_reminded_at, repeat_count,
              -- remind_count(승인 재촉 횟수)와 repeat_count(발송 회차)는 뜻이 다른 값이다
              -- (0016_remind_count.sql). 화면의 "재알림 N회" 배지는 앞의 것을 읽어야 한다.
              remind_count
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

  // 값 자체를 본다(QA W-10). 예전에는 "threshold가 객체인가"까지만 보고 안의 값은
  // 전부 통과시켰다. 그래서 화면이 빈 칸을 0으로 바꿔 보내면 임계값이 0이 되어
  // **매시간 폭우 주의보**가 떴고, 오타 난 키는 그 종류의 특보를 **영원히** 막았다.
  for (const r of inRows) {
    const invalid = validateThreshold(r.kind, r.threshold as Record<string, unknown>);
    if (invalid) return res.status(400).json({ error: invalid });
  }

  // 경보는 주의보보다 낮을 수 없다. 뒤집히면 판정이 뒤집힌다: 경보 기준을 먼저
  // 넘으므로 주의보 단계 없이 곧바로 경보가 뜨고, 경보에서 주의보로 내려가는
  // 완화 판정이 일어나지 않는다. 관리자가 두 칸을 바꿔 넣어도 지금까지는
  // 아무도 말해 주지 않았다(QA W-10).
  //
  // 화면은 8행을 통째로 보내지만 API는 부분 배치도 받는다 — 짝이 되는 등급이
  // 본문에 없으면 저장된 값과 비교해야 한다. 저장된 값이 (옛 결함으로) 숫자가
  // 아닐 수 있으므로 그때는 비교를 건너뛴다: 여기서 막으면 관리자가 그 값을
  // 고칠 방법이 없어진다.
  const stored = await withUser(req.user!.accountId, async (q) => {
    const { rows } = await q.query("select kind, grade, threshold from weather_criteria");
    return rows as { kind: string; grade: string; threshold: Record<string, unknown> }[];
  });
  const effective = new Map<string, Record<string, unknown>>();
  for (const r of stored) effective.set(`${r.kind}:${r.grade}`, r.threshold ?? {});
  for (const r of inRows) effective.set(`${r.kind}:${r.grade}`, r.threshold);
  for (const r of inRows) {
    const kind = r.kind as keyof typeof CRITERIA_FIELDS;
    const watch = effective.get(`${kind}:watch`);
    const warning = effective.get(`${kind}:warning`);
    if (!watch || !warning) continue;
    for (const f of CRITERIA_FIELDS[kind]) {
      const w = watch[f.key];
      const g = warning[f.key];
      if (typeof w !== "number" || typeof g !== "number") continue;
      if (g < w) {
        return res.status(400).json({
          error:
            `${KIND_LABEL[kind]} ${GRADE_LABEL.warning} 기준(${g}${f.unit})이 ` +
            `${GRADE_LABEL.watch} 기준(${w}${f.unit})보다 낮습니다 — 경보는 주의보보다 높아야 합니다`,
        });
      }
    }
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
      // 타입만으로는 부족하다 — 타입이 맞는 잘못된 값(nx=-1)이 수집을 멈춘다(QA W-10).
      const v = body[key];
      const invalid = SITE_SETTINGS_RULES[key](v);
      if (invalid) {
        return res.status(400).json({ error: invalid });
      }
      // 문자열은 저장 전에 다듬는다 — 앞뒤 공백만 든 지점 이름은 위에서 이미
      // 거부되지만, 통과한 값에도 공백이 남으면 화면·DM 제목에 그대로 실린다.
      vals.push(typeof v === "string" ? v.trim() : v);
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
