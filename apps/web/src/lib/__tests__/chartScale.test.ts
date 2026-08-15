import { describe, expect, it } from "vitest";
import { computeScale, yOf } from "../chartScale";

describe("computeScale", () => {
  // 시안에서 실제로 발생: 강수 24시간 전부 0인데 축이 -1.3mm까지 내려갔다.
  it("음수가 없는 물리량은 축 하한이 0 아래로 내려가지 않는다", () => {
    const r = computeScale([0, 0, 0, 0], 20, false);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(0);
    expect(r.flat).toBe(true);
  });

  it("기온처럼 음수가 실재하는 값은 하한이 음수여도 된다", () => {
    const r = computeScale([-3, -3, -3], 33, true);
    expect(r.lo).toBeLessThan(-3);
    expect(r.flat).toBe(true);
  });

  it("값이 전부 같으면 flat이고 lo<hi를 보장한다", () => {
    const r = computeScale([5, 5, 5], 20, false);
    expect(r.flat).toBe(true);
    expect(r.hi).toBeGreaterThan(r.lo);
  });

  // 적응형: 임계가 사정권(데이터 폭의 60% 이내)이면 스케일에 포함해 기준선이 보인다
  it("임계가 사정권이면 스케일에 포함하고 thresholdVisible이 참", () => {
    const r = computeScale([28, 29, 30, 31], 33, true);
    expect(r.hi).toBeGreaterThanOrEqual(33);
    expect(r.thresholdVisible).toBe(true);
  });

  it("임계가 멀면 스케일에 넣지 않고 thresholdVisible이 거짓", () => {
    const r = computeScale([1, 2, 2.5, 2], 14, false);
    expect(r.hi).toBeLessThan(14);
    expect(r.thresholdVisible).toBe(false);
  });

  it("임계를 이미 넘긴 경우에도 기준선이 보인다", () => {
    const r = computeScale([18, 22, 31, 28], 20, false);
    expect(r.lo).toBeLessThanOrEqual(20);
    expect(r.hi).toBeGreaterThanOrEqual(20);
    expect(r.thresholdVisible).toBe(true);
  });

  it("값이 하나뿐이어도 유효한 범위를 돌려준다", () => {
    const r = computeScale([7], 20, false);
    expect(r.hi).toBeGreaterThan(r.lo);
    expect(r.lo).toBe(0);
  });

  // 회귀: 예전 조건은 임계가 lo보다 아래면 거리와 무관하게 포함해, 축이 폭증했다.
  it("임계가 데이터보다 한참 아래면 스케일에 넣지 않는다", () => {
    const r = computeScale([100, 110], 5, true);
    expect(r.thresholdVisible).toBe(false);
    expect(r.lo).toBeGreaterThan(50);
  });

  it("음수 입력이 들어와도 lo <= hi 를 지킨다", () => {
    const r = computeScale([-5, -3], 20, false);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(r.lo);
  });

  it("패딩이 0 아래로 내려가는 경우 하한을 0으로 자른다", () => {
    // 패딩 없이는 lo가 0.05 - (4.95*0.15) = -0.69 가 된다
    const r = computeScale([0.05, 0.1, 5], 50, false);
    expect(r.lo).toBe(0);
  });

  // 회귀: flat 분기가 비음수에서 hi를 임계의 35%로 고정해, 값이 0이 아니면
  // 축 위로 벗어났다(풍속 6m/s 고정 → hi 4.9).
  it("값이 전부 동일하고 0이 아니어도 값이 축 안에 들어온다", () => {
    for (const [v, thr] of [[15, 20], [6, 14], [28, 33]] as const) {
      const r = computeScale([v, v, v], thr, false);
      expect(r.lo).toBeLessThanOrEqual(v);
      expect(r.hi).toBeGreaterThanOrEqual(v);
    }
  });

  // threshold가 null이면 기준 미설정이다(값 0을 임계처럼 취급하면 안 된다).
  // 포함 판정을 건너뛰어도 축은 여전히 유효해야 한다.
  it("threshold가 null이면 기준선을 스케일에 넣지 않고도 유효한 범위를 돌려준다", () => {
    const r = computeScale([0, 0, 0], null, false);
    expect(r.thresholdVisible).toBe(false);
    expect(r.hi).toBeGreaterThan(r.lo);
    expect(Number.isFinite(r.lo)).toBe(true);
    expect(Number.isFinite(r.hi)).toBe(true);
  });
});

describe("yOf", () => {
  it("최댓값은 위쪽 패딩에, 최솟값은 아래쪽 패딩에 놓인다", () => {
    expect(yOf(10, 0, 10, 100, 20, 20)).toBeCloseTo(20);
    expect(yOf(0, 0, 10, 100, 20, 20)).toBeCloseTo(80);
  });

  it("lo와 hi가 같아도 0으로 나누지 않는다", () => {
    const y = yOf(5, 5, 5, 100, 20, 20);
    expect(Number.isFinite(y)).toBe(true);
  });
});
