import "./BoardTicker.css";

export type TickerItem = {
  label: string;
  value: number;
  unit: string;
  threshold: number;
  gradeLabel: string;
};

export function gapPhrase(item: TickerItem): { text: string; over: boolean } {
  // 판정 엔진이 >= 로 초과를 판단하므로(supabase/functions/_shared/engine.ts) 여기도 맞춘다.
  const over = item.value >= item.threshold;
  const diff = Math.abs(item.value - item.threshold).toFixed(1);
  return over
    ? { text: `${item.gradeLabel} 기준 초과 +${diff}${item.unit}`, over: true }
    : { text: `${item.gradeLabel}까지 ${diff}${item.unit}`, over: false };
}

// copyIndex: 끊김 없는 순환을 위해 트랙을 2벌 이어붙이는데, 두 벌 모두 동일한
// items를 렌더링하므로 label+i만으로는 키가 두 벌 사이에서 충돌한다.
// (React가 Fragment를 펼치면 두 Row의 자식이 .bt-track 아래 같은 형제 목록에 놓인다.)
function Row({ items, copyIndex }: { items: TickerItem[]; copyIndex: number }) {
  return (
    <>
      {items.map((it, i) => {
        const g = gapPhrase(it);
        return (
          <span className="bt-item" key={`${copyIndex}-${it.label}-${i}`}>
            <b className="bt-label">{it.label}</b>
            <span className="bt-value">
              {Number(it.value.toFixed(1))}
              {it.unit}
            </span>
            <span className={g.over ? "bt-gap bt-over" : "bt-gap"}>· {g.text}</span>
          </span>
        );
      })}
    </>
  );
}

export function BoardTicker({ items }: { items: TickerItem[] }) {
  if (items.length === 0) return null;
  // 트랙을 2벌 이어붙이고 -50% 이동시켜 끊김 없이 순환시킨다.
  return (
    <div className="bt">
      <div className="bt-track">
        <Row items={items} copyIndex={0} />
        <Row items={items} copyIndex={1} />
      </div>
    </div>
  );
}
