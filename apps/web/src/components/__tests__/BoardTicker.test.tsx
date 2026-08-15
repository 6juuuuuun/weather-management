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

  // 회귀: 트랙에 gap이나 padding이 있으면 -50% 이동이 이음매와 어긋난다(계산상 11px 튐).
  // 두 벌이 정확히 같은 폭이 되려면 모든 자식이 동일한 자기 여백만 가져야 한다.
  // 좌측 인셋은 애니메이션되지 않는 .bt가 가진다.
  it("트랙의 자식은 두 벌이 정확히 같은 수여야 한다", () => {
    const items = [rain, { ...rain, label: "기온" }, { ...rain, label: "풍속" }];
    const { container } = render(<BoardTicker items={items} />);
    const track = container.querySelector(".bt-track")!;
    expect(track.children.length).toBe(items.length * 2);
  });
});
