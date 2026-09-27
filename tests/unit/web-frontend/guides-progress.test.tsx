/** @jest-environment jsdom */
/**
 * What the guides remember about a reader, and what the interface does with it.
 *
 * The store keeps one user setting: a change is seen at once and saved against the stored value
 * read just before, so two changes made together both land and a field a later build stores is
 * kept; a change the server refuses is undone and rejected. The rules read from it: a guide the
 * reader never walked has nothing "new"; a step whose revision rose since they saw it is new, and
 * "What is this?" then carries a dot and runs only those steps, offering the whole tour at the end.
 * Walking a guide records each step and the place to resume; walking it to the end clears that
 * place, closing it keeps it. The first-run prompt waits for the layout, asks once, and each of its
 * answers holds.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import {
  GuideProvider,
  useGuides,
  visibleSteps,
} from "../../../packages/web-frontend/src/guides/GuideContext";
import { GuideButton } from "../../../packages/web-frontend/src/guides/GuideButton";
import {
  FirstRunPrompt,
  forgetFirstRunLater,
} from "../../../packages/web-frontend/src/guides/FirstRunPrompt";
import { ShowMeAround } from "../../../packages/web-frontend/src/guides/ShowMeAround";
import { SidebarProvider } from "../../../packages/web-frontend/src/components/ui/sidebar";
import { guideAnchor } from "../../../packages/web-frontend/src/guides/anchors";
import { guideById } from "../../../packages/web-frontend/src/guides/registry";
import {
  GUIDE_PROGRESS_KEY,
  changeProgress,
  decideFirstRun,
  finishGuide,
  forgetProgress,
  newSteps,
  parseProgress,
  recordStep,
  stepsForReader,
  resetGuideProgress,
  restartGuides,
  useGuideProgress,
  type GuideProgress,
} from "../../../packages/web-frontend/src/guides/progress";
import en from "../../../packages/web-frontend/src/locales/en.json";
import { fakeUserSettings } from "./helpers/fake-user-settings";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
const settingsGuide = guideById("settings")!;
const SETTINGS_ANCHORS = [
  "settings.nav",
  "settings.account",
  "settings.security",
  "settings.notifications",
  "settings.integrations",
  "settings.apps",
  "settings.api-tokens",
  "settings.preferences",
];
/** Every Settings step seen at its shipped revision. */
const allSeen = Object.fromEntries(
  settingsGuide.steps.map((step) => [`settings.${step.id}`, step.revision]),
);

function stubLayout(): void {
  HTMLElement.prototype.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 40, y: 80, width: 320, height: 48 });
  HTMLElement.prototype.scrollIntoView = () => {};
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
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
}

beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  resetGuideProgress();
  forgetFirstRunLater();
  stubLayout();
});

afterEach(async () => {
  cleanup();
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

/** The stored progress on the fake server. */
const storedProgress = (server: { stored: Record<string, unknown> }) =>
  server.stored[GUIDE_PROGRESS_KEY] as GuideProgress | undefined;

describe("the progress store", () => {
  test("two changes made together both land, and a later build's field is kept", async () => {
    // A server that answers slowly, so the second change is made before the first is saved.
    let stored: Record<string, unknown> = {
      [GUIDE_PROGRESS_KEY]: { tutorials: { copyId: "later-build" } },
    };
    const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
    jest.spyOn(apiClient, "getUserSettings").mockImplementation(async () => {
      await delay();
      return { ...stored };
    });
    jest.spyOn(apiClient, "updateUserSettings").mockImplementation(async (settings) => {
      await delay();
      stored = { ...stored, ...settings };
      return { saved: settings, refused: [] };
    });
    const { result } = renderHook(() => useGuideProgress());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    await act(async () => {
      await Promise.all([
        changeProgress(decideFirstRun("accepted")),
        changeProgress(recordStep("settings", settingsGuide.steps[0], "/settings")),
      ]);
    });
    expect(stored[GUIDE_PROGRESS_KEY]).toEqual({
      tutorials: { copyId: "later-build" },
      firstRun: "accepted",
      seen: { "settings.nav": 1 },
      resume: { guide: "settings", step: "nav", path: "/settings" },
    });
  });

  test("a change is applied to what is stored now, keeping another device's change since loading", async () => {
    const server = fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    const { result } = renderHook(() => useGuideProgress());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    // Another device records the reader's answer after this page read the progress.
    server.stored = { [GUIDE_PROGRESS_KEY]: { firstRun: "declined" } };
    await act(async () => {
      await changeProgress(recordStep("settings", settingsGuide.steps[0], "/settings"));
    });
    expect(storedProgress(server)?.firstRun).toBe("declined");
    expect(storedProgress(server)?.seen).toEqual({ "settings.nav": 1 });
  });

  test("progress that cannot be read stays unknown through a change, so nothing asks on a guess", async () => {
    jest.spyOn(apiClient, "getUserSettings").mockRejectedValue(new Error("unreachable"));
    jest.spyOn(apiClient, "updateUserSettings").mockResolvedValue({ saved: {}, refused: [] });
    const { result } = renderHook(() => useGuideProgress());
    await waitFor(() => expect(apiClient.getUserSettings).toHaveBeenCalled());
    let saved: Promise<void> = Promise.resolve();
    act(() => {
      saved = changeProgress(decideFirstRun("accepted"));
    });
    expect(result.current.loaded).toBe(false);
    await expect(saved).rejects.toThrow("unreachable");
    expect(result.current.loaded).toBe(false);
    expect(apiClient.updateUserSettings).not.toHaveBeenCalled();
  });

  test("a refused save is undone on the page and rejects", async () => {
    jest.spyOn(apiClient, "getUserSettings").mockResolvedValue({});
    jest.spyOn(apiClient, "updateUserSettings").mockResolvedValue({
      saved: {},
      refused: [{ key: GUIDE_PROGRESS_KEY, reason: "does not satisfy its declared schema" }],
    });
    const { result } = renderHook(() => useGuideProgress());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let saved: Promise<void> = Promise.resolve();
    act(() => {
      saved = changeProgress(decideFirstRun("declined"));
    });
    // Shown at once …
    expect(result.current.progress?.firstRun).toBe("declined");
    // … and taken back when the server refuses it.
    await expect(saved).rejects.toThrow("declared schema");
    await waitFor(() => expect(result.current.progress?.firstRun).toBeUndefined());
  });
});

describe("the rules read from progress", () => {
  test("a stored resume role or tour mark that is not yes-or-no is dropped and the place is kept", () => {
    const place = { guide: "flow", step: "edit", path: "/workflows/moira/quick-task" };
    expect(parseProgress({ resume: { ...place, owner: "yes", tour: "full" } }).resume).toEqual(
      place,
    );
    expect(parseProgress({ resume: { ...place, owner: true, tour: true } }).resume).toEqual({
      ...place,
      owner: true,
      tour: true,
    });
  });

  test("a step shown in the full tour makes the tour the place to resume", () => {
    const step = settingsGuide.steps[0];
    expect(recordStep("settings", step, "/settings", true, { tour: true })({}).resume).toEqual({
      guide: "settings",
      step: step.id,
      path: "/settings",
      tour: true,
    });
    expect(recordStep("settings", step, "/settings")({}).resume).not.toHaveProperty("tour");
  });

  test("a guide never walked has nothing new; a step whose revision rose since is new", () => {
    const steps = settingsGuide.steps;
    expect(newSteps(settingsGuide, steps, {})).toEqual([]);
    expect(newSteps(settingsGuide, steps, { seen: allSeen })).toEqual([]);
    // Half-walked: the steps not reached yet are unseen, not new.
    expect(
      newSteps(settingsGuide, steps, { seen: { "settings.nav": 1, "settings.account": 1 } }),
    ).toEqual([]);
    const oneBehind = { seen: { ...allSeen, "settings.security": 0 } };
    expect(newSteps(settingsGuide, steps, oneBehind).map((step) => step.id)).toEqual(["security"]);
    // Finished: a step never seen was added since, and is new.
    const { "settings.preferences": _added, ...beforeItWasAdded } = allSeen;
    const finished = { seen: beforeItWasAdded, finished: { settings: true as const } };
    expect(newSteps(settingsGuide, steps, finished).map((step) => step.id)).toEqual([
      "preferences",
    ]);
  });

  test("finishing records every step at its current revision, the skipped ones too", () => {
    const walkedPart = {
      seen: { "settings.nav": 1 },
      resume: { guide: "settings", step: "nav", path: "/settings" },
    };
    const done = finishGuide(settingsGuide, settingsGuide.steps)(walkedPart);
    expect(done).toEqual({ seen: allSeen, finished: { settings: true } });
    // So a finished guide has nothing new until a step is added or changed.
    expect(newSteps(settingsGuide, settingsGuide.steps, done)).toEqual([]);
  });

  test("forgetting drops what the guides know and keeps a later build's field", () => {
    const progress: GuideProgress = {
      firstRun: "declined",
      seen: allSeen,
      resume: { guide: "settings", step: "apps", path: "/settings" },
      tutorials: { copyId: "x" },
    };
    expect(forgetProgress({ ...progress, finished: { settings: true } })).toEqual({
      tutorials: { copyId: "x" },
    });
  });

  test("starting guides over forgets their seen steps and a resume point in them, not another guide's", () => {
    const progress: GuideProgress = {
      seen: { ...allSeen, "run.process": 1, "settings-github.steps": 1 },
      resume: { guide: "settings", step: "apps", path: "/settings" },
      finished: { settings: true, run: true, "settings-github": true },
    };
    expect(restartGuides(["settings", "run"])(progress)).toEqual({
      seen: { "settings-github.steps": 1 },
      finished: { "settings-github": true },
    });
    const elsewhere = {
      ...progress,
      resume: { guide: "notes", step: "list", path: "/notes" },
    };
    expect(restartGuides(["settings", "run"])(elsewhere).resume).toEqual(elsewhere.resume);
  });
});

/** The Settings tour's elements, its "What is this?", and the first-run prompt. */
function SettingsPage(): React.JSX.Element {
  return (
    <>
      <GuideButton guideId="settings" />
      <FirstRunPrompt />
      {SETTINGS_ANCHORS.map((name) => (
        <section key={name} {...guideAnchor(name)}>
          {name}
        </section>
      ))}
    </>
  );
}

function renderSettings({ promptReady = true }: { promptReady?: boolean } = {}): void {
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <I18nextProvider i18n={i18n}>
        <GuideProvider promptReady={promptReady}>
          <SettingsPage />
        </GuideProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
}

const steps = en.guides.settings.steps;
const onStep = (id: string) =>
  waitFor(() => expect(screen.getByTestId("guide-card")).toHaveAttribute("data-guide-step", id), {
    timeout: 4000,
  });

describe("walking a guide", () => {
  test("records each step and where to resume; closing keeps the place, finishing clears it", async () => {
    const server = fakeUserSettings();
    renderSettings();
    fireEvent.click(screen.getByTestId("guide-open"));
    await onStep("nav");
    // The card's own button: its handler is bound when the card renders. The keyboard, which
    // listens from an effect, is the card test's subject.
    fireEvent.click(screen.getByTestId("guide-next"));
    await onStep("account");
    await waitFor(() =>
      expect(storedProgress(server)?.resume).toEqual({
        guide: "settings",
        step: "account",
        path: "/settings",
      }),
    );
    expect(storedProgress(server)?.seen).toEqual({ "settings.nav": 1, "settings.account": 1 });

    fireEvent.click(screen.getByTestId("guide-close"));
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    expect(storedProgress(server)?.resume?.step).toBe("account");

    // Walk it to the end: nothing is left to resume.
    fireEvent.click(screen.getByTestId("guide-open"));
    // "What is this?" always starts a tour from its first step; resuming is the menu's.
    for (const step of settingsGuide.steps) {
      await onStep(step.id);
      fireEvent.click(
        screen.getByTestId(step === settingsGuide.steps.at(-1) ? "guide-finish" : "guide-next"),
      );
    }
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    await waitFor(() => expect(storedProgress(server)?.resume).toBeUndefined());
    expect(storedProgress(server)?.seen).toEqual(allSeen);
    expect(storedProgress(server)?.finished).toEqual({ settings: true });
  });

  test('a changed step puts a dot on "What is this?", which runs only it and then offers the whole tour', async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: { seen: { ...allSeen, "settings.security": 0 } } });
    renderSettings();
    const button = screen.getByTestId("guide-open");
    await waitFor(() => expect(button).toHaveAttribute("data-new-steps", "1"));
    expect(screen.getByTestId("guide-new-dot")).toBeInTheDocument();

    fireEvent.click(button);
    const card = await screen.findByRole(
      "dialog",
      { name: steps.security.title },
      { timeout: 4000 },
    );
    // One step, so it is also the last: Finish, and the way to the whole tour.
    expect(card).toHaveTextContent("1/1");
    fireEvent.click(screen.getByTestId("guide-whole-tour"));
    expect(
      await screen.findByRole("dialog", { name: steps.nav.title }, { timeout: 4000 }),
    ).toHaveTextContent(`1/${settingsGuide.steps.length}`);
    // Seeing the changed step cleared the dot.
    await waitFor(() => expect(button).not.toHaveAttribute("data-new-steps"));
  });

  test("finishing a run of only the changed steps finishes nothing and keeps the place to resume", async () => {
    const resume = { guide: "settings", step: "account", path: "/settings" };
    const server = fakeUserSettings({
      [GUIDE_PROGRESS_KEY]: { seen: { "settings.nav": 0, "settings.account": 1 }, resume },
    });
    renderSettings();
    const button = screen.getByTestId("guide-open");
    await waitFor(() => expect(button).toHaveAttribute("data-new-steps", "1"));
    fireEvent.click(button);
    await onStep("nav");
    fireEvent.click(screen.getByTestId("guide-finish"));
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    await waitFor(() => expect(storedProgress(server)?.seen?.["settings.nav"]).toBe(1));
    expect(storedProgress(server)?.finished).toBeUndefined();
    expect(storedProgress(server)?.resume).toEqual(resume);
    expect(Object.keys(storedProgress(server)?.seen ?? {})).toEqual([
      "settings.nav",
      "settings.account",
    ]);
  });

  test("the whole tour opened from a run of its changed first step makes that step the place to resume", async () => {
    const server = fakeUserSettings({
      [GUIDE_PROGRESS_KEY]: { seen: { "settings.nav": 0, "settings.account": 1 } },
    });
    renderSettings();
    const button = screen.getByTestId("guide-open");
    await waitFor(() => expect(button).toHaveAttribute("data-new-steps", "1"));
    fireEvent.click(button);
    await onStep("nav");
    fireEvent.click(screen.getByTestId("guide-whole-tour"));
    // The same first step, now in the whole tour.
    await waitFor(() =>
      expect(screen.getByTestId("guide-card")).toHaveTextContent(`1/${settingsGuide.steps.length}`),
    );
    await waitFor(() =>
      expect(storedProgress(server)?.resume).toEqual({
        guide: "settings",
        step: "nav",
        path: "/settings",
      }),
    );
    fireEvent.click(screen.getByTestId("guide-close"));
    await waitFor(() => expect(screen.queryByTestId("guide-card")).toBeNull());
    expect(storedProgress(server)?.resume?.step).toBe("nav");
  });

  test('a reader who never walked a guide gets a plain "What is this?"', async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    renderSettings();
    // Give the progress time to load, then look: there must be no dot.
    await waitFor(() => expect(apiClient.getUserSettings).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.getByTestId("guide-open")).not.toHaveAttribute("data-new-steps");
    expect(screen.queryByTestId("guide-new-dot")).toBeNull();
  });
});

describe("the first-run prompt", () => {
  test("waits while the layout is not ready, even for a reader who never answered", async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    renderSettings({ promptReady: false });
    await waitFor(() => expect(apiClient.getUserSettings).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();
  });

  test('"No thanks" is kept on the server; an answered reader is not asked', async () => {
    const server = fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    renderSettings();
    fireEvent.click(await screen.findByTestId("first-run-decline"));
    await waitFor(() => expect(screen.queryByTestId("first-run-prompt")).toBeNull());
    await waitFor(() => expect(storedProgress(server)?.firstRun).toBe("declined"));

    cleanup();
    resetGuideProgress();
    renderSettings();
    await waitFor(() => expect(apiClient.getUserSettings).toHaveBeenCalledTimes(3));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();
  });

  test("a reader with any guide progress is not asked, even without an answer on record", async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: { seen: { "settings.nav": 1 } } });
    renderSettings();
    await waitFor(() => expect(apiClient.getUserSettings).toHaveBeenCalled());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();
  });

  test('"Later" holds for this browser session only, and stores nothing', async () => {
    const server = fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    renderSettings();
    fireEvent.click(await screen.findByTestId("first-run-later"));
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();
    expect(storedProgress(server)?.firstRun).toBeUndefined();

    // The same session, on another page load: still later.
    cleanup();
    renderSettings();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();

    // A new session asks again.
    cleanup();
    forgetFirstRunLater();
    renderSettings();
    expect(await screen.findByTestId("first-run-prompt")).toBeVisible();
  });

  test('"Show me around" records the answer and opens the guides menu', async () => {
    const server = fakeUserSettings({ [GUIDE_PROGRESS_KEY]: {} });
    let menuOpen = false;
    function MenuProbe(): null {
      // Read through the same context the sidebar menu uses.
      const { menuOpen: open } = useGuides();
      menuOpen = open;
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <I18nextProvider i18n={i18n}>
          <GuideProvider>
            <FirstRunPrompt />
            <MenuProbe />
          </GuideProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("first-run-accept"));
    await waitFor(() => expect(storedProgress(server)?.firstRun).toBe("accepted"));
    expect(menuOpen).toBe(true);
    expect(screen.queryByTestId("first-run-prompt")).toBeNull();
  });
});

describe("the guides menu away from a tour's page", () => {
  const flowGuide = guideById("flow")!;
  /** The owner walked the flow tour: every step for everyone, and the owner's own edit step. */
  const ownerSteps = visibleSteps(flowGuide, true);
  const path = "/workflows/moira/quick-task";
  /** The progress a real walk leaves: each step recorded as shown, up to `upTo`, by the owner. */
  const ownerWalk = (upTo: string): GuideProgress => {
    let progress: GuideProgress = {};
    for (const step of ownerSteps) {
      progress = recordStep("flow", step, path)(progress);
      if (step.id === upTo) break;
    }
    return progress;
  };
  const ownerFinished = finishGuide(flowGuide, ownerSteps)(ownerWalk("explore"));
  const readerCount = ownerSteps.length;

  test("finishing marks only the reader's own role's steps, so the other role's changes are not theirs", () => {
    expect(ownerFinished.seen).not.toHaveProperty("flow.edit-reader");
    const bump = (id: string) => ({
      ...flowGuide,
      steps: flowGuide.steps.map((step) =>
        step.id === id ? { ...step, revision: step.revision + 1 } : step,
      ),
    });
    // The reader's (non-owner's) step changes: nothing new for the owner.
    const readerStepRaised = bump("edit-reader");
    expect(
      newSteps(readerStepRaised, stepsForReader(readerStepRaised, ownerFinished), ownerFinished),
    ).toEqual([]);
    // The owner's own step changes: that one is new.
    const ownerStepRaised = bump("edit");
    expect(
      newSteps(ownerStepRaised, stepsForReader(ownerStepRaised, ownerFinished), ownerFinished).map(
        (step) => step.id,
      ),
    ).toEqual(["edit"]);
  });

  function renderMenu(): void {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <I18nextProvider i18n={i18n}>
          <SidebarProvider>
            <GuideProvider>
              <ShowMeAround />
            </GuideProvider>
          </SidebarProvider>
        </I18nextProvider>
      </MemoryRouter>,
    );
  }

  const flowStatus = () =>
    screen.getByTestId("show-me-around-screens").querySelector('[data-guide-id="flow"]');

  test("an owner who finished the flow tour sees it as seen", async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: ownerFinished });
    renderMenu();
    await waitFor(() =>
      expect(screen.getByTestId("show-me-around")).toHaveAttribute("data-progress", "loaded"),
    );
    fireEvent.click(screen.getByTestId("show-me-around"));
    await waitFor(() => expect(flowStatus()).toHaveAttribute("data-status", "seen"));
  });

  test("a changed owner-only step counts as new, and the resume line counts the steps this reader sees", async () => {
    fakeUserSettings({
      // Walked to "explore", having seen the edit step at an earlier revision.
      [GUIDE_PROGRESS_KEY]: (() => {
        const walked = ownerWalk("explore");
        return { ...walked, seen: { ...walked.seen, "flow.edit": 0 } };
      })(),
    });
    renderMenu();
    await waitFor(() =>
      expect(screen.getByTestId("show-me-around")).toHaveAttribute("data-progress", "loaded"),
    );
    fireEvent.click(screen.getByTestId("show-me-around"));
    await waitFor(() => expect(flowStatus()).toHaveAttribute("data-status", "new"));
    expect(screen.getByTestId("show-me-around-resume")).toHaveTextContent(`of ${readerCount}`);
  });

  test("a reader who has been both owner and reader has the resume line counted in the role they stopped in", async () => {
    // They finished the tour on their own flow, then walked it as a reader of someone else's flow
    // up to its last step: both roles' edit steps are seen.
    const readerSteps = visibleSteps(flowGuide, false);
    let progress = ownerFinished;
    for (const step of readerSteps) {
      progress = recordStep("flow", step, "/workflows/someone/their-flow", true, { owner: false })(
        progress,
      );
    }
    expect(progress.seen).toHaveProperty(["flow.edit"]);
    expect(progress.seen).toHaveProperty(["flow.edit-reader"]);
    expect(progress.resume).toMatchObject({ step: "explore", owner: false });
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: progress });
    renderMenu();
    await waitFor(() =>
      expect(screen.getByTestId("show-me-around")).toHaveAttribute("data-progress", "loaded"),
    );
    fireEvent.click(screen.getByTestId("show-me-around"));
    expect(await screen.findByTestId("show-me-around-resume")).toHaveTextContent(
      `step ${readerSteps.length} of ${readerSteps.length}`,
    );
  });

  test("before either role's step is seen, the resume line counts the reader as the page does", async () => {
    fakeUserSettings({ [GUIDE_PROGRESS_KEY]: ownerWalk("loop") });
    renderMenu();
    await waitFor(() =>
      expect(screen.getByTestId("show-me-around")).toHaveAttribute("data-progress", "loaded"),
    );
    fireEvent.click(screen.getByTestId("show-me-around"));
    // Walked to "loop"; numbered over the steps a reader is shown.
    const readerSteps = visibleSteps(flowGuide, false);
    const loop = readerSteps.findIndex((step) => step.id === "loop") + 1;
    expect(await screen.findByTestId("show-me-around-resume")).toHaveTextContent(
      `step ${loop} of ${readerSteps.length}`,
    );
  });
});
