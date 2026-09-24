/**
 * "Explain this page" as a reader meets it, and the same interface in Russian.
 *
 * The walkthrough is only worth anything if every step it shows actually highlights something.
 * After the redesign its anchors name the contents rows, the block panel's steps, a card's return
 * port, the run's route cursor and the diagram toolbar — elements that are now drawn beside the
 * graph as well as the map — so each spec here walks the whole sequence to the end and asserts
 * the ring landed on a rendered element at every step, on the run page in both views and on the
 * flow page.
 *
 * The last test is the check no unit test can make: the running interface in Russian, on the run
 * page (both views and the node level) and on the flow page. Toolbar buttons, layout presets,
 * panel sections, accessible labels and hints are read back and matched against the English
 * words they used to be hard-coded with — a fallback anywhere in that chain shows up as English
 * text in a Russian page.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { quickTaskWithRepairLoop } from "./helpers/quick-task.js";
import { GRAPH, graphOverview, settledCamera } from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

/** The step ids each page's walkthrough runs through, in order. */
const RUN_STEPS = ["process", "agent", "evidence", "loop", "route", "explore"];
const FLOW_STEPS = ["intro", "steps", "process", "agent", "evidence", "loop", "edit", "explore"];

/**
 * Runs in the page: for an element inside a React Flow node, whether its box lies within the
 * diagram pane that draws it; for any other element, true.
 */
function insideItsPane(element: Element): boolean {
  const node = element.closest(".react-flow__node");
  if (!node) return true;
  const pane = node.closest(".react-flow");
  if (!pane) return false;
  const box = element.getBoundingClientRect();
  const frame = pane.getBoundingClientRect();
  return (
    box.left >= frame.left &&
    box.right <= frame.right &&
    box.top >= frame.top &&
    box.bottom <= frame.bottom
  );
}

/**
 * Walk the open walkthrough to its end, asserting that each step both announces itself and puts
 * its ring on an element the page has rendered. `data-guide-target` is written onto the anchored
 * element itself, so finding it visible is the proof that the anchor resolved.
 */
async function walkThrough(page: Page, steps: readonly string[]): Promise<void> {
  for (const [index, id] of steps.entries()) {
    await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", id);
    const target = page.locator(`[data-guide-target="${id}"]`);
    await expect(target).toBeVisible({ timeout: 15000 });
    // Rendered is not enough: the page scrolls to the anchor and the diagram moves its camera to
    // an anchored card, so the ring must sit inside the browser viewport at every step — and an
    // anchor drawn inside a diagram must sit inside the diagram's own pane, since a card that the
    // camera left behind is still "in the viewport" under the sidebar or the panel.
    await expect(target).toBeInViewport({ ratio: 0.5, timeout: 15000 });
    await expect.poll(() => target.evaluate(insideItsPane), { timeout: 15000 }).toBe(true);
    if (index < steps.length - 1) await page.getByTestId("walkthrough-next").click();
  }
  await page.getByTestId("walkthrough-finish").click();
  await expect(page.getByTestId("walkthrough")).toHaveCount(0);
}

// One test per view: each walks the whole sequence on a run of its own, and both walks in one
// test would not fit the per-test budget on a CI runner.
for (const view of ["map", "graph"] as const) {
  test(`the run page's walkthrough highlights a rendered element at every step, in the ${view} view`, async ({
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
      await expect(page).toHaveURL(/guide=1/);
      await walkThrough(page, RUN_STEPS);
      // No step took the reader out of the view they opened: every anchor exists on both.
      await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", view);
    } finally {
      await authenticated.cleanup();
    }
  });
}

test("the flow page's walkthrough highlights a rendered element at every step, in both views", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1600, height: 1000 });

  for (const view of ["map", "graph"] as const) {
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${view}&guide=1`);
    await expect(page.getByTestId("flow-page")).toBeVisible({ timeout: 20000 });
    await walkThrough(page, FLOW_STEPS);
    await expect(page.getByTestId("flow-page")).toHaveAttribute("data-view", view);
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
        "[data-testid^='panel-section-'] > button, [data-testid^='node-panel-'] > button",
      ),
    ))
      words.push(section.textContent ?? "");
    return words.filter(Boolean);
  });
}

test("the interface in Russian shows no English fallback in the toolbar, presets, sections or hints", async ({
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
