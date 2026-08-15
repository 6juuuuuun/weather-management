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
