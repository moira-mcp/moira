/**
 * Note node types on the technical graph: a workflow whose steps write and upsert notes opens
 * without crashing, each note step is drawn as a card carrying its own type, and clicking one
 * opens its details in the page's node panel. Related issue: #467.
 *
 * The fixture declares no process view: the right panel is the only home of a node's details and
 * stands beside the graph whether or not a workflow declares a process, which is what this spec
 * reads. The graph itself is asked for explicitly through the `view` parameter.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";

const BASE_URL = getTestBaseUrl();

const NOTE_WORKFLOW_OWNER = "admin";
let noteWorkflowId = "";
let noteWorkflowSlug = "";

test.describe("Note Nodes Rendering", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);
    const result = await loadWorkflowFixture(page, "note-nodes-test.json", "private");
    expect(result.success).toBe(true);
    expect(result.workflowId).toBeTruthy();
    expect(result.slug).toBeTruthy();
    noteWorkflowId = result.workflowId;
    noteWorkflowSlug = result.slug;
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!noteWorkflowId) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsAdmin(page);
    await page.request.delete(`${BASE_URL}/api/workflows/${noteWorkflowId}`);
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("workflow with note nodes opens without crash", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}?view=graph`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for ReactFlow canvas to render - this is the key check
    // If note nodes cause crash, ReactFlow won't render
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Verify no error boundary triggered (no crash)
    const errorBoundary = page.locator('text="Something went wrong"');
    await expect(errorBoundary).not.toBeVisible();

    // Verify no "Unsupported node type" error
    const unsupportedError = page.locator('text="Unsupported node type"');
    await expect(unsupportedError).not.toBeVisible();
  });

  test("note nodes display with correct labels", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}?view=graph`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 20000 });

    // This workflow has one write-note and one upsert-note step; each card names its own type in
    // its title band. The card is addressed by its node id, since a neighbouring card's ports
    // name these steps too.
    await expect(page.locator('[data-graph-node="write-note"]')).toContainText("WRITE");
    await expect(page.locator('[data-graph-node="upsert-note"]')).toContainText("UPSERT");
  });

  test("note nodes are clickable and show details", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}?view=graph`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-graph-node="write-note"]')).toBeVisible({ timeout: 20000 });

    await page.locator('[data-graph-node="write-note"]').click();

    // The node level of the page's right panel is where a step's details are read.
    const panel = page.getByTestId("node-panel");
    await expect(panel).toHaveAttribute("data-node-id", "write-note");
    await expect(panel).toContainText("write-note");
  });
});
