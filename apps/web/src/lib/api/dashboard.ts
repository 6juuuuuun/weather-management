// server/src/api/dashboard.ts의 엔드포인트에 대응한다.
import { apiGet, apiSend } from "./client";
import type { WeatherEvent } from "../types";

// dashboard.ts의 OBS_COLS는 id를 내려주지 않는다 — 단건/구간 조회 모두 이 형태다.
export type ObservationRow = {
  observed_at: string;
  rain_mm_per_hr: number | null;
  temp_c: number | null;
  feels_c: number | null;
  wind_ms: number | null;
  snow_new_cm: number | null;
  missing: boolean;
};

// weather_criteria는 kind+grade가 기본키다. dashboard.ts는 updated_at을 select하지 않는다.
export type CriteriaRow = { kind: WeatherEvent["kind"]; grade: WeatherEvent["grade"]; threshold: Record<string, number> };

// site_settings 실제 테이블에는 address/remind_interval_min/resolve_notice/updated_at도 있지만
// dashboard.ts는 id/site_name/nx/ny만 select한다 — Settings.tsx가 쓰는 나머지 필드는
// 이 엔드포인트로는 얻을 수 없다(report 참고).
export type SiteSettingsRow = { id: number; site_name: string; nx: number; ny: number };

// heartbeats 테이블에는 ok/note도 있지만 dashboard.ts는 name/last_run_at만 select한다.
export type HeartbeatRow = { name: string; last_run_at: string };

export const latestObservation = () => apiGet<ObservationRow | null>("/api/observations/latest");
export const observationsSince = (iso: string) =>
  apiGet<ObservationRow[]>(`/api/observations?since=${encodeURIComponent(iso)}`);
export const openEvents = () => apiGet<WeatherEvent[]>("/api/events/open");
export const criteria = () => apiGet<CriteriaRow[]>("/api/criteria");
export const siteSettings = () => apiGet<SiteSettingsRow | null>("/api/site-settings");
export const heartbeat = (name: string) => apiGet<HeartbeatRow | null>(`/api/heartbeats/${encodeURIComponent(name)}`);

// --- 아래 두 함수는 서버에 대응 엔드포인트가 없다 (dashboard.ts는 GET만 제공) ---
// Criteria.tsx/Settings.tsx의 저장 버튼이 호출은 하되, 서버가 라우트를 추가하기 전까지는
// 404로 실패한다. 화면은 이미 실패를 잡아 에러 배너/토스트로 보여주므로 크래시하지는
// 않는다 — task-8-report.md의 "서버 갭" 항목 참고.
export const saveCriteria = (rows: CriteriaRow[]) => apiSend<CriteriaRow[]>("PUT", "/api/criteria", { rows });
export const saveSiteSettings = (patch: Record<string, unknown>) =>
  apiSend<SiteSettingsRow>("PUT", "/api/site-settings", patch);
