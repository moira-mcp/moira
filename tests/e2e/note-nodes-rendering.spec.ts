/**
 * E2E Tests for Note Node Types Rendering
 * Verifies that workflows with read-note, write-note, upsert-note nodes render correctly
 * Related issue: #467
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
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}`);
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
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // This workflow has write-note and upsert-note nodes
    // They should render with labels "WRITE" and "UPSERT"
    const writeLabel = page.locator('.react-flow__node:has-text("WRITE")');
    const upsertLabel = page.locator('.react-flow__node:has-text("UPSERT")');

    await expect(writeLabel).toHaveCount(1);
    await expect(upsertLabel).toHaveCount(1);
  });

  test("note nodes are clickable and show details", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${noteWorkflowSlug}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    const noteNode = page.locator('.react-flow__node:has-text("WRITE")').first();
    await expect(noteNode).toBeVisible();
    await noteNode.click();

    const sidebar = page.locator('[data-testid="workflow-sidebar"]');
    const detailSheet = page.locator('[role="dialog"], [data-state="open"]').first();
    await expect(sidebar.or(detailSheet).first()).toBeVisible({ timeout: 5000 });
  });
});
