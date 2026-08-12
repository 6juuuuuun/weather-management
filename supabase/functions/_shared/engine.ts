import type { Obs, Criterion, AlertSetting, OpenEvent, Action, Kind, Grade } from "./types.ts";

function exceeds(kind: Kind, obs: Obs, th: Record<string, number>): boolean|null {
  switch (kind) {
    case "rain": return obs.rain === null ? null : obs.rain >= th.rain_mm_per_hr;
    case "snow": return obs.snowToday === null ? null : obs.snowToday >= th.snow_cm;
    case "wind": return obs.wind === null ? null : obs.wind >= th.wind_ms;
    case "heat": {
      if (obs.temp === null && obs.feels === null) return null;
      return (obs.temp !== null && obs.temp >= th.temp_c)
          || (obs.feels !== null && obs.feels >= th.feels_c);
    }
  }
}

function repeatConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "once") return false;
  if (s.repeatPolicy === "until_daily_accum_below") {
    const accum = s.kind === "snow" ? obs.snowToday : obs.rainToday;
    return accum !== null && s.repeatAccumThreshold !== null && accum > s.repeatAccumThreshold;
  }
  if (s.kind === "heat") {
    const th = crit.threshold, basis = s.heatRepeatBasis ?? "temp";
    const v = basis === "feels" ? obs.feels : obs.temp;
    const t = basis === "feels" ? th.feels_c : th.temp_c;
    return v !== null && v >= t;
  }
  return exceeds(s.kind, obs, crit.threshold) === true;
}

function resolveConditionMet(s: AlertSetting, obs: Obs, crit: Criterion): boolean {
  if (s.repeatPolicy === "until_daily_accum_below") {
    const accum = s.kind === "snow" ? obs.snowToday : obs.rainToday;
    return accum !== null && s.repeatAccumThreshold !== null
      && accum <= s.repeatAccumThreshold && exceeds(s.kind, obs, crit.threshold) === false;
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
      } else if (resolveConditionMet(s, obs, crit)) {
        actions.push({ type:"resolve", eventId: ev.id, kind, grade: ev.grade });
      }
    }
  }
  return actions;
}
