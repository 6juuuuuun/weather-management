import { describe, expect, test } from "vitest";
import { describeGrid, gridToLatLon, nearestRegion } from "../kmaGrid";

// 검증 §신규-2 — 격자 범위 안의 **엉뚱한** 좌표는 값 검증으로 잡을 수 없다.
// 저장은 되고 수집도 정상이라 모든 지표가 초록인 채로 남의 동네 날씨로 특보를
// 판정한다. 화면이 "이 좌표가 어디인가"를 말해 주는 것이 유일한 방어선이다.
describe("gridToLatLon", () => {
  // 기상청 격자의 실제 대응값. 이 값들이 맞지 않으면 화면이 엉뚱한 지역을
  // 가리켜 방어선이 오히려 거짓 안심을 만든다.
  test.each([
    [61, 121, 37.303, 127.043, "경기"], // 시드 좌표(곤지암)
    [60, 127, 37.58, 126.989, "서울"],
    [52, 38, 33.501, 126.492, "제주"], // 검증이 실제로 넣어 본 좌표
    [89, 90, 35.848, 128.606, "대구"],
    [58, 74, 35.144, 126.841, "광주"],
  ])("(%i, %i) → 위도 %f · 경도 %f (%s)", (nx, ny, lat, lon, region) => {
    const p = gridToLatLon(nx, ny)!;
    expect(p).not.toBeNull();
    expect(p.lat).toBeCloseTo(lat, 2);
    expect(p.lon).toBeCloseTo(lon, 2);
    expect(nearestRegion(p)).toBe(region);
  });

  test("숫자가 아니면 null이다", () => {
    expect(gridToLatLon(undefined, undefined)).toBeNull();
    expect(gridToLatLon("61", "121")).toBeNull();
    expect(gridToLatLon(NaN, 121)).toBeNull();
  });
});

describe("describeGrid", () => {
  // 이 한 줄이 화면에 그대로 나간다. 관리자가 곤지암 설정을 열었을 때
  // "제주 부근"이 보이면 그 자리에서 알아챌 수 있어야 한다.
  test("시드 좌표는 경기 부근으로 읽힌다", () => {
    expect(describeGrid(61, 121)).toBe("위도 37.303 · 경도 127.043 (경기 부근)");
  });

  test("제주 격자를 넣으면 제주 부근이라고 말한다", () => {
    expect(describeGrid(52, 38)).toContain("제주 부근");
    // 곤지암 좌표와 **다른 문장**이어야 한다 — 둘이 같으면 이 화면은 아무것도 막지 못한다.
    expect(describeGrid(52, 38)).not.toBe(describeGrid(61, 121));
  });

  test("좌표가 없으면 null을 돌려주고 화면이 그 사실을 말한다", () => {
    expect(describeGrid(null, null)).toBeNull();
  });
});
