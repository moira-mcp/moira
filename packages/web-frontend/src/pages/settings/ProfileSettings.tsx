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
  const { t } = useTranslation();

  const [name, setName] = useState(profile.name || "");
  const [handle, setHandle] = useState(profile.handle || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingHandle, setSavingHandle] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [handleSuccess, setHandleSuccess] = useState(false);
  const [sendingVerification, setSendingVerification] = useState(false);
  const [verificationSuccess, setVerificationSuccess] = useState(false);
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
    setProfileSuccess(false);

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
        throw new Error(data.error || "Failed to update profile");
      }

      setProfileSuccess(true);
      await reloadProfile();
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError((err as Error).message);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSaveHandle = async () => {
    setHandleError(null);
    setHandleSuccess(false);

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
        throw new Error(data.error || "Failed to update handle");
      }

      setHandleSuccess(true);
      await reloadProfile();
      setTimeout(() => setHandleSuccess(false), 3000);
    } catch (err) {
      setHandleError((err as Error).message);
    } finally {
      setSavingHandle(false);
    }
  };

  const handleResendVerification = async () => {
    setVerificationSuccess(false);
    try {
      setSendingVerification(true);
      const response = await fetch("/api/user/resend-verification", {
        method: "POST",
        credentials: "include",
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to send verification email");
      }

      setVerificationSuccess(true);
      setTimeout(() => setVerificationSuccess(false), 5000);
    } catch {
      // Error is shown via alert pattern — keeping simple
    } finally {
      setSendingVerification(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile Card */}
      <Card>
        <CardHeader>
          <CardTitle>{t("pages.settings.profile.title")}</CardTitle>
          <CardDescription>
            {t("pages.settings.profile.memberSince")}:{" "}
            {new Date(profile.createdAt).toLocaleDateString()}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSaveProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="profile-name">{t("pages.settings.profile.name")}</Label>
              <Input
                id="profile-name"
                type="text"
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
                {profile.emailVerified ? (
                  <Badge variant="outline" className="text-chart-2 border-chart-2/30 gap-1">
                    <CheckCircle className="h-3 w-3" />
                    {t("pages.settings.profile.verified")}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-warning border-warning/30 gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t("pages.settings.profile.notVerified")}
                  </Badge>
                )}
              </div>
            </div>

            {!profile.emailVerified && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-4">
                <p className="text-sm text-warning-foreground mb-2">
                  {t("pages.settings.profile.verificationWarning")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleResendVerification}
                  disabled={sendingVerification}
                >
                  {sendingVerification
                    ? t("pages.settings.profile.sendingVerification")
                    : t("pages.settings.profile.resendVerification")}
                </Button>
                {verificationSuccess && (
                  <p className="text-sm text-chart-2 mt-2">
                    ✓ {t("pages.settings.profile.verificationSent")}
                  </p>
                )}
              </div>
            )}

            {profileError && <p className="text-sm text-destructive">{profileError}</p>}
            {profileSuccess && (
              <p className="text-sm text-chart-2">✓ {t("pages.settings.profile.updateSuccess")}</p>
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
          <CardTitle>{t("pages.settings.profile.handleTitle")}</CardTitle>
          <CardDescription className="text-warning">
            {t("pages.settings.profile.handleWarningTitle")}{" "}
            {t("pages.settings.profile.handleWarningText")}
          </CardDescription>
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

            {handleError && <p className="text-sm text-destructive">{handleError}</p>}
            {handleSuccess && (
              <p className="text-sm text-chart-2">
                ✓ {t("pages.settings.profile.handleUpdateSuccess")}
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
