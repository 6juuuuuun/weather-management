import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { supabase } from "../lib/supabase";
import type { EmpRole } from "../lib/types";
import "./components.css";

const ROLE_LABEL: Record<EmpRole, string> = {
  admin: "시스템 관리자",
  approver: "사업부장",
  staff: "실무자",
};

type NavLink = { to: string; label: string; roles: EmpRole[] | null };

const NAV_LINKS: NavLink[] = [
  { to: "/", label: "대시보드", roles: null },
  { to: "/history", label: "발송 이력", roles: null },
  { to: "/guidelines", label: "행동 지침", roles: null },
  { to: "/criteria", label: "특보 기준", roles: null },
  { to: "/settings", label: "알림 설정", roles: ["admin", "approver"] },
  { to: "/employees", label: "직원 관리", roles: ["admin", "approver"] },
];

function minutesAgoLabel(lastRunAt: string): string {
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(lastRunAt).getTime()) / 60000));
  return `마지막 수집 ${diffMin}분 전`;
}

export function GlobalNav() {
  const { employee } = useAuth();
  const location = useLocation();
  const [siteName, setSiteName] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [siteRes, heartbeatRes] = await Promise.all([
        supabase.from("site_settings").select("site_name").eq("id", 1).single(),
        supabase.from("heartbeats").select("last_run_at").eq("name", "weather-tick").single(),
      ]);
      if (!active) return;
      setSiteName(siteRes.data?.site_name ?? null);
      setLastRunAt(heartbeatRes.data?.last_run_at ?? null);
    })();
    return () => {
      active = false;
    };
  }, []);

  const visibleLinks = NAV_LINKS.filter(
    (link) => !link.roles || (employee != null && link.roles.includes(employee.role)),
  );

  return (
    <nav className="global-nav">
      <div className="global-nav-inner">
        <Link to="/" className="global-nav-brand">
          <svg
            className="global-nav-brand-icon"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M17 8a4 4 0 0 1-.3 8H8a3.5 3.5 0 0 1-.6-6.95A4 4 0 0 1 15 6.1 4 4 0 0 1 17 8Z"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M10 3v1.2M6 4.6l.7.9M4 8h1.2M18.3 5.5l-.7.9" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          날씨경영
        </Link>

        <div className="global-nav-links">
          {visibleLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={`global-nav-link ${location.pathname === link.to ? "global-nav-link-active" : ""}`}
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="global-nav-meta">
          {siteName && (
            <span className="global-nav-site">
              {siteName} · {lastRunAt ? minutesAgoLabel(lastRunAt) : "수집 정보 없음"}
            </span>
          )}
          {employee && (
            <span className="global-nav-user">
              {employee.name} · {ROLE_LABEL[employee.role]}
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}
