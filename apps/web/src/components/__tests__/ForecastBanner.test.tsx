import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastBanner, FORECAST_DISCLAIMER } from "../ForecastBanner";
import type { UpcomingRow } from "../../lib/api/forecast";

const soon = new Date(Date.now() + 12 * 3600e3).toISOString();
function up(v: Partial<UpcomingRow> = {}): UpcomingRow {
  return { kind: "snow", grade: "watch", at: soon, value: 7, unit: "cm", ...v };
}

describe("ForecastBanner", () => {
  it("예고가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastBanner upcoming={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("종류와 등급과 값을 말한다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText(/폭설 주의보/)).toBeInTheDocument();
    expect(screen.getByText(/7cm/)).toBeInTheDocument();
  });

  // **이 계획에서 가장 중요한 한 줄.** 이 문구가 없으면 "배너 떴으니 알림도
  // 갔겠지" 하고 아무도 움직이지 않은 채 모두가 안심한다.
  it("문자가 나가지 않았다는 사실을 반드시 함께 말한다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText(FORECAST_DISCLAIMER)).toBeInTheDocument();
  });

  it("실제 특보 배너와 다른 라벨을 쓴다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.getByText("예고")).toBeInTheDocument();
    expect(screen.queryByText("승인 대기")).not.toBeInTheDocument();
  });

  it("가장 이른 하나만 말하고 나머지는 개수로 접는다", () => {
    const later = new Date(Date.now() + 30 * 3600e3).toISOString();
    render(<ForecastBanner upcoming={[up(), up({ kind: "rain", at: later, unit: "mm", value: 25 })]} />);
    expect(screen.getByText(/폭설 주의보/)).toBeInTheDocument();
    expect(screen.getByText(/외 1건/)).toBeInTheDocument();
  });

  it("한 건뿐이면 '외 N건'을 붙이지 않는다", () => {
    render(<ForecastBanner upcoming={[up()]} />);
    expect(screen.queryByText(/외 .*건/)).not.toBeInTheDocument();
  });

  it("compact에서도 문자 미발송 문구는 남는다", () => {
    render(<ForecastBanner upcoming={[up()]} compact />);
    expect(screen.getByText(FORECAST_DISCLAIMER)).toBeInTheDocument();
  });
});
