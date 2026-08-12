import type { ReactNode } from "react";
import { GlobalNav } from "./GlobalNav";
import { SubNav } from "./SubNav";
import "./components.css";

export function AppLayout({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app-layout">
      <GlobalNav />
      <SubNav title={title} actions={actions} />
      <main className="app-content center-1120">{children}</main>
    </div>
  );
}
