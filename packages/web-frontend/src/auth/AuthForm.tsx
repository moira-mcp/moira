/** Auth form presentation is loaded only by a branch that actually renders a form. */
import React, { useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { AuthUIProvider, AuthView, type AuthLocalization } from "@daveyplate/better-auth-ui";
import { toast as sonnerToast } from "sonner";
import { useTranslation } from "react-i18next";
import { authClient } from "./better-auth-client";
import { useAuthErrorSetter } from "./AuthProvider";
import { useFeatures } from "../hooks/useFeatures";
import { ROUTES, APP_PREFIX } from "../constants/routes";

export const AuthForm: React.FC<React.ComponentProps<typeof AuthView>> = (props) => {
  const { setAuthError } = useAuthErrorSetter();
  const { t, ready } = useTranslation();
  const { isEnabled: isFeatureEnabled } = useFeatures();
  const reactRouterNavigate = useNavigate();
  const location = useLocation();
  const redirectingRef = useRef(false);

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
        setAuthError(message);

        // Show toast notification (fallback)
        sonnerToast.error(message);
      }
    },
    [location.search, reactRouterNavigate, setAuthError],
  );

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
      <AuthView {...props} />
    </AuthUIProvider>
  );
};
