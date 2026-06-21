/**
 * MCP Moira Web UI Application
 * Clean, professional workflow management interface
 */

import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { ThemeProvider } from "./hooks/useTheme";
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
import { Artifacts } from "./pages/Artifacts";
import { Settings } from "./pages/Settings";
import { TestError } from "./pages/TestError";
import { InviteAcceptPage } from "./pages/InviteAccept";
import { APP_PREFIX, ROUTES } from "./constants/routes";

// Lazy-loaded heavy pages
const WorkflowDetail = lazy(() =>
  import("./pages/WorkflowDetail").then((m) => ({ default: m.WorkflowDetail })),
);
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

// Import global styles
import "./styles/node-styles.css";

// Import i18n configuration
import "./i18n";

/**
 * Main Application Component
 * Dashboard-centric layout with sidebar navigation
 */
const App: React.FC = () => {
  return (
    <Suspense fallback={<div aria-live="polite">loading...</div>}>
      <BrowserRouter>
        <ThemeProvider>
          <FeaturesProvider>
            <AuthProvider>
              <Routes>
                {/* Auth routes */}
                <Route path={ROUTES.LOGIN} element={<Login />} />
                <Route path={ROUTES.REGISTER} element={<Register />} />
                <Route
                  path={`${APP_PREFIX}/registration-success`}
                  element={<RegistrationSuccess />}
                />
                <Route path={`${APP_PREFIX}/forgot-password`} element={<ForgotPassword />} />
                <Route path={`${APP_PREFIX}/reset-password`} element={<ResetPassword />} />
                <Route
                  path={ROUTES.FORCED_PASSWORD_RESET}
                  element={
                    <ProtectedRoute>
                      <ForcedPasswordReset />
                    </ProtectedRoute>
                  }
                />
                <Route path={`${APP_PREFIX}/verify-email`} element={<VerifyEmail />} />
                <Route path={ROUTES.OAUTH_AUTHORIZE} element={<OAuthAuthorize />} />
                <Route path={`${APP_PREFIX}/oauth/consent`} element={<OAuthConsent />} />

                {/* Test route for ErrorBoundary - only used for E2E testing */}
                <Route path={`${APP_PREFIX}/test-error`} element={<TestError />} />

                {/* Invite accept page - standalone page, works with or without auth */}
                <Route path={ROUTES.INVITE_ACCEPT} element={<InviteAcceptPage />} />

                {/* Root redirect to dashboard — only needed in /app mode to handle bare "/" */}
                {APP_PREFIX && (
                  <Route path="/" element={<Navigate to={ROUTES.DASHBOARD} replace />} />
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
                  <Route index element={<Dashboard />} />
                  <Route path="workflows" element={<Workflows />} />
                  <Route path="workflows/:handle/:slug" element={<WorkflowDetail />} />
                  <Route path="workflows/:id" element={<WorkflowDetail />} />
                  <Route path="executions" element={<Executions />} />
                  <Route path="executions/:id" element={<ExecutionInspectorPage />} />
                  <Route path="notes" element={<Notes />} />
                  <Route path="artifacts" element={<Artifacts />} />
                  <Route path="settings" element={<Settings />} />
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
                  <Route index element={<AdminDashboard />} />
                  <Route
                    path="users"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <UserManagement />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="users/:id"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminUserDetail />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="executions"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminExecutions />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="executions/:id"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminExecutionInspectorPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="workflows"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminWorkflows />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="artifacts"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminArtifacts />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="artifacts/reported"
                    element={
                      <ProtectedRoute requireAdmin requireMultiUserAdmin>
                        <AdminReportedArtifacts />
                      </ProtectedRoute>
                    }
                  />
                  <Route path="audit-log" element={<AuditLog />} />
                  <Route path="settings" element={<AdminSettingsUnified />} />
                  <Route
                    path="global-settings"
                    element={<AdminSettingsUnified defaultTab="values" />}
                  />
                  <Route path="deleted-workflows" element={<DeletedWorkflows />} />
                  <Route path="monitoring-test" element={<AdminMonitoringTest />} />
                  <Route path="tokens" element={<AdminTokens />} />
                  <Route path="operational" element={<OperationalDashboard />} />
                  <Route path="analytics" element={<Navigate to={ROUTES.ADMIN} replace />} />
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
