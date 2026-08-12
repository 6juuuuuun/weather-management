import type { ReactNode } from "react";
import "./components.css";

export function SubNav({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="sub-nav">
      <div className="sub-nav-inner center-1120">
        <h1 className="sub-nav-title">{title}</h1>
        {actions && <div className="sub-nav-actions">{actions}</div>}
      </div>
    </div>
  );
}
