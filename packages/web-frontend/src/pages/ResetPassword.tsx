/**
 * Reset Password page - set new password after clicking email link with visual error display
 */

import React from "react";
import { AuthView } from "@daveyplate/better-auth-ui";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";

export const ResetPassword: React.FC = () => {
  return (
    <AuthLayout>
      <div className="space-y-4">
        <AuthView pathname="reset-password" />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
