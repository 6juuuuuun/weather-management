import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastDaily } from "../ForecastDaily";
import type { ForecastDay } from "../../lib/api/forecast";

function day(date: string, v: Partial<ForecastDay> = {}): ForecastDay {
  return { date, tmn_c: 16, tmx_c: 25, pop_max: 20, pcp_sum: null, sno_sum: null,
           sky: 1, derived: false, ...v };
}

describe("ForecastDaily", () => {
  it("비어 있으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastDaily days={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // 오늘은 관측 카드와 48시간 스트립이 이미 말한다. 여기서 또 말하면
  // 같은 정보가 세 번 나온다.
  it("오늘은 그리지 않고 내일부터 그린다", () => {
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(today), day(tomorrow)]} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("최저~최고와 강수확률을 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { tmn_c: 16, tmx_c: 27, pop_max: 80 })]} />);
    expect(screen.getByText(/16/)).toBeInTheDocument();
    expect(screen.getByText(/27/)).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  // 스키장에서 눈 예보는 가장 중요한 숫자다. 있으면 반드시 보여야 한다.
  it("적설이 있으면 함께 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { sno_sum: 8 })]} />);
    expect(screen.getByText(/8cm/)).toBeInTheDocument();
  });

  it("강수량이 있으면 함께 그린다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { pcp_sum: 35 })]} />);
    expect(screen.getByText(/35mm/)).toBeInTheDocument();
  });

  it("값이 없는 항목은 아예 그리지 않는다", () => {
    const tomorrow = new Date(Date.now() + 33 * 3600e3).toISOString().slice(0, 10);
    render(<ForecastDaily days={[day(tomorrow, { pcp_sum: null, sno_sum: null })]} />);
    expect(screen.queryByText(/mm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cm/)).not.toBeInTheDocument();
  });
});
