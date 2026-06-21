/**
 * E2E Tests: Context Variable Editor (tree)
 *
 * Verifies the tree-based context variable editor under the explicit output-scope model:
 * exactly TWO sections (Global variables / Node outputs) with no undeclared "runtime" group, a
 * global a node wrote is shown once under Global and hidden from the node's tree, registry
 * descriptions (tooltip), tree-aware filter, always-edit fields with dirty-gated save, per-path
 * nested editing (no whole-object overwrite), long-text modal, and empty-value handling.
 *
 * Seeds an admin-owned running execution via execSqliteInDocker for deterministic data.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { randomUUID } from "crypto";

const BASE_URL = getTestBaseUrl();
const SEED_PREFIX = "e2e-ctxtree";

test.describe("Context Variable Editor (tree)", () => {
  const seededWorkflowId = `${SEED_PREFIX}-wf-${Date.now()}`;
  const seededExecutionId = randomUUID();

  test.beforeAll(async () => {
    const now = Date.now();

    const graph = JSON.stringify({
      metadata: { name: `${SEED_PREFIX} WF`, version: "1.0.0", description: "ctx tree e2e" },
      variableRegistry: {
        alpha_start: {
          type: "string",
          description: "Alpha start description",
          default: "a-initial",
        },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "ask" } },
        {
          id: "ask",
          type: "agent-directive",
          directive: "Ask",
          completionCondition: "Done",
          inputSchema: {
            type: "object",
            properties: {
              review_findings: { type: "object", description: "Structured review outcome" },
            },
          },
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${seededWorkflowId}', 'system-admin', '${SEED_PREFIX}-wf-${now}', '${SEED_PREFIX} WF', 'ctx tree e2e', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );

    const context = JSON.stringify({
      variables: {
        alpha_start: "a-initial", // global (registry) — also written by 'ask' (see ask scope below)
        // node-local scope (node id 'ask'): local outputs (review_findings, empty_value, long_text)
        // PLUS the global the node wrote (alpha_start), which must be hidden here and shown once
        // under Global. empty_value / long_text are node-local leaves used by the affordance tests.
        ask: {
          review_findings: { blocking: 0, remarks: 2 },
          alpha_start: "a-initial",
          empty_value: "",
          long_text: "L".repeat(120),
        },
        // The start node's seeded scope contains only the global it wrote → empty after de-dup →
        // must NOT render as a node-output container.
        start: { alpha_start: "a-initial" },
      },
      nodeStates: {},
      executionId: seededExecutionId,
      workflowId: seededWorkflowId,
      userId: "system-admin",
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${seededExecutionId}', '${seededWorkflowId}', 'system-admin', 'running', 'ask', '${context}', ${now}, ${now});`,
    );
  });

  test.afterAll(async () => {
    try {
      execSqliteInDocker(
        `DELETE FROM workflowExecution WHERE executionId = '${seededExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${seededWorkflowId}';`);
    } catch {
      /* ignore */
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/executions/${seededExecutionId}`);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
  });

  test("shows exactly two sections (global / node outputs) with no undeclared group", async ({
    page,
  }) => {
    await expect(page.getByTestId("context-var-alpha_start")).toBeVisible();
    await expect(page.getByTestId("context-var-ask")).toBeVisible();

    await expect(page.getByText(/Global variables|Глобальные переменные/)).toBeVisible();
    await expect(page.getByText(/Node outputs|Выходы нод/)).toBeVisible();
    // No undeclared / "appeared during execution" section under the explicit output-scope model.
    await expect(
      page.getByText(/Appeared during execution|Появились в ходе выполнения/),
    ).toHaveCount(0);

    // Description tooltip on the global variable name (from the registry).
    await page.getByTestId("context-var-alpha_start").locator("span").first().hover();
    await expect(page.getByText("Alpha start description")).toBeVisible();
  });

  test("a global written by a node is shown once under Global and hidden from the node's tree", async ({
    page,
  }) => {
    // The global 'alpha_start' is present at the top level (under Global).
    await expect(page.getByTestId("context-var-alpha_start")).toBeVisible();
    // It also exists inside the 'ask' node scope, but must NOT be rendered there (no duplicate).
    await expect(page.getByTestId("context-var-ask.alpha_start")).toHaveCount(0);
    // The node's genuine local output is still shown inside its tree.
    await expect(page.getByTestId("context-var-ask.review_findings")).toBeVisible();
    // A node scope whose only contents are globals it wrote (e.g. start) is empty after de-dup and
    // must NOT render as a node-output container.
    await expect(page.getByTestId("context-var-start")).toHaveCount(0);
  });

  test("renders a node-local object as a tree and edits a nested value via per-path save", async ({
    page,
  }) => {
    // The 'ask' node-local scope is a top-level object (expanded by default). Expand the nested
    // 'review_findings' object inside it to reach the leaf.
    const reviewToggle = page.getByTestId("context-node-toggle-ask.review_findings");
    if (await reviewToggle.count()) {
      await reviewToggle.click();
    }

    const input = page.getByTestId("context-var-input-ask.review_findings.blocking");
    await expect(input).toBeVisible();
    await expect(input).toHaveValue("0");
    await expect(page.getByTestId("context-var-save-ask.review_findings.blocking")).toBeDisabled();
    await input.fill("5");
    // Wait for the PUT to actually complete before clicking — capture the network response so the
    // DB read below is gated on the server having persisted the write, not on the optimistic draft.
    const savePut = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/executions/${seededExecutionId}/context`) &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    );
    await page.getByTestId("context-var-save-ask.review_findings.blocking").click();
    await savePut;

    // After a successful save the row reloads from the server, so the save button returns to the
    // disabled (not-dirty) state — i.e. the input now reflects the PERSISTED value, not the draft.
    // Gating on this (instead of toHaveValue, which passes immediately off the optimistic draft)
    // guarantees the write is durable before we read it back from the DB.
    await expect(page.getByTestId("context-var-save-ask.review_findings.blocking")).toBeDisabled({
      timeout: 10000,
    });
    await expect(page.getByTestId("context-var-input-ask.review_findings.blocking")).toHaveValue(
      "5",
    );
    const row = execSqliteInDocker(
      `SELECT context FROM workflowExecution WHERE executionId = '${seededExecutionId}';`,
    );
    const ctx = JSON.parse(row);
    expect(ctx.variables.ask.review_findings).toEqual({ blocking: 5, remarks: 2 });
    expect(ctx.variables.alpha_start).toBe("a-initial");
  });

  test("tree-aware filter shows a nested match with its ancestors", async ({ page }) => {
    // "remarks" only exists nested under ask.review_findings.
    await page.getByTestId("context-filter-input").fill("remarks");
    await expect(page.getByTestId("context-var-ask")).toBeVisible();
    await expect(page.getByTestId("context-var-ask.review_findings.remarks")).toBeVisible();
    // Unrelated top-level vars are filtered out.
    await expect(page.getByTestId("context-var-empty_value")).toHaveCount(0);
  });

  test("long text shows an expand button opening a modal editor", async ({ page }) => {
    await expect(page.getByTestId("context-var-expand-ask.long_text")).toBeVisible();
    await page.getByTestId("context-var-expand-ask.long_text").click();
    await expect(page.getByTestId("context-var-modal-textarea-ask.long_text")).toBeVisible();
  });

  test("empty value renders an editable field (not a sliver)", async ({ page }) => {
    const input = page.getByTestId("context-var-input-ask.empty_value");
    await expect(input).toBeVisible();
    // The input has a real height (normal field), not a ~2px sliver.
    const box = await input.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(16);
  });
});
