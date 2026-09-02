// 특보 기준(weather_criteria.threshold)이 **어떤 키를 가져야 하는가**를 한 곳에 둔다.
//
// 키 이름은 shared/engine.ts의 exceeds()가 실제로 읽는 이름과 정확히 같아야 한다.
// 오타 난 키(`rain_mm` 등)가 저장되면 exceeds가 undefined와 비교하므로 **그 종류의
// 특보가 영원히 뜨지 않는다** — 화면에는 빈칸으로만 보인다(QA W-10).
//
// 저장을 막는 쪽(api/dashboard.ts의 PUT /criteria)과 **이미 저장된 잘못된 값을
// 드러내는 쪽**(jobs/watchdog.ts)이 같은 목록을 봐야 한다. 값 검증은 2026-08-28
// 라운드에 들어갔지만, 그 전에 저장된 값과 DB를 직접 고친 경우는 그대로 남는다 —
// 그리고 그 상태에서 지금까지 모든 지표가 초록이었다. kmaGrid.ts와 같은 처방이다.
export const CRITERIA_FIELDS = {
  rain: [{ key: "rain_mm_per_hr", max: 500, unit: "mm" }],
  snow: [{ key: "snow_cm", max: 500, unit: "cm" }],
  wind: [{ key: "wind_ms", max: 100, unit: "m/s" }],
  heat: [
    { key: "temp_c", max: 60, unit: "℃" },
    { key: "feels_c", max: 60, unit: "℃" },
  ],
} as const satisfies Record<string, readonly { key: string; max: number; unit: string }[]>;

export type CriteriaKind = keyof typeof CRITERIA_FIELDS;

export const KIND_LABEL_KO: Record<CriteriaKind, string> = {
  rain: "폭우",
  snow: "폭설",
  wind: "강풍",
  heat: "폭염",
};

/**
 * 이 임계값으로 판정이 될 수 있는가.
 *
 * 0 이하도 거짓으로 본다 — `>= 0`은 언제나 참이라 매시간 특보가 뜨고(QA가 실제로
 * 겪었다), 음수는 그보다 더 나쁘다. 저장 검증과 같은 기준이다.
 */
export function thresholdUsable(kind: string, threshold: unknown): boolean {
  const fields = (CRITERIA_FIELDS as Record<string, readonly { key: string }[]>)[kind];
  if (!fields) return false;
  if (typeof threshold !== "object" || threshold === null || Array.isArray(threshold)) return false;
  const t = threshold as Record<string, unknown>;
  return fields.every((f) => typeof t[f.key] === "number" && Number.isFinite(t[f.key]) && (t[f.key] as number) > 0);
}
