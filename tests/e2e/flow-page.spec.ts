/**
 * The flow page on Quick Task: the definition read as a process (outline by default, canvas,
 * lanes, split, the technical graph with its sidebar), the walkthrough, a non-owner without edit
 * mode, and an owner's edit session on a private copy — a renamed block, a relabelled return, a
 * moved routing node reported as a diagnostic before any save, an edited directive and registry
 * default, the export diff, a save that persists and advances the revision, a save refused on a
 * stale revision (409) and on an invalid definition (400) with the edits kept, and the page
 * usable on a phone.
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

test("reads a bundled flow as a process in every mode and explains it", async ({ page }) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task`);

  const flow = page.getByTestId("flow-page");
  await expect(flow).toHaveAttribute("data-view", "outline");
  await expect(page.getByTestId("outline-document").locator("section[data-block-id]")).toHaveCount(
    7,
  );
  await expect(page.getByTestId("flow-edit-toggle")).toHaveCount(0);
  // The block panel opens on the first block and drills into its steps with their evidence.
  await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "scope");
  await expect(
    page.getByTestId("block-detail").locator('[data-node-id="get-task"] [data-node-inputs]'),
  ).toBeVisible();
  await expect(page.getByTestId("flow-panel").getByTestId("registry-panel")).toHaveCount(0);
  await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
  await expect(page.getByTestId("registry-current_plan_file")).toBeVisible();

  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=canvas&block=execute`);
  await expect(
    page.locator('[data-testid="flow-view"] [data-block-id="execute"]').first(),
  ).toBeVisible();
  await expect(page.locator('[data-edge-kind="cycle"]').first()).toBeVisible();
  // The canvas draws cycles muted and unlabelled; the selected block's own connectors are lit,
  // and hovering another block's return chip lights that edge with its label instead.
  // A chip may fold several returns to one target (`data-connector-count`): count connectors.
  const connectorsOf = async (selector: string) =>
    (
      await page
        .locator(selector)
        .evaluateAll((chips) =>
          chips.map((c) => Number(c.getAttribute("data-connector-count") ?? 1)),
        )
    ).reduce((a, b) => a + b, 0);
  const executeReturns = await connectorsOf('[data-block-id="execute"] [data-return-chip]');
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(executeReturns);
  const otherChip = page
    .locator('[data-block-id]:not([data-block-id="execute"]) [data-return-chip]')
    .first();
  await otherChip.hover();
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(1);
  await expect(page.locator('[data-edge-kind="cycle"][data-focused="true"]')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(page.locator('[data-edge-label="cycle"]')).toHaveCount(executeReturns);
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=lanes`);
  await expect(page.locator("[data-lane-index]")).toHaveCount(7);
  // A definition has no run: no status chips, no "the run has not reached" text, and the mode
  // note speaks of the process, not of a run.
  await expect(page.locator("span[data-status]")).toHaveCount(0);
  await expect(page.getByTestId("guidance-lanes")).toContainText(
    /the process in order|процесс по порядку/,
  );
  await expect(page.getByTestId("lanes-content")).not.toContainText(
    /has not reached this block|ещё не дошёл/,
  );
  await expect(page.locator("[data-arc]:not([data-arc='chip'])").first()).toBeVisible();
  // Returns carry no label at rest; a chip in the source lane lights its arc and label on hover.
  await expect(page.locator("[data-arc-label]")).toHaveCount(0);
  const returnChip = page.locator("[data-lane-index] [data-return-chip]").first();
  await returnChip.hover();
  await expect(page.locator("[data-arc-label]")).toHaveCount(1);
  await expect(page.locator('[data-arc][data-focused="true"]')).toHaveCount(1);
  // A block deep link selects it: its return arcs stay lit with their labels, no other block's.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=lanes&block=plan-review`);
  await expect(
    page.locator('[data-block-id="plan-review"] [data-return-chip]').first(),
  ).toBeVisible();
  const selectedReturns = await connectorsOf('[data-block-id="plan-review"] [data-return-chip]');
  await expect(page.locator("[data-arc-label]")).toHaveCount(selectedReturns);
  await expect(page.locator('[data-arc][data-focused="true"]')).toHaveCount(selectedReturns);
  await expect(
    page.locator('[data-arc][data-focused="true"][data-transition^="plan-review→"]'),
  ).toHaveCount(selectedReturns);
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=split&block=plan-review`);
  await expect(page.getByTestId("split-implementation")).toHaveAttribute(
    "data-block-id",
    "plan-review",
  );
  await expect(page.getByTestId("split-nodes").locator("[data-node-id]")).toHaveCount(3);
  await page.getByTestId("split-node-finder").fill("fix-issues");
  await page.locator('[data-node-match="fix-issues"]').click();
  await expect(page.getByTestId("split-implementation")).toHaveAttribute("data-block-id", "verify");

  // The technical graph keeps its controls and sidebar; a step in the block panel focuses it.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=graph`);
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("button:has-text('Fit View')")).toBeVisible();
  await expect(page.getByTestId("workflow-sidebar")).toBeVisible();
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=outline&block=verify`);
  await page.getByTestId("block-detail").locator('[data-node-id="final-review"] button').click();
  await expect(flow).toHaveAttribute("data-view", "graph");

  // The walkthrough lives in the URL and lands on the split mode for the step and evidence.
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?guide=1`);
  await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "process");
  await page.getByTestId("walkthrough-next").click();
  await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "agent");
  await expect(page).toHaveURL(/view=split/);
  await expect(page.locator('[data-guide-target="agent"]')).toBeVisible();
  await page.getByTestId("walkthrough-next").click();
  await expect(page.locator('[data-guide-target="evidence"]')).toBeVisible();
});

async function openEditing(page: Page, id: string): Promise<void> {
  await page.goto(`${BASE_URL}/workflows/${id}?edit=1`);
  await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
  await expect(page.getByTestId("flow-edit-count")).toContainText("0");
}

/** Switch modes and blocks in the app: a page load would discard the in-memory edits. */
async function openSplitBlock(page: Page, blockId: string): Promise<void> {
  await page.getByTestId("flow-modes").locator('[data-mode="split"]').click();
  await page.getByTestId(`split-block-${blockId}`).click();
  await expect(page.getByTestId("split-implementation")).toHaveAttribute("data-block-id", blockId);
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

    // Rename a block and relabel a return, in the outline.
    await page.getByTestId("edit-block-label-plan").fill("Draft the plan (edited)");
    await page.locator('[data-edges="repair-plan.success"]').click();
    await page.getByTestId("edit-transition-label").fill("plan repaired");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("flow-edit-count")).toContainText("2");

    // Move a routing node to another block: the diagnostic appears without a round trip and
    // blocks the save; moving it back clears it.
    await openSplitBlock(page, "plan-review");
    await page.getByTestId("edit-owner-check-plan-review-clean").click();
    await page.getByRole("option", { name: "Understand the task" }).click();
    await expect(page.getByTestId("flow-diagnostics")).toContainText("unlabeled-edge");
    await expect(page.getByTestId("flow-edit-save")).toBeDisabled();
    // …and on the offending step itself, in the block it now sits in.
    await page.getByTestId("split-block-scope").click();
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
    await page.getByTestId("split-block-plan").click();
    await page.getByTestId("edit-node-create-plan-directive").fill("Write the plan (edited).");
    await page.getByTestId("split-block-execute").click();
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
    expect(saved.workflow.progress.nodes[1].label).toBe("Draft the plan (edited)");
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
    await page.goto(`${BASE_URL}/workflows/${id}?view=outline&block=plan`);
    await expect(page.getByTestId("block-detail")).toContainText("Draft the plan (edited)");
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

test("a phone keeps the flow page readable: vertical lanes, the panel under the picture, no overflow", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.goto(`${BASE_URL}/workflows/moira/quick-task?view=lanes`);
  await expect(page.locator("[data-lanes-orientation]")).toHaveAttribute(
    "data-lanes-orientation",
    "vertical",
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("guidance-lanes")).toHaveAttribute("data-folded", "true");
  const picture = (await page.getByTestId("flow-view").boundingBox())!;
  const panel = (await page.getByTestId("flow-panel").boundingBox())!;
  expect(picture.height).toBeGreaterThanOrEqual(900 * 0.4);
  expect(panel.y).toBeGreaterThanOrEqual(picture.y + picture.height - 1);
});
