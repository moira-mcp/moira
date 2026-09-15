/**
 * E2E Tests for Admin Executions Page
 * Tests that admin can see executions from all users
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import {
  createAuthenticatedMCPClient,
  createTestUserViaApi,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Second user to create executions. The email is unique per run: the admin user filter lists
// only the newest hundred users, so a reused account eventually drops out of the dropdown.
const TEST_USER = {
  name: "Executions Test User",
  email: `exec-test-user-${Date.now()}@example.com`,
  password: "TestPass123!",
};

// Use existing production workflow that's guaranteed to be available
const TEST_WORKFLOW_ID = "moira/verified-research";

test.describe("Admin Executions Page", () => {
  let testUserCleanup: () => Promise<void>;
  let executionId: string;

  test.beforeAll(async () => {
    // Create the verified test user (idempotent) and start one execution as that user
    await createTestUserViaApi(FETCH_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);
    const mcpClient = await createAuthenticatedMCPClient({
      email: TEST_USER.email,
      password: TEST_USER.password,
    });
    testUserCleanup = mcpClient.cleanup;
    // The user is created fresh for this run and has no notification channel; this scenario is
    // about what an operator sees, not about notifications, so the optional channel check is
    // skipped rather than satisfied.
    ({ processId: executionId } = await startWorkflowExecutionState(
      mcpClient.client,
      TEST_WORKFLOW_ID,
      { skipNotificationCheck: true },
    ));
  });

  test.afterAll(async () => {
    if (testUserCleanup) {
      await testUserCleanup();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/executions`);
  });

  test("Admin sees executions from other users", async ({ page }) => {
    // Wait for page content to render and execution data to load
    await expect(page.locator('h1:has-text("All Executions")')).toBeVisible({ timeout: 10000 });

    // Wait for execution cards to appear (data may take time to load)
    await expect(
      page
        .locator(`text=${TEST_USER.name}`)
        .or(page.locator(`text=${TEST_USER.email}`))
        .first(),
    ).toBeVisible({ timeout: 10000 });

    // Check that test user's execution is visible
    // Cards show userName (if available) or userEmail
    const testUserName = await page.locator(`text=${TEST_USER.name}`).count();
    const testUserEmail = await page.locator(`text=${TEST_USER.email}`).count();

    // At least one should be visible (card shows name preferentially)
    expect(testUserName + testUserEmail).toBeGreaterThan(0);

    console.log(
      `✓ Admin sees test user execution (name matches: ${testUserName}, email matches: ${testUserEmail})`,
    );

    // Click the card for this exact execution, not an arbitrary card owned by the same user.
    const shortId = executionId.substring(0, 8);
    const targetCard = page.getByTestId("execution-card").filter({ hasText: shortId }).first();
    await expect(targetCard).toBeVisible({ timeout: 10000 });
    await targetCard.click();
    await expect(page).toHaveURL(`/admin/executions/${executionId}`, { timeout: 10000 });

    // Both identities arrive asynchronously. Locator assertions wait for the actual detail payload;
    // `isVisible({ timeout })` is an immediate observation and previously made this test flaky.
    await expect(
      page
        .getByText("Verified Research", { exact: true })
        .or(page.getByText(TEST_WORKFLOW_ID, { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page
        .getByText(TEST_USER.name, { exact: true })
        .or(page.getByText(TEST_USER.email, { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 10000 });

    console.log(`✓ Admin can view execution details for other user's execution`);
  });

  test("Admin can filter executions by user", async ({ page }) => {
    // Find user filter dropdown
    const userFilter = page
      .locator('[data-testid="user-filter"]')
      .or(page.getByRole("combobox").first());

    await expect(userFilter).toBeVisible();
    await userFilter.click();

    // Look for test user in dropdown
    const testUserOption = page.getByText(TEST_USER.email, { exact: true });
    await expect(testUserOption).toBeVisible({ timeout: 10000 });
    const filteredResponse = page.waitForResponse(
      (response) => response.url().includes("/api/admin/executions") && response.status() === 200,
    );
    await testUserOption.click();
    await filteredResponse;

    // After filtering, the selected user and their execution remain observable.
    await expect(page.getByText(TEST_USER.email, { exact: true }).first()).toBeVisible();
    await expect(
      page
        .getByTestId("execution-card")
        .filter({ hasText: executionId.substring(0, 8) })
        .first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("Admin can search executions by ID", async ({ page }) => {
    // Find search input by data-testid (stable selector independent of i18n placeholder)
    const searchInput = page.getByTestId("admin-executions-search");

    await expect(searchInput).toBeVisible();

    // Search for execution ID (first 8 chars)
    const searchTerm = executionId.substring(0, 8);
    await searchInput.fill(searchTerm);

    // Wait for search results to load (API request triggered by search input)
    await page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/admin/executions") &&
        resp.url().includes(searchTerm) &&
        resp.status() === 200,
      { timeout: 10000 },
    );

    // Should find our execution (card shows first 8 chars of ID)
    await expect(
      page.getByTestId("execution-card").filter({ hasText: searchTerm }).first(),
    ).toBeVisible();
  });

  /**
   * Issue #421: Admin Executions page should show workflow name, not UUID
   */
  test("Workflow column shows human-readable name instead of UUID", async ({ page }) => {
    // Get workflow name from first execution card
    const firstCard = page.getByTestId("execution-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });
    const workflowText = await firstCard.textContent();

    expect(workflowText).toBeTruthy();

    // Issue #421: Should NOT be a UUID or truncated UUID
    const isUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      workflowText!.trim(),
    );
    const isTruncatedUUID = /^[a-f0-9]{8}\.\.\.$/.test(workflowText!.trim());

    expect(isUUID || isTruncatedUUID).toBe(false);

    // Should contain non-hex characters (workflow names have words)
    const hasNonHexChars = /[^a-f0-9.\s-]/i.test(workflowText!);
    expect(hasNonHexChars).toBe(true);

    console.log(`✓ Issue #421: Admin Executions shows workflow name "${workflowText}" (not UUID)`);
  });
});
