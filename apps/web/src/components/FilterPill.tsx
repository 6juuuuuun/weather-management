import "./components.css";

export function FilterPill({
  selected,
  label,
  count,
  onClick,
}: {
  selected: boolean;
  label: string;
  count?: number;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`filter-pill ${selected ? "filter-pill-selected" : ""}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {label}
      {typeof count === "number" && <span className="filter-pill-count">{count}</span>}
    </button>
  );
}
