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
import {
  CommunicationChannelCard,
  type CommunicationChannelDescriptor,
} from "@/components/settings/CommunicationChannelCard";
import { Separator } from "@/components/ui/separator";
import { ProfileSettings, type UserProfile } from "./settings/ProfileSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { OAuthSettings } from "./settings/OAuthSettings";
import { SessionsSettings } from "./settings/SessionsSettings";
import { ApiTokensSettings } from "./settings/ApiTokensSettings";
import { GitHubWorkspaceSettings } from "./settings/GitHubWorkspaceSettings";

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
  const [channels, setChannels] = useState<CommunicationChannelDescriptor[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [values, setValues] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

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

        const channelsResponse = await fetch("/api/notifications/channels");
        const channelsData = await channelsResponse.json();
        setChannels(channelsData.data || []);

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
  const channelSettingKeys = new Set(channels.flatMap((channel) => channel.settingKeys));
  const unassignedDynamic = allDynamic.filter(
    (definition) => !channelSettingKeys.has(definition.key),
  );

  const editorDefinition = (def: SettingDefinition): EditorSettingDefinition => ({
    key: def.key,
    type: def.type,
    category: def.category,
    label: def.label,
    description: def.description || null,
    defaultValue: def.defaultValue,
    required: def.required,
    validation: def.validation,
    adminOnly: def.adminOnly,
  });

  const saveSetting = async (key: string, value: unknown) => {
    const result = await apiClient.updateUserSettings({ [key]: value });
    const refusal = result.refused.find((entry) => entry.key === key);
    if (refusal) throw new Error(refusal.reason);
    setValues((previous) => ({ ...previous, [key]: value }));
    try {
      const response = await fetch("/api/notifications/channels");
      const data = await response.json();
      if (response.ok) setChannels(data.data || []);
    } catch (error) {
      console.error("Failed to refresh communication channel state:", error);
    }
  };

  const handleTestNotification = async (channel: CommunicationChannelDescriptor) => {
    try {
      setTestingChannel(channel.id);
      const response = await fetch(
        `/api/notifications/channels/${encodeURIComponent(channel.id)}/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );

      const data = await response.json();
      const result = data.data as
        { status?: string; channels?: Array<{ reason?: string }> } | undefined;
      if (response.ok && result?.status === "delivered") {
        toast.success(t("pages.settings.channels.testSuccess", { channel: channel.title }));
      } else {
        const reason = result?.channels?.[0]?.reason;
        toast.error(
          reason
            ? t(`pages.settings.channels.errors.${reason}`, {
                defaultValue: t("pages.settings.channels.testFailed", {
                  channel: channel.title,
                }),
              })
            : t("pages.settings.channels.testFailed", { channel: channel.title }),
        );
      }
    } catch (error) {
      console.error("Failed to test notification:", error);
      toast.error(t("pages.settings.channels.testFailed", { channel: channel.title }));
    } finally {
      setTestingChannel(null);
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
        {channels.length > 0 && (
          <>
            <Separator />
            <section data-testid="settings-section-dynamic">
              <h2 className="text-lg font-semibold mb-4">
                {t("pages.settings.tabs.notifications", "Notifications")}
              </h2>
              <div className="space-y-6">
                {channels.map((channel) => (
                  <CommunicationChannelCard
                    key={channel.id}
                    channel={channel}
                    definitions={allDynamic
                      .filter((definition) => channel.settingKeys.includes(definition.key))
                      .map(editorDefinition)}
                    values={values}
                    testing={testingChannel === channel.id}
                    onSave={saveSetting}
                    onTest={handleTestNotification}
                  />
                ))}
              </div>
            </section>
          </>
        )}

        {unassignedDynamic.length > 0 && (
          <>
            <Separator />
            <section data-testid="settings-section-other">
              <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.settings")}</h2>
              <SettingsEditor
                definitions={unassignedDynamic.map(editorDefinition)}
                values={values}
                onSave={saveSetting}
                loading={loading}
                testIdPrefix="user-setting"
                enableFullscreenEdit
                collapsible={false}
              />
            </section>
          </>
        )}

        <Separator />

        <section id="integrations-github" data-testid="settings-section-integrations">
          <h2 className="text-lg font-semibold mb-4">{t("pages.settings.tabs.integrations")}</h2>
          <GitHubWorkspaceSettings />
        </section>

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
