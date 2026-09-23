/**
 * Helpers shared by the specs that read the process diagrams — the map on the run and flow pages
 * and the technical graph beside it. They exist because every one of those specs needs the same
 * three facts about a diagram: what its camera is set to, which cards the reader has just been
 * taken to, and where on screen an edge's line actually runs.
 */

import { expect, type Page } from "../fixtures.js";

/** The map's diagram inside whichever page mounts it. */
export const MAP = '[data-testid="canvas-view"]';
/** The technical graph and its contents sidebar. */
export const GRAPH = '[data-testid="graph-view"]';

/**
 * The computed transform of a diagram's viewport — the camera. React Flow writes the pan and the
 * zoom into this one matrix, so comparing the string is how a test says "the camera moved" or
 * "the camera was left where it was".
 */
export function cameraOf(page: Page, diagram: string): Promise<string> {
  return page
    .locator(`${diagram} .react-flow__viewport`)
    .first()
    .evaluate((el) => window.getComputedStyle(el).transform);
}

/**
 * The camera once the diagram has finished opening: its layout is final and the opening placement
 * has arrived, which the diagram publishes as `data-diagram-settled`. A camera read earlier can be
 * the fit that precedes the placement, or the placement of a layout about to be redone with the
 * card heights the browser measured — and on a slow machine the reader's (or the test's) next
 * action lands before the camera moves again.
 */
export async function settledCamera(page: Page, diagram: string): Promise<string> {
  await expect(page.locator(`${diagram} .react-flow`).first()).toHaveAttribute(
    "data-diagram-settled",
    "true",
    { timeout: 15000 },
  );
  return cameraOf(page, diagram);
}

/**
 * The camera once it has stopped moving. A fit is animated, so a reading taken while it runs is
 * stale: a spec that measures where an edge is drawn, or that wants a real "before", waits here
 * for two identical readings in a row.
 */
export async function restingCamera(page: Page, diagram: string): Promise<string> {
  let last = await settledCamera(page, diagram);
  await expect
    .poll(
      async () => {
        const now = await cameraOf(page, diagram);
        const rested = now === last;
        last = now;
        return rested;
      },
      { timeout: 10000 },
    )
    .toBe(true);
  return last;
}

/**
 * The whole technical graph on screen, for a spec that clicks a card the opening placement may
 * have left outside the pane: the graph opens readable on its first block (a run's, on its current
 * step), so a card further along lies past the pane's edge and only a click taken before that
 * placement arrives — on a fast machine — would reach it. The overview is taken once the opening
 * placement has arrived, so no placement moves the camera again under the click.
 */
export async function graphOverview(page: Page): Promise<void> {
  // The technical graph wherever a page mounts it — beside the contents on a page with a process
  // view, alone on one without — is the diagram drawn under the graph's own toolbar.
  const graph = '[data-testid="graph-toolbar"] ~ div';
  await settledCamera(page, graph);
  await page.getByTestId("graph-toolbar").getByTestId("toolbar-fit").click();
  await restingCamera(page, graph);
}

/**
 * The cards currently playing the arrival animation: `card-arrive` is the ring a card wears for
 * about two seconds after the reader is taken to it, which is how a travel is told from a jump
 * that landed nowhere.
 */
export function arrivedCards(page: Page, attribute: "data-block-id" | "data-graph-node") {
  return page
    .locator(`[${attribute}]`)
    .evaluateAll(
      (cards, name) =>
        cards
          .filter((card) => card.className.includes("card-arrive"))
          .map((card) => card.getAttribute(name as string)!),
      attribute,
    );
}

/** The block groups on the graph playing the arrival pulse (a group is a frame, not a card). */
export function pulsingGroups(page: Page) {
  return page
    .locator("[data-graph-group]")
    .evaluateAll((groups) =>
      groups
        .filter((group) => group.className.includes("animate-pulse"))
        .map((group) => group.getAttribute("data-block-id")!),
    );
}

/**
 * A point on an edge's drawn line that can actually be clicked, in page coordinates, with the
 * transition the edge carries. An edge's bounding box is mostly empty for an elbow or a lane, so
 * clicking its centre would miss the stroke; this walks the path itself and, since a stretch of a
 * line can be off-screen or run under a card, returns the sample nearest the middle whose topmost
 * element is still this edge.
 */
export async function edgePoint(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number; transition: string }> {
  const point = await page
    .locator(selector)
    .first()
    .evaluate((group) => {
      const path = group.querySelector("path.react-flow__edge-path") as SVGPathElement;
      const total = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      // The middle first, then outwards along the line in both directions.
      for (let step = 0; step <= 18; step += 1) {
        const fraction = 0.5 + (step % 2 ? -1 : 1) * Math.ceil(step / 2) * 0.05;
        if (fraction <= 0.05 || fraction >= 0.95) continue;
        const at = path.getPointAtLength(total * fraction);
        const screen = new DOMPoint(at.x, at.y).matrixTransform(matrix);
        const topmost = document.elementFromPoint(screen.x, screen.y);
        if (topmost && group.contains(topmost)) {
          return {
            x: screen.x,
            y: screen.y,
            transition: group.getAttribute("data-transition")!,
          };
        }
      }
      throw new Error(
        `No point of ${group.getAttribute("data-transition")} is both in view and on top`,
      );
    });
  return point;
}

/**
 * Open a folded section of a side panel. The panel remembers folds per reader, and the sections
 * that hold lists (steps, the route) open folded, so a spec that reads their content unfolds them
 * first and says so.
 */
export async function openPanelSection(page: Page, testId: string): Promise<void> {
  const section = page.getByTestId(testId);
  await expect(section).toBeVisible();
  if ((await section.getAttribute("data-folded")) === "true") {
    await section.getByRole("button").first().click();
  }
  await expect(section).not.toHaveAttribute("data-folded", "true");
}

/** Nothing on the page may say "the whole page is being rebuilt". */
export async function expectNoLoaders(page: Page): Promise<void> {
  await expect(page.getByTestId("page-loader")).toHaveCount(0);
  await expect(page.getByTestId("diagram-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("canvas-loading")).toHaveCount(0);
  await expect(page.getByText(/Laying out the process|Раскладываю процесс/)).toHaveCount(0);
}

/** Every block card the map currently draws, with its box in page coordinates. */
export function mapCardBoxes(page: Page) {
  return page.locator(`${MAP} [data-block-id]`).evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      return {
        id: card.getAttribute("data-block-id")!,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    }),
  );
}

/**
 * The extent of the laid-out technical graph in diagram coordinates: the width and height the
 * cards span once the camera's transform is divided out, so a re-layout is visible as a number
 * even though the camera moves with it.
 */
export function graphExtent(page: Page): Promise<string> {
  return page.locator("[data-graph-node]").evaluateAll((cards) => {
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement;
    const camera = new DOMMatrix(window.getComputedStyle(viewport).transform);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      xs.push((box.x - camera.e) / camera.a, (box.x + box.width - camera.e) / camera.a);
      ys.push((box.y - camera.f) / camera.d, (box.y + box.height - camera.f) / camera.d);
    }
    return `${Math.round(Math.max(...xs) - Math.min(...xs))}x${Math.round(Math.max(...ys) - Math.min(...ys))}`;
  });
}

/**
 * The card nearest the centre of a diagram's pane — which card the camera actually landed on, as
 * opposed to which card the page merely marked as selected. A focus fits one card into view, so
 * the card at the centre is the one the reader was taken to.
 */
export function centredCard(
  page: Page,
  diagram: string,
  attribute: "data-block-id" | "data-graph-node",
): Promise<string | null> {
  return page
    .locator(`${diagram} .react-flow`)
    .first()
    .evaluate((pane, name) => {
      const view = pane.getBoundingClientRect();
      const cx = view.x + view.width / 2;
      const cy = view.y + view.height / 2;
      let nearest: string | null = null;
      let best = Infinity;
      for (const card of Array.from(pane.querySelectorAll(`[${name}]`))) {
        const box = card.getBoundingClientRect();
        const distance = Math.hypot(box.x + box.width / 2 - cx, box.y + box.height / 2 - cy);
        if (distance < best) {
          best = distance;
          nearest = card.getAttribute(name);
        }
      }
      return nearest;
    }, attribute);
}
