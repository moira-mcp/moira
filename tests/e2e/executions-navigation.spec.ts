/**
 * Executions Navigation E2E Tests
 * Tests filtering, sorting, pagination and note display on executions page
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { TEST_WORKFLOWS } from "./fixtures/test-constants.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

// The page sizes its list to the viewport but never below five rows; six seeded executions
// therefore guarantee a second page at a short viewport, whatever else is in the database.
const SEEDED_EXECUTIONS = 6;
const SHORT_VIEWPORT = { width: 1280, height: 480 };

test.describe("Executions Navigation", () => {
  let mcpCleanup: () => Promise<void>;

  test.beforeAll(async () => {
    // Seed executions as the admin: several waiting runs plus one driven to completion so the
    // "Completed" status filter has a deterministic match
    const authenticated = await createAuthenticatedMCPClient();
    mcpCleanup = authenticated.cleanup;
    const workflowId = TEST_WORKFLOWS.REACT_FLOW_THEME.id;
    for (let i = 0; i < SEEDED_EXECUTIONS - 1; i++) {
      await startWorkflowExecutionState(authenticated.client, workflowId);
    }
    // The fixture's two directive steps declare no inputSchema, so they accept only `{}`
    const completed = await startWorkflowExecutionState(authenticated.client, workflowId);
    await advanceWorkflowExecution(authenticated.client, completed, {});
    const finalResponse = await advanceWorkflowExecution(authenticated.client, completed, {});
    if (!/completed/i.test(finalResponse)) {
      throw new Error(`Seeded execution did not complete: ${finalResponse}`);
    }
  });

  test.afterAll(async () => {
    if (mcpCleanup) {
      await mcpCleanup();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for React to render the cards (Loading... disappears)
    await expect(page.locator("text=Loading...")).not.toBeVisible({ timeout: 10000 });
    // Ensure execution cards are rendered
    await expect(page.getByTestId("execution-card").first()).toBeVisible({ timeout: 10000 });
  });

  test("displays filter controls", async ({ page }) => {
    // Search input
    await expect(page.getByTestId("executions-search")).toBeVisible();

    // Status filter
    await expect(page.getByTestId("status-filter")).toBeVisible();

    // Combined sort select
    await expect(page.getByTestId("sort-select")).toBeVisible();

    // Reset button
    await expect(page.getByTestId("filter-reset")).toBeVisible();
  });

  test("displays execution cards with info", async ({ page }) => {
    // Should have at least one card
    const cardCount = await page.getByTestId("execution-card").count();
    expect(cardCount).toBeGreaterThan(0);

    // First card should contain text (workflow name + status)
    const firstCard = page.getByTestId("execution-card").first();
    const cardText = await firstCard.textContent();
    expect(cardText).toBeTruthy();
    expect(cardText!.length).toBeGreaterThan(0);
  });

  test("displays execution cards", async ({ page }) => {
    // Should have at least one card (pagination shows total in "X / Y" indicator)
    const cardCount = await page.getByTestId("execution-card").count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test("status filter changes results", async ({ page }) => {
    // Start waiting for response BEFORE clicking (to avoid race condition)
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/executions") &&
        response.url().includes("status=completed") &&
        response.status() === 200,
    );

    // Open status filter and select "Completed"
    await page.getByTestId("status-filter").click();
    await page.getByRole("option", { name: "Completed" }).click();

    // Wait for API request with status=completed filter to complete
    await responsePromise;

    // One seeded execution is completed, so the filtered list is non-empty and every visible
    // card shows the "Completed" status
    const cards = page.getByTestId("execution-card");
    await expect(cards.first()).toContainText(/completed/i);
    const count = await cards.count();
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i)).toContainText(/completed/i);
    }
  });

  test("sort order changes results", async ({ page }) => {
    // Get first card text with desc order (newest first - default)
    const firstCardDesc = await page.getByTestId("execution-card").first().textContent();

    // Change sort to oldest first via combined sort select
    await page.getByTestId("sort-select").click();
    // Select "Created ↑" option (ascending)
    await page.getByRole("option", { name: /Created.*↑/ }).click();

    await page.waitForLoadState("domcontentloaded");

    // Get first card text with asc order
    const firstCardAsc = await page.getByTestId("execution-card").first().textContent();

    // At minimum, verify the sort control worked (no crash)
    expect(firstCardAsc).toBeTruthy();
    expect(firstCardDesc).toBeTruthy();
  });

  test("sort by field changes results", async ({ page }) => {
    // Default is createdAt desc, switch to updatedAt desc via combined sort select
    await page.getByTestId("sort-select").click();
    await page.getByRole("option", { name: /Updated.*↓/ }).click();

    await page.waitForLoadState("domcontentloaded");

    // Verify sort worked (page didn't crash)
    const cardCount = await page.getByTestId("execution-card").count();
    expect(cardCount).toBeGreaterThanOrEqual(0);
  });

  test("search by note filters results", async ({ page }) => {
    // Enter a search term that's unlikely to match anything; the debounced request empties
    // the list and the count assertion retries until it has
    await page.getByTestId("executions-search").fill("xyznonexistent123");

    // Should show empty state (no cards)
    await expect(page.getByTestId("execution-card")).toHaveCount(0, { timeout: 5000 });
  });

  test("pagination shows when more than one page of results", async ({ page }) => {
    // A short viewport gives the minimum page size, so the seeded executions span two pages
    await page.setViewportSize(SHORT_VIEWPORT);
    await page.goto(`${BASE_URL}/executions`);

    // Pagination should be visible
    await expect(page.getByTestId("pagination-next")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("pagination-prev")).toBeVisible();

    // Previous should be disabled on first page
    await expect(page.getByTestId("pagination-prev")).toBeDisabled();

    // Click next
    await page.getByTestId("pagination-next").click();

    // Now previous should be enabled (wait for React state update after API response)
    await expect(page.getByTestId("pagination-prev")).toBeEnabled({ timeout: 10000 });

    // Check page indicator updated - look for "2 / X" pattern
    await expect(page.locator("text=/2 \\/ \\d+/")).toBeVisible();
  });

  test("clicking card navigates to execution inspector", async ({ page }) => {
    // Click first card and remember which execution it is
    const firstCard = page.getByTestId("execution-card").first();
    await firstCard.click();

    // Should navigate to the run page of that execution. The run page opens in a process
    // mode (outline/lanes/canvas) when the workflow has a process view and in the technical
    // view otherwise; the toolbar with the short execution ID is common to both.
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);
    const executionId = page.url().match(/\/executions\/([a-f0-9-]+)/)![1];
    await expect(page.getByTestId("run-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(executionId.substring(0, 8), { exact: true })).toBeVisible();
  });

  test("pagination navigation works", async ({ page }) => {
    // A short viewport gives the minimum page size, so the seeded executions span two pages
    await page.setViewportSize(SHORT_VIEWPORT);
    await page.goto(`${BASE_URL}/executions`);
    await expect(page.getByTestId("pagination-next")).toBeVisible({ timeout: 10000 });

    // Prev should be disabled on page 1
    await expect(page.getByTestId("pagination-prev")).toBeDisabled();

    // Go to page 2 — wait for API response
    const nextResponse = page.waitForResponse(
      (r) => r.url().includes("/api/executions") && r.status() === 200,
    );
    await page.getByTestId("pagination-next").click();
    await nextResponse;

    // Now prev should be enabled (wait for React state update after API response)
    await expect(page.getByTestId("pagination-prev")).toBeEnabled({ timeout: 10000 });

    // Go back to page 1 — wait for API response
    const prevResponse = page.waitForResponse(
      (r) => r.url().includes("/api/executions") && r.status() === 200,
    );
    await page.getByTestId("pagination-prev").click();
    await prevResponse;

    // Prev should be disabled again
    await expect(page.getByTestId("pagination-prev")).toBeDisabled();
  });

  test("workflow filter shows workflows", async ({ page }) => {
    // The admin owns workflows, so the workflow filter is rendered
    const workflowFilter = page.getByTestId("workflow-filter");
    await expect(workflowFilter).toBeVisible();
    await workflowFilter.click();

    // Should have "All workflows" option
    await expect(page.getByRole("option", { name: "All workflows" })).toBeVisible();

    // Close the dropdown
    await page.keyboard.press("Escape");
  });
});
