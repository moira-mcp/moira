/**
 * The controls of a process diagram, which now live in one toolbar above it instead of the old
 * floating React Flow cluster: the view modes, the step finder folded into a button, the layout
 * presets, zoom out, zoom in, fit-to-view and the navigator switch — the same row on the map and
 * on the technical graph.
 *
 * What is asserted here is that each control does its job (the zoom buttons change the camera's
 * scale, fit gives the overview back, the navigator appears and disappears with its button, the
 * finder opens and selects what it finds) and that the old cluster is gone. Which layout each
 * preset produces is `diagram-presets.spec.ts`; travelling along a link is
 * `diagram-interaction.spec.ts`.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { GRAPH, MAP, settledCamera } from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

/** The camera's scale: `matrix(a, …)` with a the zoom React Flow applied. */
async function scaleOf(page: Page, diagram: string): Promise<number> {
  return page
    .locator(`${diagram} .react-flow__viewport`)
    .first()
    .evaluate((el) => new DOMMatrix(window.getComputedStyle(el).transform).a);
}

const VIEWS = [
  {
    view: "map",
    toolbar: "map-toolbar",
    diagram: MAP,
    ready: `${MAP} [data-block-id="deliver"]`,
    finder: "map-node-finder",
  },
  {
    view: "graph",
    toolbar: "graph-toolbar",
    diagram: GRAPH,
    ready: '[data-graph-node="end"]',
    finder: "graph-node-finder",
  },
] as const;

for (const { view, toolbar, diagram, ready, finder } of VIEWS) {
  test(`the ${view}'s toolbar zooms, fits and folds the navigator away`, async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${view}`);
    await expect(page.locator(ready)).toBeVisible({ timeout: 20000 });
    const strip = page.getByTestId(toolbar);
    await expect(strip).toHaveAttribute("role", "toolbar");
    // One toolbar holds every control the diagram has; the floating cluster is gone.
    await expect(page.locator(".react-flow__controls")).toHaveCount(0);
    for (const control of [
      "toolbar-finder",
      "layout-preset-buttons",
      "toolbar-zoom-out",
      "toolbar-zoom-in",
      "toolbar-fit",
      "toolbar-minimap",
    ]) {
      await expect(strip.getByTestId(control)).toBeVisible();
    }

    await settledCamera(page, diagram);
    const fitted = await scaleOf(page, diagram);
    // Zoom in, then out: the camera's scale moves each way, from the toolbar alone.
    await strip.getByTestId("toolbar-zoom-in").click();
    await expect.poll(() => scaleOf(page, diagram), { timeout: 5000 }).toBeGreaterThan(fitted);
    const zoomedIn = await scaleOf(page, diagram);
    await strip.getByTestId("toolbar-zoom-out").click();
    await expect.poll(() => scaleOf(page, diagram), { timeout: 5000 }).toBeLessThan(zoomedIn);

    // Fit gives the overview back after zooming deep into one corner. What "the overview" is
    // differs by diagram: the technical graph shrinks until every card fits, while the map keeps
    // its readable floor and anchors the overview at the first block instead of shrinking the
    // cards past legibility.
    for (let step = 0; step < 4; step += 1) await strip.getByTestId("toolbar-zoom-in").click();
    await strip.getByTestId("toolbar-fit").click();
    const firstCardInside = async () => {
      const box = (await page.locator(diagram).boundingBox())!;
      const card = await page.locator(`${MAP} [data-block-id="scope"]`).boundingBox();
      if (!card) return false;
      return (
        card.x >= box.x - 1 &&
        card.y >= box.y - 1 &&
        card.x + card.width <= box.x + box.width + 1 &&
        card.y + card.height <= box.y + box.height + 1
      );
    };
    const cardsOutside = async () => {
      const box = (await page.locator(diagram).boundingBox())!;
      return page.locator("[data-graph-node]").evaluateAll(
        (cards, frame) =>
          cards.filter((card) => {
            const at = card.getBoundingClientRect();
            return (
              at.right < frame.x ||
              at.bottom < frame.y ||
              at.left > frame.x + frame.width ||
              at.top > frame.y + frame.height
            );
          }).length,
        box,
      );
    };
    if (view === "map") {
      await expect.poll(firstCardInside, { timeout: 10000 }).toBe(true);
      expect(await scaleOf(page, diagram)).toBeGreaterThanOrEqual(0.75);
    } else {
      await expect.poll(cardsOutside, { timeout: 10000 }).toBe(0);
    }

    // The navigator is the reader's choice and it is remembered: it opens folded (unfolded it
    // would cover the diagram's corner and the cards under it), switched on it appears, and it
    // is still on after a reload; switched off it leaves the diagram again.
    await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
    await expect(strip.getByTestId("toolbar-minimap")).not.toHaveAttribute("aria-pressed", "true");
    await strip.getByTestId("toolbar-minimap").click();
    await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
    await expect(strip.getByTestId("toolbar-minimap")).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator(ready)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".react-flow__minimap")).toHaveCount(1);
    await page.getByTestId(toolbar).getByTestId("toolbar-minimap").click();
    await expect(page.locator(".react-flow__minimap")).toHaveCount(0);
    await expect(page.getByTestId(toolbar).getByTestId("toolbar-minimap")).not.toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test(`the ${view}'s finder is folded away until it is asked for, and then it finds a step`, async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${view}`);
    await expect(page.locator(ready)).toBeVisible({ timeout: 20000 });
    const strip = page.getByTestId(toolbar);
    // Folded: the field costs nothing until the reader wants it.
    await expect(strip.getByTestId("toolbar-finder-field")).toHaveCount(0);
    await strip.getByTestId("toolbar-finder").click();
    await expect(strip.getByTestId("toolbar-finder-field")).toBeVisible();

    // "Which block is this step in" — the finder answers by name and selects what it finds.
    await page.getByTestId(finder).fill("fix-issues");
    await expect(page.locator('[data-node-match="fix-issues"]')).toBeVisible();
    await page.locator('[data-node-match="fix-issues"]').click();
    if (view === "map") {
      // On the map the finder selects the block that owns the step.
      await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "verify");
    } else {
      // On the graph it brings the step's own card into view and marks it.
      await expect(page.locator('[data-graph-node="fix-issues"]')).toBeVisible();
      await expect(
        page.locator('.react-flow__node.selected [data-graph-node="fix-issues"]'),
      ).toHaveCount(1);
    }
  });
}
