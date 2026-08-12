import { assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { feelsLikeC, snowNewCm } from "./derive.ts";

Deno.test("여름 체감온도: 33℃/60%/2m·s ≈ 33.5±0.5", () => {
  assertAlmostEquals(feelsLikeC(33, 60, 2), 33.5, 0.5);
});
Deno.test("겨울 체감온도: -10℃/풍속 5m·s ≈ -17.4±0.5", () => {
  assertAlmostEquals(feelsLikeC(-10, 50, 5), -17.4, 0.5);
});
Deno.test("신적설 환산: 눈(PTY=3)이면 3mm→3cm, 비(PTY=1)면 0, null이면 null", () => {
  assertEquals(snowNewCm(3, 3), 3);
  assertEquals(snowNewCm(3, 1), 0);
  assertEquals(snowNewCm(null, 3), null);
});
