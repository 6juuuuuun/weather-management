import { assertEquals } from "jsr:@std/assert";
import { baseDateTime, buildKmaUrl, parseKmaResponse } from "./kma.ts";

Deno.test("baseDateTime: 정시+10분 전이면 이전 시각", () => {
  assertEquals(baseDateTime(new Date("2026-08-12T08:05:00+09:00")),
    { baseDate: "20260812", baseTime: "0700" });
  assertEquals(baseDateTime(new Date("2026-08-12T08:20:00+09:00")),
    { baseDate: "20260812", baseTime: "0800" });
  assertEquals(baseDateTime(new Date("2026-08-12T00:05:00+09:00")),
    { baseDate: "20260811", baseTime: "2300" });
});

Deno.test("parseKmaResponse: 카테고리 추출", () => {
  const json = { response: { header: { resultCode: "00" }, body: { items: { item: [
    { category: "RN1", obsrValue: "32.5", baseDate: "20260812", baseTime: "0800" },
    { category: "T1H", obsrValue: "28.4" }, { category: "WSD", obsrValue: "9.2" },
    { category: "REH", obsrValue: "83" },  { category: "PTY", obsrValue: "1" },
  ] } } } };
  const o = parseKmaResponse(json);
  assertEquals(o.rainMmPerHr, 32.5);
  assertEquals(o.tempC, 28.4);
  assertEquals(o.windMs, 9.2);
  assertEquals(o.humidityPct, 83);
  assertEquals(o.pty, 1);
});

Deno.test("buildKmaUrl: Decoding 키(원문)를 그대로 인코딩해 사용", () => {
  const decodingKey = "abc+def==/ghi";
  const url = buildKmaUrl(decodingKey, 60, 127, "20260812", "0800");
  assertEquals(url.includes(`serviceKey=${encodeURIComponent(decodingKey)}`), true);
});

Deno.test("buildKmaUrl: Encoding 키를 넣어도 Decoding 키와 동일한 URL로 정규화", () => {
  const decodingKey = "abc+def==/ghi";
  const encodingKey = encodeURIComponent(decodingKey); // 사용자가 실수로 Encoding 키를 넣은 상황 재현
  const urlFromDecoding = buildKmaUrl(decodingKey, 60, 127, "20260812", "0800");
  const urlFromEncoding = buildKmaUrl(encodingKey, 60, 127, "20260812", "0800");
  assertEquals(urlFromEncoding, urlFromDecoding);
});
