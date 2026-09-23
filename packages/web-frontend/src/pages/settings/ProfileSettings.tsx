/**
 * Profile Settings Sub-Component
 * Handles display name, email verification, handle management
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CheckCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useFeatures } from "@/hooks/useFeatures";
import { HelpPopover } from "@/components/settings/HelpPopover";

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  handle: string;
  emailVerified: boolean;
  createdAt: string;
  image: string | null;
}

interface ProfileSettingsProps {
  profile: UserProfile;
  onProfileUpdate: (profile: UserProfile) => void;
}

export const ProfileSettings: React.FC<ProfileSettingsProps> = ({ profile, onProfileUpdate }) => {
  const { t, i18n } = useTranslation();
  const { isEnabled, emailDelivery } = useFeatures();
  const emailVerificationRequired = isEnabled("emailVerificationGate");

  const [name, setName] = useState(profile.name || "");
  const [handle, setHandle] = useState(profile.handle || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingHandle, setSavingHandle] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [sendingVerification, setSendingVerification] = useState(false);
  const [showHandleConfirm, setShowHandleConfirm] = useState(false);

  const reloadProfile = async () => {
    const response = await fetch("/api/user/profile", { credentials: "include" });
    if (response.ok) {
      const data = await response.json();
      if (data.success && data.data) {
        onProfileUpdate(data.data);
        setName(data.data.name || "");
        setHandle(data.data.handle || "");
      }
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileError(null);

    if (name.length > 100) {
      setProfileError(t("pages.settings.profile.nameMaxLength"));
      return;
    }

    try {
      setSavingProfile(true);
      const response = await fetch("/api/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() || null }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || t("pages.settings.profile.updateFailed"));
      }

      toast.success(t("pages.settings.profile.updateSuccess"));
      await reloadProfile();
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveHandle = async () => {
    setHandleError(null);

    const handleRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    if (!handle || handle.length < 3 || handle.length > 30) {
      setHandleError(t("pages.settings.profile.handleLengthError"));
      return;
    }
    if (!handleRegex.test(handle)) {
      setHandleError(t("pages.settings.profile.handleFormatError"));
      return;
    }

    setShowHandleConfirm(true);
  };

  const confirmHandleChange = async () => {
    setShowHandleConfirm(false);
    try {
      setSavingHandle(true);
      const response = await fetch("/api/user/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ handle }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || t("pages.settings.profile.handleUpdateFailed"));
      }

      toast.success(t("pages.settings.profile.handleUpdateSuccess"));
      await reloadProfile();
    } catch (err) {
      setHandleError((err as Error).message);
    } finally {
      setSavingHandle(false);
    }
  };

  const handleResendVerification = async () => {
    try {
      setSendingVerification(true);
      const response = await fetch("/api/user/resend-verification", {
        method: "POST",
        credentials: "include",
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || t("pages.settings.profile.verificationFailed"));
      }

      toast.success(t("pages.settings.profile.verificationSent"));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("pages.settings.profile.verificationFailed"),
      );
    } finally {
      setSendingVerification(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("pages.settings.profile.title")}</CardTitle>
          <CardDescription>
            {t("pages.settings.profile.memberSince")}:{" "}
            {new Date(profile.createdAt).toLocaleDateString(i18n.language, { dateStyle: "long" })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">{t("pages.settings.profile.name")}</Label>
              <Input
                id="profile-name"
                type="text"
                data-testid="profile-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("pages.settings.profile.namePlaceholder")}
                maxLength={100}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="profile-email">{t("pages.settings.profile.email")}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="profile-email"
                  type="email"
                  value={profile.email}
                  disabled
                  className="flex-1"
                />
                {emailVerificationRequired &&
                  (profile.emailVerified ? (
                    <Badge variant="outline" className="text-chart-2 border-chart-2/30 gap-1">
                      <CheckCircle className="h-3 w-3" />
                      {t("pages.settings.profile.verified")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-warning border-warning/30 gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {t("pages.settings.profile.notVerified")}
                    </Badge>
                  ))}
              </div>
            </div>

            {emailVerificationRequired && !profile.emailVerified && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
                <p className="text-sm text-warning-foreground mb-2">
                  {t("pages.settings.profile.verificationWarning")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResendVerification}
                  disabled={sendingVerification || !emailDelivery.available}
                >
                  {sendingVerification
                    ? t("pages.settings.profile.sendingVerification")
                    : t("pages.settings.profile.resendVerification")}
                </Button>
                {!emailDelivery.available && (
                  <p className="text-sm text-muted-foreground mt-2">
                    {t("pages.settings.profile.emailDeliveryUnavailable")}
                  </p>
                )}
              </div>
            )}

            {profileError && (
              <p className="text-sm text-destructive" role="alert">
                {profileError}
              </p>
            )}

            <Button type="submit" disabled={savingProfile}>
              {savingProfile
                ? t("pages.settings.profile.saving")
                : t("pages.settings.profile.saveChanges")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Handle Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{t("pages.settings.profile.handleTitle")}</CardTitle>
            <HelpPopover
              title={t("pages.settings.profile.handleHelpTitle")}
              data-testid="handle-help"
            >
              <p>{t("pages.settings.profile.handleWarningText")}</p>
            </HelpPopover>
          </div>
          <CardDescription>{t("pages.settings.profile.handleDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveHandle();
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="profile-handle">{t("pages.settings.profile.handle")}</Label>
              <Input
                id="profile-handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value.toLowerCase())}
                placeholder={t("pages.settings.profile.handlePlaceholder")}
                className="font-mono"
                pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                minLength={3}
                maxLength={30}
              />
              <p className="text-xs text-muted-foreground">
                {t("pages.settings.profile.handleHint")}
              </p>
            </div>

            {handleError && (
              <p className="text-sm text-destructive" role="alert">
                {handleError}
              </p>
            )}

            <Button
              type="submit"
              variant="outline"
              disabled={savingHandle || handle === profile.handle}
            >
              {savingHandle
                ? t("pages.settings.profile.savingHandle")
                : t("pages.settings.profile.changeHandle")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Handle change confirmation */}
      <ConfirmDialog
        open={showHandleConfirm}
        onOpenChange={setShowHandleConfirm}
        title={t("pages.settings.profile.handleTitle")}
        description={t("pages.settings.profile.handleChangeWarning", {
          handle,
          currentHandle: profile.handle,
        })}
        confirmLabel={t("pages.settings.profile.changeHandle")}
        cancelLabel={t("common.cancel")}
        onConfirm={confirmHandleChange}
      />
    </div>
  );
};
