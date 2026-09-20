/**
 * Diagram gestures on a freshly loaded flow page (Quick Task), in both of its views — the map and
 * the technical graph: the view opens fitted (a transform is set), a plain wheel over the diagram
 * pans it — the translation changes while the scale stays what fit-to-view set — a ctrl-wheel
 * (what a trackpad pinch produces in Chromium) zooms it, and a wheel over the side panel leaves
 * the diagram untouched.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

interface Transform {
  scale: number;
  x: number;
  y: number;
}

/** The diagram's viewport; scoped, since a page may hold more than one React Flow instance. */
function viewportOf(page: Page, diagram: string) {
  return page.locator(`${diagram} .react-flow__viewport`);
}

/** The viewport's computed transform: `matrix(a, b, c, d, tx, ty)` with a = d = scale. */
async function viewportTransform(page: Page, diagram: string): Promise<Transform> {
  const raw = await viewportOf(page, diagram).evaluate(
    (el) => window.getComputedStyle(el).transform,
  );
  const match = /^matrix\(([^)]+)\)$/.exec(raw);
  expect(raw, "the viewport has been fitted").toMatch(/^matrix\(/);
  const [a, , , , tx, ty] = match![1].split(",").map((part) => Number(part.trim()));
  return { scale: a, x: tx, y: ty };
}

async function pointInside(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = (await page.locator(selector).first().boundingBox())!;
  expect(box, `${selector} is laid out`).toBeTruthy();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// `minScale` is the readable floor the opening fit must respect (the map never opens below three
// quarters; the technical graph may shrink to fit); `first` is the card of the first block, which
// must be inside the diagram's box at rest.
const MODES = [
  {
    mode: "map",
    diagram: '[data-testid="canvas-view"]',
    panel: '[data-testid="flow-panel"]',
    minScale: 0.75,
    first: '.react-flow__node[data-id="scope"]',
  },
  {
    mode: "graph",
    diagram: ".react-flow",
    // The graph no longer carries a node sidebar of its own: the page's right panel stands
    // beside it, and a wheel over that panel must leave the diagram alone just the same.
    panel: '[data-testid="flow-panel"]',
    minScale: 0.1,
    first: null,
  },
] as const;

for (const { mode, diagram, panel, minScale, first } of MODES) {
  test(`${mode}: a plain wheel pans, a ctrl-wheel zooms, a wheel over the panel leaves it alone`, async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${mode}`);
    await expect(viewportOf(page, diagram)).toBeVisible({ timeout: 15000 });
    // React Flow mounts the viewport at the identity transform and fits it once the nodes are
    // measured; the readings below start from the fitted state.
    await expect
      .poll(() => viewportOf(page, diagram).evaluate((el) => window.getComputedStyle(el).transform))
      .not.toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    const fitted = await viewportTransform(page, diagram);
    // The opening fit is readable and starts at the first block: a fit that shrank the picture to
    // make everything visible, or one centred on the middle of the process, fails here.
    expect(fitted.scale).toBeGreaterThanOrEqual(minScale);
    if (first) {
      const box = await page.locator(diagram).boundingBox();
      const card = await page.locator(first).boundingBox();
      expect(box && card).toBeTruthy();
      expect(card!.x).toBeGreaterThanOrEqual(box!.x);
      expect(card!.y).toBeGreaterThanOrEqual(box!.y);
      expect(card!.x + card!.width).toBeLessThanOrEqual(box!.x + box!.width);
      expect(card!.y + card!.height).toBeLessThanOrEqual(box!.y + box!.height);
    }

    // A plain wheel (two-finger scroll) pans: the translation moves, the scale is untouched.
    const over = await pointInside(page, diagram);
    await page.mouse.move(over.x, over.y);
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await viewportTransform(page, diagram)).y).not.toBe(fitted.y);
    const panned = await viewportTransform(page, diagram);
    expect(panned.scale).toBe(fitted.scale);

    // A ctrl-wheel (a trackpad pinch in Chromium) zooms: the scale changes.
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await expect
      .poll(async () => (await viewportTransform(page, diagram)).scale)
      .not.toBe(panned.scale);

    // Page scroll outside the diagram: a wheel over the side panel does not move the diagram.
    const settled = await viewportTransform(page, diagram);
    const beside = await pointInside(page, panel);
    await page.mouse.move(beside.x, beside.y);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    expect(await viewportTransform(page, diagram)).toEqual(settled);
  });
}
