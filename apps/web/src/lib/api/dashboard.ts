// server/src/api/dashboard.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";
import type { WeatherEvent } from "../types";

// dashboard.ts의 OBS_COLS는 id를 내려주지 않는다 — /latest, /observations?since=는
// 이 형태다. 단건(/observations/:id)만 id를 추가로 포함한다(ObservationDetail).
export type ObservationRow = {
  observed_at: string;
  rain_mm_per_hr: number | null;
  temp_c: number | null;
  feels_c: number | null;
  wind_ms: number | null;
  humidity_pct: number | null;
  snow_new_cm: number | null;
  missing: boolean;
};

export type ObservationDetail = ObservationRow & { id: number };

// weather_criteria는 kind+grade가 기본키다. dashboard.ts는 updated_at을 select하지 않는다.
export type CriteriaRow = { kind: WeatherEvent["kind"]; grade: WeatherEvent["grade"]; threshold: Record<string, number> };

export type SiteSettingsRow = {
  id: number;
  site_name: string;
  address: string;
  nx: number;
  ny: number;
  remind_interval_min: number;
  resolve_notice: boolean;
  updated_at: string;
};

export type HeartbeatRow = { name: string; last_run_at: string; ok: boolean; note: string | null };

export const latestObservation = () => apiGet<ObservationRow | null>("/api/observations/latest");
export const observationsSince = (iso: string) =>
  apiGet<ObservationRow[]>(`/api/observations?since=${encodeURIComponent(iso)}`);
// 특보의 trigger_observation_id로 그 특보를 일으킨 관측 1건을 정확히 짚는다
// (EventReview.tsx) — 근사치가 아니라 실제 id 매칭이다.
export const observation = (id: number) => apiGet<ObservationDetail | null>(`/api/observations/${id}`);
export const openEvents = () => apiGet<WeatherEvent[]>("/api/events/open");
export const criteria = () => apiGet<CriteriaRow[]>("/api/criteria");
export const saveCriteria = (rows: CriteriaRow[]) => apiSend<CriteriaRow[]>("PUT", "/api/criteria", { rows });
export const siteSettings = () => apiGet<SiteSettingsRow | null>("/api/site-settings");
// site_settings는 시드 1행뿐이고 admin에게 update만 허용한다 — 부분 갱신(PATCH)이다.
export const saveSiteSettings = (patch: Partial<Omit<SiteSettingsRow, "id" | "updated_at">>) =>
  apiSend<SiteSettingsRow>("PATCH", "/api/site-settings", patch);
export const heartbeat = (name: string) => apiGet<HeartbeatRow | null>(`/api/heartbeats/${encodeURIComponent(name)}`);
