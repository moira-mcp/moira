/**
 * Security Settings Sub-Component
 * Handles password change with strength indicator
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export const SecuritySettings: React.FC = () => {
  const { t } = useTranslation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

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

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(false);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError(t("pages.settings.security.errors.allRequired"));
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError(t("pages.settings.security.errors.minLength"));
      return;
    }
    if (newPassword.length > 128) {
      setPasswordError(t("pages.settings.security.errors.maxLength"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t("pages.settings.security.errors.noMatch"));
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError(t("pages.settings.security.errors.samePassword"));
      return;
    }

    try {
      setChangingPassword(true);
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to change password");
      }

      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPasswordSuccess(false), 3000);
    } catch (err) {
      setPasswordError((err as Error).message);
    } finally {
      setChangingPassword(false);
    }
  };

  const strength = getPasswordStrength();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pages.settings.security.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
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

          {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
          {passwordSuccess && (
            <p className="text-sm text-chart-2">✓ {t("pages.settings.security.passwordSuccess")}</p>
          )}

          <Button type="submit" disabled={changingPassword}>
            {changingPassword
              ? t("pages.settings.security.changingPassword")
              : t("pages.settings.security.changePassword")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
