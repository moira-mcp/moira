/**
 * The Settings page's guides: the screen tour through every section, and the two task tours that
 * set up GitHub with cloud codespaces and Telegram notifications, started from their sections.
 * Every section stays mounted, so no step waits on a panel to open.
 */

import type { GuideDefinition } from "../../guides/types";

const SETTINGS_ROUTES = ["/settings"];

export const settingsGuide: GuideDefinition = {
  id: "settings",
  kind: "screen",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  steps: [
    { id: "nav", anchor: "settings.nav", kind: "look", revision: 1 },
    { id: "account", anchor: "settings.account", kind: "look", revision: 1 },
    { id: "security", anchor: "settings.security", kind: "look", revision: 1 },
    // Revision 2: the step says what Moira's notifications are for (plan ready, action needed,
    // finished) and that their heading opens the run page.
    { id: "notifications", anchor: "settings.notifications", kind: "look", revision: 2 },
    { id: "github", anchor: "settings.integrations", kind: "look", revision: 1 },
    { id: "local-devices", anchor: "settings.local-devices", kind: "look", revision: 1 },
    { id: "apps", anchor: "settings.apps", kind: "look", revision: 1 },
    { id: "tokens", anchor: "settings.api-tokens", kind: "look", revision: 1 },
    { id: "preferences", anchor: "settings.preferences", kind: "look", revision: 1 },
  ],
};

export const githubSetupGuide: GuideDefinition = {
  id: "settings-github",
  kind: "task",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  steps: [
    { id: "steps", anchor: "settings.github-steps", kind: "look", revision: 1 },
    { id: "connect", anchor: "settings.github-connect", kind: "look", revision: 2 },
    { id: "codespaces", anchor: "settings.codespaces", kind: "look", revision: 3 },
    { id: "limits", anchor: "settings.codespace-limits", kind: "look", revision: 2 },
    { id: "autopause", anchor: "settings.codespace-autopause", kind: "look", revision: 1 },
  ],
};

export const telegramSetupGuide: GuideDefinition = {
  id: "settings-telegram",
  kind: "task",
  screen: "settings",
  routes: SETTINGS_ROUTES,
  steps: [
    { id: "bot", anchor: "settings.telegram-bot-token", kind: "look", revision: 1 },
    { id: "chat", anchor: "settings.telegram-chat-id", kind: "look", revision: 1 },
    { id: "enable", anchor: "settings.telegram-enabled", kind: "look", revision: 1 },
    { id: "test", anchor: "settings.telegram-test", kind: "look", revision: 1 },
  ],
};
