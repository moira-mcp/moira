/**
 * E2E Tests for Workflow Canvas Controls
 * Tests Fit View button and Layout toggle buttons
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";

const BASE_URL = getTestBaseUrl();

// Test workflow - captured from server response
let TEST_WORKFLOW_ID = "";
let TEST_WORKFLOW_SLUG = "";
const TEST_OWNER_HANDLE = "admin"; // Admin user handle for handle/slug URLs

test.describe("Workflow Canvas Controls", () => {
  // Run all tests serially to share the fixture
  test.describe.configure({ mode: "serial" });

  // Create test workflow before all tests
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAsAdmin(page);

    // Create a simple test workflow for canvas controls testing
    const result = await loadWorkflowFixture(page, "all-node-types-test.json", "private");
    if (result.success) {
      TEST_WORKFLOW_ID = result.workflowId;
      TEST_WORKFLOW_SLUG = result.slug;
      console.log(
        `Canvas controls test workflow created: id=${TEST_WORKFLOW_ID}, slug=${TEST_WORKFLOW_SLUG}`,
      );
    } else {
      console.error("Failed to create test workflow for canvas controls");
    }

    await context.close();
  });

  // Cleanup after all tests
  test.afterAll(async ({ browser }) => {
    if (!TEST_WORKFLOW_ID) return;

    const context = await browser.newContext();
    const page = await context.newPage();

    await loginAsAdmin(page);
    // Use UUID for API delete operations
    await page.request.delete(`${BASE_URL}/api/workflows/${TEST_WORKFLOW_ID}`);
    await context.close();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("Fit View button is visible and clickable", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy(); // Ensure workflow was created

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas to render (ReactFlow needs time to initialize)
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Find Fit View button by text
    const fitViewButton = page.locator("button:has-text('Fit View')");
    await expect(fitViewButton).toBeVisible();

    // Click Fit View button (should not throw error)
    await fitViewButton.click();

    // Wait for animation duration (300ms from code + buffer)
    await page.waitForTimeout(400);

    // Verify canvas is still visible and functional
    await expect(page.locator(".react-flow")).toBeVisible();
  });

  test("Vertical layout button works", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy();

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Find Vertical button
    const verticalButton = page.locator("button:has-text('Vertical')");
    await expect(verticalButton).toBeVisible();

    // Click vertical layout
    await verticalButton.click();
    await page.waitForTimeout(400);

    // Canvas should still be functional
    await expect(page.locator(".react-flow")).toBeVisible();
  });

  test("Horizontal layout button works", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy();

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Find Horizontal button
    const horizontalButton = page.locator("button:has-text('Horizontal')");
    await expect(horizontalButton).toBeVisible();

    // Click horizontal layout
    await horizontalButton.click();
    await page.waitForTimeout(400);

    // Canvas should still be functional
    await expect(page.locator(".react-flow")).toBeVisible();
  });

  test("All canvas control buttons are present together", async ({ page }) => {
    expect(TEST_WORKFLOW_SLUG).toBeTruthy();

    // Navigate using handle/slug URL format (canonical user-facing format)
    await page.goto(`${BASE_URL}/workflows/${TEST_OWNER_HANDLE}/${TEST_WORKFLOW_SLUG}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for canvas
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // All three buttons should be present
    await expect(page.locator("button:has-text('Fit View')")).toBeVisible();
    await expect(page.locator("button:has-text('Vertical')")).toBeVisible();
    await expect(page.locator("button:has-text('Horizontal')")).toBeVisible();

    // Buttons should be in a control panel container
    const controlPanel = page.locator(".absolute.bottom-20.left-4");
    await expect(controlPanel).toBeVisible();
  });
});
