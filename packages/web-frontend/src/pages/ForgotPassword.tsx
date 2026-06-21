/**
 * Forgot Password page - request password reset email with visual error display
 */

import React from "react";
import { AuthView } from "@daveyplate/better-auth-ui";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";

export const ForgotPassword: React.FC = () => {
  return (
    <AuthLayout>
      <div className="space-y-4">
        <AuthView pathname="forgot-password" />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
