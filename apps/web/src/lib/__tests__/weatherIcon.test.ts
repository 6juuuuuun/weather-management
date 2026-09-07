import { describe, expect, it } from "vitest";
import { skyLook } from "../weatherIcon";

describe("skyLook", () => {
  it("강수형태가 하늘상태보다 앞선다", () => {
    // 하늘이 맑아도 비가 온다면 비다.
    expect(skyLook(1, 1).key).toBe("rain");
    expect(skyLook(1, 3).key).toBe("snow");
    expect(skyLook(1, 2).key).toBe("sleet");
    expect(skyLook(1, 4).key).toBe("shower");
  });

  it("강수가 없으면 하늘상태를 쓴다", () => {
    expect(skyLook(1, 0).key).toBe("clear");
    expect(skyLook(3, 0).key).toBe("partly");
    expect(skyLook(4, 0).key).toBe("cloudy");
  });

  it("모르는 값은 unknown이고 글리프가 비어 있지 않다", () => {
    expect(skyLook(null, null).key).toBe("unknown");
    expect(skyLook(99, 99).key).toBe("unknown");
    expect(skyLook(null, null).glyph).not.toBe("");
  });

  // 화면에 아이콘만 있으면 색각·저시력 사용자에게 아무 정보도 아니다.
  it("모든 경우에 한글 라벨이 있다", () => {
    for (const [sky, pty] of [[1, 0], [3, 0], [4, 0], [1, 1], [1, 2], [1, 3], [1, 4], [null, null]] as const) {
      expect(skyLook(sky, pty).label.length).toBeGreaterThan(0);
    }
  });
});
