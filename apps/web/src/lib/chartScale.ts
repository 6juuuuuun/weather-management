// 차트의 축 계산. SVG를 그리기 전에 여기서 모든 판단을 끝낸다.
//
// 적응형인 이유: 축을 0~임계로 고정하면 곤지암 기온처럼 24시간 폭이 5℃뿐인 값은
// 선이 거의 직선이 되어 추이를 못 읽는다. 반대로 데이터 범위에만 맞추면 임계가
// 화면 밖이라 근접도를 못 보여준다. 그래서 평소엔 데이터 범위를 쓰되 임계가
// 사정권에 들면 스케일에 포함한다 — 위험해질수록 기준선이 시야로 들어온다.

/** 임계를 스케일에 포함할지 판단하는 여유폭 (데이터 폭 대비) */
const THRESHOLD_REACH = 0.7;
/** 스케일 상하 여유 (데이터 폭 대비) */
const PADDING_RATIO = 0.15;
/** 값이 전부 같을 때 물리량 축의 상한 (임계 대비) */
const FLAT_HEADROOM = 0.35;

export type ScaleResult = {
  lo: number;
  hi: number;
  /** 값이 전부 같아 추이가 없는 상태 */
  flat: boolean;
  /** 기준선을 그릴 수 있는지 (lo..hi 안에 임계가 들어왔는지) */
  thresholdVisible: boolean;
};

export function computeScale(values: number[], threshold: number, allowNegative: boolean): ScaleResult {
  if (values.length === 0) {
    const lo = allowNegative ? -1 : 0;
    const hi = Math.max(threshold * FLAT_HEADROOM, lo + 1);
    return { lo, hi, flat: true, thresholdVisible: lo <= threshold && threshold <= hi };
  }

  let lo = Math.min(...values);
  let hi = Math.max(...values);

  if (hi - lo < 1e-9) {
    // 전부 같은 값. 억지로 벌리면 강수량 축이 -1.3mm 같은 불가능한 값이 된다.
    lo = allowNegative ? lo - 1 : 0;
    hi = allowNegative ? hi + 1 : Math.max(threshold * FLAT_HEADROOM, lo + 1);
    return { lo, hi, flat: true, thresholdVisible: lo <= threshold && threshold <= hi };
  }

  const span = hi - lo;
  const reach = span * THRESHOLD_REACH;
  // 사정권 판정은 양방향이어야 한다. `threshold <= hi + reach` 하나로만 쓰면
  // 임계가 lo 아래에 있을 때 우변이 언제나 임계보다 커서 거리와 무관하게 포함된다
  // (하루 종일 임계를 웃돈 날 축이 불필요하게 넓어져 추이가 눌린다).
  const nearEnough =
    threshold > hi ? threshold - hi <= reach
    : threshold < lo ? lo - threshold <= reach
    : true; // 이미 데이터 범위 안
  if (nearEnough) {
    hi = Math.max(hi, threshold);
    lo = Math.min(lo, threshold);
  }

  const pad = (hi - lo) * PADDING_RATIO;
  lo -= pad;
  hi += pad;
  if (!allowNegative) {
    lo = Math.max(0, lo);
    // 입력이 전부 음수인 채로 들어오면(결측 센티널 등) lo만 0으로 잡혀 범위가 뒤집힌다
    if (hi <= lo) hi = lo + 1;
  }

  return { lo, hi, flat: false, thresholdVisible: lo <= threshold && threshold <= hi };
}

export function yOf(
  value: number, lo: number, hi: number, height: number, padTop: number, padBottom: number,
): number {
  const span = hi - lo || 1;
  return padTop + (height - padTop - padBottom) * (1 - (value - lo) / span);
}
