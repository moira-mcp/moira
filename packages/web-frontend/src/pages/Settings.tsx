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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertCircle,
  AppWindow,
  Bell,
  Compass,
  Github,
  KeyRound,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import { apiClient } from "../services/api-client";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { Walkthrough } from "@/components/run/Walkthrough";
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
import {
  GUIDE_PARAM,
  SETTINGS_TOURS,
  TOUR_PARAM,
  isSettingsTourId,
  type SettingsTourId,
  type SettingsTourView,
} from "./settings/settingsTours";

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
]);

const noop = () => {};

export const Settings: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [definitions, setDefinitions] = useState<SettingDefinition[]>([]);
  const [channels, setChannels] = useState<CommunicationChannelDescriptor[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const loadChannels = useCallback(async () => {
    const response = await fetch("/api/notifications/channels");
    const data = await response.json();
    if (!response.ok) throw new Error("channels");
    setChannels(data.data || []);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const results = await Promise.allSettled([
      (async () => {
        const response = await fetch("/api/user/profile", { credentials: "include" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error("profile");
        setProfile(data.data);
      })(),
      (async () => {
        const response = await fetch("/api/settings/definitions");
        const data = await response.json();
        if (!response.ok) throw new Error("definitions");
        setDefinitions(data.data || []);
      })(),
      loadChannels(),
      (async () => setValues(await apiClient.getUserSettings()))(),
    ]);
    setLoadFailed(results.some((result) => result.status === "rejected"));
    setLoading(false);
  }, [loadChannels]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

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
      try {
        await loadChannels();
      } catch {
        // The saved value stands; the channel state catches up on the next load.
      }
    },
    [loadChannels],
  );

  const handleTestNotification = async (channel: CommunicationChannelDescriptor) => {
    try {
      setTestingChannel(channel.id);
      const response = await fetch(
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
  const active = useActiveSection(sectionIds, !loading);
  const { highlight } = useSectionHighlight(contentRef, !loading);

  // Tutorials: `?tour=<id>&guide=<step>`, so a step can be linked and reopened.
  const tourParam = searchParams.get(TOUR_PARAM);
  const tour: SettingsTourId = isSettingsTourId(tourParam) ? tourParam : "page";
  const guideStep = Number(searchParams.get(GUIDE_PARAM)) || 0;
  const navigateTour = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          if (patch[GUIDE_PARAM] === null) next.delete(TOUR_PARAM);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const openTour = (id: SettingsTourId) => navigateTour({ [TOUR_PARAM]: id, [GUIDE_PARAM]: "1" });
  const hasTelegram = channels.some((channel) => channel.id === "telegram");

  const sectionSkeleton = (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-20 w-full rounded-xl" />
    </div>
  );

  return (
    <div className="px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <PageHeader title={t("pages.settings.title")} description={t("pages.settings.description")}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openTour("page")}
          data-testid="settings-guide-open"
        >
          <Compass className="mr-1.5 size-4" aria-hidden="true" />
          {t("pages.settings.tours.page.open")}
        </Button>
      </PageHeader>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav
          items={navItems}
          active={active}
          onSelect={highlight}
          label={t("pages.settings.navLabel")}
        />

        <div
          ref={contentRef}
          className="min-w-0 max-w-3xl space-y-14 pb-24"
          data-testid="settings-flat-layout"
        >
          {loadFailed && (
            <Alert variant="destructive" data-testid="settings-load-failed">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{t("pages.settings.loadFailed")}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{t("pages.settings.loadFailedDescription")}</p>
                <Button variant="outline" size="sm" onClick={() => void loadAll()}>
                  {t("pages.settings.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <SettingsSection
            id="account"
            icon={UserRound}
            title={t("pages.settings.sections.account.title")}
            description={t("pages.settings.sections.account.description")}
            data-testid="settings-section-profile"
          >
            {profile ? (
              <ProfileSettings profile={profile} onProfileUpdate={setProfile} />
            ) : (
              sectionSkeleton
            )}
          </SettingsSection>

          <SettingsSection
            id="security"
            icon={ShieldCheck}
            title={t("pages.settings.sections.security.title")}
            description={t("pages.settings.sections.security.description")}
            data-testid="settings-section-security"
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
                  onClick={() => openTour("telegram")}
                  data-testid="telegram-guide-open"
                >
                  <Compass className="mr-1.5 size-4" aria-hidden="true" />
                  {t("pages.settings.tours.telegram.open")}
                </Button>
              )
            }
            data-testid="settings-section-dynamic"
          >
            {loading ? (
              sectionSkeleton
            ) : channels.length === 0 ? (
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
                onClick={() => openTour("github")}
                data-testid="github-guide-open"
              >
                <Compass className="mr-1.5 size-4" aria-hidden="true" />
                {t("pages.settings.tours.github.open")}
              </Button>
            }
            data-testid="settings-section-integrations"
          >
            <GitHubCodespacesProvider>
              <GitHubCodespaceSettings />
              <GitHubCodespaceManagement />
              <CodespaceAutoPause values={values} onSave={saveSetting} />
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
          >
            <ApiTokensSettings />
          </SettingsSection>

          <SettingsSection
            id="preferences"
            icon={SlidersHorizontal}
            title={t("pages.settings.sections.preferences.title")}
            description={t("pages.settings.sections.preferences.description")}
            data-testid="settings-section-preferences"
          >
            <PreferencesSettings />
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
          </SettingsSection>
        </div>
      </div>

      <Walkthrough<SettingsTourView, never>
        step={guideStep}
        mode="page"
        currentBlockId={null}
        routeRecorded={false}
        onNavigate={navigateTour}
        onPanel={noop}
        steps={SETTINGS_TOURS[tour]}
        textKey={`pages.settings.tours.${tour}`}
      />
    </div>
  );
};
