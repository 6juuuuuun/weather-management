// supabase/functions/weather-tick/index.ts 이식.
// 바뀐 것은 두 가지뿐이다: (1) Supabase 클라이언트 호출을 withService의 SQL로,
// (2) Deno.serve HTTP 진입점을 걷어내고 순수 함수로. 판정 순서·분기·문구는 그대로다.
// CRON_SECRET 헤더 검사와 x-mock-kma 헤더는 진입점과 함께 사라진다 — 이제 이 함수를
// 부르는 건 외부 HTTP가 아니라 같은 프로세스의 스케줄러다.
//
// withService를 한 번 열어 작업 전체를 감싸지 않고 단계마다 나눠 여는 이유가 두 가지다.
// (1) 원본은 Supabase 호출마다 자동 커밋이었다 — 통째로 트랜잭션에 넣으면 판정 도중
//     오류가 났을 때 방금 저장한 관측까지 함께 롤백돼 "수집은 됐다"는 사실이 사라진다.
// (2) 카카오워크 발송(네트워크)이 트랜잭션 안에 들어가면 그동안 커넥션이 붙잡힌다.
//     그래서 발송은 항상 withService 블록 바깥에서 한다.
import { withService, type Querier } from "../db.ts";
import { fetchObservation, type KmaObservation } from "../shared/kma.ts";
import { feelsLikeC, snowNewCm } from "../shared/derive.ts";
import { evaluate } from "../shared/engine.ts";
import {
  composeDraft, renderMessage, formatObsLine, KIND_LABEL, GRADE_LABEL, type DeptBlock,
} from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import type { Kind, Grade, Obs, Criterion, AlertSetting, OpenEvent, Action } from "../shared/types.ts";
import { env, envChannel, alertRecipientKakaoIds } from "./common.ts";

export type SiteSettings = {
  site_name: string; nx: number; ny: number; remind_interval_min: number; resolve_notice: boolean;
};

// 원본 _shared/db.ts의 loadEngineInputs. 네 질의를 그대로 SQL로 옮겼다.
// weather_events의 `.or("status.in.(...),and(status.eq.DISMISSED,closed_at.is.null)")`는
// 아래 where 절과 같은 뜻이다 — DISMISSED이지만 아직 닫히지 않은 건은 재감지 금지 대상이라
// 열린 것으로 함께 실어야 한다.
export async function loadEngineInputs(q: Querier) {
  // 원본은 네 질의를 Promise.all로 동시에 던졌지만, 여기서는 넷이 한 커넥션(한 트랜잭션)을
  // 공유한다 — pg 커넥션은 질의를 동시에 처리하지 못하고 큐에 쌓을 뿐이라 이득이 없고,
  // pg@9에서는 아예 금지된다(deprecation). 순서대로 기다린다.
  const crit = await q.query("select kind, grade, threshold from weather_criteria");
  const sets = await q.query(
    "select kind, enabled, repeat_policy, repeat_accum_threshold, heat_repeat_basis from alert_settings");
  const events = await q.query(
    `select id, kind, grade, status, closed_at from weather_events
      where status in ('PENDING_APPROVAL','ACTIVE')
         or (status = 'DISMISSED' and closed_at is null)`,
  );
  const site = await q.query("select site_name, nx, ny, remind_interval_min, resolve_notice from site_settings limit 1");
  const criteria: Criterion[] = crit.rows.map((c: any) => ({ kind: c.kind, grade: c.grade, threshold: c.threshold }));
  const settings: AlertSetting[] = sets.rows.map((s: any) => ({
    kind: s.kind, enabled: s.enabled, repeatPolicy: s.repeat_policy,
    repeatAccumThreshold: s.repeat_accum_threshold, heatRepeatBasis: s.heat_repeat_basis }));
  const open: OpenEvent[] = events.rows.map((e: any) => ({
    id: e.id, kind: e.kind, grade: e.grade, status: e.status,
    dismissedOpen: e.status === "DISMISSED" && e.closed_at === null }));
  return { criteria, settings, open, site: site.rows[0] as SiteSettings };
}

// 원본 _shared/db.ts의 todayAccums. KST 자정 이후의 결측 아닌 관측만 합산하고,
// 한 건도 없으면 null을 돌려준다(0이 아니다 — 0은 "누적 0"으로 판정돼 반복 조건이 달라진다).
export async function todayAccums(q: Querier, now: Date) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const midnightKst = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
  const { rows } = await q.query(
    `select count(*)::int as n,
            coalesce(sum(rain_mm_per_hr), 0) as rain_today,
            coalesce(sum(snow_new_cm), 0) as snow_today
       from weather_observations
      where observed_at >= $1 and missing = false`,
    [midnightKst],
  );
  if (rows[0].n === 0) return { rainToday: null, snowToday: null };
  return { rainToday: Number(rows[0].rain_today), snowToday: Number(rows[0].snow_today) };
}

// last_run_at은 Node의 Date가 아니라 Postgres의 now()로 찍는다. 이 값을 판정하는
// 쪽(jobs/scheduler.ts의 catchUpIfMissed, jobs/watchdog.ts의 checkHealth)이 전부
// `now() - last_run_at > 임계값`을 SQL에서 계산하기 때문이다. 기록만 앱 시계로 하면
// 두 시계를 섞어 쓰는 셈이고, 앱 컨테이너 시계가 DB보다 앞서면(VM 재개·NTP 사고)
// last_run_at이 미래로 찍혀 수집이 완전히 멈춰도 워치독이 드리프트만큼 늦게 깨어난다.
// 이 프로젝트는 같은 부류를 이미 두 번 고쳤다(계정 잠금 2fc6b13, catchUpIfMissed).
// 시계 도메인을 Postgres 하나로 닫는다 — 그래서 이 함수는 시각을 인자로 받지 않는다.
export async function upsertHeartbeat(name: string, ok: boolean, note: string | null) {
  await withService((q) =>
    q.query(
      `insert into heartbeats (name, last_run_at, ok, note) values ($1, now(), $2, $3)
       on conflict (name) do update set
         last_run_at = excluded.last_run_at, ok = excluded.ok, note = excluded.note`,
      [name, ok, note],
    ),
  );
}

export type WeatherTickResult = { collected: boolean; events: number; actions: Action[] };

export async function runWeatherTick(
  deps: { channel?: NotificationChannel; now?: Date } = {},
): Promise<WeatherTickResult> {
  const channel = deps.channel ?? envChannel();
  const now = deps.now ?? new Date();

  const { criteria, settings, open, site } = await withService(loadEngineInputs);

  // 1. 관측 — 기상청 호출은 DB 트랜잭션 밖에서 한다.
  let kma: KmaObservation | null = null;
  let fetchError: unknown = null;
  try {
    kma = await fetchObservation(env("KMA_API_KEY")!, site.nx, site.ny, now);
  } catch (e) {
    fetchError = e;
  }

  const saved = await withService(async (q) => {
    if (kma) {
      const k = kma;
      const feels = (k.tempC !== null && k.humidityPct !== null && k.windMs !== null)
        ? feelsLikeC(k.tempC, k.humidityPct, k.windMs) : null;
      // jsonb 파라미터는 반드시 JSON 문자열로 넘긴다 — 객체·배열을 그대로 바인딩하면
      // pg가 Postgres 배열/레코드 리터럴로 직렬화해 jsonb 파싱이 깨진다.
      const { rows } = await q.query(
        `insert into weather_observations
           (observed_at, rain_mm_per_hr, temp_c, wind_ms, humidity_pct, snow_new_cm, feels_c, raw, missing)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false)
         on conflict (observed_at) do update set
           rain_mm_per_hr = excluded.rain_mm_per_hr, temp_c = excluded.temp_c,
           wind_ms = excluded.wind_ms, humidity_pct = excluded.humidity_pct,
           snow_new_cm = excluded.snow_new_cm, feels_c = excluded.feels_c,
           raw = excluded.raw, missing = false
         returning *`,
        [k.observedAt, k.rainMmPerHr, k.tempC, k.windMs, k.humidityPct,
         snowNewCm(k.rainMmPerHr, k.pty), feels, JSON.stringify(k)],
      );
      return rows[0];
    }
    // 기상청이 실패했을 때 조용히 넘어가면 화면은 옛 값을 최신인 양 보여준다.
    // 원본과 같이 정시로 내림한 시각에 결측 행을 남긴다.
    const { rows } = await q.query(
      `insert into weather_observations (observed_at, missing, raw)
       values ($1, true, $2::jsonb)
       on conflict (observed_at) do update set missing = true, raw = excluded.raw
       returning *`,
      [new Date(Math.floor(now.getTime() / 3600_000) * 3600_000), JSON.stringify({ error: String(fetchError) })],
    );
    return rows[0];
  });

  // 결측 3연속 → admin 알림, 판정 스킵
  if (saved.missing) {
    const admins = await withService(async (q) => {
      const { rows: last3 } = await q.query(
        "select missing from weather_observations order by observed_at desc limit 3",
      );
      if (!(last3.length === 3 && last3.every((r: any) => r.missing))) return [];
      const { rows } = await q.query(
        "select kakaowork_user_id from employees where role = 'admin' and kakaowork_user_id is not null",
      );
      return rows.map((r: any) => r.kakaowork_user_id as string);
    });
    for (const kw of admins)
      await channel.send(kw, "[날씨경영] 날씨 수집이 3시간 연속 실패했습니다. 시스템을 확인해 주세요.");
    await upsertHeartbeat("weather-tick", false, "missing");
    return { collected: false, events: 0, actions: [] };
  }

  // 2~3. 판정
  const acc = await withService((q) => todayAccums(q, now));
  const obs: Obs = { rain: saved.rain_mm_per_hr, snowNew: saved.snow_new_cm,
    snowToday: acc.snowToday, rainToday: acc.rainToday,
    temp: saved.temp_c, feels: saved.feels_c, wind: saved.wind_ms };
  const actions = evaluate(obs, criteria, settings, open);

  const obsLine = formatObsLine(saved);

  async function createEvent(kind: Kind, grade: Grade) {
    const { eventId, alertIds } = await withService(async (q) => {
      const { rows: evRows } = await q.query(
        "insert into weather_events (kind, grade, trigger_observation_id) values ($1, $2, $3) returning id",
        [kind, grade, saved.id],
      );
      const ev = evRows[0];
      const { rows: gRows } = await q.query(
        `select g.department_id, g.kind, g.grade, g.staff_actions, g.guest_notice,
                d.name as department_name
           from action_guidelines g
           join departments d on d.id = g.department_id
          where g.kind = $1 and g.grade = $2`,
        [kind, grade],
      );
      const { rows: rRows } = await q.query(
        `select r.department_id, r.employee_id, e.name, e.kakaowork_user_id
           from recipients r
           join employees e on e.id = r.employee_id`,
      );
      const blocks = composeDraft(kind, grade, gRows as any, rRows as any);
      await q.query("insert into messages (event_id, content) values ($1, $2::jsonb)",
        [ev.id, JSON.stringify(blocks)]);
      return { eventId: ev.id as string, alertIds: await alertRecipientKakaoIds(q) };
    });
    const deepLink = `${env("APP_BASE_URL")}/events/${eventId}`;
    for (const kw of alertIds)
      await channel.send(kw,
        `[날씨경영] ${KIND_LABEL[kind]} ${GRADE_LABEL[grade]} 감지 — 발송 초안이 승인을 기다립니다.\n${obsLine}\n검토: ${deepLink}`);
  }

  for (const a of actions) {
    if (a.type === "create") await createEvent(a.kind, a.grade);
    if (a.type === "escalate") {
      await withService((q) =>
        q.query("update weather_events set status = 'ESCALATED', closed_at = $2 where id = $1", [a.eventId, now]));
      await createEvent(a.kind, "warning");
    }
    if (a.type === "repeat") {
      const msg = await withService(async (q) => {
        const { rows } = await q.query(
          "select id, event_id, content from messages where event_id = $1 and status = 'approved'", [a.eventId]);
        return rows[0] ?? null;
      });
      if (msg) {
        const results: unknown[] = [];
        for (const b of (msg.content as DeptBlock[]).filter((b) => b.selected))
          for (const r of b.recipients)
            results.push({ employee_id: r.employee_id, name: r.name,
              ...(r.kakaowork_user_id
                ? await channel.send(r.kakaowork_user_id, renderMessage(b, { kindLabel: KIND_LABEL[a.kind],
                    gradeLabel: GRADE_LABEL[a.grade], siteName: site.site_name, obsLine }))
                : { ok: false, error: "카카오워크 미연결" }) });
        await withService(async (q) => {
          // 회차 채번은 weather_events.repeat_count 단일 소스 (승인 발송이 1회차 → 이후 +1씩).
          const { rows: evRows } = await q.query("select repeat_count from weather_events where id = $1", [a.eventId]);
          const repeatNo = (evRows[0]?.repeat_count ?? 0) + 1;
          await q.query(
            `insert into dispatches (message_id, event_id, repeat_no, results, content)
             values ($1, $2, $3, $4::jsonb, $5::jsonb)`,
            [msg.id, a.eventId, repeatNo, JSON.stringify(results), JSON.stringify(msg.content)],
          );
          await q.query("update weather_events set repeat_count = $2 where id = $1", [a.eventId, repeatNo]);
        });
      }
    }
    if (a.type === "resolve") {
      // 승인된 메시지 존재 여부로 분기 (스펙 오너 추가 결정, 2026-08-12):
      // - approved 메시지 있음 (ACTIVE였던 경우): resolve_notice에 따라 발송받았던 부서에 해제 알림
      // - approved 메시지 없음 (PENDING_APPROVAL 중 자동 종료): alert_recipients 전원에게 자동 종료 알림
      const { approvedMsg, alertIds } = await withService(async (q) => {
        const { rows } = await q.query(
          "select content from messages where event_id = $1 and status = 'approved'", [a.eventId]);
        await q.query("update weather_events set status = 'RESOLVED', closed_at = $2 where id = $1", [a.eventId, now]);
        return { approvedMsg: rows[0] ?? null, alertIds: rows[0] ? [] : await alertRecipientKakaoIds(q) };
      });
      if (approvedMsg) {
        if (site.resolve_notice) {
          for (const b of ((approvedMsg.content ?? []) as DeptBlock[]).filter((b) => b.selected))
            for (const r of b.recipients) if (r.kakaowork_user_id)
              await channel.send(r.kakaowork_user_id,
                `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되었습니다. 조치해 주셔서 감사합니다.`);
        }
      } else {
        for (const kw of alertIds)
          await channel.send(kw,
            `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되어 승인 대기 초안이 자동 종료되었습니다`);
      }
    }
  }

  await upsertHeartbeat("weather-tick", true, null);
  return { collected: true, events: actions.length, actions };
}
