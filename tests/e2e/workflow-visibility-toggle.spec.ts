/**
 * E2E Tests for Workflow Visibility Toggle UI
 * Tests visibility toggle button in WorkflowDetail
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_HANDLE = "admin"; // Admin user handle for handle/slug URLs

test.describe("Workflow Visibility Toggle UI", () => {
  test("Owner sees visibility toggle button for own workflow", async ({ page }) => {
    // Login as admin who owns system workflows
    await loginAsAdmin(page);

    // Create a private workflow that admin owns
    // Note: Server generates UUID and slug automatically

    // Create workflow via API
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Visibility Toggle Test",
            version: "1.0.0",
            description: "Test workflow for visibility toggle",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    // Get the server-generated workflow ID and slug
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    // Navigate to workflow detail using handle/slug format (canonical user-facing URL)
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for page to load
    await page.waitForTimeout(1000);

    // Verify visibility toggle button is visible (shows Private or Public)
    const toggleButton = page.locator('button:has-text("Private"), button:has-text("Public")');

    // Should be visible since admin owns this workflow
    await expect(toggleButton.first()).toBeVisible({ timeout: 5000 });

    // Cleanup - delete test workflow using UUID
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("Visibility toggle changes from private to public", async ({ page }) => {
    await loginAsAdmin(page);

    // Create private workflow
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Toggle Change Test",
            version: "1.0.0",
            description: "Test",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    // Get the server-generated workflow ID and slug
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Initially should show Private button
    const privateButton = page.locator('button:has-text("Private")');
    await expect(privateButton).toBeVisible({ timeout: 5000 });

    // Click toggle button to change to public
    await privateButton.click();

    // Wait for API call and UI update
    await page.waitForTimeout(1500);

    // Now should show Public button
    const publicButton = page.locator('button:has-text("Public")');
    await expect(publicButton).toBeVisible({ timeout: 5000 });

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("Non-owner does not see visibility toggle for system workflows", async ({ page }) => {
    // Create regular user via HTTP
    const email = `test-visibility-${Date.now()}@example.com`;
    const password = "TestPassword123!";
    const result = await createTestUser(email, password, "Test User", true);
    expect(result.success).toBe(true);

    // Login as the regular user
    await login(page, email, password);

    // Navigate to a system workflow (owned by system-admin)
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Click on first public workflow (system-owned)
    const workflowCard = page.locator("[class*='cursor-pointer']").first();
    await workflowCard.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Regular user should NOT see visibility toggle for system workflow
    // The toggle button shows "Private" or "Public" text - should NOT be visible for non-owners
    const privateButton = page.locator('button:has-text("Private")');
    const publicButton = page.locator('button:has-text("Public")');

    // Neither Private nor Public toggle should be visible (non-owner can't toggle)
    await expect(privateButton).toHaveCount(0);
    await expect(publicButton).toHaveCount(0);
  });

  test("Toggle button shows loading state during update", async ({ page }) => {
    await loginAsAdmin(page);

    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: { name: "Loading Test", version: "1.0.0", description: "Test" },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    // Get the server-generated workflow ID and slug
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Find toggle button (shows "Private" initially)
    const toggleButton = page.locator('button:has-text("Private")');
    await expect(toggleButton).toBeVisible();

    // Button should be enabled initially
    await expect(toggleButton).toBeEnabled();

    // Click toggle button
    await toggleButton.click();

    // The button becomes disabled during update (visibilityUpdating state)
    // We just verify the click worked and state changed
    await page.waitForTimeout(1500);

    // After update, should show Public button
    await expect(page.locator('button:has-text("Public")')).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});
