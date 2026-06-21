/**
 * Register page - Better Auth UI with visual error display
 * Handles both direct registration and OAuth authorize flow registration
 */

import React, { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { AuthView } from "@daveyplate/better-auth-ui";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";
import { ROUTES, APP_PREFIX } from "../constants/routes";

export const Register: React.FC = () => {
  const [searchParams] = useSearchParams();

  // Build redirectTo URL based on context
  // ALWAYS redirect to registration-success first (for email verification instructions)
  // OAuth params are preserved so flow can continue after verification
  const redirectToUrl = useMemo(() => {
    if (searchParams.has("client_id") && searchParams.has("redirect_uri")) {
      // OAuth flow: registration-success with OAuth params preserved
      // After email verification, will redirect to OAuth authorize
      const params = new URLSearchParams();
      searchParams.forEach((value, key) => {
        params.set(key, value);
      });
      return `${APP_PREFIX}/registration-success?${params.toString()}`;
    }
    // Preserve returnUrl through registration flow
    const returnUrl = searchParams.get("returnUrl");
    if (returnUrl) {
      return `${APP_PREFIX}/registration-success?returnUrl=${encodeURIComponent(returnUrl)}`;
    }

    // Regular registration - redirect to success page
    return `${APP_PREFIX}/registration-success`;
  }, [searchParams]);

  return (
    <AuthLayout>
      <div className="space-y-4">
        <AuthView pathname={ROUTES.REGISTER} redirectTo={redirectToUrl} />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
