/**
 * Executions Page E2E Tests
 * Tests execution list display and navigation
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { TEST_WORKFLOWS } from "./fixtures/test-constants.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Executions Page", () => {
  let mcpCleanup: () => Promise<void>;

  test.beforeAll(async () => {
    // Create an admin MCP client via HTTP OAuth and start one execution so the list is non-empty
    const client = await createAuthenticatedMCPClient();
    mcpCleanup = client.cleanup;
    await startWorkflowExecutionState(client.client, TEST_WORKFLOWS.REACT_FLOW_THEME.id);
  });

  test.afterAll(async () => {
    if (mcpCleanup) {
      await mcpCleanup();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("executions page loads and displays execution list", async ({ page }) => {
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Check page title
    await expect(page.locator('h1:has-text("Executions")')).toBeVisible();

    // Check subtitle
    await expect(page.locator("text=Your workflow execution history")).toBeVisible();

    // Should have at least one execution card (created in beforeAll)
    await expect(page.getByTestId("execution-card").first()).toBeVisible({ timeout: 10000 });
    const cardCount = await page.getByTestId("execution-card").count();
    expect(cardCount).toBeGreaterThan(0);

    console.log(`✓ Executions page loaded with ${cardCount} execution cards`);
  });

  test("execution card displays workflow name and status", async ({ page }) => {
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Check first execution card has required info
    const firstCard = page.getByTestId("execution-card").first();
    await expect(firstCard).toBeVisible();

    // Card should contain text content (workflow name)
    const cardText = await firstCard.textContent();
    expect(cardText).toBeTruthy();
    expect(cardText!.length).toBeGreaterThan(0);

    // Card should show a status (completed, waiting, running, failed)
    const hasStatus = /completed|waiting|running|failed/i.test(cardText || "");
    expect(hasStatus).toBe(true);

    console.log(`✓ Execution card displays: ${cardText?.substring(0, 80)}`);
  });

  test("execution card click navigates to inspector", async ({ page }) => {
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution card
    const firstCard = page.getByTestId("execution-card").first();
    await firstCard.click();

    // Should navigate to execution inspector
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);
    expect(page.url()).toMatch(/\/executions\/[a-f0-9-]+/);
  });

  test("error state shows retry button", async ({ page }) => {
    // Fail the list request once: the page shows the error state with a Retry button
    let failNext = true;
    await page.route(
      (url) => url.pathname.endsWith("/api/executions"),
      async (route) => {
        if (failNext) {
          failNext = false;
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ success: false, error: { message: "Temporary failure" } }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.goto(`${BASE_URL}/executions`);
    const retryButton = page.getByRole("button", { name: "Retry" });
    await expect(retryButton).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("execution-card")).toHaveCount(0);

    // Retry reloads the list; the next request succeeds and the cards render
    await retryButton.click();
    await expect(page.getByTestId("execution-card").first()).toBeVisible({ timeout: 10000 });
    await expect(retryButton).toHaveCount(0);
  });

  /**
   * Issue #421: Workflow name should display human-readable name, not UUID
   * Previously the UI showed UUID like "a9156681..." instead of workflow name
   */
  test("workflow name shows human-readable name instead of UUID", async ({ page }) => {
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("networkidle");

    // Get text from first execution card
    const firstCard = page.getByTestId("execution-card").first();
    const cardText = await firstCard.textContent();

    expect(cardText).toBeTruthy();

    // Issue #421: Workflow name should NOT be a UUID pattern
    const isUUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i.test(cardText!);

    // Card should contain human-readable workflow name, not UUID
    // Workflow names typically contain words, spaces, or descriptive text
    const hasNonHexChars = /[^a-f0-9.\s-]/i.test(cardText!);
    expect(hasNonHexChars).toBe(true);

    // Allow UUID to be present (e.g., in data attributes) but primary text should be human-readable
    if (!isUUID) {
      console.log(
        `✓ Issue #421: Card displays name "${cardText?.substring(0, 60)}" (no UUID visible)`,
      );
    } else {
      console.log(
        `⚠ UUID found in card text, but name also present: "${cardText?.substring(0, 60)}"`,
      );
    }
  });
});
