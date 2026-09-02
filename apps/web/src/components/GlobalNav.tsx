import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { siteSettings, heartbeat } from "../lib/api/dashboard";
import type { EmpRole } from "../lib/types";
import { ROLE_LABEL } from "../lib/roles";
import "./components.css";

type NavLink = { to: string; label: string; roles: EmpRole[] | null };

const NAV_LINKS: NavLink[] = [
  { to: "/", label: "대시보드", roles: null },
  { to: "/history", label: "발송 이력", roles: null },
  { to: "/guidelines", label: "행동 지침", roles: null },
  { to: "/criteria", label: "특보 기준", roles: null },
  { to: "/settings", label: "알림 설정", roles: ["admin", "approver"] },
  { to: "/employees", label: "직원 관리", roles: ["admin", "approver"] },
];

function minutesAgoLabel(lastRunAt: string, now: number): string {
  const diffMin = Math.max(0, Math.floor((now - new Date(lastRunAt).getTime()) / 60000));
  return `마지막 수집 ${diffMin}분 전`;
}

// 이 줄은 "수집이 살아 있는가"를 한눈에 말해 주는 유일한 상시 표시다. 대시보드는
// 30초마다 다시 부르는데 바로 위 네비게이션만 마운트 시점 값을 들고 있었다 —
// 탭을 열어 둔 채 하루를 보내면 아침 값이 "마지막 수집 3분 전"이라고 계속 말한다
// (QA W-32). 대시보드보다 느슨한 1분 주기면 충분하다(관측 자체가 매시 1회다).
export const NAV_POLL_MS = 60_000;

export function GlobalNav() {
  const { employee } = useAuth();
  const location = useLocation();
  const [siteName, setSiteName] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<string | null>(null);
  // "N분 전"은 조회 결과가 아니라 **지금 시각**에서 나온다. 서버 값이 그대로여도
  // 시간이 흐르면 숫자가 달라져야 하므로 현재 시각도 상태로 들고 함께 갱신한다.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [site, hb] = await Promise.all([siteSettings(), heartbeat("weather-tick")]);
        if (!active) return;
        setSiteName(site?.site_name ?? null);
        setLastRunAt(hb?.last_run_at ?? null);
        setNow(Date.now());
      } catch {
        // 조용히 삼킨다. 이 조회는 네비게이션 우측의 "지점명 · 마지막 수집 N분 전"
        // 한 줄을 채우는 게 전부고, 실패하면 siteName이 null로 남아 그 span 자체가
        // 렌더되지 않는다 — 링크·역할 표시 등 네비게이션의 본 기능은 그대로 동작한다.
        // 여기서 오류를 띄우면 모든 화면 상단에 배너가 겹쳐 뜨는데, 정작 각 페이지는
        // 자기 로더에서 같은 실패를 이미 보여준다(중복이고, 이 컴포넌트에는 재시도
        // 수단도 로딩 표시도 없다). 던지게 두면 처리되지 않은 rejection만 남는다.
      }
    };
    load();
    const t = setInterval(load, NAV_POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
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
              {siteName} · {lastRunAt ? minutesAgoLabel(lastRunAt, now) : "수집 정보 없음"}
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
