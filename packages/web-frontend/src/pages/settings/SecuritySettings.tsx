/**
 * Security Settings Sub-Component
 *
 * The password card matches how the account signs in. An account with a password gets the
 * change-password form. An account that signs in only through a social provider has no current
 * password to type, so it is told how it signs in and may set a password as well.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { authClient } from "@/auth/better-auth-client";

/** How the account signs in: whether it has a password, and through which providers. */
interface SignInMethods {
  hasPassword: boolean;
  providers: string[];
}

const PROVIDER_NAMES: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
  gitlab: "GitLab",
};

function providerName(providerId: string): string {
  return PROVIDER_NAMES[providerId] ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
}

/** The server's reason for a refused password request, read from the error details. */
function refusalReason(body: unknown): string | undefined {
  const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details
    ?.reason;
  return typeof reason === "string" ? reason : undefined;
}

export const SecuritySettings: React.FC = () => {
  const { t } = useTranslation();

  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const loadMethods = useCallback(async () => {
    try {
      const { data } = await authClient.listAccounts();
      if (!data) throw new Error("no accounts");
      setMethods({
        hasPassword: data.some((account) => account.providerId === "credential"),
        providers: data
          .filter((account) => account.providerId !== "credential")
          .map((account) => providerName(account.providerId)),
      });
    } catch {
      // Without the list, fall back to the form every password account needs; the server still
      // refuses a change that cannot apply.
      setMethods({ hasPassword: true, providers: [] });
    }
  }, []);

  useEffect(() => {
    void loadMethods();
  }, [loadMethods]);

  const getPasswordStrength = (): { value: number; label: string } => {
    if (!newPassword) return { value: 0, label: "" };
    if (newPassword.length < 6)
      return { value: 15, label: t("pages.settings.security.strength.tooShort") };
    if (newPassword.length < 10)
      return { value: 33, label: t("pages.settings.security.strength.fair") };
    if (newPassword.length < 15)
      return { value: 66, label: t("pages.settings.security.strength.good") };
    return { value: 100, label: t("pages.settings.security.strength.strong") };
  };

  /** The checks both forms share; returns the message to show, or null when the input is valid. */
  const newPasswordProblem = (): string | null => {
    if (newPassword.length < 6) return t("pages.settings.security.errors.minLength");
    if (newPassword.length > 128) return t("pages.settings.security.errors.maxLength");
    if (newPassword !== confirmPassword) return t("pages.settings.security.errors.noMatch");
    return null;
  };

  const resetFields = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError(t("pages.settings.security.errors.allRequired"));
      return;
    }
    const problem = newPasswordProblem();
    if (problem) {
      setPasswordError(problem);
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError(t("pages.settings.security.errors.samePassword"));
      return;
    }

    try {
      setSubmitting(true);
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        setPasswordError(
          refusalReason(data) === "CURRENT_PASSWORD_INCORRECT"
            ? t("pages.settings.security.errors.currentIncorrect")
            : t("pages.settings.security.errors.changeFailed"),
        );
        return;
      }
      toast.success(t("pages.settings.security.passwordSuccess"));
      resetFields();
    } catch {
      setPasswordError(t("pages.settings.security.errors.changeFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);

    if (!newPassword || !confirmPassword) {
      setPasswordError(t("pages.settings.security.errors.allRequired"));
      return;
    }
    const problem = newPasswordProblem();
    if (problem) {
      setPasswordError(problem);
      return;
    }

    try {
      setSubmitting(true);
      const response = await fetch("/api/user/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        const reason = refusalReason(data);
        if (reason === "PASSWORD_ALREADY_SET") await loadMethods();
        setPasswordError(
          reason === "SESSION_NOT_FRESH"
            ? t("pages.settings.security.errors.signInAgain")
            : reason === "PASSWORD_ALREADY_SET"
              ? t("pages.settings.security.errors.alreadySet")
              : t("pages.settings.security.errors.setFailed"),
        );
        return;
      }
      toast.success(t("pages.settings.security.passwordSetSuccess"));
      resetFields();
      await loadMethods();
    } catch {
      setPasswordError(t("pages.settings.security.errors.setFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const strength = getPasswordStrength();

  const newPasswordFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="new-password">{t("pages.settings.security.newPassword")}</Label>
        <Input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("pages.settings.security.newPasswordPlaceholder")}
          autoComplete="new-password"
          minLength={6}
          maxLength={128}
        />
        {newPassword && (
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("pages.settings.security.passwordStrength")}
            </span>
            <div className="flex items-center gap-2">
              <Progress value={strength.value} className="h-2 flex-1" />
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {strength.label}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{t("pages.settings.security.confirmPassword")}</Label>
        <Input
          id="confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder={t("pages.settings.security.confirmPasswordPlaceholder")}
          autoComplete="new-password"
        />
      </div>

      {passwordError && (
        <p className="text-sm text-destructive" role="alert">
          {passwordError}
        </p>
      )}
    </>
  );

  if (methods === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pages.settings.security.title")}</CardTitle>
          <CardDescription>{t("pages.settings.security.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-40 w-full max-w-md" />
        </CardContent>
      </Card>
    );
  }

  if (!methods.hasPassword) {
    return (
      <Card data-testid="security-social-only">
        <CardHeader>
          <CardTitle className="text-base">
            {t("pages.settings.security.setPasswordTitle")}
          </CardTitle>
          <CardDescription data-testid="security-sign-in-methods">
            {t("pages.settings.security.socialOnlyDescription", {
              providers:
                methods.providers.length > 0
                  ? methods.providers.join(", ")
                  : t("pages.settings.security.socialProviderFallback"),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSetPassword}
            className="space-y-4 max-w-md"
            data-testid="security-set-password-form"
          >
            {newPasswordFields}
            <Button type="submit" disabled={submitting}>
              {submitting
                ? t("pages.settings.security.settingPassword")
                : t("pages.settings.security.setPassword")}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("pages.settings.security.title")}</CardTitle>
        <CardDescription>{t("pages.settings.security.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleChangePassword}
          className="space-y-4 max-w-md"
          data-testid="security-password-form"
        >
          <div className="space-y-2">
            <Label htmlFor="current-password">{t("pages.settings.security.currentPassword")}</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t("pages.settings.security.currentPasswordPlaceholder")}
              autoComplete="current-password"
            />
          </div>

          {newPasswordFields}

          <Button type="submit" disabled={submitting}>
            {submitting
              ? t("pages.settings.security.changingPassword")
              : t("pages.settings.security.changePassword")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
