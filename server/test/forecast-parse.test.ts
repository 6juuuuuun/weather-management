import { describe, expect, it } from "vitest";
import { parseAmount, parseForecastResponse, forecastBaseDateTime, buildForecastUrl } from "../src/shared/forecast.ts";

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
