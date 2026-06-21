/**
 * Forced Password Reset Page
 * User must change password when admin forces reset
 * Cannot navigate away until password is changed
 * Auto-login after successful password change
 */

import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { authClient, useSession } from "../auth/better-auth-client";
import { ROUTES } from "../constants/routes";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Lock, CheckCircle } from "lucide-react";
import { useAuthError } from "../auth/AuthProvider";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";

export const ForcedPasswordReset: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { setAuthError } = useAuthError();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setAuthError(null);

    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      setError(t("pages.forcedPasswordReset.errors.allRequired"));
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t("pages.forcedPasswordReset.errors.noMatch"));
      return;
    }

    if (newPassword.length < 8) {
      setError(t("pages.forcedPasswordReset.errors.minLength"));
      return;
    }

    if (newPassword === currentPassword) {
      setError(t("pages.forcedPasswordReset.errors.samePassword"));
      return;
    }

    setLoading(true);

    try {
      // Change password via API
      await apiClient.changeForcedPassword(currentPassword, newPassword);

      // Show success state
      setSuccess(true);
      toast.success(t("pages.forcedPasswordReset.success"));

      // Auto-login with new password
      const userEmail = session?.user?.email;
      if (userEmail) {
        try {
          await authClient.signIn.email({
            email: userEmail,
            password: newPassword,
          });
          // Wait 1.5 seconds then redirect
          setTimeout(() => {
            navigate(ROUTES.WORKFLOWS, { replace: true });
          }, 1500);
        } catch {
          // Auto-login failed, redirect to login page
          toast.info(t("pages.forcedPasswordReset.loginWithNew"));
          setTimeout(() => {
            authClient.signOut().finally(() => {
              navigate(ROUTES.LOGIN, { replace: true });
            });
          }, 1500);
        }
      } else {
        // No email available, redirect to login
        setTimeout(() => {
          authClient.signOut().finally(() => {
            navigate(ROUTES.LOGIN, { replace: true });
          });
        }, 1500);
      }
    } catch (err) {
      if (err instanceof Error) {
        setAuthError(err.message);
      } else {
        setAuthError(t("pages.forcedPasswordReset.errors.failed"));
      }
      setLoading(false);
    }
  };

  // Success state UI
  if (success) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-6 w-6 text-chart-2" />
              <CardTitle>{t("pages.forcedPasswordReset.successTitle")}</CardTitle>
            </div>
            <CardDescription>{t("pages.forcedPasswordReset.successDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout showLanguageSwitcher={false}>
      <Card className="w-full">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Lock className="h-6 w-6 text-destructive" />
            <CardTitle>{t("pages.forcedPasswordReset.title")}</CardTitle>
          </div>
          <CardDescription>{t("pages.forcedPasswordReset.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AuthErrorDisplay />

          {error && (
            <div
              data-testid="password-error"
              className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md flex items-start gap-2"
            >
              <Lock className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">
                {t("pages.forcedPasswordReset.currentPassword")}
              </Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={loading}
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="newPassword">{t("pages.forcedPasswordReset.newPassword")}</Label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={loading}
                required
                minLength={8}
              />
              <p className="text-xs text-muted-foreground">
                {t("pages.forcedPasswordReset.minLength")}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">
                {t("pages.forcedPasswordReset.confirmPassword")}
              </Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={loading}
                required
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading
                ? t("pages.forcedPasswordReset.changingPassword")
                : t("pages.forcedPasswordReset.changePassword")}
            </Button>
          </form>

          <div className="mt-4 p-3 bg-muted rounded-md">
            <p className="text-xs text-muted-foreground">
              <strong>Note:</strong> {t("pages.forcedPasswordReset.note")}
            </p>
          </div>
        </CardContent>
      </Card>
    </AuthLayout>
  );
};
