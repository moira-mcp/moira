/**
 * The layout presets of the process diagrams. Both the map and the technical graph carry the same
 * four buttons in their toolbar, both re-lay themselves when one is chosen, and both follow one
 * stored choice — so a reader who prefers the compact rows or the vertical column meets that
 * layout on either view and after a reload, instead of setting it again per diagram.
 *
 * "Re-laid" is measured as the extent of the laid-out diagram (its width and height in diagram
 * coordinates, with the camera divided out), because a preset that only moved the camera would
 * leave that number alone.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { GRAPH, MAP, graphExtent, settledCamera } from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();
const PRESETS = ["default", "compact", "flow", "vertical"] as const;

/** The map publishes the size of the layout it drew, which is exactly the extent under test. */
function mapExtent(page: Page): Promise<string | null> {
  return page.getByTestId("canvas-view").getAttribute("data-canvas-size");
}

test("the map's presets re-lay it, and the vertical one turns the row of blocks into a column", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.locator(`${MAP} [data-block-id="deliver"]`)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("layout-preset-buttons")).toBeVisible();
  await expect(page.locator("[data-layout-preset]")).toHaveCount(PRESETS.length);

  const sizeOf = (extent: string) => extent.split("x").map(Number);
  const extents: Record<string, string> = {};
  for (const preset of PRESETS) {
    await page.locator(`[data-layout-preset="${preset}"]`).click();
    // The chosen preset is the marked one, and the map is laid out again under it.
    await expect(page.locator(`[data-layout-preset="${preset}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(page.locator("[data-layout-preset][data-active]")).toHaveCount(1);
    // The previous layout stays drawn until the new one is ready: the extent is read once the map
    // has settled under the chosen preset, not while it still shows the last one.
    await settledCamera(page, MAP);
    extents[preset] = (await mapExtent(page))!;
    await expect(page.locator(`${MAP} [data-block-id]`)).toHaveCount(7);
  }

  // The compact preset draws the same blocks in less room; a preset that changed nothing would
  // report the default's extent here.
  const [defaultWidth, defaultHeight] = sizeOf(extents.default);
  const [compactWidth, compactHeight] = sizeOf(extents.compact);
  expect(extents.compact).not.toBe(extents.default);
  expect(compactWidth * compactHeight).toBeLessThan(defaultWidth * defaultHeight);
  // The default layout reads left to right; the vertical one is the same process transposed.
  expect(defaultWidth).toBeGreaterThan(defaultHeight);
  const [verticalWidth, verticalHeight] = sizeOf(extents.vertical);
  expect(verticalHeight).toBeGreaterThan(verticalWidth);
});

test("the graph's presets re-lay it, each one to a layout of its own", async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator('[data-graph-node="end"]')).toBeVisible({ timeout: 20000 });
  await settledCamera(page, GRAPH);
  const cards = await page.locator("[data-graph-node]").count();

  const extents: string[] = [];
  for (const preset of PRESETS) {
    await page.locator(`[data-layout-preset="${preset}"]`).click();
    await expect(page.locator(`[data-layout-preset="${preset}"]`)).toHaveAttribute(
      "data-active",
      "true",
    );
    // The layout is asynchronous; the extent is read once it has settled on a new value.
    await expect
      .poll(() => graphExtent(page), { timeout: 15000 })
      .not.toBe(extents[extents.length - 1]);
    extents.push(await graphExtent(page));
    // Every step is still drawn: a preset re-lays the graph, it does not drop cards from it.
    await expect(page.locator("[data-graph-node]")).toHaveCount(cards);
  }
  // Four presets, four different shapes — stacked groups, the same tighter, groups in a row and
  // the steps top to bottom.
  expect(new Set(extents).size).toBe(PRESETS.length);
});

test("the preset is one choice for both views and it survives a reload", async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.locator(`${MAP} [data-block-id="scope"]`)).toBeVisible({ timeout: 15000 });
  await page.locator('[data-layout-preset="vertical"]').click();
  // Read once the map has settled under the new preset: until then it still draws the default.
  await settledCamera(page, MAP);
  const asColumn = (await mapExtent(page))!;

  // The preset's hint stays open under the pointer but cannot intercept the Graph tab.
  const hintWrapper = page.locator("[data-radix-popper-content-wrapper]:has([data-hint-layer])");
  await expect(hintWrapper).toBeVisible();
  await expect(hintWrapper).toHaveCSS("pointer-events", "none");
  // The graph opens under the same preset, marked in its own toolbar.
  await page.getByTestId("flow-modes").locator('[data-mode="graph"]').click();
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("graph-toolbar")).toBeVisible();
  await expect(
    page.getByTestId("graph-toolbar").locator('[data-layout-preset="vertical"]'),
  ).toHaveAttribute("data-active", "true");

  // And a reload of the map keeps it: the choice is the reader's, not the page's.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.locator(`${MAP} [data-block-id="scope"]`)).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-layout-preset="vertical"]')).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect.poll(() => mapExtent(page), { timeout: 10000 }).toBe(asColumn);
});

test("changing the preset keeps the selected block in view", async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=deliver`);
  await expect(page.locator(`${MAP} [data-block-id="deliver"]`)).toBeVisible({ timeout: 15000 });
  await settledCamera(page, MAP);

  /** True while the camera holds the selected block: its card's middle is inside the diagram. */
  const selectedInView = async () => {
    const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
    const card = await page.locator(`${MAP} [data-block-id="deliver"]`).boundingBox();
    if (!card) return false;
    const middle = { x: card.x + card.width / 2, y: card.y + card.height / 2 };
    return (
      middle.x >= diagram.x &&
      middle.y >= diagram.y &&
      middle.x <= diagram.x + diagram.width &&
      middle.y <= diagram.y + diagram.height
    );
  };

  await expect.poll(selectedInView, { timeout: 10000 }).toBe(true);
  // A re-layout moves every block; the camera follows the reader's block rather than staying on
  // coordinates that now hold a different one.
  await page.locator('[data-layout-preset="vertical"]').click();
  await expect.poll(selectedInView, { timeout: 15000 }).toBe(true);
  await page.locator('[data-layout-preset="compact"]').click();
  await expect.poll(selectedInView, { timeout: 15000 }).toBe(true);
});
