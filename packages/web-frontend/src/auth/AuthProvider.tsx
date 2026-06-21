/**
 * AuthUIProvider wrapper for Better Auth UI components
 * Custom navigate wrapper for OAuth /api/auth/mcp/authorize redirects
 * Global auth error state management through external store (not React state)
 * Auth error interception for 401/403 responses
 *
 * IMPORTANT: Auth error uses external store pattern to prevent form re-renders.
 * Only AuthErrorDisplay subscribes to error changes via useSyncExternalStore.
 */

import React, { useRef, createContext, useContext, useCallback, useSyncExternalStore } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { AuthUIProvider, AuthLocalization } from "@daveyplate/better-auth-ui";
import { Toaster, toast as sonnerToast } from "sonner";
import { useTranslation } from "react-i18next";
import { authClient } from "./better-auth-client";
import { useAuthErrorHandler } from "../hooks/useAuthErrorHandler";
import { useFeatures } from "../hooks/useFeatures";
import { ROUTES, APP_PREFIX } from "../constants/routes";

interface AuthProviderProps {
  children: React.ReactNode;
}

// External store for auth error - changes don't trigger parent re-renders
let authErrorStore: string | null = null;
const authErrorListeners = new Set<() => void>();

const authErrorActions = {
  set: (error: string | null) => {
    authErrorStore = error;
    authErrorListeners.forEach((listener) => listener());
  },
  clear: () => {
    authErrorStore = null;
    authErrorListeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    authErrorListeners.add(listener);
    return () => authErrorListeners.delete(listener);
  },
  getSnapshot: () => authErrorStore,
};

// Hook to subscribe to auth error changes (only re-renders the component using it)
export const useAuthError = () => {
  const authError = useSyncExternalStore(authErrorActions.subscribe, authErrorActions.getSnapshot);

  return {
    authError,
    setAuthError: authErrorActions.set,
    clearAuthError: authErrorActions.clear,
  };
};

interface AuthErrorContextValue {
  setAuthError: (error: string | null) => void;
  clearAuthError: () => void;
}

// Context only provides setters (not the error value itself)
const AuthErrorContext = createContext<AuthErrorContextValue | undefined>(undefined);

export const useAuthErrorSetter = () => {
  const context = useContext(AuthErrorContext);
  if (!context) {
    throw new Error("useAuthErrorSetter must be used within AuthProvider");
  }
  return context;
};

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const { t, ready } = useTranslation();
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const reactRouterNavigate = useNavigate();
  const location = useLocation();
  const redirectingRef = useRef(false);

  // Register global auth error handler for 401/403 interception
  useAuthErrorHandler();

  const navigate = (path: string) => {
    // MCP authorize endpoint needs HTTP redirect, prevent loop
    if (path.startsWith("/api/auth/mcp/authorize")) {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      window.location.href = path;
      return;
    }

    // After registration, redirect to success page instead of login
    // Better Auth UI redirects to login when email verification is required
    const currentParams = new URLSearchParams(location.search);
    const isOnRegisterPage = location.pathname === ROUTES.REGISTER;
    const isRedirectingToLogin = path === ROUTES.LOGIN || path.startsWith(`${ROUTES.LOGIN}?`);
    const hasOAuthParams = currentParams.has("client_id") && currentParams.has("redirect_uri");
    const returnUrl = currentParams.get("returnUrl");
    const registrationSuccessPath = `${APP_PREFIX}/registration-success`;

    if (isOnRegisterPage && isRedirectingToLogin) {
      // Preserve OAuth params for continuation after email verification
      if (hasOAuthParams) {
        reactRouterNavigate(`${registrationSuccessPath}${location.search}`);
      } else if (returnUrl) {
        reactRouterNavigate(
          `${registrationSuccessPath}?returnUrl=${encodeURIComponent(returnUrl)}`,
        );
      } else {
        reactRouterNavigate(registrationSuccessPath);
      }
      return;
    }

    // Preserve returnUrl when navigating between login/register views
    if (returnUrl && (path === ROUTES.REGISTER || path === ROUTES.LOGIN)) {
      reactRouterNavigate(`${path}?returnUrl=${encodeURIComponent(returnUrl)}`);
      return;
    }

    // Normal React Router navigation
    reactRouterNavigate(path);
  };

  // Custom toast callback that captures errors into external store (not React state)
  // This prevents form re-renders when error changes
  const customToast = useCallback(
    ({ variant, message }: { variant?: string; message?: string }) => {
      if (variant === "error" && message) {
        // Log error for debugging
        // eslint-disable-next-line no-console
        console.error("[Auth Error]", message);

        // Handle unverified user re-registration - redirect to registration success
        // This error is thrown when user tries to register with existing unverified email
        if (
          message.includes("Email not verified") &&
          message.includes("request a new verification email")
        ) {
          // Preserve OAuth params or returnUrl for continuation after email verification
          const params = new URLSearchParams(location.search);
          const hasOAuthParams = params.has("client_id") && params.has("redirect_uri");
          const currentReturnUrl = params.get("returnUrl");
          const registrationSuccessPath = `${APP_PREFIX}/registration-success`;
          if (hasOAuthParams) {
            reactRouterNavigate(`${registrationSuccessPath}${location.search}`);
          } else if (currentReturnUrl) {
            reactRouterNavigate(
              `${registrationSuccessPath}?returnUrl=${encodeURIComponent(currentReturnUrl)}`,
            );
          } else {
            reactRouterNavigate(registrationSuccessPath);
          }
          return; // Don't show error, we're redirecting
        }

        // Set error in external store (only AuthErrorDisplay re-renders)
        authErrorActions.set(message);

        // Show toast notification (fallback)
        sonnerToast.error(message);
      }
    },
    [location.search, reactRouterNavigate],
  );

  // Context value is stable - only provides setters, not the error value
  const authErrorContextValue: AuthErrorContextValue = {
    setAuthError: authErrorActions.set,
    clearAuthError: authErrorActions.clear,
  };

  if (!ready) {
    // Use bg-background to match theme colors and prevent white/dark flash
    return <div className="flex min-h-screen items-center justify-center bg-background" />;
  }

  const authLocalization = t("auth", { returnObjects: true }) as unknown as AuthLocalization;

  // Legal-consent fields (terms + residency) are SaaS-only. In self-host
  // (legalConsents off) they are omitted from registration entirely.
  const legalConsents = isFeatureEnabled("legalConsents");
  // Social (GitHub/Google) login is gated by the socialLogin feature — off in
  // self-host, on in saas. When off, omit the social block so no buttons render.
  const socialLogin = isFeatureEnabled("socialLogin");
  const legalFields = legalConsents
    ? {
        acceptedTermsAt: {
          label: (
            <span>
              {t("signUpForm.acceptTerms")}{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t("signUpForm.termsOfService")}
              </a>{" "}
              {t("signUpForm.and")}{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {t("signUpForm.privacyPolicy")}
              </a>
            </span>
          ),
          type: "boolean" as const,
          required: true,
        },
        acceptedNotRussianResidentAt: {
          label: t("signUpForm.confirmNotRussianResident"),
          type: "boolean" as const,
          required: true,
        },
      }
    : undefined;
  const signUpFields = legalConsents ? ["acceptedTermsAt", "acceptedNotRussianResidentAt"] : [];

  return (
    <>
      <AuthErrorContext.Provider value={authErrorContextValue}>
        {}
        <AuthUIProvider
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          authClient={authClient as any}
          navigate={navigate}
          toast={customToast}
          basePath={APP_PREFIX || "/"}
          baseURL={window.location.origin}
          viewPaths={{
            SIGN_IN: "login",
            SIGN_UP: "register",
          }}
          social={socialLogin ? { providers: ["github", "google"] } : undefined}
          localization={authLocalization}
          additionalFields={legalFields}
          signUp={{
            fields: signUpFields,
          }}
        >
          {children}
        </AuthUIProvider>
      </AuthErrorContext.Provider>
      <Toaster richColors position="top-right" />
    </>
  );
};
