import { useId } from "react";
import { computeScale, yOf } from "../lib/chartScale";
import "./MetricChart.css";

// 보드 카드 안 비율. viewBox를 늘려 쓰지 않는다 — 늘리면 선뿐 아니라
// 축 라벨 글자까지 세로로 찌그러진다(시안에서 확인).
const W = 840;
const H = 196;
const PAD_T = 22;
const PAD_B = 18;

export type MetricChartProps = {
  values: number[];
  // null이면 이 지표에 아직 기준이 설정되지 않았다는 뜻이다(DashboardBoard가
  // threshold<=0을 null로 변환해 넘긴다). 0을 그대로 받으면 0을 실제 임계처럼
  // 그려 "0mm 초과" 같은 거짓 기준선이 뜬다.
  threshold: number | null;
  unit: string;
  gradeLabel: string;
  allowNegative: boolean;
  tone: "calm" | "near" | "over";
  /**
   * 앞으로의 예보. 비면 지금과 완전히 같게 그린다 — 기존 호출부를 지킨다.
   *
   * **이 값은 tone(색)에 영향을 주지 않는다.** 색과 큰 숫자는 "지금"만
   * 말해야 한다. 예보가 임계를 넘는다고 카드를 빨갛게 만들면, 3미터 밖에서
   * 흘끗 본 사람이 지금 폭우가 오는 줄 안다. 예보의 초과는 점선이 임계선을
   * 넘는 그림으로만 말한다.
   */
  forecast?: number[];
};

function fmt(v: number): string {
  return Number(v.toFixed(2)).toString();
}

export function MetricChart({
  values, threshold, unit, gradeLabel, allowNegative, tone, forecast,
}: MetricChartProps) {
  // 훅은 조건부 반환보다 먼저 호출해야 한다(React 규칙).
  // useId로 clipPath id를 만드는 이유: 월보드는 카드 4개가 한 화면에 동시에
  // 렌더된다. props(tone/길이/lo)로 id를 조합하면 같은 시간창을 쓰는
  // 두 지표가 같은 tone·같은 lo(예: 둘 다 0으로 클램프)일 때 id가 겹쳐
  // 서로 다른 차트의 clipPath를 잘못 참조하게 된다. useId는 컴포넌트
  // 인스턴스마다 고유해 이 충돌이 원천적으로 없다.
  // useId()는 ":r0:" 형태로 콜론을 포함한다. url(#...) 프래그먼트 참조에서
  // 콜론 포함 id가 일부 WebKit에서 깨지므로 제거한다.
  const uid = useId().replace(/:/g, "");

  if (values.length === 0) return <div className="mc-empty" />;

  const fc = forecast ?? [];
  // 축은 관측과 예보를 **함께** 본다. 관측 범위에만 맞추면 예보 점선이
  // 화면 밖으로 나가 아무것도 보여주지 못한다.
  const { lo, hi, flat, thresholdVisible } = computeScale([...values, ...fc], threshold, allowNegative);

  // 가로축을 관측 구간과 예보 구간으로 나눈다. 관측이 왼쪽, 예보가 오른쪽이다.
  const total = values.length + fc.length;
  const xAt = (i: number) => (total <= 1 ? W / 2 : (i * W) / (total - 1));
  const pts = values.map((v, i) => ({ x: xAt(i), y: yOf(v, lo, hi, H, PAD_T, PAD_B) }));
  const fcPts = fc.map((v, i) => ({ x: xAt(values.length + i), y: yOf(v, lo, hi, H, PAD_T, PAD_B) }));
  const last = pts[pts.length - 1];
  const line = "M" + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L");
  const area = `${line} L${last.x.toFixed(1)},${H} L${pts[0].x.toFixed(1)},${H} Z`;
  // threshold가 null이면 비교 대상이 없다 — ty는 (thresholdVisible이 항상
  // false라) 실제로 렌더에 쓰이지 않는 자리표시값이다.
  const ty = threshold !== null ? yOf(threshold, lo, hi, H, PAD_T, PAD_B) : 0;

  const allZero = values.every((v) => v === 0);
  // threshold가 null이면 "넘겼다"를 판정할 기준이 없으므로 항상 미달로 본다.
  // **관측(values)만 본다** — 예보를 섞으면 색이 "지금"이 아니라 "앞으로"를
  // 말하게 된다(이 파일에서 가장 중요한 불변식).
  const everOver = threshold !== null && Math.max(...values) >= threshold;
  const clipId = `mc-lo-${uid}`;
  const clipHiId = `mc-hi-${uid}`;

  return (
    <svg className="mc" viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
      {!allZero && everOver && thresholdVisible && (
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y={ty} width={W} height={H} />
          </clipPath>
          <clipPath id={clipHiId}>
            <rect x="0" y="0" width={W} height={ty} />
          </clipPath>
        </defs>
      )}

      {/* threshold !== null은 thresholdVisible이 참일 때 항상 성립하지만(computeScale
          계약), fmt(threshold)에 number를 넘기려면 여기서도 타입을 좁혀야 한다. */}
      {thresholdVisible && threshold !== null && (
        <>
          <line className="mc-threshold" x1="0" y1={ty} x2={W} y2={ty} />
          {/* 라벨은 좌측. 우측은 최신값 점이 있어 겹친다(시안에서 확인). */}
          <rect className="mc-chip" x="0" y={ty - 23} width="96" height="20" rx="4" />
          <text className="mc-thrlabel" x="6" y={ty - 9}>
            {gradeLabel} {fmt(threshold)}{unit}
          </text>
        </>
      )}

      {!allZero && (
        everOver && thresholdVisible ? (
          <>
            <path className="mc-area-below" d={area} clipPath={`url(#${clipId})`} />
            <path className={`mc-area-above mc-fill-${tone === "calm" ? "near" : tone}`} d={area}
                  clipPath={`url(#${clipHiId})`} />
          </>
        ) : (
          <path className={`mc-area-below mc-fill-${tone}`} d={area} />
        )
      )}

      {values.length > 1 && <path className={`mc-line mc-tone-${tone}`} d={line} />}
      <circle className={`mc-dot mc-tone-${tone}`} cx={last.x} cy={last.y} r="6" />

      {fcPts.length > 0 && (
        <>
          {/* "지금" 경계. 이 선이 없으면 어디까지가 실제로 일어난 일인지 알 수 없다. */}
          <line className="mc-now" x1={last.x} y1="0" x2={last.x} y2={H} />
          <path
            className="mc-forecast"
            d={"M" + [last, ...fcPts].map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L")}
          />
        </>
      )}

      <text className="mc-axis" x="0" y="12">{fmt(hi)}</text>
      <text className="mc-axis" x="0" y={H - 3}>{fmt(lo)}</text>
      {flat && <text className="mc-flat" x="8" y={H / 2 - 10}>변화 없음</text>}
    </svg>
  );
}
