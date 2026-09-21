/**
 * The technical graph as the detailed layer of the process view.
 *
 * On the flow page's graph mode every workflow node is a step card inside a block group, the
 * groups follow process order, and every connection is drawn at rest as an edge of a named kind —
 * forward inside a block, external across blocks, a dashed return where the process loops back.
 * Nothing is labelled on the line any more: the transition is named by the ports on the two cards
 * it joins, one port per connection, so a dense corridor stays readable. Hovering a port lights
 * that one connection and dims the rest, which is how a reader follows a line through a crossing.
 *
 * The graph lays its cards out from the heights the browser measures, so a summary that wraps
 * further than estimated does not put a card on its neighbour — asserted on the Software
 * Development Flow, the densest bundled flow. On a run the same graph groups by the run's blocks
 * and marks the step the run is on.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { GRAPH, restingCamera, settledCamera } from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

test("the flow page's graph draws every node as a card in its block's group, with ported edges", async ({
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
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  // Every node is a step card; every block is a group in process order, stacked top to bottom.
  await expect(page.locator("[data-graph-node]")).toHaveCount(workflow.nodes.length);
  const groups = page.locator("[data-graph-group]");
  await expect(groups).toHaveCount(process.blocks.length);
  expect(
    await groups.evaluateAll((els) => els.map((el) => el.getAttribute("data-block-id"))),
  ).toEqual(process.blocks.map((b) => b.id));
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
  // The header starts inside the box; a group wider than the viewport runs off to the right,
  // which is what panning is for.
  expect(firstHeader.x).toBeGreaterThanOrEqual(graphBox.x);
  expect(firstHeader.y).toBeGreaterThanOrEqual(graphBox.y);
  expect(firstHeader.x).toBeLessThanOrEqual(graphBox.x + graphBox.width);
  expect(firstHeader.y).toBeLessThanOrEqual(graphBox.y + graphBox.height);

  // Edges paint above the group surfaces and below the cards. The stacking level of an element is
  // that of its nearest ancestor with a z-index inside the viewport (edges are grouped per level).
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

  // Every connection is drawn at rest and named by the ports of the two cards it joins — no
  // label floats on the line, and a return is a dashed edge rather than a pair of chips.
  await expect(page.locator("[data-edge-label]")).toHaveCount(0);
  const [returnLink] = [...cycleEdges];
  const [sourceId, ...labelParts] = returnLink.split(".");
  const label = labelParts.join(".");
  const targetId = (
    workflow.nodes.find((n) => n.id === sourceId)!.connections as Record<string, string>
  )[label];
  await expect(
    page.locator(`[data-edge-kind="return"][data-transition="${returnLink}"]`),
  ).toHaveCount(1);
  const sourcePort = page.locator(
    `[data-graph-node="${sourceId}"] [data-port="out"][data-transition="${returnLink}"]`,
  );
  await expect(sourcePort).toHaveCount(1);
  await expect(sourcePort).toHaveAttribute("data-peer", targetId);
  await expect(
    page.locator(
      `[data-graph-node="${targetId}"] [data-port="in"][data-transition="${returnLink}"]`,
    ),
  ).toHaveCount(1);

  // Hovering a port lights that connection and dims the others, so one line can be followed
  // through the corridor it shares with its neighbours.
  // The return's source can start outside the graph pane; the finder moves the camera to it.
  await page.getByTestId("graph-toolbar").getByTestId("toolbar-finder").click();
  await page.getByTestId("graph-node-finder").fill(sourceId);
  await page.locator(`[data-node-match="${sourceId}"]`).click();
  await restingCamera(page, GRAPH);
  await sourcePort.hover();
  await expect(page.locator(`[data-transition="${returnLink}"][data-focused="true"]`)).toHaveCount(
    1,
  );
  await expect(page.locator('[data-edge-kind][data-dimmed="true"]').first()).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-edge-kind][data-dimmed="true"]')).toHaveCount(0);
  await expect(page.locator('[data-edge-kind][data-focused="true"]')).toHaveCount(0);
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
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
  const cards = page.locator("[data-graph-node]");
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
              `${els[i].getAttribute("data-graph-node")}/${els[j].getAttribute("data-graph-node")}`,
            );
          }
        }
      }
      return pairs;
    });
  await expect.poll(overlaps, { timeout: 15000 }).toEqual([]);
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
    // Opened on the graph, the graph is the only diagram on the page: the map is not mounted
    // behind it, so the document holds one React Flow instance.
    await expect(page.locator(".react-flow")).toHaveCount(1);
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });
    await settledCamera(page, GRAPH);
    await expect(page.locator("[data-graph-group]").first()).toBeVisible();
    // The block the run is at carries the active status surface; the current step is marked, and
    // it is the only one.
    await expect(page.locator('[data-graph-group][data-block-id="scope"]')).toHaveClass(
      /ring-primary|border-primary|border-warning/,
    );
    await expect(page.locator('[data-graph-node][data-current="true"]')).toHaveCount(1);
    await expect(page.locator('[data-graph-node="get-task"]')).toHaveAttribute(
      "data-current",
      "true",
    );
  } finally {
    await authenticated.cleanup();
  }
});
