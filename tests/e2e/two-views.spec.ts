/**
 * The two views of a process — the map and the technical graph — behave as one page.
 *
 * Part one, on the run page and on the flow page alike: once a view has been shown, clicking a
 * block, a step, a panel tab, a view tab or a node on the graph never remounts the page. No page
 * loader appears, no diagram skeleton and no "laying out" placeholder comes back, the `view`
 * parameter in the URL is what changes, the page's shell element keeps its DOM identity across a
 * tab switch, and the state each view holds survives a switch away and back: the map keeps the
 * selected block, the graph keeps its viewport.
 *
 * Part two, the waiting actor of #233: a run paused on an agent step must not tell the reader
 * that it is waiting for them. The status chip and the block panel say the agent is on the step;
 * only a run stopped at a lock node's PIN gate reads as "waiting for you". The lock case is
 * seeded directly into the container's database: creating a lock at run time requires configured
 * Telegram PIN delivery and would send a real message, which a test must not do, and the state
 * under test is exactly "the run is paused on a node of type `lock`".
 */

import { test, expect, type ElementHandle, type Page } from "./fixtures.js";
import { randomUUID } from "crypto";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

/** Nothing on the page may say "the whole page is being rebuilt". */
async function expectNoLoaders(page: Page): Promise<void> {
  await expect(page.getByTestId("page-loader")).toHaveCount(0);
  await expect(page.getByTestId("diagram-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("canvas-loading")).toHaveCount(0);
  await expect(page.getByText(/Laying out the process|Раскладываю процесс/)).toHaveCount(0);
}

/** The computed transform of the technical graph's viewport (the graph's remembered position). */
function graphTransform(page: Page, scope: string) {
  return page
    .locator(`${scope} .react-flow__viewport`)
    .last()
    .evaluate((el) => window.getComputedStyle(el).transform);
}

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

    // A step in the panel focuses the graph: the view parameter is what changes. The graph's
    // chunk was fetched on mount, so its skeleton is never shown.
    await page.getByTestId("block-detail").locator('[data-node-id="create-plan"] button').click();
    await expect(page).toHaveURL(/view=graph/);
    await expect(progress).toHaveAttribute("data-view", "graph");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
    await expectNoLoaders(page);
    // The map's selection is carried: the selected block's frame is the highlighted one, not
    // (only) the frame of the block the run is on.
    await expect(page.locator('[data-graph-group][data-block-id="plan"]')).toHaveAttribute(
      "data-selected",
      "true",
    );
    await expect(page.locator('[data-graph-group][data-selected="true"]')).toHaveCount(1);

    // A node on the graph, then back to the map and to the graph again: the map still carries
    // the block that was selected, and the graph the viewport it was left at.
    await page.locator('[data-graph-node="create-plan"]').click();
    // The run page shows a node's details in a sheet; reading it and closing it changes nothing
    // about the views behind it.
    const sheet = page.locator('[role="dialog"]');
    await expect(sheet).toContainText("create-plan");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expectNoLoaders(page);
    await expect
      .poll(() => graphTransform(page, '[data-testid="execution-progress"]'))
      .not.toBe("none");
    const onGraph = await graphTransform(page, '[data-testid="execution-progress"]');
    await page.getByTestId("run-modes").locator('[data-mode="map"]').click();
    await expect(page).toHaveURL(/view=map/);
    await expect(page.getByTestId("canvas-view")).toBeVisible();
    await expect(page).toHaveURL(/block=plan/);
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan");
    await expectNoLoaders(page);
    expect(await sameElement(page, "run-page", shell)).toBe(true);
    await page.getByTestId("run-modes").locator('[data-mode="graph"]').click();
    await expect(progress).toHaveAttribute("data-view", "graph");
    // The viewport is read once the shown element is laid out again; it is the transform the
    // graph was left at, not a fresh fit.
    await expect
      .poll(() => graphTransform(page, '[data-testid="execution-progress"]'))
      .toBe(onGraph);
    await expectNoLoaders(page);
    expect(await sameElement(page, "run-page", shell)).toBe(true);

    // A link that opens on the graph: the map is mounted only when first shown, so it opens on
    // the run's current block at a readable size instead of a placement made in a hidden box.
    await page.goto(`${BASE_URL}/executions/${run.processId}?view=graph`);
    await expect(progress).toHaveAttribute("data-view", "graph");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("canvas-view")).toHaveCount(0);
    await page.getByTestId("run-modes").locator('[data-mode="map"]').click();
    await expect(page.getByTestId("canvas-view")).toBeVisible();
    const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
    await expect
      .poll(async () => {
        const current = (await cardBoxes(page)).find((card) => card.id === "scope");
        return current
          ? current.height >= 60 &&
              current.x >= diagram.x - 1 &&
              current.x + current.width <= diagram.x + diagram.width + 1
          : false;
      })
      .toBe(true);
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
  await page.getByTestId("block-detail").locator('[data-node-id="execute-step"] button').click();
  await expect(page).toHaveURL(/view=graph/);
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
  await expectNoLoaders(page);

  // The block selected on the map is the highlighted frame on the graph.
  await expect(page.locator('[data-graph-group][data-block-id="execute"]')).toHaveAttribute(
    "data-selected",
    "true",
  );
  await page.locator('[data-graph-node="execute-step"]').click();
  await expect(page.getByTestId("workflow-sidebar")).toContainText("execute-step");
  await expectNoLoaders(page);
  await expect.poll(() => graphTransform(page, '[data-testid="flow-view"]')).not.toBe("none");
  const onGraph = await graphTransform(page, '[data-testid="flow-view"]');
  await page.getByTestId("flow-modes").locator('[data-mode="map"]').click();
  await expect(page).toHaveURL(/view=map/);
  await expect(page).toHaveURL(/block=execute/);
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "execute");
  await expectNoLoaders(page);
  expect(await sameElement(page, "flow-page", shell)).toBe(true);
  await page.getByTestId("flow-modes").locator('[data-mode="graph"]').click();
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect.poll(() => graphTransform(page, '[data-testid="flow-view"]')).toBe(onGraph);
  await expectNoLoaders(page);
  expect(await sameElement(page, "flow-page", shell)).toBe(true);
});

/** Every block card the map's diagram currently draws, with its box. */
async function cardBoxes(page: Page) {
  return page.locator('[data-testid="canvas-view"] [data-block-id]').evaluateAll((cards) =>
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

test("the map gives the diagram the column on a desktop and one scrolling column on a phone", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  await expect(page.getByTestId("map-contents-list").locator("[data-block-id]")).toHaveCount(7);

  // The diagram owns the column: the explanation above it costs one row, so the picture keeps
  // most of the page's height instead of a strip at the bottom.
  const desktop = (await page.getByTestId("canvas-view").boundingBox())!;
  expect(desktop.height).toBeGreaterThanOrEqual(600);
  await expect(page.getByTestId("guidance-map-body")).toHaveCount(0);

  // The map opens readable: every card it draws is at least 60 px tall (a diagram squeezed into
  // a strip cannot manage that), and the block it opens on is wholly inside the diagram's box —
  // a card laid out beyond the box is invisible and yet still answers a click.
  await expect.poll(async () => (await cardBoxes(page)).length).toBe(7);
  const inside = (card: { x: number; y: number; width: number; height: number }) =>
    card.x >= desktop.x - 1 &&
    card.y >= desktop.y - 1 &&
    card.x + card.width <= desktop.x + desktop.width + 1 &&
    card.y + card.height <= desktop.y + desktop.height + 1;
  await expect
    .poll(async () => {
      const cards = await cardBoxes(page);
      const short = cards.filter((card) => card.height < 60);
      const opened = cards.find((card) => card.id === "scope")!;
      return `short=${short.map((c) => `${c.id}:${Math.round(c.height)}`).join(",")} opened=${inside(opened)}`;
    })
    .toBe("short= opened=true");

  // Fit-to-view gives the overview back without going below the readable floor: after zooming
  // in on the middle of the process, the control returns to the first block wholly inside the
  // box with every card still readable, not a centred strip of 30 px cards.
  await page.getByTestId("canvas-view").locator(".react-flow__controls-zoomin").click();
  await page.getByTestId("canvas-view").locator(".react-flow__controls-zoomin").click();
  await page.getByTestId("canvas-view").locator(".react-flow__controls-fitview").click();
  await expect
    .poll(async () => {
      const cards = await cardBoxes(page);
      const short = cards.filter((card) => card.height < 60);
      const first = cards.find((card) => card.id === "scope")!;
      return `short=${short.map((c) => c.id).join(",")} first=${inside(first)}`;
    })
    .toBe("short= first=true");

  // Every card's footer keeps its shape: the facts are one text line, and each transition chip
  // sits inside its card and below that line — a chip drawn over the description, or facts
  // wrapped into a column beside a long chip, fails here.
  const footers = await page
    .locator('[data-testid="canvas-view"] [data-block-id]')
    .evaluateAll((cards) =>
      cards.map((card) => {
        const chips = card.querySelector('[data-testid="block-chips"]');
        const facts = (chips?.previousElementSibling ?? card.querySelector(".mt-auto > span"))!;
        const box = card.getBoundingClientRect();
        const factsBox = facts.getBoundingClientRect();
        const chipBoxes = [...(chips?.children ?? [])].map((chip) => chip.getBoundingClientRect());
        return {
          id: card.getAttribute("data-block-id"),
          factsLines: Math.round(factsBox.height / 16),
          chipsInside: chipBoxes.every(
            (c) =>
              c.left >= box.left - 1 &&
              c.right <= box.right + 1 &&
              c.bottom <= box.bottom + 1 &&
              c.top >= factsBox.bottom - 1,
          ),
        };
      }),
    );
  expect(footers.length).toBe(7);
  expect(footers.filter((f) => f.factsLines > 1 || !f.chipsInside)).toEqual([]);
  expect(footers.some((f) => f.id === "plan-review")).toBe(true);

  // A phone reads the map as one scrolling column: the diagram keeps a readable height, the
  // contents come beneath it, and scrolling the column reaches the last block.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("canvas-view")).toBeVisible();
  const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
  expect(diagram.height).toBeGreaterThanOrEqual(300);
  const contents = page.getByTestId("map-contents");
  expect((await contents.boundingBox())!.y).toBeGreaterThanOrEqual(diagram.y + diagram.height - 1);
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
    const card = page.locator('[data-testid="canvas-view"] [data-block-id="scope"]');
    await expect(card).toHaveAttribute("data-status", "waiting");
    // The card's chip, the legend and the block panel's chip all word it as the agent's turn.
    await expect(card.locator('[data-status="waiting"]')).toHaveText(/agent on the step/i);
    await expect(page.getByTestId("status-legend")).toContainText(/agent on the step/i);
    await expect(page.getByTestId("block-detail").locator('[data-status="waiting"]')).toHaveText(
      /agent on the step/i,
    );
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
    const card = page.locator('[data-testid="canvas-view"] [data-block-id="gate"]');
    await expect(card).toHaveAttribute("data-status", "waiting");
    await expect(card.locator('[data-status="waiting"]')).toHaveText(NEVER_A_PERSON);
    await expect(page.getByTestId("status-legend")).toContainText(NEVER_A_PERSON);
    await expect(page.getByTestId("block-detail").locator('[data-status="waiting"]')).toHaveText(
      NEVER_A_PERSON,
    );
    // …and never the agent wording for this state.
    await expect(page.getByTestId("block-detail")).not.toContainText(/agent on the step/i);
  });
});
