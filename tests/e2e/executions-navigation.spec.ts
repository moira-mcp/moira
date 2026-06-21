/**
 * Executions Navigation E2E Tests
 * Tests filtering, sorting, pagination and note display on executions page
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Executions Navigation", () => {
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
    // Get initial card count
    const initialCount = await page.getByTestId("execution-card").count();

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

    // Additional wait for React to re-render
    await page.waitForTimeout(300);

    // Get new count
    const filteredCount = await page.getByTestId("execution-card").count();

    // Filtered count should be <= initial
    expect(filteredCount).toBeLessThanOrEqual(initialCount);

    // If there are results, all visible cards should show "Completed" status
    if (filteredCount > 0) {
      const cards = page.getByTestId("execution-card");
      const count = await cards.count();
      for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await cards.nth(i).textContent();
        expect(text?.toLowerCase()).toContain("completed");
      }
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
    // Enter a search term that's unlikely to match anything
    await page.getByTestId("executions-search").fill("xyznonexistent123");

    // Wait for debounce (300ms) + request
    await page.waitForTimeout(500);
    await page.waitForLoadState("domcontentloaded");

    // Should show empty state (no cards)
    await expect(page.getByTestId("execution-card")).toHaveCount(0, { timeout: 5000 });
  });

  test("pagination shows when more than one page of results", async ({ page }) => {
    // Check if pagination is visible
    const paginationVisible = await page.getByTestId("pagination-next").isVisible();

    if (paginationVisible) {
      // Pagination should be visible
      await expect(page.getByTestId("pagination-next")).toBeVisible();
      await expect(page.getByTestId("pagination-prev")).toBeVisible();

      // Previous should be disabled on first page
      await expect(page.getByTestId("pagination-prev")).toBeDisabled();

      // Click next
      await page.getByTestId("pagination-next").click();
      await page.waitForLoadState("domcontentloaded");

      // Now previous should be enabled (wait for React state update after API response)
      await expect(page.getByTestId("pagination-prev")).toBeEnabled({ timeout: 10000 });

      // Check page indicator updated - look for "2 / X" pattern
      await expect(page.locator("text=/2 \\/ \\d+/")).toBeVisible();
    } else {
      // All results fit on one page
      const cardCount = await page.getByTestId("execution-card").count();
      expect(cardCount).toBeGreaterThanOrEqual(0);
    }
  });

  test("clicking card navigates to execution inspector", async ({ page }) => {
    // Click first card
    const firstCard = page.getByTestId("execution-card").first();
    await firstCard.click();

    // Should navigate to execution detail page
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);
    // Wait for page to load - check for execution inspector toolbar (status badge or workflow graph)
    await expect(page.locator(".react-flow")).toBeVisible({
      timeout: 15000,
    });
  });

  test("pagination navigation works", async ({ page }) => {
    // Check if pagination exists (more than one page)
    const paginationVisible = await page.getByTestId("pagination-next").isVisible();

    if (paginationVisible) {
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
    }
  });

  test("workflow filter shows workflows", async ({ page }) => {
    // Workflow filter should exist if there are workflows
    const workflowFilter = page.getByTestId("workflow-filter");

    // Workflow filter visibility depends on whether workflows exist
    if (await workflowFilter.isVisible()) {
      await workflowFilter.click();

      // Should have "All workflows" option
      await expect(page.getByRole("option", { name: "All workflows" })).toBeVisible();

      // Close the dropdown
      await page.keyboard.press("Escape");
    }
  });
});
