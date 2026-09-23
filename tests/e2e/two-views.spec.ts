/**
 * The two views of a process — the map and the technical graph — behave as one page.
 *
 * Part one, on the run page and on the flow page alike: once a page has been shown, clicking a
 * block, a step, a panel tab or a view tab never remounts it. No page loader appears, no diagram
 * skeleton and no "laying out" placeholder comes back, the `view` parameter in the URL is what
 * changes, and the page's shell element keeps its DOM identity across a tab switch. Only the view
 * being read is mounted, so what a switch must carry is the selection, not a hidden diagram: the
 * map keeps the block it was left on and the graph opens on that block's group and first step.
 *
 * Part two, the map's own column: at 1440×900 the diagram owns the height and every card it draws
 * is readable, whole and built the same way — a title band, ports on the card's own borders and
 * the facts inside it; at 390×844 the page is one scrolling column.
 *
 * Part three, the waiting actor of #233: a run paused on an agent step must not tell the reader
 * that it is waiting for them. The status chip, the legend and the block panel say the agent is on
 * the step; only a run stopped at a lock node's PIN gate reads as "waiting for you". The lock case
 * is seeded directly into the container's database: creating a lock at run time requires configured
 * Telegram PIN delivery and would send a real message, which a test must not do, and the state
 * under test is exactly "the run is paused on a node of type `lock`".
 */

import { test, expect, type ElementHandle, type Page } from "./fixtures.js";
import { randomUUID } from "crypto";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import {
  GRAPH,
  MAP,
  expectNoLoaders,
  mapCardBoxes,
  openPanelSection,
  settledCamera,
} from "./helpers/diagram.js";

const BASE_URL = getTestBaseUrl();

type NodeHandle = ElementHandle<Node> | null;

/**
 * True when the element behind `testId` is still the very same DOM node as `before`. A remount
 * would replace it, so comparing the two handles in the page is the direct evidence.
 */
async function sameElement(page: Page, testId: string, before: NodeHandle): Promise<boolean> {
  const after: NodeHandle = await page.getByTestId(testId).elementHandle();
  return page.evaluate((pair: (Node | null)[]) => pair[0] !== null && pair[0] === pair[1], [
    before,
    after,
  ] as NodeHandle[]);
}

/** Open a step from the block panel, whose steps section opens folded. */
async function openStepFromPanel(page: Page, nodeId: string): Promise<void> {
  await openPanelSection(page, "panel-section-steps");
  await page.getByTestId("block-detail").locator(`[data-node-id="${nodeId}"] button`).click();
}

test("the run page switches block, step, tab and view without remounting anything", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    const progress = page.getByTestId("execution-progress");
    await expect(progress).toHaveAttribute("data-view", "map");
    await expect(page.getByTestId("canvas-view")).toBeVisible();
    await expectNoLoaders(page);

    // A block on the map: the URL carries the selection, the page does not reload.
    const shell: NodeHandle = await page.getByTestId("run-page").elementHandle();
    await page.getByTestId("map-contents-plan").click();
    await expect(page).toHaveURL(/block=plan/);
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan");
    await expectNoLoaders(page);

    // A panel tab: still the same page shell, still no loader.
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("variables-panel")).toBeVisible();
    await expectNoLoaders(page);
    expect(await sameElement(page, "run-page", shell)).toBe(true);
    await page.getByRole("tab", { name: /Block|Блок/ }).click();

    // A step in the panel opens the graph: the view parameter is what changes, and the panel
    // follows the jump to its node level.
    await openStepFromPanel(page, "create-plan");
    await expect(page).toHaveURL(/view=graph/);
    await expect(progress).toHaveAttribute("data-view", "graph");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "create-plan");
    await expectNoLoaders(page);
    // The map's selection is carried: the selected block's frame is the highlighted one, not
    // (only) the frame of the block the run is on.
    await expect(page.locator('[data-graph-group][data-block-id="plan"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.locator('[data-graph-group][data-selected="true"]')).toHaveCount(1);

    // Back to the map and to the graph again: only the view being read is mounted, and each
    // switch is carried by the selection and the panel's level — the map returns to its block
    // with the step still open, and the graph to that block's group with the step in view.
    await page.getByTestId("run-modes").locator('[data-mode="map"]').click();
    await expect(page).toHaveURL(/view=map/);
    await expect(page.getByTestId("canvas-view")).toBeVisible();
    await expect(page.locator("[data-graph-node]")).toHaveCount(0);
    await expect(page).toHaveURL(/block=plan/);
    await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "create-plan");
    await page.getByTestId("node-panel-back").click();
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan");
    await expectNoLoaders(page);
    expect(await sameElement(page, "run-page", shell)).toBe(true);
    await page.getByTestId("run-modes").locator('[data-mode="graph"]').click();
    await expect(progress).toHaveAttribute("data-view", "graph");
    await expect(page.getByTestId("canvas-view")).toHaveCount(0);
    await expect(page.locator('[data-graph-group][data-block-id="plan"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    const inGraphPane = async (selector: string) => {
      const frame = await page.locator('[data-testid="graph-view"] .react-flow').boundingBox();
      const card = await page.locator(selector).boundingBox();
      if (!frame || !card) return false;
      return (
        card.x >= frame.x &&
        card.y >= frame.y &&
        card.x + card.width <= frame.x + frame.width &&
        card.y + card.height <= frame.y + frame.height
      );
    };
    await expect
      .poll(() => inGraphPane('[data-graph-node="create-plan"]'), { timeout: 10000 })
      .toBe(true);
    await expectNoLoaders(page);
    expect(await sameElement(page, "run-page", shell)).toBe(true);

    // A node on the graph opens as the panel's node level rather than in a sheet over the page.
    // The navigator opens folded, so no card lies under it and the click lands on the card.
    await expect(page.getByTestId("rf__minimap")).toHaveCount(0);
    await page.locator('[data-graph-node="plan-review"]').click();
    await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "plan-review");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expectNoLoaders(page);

    // A link that opens on the graph: the map is mounted only when it is first shown, so it opens
    // on the run's current block at a readable size instead of a placement made in a hidden box.
    await page.goto(`${BASE_URL}/executions/${run.processId}?view=graph`);
    await expect(progress).toHaveAttribute("data-view", "graph");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("canvas-view")).toHaveCount(0);
    await page.getByTestId("run-modes").locator('[data-mode="map"]').click();
    await expect(page.getByTestId("canvas-view")).toBeVisible();
    const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
    // The block the run is at is the one the map is centred on, and it is drawn at a readable
    // size: a placement made while the map was hidden would leave the camera on the first block
    // (or on nothing at all), so exactly one card — this one — has its middle inside the box.
    await expect
      .poll(async () => {
        const cards = await mapCardBoxes(page);
        const centred = cards.filter(
          (card) =>
            card.x + card.width / 2 >= diagram.x &&
            card.x + card.width / 2 <= diagram.x + diagram.width &&
            card.y + card.height / 2 >= diagram.y &&
            card.y + card.height / 2 <= diagram.y + diagram.height,
        );
        return centred.map((card) => `${card.id}:${card.height >= 60}`);
      })
      .toEqual(["scope:true"]);
    await expectNoLoaders(page);
  } finally {
    await authenticated.cleanup();
  }
});

test("the flow page switches block, step, tab and view without remounting anything", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  const flow = page.getByTestId("flow-page");
  await expect(flow).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  await expectNoLoaders(page);

  const shell: NodeHandle = await page.getByTestId("flow-page").elementHandle();
  await page.getByTestId("map-contents-execute").click();
  await expect(page).toHaveURL(/block=execute/);
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "execute");
  await expectNoLoaders(page);

  await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
  await expect(page.getByTestId("registry-panel")).toBeVisible();
  await expectNoLoaders(page);
  expect(await sameElement(page, "flow-page", shell)).toBe(true);
  await page.getByRole("tab", { name: /Block|Блок/ }).click();

  // A step focuses the graph, which is the page's other view.
  await openStepFromPanel(page, "execute-step");
  await expect(page).toHaveURL(/view=graph/);
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
  await expectNoLoaders(page);

  // The block selected on the map is the highlighted frame on the graph, and a node clicked
  // there opens as the panel's node level.
  await expect(page.locator('[data-graph-group][data-block-id="execute"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  // The step asked for is the one the camera settles on — not the first step of its block — and
  // it is clicked there.
  await settledCamera(page, GRAPH);
  await page.locator('[data-graph-node="execute-step"]').click();
  await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "execute-step");
  await expectNoLoaders(page);

  // Back and forth: one diagram at a time, the selection carrying the switch.
  await page.getByTestId("flow-modes").locator('[data-mode="map"]').click();
  await expect(page).toHaveURL(/view=map/);
  await expect(page).toHaveURL(/block=execute/);
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  await expect(page.locator("[data-graph-node]")).toHaveCount(0);
  await expectNoLoaders(page);
  expect(await sameElement(page, "flow-page", shell)).toBe(true);
  await page.getByTestId("flow-modes").locator('[data-mode="graph"]').click();
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page.getByTestId("canvas-view")).toHaveCount(0);
  await expect(page.locator('[data-graph-group][data-block-id="execute"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await expectNoLoaders(page);
  expect(await sameElement(page, "flow-page", shell)).toBe(true);
});

test("the map gives the diagram the column on a desktop and one scrolling column on a phone", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  await expect(page.getByTestId("map-contents-list").locator("[data-block-id]")).toHaveCount(7);

  // The diagram owns the column: the explanation of the view is one button in the toolbar, so
  // the picture keeps most of the page's height instead of a strip at the bottom.
  const desktop = (await page.getByTestId("canvas-view").boundingBox())!;
  expect(desktop.height).toBeGreaterThanOrEqual(600);
  await expect(page.getByTestId("diagram-guide-body")).toHaveCount(0);

  // The map opens readable: every card it draws is at least 60 px tall (a diagram squeezed into
  // a strip cannot manage that), and the block it opens on is wholly inside the diagram's box —
  // a card laid out beyond the box is invisible and yet still answers a click.
  await expect.poll(async () => (await mapCardBoxes(page)).length).toBe(7);
  const inside = (card: { x: number; y: number; width: number; height: number }) =>
    card.x >= desktop.x - 1 &&
    card.y >= desktop.y - 1 &&
    card.x + card.width <= desktop.x + desktop.width + 1 &&
    card.y + card.height <= desktop.y + desktop.height + 1;
  await expect
    .poll(async () => {
      const cards = await mapCardBoxes(page);
      const short = cards.filter((card) => card.height < 60);
      const opened = cards.find((card) => card.id === "scope")!;
      return `short=${short.map((c) => `${c.id}:${Math.round(c.height)}`).join(",")} opened=${inside(opened)}`;
    })
    .toBe("short= opened=true");

  // Every card is the same ported card: a title band across the top, the ports of its transitions
  // on the card's own left and right borders, and the fact chips inside the card. A port drawn
  // outside its card, or facts pushed past the card's bottom edge, fails here.
  const shapes = await page.locator(`${MAP} [data-block-id]`).evaluateAll((cards) =>
    cards.map((card) => {
      const box = card.getBoundingClientRect();
      const within = (element: Element | null) => {
        if (!element) return true;
        const at = element.getBoundingClientRect();
        return (
          at.left >= box.left - 1 &&
          at.right <= box.right + 1 &&
          at.top >= box.top - 1 &&
          at.bottom <= box.bottom + 1
        );
      };
      const ports = [...card.querySelectorAll("[data-port]")];
      return {
        id: card.getAttribute("data-block-id"),
        band: Boolean(card.querySelector("[data-step-title]")),
        ports: ports.length,
        portsInside: ports.every(within),
        factsInside: within(card.querySelector("[data-step-facts]")),
      };
    }),
  );
  expect(shapes).toHaveLength(7);
  expect(shapes.filter((c) => !c.band || !c.portsInside || !c.factsInside)).toEqual([]);
  // Every block of Quick Task takes part in at least one transition, so every card has ports.
  expect(shapes.filter((c) => c.ports === 0)).toEqual([]);

  // A phone reads the map as one scrolling column: the diagram keeps a readable height, the
  // contents come beneath it, and scrolling the column reaches the last block.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  const phone = (await page.getByTestId("canvas-view").boundingBox())!;
  expect(phone.height).toBeGreaterThanOrEqual(300);
  const contents = page.getByTestId("map-contents");
  expect((await contents.boundingBox())!.y).toBeGreaterThanOrEqual(phone.y + phone.height - 1);
  const last = page.getByTestId("map-contents-deliver");
  expect((await last.boundingBox())!.y).toBeGreaterThan(844);
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

const NEVER_A_PERSON = /waiting for you|ждёт вас|your answer|вашего ответа/i;

/** The status legend, which the run's toolbar keeps behind its own button. */
async function openLegend(page: Page) {
  await page.getByTestId("legend-open").click();
  const legend = page.getByTestId("status-legend");
  await expect(legend).toBeVisible();
  return legend;
}

test("a run paused on an agent step says the agent is on the step, never that it waits for you", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    const card = page.locator(`${MAP} [data-block-id="scope"]`);
    await expect(card).toHaveAttribute("data-status", "waiting");
    // The card's chip, the legend and the block panel's chip all word it as the agent's turn.
    await expect(card.locator('[data-status="waiting"]')).toHaveText(/agent on the step/i);
    await expect(page.getByTestId("block-detail").locator('[data-status="waiting"]')).toHaveText(
      /agent on the step/i,
    );
    await expect(await openLegend(page)).toContainText(/agent on the step/i);
    // Nowhere on the page does it claim a person is being waited for.
    await expect(page.getByTestId("run-page")).not.toContainText(NEVER_A_PERSON);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("variables-panel")).toBeVisible();
    await expect(page.getByTestId("run-page")).not.toContainText(NEVER_A_PERSON);
  } finally {
    await authenticated.cleanup();
  }
});

test.describe("a run stopped at a lock node's PIN gate", () => {
  const workflowId = `e2e-lock-gate-${randomUUID()}`;
  const executionId = randomUUID();

  test.beforeAll(async () => {
    const now = Date.now();
    const graph = JSON.stringify({
      metadata: { name: "Lock gate e2e", version: "1.0.0", description: "waiting actor e2e" },
      progress: {
        title: "Lock gate e2e",
        goal: "Show who a paused run waits for.",
        nodes: [
          {
            id: "prepare",
            label: "Prepare the change",
            content: { summary: "The agent prepares the change that needs approval." },
            connections: { default: "gate" },
          },
          {
            id: "gate",
            label: "Approval gate",
            content: { summary: "A person approves the change with a PIN before it goes on." },
            connections: { default: "finish" },
          },
          {
            id: "finish",
            label: "Finish",
            content: { summary: "The approved change is applied." },
          },
        ],
      },
      nodes: [
        {
          id: "start",
          type: "start",
          connections: { default: "do-work" },
          progressNodeId: "prepare",
        },
        {
          id: "do-work",
          type: "agent-directive",
          directive: "Prepare the change.",
          completionCondition: "The change is prepared.",
          inputSchema: { type: "object", properties: { note: { type: "string" } } },
          connections: { success: "pin-gate" },
          progressNodeId: "prepare",
        },
        {
          id: "pin-gate",
          type: "lock",
          reason: "Approve the prepared change",
          connections: { unlocked: "wrap-up" },
          progressNodeId: "gate",
        },
        {
          id: "wrap-up",
          type: "agent-directive",
          directive: "Apply the approved change.",
          completionCondition: "The change is applied.",
          inputSchema: { type: "object", properties: { note: { type: "string" } } },
          connections: { success: "end" },
          progressNodeId: "finish",
        },
        { id: "end", type: "end", progressNodeId: "finish" },
      ],
    }).replace(/'/g, "''");
    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${workflowId}', 'system-admin', '${workflowId}-slug', 'Lock gate e2e', 'waiting actor e2e', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );
    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId,
      workflowId,
      userId: "system-admin",
    }).replace(/'/g, "''");
    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, waitingForInputNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${executionId}', '${workflowId}', 'system-admin', 'running', 'pin-gate', 'pin-gate', '${context}', ${now}, ${now});`,
    );
  });

  test.afterAll(async () => {
    try {
      execSqliteInDocker(`DELETE FROM workflowExecution WHERE executionId = '${executionId}';`);
    } catch {
      /* the row may already be gone */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${workflowId}';`);
    } catch {
      /* the row may already be gone */
    }
  });

  test("says it is waiting for you", async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${executionId}`);
    const card = page.locator(`${MAP} [data-block-id="gate"]`);
    await expect(card).toHaveAttribute("data-status", "waiting");
    await expect(card.locator('[data-status="waiting"]')).toHaveText(NEVER_A_PERSON);
    await expect(page.getByTestId("block-detail").locator('[data-status="waiting"]')).toHaveText(
      NEVER_A_PERSON,
    );
    await expect(await openLegend(page)).toContainText(NEVER_A_PERSON);
    // …and never the agent wording for this state.
    await expect(page.getByTestId("block-detail")).not.toContainText(/agent on the step/i);
  });
});
