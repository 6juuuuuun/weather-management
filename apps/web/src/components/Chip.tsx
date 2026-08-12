import "./components.css";

export function Chip({ label, onRemove }: { label: string; onRemove?: () => void }) {
  return (
    <span className="chip">
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
