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

  // F1: threshold<=0은 "기준 미설정"이다. 값이 있어도 티커·차트·카드 색
  // 세 곳 모두에서 거짓 경보(가짜 기준선, "…초과" 문구, 빨간 숫자)를 내면 안 된다.
  it("threshold가 0인 지표는 티커에 나타나지 않고 기준선도 그리지 않으며 카드가 빨갛지 않다", () => {
    const zeroThresholdMetric: BoardMetric = {
      key: "rain", label: "시간당 강수량", unit: "mm", value: 5, threshold: 0,
      gradeLabel: "폭우 주의보", allowNegative: false, history: [3, 4, 5],
    };
    const { container } = render(
      <DashboardBoard siteName="곤지암" clock="13:47" collectedAgo="마지막 수집 2분 전"
        metrics={[zeroThresholdMetric]} events={[]} />,
    );
    // 티커: threshold<=0 지표를 빼면 항목이 하나도 없어 트랙 자체가 렌더되지 않는다.
    expect(container.querySelector(".bt")).toBeNull();
    // 차트: 기준선을 그리지 않는다.
    expect(container.querySelector("line.mc-threshold")).toBeNull();
    // 카드: 값이 임계(0) 이상이어도 danger 색 클래스가 붙지 않는다.
    expect(container.querySelector(".bd-value-over")).toBeNull();
  });
});
