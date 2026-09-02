import "./components.css";

// tone="warn"은 "이 칩이 가리키는 상태에 문제가 있다"는 뜻이다. 특보 승인 수신자
// 목록에서 카카오워크에 연결되지 않은 사람을 구분하는 데 쓴다(QA W-31) — 그 사람은
// 승인권자로 지정돼 있어도 승인 요청 DM을 받지 못한다.
export function Chip({
  label,
  tone = "default",
  onRemove,
}: {
  label: string;
  tone?: "default" | "warn";
  onRemove?: () => void;
}) {
  return (
    <span className={tone === "warn" ? "chip chip-warn" : "chip"}>
      {label}
      {onRemove && (
        <button
          type="button"
          className="chip-remove"
          aria-label={`${label} 제거`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
