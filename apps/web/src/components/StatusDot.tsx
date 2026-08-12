import "./components.css";

export function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`status-dot-wrap ${ok ? "status-ok" : "status-fail"}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
