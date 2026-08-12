import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./AuthProvider";

export function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { employee, loading } = useAuth();
  if (loading) return null;
  if (!employee) return <Navigate to="/login" replace />;
  if (!roles.includes(employee.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
