/**
 * The flow page on Quick Task, in its two views: the map (the derived process as a diagram with
 * its contents sidebar and the block panel beside it) and the technical graph with its node
 * sidebar. Covers reading a bundled flow, a non-owner without edit mode, and an owner's edit
 * session on a private copy — a block renamed to ninety characters (the map card clamps it, facts
 * still inside the card), a relabelled return, a moved routing node reported
 * as a diagnostic before any save, an edited directive and registry default, the export diff, a
 * save that persists and advances the revision, a save refused on a stale revision (409) and on an
 * invalid definition (400) with the edits kept, and the page usable on a phone.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

async function copyQuickTask(page: Page): Promise<string> {
  const response = await page.request.post(`${BASE_URL}/api/workflows/moira/quick-task/copy`, {
    data: { newName: `Flow page edit ${Date.now()}` },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: { workflowId: string } }).data.workflowId;
}

async function detailOf(page: Page, id: string) {
  const response = await page.request.get(`${BASE_URL}/api/workflows/${id}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: any }).data;
}

/** Select a block through the map's contents sidebar: the panel then carries that block. */
async function openBlock(page: Page, blockId: string): Promise<void> {
  await page.getByTestId(`map-contents-${blockId}`).click();
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", blockId);
}

test("reads a bundled flow as a process on the map and as nodes on the graph, and explains it", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);

  const flow = page.getByTestId("flow-page");
  // The map is the default view of a workflow that has a process view.
  await expect(flow).toHaveAttribute("data-view", "map");
  await expect(page.getByTestId("map-view")).toBeVisible();
  await expect(page.getByTestId("map-contents-list").locator("[data-block-id]")).toHaveCount(7);
  await expect(page.getByTestId("flow-edit-toggle")).toHaveCount(0);
  // A definition has no run: no status chips and no "the run has not reached" wording, and the
  // block instead carries what the version typically costs.
  await expect(page.locator("span[data-status]")).toHaveCount(0);
  await expect(page.getByTestId("map-view")).not.toContainText(
    /has not reached this block|ещё не дошёл/,
  );
  // The explanation of the view is one line with a disclosure: the title is always there, the
  // body only after the reader asks for it, so the diagram keeps the column.
  await expect(page.getByTestId("guidance-map-toggle")).toContainText(
    /the process as a diagram|процесс как схема/,
  );
  await expect(page.getByTestId("guidance-map-body")).toHaveCount(0);
  await page.getByTestId("guidance-map-toggle").click();
  await expect(page.getByTestId("guidance-map-body")).toBeVisible();
  await page.getByTestId("guidance-map-toggle").click();
  await expect(page.getByTestId("guidance-map-body")).toHaveCount(0);
  // The block panel opens on the first block and drills into its steps with their evidence.
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "scope");
  await expect(
    page.getByTestId("block-detail").locator('[data-node-id="get-task"] [data-node-inputs]'),
  ).toBeVisible();
  await expect(page.getByTestId("typical-durations")).toHaveAttribute("data-block-id", "scope");
  await expect(page.getByTestId("flow-panel").getByTestId("registry-panel")).toHaveCount(0);
  await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
  await expect(page.getByTestId("registry-current_plan_file")).toBeVisible();

  // The map draws cycles muted and unlabelled; hovering a block's return chip lights that edge
  // with its label, and a selected block keeps its own connectors lit.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=execute`);
  await expect(
    page.locator('[data-testid="map-view"] [data-block-id="execute"]').first(),
  ).toBeVisible();
  await expect(page.locator('[data-edge-kind="cycle"]').first()).toBeVisible();
  // A chip may fold several returns to one target (`data-connector-count`): count connectors.
  const connectorsOf = async (selector: string) =>
    (
      await page
        .locator(selector)
        .evaluateAll((chips) =>
          chips.map((c) => Number(c.getAttribute("data-connector-count") ?? 1)),
        )
    ).reduce((a, b) => a + b, 0);
  const executeReturns = await connectorsOf(
    '[data-testid="canvas-view"] [data-block-id="execute"] [data-return-chip]',
  );
  expect(executeReturns).toBeGreaterThan(0);
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(executeReturns);
  const otherChip = page
    .locator(
      '[data-testid="canvas-view"] [data-block-id]:not([data-block-id="execute"]) [data-return-chip]',
    )
    .first();
  await otherChip.hover();
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(1);
  await expect(page.locator('[data-edge-kind="cycle"][data-focused="true"]')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(executeReturns);

  // The contents sidebar's finder answers "which block is this step in" and selects that block.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=plan-review`);
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "plan-review");
  await expect(page.getByTestId("block-detail").locator("[data-node-id]")).toHaveCount(3);
  await page.getByTestId("map-node-finder").fill("fix-issues");
  await page.locator('[data-node-match="fix-issues"]').click();
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "verify");

  // The technical graph is the other view: every node with its controls and node sidebar, and
  // the block panel steps aside for the sidebar the graph brings.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page.getByTestId("graph-fit-view")).toBeVisible();
  await expect(page.getByTestId("workflow-sidebar")).toBeVisible();
  await expect(page.getByTestId("flow-panel")).not.toBeVisible();
  // The graph draws no minimap over its lower cards.
  await expect(page.locator(".react-flow__minimap")).toHaveCount(0);

  // A link written for one of the views this page used to have resolves to the map.
  for (const legacy of ["outline", "canvas", "lanes", "split", "nonsense"]) {
    await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=${legacy}`);
    await expect(flow).toHaveAttribute("data-view", "map");
    await expect(page.getByTestId("map-view")).toBeVisible();
  }

  // A step in the block panel focuses it on the graph, which switches the page's view.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?block=verify`);
  await page.getByTestId("block-detail").locator('[data-node-id="final-review"] button').click();
  await expect(flow).toHaveAttribute("data-view", "graph");
  await expect(page).toHaveURL(/view=graph/);
  // The focused node is centred, so a click on it selects it; the sidebar names the other end
  // of each connection by node id (or display name), never by the type of the node the edge
  // reaches — "Decision" names nothing when several edges lead to different routing nodes.
  const focused = page.locator('.react-flow__node[data-id="final-review"]');
  const focusedBox = (await focused.boundingBox())!;
  await page.mouse.click(focusedBox.x + 20, focusedBox.y + 12);
  await expect(page.getByTestId("workflow-sidebar")).toContainText("final-review");
  const chips = page.getByTestId("outgoing-connection");
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("check-review-clean");
  await expect(chips).not.toContainText("Decision");

  // The walkthrough lives in the URL and points at the map's own elements.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?guide=1`);
  await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "process");
  await expect(page.locator('[data-guide-target="process"]')).toBeVisible();
  await page.getByTestId("walkthrough-next").click();
  await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "agent");
  await expect(page.locator('[data-guide-target="agent"]')).toBeVisible();
  await page.getByTestId("walkthrough-next").click();
  await expect(page.locator('[data-guide-target="evidence"]')).toBeVisible();
});

/** A ninety-character block name: the map card must clamp it rather than grow or overflow. */
const LONG_BLOCK_NAME =
  "Draft the plan (edited) with every unit, its acceptance evidence and the gate it ends with";

async function openEditing(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE_URL}/workflows/${id}?edit=1`);
  await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
  await expect(page.getByTestId("flow-edit-count")).toContainText("0");
}

test("an owner edits the definition in place; the save persists and advances the revision", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await copyQuickTask(page);
  try {
    expect((await detailOf(page, id)).fileInfo.revision).toBe(0);
    await openEditing(page, id);

    // Rename a block in its own panel. Switching blocks happens in the app: a page load would
    // discard the in-memory edits.
    await openBlock(page, "plan");
    await page.getByTestId("edit-block-label-plan").fill(LONG_BLOCK_NAME);
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    // The map's card clamps the ninety-character name: its name box and its facts line both lie
    // inside the card, the name takes at most two lines and the facts keep one — a name that
    // wrapped freely would push the facts out of the card's bottom edge.
    await expect(
      page.locator('[data-testid="canvas-view"] [data-block-id="plan"] [data-block-name]'),
    ).toContainText(LONG_BLOCK_NAME.slice(0, 20));
    const geometry = await page
      .locator('[data-testid="canvas-view"] [data-block-id="plan"]')
      .evaluate((card) => {
        const box = card.getBoundingClientRect();
        const name = card.querySelector("[data-block-name]")!.getBoundingClientRect();
        const facts = card.querySelector(".mt-auto > span")!.getBoundingClientRect();
        const inside = (r: DOMRect) =>
          r.left >= box.left - 1 &&
          r.right <= box.right + 1 &&
          r.top >= box.top - 1 &&
          r.bottom <= box.bottom + 1;
        return {
          title: card.getAttribute("title"),
          nameInside: inside(name),
          nameLines: Math.round(name.height / 20),
          factsInside: inside(facts),
          factsLines: Math.round(facts.height / 16),
          factsBelowName: facts.top >= name.bottom - 1,
        };
      });
    expect(geometry).toEqual({
      title: LONG_BLOCK_NAME,
      nameInside: true,
      nameLines: 2,
      factsInside: true,
      factsLines: 1,
      factsBelowName: true,
    });

    // Relabel the repair return, which belongs to the review block that it re-enters.
    await openBlock(page, "plan-review");
    await page.locator('[data-edges="repair-plan.success"]').click();
    await page.getByTestId("edit-transition-label").fill("plan repaired");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("flow-edit-count")).toContainText("2");

    // Move a routing node to another block: the diagnostic appears without a round trip and
    // blocks the save; moving it back clears it.
    await page.getByTestId("edit-owner-check-plan-review-clean").click();
    await page.getByRole("option", { name: "Understand the task" }).click();
    await expect(page.getByTestId("flow-diagnostics")).toContainText("unlabeled-edge");
    await expect(page.getByTestId("flow-edit-save")).toBeDisabled();
    // …and on the offending step itself, in the block it now sits in.
    await openBlock(page, "scope");
    await expect(
      page.locator('[data-node-id="check-plan-review-clean"] [data-testid="inline-diagnostic"]'),
    ).toHaveAttribute("data-diagnostic", /unlabeled-edge/);
    await page.getByTestId("edit-owner-check-plan-review-clean").click();
    await page.getByRole("option", { name: "Independent plan review" }).click();
    await expect(page.getByTestId("flow-diagnostics")).toHaveCount(0);
    await expect(page.getByTestId("inline-diagnostic")).toHaveCount(0);
    await expect(page.getByTestId("flow-edit-save")).toBeEnabled();

    // Edit a directive and a registry default; the export lists exactly what changes (the
    // ownership edit that ended where it started is not a change).
    await openBlock(page, "plan");
    await page.getByTestId("edit-node-create-plan-directive").fill("Write the plan (edited).");
    await openBlock(page, "execute");
    await page
      .getByTestId("edit-node-close-completed-step-expressions")
      .fill("current_step = current_step + 2");
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await page.getByTestId("registry-total_steps-default").fill("4");
    // The whole declaration is editable as JSON Schema (a keyword the field editors do not
    // offer) in the row's expanded body.
    await page.getByTestId("registry-total_steps-toggle").click();
    await page
      .getByTestId("registry-total_steps-schema")
      .fill('{"type":"number","description":"Steps in the plan","default":4,"minimum":1}');
    await page.getByTestId("flow-edit-export").getByRole("button").click();
    await expect(page.locator("[data-export-path]")).toHaveCount(5);
    await expect(
      page.locator('[data-export-path="nodes[close-completed-step].expressions"]'),
    ).toBeVisible();
    await expect(page.locator('[data-export-path="progress.nodes[1].label"]')).toBeVisible();
    await expect(
      page.locator('[data-export-path="nodes[repair-plan].connectionLabels.success"]'),
    ).toBeVisible();
    await expect(page.locator('[data-export-path="nodes[create-plan].directive"]')).toBeVisible();
    await expect(page.locator('[data-export-path="variableRegistry.total_steps"]')).toBeVisible();

    // Save: persisted, revision advanced, re-derived on reload.
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-edit-count")).toContainText("0");
    const saved = await detailOf(page, id);
    expect(saved.fileInfo.revision).toBe(1);
    expect(saved.workflow.progress.nodes[1].label).toBe(LONG_BLOCK_NAME);
    expect(saved.workflow.nodes.find((n: any) => n.id === "create-plan").directive).toBe(
      "Write the plan (edited).",
    );
    expect(saved.workflow.variableRegistry.total_steps).toEqual({
      type: "number",
      description: "Steps in the plan",
      default: 4,
      minimum: 1,
    });
    expect(
      saved.workflow.nodes.find((n: any) => n.id === "close-completed-step").expressions,
    ).toEqual(["current_step = current_step + 2"]);
    await page.goto(`${BASE_URL}/workflows/${id}?block=plan`);
    await expect(page.getByTestId("block-detail")).toContainText(LONG_BLOCK_NAME);
    await expect(page.getByTestId("block-detail")).toContainText("Write the plan (edited).");
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});

test("a save against a stale revision or with an invalid definition is refused and the edits stay", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await copyQuickTask(page);
  try {
    // Stale revision: another writer advanced the workflow after this page loaded.
    await openEditing(page, id);
    const current = await detailOf(page, id);
    const elsewhere = await page.request.put(`${BASE_URL}/api/workflows/${id}`, {
      data: {
        workflow: {
          ...current.workflow,
          metadata: { ...current.workflow.metadata, description: "moved on" },
        },
        expectedRevision: 0,
      },
    });
    expect(elsewhere.status()).toBe(200);
    await page.getByTestId("edit-block-label-scope").fill("Understand the task (stale)");
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-save-error")).toContainText(/reload|перезагрузите/i);
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    await expect(page.getByTestId("edit-block-label-scope")).toHaveValue(
      "Understand the task (stale)",
    );
    expect((await detailOf(page, id)).fileInfo.revision).toBe(1);

    // Invalid definition: a default that does not match its declared type is refused (400).
    await openEditing(page, id);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await page.getByTestId("registry-total_steps-default").fill('"four"');
    await page.getByTestId("flow-edit-save").click();
    await expect(page.getByTestId("flow-save-error")).toBeVisible();
    await expect(page.getByTestId("flow-edit-count")).toContainText("1");
    expect((await detailOf(page, id)).fileInfo.revision).toBe(1);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});

test("a phone keeps the flow page readable: contents under the diagram, panel under both, no overflow", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
  await expect(page.getByTestId("map-view")).toBeVisible();
  const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
  const contents = (await page.getByTestId("map-contents").boundingBox())!;
  expect(contents.y).toBeGreaterThanOrEqual(diagram.y + diagram.height - 1);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("guidance-map-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("guidance-map-body")).toHaveCount(0);
  const picture = (await page.getByTestId("flow-view").boundingBox())!;
  const panel = (await page.getByTestId("flow-panel").boundingBox())!;
  expect(picture.height).toBeGreaterThanOrEqual(900 * 0.4);
  expect(panel.y).toBeGreaterThanOrEqual(picture.y + picture.height - 1);
});
