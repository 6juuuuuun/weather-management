import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthProvider";

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
  const { employee, loading, isApprover } = useAuth();
  if (loading) return null;
  if (!employee) return <Navigate to="/login" replace />;
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
