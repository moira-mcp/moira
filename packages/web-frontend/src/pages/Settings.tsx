/**
 * The user Settings page: seven sections, always mounted, with a sticky in-page navigation,
 * deep links (`/settings#<section>`) that scroll to and highlight their section once the page's data
 * has loaded, per-topic help and three step-by-step tutorials (the page itself, GitHub & Codespaces
 * setup, Telegram setup).
 *
 * Sections: Account · Security & sign-in (with signed-in devices) · Notifications · GitHub &
 * Codespaces (`#integrations-github`, the anchor links from the server and agents use) · Connected
 * apps · API tokens · Preferences.
 *
 * It does not use `PageShell`: a two-column layout with its own navigation and per-section loading
 * is exactly the kind of page that component's contract excludes.
 */

import { productFetch } from "@/services/product-fetch";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AppWindow,
  Bell,
  CircleHelp,
  Github,
  KeyRound,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { apiClient } from "../services/api-client";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DataRegion } from "@/components/DataRegion";
import { useResource } from "@/hooks/useResource";
import { getReadOwner, isPrivateReadSuspended } from "@/services/read-scope";
import { EmptyState } from "@/components/empty-state";
import {
  SettingsEditor,
  type SettingDefinition as EditorSettingDefinition,
} from "@/components/settings/SettingsEditor";
import {
  CommunicationChannelCard,
  type CommunicationChannelDescriptor,
} from "@/components/settings/CommunicationChannelCard";
import { HelpPopover } from "@/components/settings/HelpPopover";
import { SettingsSection, SettingsSubsection } from "@/components/settings/SettingsSection";
import {
  SettingsNav,
  useActiveSection,
  type SettingsNavItem,
} from "@/components/settings/SettingsNav";
import { useSectionHighlight } from "@/components/settings/useSectionHighlight";
import { localizeSettingDefinition } from "@/components/settings/localize-definition";
import { ProfileSettings, type UserProfile } from "./settings/ProfileSettings";
import { SecuritySettings } from "./settings/SecuritySettings";
import { OAuthSettings } from "./settings/OAuthSettings";
import { SessionsSettings } from "./settings/SessionsSettings";
import { ApiTokensSettings } from "./settings/ApiTokensSettings";
import { GitHubCodespaceSettings } from "./settings/GitHubCodespaceSettings";
import { GitHubCodespaceManagement } from "./settings/GitHubCodespaceManagement";
import { GitHubCodespacesProvider } from "./settings/GitHubCodespacesData";
import { CodespaceAutoPause } from "./settings/CodespaceAutoPause";
import { CodespaceLimitsFromData } from "./settings/CodespaceLimitsPanel";
import { PreferencesSettings } from "./settings/PreferencesSettings";
import { useGuides } from "@/guides/GuideContext";
import { guideAnchor } from "@/guides/anchors";

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

/** Categories other sections of this page own, so the generic editor must not show them again. */
const OWNED_CATEGORIES = new Set([
  "profile",
  "security",
  "oauth",
  "sessions",
  "api-tokens",
  // The auto-pause card in GitHub & Codespaces is their editor.
  "codespaces",
  // The beginner-panel switches in Preferences are the editor of the interface settings.
  "ui",
]);

export const Settings: React.FC = () => {
  const { t } = useTranslation();
  const { start: startGuide } = useGuides();

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const profileResource = useResource<UserProfile>("user-settings-profile", async () => {
    const response = await productFetch("/api/user/profile", { credentials: "include" });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(t("pages.settings.loadFailed"));
    return data.data;
  });
  // Keep accepted props mounted behind the private boundary during a same-owner check.
  // Only the resource publishes profile facts; this ref cannot accept mutation results.
  const owner = getReadOwner();
  const retainedProfile = useRef<{ owner: string; value: UserProfile | null }>({
    owner,
    value: null,
  });
  if (retainedProfile.current.owner !== owner) retainedProfile.current = { owner, value: null };
  if (profileResource.data) retainedProfile.current.value = profileResource.data;
  const profile =
    profileResource.data ?? (isPrivateReadSuspended() ? retainedProfile.current.value : null);
  const channelsResource = useResource<CommunicationChannelDescriptor[]>(
    "user-settings-channels",
    async () => {
      const response = await productFetch("/api/notifications/channels");
      const data = await response.json();
      if (!response.ok) throw new Error(t("pages.settings.loadFailed"));
      return data.data || [];
    },
  );
  const settingsResource = useResource<{
    definitions: SettingDefinition[];
    values: Record<string, unknown>;
  }>("user-settings-editor-data", async () => {
    const [definitions, values] = await Promise.all([
      (async (): Promise<SettingDefinition[]> => {
        const response = await productFetch("/api/settings/definitions");
        const data = await response.json();
        if (!response.ok) throw new Error(t("pages.settings.loadFailed"));
        return data.data || [];
      })(),
      apiClient.getUserSettings(),
    ]);
    return { definitions, values };
  });
  const definitions = settingsResource.data?.definitions ?? [];
  const channels = useMemo(() => channelsResource.data ?? [], [channelsResource.data]);
  const refreshChannels = channelsResource.refresh;
  useEffect(() => {
    if (settingsResource.data) setValues(settingsResource.data.values);
  }, [settingsResource.data]);

  const channelSettingKeys = useMemo(
    () => new Set(channels.flatMap((channel) => channel.settingKeys)),
    [channels],
  );
  const editorDefinition = useCallback(
    (def: SettingDefinition): EditorSettingDefinition =>
      localizeSettingDefinition(
        {
          key: def.key,
          type: def.type,
          category: def.category,
          label: def.label,
          description: def.description || null,
          defaultValue: def.defaultValue,
          required: def.required,
          validation: def.validation,
          adminOnly: def.adminOnly,
        },
        t,
      ),
    [t],
  );
  const pageDefinitions = definitions.filter(
    (definition) => !OWNED_CATEGORIES.has(definition.category),
  );
  const otherDefinitions = pageDefinitions.filter(
    (definition) => !channelSettingKeys.has(definition.key),
  );

  const saveSetting = useCallback(
    async (key: string, value: unknown) => {
      const result = await apiClient.updateUserSettings({ [key]: value });
      const refusal = result.refused.find((entry) => entry.key === key);
      if (refusal) throw new Error(refusal.reason);
      setValues((previous) => ({ ...previous, [key]: value }));
      // A channel's readiness depends on its settings; show the new state without a reload.
      await refreshChannels();
    },
    [refreshChannels],
  );

  const handleTestNotification = async (channel: CommunicationChannelDescriptor) => {
    try {
      setTestingChannel(channel.id);
      const response = await productFetch(
        `/api/notifications/channels/${encodeURIComponent(channel.id)}/test`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
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
                defaultValue: t("pages.settings.channels.testFailed", { channel: channel.title }),
              })
            : t("pages.settings.channels.testFailed", { channel: channel.title }),
        );
      }
    } catch {
      toast.error(t("pages.settings.channels.testFailed", { channel: channel.title }));
    } finally {
      setTestingChannel(null);
    }
  };

  // Navigation, deep links and the section being read.
  const navItems: SettingsNavItem[] = useMemo(
    () => [
      { id: "account", label: t("pages.settings.sections.account.title"), icon: UserRound },
      { id: "security", label: t("pages.settings.sections.security.title"), icon: ShieldCheck },
      { id: "notifications", label: t("pages.settings.sections.notifications.title"), icon: Bell },
      { id: "integrations-github", label: t("pages.settings.sections.github.title"), icon: Github },
      { id: "connected-apps", label: t("pages.settings.sections.apps.title"), icon: AppWindow },
      { id: "api-tokens", label: t("pages.settings.sections.tokens.title"), icon: KeyRound },
      {
        id: "preferences",
        label: t("pages.settings.sections.preferences.title"),
        icon: SlidersHorizontal,
      },
    ],
    [t],
  );
  const sectionIds = useMemo(() => navItems.map((item) => item.id), [navItems]);
  const active = useActiveSection(sectionIds, true);
  const { highlight } = useSectionHighlight(
    contentRef,
    !profileResource.pending && !settingsResource.pending && !channelsResource.pending,
  );

  const hasTelegram = channels.some((channel) => channel.id === "telegram");

  return (
    <div className="px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <PageHeader title={t("pages.settings.title")} description={t("pages.settings.description")} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav
          items={navItems}
          active={active}
          onSelect={(id) => {
            window.history.replaceState(window.history.state, "", `#${id}`);
            highlight(id);
          }}
          label={t("pages.settings.navLabel")}
          guide={guideAnchor("settings.nav")}
        />

        <div
          ref={contentRef}
          className="min-w-0 max-w-3xl space-y-14 pb-24"
          data-testid="settings-flat-layout"
        >
          <SettingsSection
            id="account"
            icon={UserRound}
            title={t("pages.settings.sections.account.title")}
            description={t("pages.settings.sections.account.description")}
            data-testid="settings-section-profile"
            {...guideAnchor("settings.account")}
          >
            <DataRegion
              hasResult={profile !== null}
              pending={profileResource.pending}
              error={profileResource.error}
              onRetry={profileResource.refresh}
              testId="settings-profile-region"
            >
              {profile && (
                <ProfileSettings
                  profile={profile}
                  onProfileUpdate={(next) => profileResource.update(() => next)}
                />
              )}
            </DataRegion>
          </SettingsSection>

          <SettingsSection
            id="security"
            icon={ShieldCheck}
            title={t("pages.settings.sections.security.title")}
            description={t("pages.settings.sections.security.description")}
            data-testid="settings-section-security"
            {...guideAnchor("settings.security")}
          >
            <SecuritySettings />
            <SettingsSubsection
              title={t("pages.settings.sessions.title")}
              description={t("pages.settings.sessions.description")}
              help={
                <HelpPopover
                  title={t("pages.settings.sessions.helpTitle")}
                  data-testid="sessions-help"
                >
                  <p>{t("pages.settings.sessions.helpBody")}</p>
                  <p>{t("pages.settings.sessions.helpAgents")}</p>
                </HelpPopover>
              }
              data-testid="settings-section-sessions"
            >
              <SessionsSettings />
            </SettingsSubsection>
          </SettingsSection>

          <SettingsSection
            id="notifications"
            icon={Bell}
            title={t("pages.settings.sections.notifications.title")}
            description={t("pages.settings.sections.notifications.description")}
            help={
              <HelpPopover
                title={t("pages.settings.sections.notifications.helpTitle")}
                data-testid="notifications-help"
              >
                <p>{t("pages.settings.sections.notifications.helpBody")}</p>
                <p>{t("pages.settings.sections.notifications.helpTrusted")}</p>
              </HelpPopover>
            }
            actions={
              hasTelegram && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => startGuide("settings-telegram")}
                  data-testid="telegram-guide-open"
                >
                  <CircleHelp className="mr-1.5 size-4" aria-hidden="true" />
                  {t("guides.settings-telegram.open")}
                </Button>
              )
            }
            data-testid="settings-section-dynamic"
            {...guideAnchor("settings.notifications")}
          >
            <DataRegion
              hasResult={channelsResource.data !== undefined && settingsResource.data !== undefined}
              pending={channelsResource.pending || settingsResource.pending}
              error={channelsResource.error || settingsResource.error}
              onRetry={() =>
                Promise.all([
                  ...(channelsResource.error ? [channelsResource.refresh()] : []),
                  ...(settingsResource.error ? [settingsResource.refresh()] : []),
                ])
              }
              testId="settings-notifications-region"
            >
              {channels.length === 0 ? (
                <EmptyState
                  icon={Bell}
                  title={t("pages.settings.sections.notifications.empty")}
                  description={t("pages.settings.sections.notifications.emptyDescription")}
                />
              ) : (
                channels.map((channel) => (
                  <CommunicationChannelCard
                    key={channel.id}
                    channel={channel}
                    definitions={pageDefinitions
                      .filter((definition) => channel.settingKeys.includes(definition.key))
                      .map(editorDefinition)}
                    values={values}
                    testing={testingChannel === channel.id}
                    onSave={saveSetting}
                    onTest={handleTestNotification}
                  />
                ))
              )}
            </DataRegion>
          </SettingsSection>

          <SettingsSection
            id="integrations-github"
            icon={Github}
            title={t("pages.settings.sections.github.title")}
            description={t("pages.settings.sections.github.description")}
            help={
              <HelpPopover
                title={t("pages.settings.sections.github.helpTitle")}
                data-testid="github-help"
              >
                <p>{t("pages.settings.sections.github.helpBody")}</p>
                <p>{t("pages.settings.sections.github.helpAuthority")}</p>
              </HelpPopover>
            }
            actions={
              <Button
                variant="outline"
                size="sm"
                onClick={() => startGuide("settings-github")}
                data-testid="github-guide-open"
              >
                <CircleHelp className="mr-1.5 size-4" aria-hidden="true" />
                {t("guides.settings-github.open")}
              </Button>
            }
            data-testid="settings-section-integrations"
            {...guideAnchor("settings.integrations")}
          >
            <GitHubCodespacesProvider>
              <GitHubCodespaceSettings />
              <GitHubCodespaceManagement />
              <DataRegion
                hasResult={settingsResource.data !== undefined}
                pending={settingsResource.pending}
                error={settingsResource.error}
                onRetry={settingsResource.refresh}
                testId="settings-autopause-region"
              >
                <CodespaceAutoPause values={values} onSave={saveSetting} />
              </DataRegion>
              <CodespaceLimitsFromData />
            </GitHubCodespacesProvider>
          </SettingsSection>

          <SettingsSection
            id="connected-apps"
            icon={AppWindow}
            title={t("pages.settings.sections.apps.title")}
            description={t("pages.settings.sections.apps.description")}
            help={
              <HelpPopover
                title={t("pages.settings.sections.apps.helpTitle")}
                data-testid="connected-apps-help"
              >
                <p>{t("pages.settings.sections.apps.helpBody")}</p>
                <p>{t("pages.settings.sections.apps.helpRevoke")}</p>
              </HelpPopover>
            }
            data-testid="settings-section-oauth"
            {...guideAnchor("settings.apps")}
          >
            <OAuthSettings />
          </SettingsSection>

          <SettingsSection
            id="api-tokens"
            icon={KeyRound}
            title={t("pages.settings.sections.tokens.title")}
            description={t("pages.settings.sections.tokens.description")}
            help={
              <HelpPopover
                title={t("pages.settings.sections.tokens.helpTitle")}
                data-testid="api-tokens-help"
              >
                <p>{t("pages.settings.sections.tokens.helpBody")}</p>
                <p>{t("pages.settings.sections.tokens.helpHeader")}</p>
                <p>{t("pages.settings.sections.tokens.helpOnce")}</p>
              </HelpPopover>
            }
            data-testid="settings-section-api-tokens"
            {...guideAnchor("settings.api-tokens")}
          >
            <ApiTokensSettings />
          </SettingsSection>

          <SettingsSection
            id="preferences"
            icon={SlidersHorizontal}
            title={t("pages.settings.sections.preferences.title")}
            description={t("pages.settings.sections.preferences.description")}
            data-testid="settings-section-preferences"
            {...guideAnchor("settings.preferences")}
          >
            <PreferencesSettings />
            <DataRegion
              hasResult={settingsResource.data !== undefined}
              pending={settingsResource.pending}
              error={settingsResource.error}
              onRetry={settingsResource.refresh}
              testId="settings-other-region"
            >
              {otherDefinitions.length > 0 && (
                // Each extension category is its own titled card, like the cards above it.
                <div className="space-y-4" data-testid="settings-section-other">
                  <SettingsEditor
                    definitions={otherDefinitions.map(editorDefinition)}
                    values={values}
                    onSave={saveSetting}
                    testIdPrefix="user-setting"
                    enableFullscreenEdit
                    collapsible={false}
                    showKeys={false}
                  />
                </div>
              )}
            </DataRegion>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
};
