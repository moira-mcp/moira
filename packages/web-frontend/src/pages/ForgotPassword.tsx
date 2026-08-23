/**
 * Forgot Password page - request password reset email with visual error display
 */

import React from "react";
import { AuthView } from "@daveyplate/better-auth-ui";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { MailX } from "lucide-react";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ROUTES } from "../constants/routes";
import { useFeatures } from "../hooks/useFeatures";

export const ForgotPassword: React.FC = () => {
  const { t } = useTranslation();
  const { loaded, error, emailDelivery } = useFeatures();

  if (!loaded) {
    return (
      <AuthLayout>
        <p className="text-center text-sm text-muted-foreground" aria-live="polite">
          {t("pages.forgotPasswordUnavailable.loading")}
        </p>
      </AuthLayout>
    );
  }

  if (error || !emailDelivery.available) {
    return (
      <AuthLayout>
        <Card className="w-full" data-testid="email-delivery-unavailable">
          <CardHeader>
            <div className="mb-2 flex items-center gap-2">
              <MailX className="h-6 w-6 text-muted-foreground" />
              <CardTitle>{t("pages.forgotPasswordUnavailable.title")}</CardTitle>
            </div>
            <CardDescription>{t("pages.forgotPasswordUnavailable.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("pages.forgotPasswordUnavailable.instructions")}
            </p>
            <Button asChild className="w-full">
              <Link to={ROUTES.LOGIN}>{t("pages.forgotPasswordUnavailable.backToLogin")}</Link>
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="space-y-4">
        <AuthView pathname="forgot-password" />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
