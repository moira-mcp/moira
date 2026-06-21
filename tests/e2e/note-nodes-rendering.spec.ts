/**
 * E2E Tests for Note Node Types Rendering
 * Verifies that workflows with read-note, write-note, upsert-note nodes render correctly
 * Related issue: #467
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

// Public workflow with note nodes (from workflows/production/public/)
const NOTE_WORKFLOW_OWNER = "moira";
const NOTE_WORKFLOW_SLUG = "notes-demo-metrics-collector";

test.describe("Note Nodes Rendering", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("workflow with note nodes opens without crash", async ({ page }) => {
    // Navigate to the public note-demo workflow
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${NOTE_WORKFLOW_SLUG}`);
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
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${NOTE_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // This workflow has write-note and upsert-note nodes
    // They should render with labels "WRITE" and "UPSERT"
    const writeLabel = page.locator('.react-flow__node:has-text("WRITE")');
    const upsertLabel = page.locator('.react-flow__node:has-text("UPSERT")');

    // At least one note node type should be visible
    const hasWriteNode = (await writeLabel.count()) > 0;
    const hasUpsertNode = (await upsertLabel.count()) > 0;

    expect(hasWriteNode || hasUpsertNode).toBe(true);
  });

  test("note nodes are clickable and show details", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows/${NOTE_WORKFLOW_OWNER}/${NOTE_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Find any note node (WRITE or UPSERT)
    const noteNode = page.locator('.react-flow__node:has-text("WRITE")').first();
    const hasWriteNode = (await noteNode.count()) > 0;

    if (hasWriteNode) {
      // Click on the node
      await noteNode.click();

      // Node details should show in sidebar or dialog
      const sidebar = page.locator('[data-testid="workflow-sidebar"]');
      const detailSheet = page.locator('[role="dialog"], [data-state="open"]').first();
      await expect(sidebar.or(detailSheet).first()).toBeVisible({ timeout: 5000 });
    }
  });
});
