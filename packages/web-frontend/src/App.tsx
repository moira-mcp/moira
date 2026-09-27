/**
 * MCP Moira Web UI Application
 * Clean, professional workflow management interface
 */

import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { ThemeProvider } from "./hooks/useTheme";
import { HintLayer } from "./components/diagram/Hint";
import { FeaturesProvider } from "./hooks/useFeatures";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { MainAppLayout } from "./components/layout/MainAppLayout";
import { AdminLayout } from "./components/layout/AdminLayout";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { RegistrationSuccess } from "./pages/RegistrationSuccess";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";
import { ForcedPasswordReset } from "./pages/ForcedPasswordReset";
import { VerifyEmail } from "./pages/VerifyEmail";
import { OAuthAuthorize } from "./pages/OAuthAuthorize";
import { OAuthConsent } from "./pages/OAuthConsent";
import { Dashboard } from "./pages/Dashboard";
import { Workflows } from "./pages/Workflows";
import { Notes } from "./pages/Notes";
import { Playbooks } from "./pages/Playbooks";
import { Artifacts } from "./pages/Artifacts";
import { Settings } from "./pages/Settings";
import { TestError } from "./pages/TestError";
import { InviteAcceptPage } from "./pages/InviteAccept";
import { APP_PREFIX, ROUTES } from "./constants/routes";
import { RouteSkeleton } from "./components/route-skeleton";
import {
  ADMIN_ROUTES,
  MAIN_ROUTES,
  ROOT_REDIRECT,
  STANDALONE_ROUTES,
  type AdminRouteId,
  type MainRouteId,
  type StandaloneRouteId,
} from "./routes/routeTable";

// Lazy-loaded heavy pages
const FlowPage = lazy(() => import("./pages/FlowPage").then((m) => ({ default: m.FlowPage })));
const Executions = lazy(() =>
  import("./pages/Executions").then((m) => ({ default: m.Executions })),
);
const ExecutionInspectorPage = lazy(() =>
  import("./pages/ExecutionInspectorPage").then((m) => ({ default: m.ExecutionInspectorPage })),
);
const AdminDashboard = lazy(() =>
  import("./pages/AdminDashboard").then((m) => ({ default: m.AdminDashboard })),
);
const UserManagement = lazy(() =>
  import("./pages/UserManagement").then((m) => ({ default: m.UserManagement })),
);
const AdminUserDetail = lazy(() =>
  import("./pages/AdminUserDetail").then((m) => ({ default: m.AdminUserDetail })),
);
const AdminExecutions = lazy(() =>
  import("./pages/AdminExecutions").then((m) => ({ default: m.AdminExecutions })),
);
const AdminWorkflows = lazy(() =>
  import("./pages/AdminWorkflows").then((m) => ({ default: m.AdminWorkflows })),
);
const AdminExecutionInspectorPage = lazy(() =>
  import("./pages/AdminExecutionInspectorPage").then((m) => ({
    default: m.AdminExecutionInspectorPage,
  })),
);
const AdminArtifacts = lazy(() =>
  import("./pages/AdminArtifacts").then((m) => ({ default: m.AdminArtifacts })),
);
const AdminReportedArtifacts = lazy(() =>
  import("./pages/AdminReportedArtifacts").then((m) => ({ default: m.AdminReportedArtifacts })),
);
const AuditLog = lazy(() => import("./pages/AuditLog").then((m) => ({ default: m.AuditLog })));
const AdminSettingsUnified = lazy(() =>
  import("./pages/AdminSettingsUnified").then((m) => ({ default: m.AdminSettingsUnified })),
);
const DeletedWorkflows = lazy(() =>
  import("./pages/DeletedWorkflows").then((m) => ({ default: m.DeletedWorkflows })),
);
const AdminMonitoringTest = lazy(() =>
  import("./pages/AdminMonitoringTest").then((m) => ({ default: m.AdminMonitoringTest })),
);
const AdminTokens = lazy(() =>
  import("./pages/AdminTokens").then((m) => ({ default: m.AdminTokens })),
);
const OperationalDashboard = lazy(() =>
  import("./pages/OperationalDashboard").then((m) => ({ default: m.OperationalDashboard })),
);

// Import i18n configuration
import "./i18n";

/** The page each route renders; the table in `routes/routeTable.ts` holds the paths. */
const STANDALONE_PAGES: Record<StandaloneRouteId, React.ReactNode> = {
  login: <Login />,
  register: <Register />,
  "registration-success": <RegistrationSuccess />,
  "forgot-password": <ForgotPassword />,
  "reset-password": <ResetPassword />,
  "forced-password-reset": <ForcedPasswordReset />,
  "verify-email": <VerifyEmail />,
  "oauth-authorize": <OAuthAuthorize />,
  "oauth-consent": <OAuthConsent />,
  "test-error": <TestError />,
  "invite-accept": <InviteAcceptPage />,
};

const MAIN_PAGES: Record<MainRouteId, React.ReactNode> = {
  home: <Dashboard />,
  flows: <Workflows />,
  "flow-by-name": <FlowPage />,
  "flow-by-id": <FlowPage />,
  runs: <Executions />,
  run: <ExecutionInspectorPage />,
  notes: <Notes />,
  playbooks: <Playbooks />,
  artifacts: <Artifacts />,
  settings: <Settings />,
};

const ADMIN_PAGES: Record<AdminRouteId, React.ReactNode> = {
  admin: <AdminDashboard />,
  "admin-users": <UserManagement />,
  "admin-user": <AdminUserDetail />,
  "admin-runs": <AdminExecutions />,
  "admin-run": <AdminExecutionInspectorPage />,
  "admin-flows": <AdminWorkflows />,
  "admin-artifacts": <AdminArtifacts />,
  "admin-reported-artifacts": <AdminReportedArtifacts />,
  "admin-audit-log": <AuditLog />,
  "admin-settings": <AdminSettingsUnified />,
  "admin-global-settings": <AdminSettingsUnified defaultTab="values" />,
  "admin-deleted-flows": <DeletedWorkflows />,
  "admin-monitoring-test": <AdminMonitoringTest />,
  "admin-tokens": <AdminTokens />,
  "admin-operational": <OperationalDashboard />,
  "admin-analytics": <Navigate to={ROUTES.ADMIN} replace />,
};

/** A child route's path relative to its layout's path; the layout's own path is its index. */
function childRoute(base: string, path: string, element: React.ReactNode): React.ReactElement {
  return path === base ? (
    <Route key={path} index element={element} />
  ) : (
    <Route key={path} path={path.slice(base === "/" ? 1 : base.length + 1)} element={element} />
  );
}
/**
 * Main Application Component
 * Dashboard-centric layout with sidebar navigation. Lazily loaded pages inside the layouts are
 * caught by the layouts' own Suspense boundaries (the sidebar stays while a page's code
 * arrives); this outer boundary only covers a chunk loaded outside any layout.
 */
const App: React.FC = () => {
  return (
    <Suspense fallback={<RouteSkeleton />}>
      <BrowserRouter>
        <ThemeProvider>
          <HintLayer />
          <FeaturesProvider>
            <AuthProvider>
              <Routes>
                {/* Standalone pages: sign-in, account recovery, consent screens */}
                {STANDALONE_ROUTES.map((route) => {
                  const page = STANDALONE_PAGES[route.id];
                  return (
                    <Route
                      key={route.id}
                      path={`${APP_PREFIX}${route.path}`}
                      element={
                        "signedIn" in route && route.signedIn ? (
                          <ProtectedRoute>{page}</ProtectedRoute>
                        ) : (
                          page
                        )
                      }
                    />
                  );
                })}

                {/* Root redirect to dashboard — only needed in /app mode to handle bare "/" */}
                {APP_PREFIX && (
                  <Route
                    path={ROOT_REDIRECT.path}
                    element={<Navigate to={ROUTES.DASHBOARD} replace />}
                  />
                )}

                {/* Main App routes - for all users */}
                <Route
                  path={APP_PREFIX}
                  element={
                    <ProtectedRoute>
                      <MainAppLayout />
                    </ProtectedRoute>
                  }
                >
                  {MAIN_ROUTES.map((route) => childRoute("/", route.path, MAIN_PAGES[route.id]))}
                </Route>

                {/* Admin routes - admin only */}
                <Route
                  path={ROUTES.ADMIN}
                  element={
                    <ProtectedRoute requireAdmin>
                      <AdminLayout />
                    </ProtectedRoute>
                  }
                >
                  {ADMIN_ROUTES.map((route) => {
                    const page = ADMIN_PAGES[route.id];
                    return childRoute(
                      "/admin",
                      route.path,
                      "capability" in route ? (
                        <ProtectedRoute requireAdmin requireCapability={route.capability}>
                          {page}
                        </ProtectedRoute>
                      ) : (
                        page
                      ),
                    );
                  })}
                </Route>
              </Routes>
            </AuthProvider>
          </FeaturesProvider>
        </ThemeProvider>
      </BrowserRouter>
    </Suspense>
  );
};

export default App;
