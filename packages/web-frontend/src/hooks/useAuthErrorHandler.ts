/**
 * Auth Error Handler Hook
 * Handles 401/403 responses from API by redirecting to login
 * and showing appropriate error messages
 */

import { useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { setAuthErrorHandler } from "../services/api-client";
import { authClient } from "../auth/better-auth-client";
import { ROUTES, APP_PREFIX } from "../constants/routes";
import { buildLoginUrlWithReturn } from "../utils/return-url";

/**
 * Hook to handle auth errors (401/403) from API responses
 * Must be used inside Router context
 */
export const useAuthErrorHandler = (): void => {
  const navigate = useNavigate();
  const location = useLocation();
  const isHandlingRef = useRef(false);

  const handleAuthError = useCallback(
    (status: number, message: string) => {
      // Prevent multiple simultaneous redirects
      if (isHandlingRef.current) return;

      // Don't redirect if already on login/auth pages
      const currentPath = location.pathname;
      const authPaths = [
        ROUTES.LOGIN,
        ROUTES.REGISTER,
        `${APP_PREFIX}/forgot-password`,
        `${APP_PREFIX}/reset-password`,
        `${APP_PREFIX}/verify-email`,
        ROUTES.FORCED_PASSWORD_RESET, // Don't redirect during forced password reset flow
      ];

      if (authPaths.some((path) => currentPath.startsWith(path))) {
        return;
      }

      isHandlingRef.current = true;

      // Show toast with error message
      if (status === 401) {
        toast.error("Session Expired", {
          description: message || "Your session has expired. Please log in again.",
        });
      } else if (status === 403) {
        toast.error("Access Denied", {
          description: message || "Your account may have been blocked.",
        });
      }

      // Sign out and redirect to login, preserving current URL for return after re-login
      const currentUrl = location.pathname + location.search;
      const loginUrl = buildLoginUrlWithReturn(currentUrl, ROUTES.LOGIN);
      authClient.signOut().finally(() => {
        navigate(loginUrl, { replace: true });
        // Reset flag after a short delay to allow for new redirects
        setTimeout(() => {
          isHandlingRef.current = false;
        }, 1000);
      });
    },
    [navigate, location.pathname, location.search],
  );

  // Register handler on mount, unregister on unmount
  useEffect(() => {
    setAuthErrorHandler(handleAuthError);
    return () => {
      setAuthErrorHandler(null);
    };
  }, [handleAuthError]);
};
