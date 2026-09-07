# 예보 기반 대시보드 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기상청 단기예보를 수집·저장해 일반 대시보드와 월보드에 48시간·5일 예보와 사전 예고 배너를 표시한다.

**Architecture:** 새 테이블 `weather_forecasts`에 5일치 시간별 예보를 upsert로 쌓고, 스케줄러가 기상청 발표 시각(하루 8회)에 맞춰 갱신한다. 예고 판정은 서버가 기존 `weather_criteria`를 그대로 읽어 수행하고 화면은 결과만 받는다. 발송·승인 경로는 건드리지 않는다.

**Tech Stack:** Node 22 · Express 5 · Postgres 16 · React 19 · Vitest

**Spec:** [docs/superpowers/specs/2026-09-07-forecast-dashboard-design.md](../specs/2026-09-07-forecast-dashboard-design.md)

## Global Constraints

- **예보로 문자를 보내지 않는다.** `server/src/jobs/send.ts`와 `server/src/jobs/remindTick.ts`는 **한 줄도 수정하지 않는다.**
- **예보로 `weather_events`를 만들지 않는다.** 특보는 계속 실측으로만 난다.
- **임계값은 `weather_criteria` 하나만 읽는다.** 예고 전용 임계값을 새로 만들지 않는다.
- **예고 판정은 서버에서만 한다.** 화면에 임계 비교 로직을 두지 않는다 (`notifiable` 선례).
- **KMA 호출은 반드시 `normalizeKmaKey()`(`server/src/shared/kma.ts`)를 거친다.** 새 인코딩 함수를 만들지 않는다.
- **`PCP`·`SNO` 파싱 실패는 `null`이다. `0`으로 뭉개지 않는다.**
- **하루 경계는 KST다.** SQL에서는 `(fcst_at at time zone 'Asia/Seoul')::date`.
- **`stale` 기준은 상수 하나(`FORECAST_STALE_HOURS = 6`)를 서버 전체가 공유한다.**
- **월보드 카드 색과 큰 숫자는 "지금"만 말한다.** 예보가 임계를 넘어도 카드 색은 바뀌지 않는다.
- **월보드에는 가로 스크롤을 쓰지 않는다.**
- **예고 배너에는 `예보 기준입니다 · 문자는 나가지 않았습니다`가 반드시 함께 나온다.**
- 새 npm 의존성을 추가하지 않는다.
- 서버 타입 검사는 오류 0건을 유지한다 (`cd server && npm run typecheck`).

---

## File Structure

**서버 — 새 파일**

| 파일 | 책임 |
|---|---|
| `db/migrations/0018_weather_forecasts.sql` | 테이블 + RLS 정책 |
| `server/src/shared/forecast.ts` | KMA 예보 **파싱만**. 네트워크·DB 없음 (fetch 함수 제외) |
| `server/src/forecastRules.ts` | 예고 **판정만**. 순수 함수, DB 없음 |
| `server/src/jobs/forecastTick.ts` | 수집 → 저장 → 정리 → heartbeat |
| `server/src/api/forecast.ts` | `GET /api/forecast` |

**서버 — 수정**

| 파일 | 무엇 |
|---|---|
| `server/src/jobs/watchdog.ts` | `Health`에 `warnings` 추가 |
| `server/src/jobs/scheduler.ts` | cron 등록 + 기동 시 따라잡기 |
| `server/src/index.ts` | `forecastRouter` 등록 |

**웹 — 새 파일**

| 파일 | 책임 |
|---|---|
| `apps/web/src/lib/api/forecast.ts` | 타입 + 조회 |
| `apps/web/src/lib/weatherIcon.ts` | `SKY`/`PTY` → 아이콘·라벨 |
| `apps/web/src/components/ForecastStrip.tsx` / `.css` | 48시간. `density` prop으로 두 화면 대응 |
| `apps/web/src/components/ForecastDaily.tsx` / `.css` | 5일 |
| `apps/web/src/components/ForecastBanner.tsx` / `.css` | 예고 배너 (두 화면 공용) |

**웹 — 수정**

| 파일 | 무엇 |
|---|---|
| `apps/web/src/components/MetricChart.tsx` | 예보 점선 + "지금" 세로선 |
| `apps/web/src/pages/Dashboard.tsx` | 예보 조회 + 블록 3개 삽입 + 월보드 props |
| `apps/web/src/pages/DashboardBoard.tsx` | props 확장 + 렌더 |

---

### Task 1: 예보 응답 파싱 (`shared/forecast.ts`)

기상청 응답을 행 배열로 바꾸는 순수 함수. **DB도 네트워크도 없다** — 그래서 실물 없이 전부 테스트된다.

**Files:**
- Create: `server/src/shared/forecast.ts`
- Test: `server/test/forecast-parse.test.ts`

**Interfaces:**
- Consumes: `normalizeKmaKey`(`server/src/shared/kma.ts`)
- Produces:
```ts
export type ForecastRow = {
  fcstAt: Date;
  tempC: number | null; popPct: number | null; pty: number | null; sky: number | null;
  pcpMm: number | null; snoCm: number | null; wsdMs: number | null; rehPct: number | null;
  tmnC: number | null; tmxC: number | null;
};
export function parseAmount(raw: string | undefined | null): number | null;
export function forecastBaseDateTime(now: Date): { baseDate: string; baseTime: string };
export function buildForecastUrl(apiKey: string, nx: number, ny: number, baseDate: string, baseTime: string): string;
export function parseForecastResponse(json: unknown): { baseAt: Date; rows: ForecastRow[] };
export function fetchForecast(apiKey: string, nx: number, ny: number, now: Date, fetchFn?: typeof fetch): Promise<{ baseAt: Date; rows: ForecastRow[] }>;
```

- [ ] **Step 1: `parseAmount`의 실패 테스트를 쓴다**

```ts
// server/test/forecast-parse.test.ts
import { describe, expect, it } from "vitest";
import { parseAmount } from "../src/shared/forecast.ts";

describe("parseAmount — PCP·SNO는 숫자가 아니라 한글 문자열로 온다", () => {
  it("'강수없음'·'적설없음'은 0이다", () => {
    expect(parseAmount("강수없음")).toBe(0);
    expect(parseAmount("적설없음")).toBe(0);
  });

  it("단위가 붙은 값을 숫자로 읽는다", () => {
    expect(parseAmount("1.0mm")).toBe(1);
    expect(parseAmount("5.0cm")).toBe(5);
    expect(parseAmount("30mm")).toBe(30);
  });

  // 범위는 상한을 쓴다. 안전 경보 시스템에서 덜 경고하는 쪽이 더 위험하다.
  it("범위는 상한을 쓴다", () => {
    expect(parseAmount("30.0~50.0mm")).toBe(50);
    expect(parseAmount("1.0~4.0cm")).toBe(4);
  });

  it("'이상'은 그 값을 쓴다", () => {
    expect(parseAmount("50.0mm 이상")).toBe(50);
  });

  // 참값이 1 미만이라는 것만 알 수 있다. 이 시스템의 어떤 임계도 1보다 훨씬
  // 크므로(최소 5cm) 판정에 영향이 없고, 0으로 두면 화면도 과장하지 않는다.
  it("'미만'은 0으로 본다", () => {
    expect(parseAmount("1.0mm 미만")).toBe(0);
    expect(parseAmount("1.0cm 미만")).toBe(0);
  });

  // **가장 중요한 줄.** null이 아니라 0을 돌려주면 "판정 불가"가 "안전"으로
  // 둔갑한다 — 이 프로젝트가 반복해 고친 결함과 같은 모양이다.
  it("읽을 수 없는 값은 0이 아니라 null이다", () => {
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("알수없음")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd server && npx vitest run test/forecast-parse.test.ts`
Expected: FAIL — `Failed to resolve import "../src/shared/forecast.ts"`

- [ ] **Step 3: `parseAmount`를 구현한다**

```ts
// server/src/shared/forecast.ts
// 기상청 단기예보(getVilageFcst) 응답을 행으로 바꾼다. 이 파일에는 판정이 없다 —
// 임계 비교는 forecastRules.ts 하나에서만 한다.

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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd server && npx vitest run test/forecast-parse.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 응답 파싱 테스트를 추가한다**

```ts
// server/test/forecast-parse.test.ts 에 이어서
import { parseForecastResponse, forecastBaseDateTime, buildForecastUrl } from "../src/shared/forecast.ts";

/** 실제 응답과 같은 모양의 최소 픽스처. category가 시각별로 흩어져 온다. */
function item(fcstDate: string, fcstTime: string, category: string, fcstValue: string) {
  return { baseDate: "20260907", baseTime: "0500", category, fcstDate, fcstTime, fcstValue, nx: 61, ny: 121 };
}
function ok(items: ReturnType<typeof item>[]) {
  return { response: { header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" }, body: { items: { item: items } } } };
}

describe("parseForecastResponse", () => {
  it("같은 시각의 여러 category를 한 행으로 모은다", () => {
    const { rows } = parseForecastResponse(ok([
      item("20260907", "0600", "TMP", "18"),
      item("20260907", "0600", "POP", "20"),
      item("20260907", "0600", "PCP", "강수없음"),
      item("20260907", "0600", "SNO", "적설없음"),
      item("20260907", "0600", "SKY", "3"),
      item("20260907", "0600", "PTY", "0"),
      item("20260907", "0600", "WSD", "1.3"),
      item("20260907", "0600", "REH", "90"),
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tempC).toBe(18);
    expect(rows[0]!.popPct).toBe(20);
    expect(rows[0]!.pcpMm).toBe(0);
    expect(rows[0]!.snoCm).toBe(0);
    expect(rows[0]!.wsdMs).toBe(1.3);
  });

  // fcstDate+fcstTime은 KST다. UTC로 읽으면 모든 예보가 9시간 어긋난다.
  it("예보 시각을 KST로 읽는다", () => {
    const { rows } = parseForecastResponse(ok([item("20260907", "0600", "TMP", "18")]));
    expect(rows[0]!.fcstAt.toISOString()).toBe("2026-09-06T21:00:00.000Z");
  });

  it("발표 시각(baseAt)도 KST로 읽는다", () => {
    const { baseAt } = parseForecastResponse(ok([item("20260907", "0600", "TMP", "18")]));
    expect(baseAt.toISOString()).toBe("2026-09-06T20:00:00.000Z");
  });

  it("TMN·TMX는 그 값이 온 시각의 행에만 담긴다", () => {
    const { rows } = parseForecastResponse(ok([
      item("20260907", "0600", "TMN", "16.0"),
      item("20260907", "1500", "TMX", "27.0"),
    ]));
    const at06 = rows.find((r) => r.fcstAt.toISOString() === "2026-09-06T21:00:00.000Z");
    const at15 = rows.find((r) => r.fcstAt.toISOString() === "2026-09-07T06:00:00.000Z");
    expect(at06!.tmnC).toBe(16);
    expect(at06!.tmxC).toBeNull();
    expect(at15!.tmxC).toBe(27);
  });

  it("결과가 시각 오름차순이다", () => {
    const { rows } = parseForecastResponse(ok([
      item("20260908", "0300", "TMP", "15"),
      item("20260907", "0600", "TMP", "18"),
    ]));
    expect(rows.map((r) => r.tempC)).toEqual([18, 15]);
  });

  it("resultCode가 00이 아니면 던진다", () => {
    expect(() =>
      parseForecastResponse({ response: { header: { resultCode: "03", resultMsg: "NO_DATA" } } }),
    ).toThrow(/KMA/);
  });

  // 서비스 키 오류는 response 자체가 오지 않는다 — 실제로 겪은 모양이다.
  it("서비스 키 오류 응답도 던진다", () => {
    expect(() =>
      parseForecastResponse({ OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" } } }),
    ).toThrow(/KMA/);
  });
});

describe("forecastBaseDateTime — 발표 시각으로 내린다", () => {
  // 발표는 02·05·08·11·14·17·20·23시 + 10분. 그 전에 부르면 직전 회차를 써야 한다.
  it("09:30 KST면 08시 발표를 쓴다", () => {
    expect(forecastBaseDateTime(new Date("2026-09-07T00:30:00Z"))).toEqual({ baseDate: "20260907", baseTime: "0800" });
  });

  it("08:05 KST면 아직 08시 발표 전이라 05시를 쓴다", () => {
    expect(forecastBaseDateTime(new Date("2026-09-06T23:05:00Z"))).toEqual({ baseDate: "20260907", baseTime: "0500" });
  });

  it("00:30 KST면 전날 23시 발표를 쓴다", () => {
    expect(forecastBaseDateTime(new Date("2026-09-06T15:30:00Z"))).toEqual({ baseDate: "20260906", baseTime: "2300" });
  });
});

describe("buildForecastUrl", () => {
  it("Encoding 키를 이중 인코딩하지 않는다", () => {
    // %2B가 %252B가 되면 SERVICE_KEY_IS_NOT_REGISTERED_ERROR가 난다(실제로 겪었다).
    const url = buildForecastUrl("abc%2Bdef", 61, 121, "20260907", "0500");
    expect(url).toContain("serviceKey=abc%2Bdef");
    expect(url).not.toContain("%252B");
  });

  it("한 번에 5일치를 받도록 numOfRows를 충분히 준다", () => {
    expect(buildForecastUrl("k", 61, 121, "20260907", "0500")).toContain("numOfRows=1000");
  });
});
```

- [ ] **Step 6: 실패를 확인한다**

Run: `cd server && npx vitest run test/forecast-parse.test.ts`
Expected: FAIL — `parseForecastResponse is not a function` 외

- [ ] **Step 7: 나머지를 구현한다**

```ts
// server/src/shared/forecast.ts 에 이어서
import { normalizeKmaKey } from "./kma.ts";

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
```

- [ ] **Step 8: 통과를 확인한다**

Run: `cd server && npx vitest run test/forecast-parse.test.ts && npm run typecheck`
Expected: PASS (전체) · 타입 오류 0

- [ ] **Step 9: 변이로 테스트가 무는지 확인한다**

`parseAmount`의 `if (s.includes("미만")) return 0;`을 지우고 테스트를 돌린다.
Expected: `'미만'은 0으로 본다`가 FAIL (`"1.0mm 미만"` → `1`이 되므로).
확인 후 **되돌린다.**

`return null` (읽을 수 없는 값)을 `return 0`으로 바꾸고 돌린다.
Expected: `읽을 수 없는 값은 0이 아니라 null이다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 10: 커밋**

```bash
git add server/src/shared/forecast.ts server/test/forecast-parse.test.ts
git commit -m "feat(server): 기상청 단기예보 응답을 행으로 읽는다"
```

---

### Task 2: 테이블과 저장 (`0018` + `jobs/forecastTick.ts`)

**Files:**
- Create: `db/migrations/0018_weather_forecasts.sql`
- Create: `server/src/jobs/forecastTick.ts`
- Test: `server/test/forecast-tick.test.ts`

**Interfaces:**
- Consumes: `fetchForecast`·`ForecastRow`(Task 1), `withService`(`server/src/db.ts`), `upsertHeartbeat`(`server/src/jobs/weatherTick.ts`)
- Produces:
```ts
export const FORECAST_STALE_HOURS = 6;
export type ForecastTickResult = { ok: boolean; saved: number; note: string | null };
export function runForecastTick(
  deps?: { now?: Date; fetchFn?: typeof fetch },
): Promise<ForecastTickResult>;
```

- [ ] **Step 1: 마이그레이션을 쓴다**

```sql
-- db/migrations/0018_weather_forecasts.sql
-- 기상청 단기예보 보관. weather_observations와 같은 자리에 같은 방식으로 둔다.
--
-- 왜 저장하는가: 받아서 화면에 바로 흘려보내면 기상청이 죽었을 때 화면이 빈다.
-- 그리고 "예보가 멈췄다"를 아무도 모른다 — 이 프로젝트가 여섯 라운드 내내
-- 고친 결함이 전부 그 모양이었다. 저장하면 마지막 값과 그것을 언제 받았는지가
-- 함께 남아, 화면과 워치독이 낡음을 말할 수 있다. 5일 × 24시간 = 약 120행뿐이다.
create table weather_forecasts (
  fcst_at    timestamptz primary key,
  temp_c     numeric,
  pop_pct    integer,
  pty        integer,
  sky        integer,
  -- PCP·SNO는 기상청이 한글 문자열로 준다("강수없음"). 읽지 못한 값은 여기에
  -- null로 들어온다 — 0으로 뭉개면 "모른다"가 "비 안 온다"로 둔갑한다.
  pcp_mm     numeric,
  sno_cm     numeric,
  wsd_ms     numeric,
  reh_pct    integer,
  -- 기상청이 하루 중 특정 시각 행에만 실어 준다. 대부분의 행에서는 null이다.
  tmn_c      numeric,
  tmx_c      numeric,
  base_at    timestamptz not null,
  fetched_at timestamptz not null default now()
);

alter table weather_forecasts enable row level security;

-- weather_observations와 같은 정책. 로그인한 사람은 읽고, 쓰기는 app_service만
-- (bypassrls). 예보에는 개인정보가 없지만 정책을 빼면 이 테이블만 예외가 되고,
-- 다음 사람이 "왜 얘만 다른가"를 다시 추적해야 한다.
create policy r_all on weather_forecasts for select using (auth.uid() is not null);
```

- [ ] **Step 2: 마이그레이션을 적용해 본다**

Run: `DB_DIR=./db sh ops/migrate.sh`
Expected: `→ 0018_weather_forecasts.sql 적용` 후 `마이그레이션 1개를 적용했습니다.`

- [ ] **Step 3: 저장의 실패 테스트를 쓴다**

```ts
// server/test/forecast-tick.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import { withService } from "../src/db.ts";
import { runForecastTick, FORECAST_STALE_HOURS } from "../src/jobs/forecastTick.ts";

// 실제 문자가 나가지 않게 못박는다(다른 스위트와 같은 처방).
process.env.SMS_PROVIDER = "";

const NOW = new Date("2026-09-07T00:30:00Z"); // 09:30 KST

/** 지정한 시각들에 대한 예보를 돌려주는 가짜 기상청. */
function fakeKma(times: { date: string; time: string; tmp: string; pcp?: string; sno?: string }[]) {
  const item = (t: (typeof times)[number], category: string, fcstValue: string) => ({
    baseDate: "20260907", baseTime: "0800", category,
    fcstDate: t.date, fcstTime: t.time, fcstValue, nx: 61, ny: 121,
  });
  const items = times.flatMap((t) => [
    item(t, "TMP", t.tmp),
    item(t, "PCP", t.pcp ?? "강수없음"),
    item(t, "SNO", t.sno ?? "적설없음"),
  ]);
  return async () =>
    new Response(JSON.stringify({
      response: { header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" }, body: { items: { item: items } } },
    }), { status: 200 });
}

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from weather_forecasts");
    await q.query("delete from heartbeats where name = 'forecast-tick'");
  });
});

describe("runForecastTick", () => {
  it("받은 예보를 저장한다", async () => {
    const out = await runForecastTick({
      now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(true);
    expect(out.saved).toBe(1);
    const rows = await withService(async (q) =>
      (await q.query("select fcst_at, temp_c, pcp_mm, sno_cm from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].temp_c)).toBe(23);
    expect(Number(rows[0].pcp_mm)).toBe(0);
  });

  // 같은 시각을 다시 예보하면 최신 발표로 덮어야 한다. 안 그러면 3시간 전
  // 예보가 화면에 남아 "비 안 온다"고 말한다.
  it("같은 시각은 최신 발표로 덮는다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "27" }]) as unknown as typeof fetch });
    const rows = await withService(async (q) =>
      (await q.query("select temp_c from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].temp_c)).toBe(27);
  });

  it("지난 예보를 지운다", async () => {
    await withService(async (q) =>
      q.query(`insert into weather_forecasts (fcst_at, base_at) values (now() - interval '3 days', now())`));
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const rows = await withService(async (q) =>
      (await q.query("select fcst_at from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
  });

  it("heartbeat를 남긴다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const beat = await withService(async (q) =>
      (await q.query("select ok from heartbeats where name = 'forecast-tick'")).rows[0]);
    expect(beat.ok).toBe(true);
  });

  // **가장 중요한 줄.** 기상청이 죽었다고 마지막 예보를 지우면 화면이 빈다.
  // 낡은 값을 "낡았다"고 말하며 보여주는 것이 아무것도 없는 것보다 낫다.
  it("수집이 실패해도 마지막 예보를 지우지 않는다", async () => {
    await runForecastTick({ now: NOW,
      fetchFn: fakeKma([{ date: "20260907", time: "1000", tmp: "23" }]) as unknown as typeof fetch });
    const out = await runForecastTick({
      now: NOW,
      fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    expect(out.ok).toBe(false);
    const rows = await withService(async (q) =>
      (await q.query("select temp_c from weather_forecasts")).rows);
    expect(rows).toHaveLength(1);
  });

  it("수집이 실패하면 heartbeat도 실패로 남는다", async () => {
    await runForecastTick({
      now: NOW,
      fetchFn: (async () => { throw new Error("network down"); }) as unknown as typeof fetch,
    });
    const beat = await withService(async (q) =>
      (await q.query("select ok, note from heartbeats where name = 'forecast-tick'")).rows[0]);
    expect(beat.ok).toBe(false);
    expect(beat.note).toBeTruthy();
  });

  it("낡음 기준은 6시간이다", () => {
    expect(FORECAST_STALE_HOURS).toBe(6);
  });
});
```

- [ ] **Step 4: 실패를 확인한다**

Run: `cd server && npx vitest run test/forecast-tick.test.ts`
Expected: FAIL — `Failed to resolve import "../src/jobs/forecastTick.ts"`

- [ ] **Step 5: 수집 작업을 구현한다**

```ts
// server/src/jobs/forecastTick.ts
// 기상청 단기예보를 받아 weather_forecasts에 쌓는다.
//
// 관측(weatherTick)과 나눠 두는 이유: 발표 주기가 다르고(관측 매시 / 예보 하루 8회),
// 실패의 뜻도 다르다. 관측이 멈추면 특보가 안 뜨고, 예보가 멈추면 사전 예고만
// 사라진다. 한 작업에 묶으면 그 차이가 heartbeat 하나에 뭉개진다.
import { withService } from "../db.ts";
import { upsertHeartbeat } from "./weatherTick.ts";
import { fetchForecast } from "../shared/forecast.ts";
import { env } from "./common.ts";

/**
 * 예보가 이만큼 낡으면 "받지 못하고 있다"로 본다.
 *
 * 발표 간격이 3시간이므로 6시간은 **2회 연속 실패** 이후다. 3시간으로 잡으면
 * 한 번의 일시적 실패마다 경고가 떠 사람이 곧 무시하기 시작한다.
 *
 * 이 상수 하나를 서버 전체가 쓴다 — `/api/forecast`의 `stale`과
 * `/api/health/deep`의 `warnings`가 두 벌로 적히면 화면은 "정상"인데
 * warnings에는 올라 있는 상태가 생긴다.
 */
export const FORECAST_STALE_HOURS = 6;

export type ForecastTickResult = { ok: boolean; saved: number; note: string | null };

export async function runForecastTick(
  deps: { now?: Date; fetchFn?: typeof fetch } = {},
): Promise<ForecastTickResult> {
  const now = deps.now ?? new Date();

  const site = await withService(async (q) => {
    const { rows } = await q.query("select nx, ny from site_settings order by id limit 1");
    return rows[0] as { nx: number; ny: number } | undefined;
  });
  if (!site) {
    const note = "관측 지점이 설정되지 않았습니다";
    await upsertHeartbeat("forecast-tick", false, note);
    return { ok: false, saved: 0, note };
  }

  let fetched: Awaited<ReturnType<typeof fetchForecast>>;
  try {
    fetched = await fetchForecast(env("KMA_API_KEY")!, site.nx, site.ny, now, deps.fetchFn);
  } catch (e) {
    // **마지막 예보를 지우지 않는다.** 낡은 값을 "낡았다"고 말하며 보여주는
    // 것이, 아무것도 없어서 화면이 비는 것보다 낫다. fetched_at이 그대로
    // 남으므로 /api/forecast의 stale과 워치독의 warnings가 이 상태를 읽는다.
    const note = `예보 수집 실패: ${String(e)}`;
    console.error(`[forecast-tick] ${note}`);
    await upsertHeartbeat("forecast-tick", false, note);
    return { ok: false, saved: 0, note };
  }

  const saved = await withService(async (q) => {
    for (const r of fetched.rows) {
      await q.query(
        `insert into weather_forecasts
           (fcst_at, temp_c, pop_pct, pty, sky, pcp_mm, sno_cm, wsd_ms, reh_pct, tmn_c, tmx_c, base_at, fetched_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (fcst_at) do update set
           temp_c = excluded.temp_c, pop_pct = excluded.pop_pct, pty = excluded.pty,
           sky = excluded.sky, pcp_mm = excluded.pcp_mm, sno_cm = excluded.sno_cm,
           wsd_ms = excluded.wsd_ms, reh_pct = excluded.reh_pct,
           tmn_c = excluded.tmn_c, tmx_c = excluded.tmx_c,
           base_at = excluded.base_at, fetched_at = now()`,
        [r.fcstAt, r.tempC, r.popPct, r.pty, r.sky, r.pcpMm, r.snoCm, r.wsdMs, r.rehPct,
         r.tmnC, r.tmxC, fetched.baseAt],
      );
    }
    // 지난 예보는 남겨 둘 이유가 없다. 하루치만 남기는 이유는 "오늘 아침에
    // 뭐라고 했었나"를 확인할 여지를 두기 위해서다.
    await q.query("delete from weather_forecasts where fcst_at < now() - interval '1 day'");
    return fetched.rows.length;
  });

  await upsertHeartbeat("forecast-tick", true, null);
  return { ok: true, saved, note: null };
}
```

- [ ] **Step 6: 통과를 확인한다**

Run: `cd server && npx vitest run test/forecast-tick.test.ts && npm run typecheck`
Expected: PASS (7 tests) · 타입 오류 0

- [ ] **Step 7: 변이로 확인한다**

`catch` 블록에 `await withService((q) => q.query("delete from weather_forecasts"));`를 넣고 돌린다.
Expected: `수집이 실패해도 마지막 예보를 지우지 않는다`가 FAIL. 확인 후 **되돌린다.**

`on conflict (fcst_at) do update`를 `do nothing`으로 바꾸고 돌린다.
Expected: `같은 시각은 최신 발표로 덮는다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 8: 커밋**

```bash
git add db/migrations/0018_weather_forecasts.sql server/src/jobs/forecastTick.ts server/test/forecast-tick.test.ts
git commit -m "feat(server): 예보를 저장하고, 수집이 실패해도 마지막 값을 지키다"
```

---

### Task 3: 스케줄러 등록과 따라잡기 (`jobs/scheduler.ts`)

**Files:**
- Modify: `server/src/jobs/scheduler.ts`
- Test: `server/test/scheduler.test.ts` (기존 파일에 추가. 없으면 생성)

**Interfaces:**
- Consumes: `runForecastTick`(Task 2), `guarded`·`TIMEZONE` 패턴(같은 파일)
- Produces: `export async function catchUpForecastIfMissed(): Promise<boolean>`

- [ ] **Step 1: 실패 테스트를 쓴다**

```ts
// server/test/scheduler.test.ts 에 추가
import { describe, expect, it, beforeEach, vi } from "vitest";
import { withService } from "../src/db.ts";
import { catchUpForecastIfMissed } from "../src/jobs/scheduler.ts";
import * as forecastTick from "../src/jobs/forecastTick.ts";

describe("catchUpForecastIfMissed — 재시작으로 놓친 회차를 따라잡는다", () => {
  beforeEach(async () => {
    await withService((q) => q.query("delete from heartbeats where name = 'forecast-tick'"));
    vi.restoreAllMocks();
  });

  it("한 번도 안 돌았으면 수집한다", async () => {
    const spy = vi.spyOn(forecastTick, "runForecastTick")
      .mockResolvedValue({ ok: true, saved: 0, note: null });
    expect(await catchUpForecastIfMissed()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("방금 돌았으면 수집하지 않는다", async () => {
    await withService((q) =>
      q.query("insert into heartbeats (name, last_run_at, ok) values ('forecast-tick', now(), true)"));
    const spy = vi.spyOn(forecastTick, "runForecastTick")
      .mockResolvedValue({ ok: true, saved: 0, note: null });
    expect(await catchUpForecastIfMissed()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  // 발표 간격이 3시간이므로 3.5시간을 넘겼으면 최소 한 회차를 놓쳤다.
  it("3.5시간을 넘겼으면 수집한다", async () => {
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok)
               values ('forecast-tick', now() - interval '4 hours', true)`));
    const spy = vi.spyOn(forecastTick, "runForecastTick")
      .mockResolvedValue({ ok: true, saved: 0, note: null });
    expect(await catchUpForecastIfMissed()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd server && npx vitest run test/scheduler.test.ts`
Expected: FAIL — `catchUpForecastIfMissed is not a function`

- [ ] **Step 3: 구현한다**

`server/src/jobs/scheduler.ts` 상단 import에 추가:

```ts
import { runForecastTick } from "./forecastTick.ts";
```

`catchUpIfMissed` 바로 아래에 추가:

```ts
/** 예보 발표는 3시간 간격이다. 3.5시간이 지났다면 최소 한 회차를 놓쳤다. */
const FORECAST_STALE_MINUTES = 210;

/**
 * 관측의 catchUpIfMissed와 같은 처방·같은 이유(컨테이너 재시작·정전).
 *
 * "오래됐는가"의 계산을 Postgres 안에서 끝내는 것도 같다 — Node의 Date.now()로
 * 비교하면 컨테이너 시계와 DB 시계 두 개를 섞어 쓰게 되고, 이 프로젝트는 그
 * 실수를 계정 잠금 만료에서 이미 한 번 했다(2fc6b13).
 */
export async function catchUpForecastIfMissed(): Promise<boolean> {
  const stale = await withService(async (q) => {
    const { rows } = await q.query(
      `select coalesce(
         (select now() - last_run_at > ($1 || ' minutes')::interval
            from heartbeats where name = 'forecast-tick'),
         true
       ) as stale`,
      [String(FORECAST_STALE_MINUTES)],
    );
    return rows[0].stale as boolean;
  });
  if (stale) await runForecastTick();
  return stale;
}
```

`startScheduler()` 안, `watchdog` 등록 아래에 추가:

```ts
  // 단기예보 발표 시각(KST 02·05·08·11·14·17·20·23시)에 맞춘다. 매시 돌리면
  // 발표되지 않은 사이에 같은 값을 여덟 번 더 받는다 — 기상청 호출만 늘고
  // 얻는 것이 없다. 15분은 발표가 실제로 열릴 때까지의 여유다
  // (shared/forecast.ts의 PUBLISH_DELAY_MIN과 같은 이유).
  cron.schedule("15 2,5,8,11,14,17,20,23 * * *",
    () => guarded("forecast-tick", runForecastTick), { timezone: TIMEZONE });
```

`void guarded("catch-up", catchUpIfMissed);` 아래에 추가:

```ts
  void guarded("forecast-catch-up", catchUpForecastIfMissed);
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd server && npx vitest run test/scheduler.test.ts && npm run typecheck`
Expected: PASS · 타입 오류 0

- [ ] **Step 5: 커밋**

```bash
git add server/src/jobs/scheduler.ts server/test/scheduler.test.ts
git commit -m "feat(server): 예보 수집을 발표 시각에 맞춰 돌리고 놓친 회차를 따라잡는다"
```

---

### Task 4: `warnings` 칸을 나눈다 (`jobs/watchdog.ts`)

`reasons`는 지금 **전부 "특보가 사람에게 못 간다"**는 뜻이다. 예보가 죽어도 발송은 멀쩡하다.
같은 칸에 넣으면 진짜 사유가 묻히고, 아무 데도 안 넣으면 멈춘 것을 아무도 모른다.

**Files:**
- Modify: `server/src/jobs/watchdog.ts`
- Modify: `server/src/index.ts` (`/api/health/deep` — 응답 형태 확인만, 수정 불필요할 수 있음)
- Test: `server/test/watchdog.test.ts` (기존 파일에 describe 추가)

**Interfaces:**
- Consumes: `FORECAST_STALE_HOURS`(Task 2)
- Produces: `export type Health = { ok: boolean; reasons: string[]; warnings: string[] }`

- [ ] **Step 1: 실패 테스트를 쓴다**

```ts
// server/test/watchdog.test.ts 에 추가
import { FORECAST_STALE_HOURS } from "../src/jobs/forecastTick.ts";

describe("예보 수집 중단은 warnings이지 reasons가 아니다", () => {
  beforeEach(async () => {
    await withService(async (q) => {
      await q.query("delete from heartbeats where name = 'forecast-tick'");
      await q.query("delete from weather_forecasts");
    });
  });

  it("예보를 6시간 넘게 못 받았으면 warnings에 오른다", async () => {
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok)
               values ('forecast-tick', now() - interval '7 hours', true)`));
    const h = await health();
    expect(h.warnings.some((w) => /예보/.test(w))).toBe(true);
  });

  // **가장 중요한 줄.** warnings가 503을 만들면 예보(표시 기능)가 죽었다는
  // 이유로 "특보가 못 나간다"는 신호가 켜진다. 운영자가 잘못 읽는다.
  it("warnings는 reasons에 섞이지 않고 상태를 바꾸지 않는다", async () => {
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok)
               values ('forecast-tick', now() - interval '7 hours', true)`));
    const h = await health();
    expect(h.reasons.some((r) => /예보/.test(r))).toBe(false);
  });

  it("방금 받았으면 warnings가 비어 있다", async () => {
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok) values ('forecast-tick', now(), true)`));
    const h = await health();
    expect(h.warnings.some((w) => /예보/.test(w))).toBe(false);
  });

  it("기준은 forecastTick의 상수 하나를 쓴다", async () => {
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok)
               values ('forecast-tick', now() - interval '${FORECAST_STALE_HOURS - 1} hours', true)`));
    expect((await health()).warnings.some((w) => /예보/.test(w))).toBe(false);
  });

  // 워치독 문자는 "아무에게도 못 간다"를 알리는 자리다. 여기에 표시 기능의
  // 경고까지 섞으면 사람이 곧 전체를 무시하기 시작한다.
  it("워치독 문자에는 warnings를 싣지 않는다", async () => {
    await makeRecipient();
    await ensureGuideline();
    await withService((q) =>
      q.query(`insert into heartbeats (name, last_run_at, ok)
               values ('forecast-tick', now() - interval '7 hours', true)`));
    const { sent, channel } = recorder();
    await reportIfUnhealthy({ channel });
    for (const s of sent) expect(s.text).not.toMatch(/예보/);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd server && npx vitest run test/watchdog.test.ts`
Expected: FAIL — `h.warnings is undefined`

- [ ] **Step 3: 구현한다**

`server/src/jobs/watchdog.ts`에서 타입을 바꾼다:

```ts
/**
 * `reasons`와 `warnings`는 뜻이 다르다.
 *
 *  - `reasons`  — **특보가 사람에게 못 간다.** 하나라도 있으면 503이다.
 *  - `warnings` — 기능 하나가 죽었지만 발송은 살아 있다. **상태 코드를 바꾸지 않는다.**
 *
 * 예보 수집이 멈춘 것이 두 번째다. 사전 예고는 사라지지만 실제 특보는 그대로
 * 난다. reasons에 넣으면 진짜 사유가 묻히고, 아무 데도 안 넣으면 멈춘 것을
 * 아무도 모른다 — 이 프로젝트가 여섯 라운드 내내 고친 그 결함이다.
 */
export type Health = { ok: boolean; reasons: string[]; warnings: string[] };
```

`checkHealth` 안, `const reasons: string[] = [];` 바로 아래에 추가:

```ts
      const warnings: string[] = [];
```

`return { ok: reasons.length === 0, reasons };` 바로 위에 추가:

```ts
      // 예보 수집. reasons가 아니라 warnings다(위 타입 주석 참고).
      // 낡음 판정은 Postgres 안에서 끝낸다 — 시계를 하나만 쓴다.
      const { rows: fcstBeat } = await q.query(
        `select coalesce(
           (select now() - last_run_at > ($1 || ' hours')::interval
              from heartbeats where name = 'forecast-tick'),
           false
         ) as stale`,
        [String(FORECAST_STALE_HOURS)],
      );
      // 행이 아예 없으면(예보 기능을 아직 한 번도 안 돌린 배포) 경고하지 않는다.
      // 관측과 달리 예보는 없어도 특보가 정상 동작하므로, 설치 직후부터
      // 경고를 띄우면 새 배포가 항상 경고를 달고 시작한다.
      if (fcstBeat[0]?.stale === true) {
        warnings.push(
          `예보를 ${FORECAST_STALE_HOURS}시간 넘게 받지 못했습니다 — 사전 예고가 뜨지 않습니다 ` +
            `(특보 발송은 정상입니다)`,
        );
      }
```

`return`을 바꾼다:

```ts
      return { ok: reasons.length === 0, reasons, warnings };
```

파일 맨 아래 `catch` 블록의 반환도 바꾼다:

```ts
    return { ok: false, reasons: [`데이터베이스에 연결할 수 없습니다 (${String(e)})`], warnings: [] };
```

import에 추가:

```ts
import { FORECAST_STALE_HOURS } from "./forecastTick.ts";
```

- [ ] **Step 4: `reportIfUnhealthy`가 warnings를 싣지 않는지 확인한다**

`reportIfUnhealthy`가 `h.reasons`만 읽는지 확인한다. `h.warnings`를 문자 본문에 넣지 **않는다.**
(이미 `reasons`만 쓰고 있다면 수정할 것이 없다 — 확인만 하고 넘어간다.)

- [ ] **Step 5: 통과를 확인한다**

Run: `cd server && npx vitest run test/watchdog.test.ts && npm run typecheck`
Expected: PASS (기존 59 + 신규 5) · 타입 오류 0

- [ ] **Step 6: 변이로 확인한다**

`warnings.push(...)`를 `reasons.push(...)`로 바꾸고 돌린다.
Expected: `warnings는 reasons에 섞이지 않고 상태를 바꾸지 않는다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 7: 전체 스위트를 돌린다**

Run: `cd server && npx vitest run`
Expected: 기존 604 + 신규 전부 PASS. `Health` 타입을 쓰는 다른 곳이 깨지지 않았는지 본다.

- [ ] **Step 8: 커밋**

```bash
git add server/src/jobs/watchdog.ts server/test/watchdog.test.ts
git commit -m "feat(server): 못 가는 것과 안 보이는 것을 다른 칸에 담는다"
```

---

### Task 5: 예고 판정 (`forecastRules.ts`)

이 계획에서 **가장 조심할 파일**이다. 판정이 실제 특보와 어긋나면 배너가 거짓말을 한다.
순수 함수라 DB 없이 전부 테스트된다.

**Files:**
- Create: `server/src/forecastRules.ts`
- Test: `server/test/forecast-rules.test.ts`

**Interfaces:**
- Consumes: `thresholdUsable`·`CRITERIA_FIELDS`(`server/src/criteriaFields.ts`), `Kind`·`Grade`(`server/src/shared/types.ts`)
- Produces:
```ts
export type ForecastPoint = {
  fcstAt: Date; tempC: number | null; pcpMm: number | null; snoCm: number | null; wsdMs: number | null;
};
export type CriterionRow = { kind: Kind; grade: Grade; threshold: Record<string, number> };
export type SettingRow = { kind: Kind; enabled: boolean };
export type Upcoming = { kind: Kind; grade: Grade; at: Date; value: number; unit: string };
export function findUpcoming(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): Upcoming[];
export type ExceedMark = { at: Date; kind: Kind; grade: Grade };
export function markExceeds(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): ExceedMark[];
```

- [ ] **Step 1: 실패 테스트를 쓴다**

```ts
// server/test/forecast-rules.test.ts
import { describe, expect, it } from "vitest";
import { findUpcoming, type ForecastPoint, type CriterionRow, type SettingRow } from "../src/forecastRules.ts";

/** KST 시각으로 예보점을 만든다. */
function p(kstIso: string, v: Partial<ForecastPoint> = {}): ForecastPoint {
  return { fcstAt: new Date(kstIso), tempC: null, pcpMm: null, snoCm: null, wsdMs: null, ...v };
}
const ALL_ON: SettingRow[] = [
  { kind: "rain", enabled: true }, { kind: "snow", enabled: true },
  { kind: "wind", enabled: true }, { kind: "heat", enabled: true },
];
const CRITERIA: CriterionRow[] = [
  { kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20 } },
  { kind: "rain", grade: "warning", threshold: { rain_mm_per_hr: 50 } },
  { kind: "snow", grade: "watch", threshold: { snow_cm: 5 } },
  { kind: "snow", grade: "warning", threshold: { snow_cm: 20 } },
  { kind: "wind", grade: "watch", threshold: { wind_ms: 14 } },
  { kind: "wind", grade: "warning", threshold: { wind_ms: 21 } },
  { kind: "heat", grade: "watch", threshold: { temp_c: 33, feels_c: 31 } },
  { kind: "heat", grade: "warning", threshold: { temp_c: 35, feels_c: 33 } },
];

describe("findUpcoming — 임계 초과가 예상되는 시각", () => {
  it("임계를 넘지 않으면 아무것도 내지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 5 })], CRITERIA, ALL_ON)).toEqual([]);
  });

  it("시간당 강수량이 주의보 임계를 넘으면 잡는다", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 25 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("rain");
    expect(out[0]!.grade).toBe("watch");
    expect(out[0]!.value).toBe(25);
    expect(out[0]!.unit).toBe("mm");
  });

  // 경보를 넘는 예보에 주의보만 말하면 대비 수준이 낮아진다.
  it("경보까지 넘으면 경보를 고르고, 경보를 처음 넘는 시각을 쓴다", () => {
    const out = findUpcoming([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),   // 주의보만
      p("2026-09-07T13:00:00+09:00", { pcpMm: 60 }),   // 경보
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.grade).toBe("warning");
    expect(out[0]!.at.toISOString()).toBe("2026-09-07T04:00:00.000Z"); // 13시 KST
  });

  it("한 종류는 한 건만 낸다", () => {
    const out = findUpcoming([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 30 }),
      p("2026-09-07T12:00:00+09:00", { pcpMm: 40 }),
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
  });

  it("여러 종류는 이른 순으로 정렬한다", () => {
    const out = findUpcoming([
      p("2026-09-07T15:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T10:00:00+09:00", { wsdMs: 16 }),
    ], CRITERIA, ALL_ON);
    expect(out.map((u) => u.kind)).toEqual(["wind", "rain"]);
  });

  // 폭설은 실황이 **일 누적**으로 판정한다. 예보도 같은 기준이어야 한다 —
  // 시간당 값으로 비교하면 5cm 임계를 영영 넘지 않는다.
  it("폭설은 KST 하루 누적으로 판정한다", () => {
    const out = findUpcoming([
      p("2026-09-07T20:00:00+09:00", { snoCm: 2 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: 2 }),
      p("2026-09-07T22:00:00+09:00", { snoCm: 2 }),   // 누적 6cm → 여기서 넘는다
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("snow");
    expect(out[0]!.value).toBe(6);
    expect(out[0]!.unit).toBe("cm");
    expect(out[0]!.at.toISOString()).toBe("2026-09-07T13:00:00.000Z"); // 22시 KST
  });

  // **가장 중요한 줄.** UTC로 끊으면 하루가 9시간 어긋나 밤새 내린 눈이 두
  // 날에 쪼개진다. 이 프로젝트에서 시계 도메인 혼동은 세 번 재발했다.
  it("누적은 KST 자정에서 끊긴다", () => {
    const out = findUpcoming([
      p("2026-09-07T23:00:00+09:00", { snoCm: 4 }),
      p("2026-09-08T00:00:00+09:00", { snoCm: 4 }),   // 다른 날 → 누적 리셋
    ], CRITERIA, ALL_ON);
    expect(out).toEqual([]);
  });

  it("강풍은 풍속으로 판정한다", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { wsdMs: 22 })], CRITERIA, ALL_ON);
    expect(out[0]!.grade).toBe("warning");
    expect(out[0]!.unit).toBe("m/s");
  });

  // 예보에는 체감온도가 없다. 기온만으로 판정하고, 그래서 실제 특보와
  // 어긋날 수 있다 — 스펙 §3 함정 3.
  it("폭염은 기온만으로 판정한다", () => {
    const out = findUpcoming([p("2026-09-07T14:00:00+09:00", { tempC: 34 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
    expect(out[0]!.grade).toBe("watch");
    expect(out[0]!.unit).toBe("℃");
  });

  // 껐는데 예고가 뜨면 "예고가 떴으니 특보도 나겠지"가 된다.
  it("꺼둔 종류는 예고하지 않는다", () => {
    const off: SettingRow[] = [{ kind: "rain", enabled: false }, ...ALL_ON.slice(1)];
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, off)).toEqual([]);
  });

  it("알림 설정에 아예 없는 종류도 예고하지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, [])).toEqual([]);
  });

  // null은 "모른다"다. 0으로 보면 "안 온다"는 단언이 되고, 반대로 임계와
  // 비교하면 NaN 비교가 조용히 false가 된다.
  it("값이 null인 시각은 판정하지 않는다", () => {
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: null })], CRITERIA, ALL_ON)).toEqual([]);
  });

  it("null은 누적에서도 건너뛴다(0으로 세지 않는다)", () => {
    const out = findUpcoming([
      p("2026-09-07T20:00:00+09:00", { snoCm: 3 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: null }),
      p("2026-09-07T22:00:00+09:00", { snoCm: 3 }),   // 누적 6cm
    ], CRITERIA, ALL_ON);
    expect(out[0]!.value).toBe(6);
  });

  // 기준이 없는 종류를 판정하면 0과 비교하게 되어 언제나 초과가 된다.
  it("임계가 설정되지 않은 종류는 예고하지 않는다", () => {
    const bad: CriterionRow[] = [{ kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 0 } }];
    expect(findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 5 })], bad, ALL_ON)).toEqual([]);
  });

  it("임계와 같은 값도 초과로 본다(실황 판정과 같다)", () => {
    const out = findUpcoming([p("2026-09-07T10:00:00+09:00", { pcpMm: 20 })], CRITERIA, ALL_ON);
    expect(out).toHaveLength(1);
  });
});

// 스트립은 "몇 시가 임계를 넘는가"를 시각마다 칠해야 한다. 그 판정도 서버가
// 한다 — 화면이 임계와 비교하기 시작하면 배너와 스트립과 실제 특보가 각자
// 다른 기준을 갖게 된다.
describe("markExceeds — 시각마다의 초과 표시", () => {
  it("넘는 시각을 모두 낸다(findUpcoming과 달리 첫 건만이 아니다)", () => {
    const out = markExceeds([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 30 }),
      p("2026-09-07T12:00:00+09:00", { pcpMm: 5 }),
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.kind === "rain")).toBe(true);
  });

  it("그 시각에 해당하는 가장 높은 등급을 쓴다", () => {
    const out = markExceeds([
      p("2026-09-07T10:00:00+09:00", { pcpMm: 25 }),
      p("2026-09-07T11:00:00+09:00", { pcpMm: 60 }),
    ], CRITERIA, ALL_ON);
    expect(out.map((m) => m.grade)).toEqual(["watch", "warning"]);
  });

  it("폭설은 누적으로 표시하므로 한 번 넘으면 그날 내내 표시된다", () => {
    const out = markExceeds([
      p("2026-09-07T20:00:00+09:00", { snoCm: 3 }),
      p("2026-09-07T21:00:00+09:00", { snoCm: 3 }),   // 누적 6cm
      p("2026-09-07T22:00:00+09:00", { snoCm: 0 }),   // 누적 그대로 6cm
    ], CRITERIA, ALL_ON);
    expect(out).toHaveLength(2);
  });

  it("꺼둔 종류는 표시하지 않는다", () => {
    const off: SettingRow[] = [{ kind: "rain", enabled: false }, ...ALL_ON.slice(1)];
    expect(markExceeds([p("2026-09-07T10:00:00+09:00", { pcpMm: 60 })], CRITERIA, off)).toEqual([]);
  });

  it("값이 null인 시각은 표시하지 않는다", () => {
    expect(markExceeds([p("2026-09-07T10:00:00+09:00", { pcpMm: null })], CRITERIA, ALL_ON)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd server && npx vitest run test/forecast-rules.test.ts`
Expected: FAIL — `Failed to resolve import "../src/forecastRules.ts"`

- [ ] **Step 3: 구현한다**

```ts
// server/src/forecastRules.ts
// 예보에서 "임계를 넘을 것으로 보이는 가장 이른 시각"을 찾는다.
//
// **임계값은 weather_criteria 하나만 읽는다.** 예고 전용 임계를 따로 두면
// 배너가 말하는 기준과 실제로 특보가 나는 기준이 갈라지고, 그 순간 배너는
// 거짓말이 된다. 그래서 이 파일에는 숫자가 하나도 없다.
//
// 이 파일은 순수 함수다 — DB도 네트워크도 없다. 판정은 여기 한 곳에만 있고
// 화면은 결과만 받는다(phone.ts의 notifiable과 같은 선례).
import { thresholdUsable } from "./criteriaFields.ts";
import type { Kind, Grade } from "./shared/types.ts";

export type ForecastPoint = {
  fcstAt: Date;
  tempC: number | null; pcpMm: number | null; snoCm: number | null; wsdMs: number | null;
};
export type CriterionRow = { kind: Kind; grade: Grade; threshold: Record<string, number> };
export type SettingRow = { kind: Kind; enabled: boolean };
export type Upcoming = { kind: Kind; grade: Grade; at: Date; value: number; unit: string };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 그 시각이 속한 **KST 날짜** 키. UTC로 끊으면 하루가 9시간 어긋나
 *  밤새 내린 눈이 두 날에 쪼개진다. */
function kstDayKey(d: Date): string {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 종류마다 "무엇을 비교하는가". 폭설만 누적이고 나머지는 그 시각 값이다. */
const FIELD: Record<Kind, { unit: string; pick: (p: ForecastPoint) => number | null; key: string }> = {
  rain: { unit: "mm",  pick: (p) => p.pcpMm, key: "rain_mm_per_hr" },
  snow: { unit: "cm",  pick: (p) => p.snoCm, key: "snow_cm" },
  wind: { unit: "m/s", pick: (p) => p.wsdMs, key: "wind_ms" },
  // 예보에는 체감온도가 없다. 실황 판정은 기온·체감 둘 다 보므로 여기서는
  // 기온만으로 판정하고, 그래서 예고와 실제 특보가 어긋날 수 있다.
  heat: { unit: "℃",  pick: (p) => p.tempC, key: "temp_c" },
};

const KINDS: Kind[] = ["rain", "snow", "wind", "heat"];
/** 낮은 등급부터. 뒤에 오는 것이 더 높은 등급이다. */
const GRADES: Grade[] = ["watch", "warning"];

export function findUpcoming(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): Upcoming[] {
  const sorted = [...points].sort((a, b) => a.fcstAt.getTime() - b.fcstAt.getTime());
  const out: Upcoming[] = [];

  for (const kind of KINDS) {
    // 꺼둔 종류를 예고하면 "예고가 떴으니 특보도 나겠지"가 된다.
    // 설정 행이 아예 없는 것도 켜져 있지 않은 것이다.
    if (!settings.find((s) => s.kind === kind)?.enabled) continue;

    const field = FIELD[kind];
    // 폭설만 KST 하루 누적으로 본다 — 실황 판정이 그렇게 하기 때문이다.
    // 기준이 갈라지면 "예고는 떴는데 특보는 안 난다"가 생긴다.
    const series: { at: Date; value: number }[] = [];
    if (kind === "snow") {
      const accum = new Map<string, number>();
      for (const p of sorted) {
        const v = field.pick(p);
        if (v === null) continue;   // null은 "모른다"다. 0으로 세지 않는다.
        const day = kstDayKey(p.fcstAt);
        const next = (accum.get(day) ?? 0) + v;
        accum.set(day, next);
        series.push({ at: p.fcstAt, value: next });
      }
    } else {
      for (const p of sorted) {
        const v = field.pick(p);
        if (v === null) continue;
        series.push({ at: p.fcstAt, value: v });
      }
    }
    if (series.length === 0) continue;

    // 가장 높은 등급부터 본다. 경보를 넘는데 주의보만 말하면 대비가 낮아진다.
    let hit: { grade: Grade; at: Date; value: number } | null = null;
    for (let i = GRADES.length - 1; i >= 0; i--) {
      const grade = GRADES[i]!;
      const crit = criteria.find((c) => c.kind === kind && c.grade === grade);
      // 기준이 없거나 0 이하이면 판정하지 않는다 — 0과 비교하면 모든 값이
      // 초과가 되어 항상 예고가 뜬다(criteriaFields.ts의 같은 처방).
      if (!crit || !thresholdUsable(kind, crit.threshold)) continue;
      const th = crit.threshold[field.key];
      if (th === undefined) continue;
      const first = series.find((s) => s.value >= th);
      if (first) { hit = { grade, at: first.at, value: first.value }; break; }
    }
    if (hit) out.push({ kind, grade: hit.grade, at: hit.at, value: hit.value, unit: field.unit });
  }

  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export type ExceedMark = { at: Date; kind: Kind; grade: Grade };

/**
 * 시각마다 "무엇을 넘는가"를 낸다. `findUpcoming`이 종류당 첫 건만 내는 것과
 * 다르다 — 스트립은 넘는 구간 전체를 칠해야 한다.
 *
 * 판정 자체는 위와 완전히 같은 계산을 쓴다(같은 필드·같은 누적·같은
 * thresholdUsable). 두 함수가 다른 답을 내면 배너와 스트립이 어긋난다.
 */
export function markExceeds(
  points: ForecastPoint[], criteria: CriterionRow[], settings: SettingRow[],
): ExceedMark[] {
  const marks: ExceedMark[] = [];
  for (const kind of KINDS) {
    if (!settings.find((s) => s.kind === kind)?.enabled) continue;
    const field = FIELD[kind];
    const usable = GRADES
      .map((grade) => {
        const crit = criteria.find((c) => c.kind === kind && c.grade === grade);
        if (!crit || !thresholdUsable(kind, crit.threshold)) return null;
        const th = crit.threshold[field.key];
        return th === undefined ? null : { grade, th };
      })
      .filter((x): x is { grade: Grade; th: number } => x !== null);
    if (usable.length === 0) continue;

    const sorted = [...points].sort((a, b) => a.fcstAt.getTime() - b.fcstAt.getTime());
    const accum = new Map<string, number>();
    for (const p of sorted) {
      const v = field.pick(p);
      if (v === null) continue;
      let value = v;
      if (kind === "snow") {
        const day = kstDayKey(p.fcstAt);
        value = (accum.get(day) ?? 0) + v;
        accum.set(day, value);
      }
      // 가장 높은 등급부터 본다.
      for (let i = usable.length - 1; i >= 0; i--) {
        const u = usable[i]!;
        if (value >= u.th) { marks.push({ at: p.fcstAt, kind, grade: u.grade }); break; }
      }
    }
  }
  return marks.sort((a, b) => a.at.getTime() - b.at.getTime());
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd server && npx vitest run test/forecast-rules.test.ts && npm run typecheck`
Expected: PASS (15 tests) · 타입 오류 0

- [ ] **Step 5: 변이 4개로 확인한다**

각각 바꾼 뒤 테스트를 돌리고, FAIL을 확인한 다음 **되돌린다.**

| 변이 | 기대 |
|---|---|
| `kstDayKey`의 `+ KST_OFFSET_MS`를 지운다 | `누적은 KST 자정에서 끊긴다` FAIL |
| 등급 루프를 `for (let i = 0; i < GRADES.length; i++)`로 바꾼다 | `경보까지 넘으면 경보를 고르고…` FAIL |
| `if (!settings.find(...)?.enabled) continue;`를 지운다 | `꺼둔 종류는 예고하지 않는다` FAIL |
| `if (v === null) continue;`를 `const v2 = v ?? 0`으로 바꾼다 | `null은 누적에서도 건너뛴다` FAIL |
| `markExceeds`의 등급 루프를 오름차순으로 바꾼다 | `그 시각에 해당하는 가장 높은 등급을 쓴다` FAIL |

**변이가 살아남으면 코드가 아니라 테스트를 고친다.**

- [ ] **Step 6: 커밋**

```bash
git add server/src/forecastRules.ts server/test/forecast-rules.test.ts
git commit -m "feat(server): 예보가 특보 기준을 언제 넘는지 판정한다"
```

---

### Task 6: 일별 요약과 API (`forecastSummary.ts` + `api/forecast.ts`)

**Files:**
- Create: `server/src/forecastSummary.ts`
- Create: `server/src/api/forecast.ts`
- Modify: `server/src/index.ts`
- Test: `server/test/forecast-summary.test.ts`
- Test: `server/test/forecast-api.test.ts`

**Interfaces:**
- Consumes: `findUpcoming`·`ForecastPoint`(Task 5), `FORECAST_STALE_HOURS`(Task 2), `withUser`(`server/src/db.ts`), `requireAuth`(`server/src/auth/middleware.ts`)
- Produces:
```ts
// forecastSummary.ts
export type DailyPoint = ForecastPoint & { popPct: number | null; sky: number | null;
                                           tmnC: number | null; tmxC: number | null };
export type DailySummary = {
  date: string; tmn_c: number | null; tmx_c: number | null; pop_max: number | null;
  pcp_sum: number | null; sno_sum: number | null; sky: number | null; derived: boolean;
};
export function summarizeDaily(points: DailyPoint[]): DailySummary[];
// 반환 필드는 **snake_case다.** 이 값이 그대로 API 응답의 daily가 되는데,
// 같은 응답의 hourly가 snake_case(temp_c…)라 섞이면 화면이 두 규약을 외워야 한다.

// api/forecast.ts
export const forecastRouter: Router;   // GET /api/forecast
// hourly의 각 항목에는 그 시각이 넘는 임계가 함께 실린다:
//   exceeds: { kind: Kind; grade: Grade }[]
```

- [ ] **Step 1: 일별 요약의 실패 테스트를 쓴다**

```ts
// server/test/forecast-summary.test.ts
import { describe, expect, it } from "vitest";
import { summarizeDaily, type DailyPoint } from "../src/forecastSummary.ts";

function d(kstIso: string, v: Partial<DailyPoint> = {}): DailyPoint {
  return {
    fcstAt: new Date(kstIso), tempC: null, pcpMm: null, snoCm: null, wsdMs: null,
    popPct: null, sky: null, tmnC: null, tmxC: null, ...v,
  };
}

describe("summarizeDaily", () => {
  it("KST 날짜로 묶는다", () => {
    const out = summarizeDaily([
      d("2026-09-07T23:00:00+09:00", { tempC: 18 }),
      d("2026-09-08T00:00:00+09:00", { tempC: 17 }),
    ]);
    expect(out.map((x) => x.date)).toEqual(["2026-09-07", "2026-09-08"]);
  });

  it("기상청이 준 TMN·TMX를 우선 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { tempC: 20, tmnC: 16 }),
      d("2026-09-07T15:00:00+09:00", { tempC: 25, tmxC: 27 }),
    ]);
    expect(out[0]!.tmn_c).toBe(16);
    expect(out[0]!.tmx_c).toBe(27);
    expect(out[0]!.derived).toBe(false);
  });

  // TMN·TMX는 하루 중 특정 시각에만 온다. 없는 날은 시간별 기온으로 대신하되
  // 그 사실을 derived로 남긴다 — 어긋남을 조사할 때 필요하다.
  it("TMN·TMX가 없으면 시간별 기온의 최소·최대로 대신하고 derived로 표시한다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { tempC: 18 }),
      d("2026-09-07T15:00:00+09:00", { tempC: 26 }),
    ]);
    expect(out[0]!.tmn_c).toBe(18);
    expect(out[0]!.tmx_c).toBe(26);
    expect(out[0]!.derived).toBe(true);
  });

  it("강수확률은 그 날 최대를 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { popPct: 20 }),
      d("2026-09-07T15:00:00+09:00", { popPct: 80 }),
    ]);
    expect(out[0]!.pop_max).toBe(80);
  });

  it("강수·적설은 그 날 합이다", () => {
    const out = summarizeDaily([
      d("2026-09-07T06:00:00+09:00", { pcpMm: 3, snoCm: 1 }),
      d("2026-09-07T15:00:00+09:00", { pcpMm: 4, snoCm: 2 }),
    ]);
    expect(out[0]!.pcp_sum).toBe(7);
    expect(out[0]!.sno_sum).toBe(3);
  });

  // 값이 하나도 없으면 0이 아니라 null이다. 0은 "안 온다"는 단언이다.
  it("값이 하나도 없는 항목은 0이 아니라 null이다", () => {
    const out = summarizeDaily([d("2026-09-07T06:00:00+09:00", { tempC: 18 })]);
    expect(out[0]!.pcp_sum).toBeNull();
    expect(out[0]!.sno_sum).toBeNull();
    expect(out[0]!.pop_max).toBeNull();
  });

  // 새벽까지 넣으면 맑은 날이 흐림으로 뒤집힌다. 사람이 "그날 날씨"라고
  // 말할 때 뜻하는 구간은 낮이다.
  it("대표 하늘상태는 09~18시(KST) 최빈값이다", () => {
    const out = summarizeDaily([
      d("2026-09-07T03:00:00+09:00", { sky: 4 }),
      d("2026-09-07T04:00:00+09:00", { sky: 4 }),
      d("2026-09-07T05:00:00+09:00", { sky: 4 }),
      d("2026-09-07T10:00:00+09:00", { sky: 1 }),
      d("2026-09-07T13:00:00+09:00", { sky: 1 }),
      d("2026-09-07T16:00:00+09:00", { sky: 3 }),
    ]);
    expect(out[0]!.sky).toBe(1);
  });

  it("최빈값이 동률이면 더 흐린 쪽을 쓴다", () => {
    const out = summarizeDaily([
      d("2026-09-07T10:00:00+09:00", { sky: 1 }),
      d("2026-09-07T16:00:00+09:00", { sky: 4 }),
    ]);
    expect(out[0]!.sky).toBe(4);
  });

  it("낮 시간대 값이 없으면 하늘상태는 null이다", () => {
    const out = summarizeDaily([d("2026-09-07T03:00:00+09:00", { sky: 4 })]);
    expect(out[0]!.sky).toBeNull();
  });

  it("날짜 오름차순이다", () => {
    const out = summarizeDaily([
      d("2026-09-09T10:00:00+09:00", { tempC: 1 }),
      d("2026-09-07T10:00:00+09:00", { tempC: 2 }),
    ]);
    expect(out.map((x) => x.date)).toEqual(["2026-09-07", "2026-09-09"]);
  });
});
```

- [ ] **Step 2: 실패를 확인한 뒤 구현한다**

Run: `cd server && npx vitest run test/forecast-summary.test.ts` → FAIL

```ts
// server/src/forecastSummary.ts
// 시간별 예보를 "그 날 하루"로 접는다. 판정은 하지 않는다 —
// 임계 비교는 forecastRules.ts 하나에만 있다.
import type { ForecastPoint } from "./forecastRules.ts";

export type DailyPoint = ForecastPoint & {
  popPct: number | null; sky: number | null; tmnC: number | null; tmxC: number | null;
};

export type DailySummary = {
  date: string;               // YYYY-MM-DD (KST)
  tmn_c: number | null; tmx_c: number | null;
  pop_max: number | null; pcp_sum: number | null; sno_sum: number | null;
  sky: number | null;
  /** 최저·최고를 기상청 값이 아니라 시간별 기온에서 유도했는가. */
  derived: boolean;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 사람이 "그날 날씨"라고 할 때 뜻하는 구간. 새벽을 넣으면 맑은 날이 흐림이 된다. */
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 18;
/** 흐린 정도. 동률일 때 더 흐린 쪽을 고른다. */
const SKY_CLOUDINESS: Record<number, number> = { 1: 0, 3: 1, 4: 2 };

function kstParts(d: Date): { date: string; hour: number } {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return { date: k.toISOString().slice(0, 10), hour: k.getUTCHours() };
}

/** 값이 하나도 없으면 null. 0을 돌려주면 "없다"가 "0이다"라는 단언이 된다. */
function sum(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}
function max(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.max(...nums);
}
function min(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : Math.min(...nums);
}

export function summarizeDaily(points: DailyPoint[]): DailySummary[] {
  const byDay = new Map<string, DailyPoint[]>();
  for (const p of points) {
    const { date } = kstParts(p.fcstAt);
    const bucket = byDay.get(date);
    if (bucket) bucket.push(p); else byDay.set(date, [p]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, ps]) => {
      const givenMin = min(ps.map((p) => p.tmnC));
      const givenMax = max(ps.map((p) => p.tmxC));
      const derived = givenMin === null || givenMax === null;

      // 낮 시간대의 하늘상태 최빈값. 동률이면 더 흐린 쪽.
      const daySkies = ps
        .filter((p) => { const h = kstParts(p.fcstAt).hour;
                         return h >= DAY_START_HOUR && h <= DAY_END_HOUR; })
        .map((p) => p.sky)
        .filter((s): s is number => s !== null);
      let sky: number | null = null;
      if (daySkies.length > 0) {
        const count = new Map<number, number>();
        for (const s of daySkies) count.set(s, (count.get(s) ?? 0) + 1);
        sky = [...count.entries()].sort(
          (a, b) => b[1] - a[1] || (SKY_CLOUDINESS[b[0]] ?? 0) - (SKY_CLOUDINESS[a[0]] ?? 0),
        )[0]![0];
      }

      // snake_case인 이유는 위 타입 주석 참고 — 이 값이 그대로 API의 daily가 된다.
      return {
        date,
        tmn_c: givenMin ?? min(ps.map((p) => p.tempC)),
        tmx_c: givenMax ?? max(ps.map((p) => p.tempC)),
        pop_max: max(ps.map((p) => p.popPct)),
        pcp_sum: sum(ps.map((p) => p.pcpMm)),
        sno_sum: sum(ps.map((p) => p.snoCm)),
        sky,
        derived,
      };
    });
}
```

Run: `cd server && npx vitest run test/forecast-summary.test.ts` → PASS (10 tests)

- [ ] **Step 3: API의 실패 테스트를 쓴다**

```ts
// server/test/forecast-api.test.ts
import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/index.ts";
import { withService } from "../src/db.ts";
// 로그인 세션을 만드는 기존 헬퍼를 그대로 쓴다. 파일 위치·이름은
// server/test/ 안의 다른 API 테스트(예: org.test.ts)에서 확인하고 맞춘다.
import { signUpAndLogin } from "./helpers.ts";

process.env.SMS_PROVIDER = "";

beforeEach(async () => {
  await withService(async (q) => {
    await q.query("delete from weather_forecasts");
    await q.query("delete from heartbeats where name = 'forecast-tick'");
  });
});

async function seed(rows: { at: string; temp?: number; pcp?: number; sno?: number; pop?: number; sky?: number }[]) {
  await withService(async (q) => {
    for (const r of rows) {
      await q.query(
        `insert into weather_forecasts (fcst_at, temp_c, pcp_mm, sno_cm, pop_pct, sky, base_at, fetched_at)
         values ($1,$2,$3,$4,$5,$6, now(), now())`,
        [new Date(r.at), r.temp ?? null, r.pcp ?? null, r.sno ?? null, r.pop ?? null, r.sky ?? null],
      );
    }
    await q.query("insert into heartbeats (name, last_run_at, ok) values ('forecast-tick', now(), true)");
  });
}

describe("GET /api/forecast", () => {
  it("로그인하지 않으면 401이다", async () => {
    await request(app).get("/api/forecast").expect(401);
  });

  it("시간별과 일별을 함께 내려준다", async () => {
    const agent = await signUpAndLogin();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), temp: 20, pop: 30, sky: 1 }]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.stale).toBe(false);
  });

  // 지난 예보를 내려주면 화면의 스트립이 과거부터 시작한다.
  it("지난 시각은 내려주지 않는다", async () => {
    const agent = await signUpAndLogin();
    await seed([
      { at: new Date(Date.now() - 3600e3).toISOString(), temp: 18 },
      { at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
  });

  it("시간별은 48시간까지만 내려준다", async () => {
    const agent = await signUpAndLogin();
    await seed([
      { at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 },
      { at: new Date(Date.now() + 72 * 3600e3).toISOString(), temp: 15 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toHaveLength(1);
    // 일별은 48시간 밖까지 포함한다 — 5일 요약을 그려야 한다.
    expect(res.body.daily.length).toBeGreaterThan(1);
  });

  // 판정은 서버가 한다. 화면에 임계 비교가 들어가면 두 화면이 갈라진다.
  it("예고 판정 결과를 함께 내려준다", async () => {
    const agent = await signUpAndLogin();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), pcp: 60 }]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.upcoming[0].kind).toBe("rain");
  });

  // 화면이 스스로 시간을 재면 두 화면의 기준이 갈라진다(notifiable과 같은 이유).
  it("낡음 판정을 서버가 내려준다", async () => {
    const agent = await signUpAndLogin();
    await seed([{ at: new Date(Date.now() + 3600e3).toISOString(), temp: 20 }]);
    await withService((q) =>
      q.query(`update heartbeats set last_run_at = now() - interval '7 hours' where name = 'forecast-tick'`));
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.stale).toBe(true);
  });

  // 스트립이 어느 칸을 칠할지 화면이 스스로 정하면, 배너·스트립·실제 특보가
  // 각자 다른 기준을 갖게 된다.
  it("시각마다 무엇을 넘는지 함께 내려준다", async () => {
    const agent = await signUpAndLogin();
    await seed([
      { at: new Date(Date.now() + 3600e3).toISOString(), pcp: 25 },
      { at: new Date(Date.now() + 7200e3).toISOString(), pcp: 5 },
    ]);
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly[0].exceeds).toEqual([{ kind: "rain", grade: "watch" }]);
    expect(res.body.hourly[1].exceeds).toEqual([]);
  });

  it("예보가 하나도 없으면 빈 배열을 준다", async () => {
    const agent = await signUpAndLogin();
    const res = await agent.get("/api/forecast").expect(200);
    expect(res.body.hourly).toEqual([]);
    expect(res.body.daily).toEqual([]);
    expect(res.body.upcoming).toEqual([]);
  });
});
```

- [ ] **Step 4: 실패를 확인한 뒤 API를 구현한다**

Run: `cd server && npx vitest run test/forecast-api.test.ts` → FAIL (404)

```ts
// server/src/api/forecast.ts
// 두 화면(일반 대시보드·월보드)이 같은 응답을 쓴다. 판정과 낡음은 여기서
// 끝내고 화면은 결과만 받는다 — phone.ts의 notifiable과 같은 선례다.
import { Router } from "express";
import { withUser } from "../db.ts";
import { requireAuth } from "../auth/middleware.ts";
import { findUpcoming, markExceeds, type CriterionRow, type SettingRow } from "../forecastRules.ts";
import { summarizeDaily, type DailyPoint } from "../forecastSummary.ts";
import { FORECAST_STALE_HOURS } from "../jobs/forecastTick.ts";

export const forecastRouter = Router();
forecastRouter.use(requireAuth);

/** 스트립이 그리는 구간. 일별 요약은 이 창 밖까지 본다. */
const HOURLY_WINDOW_HOURS = 48;

forecastRouter.get("/forecast", async (req, res) => {
  const out = await withUser(req.user!.accountId, async (q) => {
    // 지난 예보는 빼고 지금부터 앞만 본다. 낡음 판정도 Postgres 안에서
    // 끝낸다 — Node와 DB 두 시계를 섞지 않는다.
    const { rows } = await q.query(
      `select fcst_at, temp_c, pop_pct, pty, sky, pcp_mm, sno_cm, wsd_ms, reh_pct,
              tmn_c, tmx_c, base_at, fetched_at
         from weather_forecasts
        where fcst_at >= date_trunc('hour', now())
        order by fcst_at`,
    );
    const { rows: criteria } = await q.query("select kind, grade, threshold from weather_criteria");
    const { rows: settings } = await q.query("select kind, enabled from alert_settings");
    const { rows: staleRow } = await q.query(
      `select coalesce(
         (select now() - last_run_at > ($1 || ' hours')::interval
            from heartbeats where name = 'forecast-tick'),
         false
       ) as stale`,
      [String(FORECAST_STALE_HOURS)],
    );
    return { rows, criteria, settings, stale: staleRow[0].stale as boolean };
  });

  const points: DailyPoint[] = out.rows.map((r: any) => ({
    fcstAt: new Date(r.fcst_at),
    tempC: r.temp_c === null ? null : Number(r.temp_c),
    pcpMm: r.pcp_mm === null ? null : Number(r.pcp_mm),
    snoCm: r.sno_cm === null ? null : Number(r.sno_cm),
    wsdMs: r.wsd_ms === null ? null : Number(r.wsd_ms),
    popPct: r.pop_pct === null ? null : Number(r.pop_pct),
    sky: r.sky === null ? null : Number(r.sky),
    tmnC: r.tmn_c === null ? null : Number(r.tmn_c),
    tmxC: r.tmx_c === null ? null : Number(r.tmx_c),
  }));

  // 시각별 초과 표시. **판정은 전부 여기서 끝난다** — 화면은 칠할지 말지만 받는다.
  // 누적으로 판정하는 폭설 때문에 전체 예보로 계산한 뒤 창을 자른다.
  const marks = markExceeds(points, out.criteria as CriterionRow[], out.settings as SettingRow[]);
  const marksAt = new Map<number, { kind: string; grade: string }[]>();
  for (const m of marks) {
    const k = m.at.getTime();
    const bucket = marksAt.get(k);
    if (bucket) bucket.push({ kind: m.kind, grade: m.grade });
    else marksAt.set(k, [{ kind: m.kind, grade: m.grade }]);
  }

  const cutoff = Date.now() + HOURLY_WINDOW_HOURS * 3600e3;
  const hourly = out.rows
    .filter((r: any) => new Date(r.fcst_at).getTime() <= cutoff)
    .map((r: any) => ({
      at: r.fcst_at, temp_c: r.temp_c === null ? null : Number(r.temp_c),
      pop_pct: r.pop_pct === null ? null : Number(r.pop_pct),
      pty: r.pty === null ? null : Number(r.pty),
      sky: r.sky === null ? null : Number(r.sky),
      pcp_mm: r.pcp_mm === null ? null : Number(r.pcp_mm),
      sno_cm: r.sno_cm === null ? null : Number(r.sno_cm),
      wsd_ms: r.wsd_ms === null ? null : Number(r.wsd_ms),
      exceeds: marksAt.get(new Date(r.fcst_at).getTime()) ?? [],
    }));

  // 예고 판정은 48시간 창이 아니라 **받은 예보 전체**로 한다. 내일모레
  // 폭설이 예상되는데 창 밖이라 말하지 않으면 미리 준비할 시간을 잃는다.
  const upcoming = findUpcoming(
    points,
    out.criteria as CriterionRow[],
    out.settings as SettingRow[],
  ).map((u) => ({ kind: u.kind, grade: u.grade, at: u.at.toISOString(), value: u.value, unit: u.unit }));

  res.json({
    fetched_at: out.rows[0]?.fetched_at ?? null,
    base_at: out.rows[0]?.base_at ?? null,
    stale: out.stale,
    hourly,
    daily: summarizeDaily(points),
    upcoming,
  });
});
```

`server/src/index.ts`에 등록한다 — **`app.use("/api", contentRouter);` 바로 아래**:

```ts
app.use("/api", forecastRouter);
```

import도 추가한다:

```ts
import { forecastRouter } from "./api/forecast.ts";
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd server && npx vitest run test/forecast-api.test.ts && npm run typecheck`
Expected: PASS (7 tests) · 타입 오류 0

- [ ] **Step 6: 전체 스위트를 돌린다**

Run: `cd server && npx vitest run`
Expected: 전건 PASS. 특히 `static.test.ts`(라우터 등록 순서)가 깨지지 않았는지 본다.

- [ ] **Step 7: 커밋**

```bash
git add server/src/forecastSummary.ts server/src/api/forecast.ts server/src/index.ts \
        server/test/forecast-summary.test.ts server/test/forecast-api.test.ts
git commit -m "feat(server): 예보를 하루 단위로 접고 한 엔드포인트로 내보낸다"
```

---

### Task 7: 웹 조회와 하늘 아이콘 (`lib/api/forecast.ts`, `lib/weatherIcon.ts`)

**Files:**
- Create: `apps/web/src/lib/api/forecast.ts`
- Create: `apps/web/src/lib/weatherIcon.ts`
- Test: `apps/web/src/lib/__tests__/weatherIcon.test.ts`
- Test: `apps/web/src/lib/api/__tests__/forecast.test.ts`

**Interfaces:**
- Consumes: `apiGet`(`apps/web/src/lib/api/client.ts`), Task 6의 응답 형태
- Produces:
```ts
export type ForecastHour = { at: string; temp_c: number|null; pop_pct: number|null; pty: number|null;
                             sky: number|null; pcp_mm: number|null; sno_cm: number|null; wsd_ms: number|null;
                             exceeds: { kind: Kind; grade: Grade }[] };
export type ForecastDay = { date: string; tmn_c: number|null; tmx_c: number|null; pop_max: number|null;
                            pcp_sum: number|null; sno_sum: number|null; sky: number|null; derived: boolean };
export type UpcomingRow = { kind: Kind; grade: Grade; at: string; value: number; unit: string };
export type ForecastResponse = { fetched_at: string|null; base_at: string|null; stale: boolean;
                                 hourly: ForecastHour[]; daily: ForecastDay[]; upcoming: UpcomingRow[] };
export const forecast: () => Promise<ForecastResponse>;
export type SkyLook = { key: string; glyph: string; label: string };
export function skyLook(sky: number|null, pty: number|null): SkyLook;
```

- [ ] **Step 1: 아이콘 테스트를 쓴다**

```ts
// apps/web/src/lib/__tests__/weatherIcon.test.ts
import { describe, expect, it } from "vitest";
import { skyLook } from "../weatherIcon";

describe("skyLook", () => {
  it("강수형태가 하늘상태보다 앞선다", () => {
    // 하늘이 맑아도 비가 온다면 비다.
    expect(skyLook(1, 1).key).toBe("rain");
    expect(skyLook(1, 3).key).toBe("snow");
    expect(skyLook(1, 2).key).toBe("sleet");
    expect(skyLook(1, 4).key).toBe("shower");
  });

  it("강수가 없으면 하늘상태를 쓴다", () => {
    expect(skyLook(1, 0).key).toBe("clear");
    expect(skyLook(3, 0).key).toBe("partly");
    expect(skyLook(4, 0).key).toBe("cloudy");
  });

  it("모르는 값은 unknown이고 글리프가 비어 있지 않다", () => {
    expect(skyLook(null, null).key).toBe("unknown");
    expect(skyLook(99, 99).key).toBe("unknown");
    expect(skyLook(null, null).glyph).not.toBe("");
  });

  // 화면에 아이콘만 있으면 색각·저시력 사용자에게 아무 정보도 아니다.
  it("모든 경우에 한글 라벨이 있다", () => {
    for (const [sky, pty] of [[1, 0], [3, 0], [4, 0], [1, 1], [1, 2], [1, 3], [1, 4], [null, null]] as const) {
      expect(skyLook(sky, pty).label.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한 뒤 구현한다**

Run: `cd apps/web && npx vitest run src/lib/__tests__/weatherIcon.test.ts` → FAIL

```ts
// apps/web/src/lib/weatherIcon.ts
// 기상청 SKY(하늘상태)·PTY(강수형태)를 화면에 쓸 글리프와 라벨로 바꾼다.
//
// label을 함께 돌려주는 이유: 아이콘만 그리면 색각·저시력 사용자에게 아무
// 정보도 아니다. 컴포넌트는 글리프를 aria-hidden으로 두고 라벨을 읽게 한다.
export type SkyLook = { key: string; glyph: string; label: string };

/** PTY 0=없음 1=비 2=비/눈 3=눈 4=소나기 */
const BY_PTY: Record<number, SkyLook> = {
  1: { key: "rain",   glyph: "🌧", label: "비" },
  2: { key: "sleet",  glyph: "🌨", label: "비/눈" },
  3: { key: "snow",   glyph: "❄",  label: "눈" },
  4: { key: "shower", glyph: "🌦", label: "소나기" },
};

/** SKY 1=맑음 3=구름많음 4=흐림 (2는 기상청이 쓰지 않는다) */
const BY_SKY: Record<number, SkyLook> = {
  1: { key: "clear",  glyph: "☀", label: "맑음" },
  3: { key: "partly", glyph: "⛅", label: "구름많음" },
  4: { key: "cloudy", glyph: "☁", label: "흐림" },
};

const UNKNOWN: SkyLook = { key: "unknown", glyph: "–", label: "정보 없음" };

export function skyLook(sky: number | null, pty: number | null): SkyLook {
  // 강수형태가 먼저다. 하늘이 맑아도 비가 온다면 그 시각의 사실은 "비"다.
  if (pty !== null && BY_PTY[pty]) return BY_PTY[pty]!;
  if (sky !== null && BY_SKY[sky]) return BY_SKY[sky]!;
  return UNKNOWN;
}
```

- [ ] **Step 3: 조회 테스트를 쓴다**

```ts
// apps/web/src/lib/api/__tests__/forecast.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { forecast } from "../forecast";

afterEach(() => vi.restoreAllMocks());

describe("forecast()", () => {
  it("GET /api/forecast를 부른다", async () => {
    const body = { fetched_at: null, base_at: null, stale: false, hourly: [], daily: [], upcoming: [] };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(forecast()).resolves.toEqual(body);
    expect(spy.mock.calls[0]![0]).toBe("/api/forecast");
  });
});
```

- [ ] **Step 4: 구현한다**

```ts
// apps/web/src/lib/api/forecast.ts
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
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd apps/web && npx vitest run src/lib && npm run build`
Expected: PASS · 빌드 성공(타입 검사 포함)

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/lib/api/forecast.ts apps/web/src/lib/weatherIcon.ts \
        apps/web/src/lib/__tests__/weatherIcon.test.ts apps/web/src/lib/api/__tests__/forecast.test.ts
git commit -m "feat(web): 예보 조회와 하늘 아이콘을 붙인다"
```

---

### Task 8: 48시간 스트립 (`components/ForecastStrip.tsx`)

두 화면이 같은 컴포넌트를 쓰되 **밀도만 다르다.** 월보드는 밀 사람이 없으므로
스크롤을 쓰지 않고 3시간 간격으로 펼친다.

**Files:**
- Create: `apps/web/src/components/ForecastStrip.tsx`
- Create: `apps/web/src/components/ForecastStrip.css`
- Test: `apps/web/src/components/__tests__/ForecastStrip.test.tsx`

**Interfaces:**
- Consumes: `ForecastHour`(Task 7), `skyLook`(Task 7)
- Produces:
```tsx
export type ForecastStripProps = { hours: ForecastHour[]; density: "scroll" | "spread" };
export function ForecastStrip(props: ForecastStripProps): JSX.Element | null;
export function thin(hours: ForecastHour[], density: "scroll" | "spread"): ForecastHour[];
```

**스펙 §9의 "임계선"이 여기서 어떤 모양이 되는가:** 이 스트립은 연속 그래프가
아니라 시각별 칸이라, 가로선을 그을 자리가 없다. 같은 뜻을 **칸 색**으로 실현한다 —
서버가 `exceeds`로 표시한 시각만 칠한다. 임계값 자체를 숫자로 보여주는 자리는
월보드의 지표 차트(임계선 + 라벨, Task 11)와 예고 배너(Task 9)다. 세 곳 모두
같은 `weather_criteria`에서 나오므로 기준을 바꾸면 함께 움직인다.

- [ ] **Step 1: 실패 테스트를 쓴다**

```tsx
// apps/web/src/components/__tests__/ForecastStrip.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastStrip, thin } from "../ForecastStrip";
import type { ForecastHour } from "../../lib/api/forecast";

function h(kstIso: string, v: Partial<ForecastHour> = {}): ForecastHour {
  return {
    at: new Date(kstIso).toISOString(), temp_c: 20, pop_pct: 0, pty: 0, sky: 1,
    pcp_mm: null, sno_cm: null, wsd_ms: 2, exceeds: [], ...v,
  };
}
const SIX = [0, 1, 2, 3, 4, 5].map((i) => h(`2026-09-07T${String(10 + i).padStart(2, "0")}:00:00+09:00`));

describe("thin — 밀도", () => {
  it("scroll은 모든 시각을 남긴다", () => {
    expect(thin(SIX, "scroll")).toHaveLength(6);
  });

  // 월보드에는 미는 사람이 없다. 48칸을 그리면 앞쪽만 영원히 보인다.
  it("spread는 3시간 간격으로 솎는다", () => {
    expect(thin(SIX, "spread")).toHaveLength(2);
  });
});

describe("ForecastStrip", () => {
  it("예보가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastStrip hours={[]} density="scroll" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("시각과 기온을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { temp_c: 23 })]} density="scroll" />);
    expect(screen.getByText("14시")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
  });

  // 자정이 지나면 몇 시인지만으로는 어느 날인지 알 수 없다.
  it("자정 칸에는 날짜를 함께 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-08T00:00:00+09:00")]} density="scroll" />);
    expect(screen.getByText(/9\/8/)).toBeInTheDocument();
  });

  // 아이콘만 있으면 색각·저시력 사용자에게 아무 정보도 아니다.
  it("하늘상태에 읽을 수 있는 라벨이 있다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { sky: 4, pty: 0 })]} density="scroll" />);
    expect(screen.getByText("흐림")).toBeInTheDocument();
  });

  // 값이 하나도 없는 줄을 0이나 -로 채우면 "비가 안 온다"는 단언이 된다.
  it("강수량이 하나도 없으면 그 줄을 아예 그리지 않는다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: null })]} density="scroll" />);
    expect(screen.queryByText("강수량")).not.toBeInTheDocument();
  });

  it("강수량이 있으면 그 줄을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: 12 })]} density="scroll" />);
    expect(screen.getByText("강수량")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("신적설이 있으면 그 줄을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { sno_cm: 3 })]} density="scroll" />);
    expect(screen.getByText("신적설")).toBeInTheDocument();
  });

  // **가장 중요한 줄.** 화면은 임계와 비교하지 않는다 — 서버가 준 exceeds만 본다.
  it("서버가 초과라고 표시한 칸만 강조한다", () => {
    const { container } = render(
      <ForecastStrip
        hours={[
          h("2026-09-07T14:00:00+09:00", { pcp_mm: 60, exceeds: [{ kind: "rain", grade: "warning" }] }),
          h("2026-09-07T15:00:00+09:00", { pcp_mm: 90, exceeds: [] }),
        ]}
        density="scroll"
      />,
    );
    expect(container.querySelectorAll(".fc-col-over")).toHaveLength(1);
    expect(container.querySelectorAll(".fc-col-warning")).toHaveLength(1);
  });

  it("밀도에 따라 다른 클래스를 단다", () => {
    const { container: a } = render(<ForecastStrip hours={SIX} density="scroll" />);
    const { container: b } = render(<ForecastStrip hours={SIX} density="spread" />);
    expect(a.querySelector(".fc-scroll")).not.toBeNull();
    expect(b.querySelector(".fc-spread")).not.toBeNull();
    // 월보드에는 스크롤 컨테이너가 없어야 한다.
    expect(b.querySelector(".fc-scroll")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/ForecastStrip.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현한다**

```tsx
// apps/web/src/components/ForecastStrip.tsx
// 앞으로 48시간. 두 화면이 같은 컴포넌트를 쓰되 밀도만 다르다.
//
// **월보드에는 스크롤을 쓰지 않는다.** 벽에 걸린 화면에는 미는 사람이 없어서,
// 48칸을 스크롤로 두면 앞쪽 몇 칸만 영원히 보이고 나머지는 없는 것과 같다.
// 그래서 spread는 3시간 간격으로 솎아 전부 한 화면에 펼친다.
import { skyLook } from "../lib/weatherIcon";
import type { ForecastHour } from "../lib/api/forecast";
import "./ForecastStrip.css";

export type ForecastStripProps = { hours: ForecastHour[]; density: "scroll" | "spread" };

/** 월보드용 간격. 48시간 ÷ 3시간 = 16칸이면 큰 화면에 한 번에 들어간다. */
const SPREAD_STEP = 3;

export function thin(hours: ForecastHour[], density: "scroll" | "spread"): ForecastHour[] {
  return density === "spread" ? hours.filter((_, i) => i % SPREAD_STEP === 0) : hours;
}

/** KST 시각 조각. 서버는 ISO(UTC)로 주고 화면은 한국 시각으로 읽는다. */
function kst(iso: string): { hour: number; month: number; day: number } {
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3);
  return { hour: d.getUTCHours(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function num(v: number | null): string {
  return v === null ? "–" : String(Number(v.toFixed(1)));
}

export function ForecastStrip({ hours, density }: ForecastStripProps) {
  const cols = thin(hours, density);
  // 예보가 없으면 빈 표를 그리지 않는다. 빈 칸을 0이나 -로 채우면
  // "받지 못했다"가 "값이 0이다"로 읽힌다.
  if (cols.length === 0) return null;

  // 값이 하나라도 있는 줄만 그린다. 겨울에는 눈이, 여름에는 비가 저절로 앞에 온다.
  const hasRain = cols.some((c) => c.pcp_mm !== null && c.pcp_mm > 0);
  const hasSnow = cols.some((c) => c.sno_cm !== null && c.sno_cm > 0);

  return (
    <section className={`fc fc-${density}`} aria-label="앞으로 48시간 예보">
      <h2 className="fc-title">앞으로 48시간</h2>
      <div className={density === "scroll" ? "fc-track fc-scroll" : "fc-track"}>
        {cols.map((c) => {
          const t = kst(c.at);
          const look = skyLook(c.sky, c.pty);
          // **화면은 임계와 비교하지 않는다.** 서버가 준 exceeds만 읽는다.
          const worst = c.exceeds.some((e) => e.grade === "warning") ? "warning"
            : c.exceeds.length > 0 ? "watch" : null;
          return (
            <div
              key={c.at}
              className={`fc-col${worst ? ` fc-col-over fc-col-${worst}` : ""}`}
            >
              <span className="fc-time">
                {t.hour === 0 && <span className="fc-date">{t.month}/{t.day}</span>}
                {t.hour}시
              </span>
              <span className="fc-sky">
                <span className="fc-glyph" aria-hidden="true">{look.glyph}</span>
                <span className="fc-skylabel">{look.label}</span>
              </span>
              <span className="fc-temp">{num(c.temp_c)}</span>
              <span className="fc-pop">{c.pop_pct === null ? "–" : `${c.pop_pct}%`}</span>
              {hasRain && <span className="fc-amount">{num(c.pcp_mm)}</span>}
              {hasSnow && <span className="fc-amount">{num(c.sno_cm)}</span>}
            </div>
          );
        })}
      </div>
      <div className="fc-legend">
        <span>기온 ℃</span><span>강수확률</span>
        {hasRain && <span>강수량</span>}
        {hasSnow && <span>신적설</span>}
      </div>
    </section>
  );
}
```

```css
/* apps/web/src/components/ForecastStrip.css */
.fc {
  padding: 24px 28px;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
}

.fc-title {
  margin: 0 0 12px;
  font-family: var(--font-ui);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}

.fc-track {
  display: flex;
  gap: 4px;
}

/* 일반 대시보드에서만. 월보드에는 이 클래스가 붙지 않는다 — 미는 사람이 없다. */
.fc-scroll {
  overflow-x: auto;
  scroll-snap-type: x proximity;
  padding-bottom: 6px;
}

.fc-col {
  flex: 0 0 auto;
  min-width: 54px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px;
  border-radius: 10px;
  scroll-snap-align: start;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--ink-muted-80);
}

/* 월보드는 16칸이 화면을 가득 채운다. 고정폭 대신 균등 분할한다. */
.fc-spread .fc-col {
  flex: 1 1 0;
  min-width: 0;
}

.fc-col-over { background: color-mix(in srgb, var(--warn-strong) 14%, var(--canvas)); }
.fc-col-warning { background: color-mix(in srgb, var(--danger) 14%, var(--canvas)); }

.fc-time { font-weight: 600; color: var(--ink); white-space: nowrap; }
.fc-date { display: block; font-size: 11px; font-weight: 400; color: var(--ink-muted-48); }
.fc-glyph { font-size: 20px; line-height: 1; }
/* 아이콘 옆의 글자. 화면에 보이되 작게 둔다 — 아이콘만으로는 정보가 아니다. */
.fc-skylabel { display: block; font-size: 11px; color: var(--ink-muted-48); }
.fc-temp { font-family: var(--font-num); font-size: 15px; color: var(--ink); }
.fc-pop { font-size: 12px; color: var(--ink-muted-48); }
.fc-amount { font-family: var(--font-num); font-size: 12px; color: var(--ink-muted-80); }

.fc-legend {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-family: var(--font-ui);
  font-size: 12px;
  color: var(--ink-muted-48);
}

/* 월보드는 3미터 밖에서 읽는다. 큰 화면에서 글자만 키운다. */
.fc-spread .fc-time { font-size: 18px; }
.fc-spread .fc-glyph { font-size: 30px; }
.fc-spread .fc-skylabel { font-size: 14px; }
.fc-spread .fc-temp { font-size: 24px; }
.fc-spread .fc-pop,
.fc-spread .fc-amount { font-size: 16px; }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/ForecastStrip.test.tsx && npm run build`
Expected: PASS (11 tests) · 빌드 성공

- [ ] **Step 5: 변이로 확인한다**

`worst` 계산을 `c.pcp_mm !== null && c.pcp_mm > 20 ? "warning" : null`로 바꾸고 돌린다
(= 화면이 스스로 임계와 비교하는 형태).
Expected: `서버가 초과라고 표시한 칸만 강조한다`가 FAIL. 확인 후 **되돌린다.**

`thin`의 `density === "spread"` 분기를 지우고 돌린다.
Expected: `spread는 3시간 간격으로 솎는다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 6: 커밋**

```bash
git add apps/web/src/components/ForecastStrip.tsx apps/web/src/components/ForecastStrip.css \
        apps/web/src/components/__tests__/ForecastStrip.test.tsx
git commit -m "feat(web): 48시간 스트립을 두 밀도로 그린다"
```

---

### Task 9: 5일 요약과 예고 배너 (`ForecastDaily.tsx`, `ForecastBanner.tsx`)

배너는 이 계획에서 **문구가 가장 중요한 조각**이다. 특보와 헷갈리면
"배너 떴으니 알림도 갔겠지" 하고 아무도 움직이지 않는다.

**Files:**
- Create: `apps/web/src/components/ForecastDaily.tsx` / `.css`
- Create: `apps/web/src/components/ForecastBanner.tsx` / `.css`
- Test: `apps/web/src/components/__tests__/ForecastDaily.test.tsx`
- Test: `apps/web/src/components/__tests__/ForecastBanner.test.tsx`

**Interfaces:**
- Consumes: `ForecastDay`·`UpcomingRow`(Task 7), `skyLook`(Task 7)
- Produces:
```tsx
export function ForecastDaily(props: { days: ForecastDay[] }): JSX.Element | null;
export const FORECAST_DISCLAIMER = "예보 기준입니다 · 문자는 나가지 않았습니다";
export function ForecastBanner(props: { upcoming: UpcomingRow[]; compact?: boolean }): JSX.Element | null;
```

- [ ] **Step 1: 5일 요약 테스트를 쓴다**

```tsx
// apps/web/src/components/__tests__/ForecastDaily.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastDaily } from "../ForecastDaily";
import type { ForecastDay } from "../../lib/api/forecast";

function day(date: string, v: Partial<ForecastDay> = {}): ForecastDay {
  return { date, tmn_c: 16, tmx_c: 25, pop_max: 20, pcp_sum: null, sno_sum: null,
           sky: 1, derived: false, ...v };
}

describe("ForecastDaily", () => {
  it("비어 있으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastDaily days={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // 오늘은 관측 카드와 48시간 스트립이 이미 말한다. 여기서 또 말하면
  // 같은 정보가 세 번 나온다.
  it("오늘은 그리지 않고 내일부터 그린다", () => {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(today), day(tomorrow)]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("최저~최고와 강수확률을 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { tmn_c: 16, tmx_c: 27, pop_max: 80 })]} />);
    expect(screen.getByText(/16/)).toBeInTheDocument();
    expect(screen.getByText(/27/)).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  // 스키장에서 눈 예보는 가장 중요한 숫자다. 있으면 반드시 보여야 한다.
  it("적설이 있으면 함께 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { sno_sum: 8 })]} />);
    expect(screen.getByText(/8cm/)).toBeInTheDocument();
  });

  it("강수량이 있으면 함께 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { pcp_sum: 35 })]} />);
    expect(screen.getByText(/35mm/)).toBeInTheDocument();
  });

  it("값이 없는 항목은 아예 그리지 않는다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { pcp_sum: null, sno_sum: null })]} />);
    expect(screen.queryByText(/mm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cm/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패를 확인한 뒤 구현한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/ForecastDaily.test.tsx` → FAIL

```tsx
// apps/web/src/components/ForecastDaily.tsx
// 5일 요약. **오늘은 그리지 않는다** — 관측 카드와 48시간 스트립이 이미
// 오늘을 말하고 있어서, 여기서 또 그리면 같은 정보가 세 번 나온다.
import { skyLook } from "../lib/weatherIcon";
import type { ForecastDay } from "../lib/api/forecast";
import "./ForecastDaily.css";

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/** 오늘(KST) 날짜 문자열. 서버의 date와 같은 형식이다. */
function todayKst(): string {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

export function ForecastDaily({ days }: { days: ForecastDay[] }) {
  const today = todayKst();
  const rows = days.filter((d) => d.date > today);
  if (rows.length === 0) return null;

  return (
    <section className="fd" aria-label="5일 예보">
      <h2 className="fd-title">5일</h2>
      <ul className="fd-list">
        {rows.map((d) => {
          const dt = new Date(`${d.date}T00:00:00+09:00`);
          const wd = WEEKDAY[new Date(dt.getTime() + 9 * 3600e3).getUTCDay()];
          const look = skyLook(d.sky, null);
          return (
            <li className="fd-item" key={d.date}>
              <span className="fd-day">
                {Number(d.date.slice(5, 7))}/{Number(d.date.slice(8, 10))} ({wd})
              </span>
              <span className="fd-sky">
                <span aria-hidden="true">{look.glyph}</span>
                <span className="fd-skylabel">{look.label}</span>
              </span>
              <span className="fd-temp">
                {d.tmn_c === null ? "–" : Math.round(d.tmn_c)}~{d.tmx_c === null ? "–" : Math.round(d.tmx_c)}℃
              </span>
              {d.pop_max !== null && <span className="fd-pop">{d.pop_max}%</span>}
              {/* 값이 없는 항목은 그리지 않는다. 0으로 채우면 "안 온다"는 단언이 된다. */}
              {d.pcp_sum !== null && d.pcp_sum > 0 && (
                <span className="fd-amount">{Number(d.pcp_sum.toFixed(1))}mm</span>
              )}
              {d.sno_sum !== null && d.sno_sum > 0 && (
                <span className="fd-amount fd-snow">{Number(d.sno_sum.toFixed(1))}cm</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

```css
/* apps/web/src/components/ForecastDaily.css */
.fd {
  padding: 24px 28px;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
}

.fd-title {
  margin: 0 0 12px;
  font-family: var(--font-ui);
  font-size: 17px;
  font-weight: 600;
  color: var(--ink);
}

.fd-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  gap: 12px;
}

.fd-item {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 12px 8px;
  border-radius: 10px;
  background: var(--pearl);
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--ink-muted-80);
}

.fd-day { font-weight: 600; color: var(--ink); white-space: nowrap; }
.fd-skylabel { display: block; font-size: 11px; color: var(--ink-muted-48); }
.fd-temp { font-family: var(--font-num); font-size: 15px; color: var(--ink); white-space: nowrap; }
.fd-pop { font-size: 12px; color: var(--ink-muted-48); }
.fd-amount { font-family: var(--font-num); font-size: 12px; }
/* 스키장에서 눈은 가장 중요한 숫자다. 색으로 한 번 더 띄운다. */
.fd-snow { color: var(--primary); font-weight: 600; }

@media (max-width: 640px) {
  .fd-list { flex-wrap: wrap; }
  .fd-item { flex: 1 1 40%; }
}
```

- [ ] **Step 3: 배너 테스트를 쓴다**

```tsx
// apps/web/src/components/__tests__/ForecastBanner.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastBanner, FORECAST_DISCLAIMER } from "../ForecastBanner";
import type { UpcomingRow } from "../../lib/api/forecast";

const soon = new Date(Date.now() + 12 * 3600e3).toISOString();
function up(v: Partial<UpcomingRow> = {}): UpcomingRow {
  return { kind: "snow", grade: "watch", at: soon, value: 7, unit: "cm", ...v };
}

describe("ForecastBanner", () => {
  it("예고가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastBanner upcoming={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("종류와 등급과 값을 말한다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText(/폭설 주의보/)).toBeInTheDocument();
    expect(screen.getByText(/7cm/)).toBeInTheDocument();
  });

  // **이 계획에서 가장 중요한 한 줄.** 이 문구가 없으면 "배너 떴으니 알림도
  // 갔겠지" 하고 아무도 움직이지 않은 채 모두가 안심한다.
  it("문자가 나가지 않았다는 사실을 반드시 함께 말한다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText(FORECAST_DISCLAIMER)).toBeInTheDocument();
  });

  it("실제 특보 배너와 다른 라벨을 쓴다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText("예고")).toBeInTheDocument();
    expect(screen.queryByText("승인 대기")).not.toBeInTheDocument();
  });

  it("가장 이른 하나만 말하고 나머지는 개수로 접는다", () => {
    const later = new Date(Date.now() + 30 * 3600e3).toISOString();
    render(<ForecastBanner upcoming={[up(), up({ kind: "rain", at: later, unit: "mm", value: 25 })]} />);
    expect(screen.getByText(/폭설 주의보/)).toBeInTheDocument();
    expect(screen.getByText(/외 1건/)).toBeInTheDocument();
  });

  it("한 건뿐이면 '외 N건'을 붙이지 않는다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.queryByText(/외 .*건/)).not.toBeInTheDocument();
  });

  it("compact에서도 문자 미발송 문구는 남는다", () => {
    render(<ForecastBanner upcoming={[up()]} compact />);
    expect(screen.getByText(FORECAST_DISCLAIMER)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: 실패를 확인한 뒤 구현한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/ForecastBanner.test.tsx` → FAIL

```tsx
// apps/web/src/components/ForecastBanner.tsx
// 예보상 임계 초과가 예상될 때 뜨는 배너. **실제 특보 배너와 반드시 구분된다.**
//
// 구분이 흐려지면 이 시스템이 다섯 번 고친 결함이 그대로 돌아온다:
// 사람들이 "배너가 떴으니 알림도 갔겠지"라고 읽고, 아무도 움직이지 않은 채
// 모두가 안심한다. 그래서 라벨("예고")·색·문구를 특보와 다르게 두고,
// **문자가 나가지 않았다는 사실을 배너 안에서 직접 말한다.**
import type { UpcomingRow } from "../lib/api/forecast";
import "./ForecastBanner.css";

const KIND_LABEL: Record<UpcomingRow["kind"], string> = {
  rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염",
};
const GRADE_LABEL: Record<UpcomingRow["grade"], string> = { watch: "주의보", warning: "경보" };

/** 이 문구는 지우면 안 된다. 테스트가 이 상수로 존재를 고정한다. */
export const FORECAST_DISCLAIMER = "예보 기준입니다 · 문자는 나가지 않았습니다";

/** "내일 06시" / "오늘 21시" — 사람이 읽는 상대 날짜. */
function whenLabel(iso: string): string {
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const kstAt = new Date(new Date(iso).getTime() + 9 * 3600e3);
  const dayDiff =
    Math.floor(kstAt.getTime() / 86400000) - Math.floor(kstNow.getTime() / 86400000);
  const prefix = dayDiff <= 0 ? "오늘" : dayDiff === 1 ? "내일" : dayDiff === 2 ? "모레" : `${kstAt.getUTCMonth() + 1}/${kstAt.getUTCDate()}`;
  return `${prefix} ${kstAt.getUTCHours()}시`;
}

export function ForecastBanner({ upcoming, compact }: { upcoming: UpcomingRow[]; compact?: boolean }) {
  if (upcoming.length === 0) return null;
  // 서버가 이미 이른 순으로 준다. 그래도 화면에서 다시 고르지 않고 첫 건을 쓴다.
  const first = upcoming[0]!;
  const rest = upcoming.length - 1;

  return (
    <div className={compact ? "fb fb-compact" : "fb"} role="status">
      <span className="fb-tag">예고</span>
      <span className="fb-main">
        <span className="fb-title">
          {whenLabel(first.at)} {KIND_LABEL[first.kind]} {GRADE_LABEL[first.grade]} 예상
          {" "}({Number(first.value.toFixed(1))}{first.unit})
          {rest > 0 && <span className="fb-more"> 외 {rest}건</span>}
        </span>
        {/* 지우지 말 것. 이 줄이 없으면 배너가 특보로 읽힌다. */}
        <span className="fb-note">{FORECAST_DISCLAIMER}</span>
      </span>
    </div>
  );
}
```

```css
/* apps/web/src/components/ForecastBanner.css */
/* 실제 특보 배너(.approval-banner)와 **눈으로 구분되어야** 한다.
   특보는 경고색을 쓰므로 예고는 정보색(Action Blue)을 쓴다. */
.fb {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 28px;
  background: color-mix(in srgb, var(--primary) 8%, var(--canvas));
  border: 1px solid color-mix(in srgb, var(--primary) 24%, var(--hairline));
  border-radius: var(--radius-card);
}

.fb-tag {
  flex: none;
  padding: 4px 10px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--primary) 16%, var(--canvas));
  color: var(--primary);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.fb-main { min-width: 0; }

.fb-title {
  display: block;
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}

.fb-more { font-weight: 400; color: var(--ink-muted-48); }

.fb-note {
  display: block;
  margin-top: 4px;
  font-family: var(--font-ui);
  font-size: 13px;
  color: var(--ink-muted-48);
}

/* 월보드용. 3미터 밖에서 읽히도록 키우되 문구는 그대로 둔다. */
.fb-compact .fb-title { font-size: 22px; }
.fb-compact .fb-note { font-size: 15px; }
.fb-compact .fb-tag { font-size: 15px; padding: 6px 14px; }
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd apps/web && npx vitest run src/components && npm run build`
Expected: PASS · 빌드 성공

- [ ] **Step 6: 변이로 확인한다**

`ForecastBanner`에서 `<span className="fb-note">` 줄을 지우고 돌린다.
Expected: `문자가 나가지 않았다는 사실을 반드시 함께 말한다`와 `compact에서도…` FAIL.
확인 후 **되돌린다.**

`ForecastDaily`의 `rows = days.filter((d) => d.date > today)`를 `days`로 바꾸고 돌린다.
Expected: `오늘은 그리지 않고 내일부터 그린다` FAIL. 확인 후 **되돌린다.**

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/components/ForecastDaily.tsx apps/web/src/components/ForecastDaily.css \
        apps/web/src/components/ForecastBanner.tsx apps/web/src/components/ForecastBanner.css \
        apps/web/src/components/__tests__/ForecastDaily.test.tsx \
        apps/web/src/components/__tests__/ForecastBanner.test.tsx
git commit -m "feat(web): 5일 요약과, 특보로 오해되지 않는 예고 배너를 만든다"
```

---

### Task 10: 일반 대시보드에 붙인다 (`pages/Dashboard.tsx`)

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Test: `apps/web/src/pages/Dashboard.test.tsx` (기존 파일에 describe 추가)

**Interfaces:**
- Consumes: `forecast`·`ForecastResponse`(Task 7), `ForecastStrip`(Task 8), `ForecastDaily`·`ForecastBanner`(Task 9)
- Produces: `DashboardData`에 `forecast: ForecastResponse | null` 추가 (Task 12가 월보드로 넘긴다)

- [ ] **Step 1: 실패 테스트를 쓴다**

이 파일은 `test-support/fetchQueue`의 `makeFetchQueue`로 **실제 경로별 응답**을
큐에 넣는다(모듈 목이 아니라 경로 목이라, 경로를 틀리면 초록이 나오지 않는다).
큐에 없는 경로가 불리면 즉시 예외를 던지므로, `/api/forecast` 응답을 **반드시
함께 넣어야** 기존 테스트가 깨지지 않는다.

```tsx
// apps/web/src/pages/Dashboard.test.tsx 에 추가
import { makeFetchQueue, jsonResponse } from "../test-support/fetchQueue";
import type { ForecastResponse } from "../lib/api/forecast";

const IN_12H = new Date(Date.now() + 12 * 3600e3).toISOString();

function forecastBody(over: Partial<ForecastResponse> = {}): ForecastResponse {
  return {
    fetched_at: new Date().toISOString(),
    base_at: new Date().toISOString(),
    stale: false,
    hourly: [{
      at: new Date(Date.now() + 3600e3).toISOString(),
      temp_c: 23, pop_pct: 10, pty: 0, sky: 1,
      pcp_mm: null, sno_cm: null, wsd_ms: 2, exceeds: [],
    }],
    daily: [{
      date: new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10),
      tmn_c: 16, tmx_c: 25, pop_max: 20, pcp_sum: null, sno_sum: null, sky: 1, derived: false,
    }],
    upcoming: [{ kind: "snow", grade: "watch", at: IN_12H, value: 7, unit: "cm" }],
    ...over,
  };
}

describe("예보 블록", () => {
  it("예고가 있으면 배너를 그리고, 문자 미발송 문구도 함께 나온다", async () => {
    // 이 파일이 이미 쓰는 렌더 헬퍼를 그대로 쓰되, /api/forecast 응답을 큐에 더한다.
    // (헬퍼 이름과 나머지 경로 목록은 같은 파일의 기존 테스트에서 그대로 가져온다.)
    const { push } = setupDashboardFetch();
    push("/api/forecast", () => jsonResponse(forecastBody()));
    renderDashboard();
    expect(await screen.findByText(/폭설 주의보 예상/)).toBeInTheDocument();
    expect(screen.getByText("예보 기준입니다 · 문자는 나가지 않았습니다")).toBeInTheDocument();
  });

  it("48시간 스트립과 5일 요약을 그린다", async () => {
    const { push } = setupDashboardFetch();
    push("/api/forecast", () => jsonResponse(forecastBody()));
    renderDashboard();
    expect(await screen.findByText("앞으로 48시간")).toBeInTheDocument();
    expect(screen.getByText("5일")).toBeInTheDocument();
  });

  // **가장 중요한 줄.** 예보는 표시 기능이다. 그것이 실패했다고 관측 카드와
  // 진행 중 특보까지 사라지면, 표시 하나 때문에 운영 화면 전체를 잃는다.
  it("예보 조회가 실패해도 나머지 화면은 그대로 그린다", async () => {
    const { push } = setupDashboardFetch();
    push("/api/forecast", () => jsonResponse({ error: "서버 오류" }, 500));
    renderDashboard();
    // 관측 카드는 그대로 있다
    expect(await screen.findByText("강수")).toBeInTheDocument();
    // 예보 블록만 사라진다
    expect(screen.queryByText("앞으로 48시간")).not.toBeInTheDocument();
    // 전체 오류 배너를 띄우지 않는다 — 특보 발송은 멀쩡하기 때문이다
    expect(screen.queryByText(/데이터를 불러오지 못했습니다/)).not.toBeInTheDocument();
  });

  it("예보가 낡았으면 그 사실을 말한다", async () => {
    const { push } = setupDashboardFetch();
    push("/api/forecast", () => jsonResponse(forecastBody({ stale: true })));
    renderDashboard();
    expect(await screen.findByText(/예보를 받지 못하고 있습니다/)).toBeInTheDocument();
  });
});
```

**기존 테스트를 먼저 고쳐야 한다.** 이 파일의 다른 모든 테스트도 이제
`/api/forecast`를 부른다. 큐에 응답이 없으면 `no mock response queued for
/api/forecast`로 즉시 터진다. 렌더 헬퍼(또는 각 테스트의 setup)에
`push("/api/forecast", () => jsonResponse(forecastBody()))`를 **기본으로 한 줄
추가**하고 전체를 돌려 확인한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd apps/web && npx vitest run src/pages/Dashboard.test.tsx`
Expected: FAIL

- [ ] **Step 3: 조회를 추가한다**

`apps/web/src/pages/Dashboard.tsx` 상단 import에 추가:

```tsx
import { forecast, type ForecastResponse } from "../lib/api/forecast";
import { ForecastStrip } from "../components/ForecastStrip";
import { ForecastDaily } from "../components/ForecastDaily";
import { ForecastBanner } from "../components/ForecastBanner";
```

`load` 안의 `Promise.all` 배열 **맨 끝에** 추가한다:

```tsx
        // **실패해도 화면 전체를 잃지 않는다.** 예보는 표시 기능이고, 그것이
        // 죽어도 관측·특보·발송은 멀쩡하다. Promise.all에 그냥 넣으면 예보
        // 하나가 거절될 때 배열 전체가 거절되어 관측 카드까지 "-"가 되고
        // "데이터를 불러오지 못했습니다"가 뜬다 — 운영자는 특보 시스템이
        // 죽은 줄 안다. 서버가 warnings/reasons를 나눈 것과 같은 판단이다.
        forecast().catch(() => null),
```

구조분해에도 이름을 추가한다(배열 순서와 같은 자리):

```tsx
      const [obs, openEventRows, dispatchRows, criteriaRows, site, snowTodayRows, historyRows, beat, fcst] =
        await Promise.all([ /* … */ ]);
```

`setData(...)`에 `forecast: fcst`를 넣고, `DashboardData` 타입에도 필드를 추가한다:

```tsx
  /** 예보. 조회에 실패하면 null이다 — 그때는 예보 블록만 그리지 않는다. */
  forecast: ForecastResponse | null;
```

- [ ] **Step 4: 블록 3개를 그린다**

승인 대기 배너(`approval-banner`)를 닫는 `)}` **바로 아래**에 배너를 넣는다:

```tsx
        {data?.forecast && <ForecastBanner upcoming={data.forecast.upcoming} />}
```

관측 카드(`<div className="obs-grid">…</div>`)를 닫은 **바로 아래**에 두 블록을 넣는다:

```tsx
        {data?.forecast?.stale && (
          <div className="dash-error">
            예보를 받지 못하고 있습니다 — 아래 예보는 갱신되지 않은 값입니다
          </div>
        )}
        {data?.forecast && <ForecastStrip hours={data.forecast.hourly} density="scroll" />}
        {data?.forecast && <ForecastDaily days={data.forecast.daily} />}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd apps/web && npx vitest run src/pages/Dashboard.test.tsx && npm run build`
Expected: PASS · 빌드 성공

- [ ] **Step 6: 변이로 확인한다**

`forecast().catch(() => null)`을 `forecast()`로 바꾸고 돌린다.
Expected: `예보 조회가 실패해도 나머지 화면은 그대로 그린다`가 FAIL.
확인 후 **되돌린다.**

- [ ] **Step 7: 커밋**

```bash
git add apps/web/src/pages/Dashboard.tsx apps/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): 대시보드에 예고 배너와 48시간·5일 예보를 붙인다"
```

---

### Task 11: 지표 차트에 예보를 잇는다 (`components/MetricChart.tsx`)

**Files:**
- Modify: `apps/web/src/components/MetricChart.tsx`
- Modify: `apps/web/src/components/MetricChart.css`
- Test: `apps/web/src/components/__tests__/MetricChart.test.tsx` (기존 파일에 추가)

**Interfaces:**
- Consumes: `computeScale`·`yOf`(`apps/web/src/lib/chartScale.ts`)
- Produces: `MetricChartProps`에 `forecast?: number[]` 추가 (기본값 `[]`, 기존 호출부는 그대로 동작)

- [ ] **Step 1: 실패 테스트를 쓴다**

```tsx
// apps/web/src/components/__tests__/MetricChart.test.tsx 에 추가
describe("예보 잇기", () => {
  const base = {
    values: [1, 2, 3], threshold: 10, unit: "mm",
    gradeLabel: "주의보", allowNegative: false, tone: "calm" as const,
  };

  it("예보를 주지 않으면 지금과 똑같이 그린다(기존 호출부 보호)", () => {
    const { container } = render(<MetricChart {...base} />);
    expect(container.querySelector(".mc-forecast")).toBeNull();
    expect(container.querySelector(".mc-now")).toBeNull();
  });

  it("예보를 주면 점선과 '지금' 세로선을 그린다", () => {
    const { container } = render(<MetricChart {...base} forecast={[4, 5, 6]} />);
    expect(container.querySelector(".mc-forecast")).not.toBeNull();
    expect(container.querySelector(".mc-now")).not.toBeNull();
  });

  // 예보가 임계를 크게 넘는데 축이 관측 범위에만 맞으면 점선이 화면 밖으로 나간다.
  it("축이 예보까지 포함한다", () => {
    const { container } = render(<MetricChart {...base} forecast={[40]} />);
    const top = container.querySelector(".mc-axis")!;
    expect(Number(top.textContent)).toBeGreaterThanOrEqual(40);
  });

  // **가장 중요한 줄.** 예보가 임계를 넘어도 지금 값의 색은 바뀌지 않는다.
  // 3미터 밖에서 흘끗 본 사람이 "지금 폭우"로 읽으면 안 된다.
  it("예보가 임계를 넘어도 tone(색)은 바뀌지 않는다", () => {
    const { container } = render(<MetricChart {...base} forecast={[99]} />);
    expect(container.querySelector(".mc-line.mc-tone-calm")).not.toBeNull();
    expect(container.querySelector(".mc-line.mc-tone-over")).toBeNull();
  });

  it("최신값 점은 예보가 아니라 마지막 관측 위에 있다", () => {
    const { container } = render(<MetricChart {...base} forecast={[40, 50]} />);
    const dot = container.querySelector(".mc-dot")!;
    const now = container.querySelector(".mc-now")!;
    expect(dot.getAttribute("cx")).toBe(now.getAttribute("x1"));
  });
});
```

- [ ] **Step 2: 실패를 확인한 뒤 구현한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/MetricChart.test.tsx` → FAIL

`MetricChartProps`에 추가:

```tsx
  /**
   * 앞으로의 예보. 비면 지금과 완전히 같게 그린다 — 기존 호출부를 지킨다.
   *
   * **이 값은 tone(색)에 영향을 주지 않는다.** 색과 큰 숫자는 "지금"만
   * 말해야 한다. 예보가 임계를 넘는다고 카드를 빨갛게 만들면, 3미터 밖에서
   * 흘끗 본 사람이 지금 폭우가 오는 줄 안다. 예보의 초과는 점선이 임계선을
   * 넘는 그림으로만 말한다.
   */
  forecast?: number[];
```

`MetricChart` 본문에서 스케일 계산을 바꾼다:

```tsx
  const fc = forecast ?? [];
  // 축은 관측과 예보를 **함께** 본다. 관측 범위에만 맞추면 예보 점선이
  // 화면 밖으로 나가 아무것도 보여주지 못한다.
  const { lo, hi, flat, thresholdVisible } = computeScale([...values, ...fc], threshold, allowNegative);

  // 가로축을 관측 구간과 예보 구간으로 나눈다. 관측이 왼쪽, 예보가 오른쪽이다.
  const total = values.length + fc.length;
  const xAt = (i: number) => (total <= 1 ? W / 2 : (i * W) / (total - 1));
  const pts = values.map((v, i) => ({ x: xAt(i), y: yOf(v, lo, hi, H, PAD_T, PAD_B) }));
  const fcPts = fc.map((v, i) => ({ x: xAt(values.length + i), y: yOf(v, lo, hi, H, PAD_T, PAD_B) }));
```

`everOver`는 **관측만** 본다(색 판단에 예보가 끼면 안 된다):

```tsx
  const everOver = threshold !== null && Math.max(...values) >= threshold;
```

`<circle className={...mc-dot...}>` 바로 뒤에 추가:

```tsx
      {fcPts.length > 0 && (
        <>
          {/* "지금" 경계. 이 선이 없으면 어디까지가 실제로 일어난 일인지 알 수 없다. */}
          <line className="mc-now" x1={last.x} y1="0" x2={last.x} y2={H} />
          <path
            className="mc-forecast"
            d={"M" + [last, ...fcPts].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}
          />
        </>
      )}
```

`MetricChart.css`에 추가:

```css
/* 예보는 점선이다. 실선(관측)과 한눈에 구분되어야 한다 —
   실제로 일어난 일과 앞으로의 추정이 같은 굵기·같은 형태면 섞여 읽힌다. */
.mc-forecast {
  fill: none;
  stroke: var(--ink-muted-48);
  stroke-width: 2;
  stroke-dasharray: 6 5;
  stroke-linecap: round;
}

/* "지금" 경계선. 눈에 띄되 데이터보다 뒤로 물러난다. */
.mc-now {
  stroke: var(--hairline);
  stroke-width: 1.5;
  stroke-dasharray: 2 3;
}
```

- [ ] **Step 3: 통과를 확인한다**

Run: `cd apps/web && npx vitest run src/components/__tests__/MetricChart.test.tsx && npm run build`
Expected: PASS (기존 + 신규 5) · 빌드 성공

- [ ] **Step 4: 변이로 확인한다**

`everOver`를 `Math.max(...values, ...fc) >= threshold`로 바꾸고 돌린다.
Expected: `예보가 임계를 넘어도 tone(색)은 바뀌지 않는다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/components/MetricChart.tsx apps/web/src/components/MetricChart.css \
        apps/web/src/components/__tests__/MetricChart.test.tsx
git commit -m "feat(web): 지표 차트가 지나온 값 옆에 앞으로를 잇는다"
```

---

### Task 12: 월보드에 붙인다 (`pages/DashboardBoard.tsx` + `toBoardProps`)

마지막 작업이다. 월보드는 **큰 화면에 띄우고 아무도 만지지 않는다** —
스크롤을 쓰지 않고, 세로가 부족하면 5일 줄부터 접는다.

**Files:**
- Modify: `apps/web/src/pages/DashboardBoard.tsx`
- Modify: `apps/web/src/pages/DashboardBoard.css`
- Modify: `apps/web/src/pages/Dashboard.tsx` (`toBoardProps`)
- Test: `apps/web/src/pages/__tests__/DashboardBoard.test.tsx`

**Interfaces:**
- Consumes: `ForecastStrip`(Task 8), `ForecastDaily`·`ForecastBanner`(Task 9), `MetricChart`의 `forecast` prop(Task 11), `DashboardData.forecast`(Task 10)
- Produces: `DashboardBoardProps`에 `forecast: ForecastResponse | null` 추가, `BoardMetric`에 `forecast: number[]` 추가

- [ ] **Step 1: 실패 테스트를 쓴다**

**먼저 기존 픽스처를 고친다.** 이 파일의 `metrics` 배열 4개 항목에 `forecast: []`를
추가하고, `renderBoard` 헬퍼가 `forecast` prop을 받도록 바꾼다. 새 필드를 필수로
두는 이유는, 선택 필드로 두면 넘기는 것을 잊어도 타입이 통과해 월보드만 조용히
예보 없이 그려지기 때문이다.

```tsx
// 기존 metrics 항목마다 forecast를 더한다:
//   { key: "rain", …, history: [0, 0, 0], forecast: [] },
//
// renderBoard도 함께 고친다:
function renderBoard(events: BoardEvent[] = [], forecast: ForecastResponse | null = null) {
  return render(
    <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="마지막 수집 2분 전"
                    stale={false} loadError={null} metrics={metrics} events={events}
                    forecast={forecast} />,
  );
}
```

```tsx
// apps/web/src/pages/__tests__/DashboardBoard.test.tsx 에 추가
import type { ForecastResponse } from "../../lib/api/forecast";

const FCST: ForecastResponse = {
  fetched_at: new Date().toISOString(),
  base_at: new Date().toISOString(),
  stale: false,
  hourly: Array.from({ length: 48 }, (_, i) => ({
    at: new Date(Date.now() + (i + 1) * 3600e3).toISOString(),
    temp_c: 20, pop_pct: 10, pty: 0, sky: 1, pcp_mm: null, sno_cm: null, wsd_ms: 2, exceeds: [],
  })),
  daily: [{
    date: new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10),
    tmn_c: 16, tmx_c: 25, pop_max: 20, pcp_sum: null, sno_sum: null, sky: 1, derived: false,
  }],
  upcoming: [{ kind: "snow", grade: "watch", at: new Date(Date.now() + 12 * 3600e3).toISOString(),
               value: 7, unit: "cm" }],
};

describe("월보드 예보", () => {
  it("예고 배너를 그리고, 문자 미발송 문구도 함께 나온다", () => {
    renderBoard([], FCST);
    expect(screen.getByText(/폭설 주의보 예상/)).toBeInTheDocument();
    expect(screen.getByText("예보 기준입니다 · 문자는 나가지 않았습니다")).toBeInTheDocument();
  });

  // **가장 중요한 줄.** 벽에 걸린 화면에는 미는 사람이 없다.
  it("가로 스크롤을 쓰지 않는다", () => {
    const { container } = renderBoard([], FCST);
    expect(container.querySelector(".fc-scroll")).toBeNull();
    expect(container.querySelector(".fc-spread")).not.toBeNull();
  });

  it("48시간을 3시간 간격 16칸으로 펼친다", () => {
    const { container } = renderBoard([], FCST);
    expect(container.querySelectorAll(".fc-col")).toHaveLength(16);
  });

  it("5일 줄도 그린다", () => {
    renderBoard([], FCST);
    expect(screen.getByText("5일")).toBeInTheDocument();
  });

  it("예보가 없으면 예보 블록만 빠지고 나머지는 그대로다", () => {
    renderBoard([], null);
    expect(screen.queryByText("앞으로 48시간")).not.toBeInTheDocument();
    expect(screen.getByText("곤지암")).toBeInTheDocument();
  });

  it("예보가 낡았으면 그 사실을 말한다", () => {
    renderBoard([], { ...FCST, stale: true });
    expect(screen.getByText(/예보를 받지 못하고 있습니다/)).toBeInTheDocument();
  });
});

// toBoardProps는 Dashboard.tsx에서 export한다. 이 파일이 이미 그것을 임포트해
// 쓰고 있다면 그대로 쓰고, 아니면 `import { toBoardProps } from "../Dashboard";`를 더한다.
describe("toBoardProps — 예보", () => {
  /** toBoardProps가 읽는 최소 필드만 담은 입력. 나머지는 이 검사와 무관하다. */
  const data = (forecast: ForecastResponse | null) => ({
    observation: {
      observed_at: new Date().toISOString(), rain_mm_per_hr: 0, temp_c: 23, feels_c: 24,
      wind_ms: 2, humidity_pct: 50, snow_new_cm: 0, missing: false,
    },
    history: [],
    openEvents: [],
    dispatches: [],
    criteria: [{ kind: "rain", grade: "watch", threshold: { rain_mm_per_hr: 20 } }],
    forecast,
  });

  it("지표마다 예보 값을 뽑아 넘긴다", () => {
    const props = toBoardProps(data(FCST) as never, "곤지암", new Date());
    expect(props.metrics.find((m) => m.key === "temp")!.forecast.length).toBeGreaterThan(0);
  });

  it("예보가 없으면 빈 배열이다", () => {
    const props = toBoardProps(data(null) as never, "곤지암", new Date());
    expect(props.metrics.every((m) => m.forecast.length === 0)).toBe(true);
  });

  // 체감온도는 예보에 없다(스펙 §3 함정 3). 없는 값을 기온으로 대신 채우면
  // 차트가 실제와 다른 선을 그리고, 그것이 예보처럼 읽힌다.
  it("체감온도 지표의 예보는 비어 있다", () => {
    const props = toBoardProps(data(FCST) as never, "곤지암", new Date());
    expect(props.metrics.find((m) => m.key === "feels")!.forecast).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd apps/web && npx vitest run src/pages/__tests__/DashboardBoard.test.tsx`
Expected: FAIL

- [ ] **Step 3: `toBoardProps`에 예보를 넘긴다**

`apps/web/src/pages/Dashboard.tsx`의 `toBoardProps` 안, `metrics` 매핑에 추가한다:

```tsx
/** 월보드 지표별로 어느 예보 필드를 잇는가. 체감온도는 예보에 없어서 뺀다 —
 *  없는 값을 0으로 채우면 차트가 0℃까지 떨어지는 거짓 예보를 그린다. */
const FORECAST_FIELD: Partial<Record<BoardMetric["key"], keyof ForecastHour>> = {
  rain: "pcp_mm", temp: "temp_c", wind: "wsd_ms",
};
```

`METRIC_DEFS.map` 안 `return { ... }`에 추가:

```tsx
      forecast: (() => {
        const field = FORECAST_FIELD[def.key];
        if (!field || !data?.forecast) return [];
        return data.forecast.hourly
          .map((h) => h[field] as number | null)
          .filter((v): v is number => v !== null);
      })(),
```

`toBoardProps`의 반환에 추가:

```tsx
    forecast: data?.forecast ?? null,
```

`BoardMetric` 타입(`DashboardBoard.tsx`)에 추가:

```tsx
  /** 앞으로의 예보. 없으면 빈 배열이고, 그때 차트는 지금과 똑같이 그린다. */
  forecast: number[];
```

- [ ] **Step 4: 월보드를 그린다**

`DashboardBoard.tsx` import에 추가:

```tsx
import { ForecastStrip } from "../components/ForecastStrip";
import { ForecastDaily } from "../components/ForecastDaily";
import { ForecastBanner } from "../components/ForecastBanner";
import type { ForecastResponse } from "../lib/api/forecast";
```

`DashboardBoardProps`에 추가:

```tsx
  /** 예보. null이면 예보 블록만 빠지고 나머지는 그대로 그린다. */
  forecast: ForecastResponse | null;
```

특보 배너 블록(`{events.length > 0 && ( … )}`) **바로 아래**에 예고 배너를 넣는다:

```tsx
      {/* 특보 배너와 **같은 줄이 아니라 바로 아래**에 둔다. 나란히 두면 벽에서
          두 배너가 한 덩어리로 읽혀 "예고"와 "실제"의 구분이 사라진다. */}
      {forecast && <ForecastBanner upcoming={forecast.upcoming} compact />}
```

`<div className="bd-cards">` 안 `<MetricChart …>`에 prop을 추가한다:

```tsx
                forecast={m.forecast}
```

`</div>`(bd-cards) **바로 아래**, `<BoardTicker …>` **위**에 넣는다:

```tsx
      {forecast?.stale && (
        <div className="bd-alarm" role="status">
          <span className="bd-alarm-title">예보를 받지 못하고 있습니다</span>
          <span className="bd-alarm-detail">아래 예보는 갱신되지 않은 값입니다</span>
        </div>
      )}
      {/* 월보드에는 미는 사람이 없다. density="spread"가 3시간 간격으로 솎아
          48시간을 16칸에 전부 펼친다 — 스크롤 컨테이너가 붙지 않는다. */}
      {forecast && <ForecastStrip hours={forecast.hourly} density="spread" />}
      {forecast && (
        <div className="bd-daily">
          <ForecastDaily days={forecast.daily} />
        </div>
      )}
```

`DashboardBoard.css`에 추가:

```css
/* 월보드는 스크롤 없이 한 화면에 들어가야 한다. 세로가 부족하면 5일 줄부터
   접는다 — 벽걸이 앞에 선 사람의 지금 행동을 가장 덜 바꾸는 정보다.
   16:9 큰 화면에서는 전부 들어간다. */
@media (max-height: 900px) {
  .bd-daily { display: none; }
}
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd apps/web && npx vitest run && npm run build`
Expected: 전건 PASS · 빌드 성공

- [ ] **Step 6: 변이로 확인한다**

`density="spread"`를 `density="scroll"`로 바꾸고 돌린다.
Expected: `가로 스크롤을 쓰지 않는다`와 `48시간을 3시간 간격 16칸으로 펼친다`가 FAIL.
확인 후 **되돌린다.**

`FORECAST_FIELD`에 `feels: "temp_c"`를 추가하고 돌린다.
Expected: `체감온도 지표의 예보는 비어 있다`가 FAIL. 확인 후 **되돌린다.**

- [ ] **Step 7: 전체를 돌린다**

```bash
cd server && npx vitest run && npm run typecheck
cd ../apps/web && npm test && npm run build
```

Expected: 서버 전건 PASS · 타입 오류 0 · 웹 전건 PASS · 빌드 성공

- [ ] **Step 8: 실제로 띄워 눈으로 본다**

```bash
cd ~/weather-trial && git pull && docker compose up -d --build
curl -s localhost:8090/api/health/deep
```

확인할 것:
- `warnings`에 예보 항목이 있거나(첫 수집 전) 비어 있다
- `reasons`는 전과 같다 — **예보 때문에 새 사유가 늘지 않았다**
- 브라우저에서 대시보드와 월보드(전체화면)를 열어 스트립·5일·배너를 눈으로 본다
- 월보드에서 **가로 스크롤바가 보이지 않는다**

- [ ] **Step 9: 커밋**

```bash
git add apps/web/src/pages/DashboardBoard.tsx apps/web/src/pages/DashboardBoard.css \
        apps/web/src/pages/Dashboard.tsx apps/web/src/pages/__tests__/DashboardBoard.test.tsx
git commit -m "feat(web): 월보드가 스크롤 없이 48시간과 5일을 함께 보여준다"
```

---

## 마무리 점검

전부 끝난 뒤 한 번에 확인한다.

- [ ] `cd server && npx vitest run && npm run typecheck` — 전건 PASS, 타입 오류 0
- [ ] `cd apps/web && npm test && npm run build` — 전건 PASS, 빌드 성공
- [ ] `git status` — **저장소 루트에서** 확인한다. `server/`나 `apps/web/` 안에서
      경로 필터를 걸면 그 하위에서만 찾아 아무것도 없다고 잘못 읽는다(이 저장소에서
      네 번 반복된 실수다)
- [ ] `jobs/send.ts`와 `jobs/remindTick.ts`가 **한 줄도 바뀌지 않았다**:
      `git diff --stat main -- server/src/jobs/send.ts server/src/jobs/remindTick.ts` → 빈 출력
- [ ] `/api/health/deep`의 `reasons`가 이 작업 전과 같다 (예보가 새 사유를 만들지 않았다)
- [ ] `README.md`의 아키텍처 그림에 `forecast-tick` 한 줄을 추가한다
- [ ] `docs/운영.md` §3-3에 `warnings` 칸이 무엇인지 두세 줄로 적는다 —
      운영자가 처음 보는 필드를 설명 없이 마주치면 안 된다
