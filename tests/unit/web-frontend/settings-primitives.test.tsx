/**
 * @jest-environment jsdom
 */

/**
 * The building blocks of the Settings page: a section addressable by its anchor, the in-page
 * navigation, help that opens on demand, deep links that wait for the page's data, the words a
 * built-in setting is shown with, the GitHub setup progress, and a readable device name.
 */

import React from "react";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import { Bell, UserRound } from "lucide-react";
import {
  SettingsSection,
  SettingsSubsection,
} from "../../../packages/web-frontend/src/components/settings/SettingsSection";
import { SettingsNav } from "../../../packages/web-frontend/src/components/settings/SettingsNav";
import { HelpPopover } from "../../../packages/web-frontend/src/components/settings/HelpPopover";
import { useSectionHighlight } from "../../../packages/web-frontend/src/components/settings/useSectionHighlight";
import { localizeSettingDefinition } from "../../../packages/web-frontend/src/components/settings/localize-definition";
import { setupStepStates } from "../../../packages/web-frontend/src/pages/settings/GitHubSetupSteps";
import { parseUserAgent } from "../../../packages/web-frontend/src/lib/user-agent";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/settings");
  document.body.replaceChildren();
});

describe("SettingsSection", () => {
  test("is addressable by its anchor and named by its heading", () => {
    render(
      <SettingsSection id="notifications" icon={Bell} title="Notifications" description="Where.">
        <p>body</p>
      </SettingsSection>,
    );
    const section = screen.getByRole("region", { name: "Notifications" });
    expect(section).toHaveAttribute("id", "notifications");
    expect(section).toHaveAttribute("data-settings-section", "notifications");
    expect(section).toHaveTextContent("Where.");
  });
});

describe("SettingsSubsection", () => {
  test("is one card whose header holds the title, its help and its description above the content", () => {
    render(
      <SettingsSubsection
        title="Active Sessions"
        description="Devices signed in."
        help={<button type="button">help</button>}
        data-testid="sessions"
      >
        <ul data-testid="rows" />
      </SettingsSubsection>,
    );
    const card = screen.getByTestId("sessions");
    const heading = screen.getByRole("heading", { level: 3, name: "Active Sessions" });
    const header = heading.closest("[data-testid=sessions] > *")!;
    // Title, help and description share the card's first child; the content is a later one.
    expect(header.parentElement).toBe(card);
    expect(header).toContainElement(screen.getByRole("button", { name: "help" }));
    expect(header).toHaveTextContent("Devices signed in.");
    expect(header).not.toContainElement(screen.getByTestId("rows"));
    expect(card).toContainElement(screen.getByTestId("rows"));
    expect(card.className).toMatch(/\bborder\b/);
  });
});

describe("SettingsNav", () => {
  const items = [
    { id: "account", label: "Account", icon: UserRound },
    { id: "notifications", label: "Notifications", icon: Bell },
  ];

  test("marks the section being read and moves to a chosen one, updating the link", () => {
    const onSelect = jest.fn();
    render(<SettingsNav items={items} active="account" onSelect={onSelect} label="Sections" />);
    expect(screen.getByTestId("settings-nav-account")).toHaveAttribute("aria-current", "location");
    expect(screen.getByTestId("settings-nav-notifications")).not.toHaveAttribute("aria-current");

    fireEvent.click(screen.getByTestId("settings-nav-notifications"));
    expect(onSelect).toHaveBeenCalledWith("notifications");
    expect(window.location.hash).toBe("#notifications");
  });
});

describe("HelpPopover", () => {
  test("keeps its explanation closed until asked, then shows it", () => {
    render(
      <HelpPopover title="What a token is" data-testid="token-help">
        <p>Sent as a Bearer header.</p>
      </HelpPopover>,
    );
    expect(screen.queryByText("Sent as a Bearer header.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "What a token is" }));
    expect(screen.getByTestId("token-help-content")).toHaveTextContent("Sent as a Bearer header.");
  });
});

describe("useSectionHighlight", () => {
  function page() {
    const container = document.createElement("div");
    for (const id of ["account", "integrations-github"]) {
      const section = document.createElement("section");
      section.dataset.settingsSection = id;
      section.scrollIntoView = jest.fn();
      container.append(section);
    }
    document.body.append(container);
    return container;
  }

  test("honours the link's section only once the page's data is ready, at the top of the view", () => {
    window.history.replaceState(null, "", "/settings#integrations-github");
    const container = page();
    const target = container.querySelector<HTMLElement>(
      '[data-settings-section="integrations-github"]',
    )!;
    const ref: RefObject<HTMLElement> = { current: container };
    const { rerender } = renderHook(({ ready }) => useSectionHighlight(ref, ready), {
      initialProps: { ready: false },
    });
    // Before the data arrives the section may not be where it will end up.
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(target).not.toHaveAttribute("data-highlighted");

    rerender({ ready: true });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(target).toHaveAttribute("data-highlighted", "true");
  });

  test("highlights a section the navigation asks for", () => {
    const container = page();
    const ref: RefObject<HTMLElement> = { current: container };
    const { result } = renderHook(() => useSectionHighlight(ref, true));
    act(() => result.current.highlight("account"));
    expect(container.querySelector('[data-settings-section="account"]')).toHaveAttribute(
      "data-highlighted",
      "true",
    );
  });
});

describe("localizeSettingDefinition", () => {
  const definition = {
    key: "telegram.bot_token",
    label: "Bot Token",
    description: "Your Telegram bot token from @BotFather",
  };

  test("prefers the locale's words and adds its help", () => {
    const words: Record<string, string> = {
      "pages.settings.definitions.telegram.bot_token.label": "Токен бота",
      "pages.settings.definitions.telegram.bot_token.description": "Токен от @BotFather.",
      "pages.settings.definitions.telegram.bot_token.help": "Откройте @BotFather.",
    };
    const t = ((key: string, options: { defaultValue: string }) =>
      words[key] ?? options.defaultValue) as unknown as TFunction;
    expect(localizeSettingDefinition(definition, t)).toMatchObject({
      label: "Токен бота",
      description: "Токен от @BotFather.",
      help: "Откройте @BotFather.",
    });
  });

  test("falls back to the server's words for a setting the locale does not know", () => {
    const t = ((_key: string, options: { defaultValue: string }) =>
      options.defaultValue) as unknown as TFunction;
    const localized = localizeSettingDefinition(
      { key: "probe.token", label: "Probe token", description: null },
      t,
    );
    expect(localized).toEqual({ key: "probe.token", label: "Probe token", description: null });
  });
});

describe("GitHub setup progress", () => {
  test.each([
    [
      "connection_required",
      0,
      { account: "current", install: "upcoming", repositories: "upcoming" },
    ],
    ["installation_required", 0, { account: "done", install: "current", repositories: "upcoming" }],
    ["connected", 0, { account: "done", install: "done", repositories: "current" }],
    ["connected", 2, { account: "done", install: "done", repositories: "done" }],
    ["disabled", 0, { account: "blocked", install: "blocked", repositories: "blocked" }],
  ] as const)("a %s connection with %i repositories", (state, count, expected) => {
    const repositories = Array.from({ length: count }, (_, index) => ({
      externalRepositoryId: String(index),
      fullName: `owner/repo-${index}`,
      private: true,
    }));
    expect(setupStepStates({ state, repositories })).toEqual(expected);
  });
});

describe("parseUserAgent", () => {
  test.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      { browser: "Chrome", os: "macOS", device: "desktop", headless: false, client: false },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36",
      { browser: "Chrome", os: "macOS", device: "desktop", headless: true, client: false },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      { browser: "Edge", os: "Windows", device: "desktop", headless: false, client: false },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      { browser: "Safari", os: "iOS", device: "mobile", headless: false, client: false },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
      { browser: "Firefox", os: "Linux", device: "desktop", headless: false, client: false },
    ],
    ["node", { browser: "Node.js", os: null, device: "desktop", headless: false, client: true }],
    ["", { browser: null, os: null, device: "desktop", headless: false, client: false }],
  ])("%s", (userAgent, expected) => {
    expect(parseUserAgent(userAgent)).toEqual(expected);
  });
});
