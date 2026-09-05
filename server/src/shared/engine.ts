import type { Obs, Criterion, AlertSetting, OpenEvent, Action, Kind, Grade } from "./types.ts";

/**
 * `v >= t`. **임계값이 없으면(undefined) false다.**
 *
 * 예전에는 `obs.rain >= th.rain_mm_per_hr`라고만 적혀 있었고, 키가 없으면
 * `숫자 >= undefined`가 NaN 비교로 false가 되어 **결과는 지금과 똑같았다.**
 * 바뀐 것은 동작이 아니라 그 사실이 코드에 보이는가다 — 저 한 줄을 읽고
 * "임계값이 비면 특보가 영영 안 뜬다"를 알아채는 사람은 없다.
 *
 * 임계값이 비는 것 자체를 막고 드러내는 일은 여기가 아니라 두 곳에서 한다
 * (criteriaFields.ts의 thresholdUsable): 저장을 막는 쪽(api/dashboard.ts의
 * PUT /criteria)과 이미 저장된 잘못된 값을 드러내는 쪽(jobs/watchdog.ts).
 * 판정 엔진은 값을 믿고 계산만 한다.
 */
const atLeast = (v: number, t: number | undefined): boolean => t !== undefined && v >= t;

function exceeds(kind: Kind, obs: Obs, th: Record<string, number>): boolean|null {
  switch (kind) {
    case "rain": return obs.rain === null ? null : atLeast(obs.rain, th.rain_mm_per_hr);
    case "snow": return obs.snowToday === null ? null : atLeast(obs.snowToday, th.snow_cm);
    case "wind": return obs.wind === null ? null : atLeast(obs.wind, th.wind_ms);
    case "heat": {
      if (obs.temp === null && obs.feels === null) return null;
      return (obs.temp !== null && atLeast(obs.temp, th.temp_c))
          || (obs.feels !== null && atLeast(obs.feels, th.feels_c));
    }
  }
}

// 일 누적(rainToday/snowToday)은 KST 자정까지 단조 증가만 하므로 해제 기준으로 쓸 수 없다
// (한 번 임계를 넘으면 비가 그쳐도 자정까지 매시간 재발송·미해제). 따라서 누적은 "반복을 계속할
// 이유"로만 쓰고, 해제는 강수/강설 중단(rain=0, snowNew=0)으로 판정한다.
// — 스펙 §5, 스펙 오너 판정 (2026-08-12). enum 값 until_daily_accum_below는 스키마 호환 위해 유지.
function fallingNow(s: AlertSetting, obs: Obs): boolean|null {
  const v = s.kind === "snow" ? obs.snowNew : obs.rain;
  return v === null ? null : v > 0;   // null = 결측 → 판정 안 함
}

function repeatConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "once") return false;
  if (s.repeatPolicy === "until_daily_accum_below") {
    // 아직 내리는 중 AND (기준 이상 OR 오늘 누적이 임계 초과) — 약해도 누적이 많으면 침수/적설 위험 지속
    if (fallingNow(s, obs) !== true) return false;
    if (exceeds(s.kind, obs, crit.threshold) === true) return true;
    const accum = s.kind === "snow" ? obs.snowToday : obs.rainToday;
    return accum !== null && s.repeatAccumThreshold !== null && accum > s.repeatAccumThreshold;
  }
  if (s.kind === "heat") {
    const th = crit.threshold, basis = s.heatRepeatBasis ?? "temp";
    const v = basis === "feels" ? obs.feels : obs.temp;
    const t = basis === "feels" ? th.feels_c : th.temp_c;
    return v !== null && atLeast(v, t);
  }
  return exceeds(s.kind, obs, crit.threshold) === true;
}

function resolveConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "until_daily_accum_below") {
    // 해제는 강수/강설 중단으로만 판정. 약한 비가 계속되고 누적도 적으면 repeat도 resolve도
    // 하지 않고 ACTIVE를 유지한다(알림 없음) — 의도된 동작.
    return fallingNow(s, obs) === false;
  }
  return exceeds(s.kind, obs, crit.threshold) === false;
}

export function evaluate(obs: Obs, criteria: Criterion[], settings: AlertSetting[], open: OpenEvent[]): Action[] {
  const actions: Action[] = [];
  const kinds: Kind[] = ["rain","snow","wind","heat"];
  for (const kind of kinds) {
    const s = settings.find(x => x.kind === kind);
    if (!s || !s.enabled) continue;
    const watch = criteria.find(c => c.kind === kind && c.grade === "watch");
    const warning = criteria.find(c => c.kind === kind && c.grade === "warning");
    const openOf = (g: Grade) => open.find(e => e.kind === kind && e.grade === g
      && (e.status === "PENDING_APPROVAL" || e.status === "ACTIVE"
          || (e.status === "DISMISSED" && e.dismissedOpen)));

    const warnHit = warning ? exceeds(kind, obs, warning.threshold) : null;
    const watchHit = watch ? exceeds(kind, obs, watch.threshold) : null;
    if (watchHit === null && warnHit === null) continue;

    const openWatch = openOf("watch"), openWarning = openOf("warning");
    let escalated = false;

    if (warnHit === true) {
      if (openWatch && openWatch.status !== "DISMISSED") {
        actions.push({ type:"escalate", eventId: openWatch.id, kind }); escalated = true;
      } else if (!openWarning) actions.push({ type:"create", kind, grade:"warning" });
    } else if (watchHit === true && !openWatch && !openWarning) {
      actions.push({ type:"create", kind, grade:"watch" });
    }

    for (const [ev, crit] of [[openWatch, watch], [openWarning, warning]] as const) {
      if (!ev || !crit) continue;
      if (escalated && ev.grade === "watch") continue;
      if (ev.status === "ACTIVE" && repeatConditionMet(s, obs, crit)) {
        actions.push({ type:"repeat", eventId: ev.id, kind, grade: ev.grade });
      // resolve는 PENDING 포함 모든 열린 특보에 적용 (승인 대기 중 자동 종료 — 스펙 §5)
      } else if (resolveConditionMet(s, obs, crit)) {
        actions.push({ type:"resolve", eventId: ev.id, kind, grade: ev.grade });
      }
    }
  }
  return actions;
}
