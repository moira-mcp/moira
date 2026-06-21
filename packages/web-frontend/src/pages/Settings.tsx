/* eslint-disable no-console */
/**
 * Settings Page — flat layout with all sections visible
 * Sections: Profile, Security, Notifications, OAuth Authorizations, Active Sessions
 */

import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import {
  SettingsEditor,
  SettingDefinition as EditorSettingDefinition,
} from "@/components/settings/SettingsEditor";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Loader2 } from "lucide-react";
import { ProfileSettings, type UserProfile } from "./settings/ProfileSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { OAuthSettings } from "./settings/OAuthSettings";
import { SessionsSettings } from "./settings/SessionsSettings";
import { ApiTokensSettings } from "./settings/ApiTokensSettings";

interface SettingDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "json" | "encrypted";
  category: string;
  label: string;
  description: string;
  defaultValue: string | null;
  required: boolean;
  validation: string | null;
  adminOnly: boolean;
}

export const Settings: React.FC = () => {
  const { t } = useTranslation();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [definitions, setDefinitions] = useState<SettingDefinition[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [values, setValues] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const loadAll = async () => {
      try {
        setLoading(true);

        const profileResponse = await fetch("/api/user/profile", { credentials: "include" });
        if (profileResponse.ok) {
          const profileData = await profileResponse.json();
          if (profileData.success && profileData.data) {
            setProfile(profileData.data);
          }
        }

        const defsResponse = await fetch("/api/settings/definitions");
        const defsData = await defsResponse.json();
        setDefinitions(defsData.data || []);

        const valuesData = await apiClient.getUserSettings();
        setValues(valuesData);
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        setLoading(false);
      }
    };

    loadAll();
  }, []);

  const staticSections = ["profile", "security", "oauth", "sessions", "api-tokens"];
  const allDynamic = definitions.filter((d) => !staticSections.includes(d.category));
  const hasTelegram = allDynamic.some((d) => d.key.startsWith("telegram."));

  const handleTestNotification = async () => {
    try {
      setTesting(true);
      const botToken = values["telegram.bot_token"];
      const chatId = values["telegram.chat_id"];

      if (!botToken || !chatId) {
        toast.warning(t("pages.settings.telegram.configureBotFirst"));
        return;
      }

      const response = await fetch("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken, chatId }),
      });

      const data = await response.json();

      if (data.success) {
        toast.success(t("pages.settings.telegram.testSuccess"));
      } else {
        const errorType = data.errorType;
        const i18nKey = `pages.settings.telegram.errors.${errorType}`;
        const translatedError = t(i18nKey);
        const errorMessage =
          translatedError !== i18nKey
            ? translatedError
            : data.message || t("pages.settings.telegram.testFailed");
        toast.error(errorMessage);
      }
    } catch (error) {
      console.error("Failed to test notification:", error);
      toast.error(t("pages.settings.telegram.testFailed"));
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return <PageShell title={t("pages.settings.title")} loading />;
  }

  return (
    <PageShell title={t("pages.settings.title")}>
      <div className="space-y-8 max-w-4xl" data-testid="settings-flat-layout">
        {/* Profile Section */}
        <section data-testid="settings-section-profile">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.profile")}</h2>
          {profile && <ProfileSettings profile={profile} onProfileUpdate={setProfile} />}
        </section>

        <Separator />

        {/* Security Section */}
        <section data-testid="settings-section-security">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.security")}</h2>
          <SecuritySettings />
        </section>

        {/* Dynamic Settings (Notifications) */}
        {allDynamic.length > 0 && (
          <>
            <Separator />
            <section data-testid="settings-section-dynamic">
              <h2 className="text-lg font-semibold mb-4">
                {t("pages.settings.tabs.notifications", "Notifications")}
              </h2>
              <div className="space-y-6">
                <SettingsEditor
                  definitions={allDynamic.map(
                    (def): EditorSettingDefinition => ({
                      key: def.key,
                      type: def.type,
                      category: def.category,
                      label: def.label,
                      description: def.description || null,
                      defaultValue: def.defaultValue,
                      required: def.required,
                      validation: def.validation,
                      adminOnly: def.adminOnly,
                    }),
                  )}
                  values={values}
                  onSave={async (key, value) => {
                    await apiClient.updateUserSettings({ [key]: value });
                    setValues((prev) => ({ ...prev, [key]: value }));
                  }}
                  loading={loading}
                  testIdPrefix="user-setting"
                  enableFullscreenEdit={true}
                  collapsible={false}
                />

                {hasTelegram && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-base">
                        {t("pages.settings.telegram.testNotification")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Button variant="outline" onClick={handleTestNotification} disabled={testing}>
                        {testing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {testing
                          ? t("pages.settings.telegram.sending")
                          : t("pages.settings.telegram.testNotification")}
                      </Button>
                      <p className="text-sm text-muted-foreground mt-2">
                        {t("pages.settings.telegram.testDescription")}
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        {t("pages.settings.telegram.setupGuide")}{" "}
                        <a
                          href="/docs/integration/telegram-setup/"
                          className="text-primary underline hover:text-primary/80"
                        >
                          {t("pages.settings.telegram.setupGuideLink")}
                        </a>
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </section>
          </>
        )}

        <Separator />

        {/* OAuth Authorizations Section */}
        <section data-testid="settings-section-oauth">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.oauth")}</h2>
          <OAuthSettings />
        </section>

        <Separator />

        {/* Active Sessions Section */}
        <section data-testid="settings-section-sessions">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.sessions")}</h2>
          <SessionsSettings />
        </section>

        <Separator />

        {/* API Tokens Section */}
        <section data-testid="settings-section-api-tokens">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.apiTokens")}</h2>
          <ApiTokensSettings />
        </section>
      </div>
    </PageShell>
  );
};
