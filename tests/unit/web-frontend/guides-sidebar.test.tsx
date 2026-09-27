/** @jest-environment jsdom */
/**
 * A guide step whose element is in the app sidebar: the runner opens the sidebar first and closes
 * again what it opened. On a phone the sidebar is a modal sheet, so the card is rendered inside it —
 * outside an open modal nothing can be clicked or focused. On a wide screen a collapsed sidebar is
 * expanded for the step and collapsed back after it, and one the person had open stays open.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { guideAnchor } from "../../../packages/web-frontend/src/guides/anchors";
import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from "../../../packages/web-frontend/src/components/ui/sidebar";
import type { GuideDefinition } from "../../../packages/web-frontend/src/guides/types";

// No shipped guide points into the sidebar yet, so the runner is driven by a fixture guide.
jest.unstable_mockModule("../../../packages/web-frontend/src/guides/registry", () => {
  const fixture: GuideDefinition = {
    id: "fixture",
    kind: "screen",
    screen: "fixture",
    routes: ["/fixture"],
    steps: [
      { id: "page", anchor: "fixture.page", kind: "look", revision: 1 },
      { id: "nav", anchor: "fixture.nav", kind: "look", revision: 1, prepare: { sidebar: true } },
      { id: "after", anchor: "fixture.after", kind: "look", revision: 1 },
      { id: "wide", anchor: "fixture.page", kind: "look", revision: 1, wide: true },
      { id: "end", anchor: "fixture.after", kind: "look", revision: 1 },
    ],
  };
  return {
    GUIDES: [fixture],
    guideById: (id: string | null | undefined) => (id === "fixture" ? fixture : undefined),
    screenTourForPath: () => undefined,
  };
});

// Imported after the mock, so the provider and the button read the fixture registry.
const { GuideProvider } = await import("../../../packages/web-frontend/src/guides/GuideContext");
const { GuideButton } = await import("../../../packages/web-frontend/src/guides/GuideButton");
const { resetGuideProgress } = await import("../../../packages/web-frontend/src/guides/progress");
const { fakeUserSettings } = await import("./helpers/fake-user-settings");
const { modalOf, sheetEdge } =
  await import("../../../packages/web-frontend/src/guides/GuideRunner");

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

function renderShell({ sidebarOpen, at }: { sidebarOpen: boolean; at?: string }): void {
  render(
    <MemoryRouter initialEntries={[at ?? "/fixture"]}>
      <I18nextProvider i18n={i18n}>
        <SidebarProvider defaultOpen={sidebarOpen}>
          <GuideProvider>
            <Sidebar collapsible="icon">
              <SidebarContent>
                <nav {...guideAnchor("fixture.nav")}>navigation</nav>
              </SidebarContent>
            </Sidebar>
            <main>
              <GuideButton guideId="fixture" />
              <section {...guideAnchor("fixture.page")}>page</section>
              <section {...guideAnchor("fixture.after")}>after</section>
            </main>
          </GuideProvider>
        </SidebarProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

const card = () => screen.getByTestId("guide-card");
const onStep = (id: string) =>
  waitFor(() => expect(card()).toHaveAttribute("data-guide-step", id), { timeout: 4000 });
/** The guide has opened: its card has focus, taken in the pass that starts its key listener. */
const opened = () => waitFor(() => expect(document.activeElement).toBe(card()), { timeout: 4000 });
const phoneSheet = () => document.querySelector<HTMLElement>('[data-mobile="true"]');
const railState = () =>
  document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute("data-state");

beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  // The runner records progress; each test starts with none, on a server that stores it.
  resetGuideProgress();
  fakeUserSettings();
  document.cookie = "sidebar_state=; max-age=0; path=/";
  // jsdom lays nothing out: give every element a box so an anchor counts as visible.
  HTMLElement.prototype.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 40, y: 80, width: 320, height: 48 });
  HTMLElement.prototype.scrollIntoView = () => {};
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Reduced motion: the card has no entrance, so it is where it will stay as soon as it exists.
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

describe("a guide step in the app sidebar", () => {
  test("on a phone, opens the sidebar sheet, shows the card inside it, and closes it after", async () => {
    setWidth(390);
    renderShell({ sidebarOpen: true });
    fireEvent.click(screen.getByTestId("guide-open"));
    await onStep("page");
    await opened();
    expect(phoneSheet()).toBeNull();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await onStep("nav");
    await waitFor(() => expect(phoneSheet()).not.toBeNull());
    await waitFor(() => expect(phoneSheet()!.contains(card())).toBe(true), { timeout: 4000 });
    expect(phoneSheet()).toHaveTextContent("navigation");

    fireEvent.click(screen.getByTestId("guide-next"));
    await onStep("after");
    await waitFor(() => expect(phoneSheet()).toBeNull());
    expect(document.body.contains(card())).toBe(true);
  });

  test.each([
    [false, ["collapsed", "expanded", "collapsed"]],
    [true, ["expanded", "expanded", "expanded"]],
  ])(
    "on a wide screen with the sidebar open %p, its state before, during and after the step is %p",
    async (sidebarOpen, states) => {
      setWidth(1280);
      renderShell({ sidebarOpen });
      fireEvent.click(screen.getByTestId("guide-open"));
      await onStep("page");
      await opened();
      expect(railState()).toBe(states[0]);

      fireEvent.keyDown(window, { key: "ArrowRight" });
      await onStep("nav");
      await waitFor(() => expect(railState()).toBe(states[1]));

      fireEvent.keyDown(window, { key: "ArrowRight" });
      await onStep("after");
      await waitFor(() => expect(railState()).toBe(states[2]));
    },
  );

  test("closing the guide on the step closes the sheet it opened", async () => {
    setWidth(390);
    renderShell({ sidebarOpen: true });
    fireEvent.click(screen.getByTestId("guide-open"));
    await onStep("page");
    await opened();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await onStep("nav");
    await waitFor(() => expect(phoneSheet()).not.toBeNull());

    // The card's own close button, not Escape: the sheet closes itself on Escape.
    await waitFor(() => expect(phoneSheet()!.contains(card())).toBe(true), { timeout: 4000 });
    fireEvent.click(screen.getByTestId("guide-close"));
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    await waitFor(() => expect(phoneSheet()).toBeNull());
  });
});

describe("where the card goes for an element in a dialog", () => {
  test.each([
    ["a modal sheet", '<div role="dialog" id="host"><button id="target"></button></div>', "host"],
    [
      "a popover, whose transformed wrapper would carry a fixed card",
      '<div data-radix-popper-content-wrapper><div role="dialog"><button id="target"></button></div></div>',
      null,
    ],
    ["the page", '<main><button id="target"></button></main>', null],
  ])("%s → %p", (_where, html, host) => {
    document.body.innerHTML = html;
    const found = modalOf(document.getElementById("target"));
    expect(found?.id ?? null).toBe(host);
  });
});

describe("a wide-only step on a phone", () => {
  test("opened by link, it is skipped with a note and never shown or announced first", async () => {
    setWidth(390);
    // Every value the card's step and the announcer ever held, from the records themselves: React
    // may correct a first render within the same task, before an observer could read the page.
    const cards: string[] = [];
    const announced: string[] = [];
    const cardStep = (node: Node) =>
      node instanceof HTMLElement
        ? (node.matches('[data-testid="guide-card"]')
            ? node
            : node.querySelector('[data-testid="guide-card"]')
          )?.getAttribute("data-guide-step")
        : undefined;
    const inAnnouncer = (node: Node) =>
      (node instanceof HTMLElement ? node : node.parentElement)?.closest(
        '[data-testid="guide-announcer"]',
      ) != null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === "data-guide-step" && record.oldValue)
          cards.push(record.oldValue);
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          const step = cardStep(node);
          if (step) cards.push(step);
        }
        if (!inAnnouncer(record.target)) continue;
        if (record.type === "characterData" && record.oldValue) announced.push(record.oldValue);
        for (const node of [...record.addedNodes, ...record.removedNodes])
          if (node.textContent) announced.push(node.textContent);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
    renderShell({ sidebarOpen: true, at: "/fixture?guide=fixture&step=wide" });
    await onStep("end");
    await waitFor(() => expect(screen.getByTestId("guide-note")).toBeVisible());
    announced.push(screen.getByTestId("guide-announcer").textContent ?? "");
    observer.disconnect();
    expect(cards).not.toContain("wide");
    expect(announced.some((text) => text.includes("steps.wide"))).toBe(false);
    expect(announced.some((text) => text.includes("steps.end"))).toBe(true);
  });
});

describe("the edge a phone's sheet docks to", () => {
  // An 844 px window and a 320 px sheet: the bottom sheet starts at 524, a top one ends at 320.
  test.each([
    ["an element scrolled to the top stays clear of a bottom sheet", 60, 120, "bottom"],
    ["an element the page could not scroll up sits under a bottom sheet", 600, 120, "top"],
    ["an element that touches neither edge keeps the bottom sheet", 350, 100, "bottom"],
    ["a tall element goes where less of it is covered", 200, 500, "top"],
  ])("%s", (_case, top, height, edge) => {
    expect(sheetEdge({ left: 0, top, width: 300, height }, 320, 844)).toBe(edge);
  });
});

describe("going back across a step that cannot be shown", () => {
  test("Back from the step after a wide-only one lands before it on a phone, with the note", async () => {
    setWidth(390);
    renderShell({ sidebarOpen: true, at: "/fixture?guide=fixture&step=end" });
    await onStep("end");
    await opened();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await onStep("after");
    await waitFor(() => expect(screen.getByTestId("guide-note")).toBeVisible());
    // And forward again crosses it the other way.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await onStep("end");
  });
});
