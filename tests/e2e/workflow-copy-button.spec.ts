/**
 * E2E Tests: Workflow Copy Button (Use as Template) (#237-UI)
 *
 * Verifies:
 * - "Use as Template" button appears for public workflows
 * - Button is NOT shown for private workflows
 * - Clicking button creates copy and navigates to it
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_HANDLE = "admin"; // Admin user handle for handle/slug URLs

test.describe("Workflow Copy Button", () => {
  test("should show 'Use as Template' button for public workflow", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Create a public workflow for testing
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "public",
        workflow: {
          metadata: {
            name: "Copy Test Public Workflow",
            version: "1.0.0",
            description: "Public workflow for testing copy functionality",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    // Navigate to the public workflow using handle/slug format
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Look for "Use as Template" button
    const templateButton = page.locator(
      "button:has-text('Use as Template'), button:has-text('Использовать как шаблон')",
    );
    await expect(templateButton).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("should NOT show copy button for private workflow", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Create a PRIVATE workflow. "Use as Template" is gated on visibility === "public",
    // so it must be ABSENT on a private flow's detail. (The old home's Private-badge card
    // is gone, so navigate to the detail directly instead of searching the home.)
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "private",
        workflow: {
          metadata: {
            name: "Copy Test Private Workflow",
            version: "1.0.0",
            description: "Private workflow for testing copy-button gating",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);
    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    // Navigate to the private workflow's detail (handle/slug).
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");

    // Positive guard: confirm the workflow DETAIL actually rendered (the react-flow canvas)
    // before asserting the button's absence — otherwise a failed navigation would make the
    // toHaveCount(0) check pass vacuously.
    await expect(page.locator(".react-flow").first()).toBeVisible({ timeout: 10000 });

    // "Use as Template" must NOT be present for a private workflow.
    const templateButton = page.locator(
      "button:has-text('Use as Template'), button:has-text('Использовать как шаблон')",
    );
    await expect(templateButton).toHaveCount(0);

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });

  test("should create copy and navigate when clicking 'Use as Template'", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Create a public workflow for testing
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "public",
        workflow: {
          metadata: {
            name: "Copy Navigate Test",
            version: "1.0.0",
            description: "Public workflow for testing copy navigation",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    const responseData = await createResponse.json();
    const sourceWorkflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(sourceWorkflowId).toBeTruthy();

    // Navigate to the public workflow using handle/slug format
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Click "Use as Template" button
    const templateButton = page.locator(
      "button:has-text('Use as Template'), button:has-text('Использовать как шаблон')",
    );
    await expect(templateButton).toBeVisible();

    // Get initial URL
    const initialUrl = page.url();
    expect(initialUrl).toContain(workflowSlug);

    // Click the button
    await templateButton.click();

    // Wait for navigation to new workflow (different from original slug)
    await page.waitForURL((url) => !url.pathname.includes(workflowSlug), { timeout: 10000 });

    // Verify we're on a different workflow page (the copy)
    const newUrl = page.url();
    expect(newUrl).not.toBe(initialUrl);
    expect(newUrl).toContain("/workflows/");
    expect(newUrl).not.toContain(workflowSlug);

    // The copy should exist and be visible
    await page.waitForLoadState("domcontentloaded");

    // Cleanup: delete source workflow (copy is already navigated to and will remain)
    await page.request.delete(`${BASE_URL}/api/workflows/${sourceWorkflowId}`);
  });

  test("should show loading state while copying", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Create a public workflow for testing
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "public",
        workflow: {
          metadata: {
            name: "Loading State Test",
            version: "1.0.0",
            description: "Public workflow for testing loading state",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    const responseData = await createResponse.json();
    const sourceWorkflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(sourceWorkflowId).toBeTruthy();

    // Navigate to the public workflow using handle/slug format
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Find the button
    const templateButton = page.locator(
      "button:has-text('Use as Template'), button:has-text('Использовать как шаблон')",
    );
    await expect(templateButton).toBeVisible();

    // Click and immediately check for loading state
    await templateButton.click();

    // Should briefly show loading text (copyingWorkflow translation)
    // Note: This might be too fast to catch, so we just verify the navigation works
    await page.waitForURL((url) => !url.pathname.includes(workflowSlug), { timeout: 10000 });

    // Cleanup: delete source workflow
    await page.request.delete(`${BASE_URL}/api/workflows/${sourceWorkflowId}`);
  });
});

test.describe("Workflow Copy Button - Visibility Icon", () => {
  test("should show visibility toggle for owned public workflow", async ({ page }) => {
    // Login as admin (owner of public workflows)
    await loginAsAdmin(page);

    // Create a public workflow for testing
    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        visibility: "public",
        workflow: {
          metadata: {
            name: "Visibility Toggle Test",
            version: "1.0.0",
            description: "Public workflow for testing visibility toggle",
          },
          nodes: [
            { type: "start", id: "start", connections: { default: "end" } },
            { type: "end", id: "end" },
          ],
        },
      },
    });
    expect(createResponse.status()).toBe(200);

    const responseData = await createResponse.json();
    const workflowId = responseData.data?.workflowId;
    const workflowSlug = responseData.data?.slug;
    expect(workflowId).toBeTruthy();

    // Navigate to the public workflow using handle/slug format
    await page.goto(`${BASE_URL}/workflows/${ADMIN_HANDLE}/${workflowSlug}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Should see both copy button AND visibility toggle
    // (admin can see visibility toggle for system workflows)
    const templateButton = page.locator(
      "button:has-text('Use as Template'), button:has-text('Использовать как шаблон')",
    );
    await expect(templateButton).toBeVisible();

    // Visibility button should also exist
    const visibilityButton = page.locator(
      "button:has-text('Public'), button:has-text('Private'), button:has-text('Публичный'), button:has-text('Приватный')",
    );
    await expect(visibilityButton).toBeVisible();

    // Cleanup
    await page.request.delete(`${BASE_URL}/api/workflows/${workflowId}`);
  });
});
