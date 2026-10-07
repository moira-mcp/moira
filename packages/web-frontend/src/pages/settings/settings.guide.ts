/**
 * The Settings page's guides: the screen tour through every section, and the two task tours that
 * set up GitHub with cloud codespaces and Telegram notifications, started from their sections.
 * Sections stay mounted; preparation selects their visible task tab before finding the anchor.
 */

import type { GuideDefinition } from "../../guides/types";

const SETTINGS_ROUTES = ["/settings"];
const SETTINGS_SECTIONS = [
  "account",
  "security",
  "notifications",
  "development-environments",
  "integrations-github",
  "integrations-local",
  "connected-apps",
  "api-tokens",
  "preferences",
];

export const settingsGuide: GuideDefinition = {
  id: "settings",
  kind: "screen",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  sections: SETTINGS_SECTIONS,
  steps: [
    { id: "nav", anchor: "settings.nav", kind: "look", revision: 3 },
    {
      id: "account",
      anchor: "settings.account",
      kind: "look",
      revision: 1,
      prepare: { section: "account" },
    },
    {
      id: "security",
      anchor: "settings.security",
      kind: "look",
      revision: 1,
      prepare: { section: "security" },
    },
    // Revision 2: the step says what Moira's notifications are for (plan ready, action needed,
    // finished) and that their heading opens the run page.
    {
      id: "notifications",
      anchor: "settings.notifications",
      kind: "look",
      revision: 2,
      prepare: { section: "notifications" },
    },
    {
      id: "github",
      anchor: "settings.integrations",
      kind: "look",
      revision: 3,
      prepare: { section: "development-environments" },
    },
    {
      id: "local-devices",
      anchor: "settings.local-devices",
      kind: "look",
      revision: 7,
      prepare: { section: "integrations-local" },
    },
    {
      id: "apps",
      anchor: "settings.apps",
      kind: "look",
      revision: 1,
      prepare: { section: "connected-apps" },
    },
    {
      id: "tokens",
      anchor: "settings.api-tokens",
      kind: "look",
      revision: 1,
      prepare: { section: "api-tokens" },
    },
    {
      id: "preferences",
      anchor: "settings.preferences",
      kind: "look",
      revision: 1,
      prepare: { section: "preferences" },
    },
  ],
};

export const githubSetupGuide: GuideDefinition = {
  id: "settings-github",
  kind: "task",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  sections: SETTINGS_SECTIONS,
  steps: [
    {
      id: "steps",
      anchor: "settings.github-steps",
      kind: "look",
      revision: 1,
      prepare: { section: "integrations-github" },
    },
    {
      id: "connect",
      anchor: "settings.github-connect",
      kind: "look",
      revision: 2,
      prepare: { section: "integrations-github" },
    },
    {
      id: "codespaces",
      anchor: "settings.codespaces",
      kind: "look",
      revision: 4,
      prepare: { section: "development-environments" },
    },
    {
      id: "limits",
      anchor: "settings.codespace-limits",
      kind: "look",
      revision: 2,
      prepare: { section: "development-environments" },
    },
    {
      id: "autopause",
      anchor: "settings.codespace-autopause",
      kind: "look",
      revision: 1,
      prepare: { section: "development-environments" },
    },
  ],
};

export const telegramSetupGuide: GuideDefinition = {
  id: "settings-telegram",
  kind: "task",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  sections: SETTINGS_SECTIONS,
  steps: [
    {
      id: "bot",
      anchor: "settings.telegram-bot-token",
      kind: "look",
      revision: 1,
      prepare: { section: "notifications" },
    },
    {
      id: "chat",
      anchor: "settings.telegram-chat-id",
      kind: "look",
      revision: 1,
      prepare: { section: "notifications" },
    },
    {
      id: "enable",
      anchor: "settings.telegram-enabled",
      kind: "look",
      revision: 1,
      prepare: { section: "notifications" },
    },
    {
      id: "test",
      anchor: "settings.telegram-test",
      kind: "look",
      revision: 1,
      prepare: { section: "notifications" },
    },
  ],
};
