import { Navigate, Route, Routes } from "react-router-dom";
import { RequireRole } from "./auth/RequireRole";
import Login from "./pages/Login";
import AuthCallback from "./pages/AuthCallback";

// 아래 플레이스홀더들은 이후 페이지 태스크에서 각각 실제 화면으로 대체된다.
const ALL_ROLES = ["admin", "approver", "staff"];

function Placeholder({ title }: { title: string }) {
  return <div style={{ padding: 40 }}>{title}</div>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route
        path="/"
        element={
          <RequireRole roles={ALL_ROLES}>
            <Placeholder title="대시보드" />
          </RequireRole>
        }
      />
      <Route
        path="/criteria"
        element={
          <RequireRole roles={["admin"]}>
            <Placeholder title="특보 기준" />
          </RequireRole>
        }
      />
      <Route
        path="/guidelines"
        element={
          <RequireRole roles={ALL_ROLES}>
            <Placeholder title="행동 지침" />
          </RequireRole>
        }
      />
      <Route
        path="/events/:id"
        element={
          <RequireRole roles={ALL_ROLES}>
            <Placeholder title="특보 검토" />
          </RequireRole>
        }
      />
      <Route
        path="/history"
        element={
          <RequireRole roles={ALL_ROLES}>
            <Placeholder title="발송 이력" />
          </RequireRole>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireRole roles={["admin"]}>
            <Placeholder title="시스템 설정" />
          </RequireRole>
        }
      />
      <Route
        path="/employees"
        element={
          <RequireRole roles={["admin"]}>
            <Placeholder title="구성원 관리" />
          </RequireRole>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
