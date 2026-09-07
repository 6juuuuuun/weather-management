import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ForecastStrip, thin } from "../ForecastStrip";
import type { ForecastHour } from "../../lib/api/forecast";

function h(kstIso: string, v: Partial<ForecastHour> = {}): ForecastHour {
  return {
    at: new Date(kstIso).toISOString(), temp_c: 20, pop_pct: 0, pty: 0, sky: 1,
    pcp_mm: null, sno_cm: null, wsd_ms: 2, exceeds: [], ...v,
  };
}
const SIX = [0, 1, 2, 3, 4, 5].map((i) => h(`2026-09-07T${String(10 + i).padStart(2, "0")}:00:00+09:00`));

describe("thin — 밀도", () => {
  it("scroll은 모든 시각을 남긴다", () => {
    expect(thin(SIX, "scroll")).toHaveLength(6);
  });

  // 월보드에는 미는 사람이 없다. 48칸을 그리면 앞쪽만 영원히 보인다.
  it("spread는 3시간 간격으로 솎는다", () => {
    expect(thin(SIX, "spread")).toHaveLength(2);
  });
});

describe("ForecastStrip", () => {
  it("예보가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<ForecastStrip hours={[]} density="scroll" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("시각과 기온을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { temp_c: 23 })]} density="scroll" />);
    expect(screen.getByText("14시")).toBeInTheDocument();
    expect(screen.getByText("23")).toBeInTheDocument();
  });

  // 자정이 지나면 몇 시인지만으로는 어느 날인지 알 수 없다.
  it("자정 칸에는 날짜를 함께 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-08T00:00:00+09:00")]} density="scroll" />);
    expect(screen.getByText(/9\/8/)).toBeInTheDocument();
  });

  // 아이콘만 있으면 색각·저시력 사용자에게 아무 정보도 아니다.
  it("하늘상태에 읽을 수 있는 라벨이 있다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { sky: 4, pty: 0 })]} density="scroll" />);
    expect(screen.getByText("흐림")).toBeInTheDocument();
  });

  // 값이 하나도 없는 줄을 0이나 -로 채우면 "비가 안 온다"는 단언이 된다.
  it("강수량이 하나도 없으면 그 줄을 아예 그리지 않는다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: null })]} density="scroll" />);
    expect(screen.queryByText("강수량")).not.toBeInTheDocument();
  });

  it("강수량이 있으면 그 줄을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: 12 })]} density="scroll" />);
    expect(screen.getByText("강수량")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("신적설이 있으면 그 줄을 그린다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { sno_cm: 3 })]} density="scroll" />);
    expect(screen.getByText("신적설")).toBeInTheDocument();
  });

  // **가장 중요한 줄.** 화면은 임계와 비교하지 않는다 — 서버가 준 exceeds만 본다.
  it("서버가 초과라고 표시한 칸만 강조한다", () => {
    const { container } = render(
      <ForecastStrip
        hours={[
          h("2026-09-07T14:00:00+09:00", { pcp_mm: 60, exceeds: [{ kind: "rain", grade: "warning" }] }),
          h("2026-09-07T15:00:00+09:00", { pcp_mm: 90, exceeds: [] }),
        ]}
        density="scroll"
      />,
    );
    expect(container.querySelectorAll(".fc-col-over")).toHaveLength(1);
    expect(container.querySelectorAll(".fc-col-warning")).toHaveLength(1);
  });

  // I4: 색만으로 "무엇을 넘는지"를 말하면 색약 운영자·스크린 리더 모두 정보를
  // 잃는다. exceeds의 kind+grade를 짧은 한글 글자로도 적어야 한다.
  it("초과 칸에는 무엇을 넘는지 글자로도 적는다", () => {
    render(
      <ForecastStrip
        hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: 60, exceeds: [{ kind: "rain", grade: "watch" }] })]}
        density="scroll"
      />,
    );
    expect(screen.getByText("폭우 주의보")).toBeInTheDocument();
  });

  it("초과하지 않는 칸에는 그 글자가 없다", () => {
    render(
      <ForecastStrip
        hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: 5, exceeds: [] })]}
        density="scroll"
      />,
    );
    expect(screen.queryByText(/주의보|경보/)).not.toBeInTheDocument();
  });

  it("초과 칸이 있으면 범례에도 뜻을 적는다", () => {
    render(
      <ForecastStrip
        hours={[h("2026-09-07T14:00:00+09:00", { pcp_mm: 60, exceeds: [{ kind: "rain", grade: "watch" }] })]}
        density="scroll"
      />,
    );
    expect(screen.getByText("색칠된 칸 = 특보 기준 초과 예상")).toBeInTheDocument();
  });

  it("초과 칸이 없으면 범례에도 뜻을 적지 않는다", () => {
    render(<ForecastStrip hours={[h("2026-09-07T14:00:00+09:00", { exceeds: [] })]} density="scroll" />);
    expect(screen.queryByText("색칠된 칸 = 특보 기준 초과 예상")).not.toBeInTheDocument();
  });

  it("밀도에 따라 다른 클래스를 단다", () => {
    const { container: a } = render(<ForecastStrip hours={SIX} density="scroll" />);
    const { container: b } = render(<ForecastStrip hours={SIX} density="spread" />);
    expect(a.querySelector(".fc-scroll")).not.toBeNull();
    expect(b.querySelector(".fc-spread")).not.toBeNull();
    // 월보드에는 스크롤 컨테이너가 없어야 한다.
    expect(b.querySelector(".fc-scroll")).toBeNull();
  });
});
