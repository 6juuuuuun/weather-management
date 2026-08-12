import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../Badge";
import { FilterPill } from "../FilterPill";

describe("Badge", () => {
  it("등급 라벨 렌더", () => {
    render(<Badge grade="watch" />);
    expect(screen.getByText("주의보")).toBeInTheDocument();
  });

  it("경보 등급 라벨 렌더", () => {
    render(<Badge grade="warning" />);
    expect(screen.getByText("경보")).toBeInTheDocument();
  });
});

describe("FilterPill", () => {
  it("count 뱃지 렌더", () => {
    render(<FilterPill selected label="부서 미지정" count={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("count 없으면 뱃지 없음", () => {
    render(<FilterPill selected={false} label="부서: 전체" />);
    expect(screen.getByText("부서: 전체")).toBeInTheDocument();
  });

  it("클릭 시 onClick 호출", () => {
    const onClick = vi.fn();
    render(<FilterPill selected={false} label="부서: 전체" onClick={onClick} />);
    screen.getByText("부서: 전체").click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
