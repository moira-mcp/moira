/**
 * The interaction contract the map and the technical graph now share: a transition is something
 * the reader can follow, not only something drawn.
 *
 * Clicking a port on a card — or the edge's own line, on the map as much as on the graph — takes
 * the camera to the far end of that transition, flashes the line travelled and pulses the card
 * arrived at, so the jump answers "where did that land" instead of asking it. The steps chip on a
 * block card opens the block's steps as rows, and a row opens that step on the graph with its node
 * panel, landing the camera and the pulse on that step rather than on its block's first one. The
 * contents sidebar stands beside the graph as well as beside the map, and a row there moves the
 * camera to the block's group and pulses it. Every hint on the page — including the delegated ones that
 * replaced native `title` attributes — is drawn on the application's own popover surface, so no
 * white browser bubble appears in the dark theme. And only the view being read is mounted: one
 * diagram, one toolbar, one set of arrowheads in the document.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import {
  GRAPH,
  MAP,
  arrivedCards,
  cameraOf,
  centredCard,
  edgePoint,
  graphExtent,
  pulsingGroups,
  restingCamera,
  settledCamera,
} from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

/** A Quick Task run of this test's own, so nothing depends on what else is in the database. */
async function seedRun(page: Page) {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  return { processId: run.processId, cleanup: authenticated.cleanup };
}

test("on the map a port and the edge itself both travel to the far block, flashing the link and pulsing the card", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.locator(`${MAP} [data-block-id="deliver"]`)).toBeVisible({ timeout: 15000 });
  const before = await settledCamera(page, MAP);

  // The first block's outgoing port names the transition and the block it reaches.
  const port = page.locator(`${MAP} [data-block-id="scope"] [data-port="out"]`).first();
  const transition = await port.getAttribute("data-transition");
  const peer = await port.getAttribute("data-peer");
  expect(peer).toBe("plan");
  await port.click();

  // The camera travels, the line travelled is the focused one, and the block arrived at pulses.
  await expect.poll(() => cameraOf(page, MAP), { timeout: 5000 }).not.toBe(before);
  await expect(page.locator(`[data-transition="${transition}"][data-focused="true"]`)).toHaveCount(
    1,
  );
  await expect.poll(() => arrivedCards(page, "data-block-id"), { timeout: 5000 }).toEqual(["plan"]);
  // The pulse is a moment, not a state: it clears itself so the map does not keep flashing.
  await expect.poll(() => arrivedCards(page, "data-block-id"), { timeout: 10000 }).toEqual([]);

  // The line itself is the other half of the same contract: a transition drawn on the map is
  // followable by clicking its stroke, not only by clicking the port it leaves from. The panel is
  // folded away first and the overview retaken, because the map's fit stops at three quarters and
  // pans rather than shrinking, so on a narrow pane the line between two cards is off-screen.
  await page.getByTestId("flow-panel-collapse").click();
  await expect(page.getByTestId("flow-panel")).toHaveAttribute("data-collapsed", "true");
  await page.getByTestId("toolbar-fit").click();
  // The overview is animated: the line's coordinates are read once the camera has come to rest,
  // and `edgePoint` picks the part of the stroke that is in view and not under a card.
  const beforeEdge = await restingCamera(page, MAP);
  const line = await edgePoint(page, `${MAP} [data-edge-kind][data-transition="${transition}"]`);
  await page.mouse.click(line.x, line.y);
  await expect.poll(() => cameraOf(page, MAP), { timeout: 5000 }).not.toBe(beforeEdge);
  await expect(
    page.locator(`[data-transition="${line.transition}"][data-focused="true"]`),
  ).toHaveCount(1);
  await expect.poll(() => arrivedCards(page, "data-block-id"), { timeout: 5000 }).toEqual([peer]);
});

test("on the graph a port and the edge itself both travel to the step at the far end", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator('[data-graph-node="get-task"]')).toBeVisible({ timeout: 20000 });
  await settledCamera(page, GRAPH);

  // A port: its `data-peer` is the step the reader is taken to.
  const port = page.locator('[data-graph-node="get-task"] [data-port="out"]').first();
  const peer = await port.getAttribute("data-peer");
  const transition = await port.getAttribute("data-transition");
  expect(peer).toBe("create-plan");
  const beforePort = await cameraOf(page, GRAPH);
  await port.click();
  await expect.poll(() => cameraOf(page, GRAPH), { timeout: 5000 }).not.toBe(beforePort);
  await expect(page.locator(`[data-transition="${transition}"][data-focused="true"]`)).toHaveCount(
    1,
  );
  await expect
    .poll(() => arrivedCards(page, "data-graph-node"), { timeout: 5000 })
    .toEqual(["create-plan"]);
  await expect.poll(() => arrivedCards(page, "data-graph-node"), { timeout: 10000 }).toEqual([]);

  // The edge's own line: clicked on the stroke, it travels the same way. The overview is taken
  // first so the whole graph is reachable and the click is not on a line already centred.
  await page.getByTestId("toolbar-fit").click();
  const beforeEdge = await restingCamera(page, GRAPH);
  const start = await edgePoint(
    page,
    '[data-edge-kind="forward"][data-transition="start.default"]',
  );
  await page.mouse.click(start.x, start.y);
  await expect.poll(() => cameraOf(page, GRAPH), { timeout: 5000 }).not.toBe(beforeEdge);
  await expect(
    page.locator(`[data-transition="${start.transition}"][data-focused="true"]`),
  ).toHaveCount(1);
  await expect
    .poll(() => arrivedCards(page, "data-graph-node"), { timeout: 5000 })
    .toEqual(["get-task"]);
});

test("a row of a block card's steps tooltip opens that step on the graph and in the node panel", async ({
  page,
}) => {
  const run = await seedRun(page);
  try {
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    await expect(page.locator(`${MAP} [data-block-id="scope"]`)).toBeVisible({ timeout: 15000 });

    // The steps chip of the first block: hovering it opens the tooltip, whose rows are the
    // block's steps in the order the process runs them.
    const stepsChip = page.locator(`${MAP} [data-block-id="scope"] [data-step-facts] > *`).first();
    await stepsChip.hover();
    const rows = page.locator("[data-step-tip-list] [data-step-row]");
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
    expect(
      await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-step-row"))),
    ).toEqual(["start", "get-task"]);
    // The tooltip is drawn on the application's hint surface, not as a browser title.
    await expect(page.locator('[data-slot="hint"] [data-step-tip-list]')).toHaveCount(1);

    // The tooltip content is a portal: the row is clicked where it is drawn.
    await page.locator('[data-step-tip-list] [data-step-row="get-task"]').click();

    // The page moves to the graph and the panel opens on that step, with the sections the step
    // has: its directive, the evidence it returns and where its outputs lead.
    await expect(page).toHaveURL(/view=graph/);
    await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "graph");
    const panel = page.getByTestId("node-panel");
    await expect(panel).toHaveAttribute("data-node-id", "get-task");
    await expect(page.getByTestId("node-panel-directive")).toBeVisible();
    await expect(page.getByTestId("node-panel-returns")).toBeVisible();
    await expect(page.getByTestId("node-panel-connections")).toBeVisible();
    // The step is on the graph the page switched to, inside its block's group.
    await expect(page.locator('[data-graph-node="get-task"]')).toBeVisible({ timeout: 15000 });
    // The camera and the arrival pulse land on the step the row named, not on the first step of
    // its block: `start` is what a block-level focus would have centred instead.
    await expect
      .poll(() => arrivedCards(page, "data-graph-node"), { timeout: 5000 })
      .toEqual(["get-task"]);
    await expect
      .poll(() => centredCard(page, GRAPH, "data-graph-node"), { timeout: 10000 })
      .toBe("get-task");
    await expect(page.locator('[data-graph-group][data-block-id="scope"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    // The breadcrumb goes back to the block level of the same panel.
    await page.getByTestId("node-panel-back").click();
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "scope");
  } finally {
    await run.cleanup();
  }
});

test("the contents sidebar stands beside the graph and a row takes the camera to that block's group", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  // The same contents as beside the map: one row per block, in process order.
  await expect(page.getByTestId("map-contents")).toBeVisible();
  expect(
    await page
      .locator('[data-testid="map-contents-list"] [data-block-id]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-block-id"))),
  ).toEqual(["scope", "plan", "plan-review", "plan-approval", "execute", "verify", "deliver"]);
  const before = await settledCamera(page, GRAPH);

  // A row far from the opening view: the camera travels to that block's group and the group
  // pulses, so the reader sees which frame the jump landed in.
  await page.getByTestId("map-contents-deliver").click();
  await expect(page).toHaveURL(/block=deliver/);
  await expect.poll(() => cameraOf(page, GRAPH), { timeout: 5000 }).not.toBe(before);
  await expect.poll(() => pulsingGroups(page), { timeout: 5000 }).toEqual(["deliver"]);
  await expect(page.locator('[data-graph-group][data-block-id="deliver"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(page.locator('[data-graph-group][data-selected="true"]')).toHaveCount(1);

  // The sidebar folds away and its fold button lives in the diagram's toolbar.
  await page.getByTestId("map-sidebar-toggle").click();
  await expect(page.getByTestId("map-contents")).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("map-contents")).not.toBeVisible();
});

test("every hint is drawn on the theme's popover surface: no white bubble in the dark theme", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.locator(`${MAP} [data-block-id="scope"]`)).toBeVisible({ timeout: 15000 });
  await expect(page.locator("html")).toHaveClass(/dark/);

  /** The channel values of a rendered colour, whatever notation the browser reports it in. */
  const channels = async (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((el) => {
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.fillStyle = window.getComputedStyle(el).backgroundColor;
      probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    });

  // The delegated layer: a toolbar button carries `data-hint` instead of a native `title`, and
  // the one listener at the root draws it on the popover surface.
  await page.getByTestId("toolbar-fit").hover();
  const delegated = page.locator("[data-hint-layer]");
  await expect(delegated).toBeVisible({ timeout: 5000 });
  await expect(delegated).toHaveAttribute("data-slot", "hint");
  const delegatedColour = await channels(delegated);
  // Dark theme: the surface is dark. A white bubble (the browser's own, or a light popover left
  // hard-coded) would be at the top of every channel.
  expect(Math.max(delegatedColour.r, delegatedColour.g, delegatedColour.b)).toBeLessThan(128);

  // A rich hint — the steps chip's list of rows — is on the same surface.
  await page.mouse.move(0, 0);
  await expect(delegated).toHaveCount(0);
  await page.locator(`${MAP} [data-block-id="scope"] [data-step-facts] > *`).first().hover();
  const rich = page.locator('[data-slot="hint"]').first();
  await expect(rich).toBeVisible({ timeout: 5000 });
  expect(await channels(rich)).toEqual(delegatedColour);
  // Nothing on the page falls back to a native tooltip on the elements the hints replaced.
  await expect(page.locator("[data-hint][title]")).toHaveCount(0);
});

test("only the view being read is mounted: one diagram, one toolbar and one set of arrowheads", async ({
  page,
}) => {
  const run = await seedRun(page);
  try {
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    await expect(page.getByTestId("canvas-view")).toBeVisible({ timeout: 15000 });
    const markerSets = () => page.locator("marker#diagram-arrow").count();

    // The map: its diagram, its toolbar, its markers — and no graph.
    await expect(page.locator(".react-flow")).toHaveCount(1);
    await expect(page.locator('[role="toolbar"]')).toHaveCount(1);
    await expect(page.getByTestId("map-toolbar")).toBeVisible();
    await expect(page.getByTestId("graph-view")).toHaveCount(0);
    await expect(page.locator("[data-graph-node]")).toHaveCount(0);
    expect(await markerSets()).toBe(1);

    // The graph: the map is gone from the document rather than hidden behind it.
    await page.getByTestId("run-modes").locator('[data-mode="graph"]').click();
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("canvas-view")).toHaveCount(0);
    await expect(page.locator(".react-flow")).toHaveCount(1);
    await expect(page.locator('[role="toolbar"]')).toHaveCount(1);
    await expect(page.getByTestId("graph-toolbar")).toBeVisible();
    expect(await markerSets()).toBe(1);
    // The graph really is laid out, not an empty instance kept for the count.
    expect(await graphExtent(page)).toMatch(/^\d+x\d+$/);
  } finally {
    await run.cleanup();
  }
});
