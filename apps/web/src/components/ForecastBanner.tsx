// 예보상 임계 초과가 예상될 때 뜨는 배너. **실제 특보 배너와 반드시 구분된다.**
//
// 구분이 흐려지면 이 시스템이 다섯 번 고친 결함이 그대로 돌아온다:
// 사람들이 "배너가 떴으니 알림도 갔겠지"라고 읽고, 아무도 움직이지 않은 채
// 모두가 안심한다. 그래서 라벨("예고")·색·문구를 특보와 다르게 두고,
// **문자가 나가지 않았다는 사실을 배너 안에서 직접 말한다.**
import type { UpcomingRow } from "../lib/api/forecast";
import "./ForecastBanner.css";

// ForecastStrip도 같은 라벨을 쓴다(48시간 스트립의 초과 칸 표시, I4) — 여기서
// export해 다시 정의하지 않는다. 두 벌로 적히면 한쪽만 고쳤을 때 배너와
// 스트립이 다른 말을 하게 된다.
export const KIND_LABEL: Record<UpcomingRow["kind"], string> = {
  rain: "폭우", snow: "폭설", wind: "강풍", heat: "폭염",
};
export const GRADE_LABEL: Record<UpcomingRow["grade"], string> = { watch: "주의보", warning: "경보" };

/** 이 문구는 지우면 안 된다. 테스트가 이 상수로 존재를 고정한다. */
export const FORECAST_DISCLAIMER = "예보 기준입니다 · 문자는 나가지 않았습니다";

/** "내일 06시" / "오늘 21시" — 사람이 읽는 상대 날짜. */
function whenLabel(iso: string): string {
  const kstNow = new Date(Date.now() + 9 * 3600e3);
  const kstAt = new Date(new Date(iso).getTime() + 9 * 3600e3);
  const dayDiff =
    Math.floor(kstAt.getTime() / 86400000) - Math.floor(kstNow.getTime() / 86400000);
  const prefix = dayDiff <= 0 ? "오늘" : dayDiff === 1 ? "내일" : dayDiff === 2 ? "모레" : `${kstAt.getUTCMonth() + 1}/${kstAt.getUTCDate()}`;
  return `${prefix} ${kstAt.getUTCHours()}시`;
}

export function ForecastBanner({ upcoming, compact }: { upcoming: UpcomingRow[]; compact?: boolean }) {
  if (upcoming.length === 0) return null;
  // 서버가 이미 이른 순으로 준다. 그래도 화면에서 다시 고르지 않고 첫 건을 쓴다.
  const first = upcoming[0]!;
  const rest = upcoming.length - 1;

  return (
    <div className={compact ? "fb fb-compact" : "fb"} role="status">
      <span className="fb-tag">예고</span>
      <span className="fb-main">
        <span className="fb-title">
          {whenLabel(first.at)} {KIND_LABEL[first.kind]} {GRADE_LABEL[first.grade]} 예상
          {" "}({Number(first.value.toFixed(1))}{first.unit})
          {rest > 0 && <span className="fb-more"> 외 {rest}건</span>}
        </span>
        {/* 지우지 말 것. 이 줄이 없으면 배너가 특보로 읽힌다. */}
        <span className="fb-note">{FORECAST_DISCLAIMER}</span>
      </span>
    </div>
  );
}
