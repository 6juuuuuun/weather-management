import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import "./RequireRole.css";

export function RequireRole({
  roles,
  requireDepartment = false,
  children,
}: {
  roles: string[];
  /** true면 부서 미지정 실무자(staff, department_id null)의 접근을 차단하고 대시보드로 되돌린다.
   *  단 Alert 수신자는 예외 — 승인은 부서 단위 업무가 아니라 전사 판단이다. */
  requireDepartment?: boolean;
  children: ReactNode;
}) {
  const { status, employee, isApprover, authError, refresh } = useAuth();

  if (status === "loading") return null;

  // 인증 자체는 됐는데(로그인 200 + 쿠키) 그 뒤 직원 정보 조회가 실패한 경우다.
  // 예전에는 이 경우도 employee=null로 뭉개져 "오류 메시지 없이 로그인 폼이 다시
  // 뜨는" 무한 루프로 보였다(F4) — 로그인 폼으로 되돌리지 않고 설명과 재시도를 준다.
  if (status === "error") {
    return (
      <div className="require-role-error">
        <p>{authError ?? "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요."}</p>
        <button type="button" onClick={() => refresh()}>
          다시 시도
        </button>
      </div>
    );
  }

  // 비밀번호를 먼저 바꿔야 하는 세션이다. 보호 라우트를 직접 열거나 새로고침해도
  // /login이 아니라 /change-password로 보낸다(F5) — 로그인 직후의 navigate 하나에만
  // 의존하면, 재진입 경로 전부가 그 navigate를 거치지 않는다.
  if (status === "must-change-password") return <Navigate to="/change-password" replace />;

  if (status === "anonymous" || !employee) return <Navigate to="/login" replace />;
  if (!roles.includes(employee.role)) return <Navigate to="/" replace />;
  if (
    requireDepartment &&
    !isApprover &&
    employee.role === "staff" &&
    employee.department_id === null
  ) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
