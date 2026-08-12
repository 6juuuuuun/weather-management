import type { ReactNode } from "react";
import "./components.css";

export function EmptyState({
  icon,
  title,
  desc,
  cta,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  cta?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <h3 className="empty-state-title">{title}</h3>
      {desc && <p className="empty-state-desc">{desc}</p>}
      {cta && <div className="empty-state-cta">{cta}</div>}
    </div>
  );
}
