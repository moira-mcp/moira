/** @jest-environment jsdom */
/**
 * An optional step explains something that may be absent: a beginner panel the reader hid, a view
 * a link opens. While its element is not on the page the step is not shown, not announced and not
 * recorded — a card for it would describe something the reader cannot see — and when the element
 * never appears the tour moves past it with a note. When the element appears a moment late, the
 * step is shown as usual.
 */

import React, { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { guideAnchor } from "../../../packages/web-frontend/src/guides/anchors";
import type { GuideDefinition } from "../../../packages/web-frontend/src/guides/types";

jest.unstable_mockModule("../../../packages/web-frontend/src/guides/registry", () => {
  const fixture: GuideDefinition = {
    id: "fixture",
    kind: "screen",
    screen: "fixture",
    routes: ["/fixture"],
    steps: [
      { id: "page", anchor: "fixture.page", kind: "look", revision: 1 },
      { id: "absent", anchor: "fixture.absent", kind: "look", revision: 1, optional: true },
      { id: "late", anchor: "fixture.late", kind: "look", revision: 1, optional: true },
      { id: "end", anchor: "fixture.page", kind: "look", revision: 1 },
    ],
  };
  // Steps whose absence is known before looking: in a hidden beginner panel, or in a view a link
  // opens (`?name=`).
  const declared: GuideDefinition = {
    id: "declared",
    kind: "screen",
    screen: "declared",
    routes: ["/fixture"],
    steps: [
      { id: "start", anchor: "fixture.page", kind: "look", revision: 1 },
      {
        id: "panel-a",
        anchor: "fixture.panel",
        kind: "look",
        revision: 1,
        optional: true,
        absentWhen: { panelHidden: "home-intro" },
      },
      {
        id: "panel-b",
        anchor: "fixture.panel",
        kind: "look",
        revision: 1,
        optional: true,
        absentWhen: { panelHidden: "home-intro" },
      },
      {
        id: "linked",
        anchor: "fixture.linked",
        kind: "look",
        revision: 1,
        optional: true,
        absentWhen: { queryMissing: "name" },
      },
      { id: "end", anchor: "fixture.page", kind: "look", revision: 1 },
    ],
  };
  // A step only one view draws, opened on the other view: the page switches views for it.
  const viewed: GuideDefinition = {
    id: "viewed",
    kind: "screen",
    screen: "viewed",
    routes: ["/fixture"],
    views: ["steps", "map"],
    steps: [
      { id: "start", anchor: "fixture.page", kind: "look", revision: 1 },
      {
        id: "mapped",
        anchor: "fixture.map",
        kind: "look",
        revision: 1,
        optional: true,
        views: ["map"],
      },
    ],
  };
  // A required step whose element arrives late, and an optional one on a view the page never opens.
  const slow: GuideDefinition = {
    id: "slow",
    kind: "screen",
    screen: "slow",
    routes: ["/fixture"],
    views: ["steps", "map"],
    steps: [
      { id: "start", anchor: "fixture.page", kind: "look", revision: 1 },
      { id: "late", anchor: "fixture.late", kind: "look", revision: 1 },
      {
        id: "never",
        anchor: "fixture.never",
        kind: "look",
        revision: 1,
        optional: true,
        views: ["map"],
      },
      { id: "end", anchor: "fixture.page", kind: "look", revision: 1 },
    ],
  };
  const guides = [fixture, declared, viewed, slow];
  return {
    GUIDES: guides,
    guideById: (id: string | null | undefined) => guides.find((guide) => guide.id === id),
    screenTourForPath: () => undefined,
  };
});

const { GuideProvider, useGuidePage } =
  await import("../../../packages/web-frontend/src/guides/GuideContext");
const { GuideButton } = await import("../../../packages/web-frontend/src/guides/GuideButton");
const { GUIDE_PROGRESS_KEY, resetGuideProgress } =
  await import("../../../packages/web-frontend/src/guides/progress");
const { fakeUserSettings } = await import("./helpers/fake-user-settings");
const { resetBeginnerPanels } =
  await import("../../../packages/web-frontend/src/components/onboarding/beginnerPanels");

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

/** Every step id the card names from now on, in order. */
function recordCardSteps(): { shown: string[]; stop: () => void } {
  const shown: string[] = [];
  const observer = new MutationObserver(() => {
    const step = document
      .querySelector('[data-testid="guide-card"]')
      ?.getAttribute("data-guide-step");
    if (step && shown[shown.length - 1] !== step) shown.push(step);
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  return { shown, stop: () => observer.disconnect() };
}

/** An element that is drawn only a while after the page. */
function Late(): React.JSX.Element | null {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), 4500);
    return () => window.clearTimeout(timer);
  }, []);
  return shown ? <section {...guideAnchor("fixture.late")}>late</section> : null;
}

/** A page with two views that registers its controller; switching views takes a moment. */
function TwoViews(): React.JSX.Element {
  const [view, setView] = useState("steps");
  const controller = React.useMemo(
    () => ({ view, setView: (next: string) => window.setTimeout(() => setView(next), 300) }),
    [view],
  );
  useGuidePage("viewed", controller);
  return (
    <main>
      <GuideButton guideId="viewed" />
      <section {...guideAnchor("fixture.page")}>page</section>
      {view === "map" && <section {...guideAnchor("fixture.map")}>map</section>}
    </main>
  );
}

/** A page that registers a controller whose view never changes, and draws one element late. */
function StuckViews(): React.JSX.Element {
  const controller = React.useMemo(() => ({ view: "steps", setView: () => {} }), []);
  useGuidePage("slow", controller);
  return (
    <main>
      <GuideButton guideId="slow" />
      <section {...guideAnchor("fixture.page")}>page</section>
      <Late />
    </main>
  );
}

function renderPage(guideId = "fixture", at = "/fixture"): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <I18nextProvider i18n={i18n}>
        <GuideProvider>
          <main>
            <GuideButton guideId={guideId} />
            <section {...guideAnchor("fixture.page")}>page</section>
            <Late />
          </main>
        </GuideProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

let server: { stored: Record<string, unknown> };

beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  resetGuideProgress();
  resetBeginnerPanels();
  server = fakeUserSettings();
  HTMLElement.prototype.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 40, y: 80, width: 320, height: 48 });
  HTMLElement.prototype.scrollIntoView = () => {};
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
  jest.useRealTimers();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

describe("an optional step", () => {
  test("whose element is absent is never shown, announced or recorded, and is passed with a note; one drawn late is shown", async () => {
    renderPage();
    // Every step the card ever names, and everything the live region ever says.
    const shownSteps: string[] = [];
    const announced: string[] = [];
    const observer = new MutationObserver(() => {
      const step = document
        .querySelector('[data-testid="guide-card"]')
        ?.getAttribute("data-guide-step");
      if (step && shownSteps[shownSteps.length - 1] !== step) shownSteps.push(step);
      const said = screen.getByTestId("guide-announcer").textContent ?? "";
      if (said && announced[announced.length - 1] !== said) announced.push(said);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });

    fireEvent.click(screen.getByTestId("guide-open"));
    await waitFor(() =>
      expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "page"),
    );
    fireEvent.click(screen.getByTestId("guide-next"));

    // The absent step is passed after the runner's wait; the late element is drawn while the late
    // step waits for it.
    await waitFor(
      () => expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "late"),
      { timeout: 9000 },
    );
    expect(screen.getByTestId("guide-note")).toHaveTextContent(
      i18n.t("guides.ui.skippedHidden", { count: 1 }) as string,
    );
    observer.disconnect();

    expect(shownSteps).toEqual(["page", "late"]);
    expect(announced.some((said) => said.includes("steps.absent"))).toBe(false);
    await waitFor(() => {
      const progress = server.stored[GUIDE_PROGRESS_KEY] as { seen?: Record<string, number> };
      expect(progress?.seen).toMatchObject({ "fixture.page": 1, "fixture.late": 1 });
      expect(progress?.seen).not.toHaveProperty(["fixture.absent"]);
    });
  }, 15000);

  test("declared absent — in a hidden beginner panel, or opened only by a link — is passed at once, and the note counts every step passed", async () => {
    server = fakeUserSettings({ "ui.hidden_panels": ["home-intro"] });
    renderPage("declared");
    const card = recordCardSteps();
    fireEvent.click(screen.getByTestId("guide-open"));
    await waitFor(() =>
      expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "start"),
    );
    fireEvent.click(screen.getByTestId("guide-next"));
    // Well inside the wait an undeclared absent step gets (about three seconds).
    await waitFor(
      () => expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "end"),
      { timeout: 1500 },
    );
    card.stop();
    expect(card.shown).toEqual(["start", "end"]);
    expect(screen.getByTestId("guide-note")).toHaveTextContent(
      i18n.t("guides.ui.skippedHidden", { count: 3 }) as string,
    );
    // Passed without being shown, in a walk of the whole tour: not recorded as seen.
    await waitFor(() => {
      const progress = server.stored[GUIDE_PROGRESS_KEY] as { seen?: Record<string, number> };
      expect(progress?.seen).toHaveProperty(["declared.end"]);
      expect(Object.keys(progress?.seen ?? {}).sort()).toEqual(["declared.end", "declared.start"]);
    });
  });

  test("declared absent in a run of only the changed steps is recorded as offered, so the change is not offered again", async () => {
    server = fakeUserSettings({ "ui.hidden_panels": ["home-intro"] });
    renderPage("declared", "/fixture?guide=declared&only=panel-a");
    await waitFor(() => {
      const progress = server.stored[GUIDE_PROGRESS_KEY] as { seen?: Record<string, number> };
      expect(progress?.seen).toEqual({ "declared.panel-a": 1 });
    });
    // Nothing was shown, and the run is over.
    expect(screen.queryByTestId("guide-card")).toBeNull();
  });

  test("drawn only by another view waits unseen while the page switches views", async () => {
    render(
      <MemoryRouter initialEntries={["/fixture"]}>
        <I18nextProvider i18n={i18n}>
          <GuideProvider>
            <TwoViews />
          </GuideProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
    // Whenever the card names the step, its element must already be on the page.
    const shownWithout: boolean[] = [];
    const observer = new MutationObserver(() => {
      const step = document
        .querySelector('[data-testid="guide-card"]')
        ?.getAttribute("data-guide-step");
      if (step === "mapped")
        shownWithout.push(!document.querySelector('[data-guide~="fixture.map"]'));
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    fireEvent.click(screen.getByTestId("guide-open"));
    await waitFor(() =>
      expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "start"),
    );
    fireEvent.click(screen.getByTestId("guide-next"));
    await waitFor(
      () => expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "mapped"),
      { timeout: 4000 },
    );
    observer.disconnect();
    expect(shownWithout.length).toBeGreaterThan(0);
    expect(shownWithout.every((absent) => !absent)).toBe(true);
  });

  test("an element that arrives after the wait is still found, and a view the page never opens is not waited on for ever", () => {
    // The runner's waits are timers: driving them by hand makes the sequence independent of how
    // busy the machine is.
    jest.useFakeTimers();
    const elapse = (ms: number): void => {
      for (let passed = 0; passed < ms; passed += 250) {
        act(() => {
          jest.advanceTimersByTime(250);
        });
      }
    };
    render(
      <MemoryRouter initialEntries={["/fixture"]}>
        <I18nextProvider i18n={i18n}>
          <GuideProvider>
            <StuckViews />
          </GuideProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId("guide-open"));
    elapse(500);
    expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "start");
    fireEvent.click(screen.getByTestId("guide-next"));
    // The required step says it cannot find its element once the wait is over …
    elapse(3500);
    expect(screen.getByTestId("guide-note")).toBeInTheDocument();
    expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "late");
    // … and finds it when it arrives, a little later.
    elapse(1500);
    expect(screen.getByTestId("guide-spotlight")).toHaveAttribute(
      "data-guide-anchor",
      "fixture.late",
    );
    expect(screen.queryByTestId("guide-note")).toBeNull();
    // The next step is drawn only by a view the page never switches to: it is passed after the
    // same wait, and the tour goes on.
    fireEvent.click(screen.getByTestId("guide-next"));
    elapse(4000);
    expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "end");
  });
});
