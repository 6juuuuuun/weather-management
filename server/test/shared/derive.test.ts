// 이관 전 원본(supabase/functions/_shared/derive_test.ts, git 기록)에서 이관. assertAlmostEquals는
// toBeCloseTo가 아니라 허용오차를 그대로 쓰는 비교로 옮겼다 — toBeCloseTo의
// 인자는 자릿수라서 원본의 ±0.5 허용치를 그대로 표현할 수 없다.
import { describe, expect, it } from "vitest";
import { feelsLikeC, snowNewCm } from "../../src/shared/derive.ts";

describe("파생값", () => {
  it("여름 체감온도: 33℃/60%/2m·s ≈ 33.5±0.5", () => {
    expect(Math.abs(feelsLikeC(33, 60, 2) - 33.5)).toBeLessThanOrEqual(0.5);
  });
  it("겨울 체감온도: -10℃/풍속 5m·s ≈ -17.4±0.5", () => {
    expect(Math.abs(feelsLikeC(-10, 50, 5) - -17.4)).toBeLessThanOrEqual(0.5);
  });
  it("신적설 환산: 눈(PTY=3)이면 3mm→3cm, 비(PTY=1)면 0, null이면 null", () => {
    expect(snowNewCm(3, 3)).toBe(3);
    expect(snowNewCm(3, 1)).toBe(0);
    expect(snowNewCm(null, 3)).toBe(null);
  });
});
