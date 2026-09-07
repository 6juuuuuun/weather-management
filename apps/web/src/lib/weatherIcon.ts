// 기상청 SKY(하늘상태)·PTY(강수형태)를 화면에 쓸 글리프와 라벨로 바꾼다.
//
// label을 함께 돌려주는 이유: 아이콘만 그리면 색각·저시력 사용자에게 아무
// 정보도 아니다. 컴포넌트는 글리프를 aria-hidden으로 두고 라벨을 읽게 한다.
export type SkyLook = { key: string; glyph: string; label: string };

/** PTY 0=없음 1=비 2=비/눈 3=눈 4=소나기 */
const BY_PTY: Record<number, SkyLook> = {
  1: { key: "rain",   glyph: "🌧", label: "비" },
  2: { key: "sleet",  glyph: "🌨", label: "비/눈" },
  3: { key: "snow",   glyph: "❄",  label: "눈" },
  4: { key: "shower", glyph: "🌦", label: "소나기" },
};

/** SKY 1=맑음 3=구름많음 4=흐림 (2는 기상청이 쓰지 않는다) */
const BY_SKY: Record<number, SkyLook> = {
  1: { key: "clear",  glyph: "☀", label: "맑음" },
  3: { key: "partly", glyph: "⛅", label: "구름많음" },
  4: { key: "cloudy", glyph: "☁", label: "흐림" },
};

const UNKNOWN: SkyLook = { key: "unknown", glyph: "–", label: "정보 없음" };

export function skyLook(sky: number | null, pty: number | null): SkyLook {
  // 강수형태가 먼저다. 하늘이 맑아도 비가 온다면 그 시각의 사실은 "비"다.
  if (pty !== null && BY_PTY[pty]) return BY_PTY[pty]!;
  if (sky !== null && BY_SKY[sky]) return BY_SKY[sky]!;
  return UNKNOWN;
}
