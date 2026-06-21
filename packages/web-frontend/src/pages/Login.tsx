/**
 * Login page - Better Auth UI with visual error display
 * Handles both direct login and OAuth authorize flow login
 */

import React, { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { AuthView } from "@daveyplate/better-auth-ui";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";
import { validateReturnUrl } from "../utils/return-url";
import { ROUTES } from "../constants/routes";

export const Login: React.FC = () => {
  const [searchParams] = useSearchParams();

  // Build redirectTo URL with OAuth params if present (for OAuth authorize flow)
  const redirectToUrl = useMemo(() => {
    // Check if we have OAuth parameters (client_id, redirect_uri, etc.)
    if (searchParams.has("client_id") && searchParams.has("redirect_uri")) {
      const params = new URLSearchParams();
      searchParams.forEach((value, key) => {
        params.set(key, value);
      });
      // Redirect to OAuth authorize page where consent screen will be shown
      return `${ROUTES.OAUTH_AUTHORIZE}?${params.toString()}`;
    }
    // Check for returnUrl parameter (redirect to original page after login)
    const returnUrl = searchParams.get("returnUrl");
    const validated = validateReturnUrl(returnUrl);
    if (validated) return validated;

    // Default - redirect to dashboard
    return ROUTES.DASHBOARD;
  }, [searchParams]);

  return (
    <AuthLayout>
      <div className="space-y-4">
        <AuthView pathname={ROUTES.LOGIN} redirectTo={redirectToUrl} />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
