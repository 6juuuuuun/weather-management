# 월보드(전체화면 대시보드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드를 `?board=1`로 전체화면 관망 모드로 전환해, 상황실 벽걸이와 관리자 PC가 같은 화면을 공용한다.

**Architecture:** 라우트는 `/` 하나를 유지하고 URL 파라미터로 모드를 가른다. 순수 계산(차트 스케일·티커 문구)을 먼저 별도 모듈로 분리해 단위 테스트로 고정한 뒤, 그 위에 표시 컴포넌트를 얹는다. 데이터 로딩은 기존 `Dashboard.tsx`의 `load`를 훅으로 추출해 두 모드가 공유한다.

**Tech Stack:** React 18 + TypeScript + Vite, Vitest + @testing-library/react, 인라인 SVG(차트 라이브러리 없음), Supabase JS v2

**Spec:** `docs/superpowers/specs/2026-08-15-wallboard-design.md`

## Global Constraints

- 주석·커밋 메시지는 한국어. 코드 주석은 "무엇을"이 아니라 "왜"를 설명한다.
- 작업 범위는 `apps/web/src/`. supabase/ 아래는 건드리지 않는다.
- **`DESIGN-apple.md` 준수** — 장식 띠 금지, 카드 그림자 금지, 장식 그라데이션 금지, 반경은 `rounded.lg`(18px)와 pill만 사용, 두 번째 강조색 금지.
- 월보드의 주의보 색은 `--warn-strong (#ff9500)`. `--warn (#a65a00)`은 경보와 색각이상에서 구분되지 않으므로 월보드에서 쓰지 않는다.
- UI 표기는 "특보". 폰트 가중치는 300/400/600만 사용(500 금지).
- 외부 차트 라이브러리를 추가하지 않는다.
- 기존 대시보드(보드 모드가 아닐 때)의 동작·외관은 바뀌지 않아야 한다.

**테스트 명령** (Supabase 스택 불필요 — 전부 모킹):
```bash
cd /Users/ojun/orca/Weather/apps/web
npx vitest run              # 전체
npx tsc -b                  # 타입체크
npm run build               # 빌드
```

---

### Task 1: 차트 스케일 계산 (순수 함수)

차트의 모든 판단(축 범위, 임계 포함 여부, 평탄 여부)을 순수 함수로 분리한다. SVG를 그리기 전에 이 계산부터 고정해야 시안에서 발견한 결함(음수 축 등)이 재발하지 않는다.

**Files:**
- Create: `apps/web/src/lib/chartScale.ts`
- Test: `apps/web/src/lib/__tests__/chartScale.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ScaleResult = { lo: number; hi: number; flat: boolean; thresholdVisible: boolean };
  export function computeScale(values: number[], threshold: number, allowNegative: boolean): ScaleResult;
  export function yOf(value: number, lo: number, hi: number, height: number, padTop: number, padBottom: number): number;
  ```
  Task 2가 둘 다 소비한다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/lib/__tests__/chartScale.test.ts`:

```ts
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
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/lib/__tests__/chartScale.test.ts`
Expected: FAIL — `Failed to resolve import "../chartScale"` (모듈 없음)

- [ ] **Step 3: 구현한다**

`apps/web/src/lib/chartScale.ts`:

```ts
// 차트의 축 계산. SVG를 그리기 전에 여기서 모든 판단을 끝낸다.
//
// 적응형인 이유: 축을 0~임계로 고정하면 곤지암 기온처럼 24시간 폭이 5℃뿐인 값은
// 선이 거의 직선이 되어 추이를 못 읽는다. 반대로 데이터 범위에만 맞추면 임계가
// 화면 밖이라 근접도를 못 보여준다. 그래서 평소엔 데이터 범위를 쓰되 임계가
// 사정권에 들면 스케일에 포함한다 — 위험해질수록 기준선이 시야로 들어온다.

/** 임계를 스케일에 포함할지 판단하는 여유폭 (데이터 폭 대비) */
const THRESHOLD_REACH = 0.6;
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
  if (threshold <= hi + span * THRESHOLD_REACH) {
    hi = Math.max(hi, threshold);
    lo = Math.min(lo, threshold);
  }

  const pad = (hi - lo) * PADDING_RATIO;
  lo -= pad;
  hi += pad;
  if (!allowNegative) lo = Math.max(0, lo);

  return { lo, hi, flat: false, thresholdVisible: lo <= threshold && threshold <= hi };
}

export function yOf(
  value: number, lo: number, hi: number, height: number, padTop: number, padBottom: number,
): number {
  const span = hi - lo || 1;
  return padTop + (height - padTop - padBottom) * (1 - (value - lo) / span);
}
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/lib/__tests__/chartScale.test.ts && npx tsc -b`
Expected: 8건 PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/lib/chartScale.ts apps/web/src/lib/__tests__/chartScale.test.ts
git commit -m "feat(web): 월보드 차트의 적응형 축 계산 추가

평소엔 데이터 범위, 임계가 사정권에 들면 기준선을 스케일에 포함한다.
강수·풍속·적설은 축 하한을 0으로 고정 — 시안에서 전부 0인 날 축이
-1.3mm까지 내려가는 것을 확인했다."
```

---

### Task 2: 지표 차트 컴포넌트

Task 1의 계산 위에 인라인 SVG를 그린다. 임계 위아래를 다른 색으로 칠하는 것이 이 차트의 핵심이다.

**Files:**
- Create: `apps/web/src/components/MetricChart.tsx`
- Create: `apps/web/src/components/MetricChart.css`
- Test: `apps/web/src/components/__tests__/MetricChart.test.tsx`

**Interfaces:**
- Consumes: `computeScale`, `yOf` (Task 1)
- Produces:
  ```ts
  export type MetricChartProps = {
    values: number[];
    threshold: number;
    unit: string;
    /** 기준선 라벨의 등급 표기 */
    gradeLabel: string;
    /** 음수가 실재하는 값인지 (기온·체감온도만 true) */
    allowNegative: boolean;
    /** 현재 상태 색 */
    tone: "calm" | "near" | "over";
  };
  export function MetricChart(props: MetricChartProps): JSX.Element;
  ```
  Task 4가 소비한다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/components/__tests__/MetricChart.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MetricChart } from "../MetricChart";

function svgOf(container: HTMLElement) {
  const el = container.querySelector("svg");
  if (!el) throw new Error("svg가 렌더되지 않았다");
  return el;
}

describe("MetricChart", () => {
  it("데이터가 있으면 선 경로를 그린다", () => {
    const { container } = render(
      <MetricChart values={[1, 2, 3]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelector("path.mc-line")).toBeTruthy();
  });

  it("임계가 사정권이면 기준선과 라벨을 그린다", () => {
    const { container, getByText } = render(
      <MetricChart values={[18, 19, 20]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="over" />,
    );
    expect(svgOf(container).querySelector("line.mc-threshold")).toBeTruthy();
    expect(getByText("주의보 20mm")).toBeTruthy();
  });

  it("임계가 멀면 기준선을 그리지 않는다", () => {
    const { container } = render(
      <MetricChart values={[1, 2, 2.5]} threshold={14} unit="m/s" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelector("line.mc-threshold")).toBeNull();
  });

  // 임계 위아래를 나눠 칠하는 것이 이 차트의 존재 이유다.
  // 현재값이 안전해도 오늘 몇 번 넘었는지가 색으로 남아야 한다.
  it("임계를 넘긴 구간이 있으면 위아래를 나눠 칠한다", () => {
    const { container } = render(
      <MetricChart values={[5, 25, 8]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelectorAll("path.mc-area-below").length).toBe(1);
    expect(svgOf(container).querySelectorAll("path.mc-area-above").length).toBe(1);
  });

  it("한 번도 넘지 않았으면 초과 영역을 그리지 않는다", () => {
    const { container } = render(
      <MetricChart values={[5, 8, 6]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelector("path.mc-area-above")).toBeNull();
  });

  // 비가 한 방울도 안 온 날 면적이 차 있으면 "쌓여 있다"로 오독된다.
  it("값이 전부 0이면 면적을 칠하지 않고 변화 없음을 표시한다", () => {
    const { container, getByText } = render(
      <MetricChart values={[0, 0, 0]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelector("path.mc-area-below")).toBeNull();
    expect(getByText("변화 없음")).toBeTruthy();
  });

  it("데이터가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(
      <MetricChart values={[]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });

  it("점이 하나뿐이면 선 대신 점만 그린다", () => {
    const { container } = render(
      <MetricChart values={[7]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    expect(svgOf(container).querySelector("path.mc-line")).toBeNull();
    expect(svgOf(container).querySelector("circle.mc-dot")).toBeTruthy();
  });

  it("tone에 따라 선 색 클래스가 바뀐다", () => {
    const { container } = render(
      <MetricChart values={[30, 31]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="over" />,
    );
    expect(svgOf(container).querySelector("path.mc-line")?.getAttribute("class")).toContain("mc-tone-over");
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/components/__tests__/MetricChart.test.tsx`
Expected: FAIL — `Failed to resolve import "../MetricChart"`

- [ ] **Step 3: 구현한다**

`apps/web/src/components/MetricChart.tsx`:

```tsx
import { computeScale, yOf } from "../lib/chartScale";
import "./MetricChart.css";

// 보드 카드 안 비율. viewBox를 늘려 쓰지 않는다 — 늘리면 선뿐 아니라
// 축 라벨 글자까지 세로로 찌그러진다(시안에서 확인).
const W = 840;
const H = 196;
const PAD_T = 22;
const PAD_B = 18;

export type MetricChartProps = {
  values: number[];
  threshold: number;
  unit: string;
  gradeLabel: string;
  allowNegative: boolean;
  tone: "calm" | "near" | "over";
};

function fmt(v: number): string {
  return Number(v.toFixed(2)).toString();
}

export function MetricChart({
  values, threshold, unit, gradeLabel, allowNegative, tone,
}: MetricChartProps) {
  if (values.length === 0) return <div className="mc-empty" />;

  const { lo, hi, flat, thresholdVisible } = computeScale(values, threshold, allowNegative);
  const pts = values.map((v, i) => ({
    x: values.length === 1 ? W / 2 : (i * W) / (values.length - 1),
    y: yOf(v, lo, hi, H, PAD_T, PAD_B),
  }));
  const last = pts[pts.length - 1];
  const line = "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L");
  const area = `${line} L${last.x.toFixed(1)},${H} L${pts[0].x.toFixed(1)},${H} Z`;
  const ty = yOf(threshold, lo, hi, H, PAD_T, PAD_B);

  const allZero = values.every((v) => v === 0);
  const everOver = Math.max(...values) >= threshold;
  const clipId = `mc-lo-${tone}-${values.length}-${Math.round(lo * 100)}`;
  const clipHiId = `mc-hi-${tone}-${values.length}-${Math.round(hi * 100)}`;

  return (
    <svg className="mc" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
      {!allZero && everOver && thresholdVisible && (
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y={ty} width={W} height={H} />
          </clipPath>
          <clipPath id={clipHiId}>
            <rect x="0" y="0" width={W} height={ty} />
          </clipPath>
        </defs>
      )}

      {thresholdVisible && (
        <>
          <line className="mc-threshold" x1="0" y1={ty} x2={W} y2={ty} />
          {/* 라벨은 좌측. 우측은 최신값 점이 있어 겹친다(시안에서 확인). */}
          <rect className="mc-chip" x="0" y={ty - 23} width="96" height="20" rx="4" />
          <text className="mc-thrlabel" x="6" y={ty - 9}>
            {gradeLabel} {fmt(threshold)}{unit}
          </text>
        </>
      )}

      {!allZero && (
        everOver && thresholdVisible ? (
          <>
            <path className="mc-area-below" d={area} clipPath={`url(#${clipId})`} />
            <path className={`mc-area-above mc-fill-${tone === "calm" ? "near" : tone}`} d={area}
                  clipPath={`url(#${clipHiId})`} />
          </>
        ) : (
          <path className={`mc-area-below mc-fill-${tone}`} d={area} />
        )
      )}

      {values.length > 1 && <path className={`mc-line mc-tone-${tone}`} d={line} />}
      <circle className={`mc-dot mc-tone-${tone}`} cx={last.x} cy={last.y} r="6" />

      <text className="mc-axis" x="0" y="12">{fmt(hi)}</text>
      <text className="mc-axis" x="0" y={H - 3}>{fmt(lo)}</text>
      {flat && <text className="mc-flat" x="8" y={H / 2 - 10}>변화 없음</text>}
    </svg>
  );
}
```

`apps/web/src/components/MetricChart.css`:

```css
/* 월보드 지표 차트. DESIGN-apple.md 준수 — 장식 그라데이션을 쓰지 않고
   평면 반투명으로 채운다. 그림자 없음. */

.mc {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}

.mc-empty {
  min-height: 40px;
}

.mc-line {
  fill: none;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mc-dot {
  stroke: var(--canvas);
  stroke-width: 2.5;
}

/* 월보드는 --warn이 아니라 --warn-strong을 쓴다.
   --warn(#a65a00)은 --danger와 색각이상에서 ΔE 1.6으로 구분되지 않는다. */
.mc-tone-calm { stroke: var(--ink-muted-48); }
.mc-tone-near { stroke: var(--warn-strong); }
.mc-tone-over { stroke: var(--danger); }

circle.mc-tone-calm { fill: var(--ink-muted-48); stroke: var(--canvas); }
circle.mc-tone-near { fill: var(--warn-strong); stroke: var(--canvas); }
circle.mc-tone-over { fill: var(--danger); stroke: var(--canvas); }

.mc-area-below { fill: var(--ink-muted-48); opacity: 0.1; }
.mc-fill-calm { fill: var(--ink-muted-48); opacity: 0.1; }
.mc-fill-near { fill: var(--warn-strong); opacity: 0.26; }
.mc-fill-over { fill: var(--danger); opacity: 0.26; }

.mc-threshold {
  stroke: var(--ink-muted-48);
  stroke-width: 1;
  stroke-dasharray: 4 5;
}

.mc-chip { fill: var(--canvas); opacity: 0.88; }

.mc-thrlabel {
  font-size: 14px;
  font-weight: 600;
  fill: var(--ink-muted-48);
}

.mc-axis {
  font-size: 14px;
  fill: var(--ink-muted-48);
}

.mc-flat {
  font-size: 16px;
  fill: var(--ink-muted-48);
}
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/components/__tests__/MetricChart.test.tsx && npx tsc -b`
Expected: 9건 PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/components/MetricChart.tsx apps/web/src/components/MetricChart.css apps/web/src/components/__tests__/MetricChart.test.tsx
git commit -m "feat(web): 월보드 지표 차트 컴포넌트

임계 위아래를 나눠 칠해, 현재값이 안전해도 오늘 몇 번 얼마나 넘었는지가
색으로 남는다. 장식 그라데이션 대신 평면 반투명(DESIGN-apple.md).
주의보 색은 --warn-strong — --warn은 경보와 색각이상에서 구분되지 않는다."
```

---

### Task 3: 티커 문구 계산과 컴포넌트

임계까지 남은 거리(또는 초과분)를 문장으로 만든다. 계산을 순수 함수로 분리해 테스트한다.

**Files:**
- Create: `apps/web/src/components/BoardTicker.tsx`
- Create: `apps/web/src/components/BoardTicker.css`
- Test: `apps/web/src/components/__tests__/BoardTicker.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type TickerItem = {
    label: string;      // "시간당 강수량"
    value: number;
    unit: string;       // "mm"
    threshold: number;
    gradeLabel: string; // "폭우 주의보"
  };
  export function gapPhrase(item: TickerItem): { text: string; over: boolean };
  export function BoardTicker(props: { items: TickerItem[] }): JSX.Element;
  ```
  Task 4가 소비한다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/components/__tests__/BoardTicker.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BoardTicker, gapPhrase } from "../BoardTicker";
import type { TickerItem } from "../BoardTicker";

const rain: TickerItem = {
  label: "시간당 강수량", value: 0, unit: "mm", threshold: 20, gradeLabel: "폭우 주의보",
};

describe("gapPhrase", () => {
  it("미달이면 남은 거리를 말한다", () => {
    const r = gapPhrase({ ...rain, value: 8 });
    expect(r.text).toBe("폭우 주의보까지 12.0mm");
    expect(r.over).toBe(false);
  });

  it("초과면 초과분을 말한다", () => {
    const r = gapPhrase({ ...rain, value: 31 });
    expect(r.text).toBe("폭우 주의보 기준 초과 +11.0mm");
    expect(r.over).toBe(true);
  });

  it("정확히 임계면 초과로 본다 (판정 엔진이 >= 로 판단한다)", () => {
    expect(gapPhrase({ ...rain, value: 20 }).over).toBe(true);
  });

  it("소수 첫째 자리까지만 쓴다", () => {
    expect(gapPhrase({ ...rain, value: 8.26 }).text).toBe("폭우 주의보까지 11.7mm");
  });
});

describe("BoardTicker", () => {
  it("모든 항목을 렌더링한다", () => {
    const { getAllByText } = render(
      <BoardTicker items={[rain, { ...rain, label: "기온", unit: "℃", threshold: 33, value: 28.9, gradeLabel: "폭염 주의보" }]} />,
    );
    // 끊김 없는 순환을 위해 트랙을 2벌 이어붙이므로 각 항목이 2번 나온다
    expect(getAllByText("시간당 강수량").length).toBe(2);
    expect(getAllByText("기온").length).toBe(2);
  });

  it("초과 항목에 강조 클래스를 붙인다", () => {
    const { container } = render(<BoardTicker items={[{ ...rain, value: 31 }]} />);
    expect(container.querySelectorAll(".bt-over").length).toBeGreaterThan(0);
  });

  it("미달 항목에는 강조 클래스를 붙이지 않는다", () => {
    const { container } = render(<BoardTicker items={[{ ...rain, value: 3 }]} />);
    expect(container.querySelector(".bt-over")).toBeNull();
  });

  it("항목이 없으면 아무것도 렌더링하지 않는다", () => {
    const { container } = render(<BoardTicker items={[]} />);
    expect(container.querySelector(".bt")).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/components/__tests__/BoardTicker.test.tsx`
Expected: FAIL — `Failed to resolve import "../BoardTicker"`

- [ ] **Step 3: 구현한다**

`apps/web/src/components/BoardTicker.tsx`:

```tsx
import "./BoardTicker.css";

export type TickerItem = {
  label: string;
  value: number;
  unit: string;
  threshold: number;
  gradeLabel: string;
};

export function gapPhrase(item: TickerItem): { text: string; over: boolean } {
  // 판정 엔진이 >= 로 초과를 판단하므로(supabase/functions/_shared/engine.ts) 여기도 맞춘다.
  const over = item.value >= item.threshold;
  const diff = Math.abs(item.value - item.threshold).toFixed(1);
  return over
    ? { text: `${item.gradeLabel} 기준 초과 +${diff}${item.unit}`, over: true }
    : { text: `${item.gradeLabel}까지 ${diff}${item.unit}`, over: false };
}

function Row({ items }: { items: TickerItem[] }) {
  return (
    <>
      {items.map((it, i) => {
        const g = gapPhrase(it);
        return (
          <span className="bt-item" key={`${it.label}-${i}`}>
            <b className="bt-label">{it.label}</b>
            <span className="bt-value">
              {Number(it.value.toFixed(1))}
              {it.unit}
            </span>
            <span className={g.over ? "bt-gap bt-over" : "bt-gap"}>· {g.text}</span>
          </span>
        );
      })}
    </>
  );
}

export function BoardTicker({ items }: { items: TickerItem[] }) {
  if (items.length === 0) return null;
  // 트랙을 2벌 이어붙이고 -50% 이동시켜 끊김 없이 순환시킨다.
  return (
    <div className="bt">
      <div className="bt-track">
        <Row items={items} />
        <Row items={items} />
      </div>
    </div>
  );
}
```

`apps/web/src/components/BoardTicker.css`:

```css
/* 하단 티커. 순수 검정은 이 시스템에서 글로벌 네비에만 쓰이므로,
   화면 최하단 띠로서 같은 문법을 따른다(DESIGN-apple.md). */

.bt {
  height: 86px;
  background: var(--surface-black);
  color: #fff;
  display: flex;
  align-items: center;
  overflow: hidden;
  flex-shrink: 0;
}

.bt-track {
  display: flex;
  align-items: center;
  gap: 34px;
  white-space: nowrap;
  padding-left: 56px;
  animation: bt-roll 46s linear infinite;
}

@keyframes bt-roll {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}

/* 화면 낭독기·모션 민감 사용자를 위해 움직임을 끈다 */
@media (prefers-reduced-motion: reduce) {
  .bt-track { animation: none; }
}

.bt-item {
  font-size: 26px;
  font-weight: 300;
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
}

.bt-label {
  font-weight: 400;
  color: #c9c9ce;
}

.bt-value { font-weight: 400; }

.bt-gap { color: #9a9aa0; }

.bt-over {
  color: var(--warn-strong);
  font-weight: 600;
}
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/components/__tests__/BoardTicker.test.tsx && npx tsc -b`
Expected: 8건 PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/components/BoardTicker.tsx apps/web/src/components/BoardTicker.css apps/web/src/components/__tests__/BoardTicker.test.tsx
git commit -m "feat(web): 월보드 하단 티커

임계까지 남은 거리(또는 초과분)를 순환 표시한다. 초과 판정은 판정 엔진과
동일하게 >= 기준. prefers-reduced-motion에서 애니메이션을 끈다."
```

---

### Task 4: 보드 레이아웃 컴포넌트

Task 2·3을 조립한 화면. 데이터는 props로 받아 표시만 한다(로딩은 Task 5).

**Files:**
- Create: `apps/web/src/pages/DashboardBoard.tsx`
- Create: `apps/web/src/pages/DashboardBoard.css`
- Test: `apps/web/src/pages/__tests__/DashboardBoard.test.tsx`

**Interfaces:**
- Consumes: `MetricChart` (Task 2), `BoardTicker`/`TickerItem` (Task 3)
- Produces:
  ```ts
  export type BoardMetric = {
    key: "rain" | "temp" | "wind" | "feels";
    label: string;
    unit: string;
    value: number | null;
    threshold: number;
    gradeLabel: string;
    allowNegative: boolean;
    history: number[];
  };
  export type BoardEvent = {
    id: string;
    title: string;      // "폭우 경보"
    tag: string;        // "승인 대기" | "발송 완료"
    detail: string;     // "13:05 감지 · 초안 5개 부서 · 재알림 2회"
    severe: boolean;    // 경보면 true
  };
  export type DashboardBoardProps = {
    siteName: string;
    clock: string;          // "13:47"
    collectedAgo: string;   // "마지막 수집 2분 전"
    metrics: BoardMetric[];
    events: BoardEvent[];
  };
  export function DashboardBoard(props: DashboardBoardProps): JSX.Element;
  export function statusHeadline(events: BoardEvent[]): { text: string; alert: boolean };
  ```
  Task 5가 소비한다.

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/pages/__tests__/DashboardBoard.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DashboardBoard, statusHeadline } from "../DashboardBoard";
import type { BoardEvent, BoardMetric } from "../DashboardBoard";

const metrics: BoardMetric[] = [
  { key: "rain", label: "시간당 강수량", unit: "mm", value: 0, threshold: 20,
    gradeLabel: "폭우 주의보", allowNegative: false, history: [0, 0, 0] },
  { key: "temp", label: "기온", unit: "℃", value: 28.9, threshold: 33,
    gradeLabel: "폭염 주의보", allowNegative: true, history: [27, 28, 28.9] },
  { key: "wind", label: "풍속", unit: "m/s", value: 2.5, threshold: 14,
    gradeLabel: "강풍 주의보", allowNegative: false, history: [1, 2, 2.5] },
  { key: "feels", label: "체감온도", unit: "℃", value: 29.8, threshold: 31,
    gradeLabel: "폭염 주의보", allowNegative: true, history: [28, 29, 29.8] },
];

const pending: BoardEvent = {
  id: "e1", title: "폭우 경보", tag: "승인 대기",
  detail: "13:05 감지 · 초안 5개 부서 · 재알림 2회", severe: true,
};
const sent: BoardEvent = {
  id: "e2", title: "폭염 경보", tag: "발송 완료",
  detail: "11:05 승인 · 5개 부서 12명 · 반복 3회차", severe: true,
};

function renderBoard(events: BoardEvent[] = []) {
  return render(
    <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="마지막 수집 2분 전"
                    metrics={metrics} events={events} />,
  );
}

describe("statusHeadline", () => {
  it("열린 특보가 없으면 평온", () => {
    expect(statusHeadline([])).toEqual({ text: "평온", alert: false });
  });

  it("승인 대기가 있으면 특보 발생", () => {
    expect(statusHeadline([pending])).toEqual({ text: "특보 발생", alert: true });
  });

  it("전부 발송 완료면 대응 중", () => {
    expect(statusHeadline([sent])).toEqual({ text: "대응 중", alert: true });
  });

  it("승인 대기가 하나라도 있으면 특보 발생이 우선", () => {
    expect(statusHeadline([sent, pending]).text).toBe("특보 발생");
  });
});

describe("DashboardBoard", () => {
  it("사업장·시각·수집 시각을 표시한다", () => {
    const { getByText } = renderBoard();
    expect(getByText("곤지암")).toBeTruthy();
    expect(getByText("13:47")).toBeTruthy();
    expect(getByText("마지막 수집 2분 전")).toBeTruthy();
  });

  it("지표 카드 4장을 렌더링한다", () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll(".bd-card").length).toBe(4);
  });

  it("특보가 없으면 배너를 렌더링하지 않는다", () => {
    const { container } = renderBoard();
    expect(container.querySelector(".bd-events")).toBeNull();
  });

  it("특보가 1건이면 세로 배치", () => {
    const { container } = renderBoard([pending]);
    expect(container.querySelector(".bd-events")?.className).not.toContain("bd-events-row");
  });

  // 세로로 쌓으면 카드가 짧아져 차트가 잘린다(시안에서 실측).
  it("특보가 2건 이상이면 가로 배치", () => {
    const { container } = renderBoard([pending, sent]);
    expect(container.querySelector(".bd-events")?.className).toContain("bd-events-row");
  });

  it("특보가 4건 이상이면 3건만 보이고 나머지는 접는다", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...pending, id: `e${n}`, title: `특보${n}` }));
    const { container, getByText } = renderBoard(many);
    expect(container.querySelectorAll(".bd-event").length).toBe(3);
    expect(getByText("외 2건")).toBeTruthy();
  });

  it("값이 없는 지표는 대시 기호를 보여준다", () => {
    const { getByText } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="—"
        metrics={[{ ...metrics[0], value: null, history: [] }]} events={[]} />,
    );
    expect(getByText("–")).toBeTruthy();
  });

  it("조작 요소를 렌더링하지 않는다", () => {
    const { container } = renderBoard([pending]);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/pages/__tests__/DashboardBoard.test.tsx`
Expected: FAIL — `Failed to resolve import "../DashboardBoard"`

- [ ] **Step 3: 구현한다**

`apps/web/src/pages/DashboardBoard.tsx`:

```tsx
import { MetricChart } from "../components/MetricChart";
import { BoardTicker } from "../components/BoardTicker";
import type { TickerItem } from "../components/BoardTicker";
import "./DashboardBoard.css";

/** 특보 배너를 가로로 눕혀도 읽히는 최대 개수. 넘으면 접는다. */
const MAX_EVENTS = 3;

export type BoardMetric = {
  key: "rain" | "temp" | "wind" | "feels";
  label: string;
  unit: string;
  value: number | null;
  threshold: number;
  gradeLabel: string;
  allowNegative: boolean;
  history: number[];
};

export type BoardEvent = {
  id: string;
  title: string;
  tag: string;
  detail: string;
  severe: boolean;
};

export type DashboardBoardProps = {
  siteName: string;
  clock: string;
  collectedAgo: string;
  metrics: BoardMetric[];
  events: BoardEvent[];
};

export function statusHeadline(events: BoardEvent[]): { text: string; alert: boolean } {
  if (events.length === 0) return { text: "평온", alert: false };
  const waiting = events.some((e) => e.tag === "승인 대기");
  return { text: waiting ? "특보 발생" : "대응 중", alert: true };
}

function toneOf(m: BoardMetric): "calm" | "near" | "over" {
  if (m.value === null) return "calm";
  if (m.value >= m.threshold) return "over";
  if (m.value >= m.threshold * 0.9) return "near";
  return "calm";
}

export function DashboardBoard({
  siteName, clock, collectedAgo, metrics, events,
}: DashboardBoardProps) {
  const status = statusHeadline(events);
  const shown = events.slice(0, MAX_EVENTS);
  const hidden = events.length - shown.length;

  const tickerItems: TickerItem[] = metrics
    .filter((m): m is BoardMetric & { value: number } => m.value !== null)
    .map((m) => ({
      label: m.label, value: m.value, unit: m.unit,
      threshold: m.threshold, gradeLabel: m.gradeLabel,
    }));

  return (
    <div className="bd">
      <header className="bd-head">
        <div className="bd-head-left">
          <span className={status.alert ? "bd-status bd-status-alert" : "bd-status"}>{status.text}</span>
          <span className="bd-site">{siteName}</span>
        </div>
        <div className="bd-head-right">
          <span className="bd-clock">{clock}</span>
          <span className="bd-collected">{collectedAgo}</span>
        </div>
      </header>

      {events.length > 0 && (
        <div className={events.length > 1 ? "bd-events bd-events-row" : "bd-events"}>
          {shown.map((e) => (
            <div className="bd-event" key={e.id}>
              <span className={e.severe ? "bd-tag bd-tag-severe" : "bd-tag"}>{e.tag}</span>
              <span className={e.severe ? "bd-event-title bd-event-severe" : "bd-event-title"}>{e.title}</span>
              <span className="bd-event-detail">{e.detail}</span>
            </div>
          ))}
          {hidden > 0 && <span className="bd-more">외 {hidden}건</span>}
        </div>
      )}

      <div className="bd-cards">
        {metrics.map((m) => {
          const tone = toneOf(m);
          return (
            <div className="bd-card" key={m.key}>
              <span className="bd-card-label">{m.label}</span>
              <span className={`bd-card-value bd-value-${tone}`}>
                {m.value === null ? "–" : Number(m.value.toFixed(1))}
                <span className="bd-card-unit">{m.unit}</span>
              </span>
              <MetricChart
                values={m.history}
                threshold={m.threshold}
                unit={m.unit}
                gradeLabel="주의보"
                allowNegative={m.allowNegative}
                tone={tone}
              />
            </div>
          );
        })}
      </div>

      <BoardTicker items={tickerItems} />
    </div>
  );
}
```

`apps/web/src/pages/DashboardBoard.css`:

```css
/* 월보드. 조작 요소가 없는 관망용 표시면 — 3미터 밖에서 읽히는 크기.
   DESIGN-apple.md 준수: 장식 띠 없음, 그림자 없음, 반경은 rounded.lg(18px)만. */

.bd {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: var(--parchment);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.bd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 38px 56px 26px;
  flex-shrink: 0;
}

.bd-head-left {
  display: flex;
  align-items: baseline;
  gap: 22px;
  min-width: 0;
}

.bd-status {
  font-size: 64px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
  color: var(--ink);
}

.bd-status-alert { color: var(--danger); }

.bd-site {
  font-size: 26px;
  font-weight: 300;
  color: var(--ink-muted-48);
}

.bd-head-right { text-align: right; flex-shrink: 0; }

.bd-clock {
  display: block;
  font-family: var(--font-num);
  font-size: 44px;
  font-weight: 300;
  letter-spacing: -0.02em;
}

.bd-collected {
  font-size: 17px;
  font-weight: 300;
  color: var(--ink-muted-48);
}

.bd-events {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0 56px 22px;
  flex-shrink: 0;
}

/* 2건 이상은 가로로 — 세로로 쌓으면 카드 영역이 줄어 차트가 잘린다 */
.bd-events-row {
  flex-direction: row;
  align-items: stretch;
  gap: 16px;
}

.bd-event {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  padding: 20px 30px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  min-width: 0;
}

.bd-events-row .bd-event {
  flex: 1;
  padding: 16px 22px;
  gap: 10px;
}

.bd-tag {
  padding: 7px 16px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--warn-strong) 18%, var(--canvas));
  color: #8a4b00;
  font-size: 18px;
  font-weight: 600;
  white-space: nowrap;
}

.bd-tag-severe {
  background: color-mix(in srgb, var(--danger) 14%, var(--canvas));
  color: var(--danger);
}

.bd-event-title {
  font-size: 36px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--warn-strong);
}

.bd-events-row .bd-event-title { font-size: 30px; }

.bd-event-severe { color: var(--danger); }

.bd-event-detail {
  font-size: 19px;
  font-weight: 300;
  color: var(--ink-muted-48);
}

.bd-events-row .bd-event-detail {
  font-size: 16px;
  flex-basis: 100%;
}

.bd-more {
  align-self: center;
  font-size: 19px;
  font-weight: 300;
  color: var(--ink-muted-48);
  white-space: nowrap;
}

.bd-cards {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 24px;
  padding: 0 56px 26px;
}

/* 16:9에서 4열 1행은 카드가 세로로 과하게 길어져 숫자와 차트 사이가 빈다.
   2×2가 카드 비율에 맞다(시안에서 실측). */
.bd-card {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-card);
  padding: 26px 30px 22px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.bd-card-label {
  font-size: 22px;
  font-weight: 400;
  color: var(--ink-muted-80);
}

.bd-card-value {
  font-family: var(--font-num);
  font-size: 68px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -2px;
  margin: 8px 0 0;
  color: var(--ink);
}

.bd-value-near { color: var(--warn-strong); }
.bd-value-over { color: var(--danger); }

.bd-card-unit {
  font-size: 26px;
  font-weight: 400;
  color: var(--ink-muted-48);
  margin-left: 6px;
  letter-spacing: 0;
}

.bd-card .mc { margin-top: 10px; }
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/pages/__tests__/DashboardBoard.test.tsx && npx tsc -b`
Expected: 13건 PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/pages/DashboardBoard.tsx apps/web/src/pages/DashboardBoard.css apps/web/src/pages/__tests__/DashboardBoard.test.tsx
git commit -m "feat(web): 월보드 레이아웃 컴포넌트

조작 요소 없는 관망용 화면. 특보 2건 이상이면 가로 배치로 눕혀
카드 영역을 지킨다(세로로 쌓으면 차트가 잘린다). 4건 이상은 접는다."
```

---

### Task 5: 관측 이력 로딩 + 보드 모드 연결

기존 대시보드에 이력 쿼리를 더하고, `?board=1`이면 `DashboardBoard`를 렌더한다.

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Test: `apps/web/src/pages/Dashboard.test.tsx` (기존 파일 — 신규 3건 추가)

**Interfaces:**
- Consumes: `DashboardBoard`, `BoardMetric`, `BoardEvent` (Task 4)

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`apps/web/src/pages/Dashboard.test.tsx`의 `describe("Dashboard 관측 카드", ...)` 블록 **뒤에** 새 블록을 추가한다. 기존 파일의 프록시 모킹(`mocks.calls`, `mocks.dataFor`)과 `renderDashboard`를 그대로 쓴다. `MemoryRouter`의 초기 경로를 바꿔야 하므로 아래 헬퍼를 파일에 추가한다:

```tsx
function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <Dashboard />
    </MemoryRouter>,
  );
}

describe("Dashboard 보드 모드", () => {
  it("최근 24시간 관측 이력을 조회한다", async () => {
    renderAt("?board=1");
    await waitFor(() => expect(mocks.calls.length).toBeGreaterThan(0));
    const history = mocks.calls.find(
      (c) => c.table === "weather_observations" && c.chain.includes("gte") && c.chain.includes("order"),
    );
    expect(history, "이력 조회가 있어야 한다").toBeDefined();
    const eqArgs = history!.chain
      .map((m, i) => (m === "eq" ? history!.args[i] : null))
      .filter(Boolean) as unknown[][];
    expect(eqArgs).toContainEqual(["missing", false]);
  });

  it("board=1이면 조작 요소를 렌더링하지 않는다", async () => {
    const { container } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd")).toBeTruthy());
    expect(container.querySelector(".setup-strip")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
  });

  it("board 파라미터가 없으면 기존 대시보드를 렌더링한다", async () => {
    const { container } = renderAt("");
    await waitFor(() => expect(container.querySelector(".obs-grid")).toBeTruthy());
    expect(container.querySelector(".bd")).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/pages/Dashboard.test.tsx`
Expected: FAIL — 이력 조회가 없고 `.bd`가 렌더되지 않는다

- [ ] **Step 3: 이력 쿼리를 더한다**

`Dashboard.tsx` 상단 임포트에 추가:

```tsx
import { useSearchParams } from "react-router-dom";
import { DashboardBoard } from "./DashboardBoard";
import type { BoardEvent, BoardMetric } from "./DashboardBoard";
```

`type DashboardData`에 필드 추가:

```tsx
type ObservationPoint = Pick<
  WeatherObservation,
  "observed_at" | "rain_mm_per_hr" | "temp_c" | "feels_c" | "wind_ms"
>;

type DashboardData = {
  observation: WeatherObservation | null;
  criteria: WeatherCriteria[];
  openEvents: WeatherEvent[];
  dispatches: DispatchRow[];
  snowToday: number | null;
  /** 월보드 차트용 최근 24시간 유효 관측 (오래된 것부터) */
  history: ObservationPoint[];
};
```

`Promise.all` 배열 끝에 쿼리를 추가한다(구조분해 이름도 함께):

```tsx
    const [obsRes, eventsRes, dispatchesRes, criteriaRes, siteRes, snowTodayRes, historyRes] =
      await Promise.all([
        // …기존 6개 그대로…
        // 월보드 차트용. 최신 관측 쿼리와 같은 기준(결측 제외)으로 읽는다.
        supabase
          .from("weather_observations")
          .select("observed_at, rain_mm_per_hr, temp_c, feels_c, wind_ms")
          .eq("missing", false)
          .gte("observed_at", new Date(Date.now() - 24 * 3600_000).toISOString())
          .order("observed_at", { ascending: true }),
      ]);
```

`setData` 호출에 추가:

```tsx
      history: (historyRes.data as ObservationPoint[] | null) ?? [],
```

- [ ] **Step 4: 보드 모드 분기를 넣는다**

`Dashboard` 컴포넌트 본문 상단(`const { employee, isApprover } = useAuth();` 바로 아래)에:

```tsx
  const [searchParams] = useSearchParams();
  const boardMode = searchParams.get("board") === "1";
```

`return (` 바로 앞에 보드 렌더 분기를 넣는다:

```tsx
  if (boardMode) {
    return <DashboardBoard {...toBoardProps(data, siteName)} />;
  }
```

그리고 파일 하단(컴포넌트 밖)에 변환 함수를 둔다. 표시용 변환을 컴포넌트 밖 순수 함수로 빼야 테스트하기 쉽고 렌더마다 재계산되지 않는다:

```tsx
const KIND_OF_METRIC: Record<BoardMetric["key"], Kind> = {
  rain: "rain", temp: "heat", wind: "wind", feels: "heat",
};

const METRIC_DEFS: Omit<BoardMetric, "value" | "threshold" | "history">[] = [
  { key: "rain", label: "시간당 강수량", unit: "mm", gradeLabel: "폭우 주의보", allowNegative: false },
  { key: "temp", label: "기온", unit: "℃", gradeLabel: "폭염 주의보", allowNegative: true },
  { key: "wind", label: "풍속", unit: "m/s", gradeLabel: "강풍 주의보", allowNegative: false },
  { key: "feels", label: "체감온도", unit: "℃", gradeLabel: "폭염 주의보", allowNegative: true },
];

const THRESHOLD_KEY: Record<BoardMetric["key"], string> = {
  rain: "rain_mm_per_hr", temp: "temp_c", wind: "wind_ms", feels: "feels_c",
};

const OBS_FIELD: Record<BoardMetric["key"], keyof ObservationPoint> = {
  rain: "rain_mm_per_hr", temp: "temp_c", wind: "wind_ms", feels: "feels_c",
};

function toBoardProps(data: DashboardData | null, siteName: string) {
  const obs = data?.observation ?? null;
  const history = data?.history ?? [];

  const metrics: BoardMetric[] = METRIC_DEFS.map((def) => {
    const watch = (data?.criteria ?? []).find(
      (c) => c.kind === KIND_OF_METRIC[def.key] && c.grade === "watch",
    );
    const threshold = watch?.threshold?.[THRESHOLD_KEY[def.key]] ?? 0;
    const field = OBS_FIELD[def.key];
    const raw = obs ? (obs[field as keyof WeatherObservation] as number | null) : null;
    return {
      ...def,
      threshold,
      value: raw ?? null,
      history: history
        .map((h) => h[field] as number | null)
        .filter((v): v is number => v !== null),
    };
  });

  const events: BoardEvent[] = (data?.openEvents ?? []).map((e) => ({
    id: e.id,
    title: `${KIND_LABEL[e.kind]} ${e.grade === "warning" ? "경보" : "주의보"}`,
    tag: e.status === "PENDING_APPROVAL" ? "승인 대기" : "발송 완료",
    detail:
      e.status === "PENDING_APPROVAL"
        ? `${formatTime(e.detected_at)} 감지 · 재알림 ${e.repeat_count}회`
        : `${formatTime(e.detected_at)} 발생 · 반복 ${e.repeat_count}회차`,
    severe: e.grade === "warning",
  }));

  return {
    siteName,
    clock: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false }),
    collectedAgo: obs ? `${formatTime(obs.observed_at)} 관측 기준` : "관측 없음",
    metrics,
    events,
  };
}
```

`siteName`은 이미 `siteRes`로 받아오고 있지 않다면 `data`에 넣지 말고 별도 상태로 둔다. 기존 코드에 `siteRes`가 있으므로 `setData` 직전에 `setSiteName(siteRes.data?.site_name ?? "곤지암")`을 추가하고, 컴포넌트에 `const [siteName, setSiteName] = useState("곤지암");`를 선언한다.

- [ ] **Step 5: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run && npx tsc -b`
Expected: 전 테스트 PASS(기존 49 + 신규), 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/pages/Dashboard.tsx apps/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): ?board=1로 월보드 모드 진입

기존 대시보드에 최근 24시간 관측 이력 쿼리를 더하고, 파라미터가 있으면
DashboardBoard를 렌더한다. 파라미터가 없을 때 기존 화면은 그대로다."
```

---

### Task 6: 전체화면 진입 버튼

대시보드에서 월보드로 들어가는 경로.

**Files:**
- Modify: `apps/web/src/pages/Dashboard.tsx`
- Modify: `apps/web/src/pages/Dashboard.css`
- Test: `apps/web/src/pages/Dashboard.test.tsx` (신규 2건)

- [ ] **Step 1: 실패하는 테스트를 먼저 쓴다**

`Dashboard.test.tsx`의 보드 모드 describe에 추가:

```tsx
  it("일반 모드에 전체화면 버튼이 있다", async () => {
    const { findByRole } = renderAt("");
    expect(await findByRole("button", { name: "전체화면" })).toBeTruthy();
  });

  it("보드 모드에는 전체화면 버튼이 없다", async () => {
    const { container, queryByRole } = renderAt("?board=1");
    await waitFor(() => expect(container.querySelector(".bd")).toBeTruthy());
    expect(queryByRole("button", { name: "전체화면" })).toBeNull();
  });
```

- [ ] **Step 2: 테스트를 돌려 실패를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run src/pages/Dashboard.test.tsx`
Expected: FAIL — 버튼을 찾지 못한다

- [ ] **Step 3: 버튼과 전체화면 전환을 구현한다**

`Dashboard.tsx`의 `useSearchParams` 구조분해를 `const [searchParams, setSearchParams] = useSearchParams();`로 바꾸고, 컴포넌트 안에 핸들러를 추가한다:

```tsx
  // 벽걸이 기기가 이 주소를 북마크하면 부팅 후 바로 월보드로 들어간다.
  // 그래서 전체화면 API와 별개로 URL에 상태를 남긴다 — API가 거부돼도 레이아웃은 바뀐다.
  function enterBoard() {
    const next = new URLSearchParams(searchParams);
    next.set("board", "1");
    setSearchParams(next);
    void document.documentElement.requestFullscreen?.().catch(() => {
      /* 브라우저 정책으로 거부될 수 있다. 레이아웃 전환만으로도 쓸 수 있으므로 무시한다. */
    });
  }
```

보드 모드에서 `ESC`로 나가는 처리를 `useEffect`로 둔다:

```tsx
  useEffect(() => {
    if (!boardMode) return;
    function onFsChange() {
      // 사용자가 ESC로 전체화면을 빠져나오면 파라미터도 함께 정리한다.
      if (!document.fullscreenElement) {
        const next = new URLSearchParams(searchParams);
        next.delete("board");
        setSearchParams(next, { replace: true });
      }
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [boardMode, searchParams, setSearchParams]);
```

`AppLayout`의 `actions`에 버튼을 더한다(기존 `<span className="dash-date">` 옆):

```tsx
    <AppLayout
      title="대시보드"
      actions={
        <>
          <button type="button" className="dash-fullscreen" onClick={enterBoard}>
            전체화면
          </button>
          <span className="dash-date">{today}</span>
        </>
      }
    >
```

`Dashboard.css`에 추가:

```css
/* 월보드 진입. 이 시스템의 상호작용 색은 Action Blue 하나뿐이다. */
.dash-fullscreen {
  margin-right: 16px;
  padding: 8px 18px;
  border: 1px solid var(--hairline);
  border-radius: 9999px;
  background: var(--canvas);
  color: var(--primary);
  font-family: var(--font-ui);
  font-size: 15px;
  font-weight: 400;
  cursor: pointer;
}

.dash-fullscreen:active { transform: scale(0.95); }
```

- [ ] **Step 4: 테스트를 돌려 통과를 확인한다**

Run: `cd /Users/ojun/orca/Weather/apps/web && npx vitest run && npx tsc -b`
Expected: 전 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
cd /Users/ojun/orca/Weather
git add apps/web/src/pages/Dashboard.tsx apps/web/src/pages/Dashboard.css apps/web/src/pages/Dashboard.test.tsx
git commit -m "feat(web): 대시보드에 전체화면 진입 버튼

URL에 board=1을 남겨 벽걸이 기기가 북마크로 바로 진입할 수 있게 한다.
전체화면 API가 거부돼도 레이아웃 전환만으로 동작한다."
```

---

### Task 7: 실제 화면 검증 + 전체 회귀

브라우저에서 네 상태를 눈으로 확인한다. 단위 테스트는 레이아웃 붕괴를 못 잡는다.

**Files:** 없음 (검증만)

- [ ] **Step 1: 전체 회귀**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web
npx tsc -b && npx vitest run && npm run build
```
Expected: 타입 오류 없음, 전 테스트 PASS, 빌드 성공

- [ ] **Step 2: 개발 서버를 띄우고 보드 모드를 연다**

Run:
```bash
cd /Users/ojun/orca/Weather/apps/web && npm run dev
```
브라우저에서 `http://localhost:5173/?board=1`

로그인이 필요하면 로컬 Supabase에 계정을 만들어 세션을 넣는다(로컬 스택이 떠 있어야 한다).

- [ ] **Step 3: 네 상태를 눈으로 확인한다**

각 항목을 실제로 보고 판정한다. 하나라도 어긋나면 고치고 다시 본다.

1. **평온** — 카드 4장이 2×2로 화면을 채우는가. 차트가 카드 밖으로 넘치거나 잘리지 않는가. 티커가 하단에 붙어 흐르는가.
2. **특보 1건** — 배너가 세로 1줄로 뜨고 카드가 여전히 온전한가.
3. **특보 3건** — 배너가 가로로 눕는가. 카드와 차트가 잘리지 않는가.
4. **결측** — 관측이 없을 때 숫자가 `–`로 뜨고 차트 자리가 깨지지 않는가.

특보 상태를 만들려면 로컬에서 `weather_events`에 행을 넣는다:
```sql
insert into weather_events (kind, grade, status) values ('rain','warning','PENDING_APPROVAL');
insert into weather_events (kind, grade, status) values ('heat','warning','ACTIVE');
insert into weather_events (kind, grade, status) values ('wind','watch','ACTIVE');
```

- [ ] **Step 4: 디자인 규범 위반이 없는지 확인한다**

Run:
```bash
cd /Users/ojun/orca/Weather
grep -n "border-left:.*px solid\|box-shadow\|linear-gradient" apps/web/src/pages/DashboardBoard.css apps/web/src/components/MetricChart.css apps/web/src/components/BoardTicker.css
```
Expected: 출력 없음. (장식 띠·그림자·그라데이션 금지 — `DESIGN-apple.md`)

```bash
grep -n "border-radius" apps/web/src/pages/DashboardBoard.css apps/web/src/components/*.css
```
Expected: `var(--radius-card)`(18px) 또는 `9999px`(pill)만. 그 사이 값이 있으면 고친다.

```bash
grep -n "font-weight: 500" apps/web/src/pages/DashboardBoard.css apps/web/src/components/*.css
```
Expected: 출력 없음 (가중치 500 금지).

- [ ] **Step 5: 기존 화면 회귀 확인**

`http://localhost:5173/`(파라미터 없이)를 열어 기존 대시보드가 이전과 같은지 확인한다. 전체화면 버튼만 늘어야 한다.

- [ ] **Step 6: 커밋 (수정이 있었다면)**

```bash
cd /Users/ojun/orca/Weather
git add -A apps/web/src
git commit -m "fix(web): 월보드 실화면 검증에서 발견한 것 수정"
```

---

## Self-Review

**1. 스펙 커버리지**

| 스펙 항목 | 담당 태스크 |
|---|---|
| 2. 진입과 유지 (`?board=1`, 전체화면 API, ESC) | Task 6 |
| 3. 보드 모드에서 숨기는 요소 | Task 4(조작 요소 없음 테스트) + Task 5(분기) |
| 4.1 헤더·상태 헤드라인 3종 | Task 4 (`statusHeadline`) |
| 4.2 특보 배너, 2건 이상 가로 배치 | Task 4 |
| 4.3 지표 카드 2×2, 숫자 색 3단계 | Task 4 (`toneOf`, CSS) |
| 4.4 적응형 스케일 · 축 하한 0 · 임계 분할 · 평탄 처리 · 라벨 좌측 | Task 1(계산) + Task 2(렌더) |
| 4.5 티커 문구·순환·초과 강조 | Task 3 |
| 5. 디자인 규범 준수 | Global Constraints + Task 7 Step 4(기계 검증) |
| 6. 색 검증 (`--warn-strong` 사용) | Task 2 CSS + Global Constraints |
| 7. 구조 (파일 분리) | Task 1~5의 Files 절 |
| 7.1 데이터 (`history` 추가) | Task 5 |
| 8. 엣지 케이스 8종 | Task 1(3종) · Task 2(4종) · Task 4(값 없음, 4건 이상) · Task 6(전체화면 거부) |
| 9. 테스트 전략 | 각 태스크의 테스트 절 |
| 10. 범위 밖 | 어떤 태스크에도 없음 (의도됨) |

**스펙과 다르게 정한 것:** 스펙 7절은 `useDashboardData.ts` 훅 추출을 적었으나, 실제로는 보드가 같은 컴포넌트 안에서 분기하므로(B안) 훅을 빼지 않아도 데이터가 공유된다. 훅 추출은 순수 리팩터링이라 이번 범위에서 뺀다 — YAGNI. 파일 분리 효과는 `DashboardBoard`/`MetricChart`/`BoardTicker`로 이미 얻는다.

**2. 플레이스홀더 스캔** — "TBD"/"적절히"/"위 내용에 대한 테스트" 없음. 모든 코드 단계에 실제 코드 블록이 있다.

**3. 타입 일관성**
- `ScaleResult`·`computeScale`·`yOf` (Task 1) → Task 2가 소비. 이름·시그니처 일치.
- `MetricChartProps` (Task 2) → Task 4가 `values/threshold/unit/gradeLabel/allowNegative/tone`으로 호출. 일치.
- `TickerItem`·`gapPhrase`·`BoardTicker` (Task 3) → Task 4가 `TickerItem[]`을 만들어 넘김. 필드명 일치.
- `BoardMetric`·`BoardEvent`·`DashboardBoardProps` (Task 4) → Task 5의 `toBoardProps`가 생성. 필드명 일치.
- `ObservationPoint` (Task 5) → 같은 태스크 안에서만 사용.
- `tone` 값 `"calm" | "near" | "over"`가 Task 2 CSS 클래스(`mc-tone-*`, `mc-fill-*`)와 Task 4 CSS(`bd-value-*`)에 동일하게 대응.

**발견해 수정한 것:** Task 2의 임계 분할 분기에서 `tone`이 `calm`인데 초과 구간이 있는 경우(현재는 안전하나 오늘 넘긴 적 있음) 초과 영역 색이 없어지는 문제가 있었다. `mc-fill-${tone === "calm" ? "near" : tone}`로 고쳐, 그 경우 주황으로 칠하도록 했다 — 시안에서 확인한 "지금은 그쳤지만 오늘 두 번 넘었다"가 이 경로다.
