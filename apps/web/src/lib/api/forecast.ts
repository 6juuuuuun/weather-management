// server/src/api/forecast.ts의 GET /api/forecast에 대응한다.
import { apiGet } from "./client";
import type { WeatherEvent } from "../types";

export type ForecastHour = {
  at: string; temp_c: number | null; pop_pct: number | null; pty: number | null;
  sky: number | null; pcp_mm: number | null; sno_cm: number | null; wsd_ms: number | null;
  /**
   * 이 시각이 넘는 임계. **서버가 판정한 값이다** — 화면은 임계와 비교하지
   * 않는다. 화면이 비교하기 시작하면 스트립·배너·실제 특보가 각자 다른
   * 기준을 갖게 된다(org.ts의 notifiable과 같은 이유).
   */
  exceeds: { kind: WeatherEvent["kind"]; grade: WeatherEvent["grade"] }[];
};

export type ForecastDay = {
  date: string; tmn_c: number | null; tmx_c: number | null; pop_max: number | null;
  pcp_sum: number | null; sno_sum: number | null; sky: number | null;
  /** 최저·최고를 기상청 값이 아니라 시간별 기온에서 유도했는가. */
  derived: boolean;
};

/**
 * 예보상 임계를 넘을 것으로 보이는 시각. **서버가 판정한 값이다** —
 * 화면은 임계 비교 규칙을 한 글자도 갖지 않는다. 화면이 스스로 비교하면
 * 배너와 실제 특보의 기준이 갈라지고, 그때 배너는 거짓말이 된다
 * (org.ts의 notifiable과 같은 이유).
 */
export type UpcomingRow = {
  kind: WeatherEvent["kind"]; grade: WeatherEvent["grade"];
  at: string; value: number; unit: string;
};

export type ForecastResponse = {
  fetched_at: string | null;
  base_at: string | null;
  /** 예보를 오래 받지 못했는가. **서버 판정이다** — 화면이 시간을 재면 두 화면의 기준이 갈라진다. */
  stale: boolean;
  hourly: ForecastHour[];
  daily: ForecastDay[];
  upcoming: UpcomingRow[];
};

export const forecast = () => apiGet<ForecastResponse>("/api/forecast");
