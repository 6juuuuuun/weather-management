// 기상청 단기예보(getVilageFcst) 응답을 행으로 바꾼다. 이 파일에는 판정이 없다 —
// 임계 비교는 forecastRules.ts 하나에서만 한다.

import { normalizeKmaKey } from "./kma.ts";

/**
 * `PCP`(1시간 강수량)·`SNO`(1시간 신적설)를 숫자로 읽는다.
 *
 * **이 값들은 숫자가 아니라 한글 문자열로 온다**: `"강수없음"` `"1.0mm"`
 * `"30.0~50.0mm"` `"50.0mm 이상"` `"1.0mm 미만"`. `Number()`에 그대로 넣으면
 * 전부 NaN이 되고 `NaN >= 임계`는 **조용히 false**다 — 값은 있는데 판정만
 * 사라지는, 이 프로젝트가 반복해서 고친 결함과 정확히 같은 모양이다.
 *
 * 그래서 읽지 못한 값은 **0이 아니라 null**을 돌려준다. 0은 "비가 오지 않는다"는
 * 단언이고, null은 "모른다"이다. 둘을 섞으면 모르는 것이 안전으로 둔갑한다.
 */
export function parseAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s === "") return null;
  if (s === "강수없음" || s === "적설없음" || s === "-") return 0;
  // 참값이 상한보다 작다는 것만 알 수 있다. 이 시스템의 임계는 전부 1보다
  // 훨씬 크므로(폭설 5cm·폭우 20mm) 0으로 두어도 판정이 달라지지 않는다.
  if (s.includes("미만")) return 0;
  // 범위는 **상한**을 쓴다. 덜 경고하는 쪽으로 기울면 안 되는 시스템이다.
  const nums = s.match(/\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return null;
  return Number(nums[nums.length - 1]);
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 단기예보 발표 시각(KST). 매 발표는 이 시각 + 10분에 열린다. */
const BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
/** 발표 직후 몇 분간은 아직 이전 회차만 있다. 여유를 둔다. */
const PUBLISH_DELAY_MIN = 15;

export type ForecastRow = {
  fcstAt: Date;
  tempC: number | null; popPct: number | null; pty: number | null; sky: number | null;
  pcpMm: number | null; snoCm: number | null; wsdMs: number | null; rehPct: number | null;
  tmnC: number | null; tmxC: number | null;
};

/** `YYYYMMDD` + `HHMM`(KST)을 Date로. 기상청 응답의 모든 시각은 KST다 —
 *  UTC로 읽으면 예보 전체가 9시간 어긋난다. */
function kstToDate(yyyymmdd: string, hhmm: string): Date {
  return new Date(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` +
      `T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+09:00`,
  );
}

/**
 * 지금 시각에 **이미 발표된** 가장 최근 회차를 고른다.
 *
 * 발표 시각 직후를 그대로 부르면 아직 열리지 않은 회차를 물어 NO_DATA가 난다.
 * 15분 여유를 두고 직전 회차로 내린다.
 */
export function forecastBaseDateTime(now: Date): { baseDate: string; baseTime: string } {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  let chosen = -1;
  for (const h of BASE_HOURS) if (h * 60 + PUBLISH_DELAY_MIN <= minutes) chosen = h;
  if (chosen === -1) {
    // 오늘 아직 한 회차도 열리지 않았다(00:00~02:15). 전날 마지막 회차를 쓴다.
    kst.setUTCDate(kst.getUTCDate() - 1);
    chosen = BASE_HOURS[BASE_HOURS.length - 1]!;
  }
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return { baseDate: `${y}${m}${d}`, baseTime: `${String(chosen).padStart(2, "0")}00` };
}

const BASE_URL = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst";

/** 실황(kma.ts)과 **같은 키 정규화**를 쓴다. 새로 만들지 않는다 —
 *  Encoding 키를 다시 인코딩하면 SERVICE_KEY_IS_NOT_REGISTERED_ERROR가 난다. */
export function buildForecastUrl(
  apiKey: string, nx: number, ny: number, baseDate: string, baseTime: string,
): string {
  return `${BASE_URL}?serviceKey=${normalizeKmaKey(apiKey)}&dataType=JSON` +
    `&numOfRows=1000&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
}

type RawItem = { category: string; fcstDate: string; fcstTime: string; fcstValue: string;
                 baseDate?: string; baseTime?: string };

/** 숫자 category. 값이 없거나 숫자가 아니면 null이다(0으로 뭉개지 않는다). */
function numOf(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function parseForecastResponse(json: unknown): { baseAt: Date; rows: ForecastRow[] } {
  const j = json as any;
  const code = j?.response?.header?.resultCode;
  if (code !== "00") {
    // 서비스 키 오류는 response 자체가 없고 OpenAPI_ServiceResponse로 온다.
    const detail = j?.response?.header ?? j?.OpenAPI_ServiceResponse?.cmmMsgHeader ?? j;
    throw new Error(`KMA forecast error: ${JSON.stringify(detail)}`);
  }
  const items = (j.response.body.items.item ?? []) as RawItem[];
  const byTime = new Map<string, Record<string, string>>();
  for (const it of items) {
    const key = `${it.fcstDate}${it.fcstTime}`;
    let bucket = byTime.get(key);
    if (!bucket) { bucket = {}; byTime.set(key, bucket); }
    bucket[it.category] = it.fcstValue;
  }
  const rows: ForecastRow[] = [...byTime.entries()]
    .map(([key, v]) => ({
      fcstAt: kstToDate(key.slice(0, 8), key.slice(8)),
      tempC: numOf(v.TMP), popPct: numOf(v.POP), pty: numOf(v.PTY), sky: numOf(v.SKY),
      pcpMm: parseAmount(v.PCP), snoCm: parseAmount(v.SNO),
      wsdMs: numOf(v.WSD), rehPct: numOf(v.REH),
      tmnC: numOf(v.TMN), tmxC: numOf(v.TMX),
    }))
    .sort((a, b) => a.fcstAt.getTime() - b.fcstAt.getTime());

  const first = items[0];
  const baseAt = first?.baseDate
    ? kstToDate(first.baseDate, first.baseTime ?? "0000")
    : new Date();
  return { baseAt, rows };
}

/** 실황의 fetchObservation과 같은 모양 — 3회 재시도 후 마지막 오류를 던진다. */
export async function fetchForecast(
  apiKey: string, nx: number, ny: number, now: Date, fetchFn: typeof fetch = fetch,
): Promise<{ baseAt: Date; rows: ForecastRow[] }> {
  const { baseDate, baseTime } = forecastBaseDateTime(now);
  const url = buildForecastUrl(apiKey, nx, ny, baseDate, baseTime);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseForecastResponse(await res.json());
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
