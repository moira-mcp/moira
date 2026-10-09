/**
 * The guides as a reader meets them, on their real routes.
 *
 * A guide is only worth anything if every step it shows lands on something. Each spec opens a
 * screen tour with its page's "What is this?" (or a task tour with its own button), walks it to
 * the end, and asserts at every step that the element the card names is rendered, lies in the
 * browser viewport and — inside a diagram — in the diagram's own pane, since a card the camera left
 * behind is still "in the viewport" under the sidebar or the panel. The walks run on the run page in
 * both views, the flow page for a reader and for its owner, and the Settings tours. A phone-width
 * pass shows the card as a bottom sheet and a desktop-only step skipped with a note.
 *
 * The last test is the check no unit test can make: the running interface in Russian, on the run
 * page (both views and the node level) and on the flow page. Toolbar buttons, layout presets,
 * panel sections, accessible labels and hints are read back and matched against the English words
 * they used to be hard-coded with — a fallback anywhere in that chain shows up as English text in a
 * Russian page.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { quickTaskWithRepairLoop } from "./helpers/quick-task.js";
import { GRAPH, graphOverview, settledCamera } from "./helpers/diagram.js";
import { expectGuideStep, freshReader } from "./helpers/guides.js";

const BASE_URL = getTestBaseUrl();

/** The step ids each guide runs through, in order, for the reader who opens it. */
const RUN_STEPS = [
  "process",
  "modes",
  "agent",
  "evidence",
  "loop",
  "route",
  "panel-tabs",
  "answer",
  "notifications",
  "explore",
];
// Bundled Quick Task is tagged complexity:complex; it names no playbook, so that step is skipped.
const FLOW_SHARED_START = [
  "intro",
  "facts",
  "level",
  "modes",
  "steps",
  "diagram-note",
  "process",
  "agent",
  "evidence",
  "loop",
  "panel-tabs",
];
// A reader of the public Quick Task can copy it and learns that the owner edits.
const FLOW_READER_STEPS = [...FLOW_SHARED_START, "template", "edit-reader", "explore"];
// The owner of a private copy sets who sees it and edits it.
const FLOW_OWNER_STEPS = [...FLOW_SHARED_START, "visibility", "edit", "explore"];
const SETTINGS_STEPS = [
  "nav",
  "account",
  "security",
  "notifications",
  "github",
  "local-devices",
  "apps",
  "tokens",
  "preferences",
];

/**
 * Walk the open guide to its end, asserting that each step names itself and that the element its
 * card points at is rendered where the reader can see it.
 */
async function walk(page: Page, guideId: string, steps: readonly string[]): Promise<void> {
  const card = page.getByTestId("guide-card");
  for (const [index, id] of steps.entries()) {
    await expectGuideStep(page, guideId, id);
    if (index < steps.length - 1) await page.getByTestId("guide-next").click();
  }
  await page.getByTestId("guide-finish").click();
  await expect(card).toHaveCount(0);
}

// One test per view: each walks the whole sequence on a run of its own, and both walks in one
// test would not fit the per-test budget on a CI runner.
for (const view of ["map", "graph"] as const) {
  test(`the run page's tour lands on a rendered element at every step, in the ${view} view`, async ({
    page,
  }) => {
    const authenticated = await createAuthenticatedMCPClient();
    const run = await quickTaskWithRepairLoop(authenticated.client);
    try {
      await loginAsAdmin(page);
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(`${BASE_URL}/executions/${run.processId}?view=${view}`);
      await expect(page.getByTestId("execution-progress")).toBeVisible({ timeout: 20000 });
      await page.getByTestId("guide-open").click();
      await expect(page).toHaveURL(/guide=run/);
      await walk(page, "run", RUN_STEPS);
      // No step took the reader out of the view they opened: every anchor exists on both.
      await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", view);
    } finally {
      await authenticated.cleanup();
    }
  });
}

// One test per view, as for the run page: both walks of the whole tour in one test would not fit
// the per-test budget on a slow runner.
for (const view of ["map", "graph"] as const) {
  test(`the flow page's tour lands on a rendered element at every step for a reader, in the ${view} view`, async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${view}`);
    await expect(page.getByTestId("flow-page")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("guide-open").click();
    // A reader is told the owner edits and how to get a copy, not pointed at a switch they lack.
    await walk(page, "flow", FLOW_READER_STEPS);
    await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", view);
  });
}

/** A private copy of the bundled Quick Task, owned by the signed-in admin; removed afterwards. */
async function withOwnCopy(page: Page, run: (id: string) => Promise<void>): Promise<void> {
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("flow-page")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /Use as Template/ }).click();
  await page.waitForURL(/\/workflows\/[0-9a-f-]{36}/, { timeout: 20000 });
  const id = /\/workflows\/([0-9a-f-]{36})/.exec(page.url())![1];
  try {
    await run(id);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`, {
      headers: { Origin: new URL(BASE_URL).origin },
    });
  }
}

test("the flow page's tour shows its owner the edit switch", async ({ page }) => {
  // A reader's completed shared steps must not turn the owner's walk into an updates-only tour.
  await freshReader(page, "flow-owner");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await withOwnCopy(page, async () => {
    await expect(page.getByTestId("flow-edit-toggle")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("guide-open").click();
    await walk(page, "flow", FLOW_OWNER_STEPS);
  });
});

for (const [guideId, opener, steps] of [
  ["settings", "guide-open", SETTINGS_STEPS],
  [
    "settings-github",
    "github-guide-open",
    ["steps", "connect", "codespaces", "limits", "autopause"],
  ],
  ["settings-telegram", "telegram-guide-open", ["bot", "chat", "enable", "test"]],
] as const) {
  test(`the Settings guide ${guideId} lands on a rendered element at every step`, async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${BASE_URL}/settings`);
    await expect(page.getByTestId("settings-section-profile")).toBeVisible({ timeout: 20000 });
    if (guideId === "settings-github") {
      await page.getByTestId("settings-nav-development").click();
      await page.getByRole("tab", { name: "GitHub connection", exact: true }).click();
    } else if (guideId === "settings-telegram") {
      await page.getByTestId("settings-nav-notifications").click();
    }
    await page.getByTestId(opener).click();
    await walk(page, guideId, steps);
  });
}

for (const language of ["en", "ru"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 600 },
  ]) {
    test(`long Settings guide text remains readable with reachable navigation (${language}, ${viewport.name})`, async ({
      page,
    }) => {
      await freshReader(page, `long-guide-${language}-${viewport.name}`);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${BASE_URL}/settings?lang=${language}&guide=settings&step=local-devices`);
      const card = page.getByTestId("guide-card");
      await expect(card).toHaveAttribute("data-guide-step", "local-devices");
      await expect(card).toBeInViewport({ ratio: 1 });
      const next = page.getByTestId("guide-next");
      const close = page.getByTestId("guide-close");
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(close).toBeInViewport({ ratio: 1 });

      // Reading to the end of the explanation scrolls only its text, not the actions.
      const text = page.getByTestId("guide-text-scroll");
      await expect(text).toBeVisible();
      await text.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect
        .poll(() =>
          text.evaluate((element) =>
            Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect(next).toBeInViewport({ ratio: 1 });
      await expect(close).toBeInViewport({ ratio: 1 });
      await next.click();
      await expect(card).toHaveAttribute("data-guide-step", "apps");
    });
  }
}

test("the flow page's tour explains the level badge of a flow built at a level", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await (
    await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { Origin: new URL(BASE_URL).origin },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: `Leveled ${Date.now()}`,
            version: "1.0.0",
            description: "A flow built at the standard level.",
            tags: ["reports", "complexity:standard"],
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    })
  ).json();
  const id = created.data.workflowId as string;
  try {
    await page.goto(`${BASE_URL}/workflows/${id}?guide=flow&step=facts`);
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "facts", { timeout: 20000 });
    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "level");
    await expect(page.getByTestId("guide-spotlight")).toHaveAttribute(
      "data-guide-anchor",
      "flow.level",
    );
    await expect(page.locator('[data-guide~="flow.level"]:visible')).toHaveText("Standard");
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`, {
      headers: { Origin: new URL(BASE_URL).origin },
    });
  }
});

test("on a phone the card is a bottom sheet, and a desktop-only step is skipped with a note", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await withOwnCopy(page, async (id) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/workflows/${id}?view=steps&guide=flow&step=panel-tabs`);
    const card = page.getByTestId("guide-card");
    await expect(card).toBeVisible({ timeout: 20000 });
    // The sheet spans the screen along an edge: the bottom, or the top when the element is under
    // the bottom (the panel's tabs sit low on a phone).
    await expect(card).toHaveAttribute("data-guide-dock", /^(bottom|top)$/);
    // Revealing the target can change the sheet's edge. Read its edge and geometry in one
    // browser sample, then wait for the layout and entrance motion to satisfy both bounds.
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const dock = element.getAttribute("data-guide-dock");
          const box = element.getBoundingClientRect();
          const gap = dock === "top" ? box.top : window.innerHeight - box.bottom;
          return (dock === "top" || dock === "bottom") && box.width >= 385 && Math.abs(gap) <= 4;
        }),
      )
      .toBe(true);
    // The visibility controls and the edit switch are drawn only on a wide screen: the owner's two
    // steps after the panel's tabs are skipped with a note — and never shown on the way, where
    // they could take a click.
    await page.evaluate(() => {
      const shown: string[] = [];
      (window as unknown as { guideStepsShown: string[] }).guideStepsShown = shown;
      new MutationObserver(() => {
        const step = document
          .querySelector('[data-testid="guide-card"]')
          ?.getAttribute("data-guide-step");
        if (step && shown[shown.length - 1] !== step) shown.push(step);
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "explore");
    await expect(page.getByTestId("guide-note")).toContainText("2 steps were skipped");
    await expect(page.getByTestId("guide-note")).toContainText("wider screen");
    const shown = await page.evaluate(
      () => (window as unknown as { guideStepsShown: string[] }).guideStepsShown,
    );
    expect(shown).not.toContain("edit");
    expect(shown).not.toContain("visibility");
    expect(shown[shown.length - 1]).toBe("explore");
  });
});

/** How much of the card's element (its first visible match) lies under the card, in pixels. */
async function coveredByCard(page: Page): Promise<number> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="guide-card"]')!;
    const name = card.dataset.guideAnchor!;
    const element = [...document.querySelectorAll<HTMLElement>(`[data-guide~="${name}"]`)].find(
      (candidate) => candidate.getBoundingClientRect().height > 0,
    )!;
    const a = element.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
  });
}

test("on a phone the sheet leaves the explained element in sight", async ({ page }) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await quickTaskWithRepairLoop(authenticated.client);
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of [
      `${BASE_URL}/executions/${run.processId}?view=map&guide=run&step=evidence`,
      `${BASE_URL}/workflows/moira/quick-task?view=map&guide=flow&step=agent`,
    ]) {
      await page.goto(url);
      const card = page.getByTestId("guide-card");
      await expect(card).toBeVisible({ timeout: 20000 });
      await expect(card).toHaveAttribute("data-guide-dock", /^(bottom|top)$/);
      await expect(page.getByTestId("guide-spotlight")).toBeVisible({ timeout: 20000 });
      await expect.poll(() => coveredByCard(page), { timeout: 10000 }).toBe(0);
    }
  } finally {
    await authenticated.cleanup();
  }
});

/** The controls of the open diagram toolbar that are cut off at its edge, as "testid or label". */
async function clippedToolbarControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const toolbar = document
      .querySelector<HTMLElement>('[data-testid="guide-open"]')!
      .closest('[role="toolbar"]')!;
    const frame = toolbar.getBoundingClientRect();
    return [...toolbar.querySelectorAll<HTMLElement>("button")]
      .filter((button) => {
        const box = button.getBoundingClientRect();
        if (box.width === 0) return false;
        return (
          box.right > frame.right + 0.5 ||
          box.left < frame.left - 0.5 ||
          button.scrollWidth > button.clientWidth + 1
        );
      })
      .map((button) => button.dataset.testid ?? button.textContent ?? "?");
  });
}

test("at a laptop width the diagram toolbars keep every control, the guide button whole", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await quickTaskWithRepairLoop(authenticated.client);
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const url of [
      `${BASE_URL}/executions/${run.processId}?view=map`,
      `${BASE_URL}/executions/${run.processId}?view=graph`,
      `${BASE_URL}/workflows/moira/quick-task?view=map`,
      `${BASE_URL}/workflows/moira/quick-task?view=graph`,
    ]) {
      await page.goto(url);
      await expect(page.getByTestId("guide-open")).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId("guide-open")).toHaveText("What is this?");
      expect(await clippedToolbarControls(page), url).toEqual([]);
    }
  } finally {
    await authenticated.cleanup();
  }
});

/** The English words these surfaces would show if a key were missing or a literal left behind. */
const ENGLISH_LEAKS = [
  "Zoom in",
  "Zoom out",
  "Fit the whole diagram",
  "Navigator",
  "Find a step",
  "How to read this diagram",
  "Top to bottom",
  "Stacked groups",
  "Groups in a row",
  "Steps top to bottom",
  "Directive",
  "Completion condition",
  "Returns",
  "Connections",
  "Show on the graph",
  "Collapse the panel",
  "Status legend",
  "breadcrumb",
  "visits",
  "What is this?",
];

/**
 * Every word the open page writes itself: hints, accessible labels and the header row of each
 * panel section. Section *bodies* are deliberately left out — they carry the workflow's own text
 * and the field names of a node type's schema, which are data in whatever language the author
 * used, not interface copy this unit translates.
 */
async function interfaceWords(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const words: string[] = [];
    for (const element of Array.from(document.querySelectorAll("[data-hint], [aria-label]"))) {
      words.push(element.getAttribute("data-hint") ?? "", element.getAttribute("aria-label") ?? "");
    }
    for (const section of Array.from(
      document.querySelectorAll(
        "[data-testid^='panel-section-'] > button, [data-testid^='node-panel-'] > button, [data-testid='guide-open']",
      ),
    ))
      words.push(section.textContent ?? "");
    return words.filter(Boolean);
  });
}

test("the interface in Russian shows no English fallback in the toolbar, presets, sections, hints or guides", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await quickTaskWithRepairLoop(authenticated.client);
  try {
    await inRussian(page, run.processId);
  } finally {
    await authenticated.cleanup();
  }
});

/** The words the page writes itself, filtered to the English phrases a missing key would show. */
async function englishLeaks(page: Page): Promise<string[]> {
  const words = await interfaceWords(page);
  expect(words.length).toBeGreaterThan(20);
  return ENGLISH_LEAKS.filter((word) =>
    words.some((text) => text.toLowerCase().includes(word.toLowerCase())),
  );
}

async function inRussian(page: Page, processId: string): Promise<void> {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The run page's own chrome: the legend, the block panel's run sections, the route line, and
  // the node level's accessible label on the graph.
  await page.goto(`${BASE_URL}/executions/${processId}?lang=ru&view=map`);
  await expect(page.getByTestId("execution-progress")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("legend-open")).toHaveAttribute("aria-label", "Легенда статусов");
  await expect(page.getByTestId("panel-section-timings")).toContainText("Время");
  await expect(page.getByTestId("panel-section-route")).toContainText("Что здесь происходило");
  await expect(page.getByTestId("run-panel-collapse")).toHaveAttribute(
    "aria-label",
    "Свернуть панель",
  );
  await expect(page.getByTestId("route-summary")).toContainText("визитов");
  // The panel's tab strip holds the five Russian labels on one row at 1600 px: a wrapped strip
  // would put "Блокировки" on a second row over the panel's content.
  const tabTops = await page
    .getByTestId("run-panel-tabs")
    .getByRole("tab")
    .evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().top)));
  expect(tabTops).toHaveLength(5);
  expect(new Set(tabTops).size).toBe(1);
  // The run page's tour speaks Russian too.
  await expect(page.getByTestId("guide-open")).toContainText("Что это?");
  await page.getByTestId("guide-open").click();
  await expect(page.getByTestId("guide-card")).toContainText("Это процесс");
  await page.getByTestId("guide-close").click();
  expect(await englishLeaks(page)).toEqual([]);

  await page.goto(`${BASE_URL}/executions/${processId}?lang=ru&view=graph`);
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  // The run's graph opens on its current step; it is clicked where the camera settles.
  await settledCamera(page, GRAPH);
  await page.locator('[data-graph-node="plan-review"]').click();
  await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "plan-review");
  await expect(page.getByTestId("node-panel-breadcrumb")).toHaveAttribute(
    "aria-label",
    "Путь к шагу",
  );
  expect(await englishLeaks(page)).toEqual([]);

  // The flow page: the toolbar, the presets of both views and the node level of the panel.

  // `?lang=ru` is the querystring the app's language detector reads first, ahead of storage.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?lang=ru&block=plan`);
  await expect(page.getByTestId("flow-page")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("map-toolbar")).toBeVisible();
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan");

  // The Russian words these controls must be showing instead.
  await expect(page.getByTestId("toolbar-zoom-in")).toHaveAttribute("aria-label", "Приблизить");
  await expect(page.getByTestId("toolbar-fit")).toHaveAttribute(
    "aria-label",
    "Показать схему целиком",
  );
  await expect(page.getByTestId("diagram-guide-toggle")).toHaveAttribute(
    "aria-label",
    "Как читать эту схему",
  );
  await expect(page.locator('[data-layout-preset="default"]').first()).toHaveAttribute(
    "aria-label",
    "Рядами",
  );

  // The graph names its own presets, and its step cards their own facts.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?lang=ru&view=graph`);
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('[data-layout-preset="default"]').first()).toHaveAttribute(
    "aria-label",
    "Группы стопкой",
  );
  await expect(page.getByTestId("toolbar-minimap")).toHaveAttribute("aria-label", "Навигатор");

  // The node level of the panel, where the section titles used to be bare English words. The
  // definition's graph opens on its first block, far from `final-review`.
  await graphOverview(page);
  await page.locator('[data-graph-node="final-review"]').click();
  const nodePanel = page.getByTestId("node-panel");
  await expect(nodePanel).toHaveAttribute("data-node-id", "final-review");
  await expect(page.getByTestId("node-panel-directive")).toContainText("Директива");
  await expect(page.getByTestId("node-panel-connections")).toContainText("Связи");
  await expect(page.getByTestId("node-panel-focus")).toContainText("Показать на графе");

  expect(await englishLeaks(page)).toEqual([]);
}

test("the editor tour is offered on the first switch into edit mode only, and each step lands on its control", async ({
  page,
}) => {
  await freshReader(page, "editor");
  const copied = await page.request.post(
    `${BASE_URL}/api/workflows/moira/example-simple-steps/copy`,
    {
      data: { newName: `Editor tour ${Date.now()}` },
    },
  );
  expect(copied.status()).toBe(200);
  const id = ((await copied.json()) as { data: { workflowId: string } }).data.workflowId;
  try {
    await page.goto(`${BASE_URL}/workflows/${id}?view=map`);
    const toggle = page.getByTestId("flow-edit-toggle");
    await toggle.click();
    await expect(page.getByTestId("editor-tour-offer")).toBeVisible();
    await page.getByTestId("editor-tour-accept").click();
    await walk(page, "flow-editor", [
      "bar",
      "add-step",
      "step-actions",
      "blocks",
      "connections",
      "choice",
      "validation",
      "stale",
    ]);

    // The second switch, and a switch after a reload, offer nothing.
    await toggle.click();
    await expect(page.getByTestId("flow-edit-panel")).toHaveCount(0);
    await toggle.click();
    await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
    await expect(page.getByTestId("editor-tour-offer")).toHaveCount(0);
    await page.goto(`${BASE_URL}/workflows/${id}?view=map`);
    await toggle.click();
    await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
    await expect(page.getByTestId("editor-tour-offer")).toHaveCount(0);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});
