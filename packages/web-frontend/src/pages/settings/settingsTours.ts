/**
 * The Settings page's step-by-step tutorials, run by the shared `Walkthrough`: one that explains
 * the page, one that sets up GitHub and cloud codespaces, one that sets up Telegram notifications.
 *
 * Every anchor names an element the page always renders (all sections stay mounted), so a step
 * never points at nothing. Texts live under `pages.settings.tours.<tour>`.
 */

import type { GuideStep } from "../../components/run/Walkthrough";

/** The Settings page has a single view; the Walkthrough's view switching never applies. */
export type SettingsTourView = "page";

export type SettingsTourId = "page" | "github" | "telegram";

type Step = GuideStep<SettingsTourView, never>;

const on = (id: string, selector: string): Step => ({
  id,
  targets: { page: selector },
  fallbackView: "page",
});

export const SETTINGS_TOURS: Record<SettingsTourId, Step[]> = {
  page: [
    on("nav", '[data-testid="settings-nav"], [data-testid="settings-nav-chips"]'),
    on("account", '[data-testid="settings-section-profile"]'),
    on("security", '[data-testid="settings-section-security"]'),
    on("notifications", '[data-testid="settings-section-dynamic"]'),
    on("github", '[data-testid="settings-section-integrations"]'),
    on("apps", '[data-testid="settings-section-oauth"]'),
    on("tokens", '[data-testid="settings-section-api-tokens"]'),
    on("preferences", '[data-testid="settings-section-preferences"]'),
  ],
  github: [
    on("steps", '[data-testid="github-setup-steps"]'),
    on("connect", '[data-testid="github-codespace-settings"]'),
    on("codespaces", '[data-testid="github-codespace-management"]'),
    on("limits", '[data-testid="github-codespace-limits"]'),
    on("autopause", '[data-testid="codespace-auto-pause"]'),
  ],
  telegram: [
    on("bot", '[data-testid="user-channel-telegram-telegram.bot_token"]'),
    on("chat", '[data-testid="user-channel-telegram-telegram.chat_id"]'),
    on("enable", '[data-testid="user-channel-telegram-telegram.enabled"]'),
    on("test", '[data-testid="communication-channel-telegram-test"]'),
  ],
};

export const TOUR_PARAM = "tour";
export const GUIDE_PARAM = "guide";

export function isSettingsTourId(value: string | null): value is SettingsTourId {
  return value === "page" || value === "github" || value === "telegram";
}
