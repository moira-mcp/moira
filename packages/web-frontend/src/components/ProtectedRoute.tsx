/**
 * Protected Route Component
 * Redirects unauthenticated users to login page
 * Optionally checks for admin privileges
 */

import React, { useEffect, useState, useRef } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import { useSession, authClient } from "../auth/better-auth-client";
import { apiClient } from "../services/api-client";
import { ROUTES, APP_PREFIX } from "../constants/routes";
import { buildLoginUrlWithReturn } from "../utils/return-url";
import { useFeatures } from "../hooks/useFeatures";
import { decideAdmissionRoute } from "../auth/admission-routing";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requireEmailVerified?: boolean;
  requireMultiUserAdmin?: boolean;
  requireUserManagement?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requireAdmin = false,
  requireEmailVerified = true,
  requireMultiUserAdmin = false,
  requireUserManagement = false,
}) => {
  const {
    isEnabled: isFeatureEnabled,
    loaded: featuresLoaded,
    error: featuresError,
    retry: retryFeatures,
  } = useFeatures();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = useSession();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [passwordResetRequired, setPasswordResetRequired] = useState<boolean | null>(null);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [accountApproved, setAccountApproved] = useState<boolean | null>(null);
  const [accountApprovalRequired, setAccountApprovalRequired] = useState<boolean | null>(null);
  const [_blocked, setBlocked] = useState<boolean | null>(null);
  const [checkingUser, setCheckingUser] = useState(false);
  const [userInfoError, setUserInfoError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  // Track session to detect re-login (session token changes on signIn)
  const fetchedSessionRef = useRef<string | null>(null);

  // Fetch user info when session loads or session changes (re-login)
  useEffect(() => {
    // Use session token to detect re-login (token changes, userId stays same)
    const sessionKey = session?.session?.id || null;

    // Fetch if: have session, not pending, and either haven't fetched or session changed
    if (session && !isPending && fetchedSessionRef.current !== sessionKey) {
      fetchedSessionRef.current = sessionKey;
      setCheckingUser(true);
      setUserInfoError(false);

      apiClient
        .getUserInfo()
        .then((userInfo) => {
          setIsAdmin(userInfo.isAdmin);
          setPasswordResetRequired(userInfo.passwordResetRequired);
          setEmailVerified(userInfo.emailVerified);
          setAccountApproved(userInfo.accountApproved);
          setAccountApprovalRequired(userInfo.accountApprovalRequired);
          setBlocked(userInfo.blocked);
          setCheckingUser(false);
          setUserInfoError(false);

          // Check if user is blocked
          if (userInfo.blocked) {
            // Force logout
            authClient.signOut().then(() => {
              navigate(ROUTES.LOGIN, { replace: true });
            });
            return;
          }

          // Immediately redirect if password reset required
          if (
            userInfo.passwordResetRequired &&
            window.location.pathname !== ROUTES.FORCED_PASSWORD_RESET
          ) {
            navigate(ROUTES.FORCED_PASSWORD_RESET, { replace: true });
          }
        })
        .catch(() => {
          setIsAdmin(false);
          setPasswordResetRequired(false);
          setEmailVerified(false);
          setAccountApproved(null);
          setAccountApprovalRequired(null);
          setBlocked(false);
          setCheckingUser(false);
          setUserInfoError(true);
          fetchedSessionRef.current = null; // Allow retry on error
        });
    } else if (!session) {
      // Reset state when logged out
      setIsAdmin(null);
      setPasswordResetRequired(null);
      setEmailVerified(null);
      setAccountApproved(null);
      setAccountApprovalRequired(null);
      setBlocked(null);
      setCheckingUser(false);
      setUserInfoError(false);
      fetchedSessionRef.current = null;
    }
  }, [session, isPending, navigate, retryKey]);

  // Show loading while checking auth or user info
  if (isPending || checkingUser) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Not authenticated - redirect to login with returnUrl
  if (!session) {
    const currentUrl = location.pathname + location.search;
    const loginUrl = buildLoginUrlWithReturn(currentUrl, ROUTES.LOGIN);
    return <Navigate to={loginUrl} replace />;
  }

  if (userInfoError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3" role="alert">
        <p className="text-sm text-destructive">{t("pages.registrationSuccess.statusLoadError")}</p>
        <Button variant="outline" onClick={() => setRetryKey((current) => current + 1)}>
          {t("pages.registrationSuccess.retryStatus")}
        </Button>
      </div>
    );
  }

  if (featuresError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3" role="alert">
        <p className="text-sm text-destructive">
          {t("pages.registrationSuccess.featuresLoadError")}
        </p>
        <Button variant="outline" onClick={retryFeatures}>
          {t("pages.registrationSuccess.retryFeatures")}
        </Button>
      </div>
    );
  }

  // Password reset required - redirect to forced password reset page
  // ONLY redirect after we have loaded user info (passwordResetRequired is not null)
  if (passwordResetRequired === true && window.location.pathname !== ROUTES.FORCED_PASSWORD_RESET) {
    return <Navigate to={ROUTES.FORCED_PASSWORD_RESET} replace />;
  }

  const admissionStateLoaded =
    accountApproved !== null && accountApprovalRequired !== null && emailVerified !== null;
  if (admissionStateLoaded && featuresLoaded) {
    const admissionDecision = decideAdmissionRoute({
      accountApprovalRequired,
      accountApproved,
      emailVerificationGate: requireEmailVerified && isFeatureEnabled("emailVerificationGate"),
      emailVerified,
    });
    if (admissionDecision !== "allow") {
      return <Navigate to={`${APP_PREFIX}/registration-success`} replace />;
    }
  }

  // Require admin but user is not admin - redirect to workflows
  if (requireAdmin && isAdmin === false) {
    return <Navigate to={ROUTES.WORKFLOWS} replace />;
  }

  // Wait until both deployment capabilities and independent admission facts are known.
  if (!featuresLoaded || !admissionStateLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Still checking admin status - show loading
  if (requireAdmin && isAdmin === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  // Multi-user admin pages are hidden when the feature is off (self-host).
  // Wait for the feature flags to load before deciding, then redirect direct
  // navigation back to the admin dashboard.
  if (requireMultiUserAdmin) {
    if (!featuresLoaded) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      );
    }
    if (!isFeatureEnabled("multiUserAdmin")) {
      return <Navigate to={ROUTES.ADMIN} replace />;
    }
  }

  if (requireUserManagement && !isFeatureEnabled("userManagement")) {
    return <Navigate to={ROUTES.ADMIN} replace />;
  }

  return <>{children}</>;
};
