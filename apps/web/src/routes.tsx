import { Navigate, Route, Routes } from "react-router-dom";
import { RequireRole } from "./auth/RequireRole";
import Login from "./pages/Login";
import AuthCallback from "./pages/AuthCallback";
import Dashboard from "./pages/Dashboard";
import Criteria from "./pages/Criteria";
import Guidelines from "./pages/Guidelines";
import EventReview from "./pages/EventReview";
import History from "./pages/History";
import Settings from "./pages/Settings";
import Employees from "./pages/Employees";

const ALL_ROLES = ["admin", "approver", "staff"];

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route
        path="/"
        element={
          <RequireRole roles={ALL_ROLES}>
            <Dashboard />
          </RequireRole>
        }
      />
      <Route
        path="/criteria"
        element={
          <RequireRole roles={ALL_ROLES} requireDepartment>
            <Criteria />
          </RequireRole>
        }
      />
      <Route
        path="/guidelines"
        element={
          <RequireRole roles={ALL_ROLES} requireDepartment>
            <Guidelines />
          </RequireRole>
        }
      />
      <Route
        path="/events/:id"
        element={
          <RequireRole roles={ALL_ROLES} requireDepartment>
            <EventReview />
          </RequireRole>
        }
      />
      <Route
        path="/history"
        element={
          <RequireRole roles={ALL_ROLES}>
            <History />
          </RequireRole>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireRole roles={["admin", "approver"]}>
            <Settings />
          </RequireRole>
        }
      />
      <Route
        path="/employees"
        element={
          <RequireRole roles={["admin", "approver"]}>
            <Employees />
          </RequireRole>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
