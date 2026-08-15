import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MetricChart } from "../MetricChart";

function svgOf(container: HTMLElement) {
  const el = container.querySelector("svg");
  if (!el) throw new Error("svg가 렌더되지 않았다");
  return el;
}

/** `clipPath="url(#id)"`에서 참조하는 id만 떼어낸다. */
function clipIdOf(svg: SVGElement, cls: string): string {
  const el = svg.querySelector(`path.${cls}`);
  if (!el) throw new Error(`path.${cls}가 없다`);
  const ref = el.getAttribute("clip-path") ?? "";
  const id = /url\(#(.+)\)/.exec(ref)?.[1];
  if (!id) throw new Error(`path.${cls}에 clip 참조가 없다: ${ref}`);
  return id;
}

function rectOf(svg: SVGElement, clipId: string): Element {
  const rect = [...svg.querySelectorAll("clipPath")].find((c) => c.id === clipId)?.querySelector("rect");
  if (!rect) throw new Error(`clipPath#${clipId}에 rect가 없다`);
  return rect;
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
    const svg = svgOf(container);
    expect(svg.querySelectorAll("path.mc-area-below").length).toBe(1);
    const above = svg.querySelector("path.mc-area-above");
    expect(above).toBeTruthy();
    // 현재는 안전(calm)해도 오늘 넘긴 이력은 경고색으로 남아야 한다.
    // mc-fill-calm이면 뮤트색이라 이력이 사라진다.
    expect(above!.getAttribute("class")).toContain("mc-fill-near");
  });

  // 분할 채색은 클래스가 아니라 clip 기하가 만든다. 클래스만 보면 두 area가
  // 같은 clip을 참조하거나 경계 y가 상수로 굳어도 초록이 되어, 스펙 §4.4가
  // "이 차트의 핵심"이라 부른 동작이 무방비가 된다.
  it("두 area가 서로 다른 clip을 임계 y에서 맞물려 참조한다", () => {
    const { container } = render(
      <MetricChart values={[5, 25, 8]} threshold={20} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    const svg = svgOf(container);
    const belowId = clipIdOf(svg, "mc-area-below");
    const aboveId = clipIdOf(svg, "mc-area-above");
    // 같은 id를 참조하면 두 겹이 똑같이 잘려 분할이 사라진다.
    expect(belowId).not.toBe(aboveId);

    const belowY = Number(rectOf(svg, belowId).getAttribute("y"));
    const aboveH = Number(rectOf(svg, aboveId).getAttribute("height"));
    // 아래 clip은 임계 y부터 아래로, 위 clip은 0부터 임계 y까지 — 둘이 같은
    // 경계에서 맞물려야 틈도 겹침도 없다. y가 0이면 아래 clip이 전면을 덮는다.
    expect(belowY).toBeGreaterThan(0);
    expect(belowY).toBeLessThan(196); // 뷰박스 높이 안
    expect(aboveH).toBe(belowY);
  });

  // 경계 y가 상수로 굳어도 위 단언은 통과한다. 임계만 바꾼 두 렌더의 경계가
  // 실제로 움직이는지까지 봐야 상수화 변이가 잡힌다.
  it("clip 경계 y가 임계에 따라 움직인다", () => {
    const boundary = (threshold: number) => {
      const { container } = render(
        <MetricChart values={[5, 25, 8]} threshold={threshold} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
      );
      const svg = svgOf(container);
      return Number(rectOf(svg, clipIdOf(svg, "mc-area-below")).getAttribute("y"));
    };
    expect(boundary(20)).not.toBe(boundary(10));
  });

  // 회귀: 예전에는 id를 tone/length/lo로 만들어, 월보드에 동시에 뜨는 4장 중
  // 조건이 같은 카드끼리 clipPath id가 충돌해 분할 채색이 조용히 깨졌다.
  it("같은 props로 두 장을 그려도 clipPath id가 겹치지 않는다", () => {
    const props = {
      values: [5, 25, 8], threshold: 20, unit: "mm",
      gradeLabel: "주의보", allowNegative: false, tone: "calm" as const,
    };
    const { container } = render(
      <>
        <MetricChart {...props} />
        <MetricChart {...props} />
      </>,
    );
    const ids = [...container.querySelectorAll("clipPath")].map((el) => el.id);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);
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

  // threshold가 null이면 기준 미설정이다. 임계 0을 그대로 그리면 "0mm 초과"
  // 같은 거짓 기준선이 뜬다 — 기준선도, 분할 채색도 없어야 한다.
  it("threshold가 null이면 기준선도 초과 채색도 그리지 않는다", () => {
    const { container } = render(
      <MetricChart values={[5, 25, 8]} threshold={null} unit="mm" gradeLabel="주의보" allowNegative={false} tone="calm" />,
    );
    const svg = svgOf(container);
    expect(svg.querySelector("line.mc-threshold")).toBeNull();
    expect(svg.querySelector("path.mc-area-above")).toBeNull();
  });
});
