import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Criterion, AlertSetting, OpenEvent } from "./types.ts";

export type SiteSettings = { site_name: string; nx: number; ny: number;
  remind_interval_min: number; resolve_notice: boolean };

export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function loadEngineInputs(db: SupabaseClient) {
  const [{ data: crit }, { data: sets }, { data: events }, { data: site }] = await Promise.all([
    db.from("weather_criteria").select("*"),
    db.from("alert_settings").select("*"),
    db.from("weather_events").select("*")
      .or("status.in.(PENDING_APPROVAL,ACTIVE),and(status.eq.DISMISSED,closed_at.is.null)"),
    db.from("site_settings").select("*").single(),
  ]);
  const criteria: Criterion[] = (crit ?? []).map((c: any) => ({ kind: c.kind, grade: c.grade, threshold: c.threshold }));
  const settings: AlertSetting[] = (sets ?? []).map((s: any) => ({
    kind: s.kind, enabled: s.enabled, repeatPolicy: s.repeat_policy,
    repeatAccumThreshold: s.repeat_accum_threshold, heatRepeatBasis: s.heat_repeat_basis }));
  const open: OpenEvent[] = (events ?? []).map((e: any) => ({
    id: e.id, kind: e.kind, grade: e.grade, status: e.status,
    dismissedOpen: e.status === "DISMISSED" && e.closed_at === null }));
  return { criteria, settings, open, site: site as SiteSettings };
}

export async function todayAccums(db: SupabaseClient, now: Date) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const midnightKst = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000);
  const { data } = await db.from("weather_observations")
    .select("rain_mm_per_hr, snow_new_cm, missing")
    .gte("observed_at", midnightKst.toISOString()).eq("missing", false);
  if (!data || data.length === 0) return { rainToday: null, snowToday: null };
  const sum = (k: string) => data.reduce((a: number, r: any) => a + Number(r[k] ?? 0), 0);
  return { rainToday: sum("rain_mm_per_hr"), snowToday: sum("snow_new_cm") };
}
