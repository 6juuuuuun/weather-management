// 이관 전 원본(supabase/functions/weather-tick/index.ts, git 기록) 이식.
// 바뀐 것은 두 가지뿐이다: (1) Supabase 클라이언트 호출을 withService의 SQL로,
// (2) Deno.serve HTTP 진입점을 걷어내고 순수 함수로. 판정 순서·분기·문구는 그대로다.
// CRON_SECRET 헤더 검사와 x-mock-kma 헤더는 진입점과 함께 사라진다 — 이제 이 함수를
// 부르는 건 외부 HTTP가 아니라 같은 프로세스의 스케줄러다.
//
// withService를 한 번 열어 작업 전체를 감싸지 않고 단계마다 나눠 여는 이유가 두 가지다.
// (1) 원본은 Supabase 호출마다 자동 커밋이었다 — 통째로 트랜잭션에 넣으면 판정 도중
//     오류가 났을 때 방금 저장한 관측까지 함께 롤백돼 "수집은 됐다"는 사실이 사라진다.
// (2) 발송(네트워크)이 트랜잭션 안에 들어가면 그동안 커넥션이 붙잡힌다.
//     그래서 발송은 항상 withService 블록 바깥에서 한다.
import { hasGuidelineContent } from "../guidelineContent.ts";
import { withService, type Querier } from "../db.ts";
import { baseDateTime, fetchObservation, type KmaObservation } from "../shared/kma.ts";
import { feelsLikeC, snowNewCm } from "../shared/derive.ts";
import { evaluate } from "../shared/engine.ts";
import {
  composeDraft, formatObsLine, KIND_LABEL, GRADE_LABEL, type DeptBlock,
} from "../shared/template.ts";
import type { NotificationChannel } from "../shared/channel.ts";
import type { Kind, Grade, Obs, Criterion, AlertSetting, OpenEvent, Action } from "../shared/types.ts";
import { env, envChannel, channelName, alertRecipientPhones, renderLmsBody } from "./common.ts";
import { isSendablePhone, sendablePhoneSql } from "../phone.ts";

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

// 반복 발송의 수신자를 **그 회차 시점의 현재 명단**으로 갈아 끼운다 (QA W-06, 사용자 결정).
//
// 승인 시점의 messages.content는 부서 블록·문구·수신자를 통째로 스냅샷한다. 그 스냅샷만
// 읽으면 밤 10시에 승인된 폭설 특보가 새벽 2시에 교대한 야간 담당자에게는 끝까지 가지 않고,
// 그날 퇴사 처리된 사람에게는 매시간 계속 간다. **바뀌는 것은 받는 사람뿐이고, 메시지 내용은
// 승인된 그대로 둔다.** 잃는 것은 "승인자가 본 명단 = 실제 받은 사람"이라는 감사 보증이므로,
// 회차마다 실제로 누구에게 갔는지를 dispatches.content·results에 남겨 그 손실을 메운다.
export async function refreshRecipients(q: Querier, blocks: DeptBlock[]): Promise<DeptBlock[]> {
  const deptIds = blocks.map((b) => b.department_id);
  if (deptIds.length === 0) return blocks;
  const { rows } = await q.query(
    `select r.department_id, r.employee_id, e.name, e.phone
       from recipients r
       join employees e on e.id = r.employee_id
      where r.department_id = any($1::uuid[])`,
    [deptIds],
  );
  return blocks.map((b) => ({
    ...b,
    recipients: rows
      .filter((r: any) => r.department_id === b.department_id)
      .map((r: any) => ({ employee_id: r.employee_id, name: r.name, phone: r.phone })),
  }));
}

export type WeatherTickResult = {
  collected: boolean; events: number; actions: Action[];
  /** 이 tick에서 처리하다 예외로 끝난 액션 수. 0이 아니면 하트비트가 ok=false로 찍힌다. */
  actionFailures?: number;
};

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

  // 수집에 실패했는데 그 시각에 이미 성공 관측이 있는 경우를 구분한다(아래).
  let alreadyCollected = false;
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
    //
    // **결측을 실제로 놓친 시각에 남긴다** (QA W-13). 예전에는 앱의 현재 정시로
    // 내림해 썼는데(`floor(now)`), 성공 경로는 기상청이 준 base 시각에 쓴다.
    // 수집 크론은 매시 5분이고 baseDateTime()은 KST 분이 10분 미만이면 한 시간 전을
    // base로 잡으므로(shared/kma.ts) 두 시각이 **항상 1시간 어긋났다**. 결과:
    //  · 실제로 값을 잃은 시각에는 행이 아예 없고
    //  · 결측 표시는 한 시간 뒤 자리에 찍혔다가 **다음 성공 수집이 그 행을 덮어 지운다**
    // → "수집이 실패했었다"는 사실이 남지 않아 사후에 원인을 추적할 수 없다.
    // 성공 경로와 같은 함수로 시각을 계산해 두 경로를 한 자리에 맞춘다.
    const { baseDate, baseTime } = baseDateTime(now);
    const missingAt = new Date(
      `${baseDate.slice(0, 4)}-${baseDate.slice(4, 6)}-${baseDate.slice(6, 8)}T${baseTime.slice(0, 2)}:00:00+09:00`,
    );
    // 이미 그 시각의 **성공** 관측이 있으면 덮어쓰지 않는다. 값이 있는 행을 missing=true로
    // 바꾸면 "결측인데 값이 있는 행"이 생기고(부수 결함) 멀쩡한 관측도 화면에서 사라진다.
    const { rows } = await q.query(
      `insert into weather_observations (observed_at, missing, raw)
       values ($1, true, $2::jsonb)
       on conflict (observed_at) do update set missing = true, raw = excluded.raw
         where weather_observations.missing = true
       returning *`,
      [missingAt, JSON.stringify({ error: String(fetchError) })],
    );
    if (rows[0]) return rows[0];
    // 충돌했는데 갱신하지 않았다 = 그 시각은 이미 성공 수집이 있다(크론 밖 수동 실행,
    // 밀린 수집 따라잡기 등). 그 관측을 결측으로 만들지 않고, 판정도 다시 돌리지 않는다 —
    // 같은 관측으로 두 번 판정하면 같은 시간에 반복 발송이 한 번 더 나간다.
    alreadyCollected = true;
    const { rows: existing } = await q.query(
      "select * from weather_observations where observed_at = $1", [missingAt]);
    return existing[0];
  });

  if (alreadyCollected) {
    // 수집은 실패했지만 그 시각 관측은 이미 있다. 실패 사실은 하트비트에 남긴다 —
    // 삼키면 기상청 키 만료 같은 지속 장애가 이 경로에서만 조용히 지나간다.
    await upsertHeartbeat("weather-tick", false, "fetch-failed(이미 수집된 시각)");
    return { collected: false, events: 0, actions: [] };
  }

  // 결측 3연속 → admin 알림, 판정 스킵
  if (saved.missing) {
    const admins = await withService(async (q) => {
      const { rows: last3 } = await q.query(
        "select missing from weather_observations order by observed_at desc limit 3",
      );
      if (!(last3.length === 3 && last3.every((r: any) => r.missing))) return [];
      const { rows } = await q.query(
        `select phone from employees where role = 'admin' and ${sendablePhoneSql("phone")}`,
      );
      return rows.map((r: any) => r.phone as string);
    });
    for (const to of admins)
      await channel.send(to, "[날씨경영] 날씨 수집이 3시간 연속 실패했습니다. 시스템을 확인해 주세요.");
    await upsertHeartbeat("weather-tick", false, "missing");
    return { collected: false, events: 0, actions: [] };
  }

  // 2~3. 판정
  const acc = await withService((q) => todayAccums(q, now));
  const obs: Obs = { rain: saved.rain_mm_per_hr, snowNew: saved.snow_new_cm,
    snowToday: acc.snowToday, rainToday: acc.rainToday,
    temp: saved.temp_c, feels: saved.feels_c, wind: saved.wind_ms };
  const actions = evaluate(obs, criteria, settings, open);

  // **꺼진 종류에 열린 특보가 남아 있으면 여기서 닫는다**(검증 W-03 잔여분).
  //
  // shared/engine.ts의 `if (!s || !s.enabled) continue`는 그 종류를 통째로 건너뛴다 —
  // 감지만이 아니라 **해제 판정까지** 건너뛴다. 그래서 진행 중(ACTIVE)인 특보가 있는
  // 종류를 알림 설정에서 끄면 그 특보가 영구히 굳었다: 대시보드는 "대응 중"을 무기한
  // 표시하고, `dismiss`는 PENDING_APPROVAL만 받으므로 409, health/deep은 초록.
  // **제품 안에 되돌릴 길이 하나도 없었다.**
  //
  // engine.ts는 원본과 바이트 단위로 같아야 하므로 호출부에서 해결한다. 판정을
  // 끈 종류의 특보를 "대응 중"으로 계속 두는 것은 거짓말이다 — 아무도 그 특보가
  // 아직 유효한지 보고 있지 않다. 그래서 닫되, **평소의 해제와 똑같은 경로로**
  // 닫는다(아래 resolve 분기): 발송받았던 부서에 해제 알림이 나가고 이력에도 남는다.
  // 조용히 지우면 "대응 중"이라고 들었던 사람들이 끝났다는 말을 영영 못 듣는다.
  // 화면(알림 설정)은 끄기 전에 몇 건이 함께 해제되는지 먼저 알려 준다.
  const disabledKinds = new Set(settings.filter((s) => !s.enabled).map((s) => s.kind));
  for (const e of open) {
    if (!disabledKinds.has(e.kind)) continue;
    if (e.status !== "PENDING_APPROVAL" && e.status !== "ACTIVE") continue;
    console.warn(
      `[weather-tick] ${e.kind} 특보가 꺼진 종류에 열려 있어 해제합니다 (event=${e.id}) — 판정이 꺼져 있어 스스로 해제되지 않습니다`,
    );
    actions.push({ type: "resolve", eventId: e.id, kind: e.kind, grade: e.grade });
  }

  const obsLine = formatObsLine(saved);

  // 폭설 메시지에 적설량이 한 글자도 없었다(QA W-04) — 받는 사람은 얼마나 왔는지 모른 채
  // "폭설 주의보"만 읽는다. shared/template.ts의 formatObsLine은 원본과 바이트 단위로 같아야
  // 하므로 그 안에 넣을 수 없다. 종류별로 필요한 값을 **호출부에서** 덧붙인다.
  const lineFor = (kind: Kind) =>
    kind === "snow"
      ? `${obsLine} · 신적설 ${saved.snow_new_cm ?? "-"}cm(오늘 누적 ${acc.snowToday ?? "-"}cm)`
      : obsLine;

  async function createEvent(kind: Kind, grade: Grade) {
    const created = await withService(async (q) => {
      // one_open_event(kind, grade) 부분 유니크 인덱스와 같은 조건으로 충돌을 흡수한다
      // (QA W-12). 승격 분기는 이미 열린 경보가 있는지 보지 않고 createEvent를 부르는데
      // (shared/engine.ts:71-74, 손댈 수 없다), 그러면 여기서 유니크 위반이 터지고
      // 예전에는 그 예외가 tick 전체를 죽여 **그 시간의 폭설·강풍·폭염 판정까지 사라졌다.**
      // 이미 같은 종류·등급의 열린 특보가 있다면 새로 만들 이유가 없으므로 조용히 건너뛴다.
      const { rows: evRows } = await q.query(
        `insert into weather_events (kind, grade, trigger_observation_id) values ($1, $2, $3)
         on conflict (kind, grade) where status in ('PENDING_APPROVAL','ACTIVE') do nothing
         returning id`,
        [kind, grade, saved.id],
      );
      if (evRows.length === 0) return null;
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
        `select r.department_id, r.employee_id, e.name, e.phone
           from recipients r
           join employees e on e.id = r.employee_id`,
      );
      // 내용이 비어 있는 지침(인력 조정 지침도 고객 안내도 없는 행)은 제목만 있는 DM을
      // 만든다(QA W-22). shared/template.ts의 composeDraft는 행이 있으면 무조건 블록을
      // 만들므로 — 그 파일은 손댈 수 없다 — 여기서 걸러서 넘긴다. checkHealth·대시보드
      // 체크리스트도 같은 기준으로 센다.
      // 기준은 guidelineContent.ts 한 곳에 있다 — checkHealth의 SQL도 같은 파일에서
      // 온다. 두 곳에 따로 적혀 있던 동안 공백만 든 지침 한 줄이 발송에서는 걸러지고
      // health/deep만 503으로 만들었다(회귀 검증 §B-1).
      const effective = (gRows as any[]).filter(hasGuidelineContent);
      const blocks = composeDraft(kind, grade, effective as any, rRows as any);
      await q.query("insert into messages (event_id, content) values ($1, $2::jsonb)",
        [ev.id, JSON.stringify(blocks)]);
      return { eventId: ev.id as string, alertIds: await alertRecipientPhones(q) };
    });
    if (!created) {
      console.warn(`[weather-tick] ${kind} ${grade}는 이미 열려 있어 새로 만들지 않았습니다`);
      return;
    }
    const { eventId, alertIds } = created;
    const deepLink = `${env("APP_BASE_URL")}/events/${eventId}`;
    for (const to of alertIds)
      await channel.send(to,
        `[날씨경영] ${KIND_LABEL[kind]} ${GRADE_LABEL[grade]} 감지 — 발송 초안이 승인을 기다립니다.\n${lineFor(kind)}\n검토: ${deepLink}`);
  }

  // 액션마다 격리한다 (QA W-12). 예전에는 열린 특보 하나가 어긋나 예외가 나면
  // runWeatherTick이 통째로 죽었고, kinds 순회 순서가 rain → snow → wind → heat이라
  // **폭우 처리에서 난 예외가 그 시간의 폭설·강풍·폭염 판정까지 지웠다.** 관측 행은
  // 이미 저장돼 있어 대시보드는 방금 수집한 최신값을 정상으로 보여준다.
  //
  // 실패는 삼키지 않는다: 서버 로그에 남기고, 하트비트를 ok=false로 찍어
  // /api/health/deep과 6시간 워치독이 그 사실을 사람에게 말하게 한다(항목 2).
  let actionFailures = 0;
  for (const a of actions) {
    try {
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
          // 매 회차 현재 수신자를 다시 조회한다(QA W-06). 내용은 승인된 그대로다.
          const blocks = await withService((q) => refreshRecipients(q, msg.content as DeptBlock[]));
          const targets = blocks.filter((b) => b.selected).reduce((n, b) => n + b.recipients.length, 0);
          if (targets === 0)
            // 이 회차는 아무에게도 가지 않는다. 이력에는 results가 빈 배열로 남아 화면이
            // "수신자 0명"으로 그리고(History.tsx), 상태 점검도 같은 상태를 사유로 잡는다.
            console.error(
              `[weather-tick] 반복 발송 대상이 0명입니다 (event=${a.eventId}) — 부서 수신자를 확인하세요`,
            );
          const results: unknown[] = [];
          for (const b of blocks.filter((b) => b.selected))
            for (const r of b.recipients)
              results.push({ employee_id: r.employee_id, name: r.name,
                ...(isSendablePhone(r.phone)
                  ? await channel.send(r.phone as string, renderLmsBody(b, { kindLabel: KIND_LABEL[a.kind],
                      gradeLabel: GRADE_LABEL[a.grade], siteName: site.site_name, obsLine: lineFor(a.kind) }))
                  : { ok: false, error: "휴대폰 번호 없음" }) });
          // **명단에는 사람이 있는데 한 명도 못 받은 회차**를 실패로 센다(검증 §신규-1).
          //
          // 위 `targets === 0`은 "수신자가 지정되지 않았다"만 잡는다. 전원이 휴대폰
          // 번호가 없으면 targets는 2인데 실제 전달은 0명이고, 예전에는 그 회차가 조용히
          // 성공으로 기록됐다 — 하트비트가 ok=true라 health/deep도 워치독도 초록이었다.
          // 여기서 액션 실패로 세면 heartbeats.ok=false가 되고, checkHealth의
          // "마지막 수집·판정이 실패로 끝났습니다 (action-failed:N)"가 그 사실을 말한다.
          const repeatSent = (results as { ok?: boolean }[]).filter((r) => r.ok).length;
          if (results.length > 0 && repeatSent === 0) {
            actionFailures++;
            console.error(
              `[weather-tick] 반복 발송이 ${results.length}명 중 0명에게 전달됐습니다 (event=${a.eventId}) — 부서 수신자의 휴대폰 번호를 확인하세요`,
            );
          }
          await withService(async (q) => {
            // 회차 채번은 weather_events.repeat_count 단일 소스 (승인 발송이 1회차 → 이후 +1씩).
            const { rows: evRows } = await q.query("select repeat_count from weather_events where id = $1", [a.eventId]);
            const repeatNo = (evRows[0]?.repeat_count ?? 0) + 1;
            // content에는 **이번 회차에 실제로 쓴 블록**(갱신된 수신자 포함)을 남긴다 —
            // 승인 스냅샷을 그대로 남기면 "누가 받았나"를 사후에 알 수 없다.
            await q.query(
              // channel은 실제로 나간 채널을 적는다 — 컬럼 기본값에 맡기면
              // 로그로만 흘린 회차도 이력에는 실제로 보낸 것처럼 남는다(QA W-29).
              `insert into dispatches (message_id, event_id, repeat_no, results, content, channel)
               values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
              [msg.id, a.eventId, repeatNo, JSON.stringify(results), JSON.stringify(blocks),
               channelName(channel)],
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
          return { approvedMsg: rows[0] ?? null, alertIds: rows[0] ? [] : await alertRecipientPhones(q) };
        });
        if (approvedMsg) {
          if (site.resolve_notice) {
            // 해제 알림도 반복 발송과 같은 명단을 쓴다(QA W-06). 승인 시점 스냅샷으로 보내면
            // 방금 교대해 실제로 대응 중인 사람은 "끝났다"는 말을 못 듣고, 퇴근한 사람만 받는다.
            const closing = await withService((q) =>
              refreshRecipients(q, (approvedMsg.content ?? []) as DeptBlock[]));
            for (const b of closing.filter((b) => b.selected))
              for (const r of b.recipients) if (isSendablePhone(r.phone))
                await channel.send(r.phone as string,
                  `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되었습니다. 조치해 주셔서 감사합니다.`);
          }
        } else {
          for (const to of alertIds)
            await channel.send(to,
              `[날씨경영] ${KIND_LABEL[a.kind]} ${GRADE_LABEL[a.grade]} 상황이 해제되어 승인 대기 초안이 자동 종료되었습니다`);
        }
      }
    
    } catch (e) {
      actionFailures++;
      console.error(`[weather-tick] ${a.type} 액션 실패 (kind=${a.kind})`, e);
    }
  }

  await upsertHeartbeat(
    "weather-tick",
    actionFailures === 0,
    actionFailures === 0 ? null : `action-failed:${actionFailures}`,
  );
  return { collected: true, events: actions.length, actions, actionFailures };
}
