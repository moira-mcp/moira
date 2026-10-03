/**
 * Auth Error Handler Hook
 * Handles 401/403 responses from API by redirecting to login
 * and showing appropriate error messages
 */

import { useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { setAuthErrorHandler } from "../services/api-client";
import { authClient, revokeObservedSession } from "../auth/better-auth-client";
import { ROUTES, APP_PREFIX } from "../constants/routes";
import { buildLoginUrlWithReturn } from "../utils/return-url";
import { getReadOwner, getSessionAuthoritySignature } from "../services/read-scope";

type AuthErrorOperation = {
  owner: string;
  userId: string | null;
  sessionSignature: string | null;
  replaced: boolean;
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Hook to handle auth errors (401/403) from API responses
 * Must be used inside Router context
 */
export const useAuthErrorHandler = (): void => {
  const navigate = useNavigate();
  const location = useLocation();
  const handlingRef = useRef<AuthErrorOperation | null>(null);

  useEffect(
    () => () => {
      const operation = handlingRef.current;
      handlingRef.current = null;
      operation?.unsubscribe();
      if (operation?.timer) clearTimeout(operation.timer);
    },
    [],
  );

  const handleAuthError = useCallback(
    (status: number, message: string) => {
      const session = authClient.$store.atoms.session.get().data;
      const owner = getReadOwner();
      const userId = session?.user.id ?? null;
      const sessionSignature = getSessionAuthoritySignature(session?.session);
      const previous = handlingRef.current;
      // Debounce only the account and credentials which started this operation.
      if (
        previous &&
        !previous.replaced &&
        previous.owner === owner &&
        previous.userId === userId &&
        previous.sessionSignature === sessionSignature
      )
        return;

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

      previous?.unsubscribe();
      if (previous?.timer) clearTimeout(previous.timer);
      const operation: AuthErrorOperation = {
        owner,
        userId,
        sessionSignature,
        replaced: false,
        unsubscribe: () => {},
      };
      handlingRef.current = operation;
      operation.unsubscribe = authClient.$store.atoms.session.listen((snapshot) => {
        // Our own sign-out may produce null. An admitted replacement must permanently
        // retire this callback, even if that replacement subsequently signs out too.
        if (
          snapshot.data &&
          (snapshot.data.user.id !== userId ||
            getSessionAuthoritySignature(snapshot.data.session) !== sessionSignature)
        )
          operation.replaced = true;
      });

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
      const settle = () => {
        if (handlingRef.current !== operation) return;
        const currentSession = authClient.$store.atoms.session.get().data;
        if (
          operation.replaced ||
          (currentSession &&
            (getReadOwner() !== operation.owner ||
              currentSession.user.id !== operation.userId ||
              getSessionAuthoritySignature(currentSession.session) !== operation.sessionSignature))
        ) {
          operation.unsubscribe();
          handlingRef.current = null;
          return;
        }
        navigate(loginUrl, { replace: true });
        // A former operation's timer cannot clear a newer account's suppression.
        operation.timer = setTimeout(() => {
          operation.unsubscribe();
          if (handlingRef.current === operation) handlingRef.current = null;
        }, 1000);
      };
      void revokeObservedSession(session?.session).then((owned) => {
        if (owned) settle();
        else {
          operation.unsubscribe();
          if (handlingRef.current === operation) handlingRef.current = null;
        }
      }, settle);
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
