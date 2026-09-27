/** @jest-environment jsdom */
/**
 * A guide as a keyboard and screen-reader user meets it: "What is this?" opens the screen's tour,
 * focus goes into the card, which is named by its step; the arrows and Enter move and Escape
 * closes, returning focus to the button; nothing moves while the reader types; each step is
 * announced once through a polite live region; the spotlight never writes to the explained element;
 * and nothing animates in when the reader asked for reduced motion.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { GuideButton } from "../../../packages/web-frontend/src/guides/GuideButton";
import { guideAnchor } from "../../../packages/web-frontend/src/guides/anchors";
import { PageHeader } from "../../../packages/web-frontend/src/components/page-header";
import en from "../../../packages/web-frontend/src/locales/en.json";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
const settings = en.guides.settings.steps;

/** The Settings sections the screen tour points at, drawn as plain boxes. */
function SettingsFixture(): React.JSX.Element {
  return (
    <>
      <GuideButton guideId="settings" />
      <input aria-label="notes" />
      {[
        "settings.nav",
        "settings.account",
        "settings.security",
        "settings.notifications",
        "settings.integrations",
        "settings.apps",
        "settings.api-tokens",
        "settings.preferences",
      ].map((name) => (
        <section key={name} {...guideAnchor(name)} data-testid={name}>
          {name}
        </section>
      ))}
    </>
  );
}

function renderTour(): void {
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <I18nextProvider i18n={i18n}>
        <GuideProvider>
          <SettingsFixture />
        </GuideProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

function stubMedia({ reducedMotion }: { reducedMotion: boolean }): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  // jsdom lays nothing out: give every element a box so an anchor counts as visible.
  HTMLElement.prototype.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 40, y: 80, width: 320, height: 48 });
  HTMLElement.prototype.scrollIntoView = () => {};
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A phone-width window: the card is a sheet, which needs no popper layout.
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  // The card's entrance runs on animation frames, so under it a card may be found half-faded. Every
  // test but the entrance's own reads the card without it.
  stubMedia({ reducedMotion: true });
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

async function openTour(): Promise<HTMLElement> {
  const opener = screen.getByTestId("guide-open");
  opener.focus();
  fireEvent.click(opener);
  return screen.findByRole("dialog", { name: settings.nav.title }, { timeout: 4000 });
}

describe("a guide's card", () => {
  test("opens on the first step, named by its title, and takes focus", async () => {
    renderTour();
    const card = await openTour();
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(card).toHaveAttribute("data-guide-step", "nav");
  });

  test("moves with the arrows and Enter, and closes on Escape with focus back on the opener", async () => {
    renderTour();
    await openTour();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("dialog", { name: settings.account.title })).toBeVisible();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: settings.security.title })).toBeVisible();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(await screen.findByRole("dialog", { name: settings.account.title })).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("guide-open")));
  });

  test("leaves the keys to a field the reader is typing in", async () => {
    renderTour();
    await openTour();
    const field = screen.getByLabelText("notes");
    fireEvent.keyDown(field, { key: "ArrowRight" });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "nav");
  });

  test("announces each step once, through a polite live region", async () => {
    renderTour();
    await openTour();
    const announcer = screen.getByTestId("guide-announcer");
    expect(announcer).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(announcer).toHaveTextContent(settings.nav.title));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(announcer).toHaveTextContent(settings.account.title));
    // One announcement at a time: the region holds the current step's sentence only.
    expect(announcer.textContent).not.toContain(settings.nav.title);
    expect(announcer.textContent).toBe(
      `${en.guides.settings.title}, step 2 of 8: ${settings.account.title}`,
    );
  });

  test("dims around the explained element without writing to it", async () => {
    renderTour();
    await openTour();
    const spotlight = await screen.findByTestId("guide-spotlight", {}, { timeout: 4000 });
    expect(spotlight).toHaveClass("pointer-events-none");
    expect(spotlight).toHaveAttribute("data-guide-anchor", "settings.nav");
    expect(screen.getByTestId("settings.nav")).not.toHaveAttribute("style");
  });

  test.each([
    [true, false],
    [false, true],
  ])(
    "with reduced motion %p, the card starts hidden for an entrance animation: %p",
    async (reducedMotion, animates) => {
      stubMedia({ reducedMotion });
      renderTour();
      // The entrance runs on animation frames, so a card read after it is found may be at any point
      // of it. Its style as React inserts it is fixed: an observer's callback runs before any frame.
      const inserted: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;
            const card = node.matches('[data-testid="guide-card"]')
              ? node
              : node.querySelector<HTMLElement>('[data-testid="guide-card"]');
            if (card) inserted.push(card.style.opacity);
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      await openTour();
      observer.disconnect();
      expect(inserted.length).toBeGreaterThan(0);
      expect(inserted[0] === "0").toBe(animates);
    },
  );
});

describe('"What is this?" in the page header', () => {
  function renderHeader(pathname: string): void {
    render(
      <MemoryRouter initialEntries={[pathname]}>
        <I18nextProvider i18n={i18n}>
          <GuideProvider>
            <PageHeader title="A page">
              <button type="button">An action</button>
            </PageHeader>
          </GuideProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
  }

  test("is offered on a route whose screen has a tour, and opens that tour", async () => {
    renderHeader("/settings");
    const button = screen.getByTestId("guide-open");
    expect(button).toHaveTextContent(en.guides.ui.whatIsThis);
    expect(button).toHaveAttribute("data-guide-id", "settings");
    fireEvent.click(button);
    expect(
      await screen.findByRole("dialog", { name: settings.nav.title }, { timeout: 4000 }),
    ).toBeVisible();
  });

  test("is absent on a route with no tour, beside the page's own actions", () => {
    // The admin area's tours are deferred, so its screens stay without one.
    renderHeader("/admin");
    expect(screen.getByRole("button", { name: "An action" })).toBeVisible();
    expect(screen.queryByTestId("guide-open")).toBeNull();
  });
});
