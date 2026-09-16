/**
 * The technical graph as the detailed layer of the process view: on the flow page's graph mode
 * every workflow node is a step card inside a block group, the groups follow process order, a
 * derived cycle edge is not drawn at rest but named by a connection chip in its source card and
 * an arrival chip in its target, appears dashed with its label while either chip is hovered and
 * brings the far card into view when the arrival chip is clicked, the layout controls and the
 * sidebar keep working, and the run page's graph view groups by the run's blocks with the current
 * node marked.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test("the flow page's graph mode draws step cards in block groups with on-demand return labels", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const detail = (
    (await (await page.request.get(`${BASE_URL}/api/workflows/moira/quick-task`)).json()) as {
      data: {
        fileInfo: { id: string };
        workflow: { nodes: Array<{ id: string; connections?: Record<string, string> }> };
      };
    }
  ).data;
  const workflow = detail.workflow;
  const process = (
    (await (
      await page.request.get(`${BASE_URL}/api/workflows/${detail.fileInfo.id}/process`)
    ).json()) as {
      process: {
        blocks: Array<{ id: string; transitions: Array<{ cycle?: unknown; edges: string[] }> }>;
      };
    }
  ).process;
  const cycleEdges = new Set(
    process.blocks.flatMap((b) => b.transitions.filter((t) => t.cycle).flatMap((t) => t.edges)),
  );
  expect(cycleEdges.size).toBeGreaterThan(0);

  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  // Every node is a step card; every block is a group in process order.
  await expect(page.locator(".react-flow__node [data-step-card]")).toHaveCount(
    workflow.nodes.length,
  );
  const groups = page.locator("[data-graph-group]");
  await expect(groups).toHaveCount(process.blocks.length);
  const groupIds = await groups.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-block-id")),
  );
  expect(groupIds).toEqual(process.blocks.map((b) => b.id));
  const tops = await groups.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  for (let i = 1; i < tops.length; i += 1) expect(tops[i]).toBeGreaterThan(tops[i - 1]);
  // The definition opens readable on its first block, not on the whole-graph overview: the zoom
  // is at least the opening zoom and the first group's header is inside the graph's box.
  const zoomOf = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate((el) => new DOMMatrix(window.getComputedStyle(el).transform).a);
  await expect.poll(zoomOf, { timeout: 5000 }).toBeGreaterThanOrEqual(0.7);
  const graphBox = (await page.locator(".react-flow").boundingBox())!;
  const firstHeader = (await groups.first().locator("p").boundingBox())!;
  expect(firstHeader.x).toBeGreaterThanOrEqual(graphBox.x);
  expect(firstHeader.y).toBeGreaterThanOrEqual(graphBox.y);
  expect(firstHeader.x + firstHeader.width).toBeLessThanOrEqual(graphBox.x + graphBox.width);
  // Edges paint above the group surfaces and below the cards.
  // The stacking level of an element is that of its nearest ancestor with a z-index inside the
  // viewport (edges are grouped in an svg per level).
  const zIndexOf = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (node.classList.contains("react-flow__viewport")) break;
          const z = window.getComputedStyle(node).zIndex;
          if (z !== "auto") return Number(z);
        }
        return Number.NaN;
      });
  const groupZ = await zIndexOf(".react-flow__node-block-group");
  const edgeZ = await zIndexOf(".react-flow__edge");
  const cardZ = await zIndexOf(".react-flow__node:not(.react-flow__node-block-group)");
  expect(groupZ).toBeLessThan(edgeZ);
  // At the cards' level the edge layer paints first, so equal is below.
  expect(edgeZ).toBeLessThanOrEqual(cardZ);
  // A return is not drawn at rest: a long line through a corridor cannot be told from its
  // neighbours, so it is named in both cards instead — a connection chip in its source and an
  // arrival chip in its target — and drawn only while one of them is hovered.
  await expect(page.locator('.react-flow__edge [data-edge-kind="return"]')).toHaveCount(0);
  await expect(page.locator('[data-edge-label="return"]')).toHaveCount(0);
  const [first] = [...cycleEdges];
  const [sourceId, ...labelParts] = first.split(".");
  const label = labelParts.join(".");
  const targetId = (
    workflow.nodes.find((n) => n.id === sourceId)!.connections as Record<string, string>
  )[label];
  await expect(
    page.locator(`[data-graph-node="${sourceId}"] [data-connection="${label}"]`),
  ).toHaveCount(1);
  await expect(
    page.locator(`[data-graph-node="${targetId}"] [data-arrival="${first}"]`),
  ).toHaveCount(1);
  // The definition opens on its first block; the fit-view control gives the overview back, and
  // hovering either chip draws the return with its label and lights it.
  await page.getByTestId("graph-fit-view").click();
  const chip = page.locator(`[data-graph-node="${sourceId}"] [data-connection="${label}"]`);
  await chip.hover();
  await expect(page.locator(`[data-edge-label="return"][data-transition="${first}"]`)).toHaveCount(
    1,
  );
  await expect(page.locator(`[data-transition="${first}"][data-focused="true"]`)).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-edge-label="return"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge [data-edge-kind="return"]')).toHaveCount(0);
  // The arrival chip in the target card draws the same return.
  await page.locator(`[data-graph-node="${targetId}"] [data-arrival="${first}"]`).hover();
  await expect(page.locator(`[data-transition="${first}"][data-focused="true"]`)).toHaveCount(1);
  await page.mouse.move(0, 0);
  // Clicking that chip takes the view to the card at the other end: the reader follows the
  // connection without a line to trace. The overview is the starting point, where every card is
  // already inside the box, so what the click must change is the view itself — it closes on that
  // one card, which shows as a zoom no overview has and as that card at the centre.
  const offCentre = async (id: string) => {
    const box = (await page.locator(".react-flow").boundingBox())!;
    const card = await page.locator(`[data-graph-node="${id}"]`).boundingBox();
    if (!card) return Number.POSITIVE_INFINITY;
    return Math.hypot(
      card.x + card.width / 2 - (box.x + box.width / 2),
      card.y + card.height / 2 - (box.y + box.height / 2),
    );
  };
  await page.getByTestId("graph-fit-view").click();
  await expect.poll(zoomOf, { timeout: 5000 }).toBeLessThan(0.9);
  const centredBefore = await offCentre(sourceId);
  await page.locator(`[data-graph-node="${targetId}"] [data-arrival="${first}"]`).click();
  await expect.poll(zoomOf, { timeout: 5000 }).toBeGreaterThan(0.9);
  expect(await offCentre(sourceId)).toBeLessThan(Math.min(centredBefore / 2, 80));
  // Forward edges inside a block keep their label.
  await expect(page.locator('[data-edge-label="forward"]').first()).toBeVisible();
  // Controls and the sidebar keep working.
  await page.getByTestId("graph-layout-horizontal").click();
  await expect(page.locator(".react-flow__node [data-step-card]").first()).toBeVisible();
  await page.getByTestId("graph-layout-vertical").click();
  await page.getByTestId("graph-fit-view").click();
  await page.locator(`[data-graph-node="${sourceId}"]`).click();
  await expect(page.getByTestId("workflow-sidebar")).toContainText(sourceId);
});

test("the graph lays cards out from their measured heights: no two cards overlap on the SDF", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const nodeCount = (
    (await (
      await page.request.get(`${BASE_URL}/api/workflows/moira/software-development-flow`)
    ).json()) as { data: { workflow: { nodes: unknown[] } } }
  ).data.workflow.nodes.length;
  await page.goto(`${BASE_URL}/workflows/moira/software-development-flow?view=graph`);
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  const cards = page.locator(".react-flow__node [data-step-card]");
  await expect(cards).toHaveCount(nodeCount);
  // The layout estimates card heights, then runs again with the measured ones; a card whose
  // summary or chips wrap more than estimated would otherwise sit on its lower neighbour.
  const overlaps = () =>
    cards.evaluateAll((els) => {
      const boxes = els.map((el) => el.getBoundingClientRect());
      const pairs: string[] = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          if (
            a.left < b.right - 1 &&
            b.left < a.right - 1 &&
            a.top < b.bottom - 1 &&
            b.top < a.bottom - 1
          ) {
            pairs.push(
              `${els[i].closest("[data-graph-node]")?.getAttribute("data-graph-node")}/${els[j].closest("[data-graph-node]")?.getAttribute("data-graph-node")}`,
            );
          }
        }
      }
      return pairs;
    });
  await expect.poll(overlaps, { timeout: 10000 }).toEqual([]);
});

test("the run page's graph view groups by the run's blocks and marks the current node", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The graph is a view of the run page, deep-linkable like the map.
    await page.goto(`${BASE_URL}/executions/${run.processId}?view=graph`);
    const section = page.getByTestId("execution-progress");
    await expect(section).toHaveAttribute("data-view", "graph");
    // Opened on the graph, the graph is the only diagram on the page; a view mounts when first
    // shown and then stays mounted, so a switch keeps its state.
    await expect(section.locator(".react-flow")).toHaveCount(1);
    await expect(section.locator(".react-flow").last()).toBeVisible({ timeout: 15000 });
    await expect(section.locator("[data-graph-group]").first()).toBeVisible();
    // The block the run is at carries the active status surface; the current step is marked.
    await expect(section.locator('[data-graph-group][data-block-id="scope"]')).toHaveClass(
      /ring-primary|border-primary|border-warning/,
    );
    await expect(
      section.locator('.react-flow__node [data-step-card][aria-current="step"]'),
    ).toHaveCount(1);
  } finally {
    await authenticated.cleanup();
  }
});
