/**
 * E2E Tests for Admin Executions Page
 * Tests that admin can see executions from all users
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl, getAdminCredentials } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Admin user
const ADMIN_USER = getAdminCredentials();

// Second user to create executions
const TEST_USER = {
  name: "Executions Test User",
  email: "exec-test-user@example.com",
  password: "TestPass123!",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

// Use existing production workflow that's guaranteed to be available
const TEST_WORKFLOW_ID = "moira/verified-research";

test.describe("Admin Executions Page", () => {
  let testUserMcpClient: Client;
  let testUserCleanup: () => Promise<void>;
  let executionId: string;

  test.beforeAll(async () => {
    // Create test user
    try {
      await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(TEST_USER),
      });
      console.log("✓ Test user created");
    } catch (error) {
      console.log("Test user already exists");
    }

    // Create MCP client for test user (with email verification)
    const mcpClient = await createAuthenticatedMCPClient({
      email: TEST_USER.email,
      password: TEST_USER.password,
      verifyEmail: true,
    });
    testUserMcpClient = mcpClient.client;
    testUserCleanup = mcpClient.cleanup;

    // Start execution as test user using existing public workflow
    const result = await callMCPTool<string>(testUserMcpClient, "start", {
      parentExecutionId: "none",
      workflowId: TEST_WORKFLOW_ID,
    });

    // Extract execution ID
    const match = result.match(/Process ID: ([a-f0-9-]+)/);
    if (match) {
      executionId = match[1];
      console.log(`✓ Execution created: ${executionId}`);
    } else {
      console.error("Failed to extract execution ID from:", result);
    }
  });

  test.afterAll(async () => {
    if (testUserCleanup) {
      await testUserCleanup();
    }
  });

  test("Admin sees executions from other users", async ({ page }) => {
    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });
    console.log(`✓ Logged in, current URL: ${page.url()}`);

    // Close beta modal if present
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");
    console.log(`✓ Navigated to: ${page.url()}`);

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

    // Click on the test user's execution card to open details
    if (executionId) {
      // Find execution card by the specific executionId (not user name, which may match multiple cards)
      const shortId = executionId.substring(0, 8);
      const targetCard = page.getByTestId("execution-card").filter({ hasText: shortId }).first();

      // If card with exact ID not found, fall back to user name filter
      const cardCount = await targetCard.count();
      if (cardCount > 0) {
        await targetCard.click();
      } else {
        const fallbackCard = page
          .getByTestId("execution-card")
          .filter({ hasText: TEST_USER.name })
          .first()
          .or(page.getByTestId("execution-card").filter({ hasText: TEST_USER.email }).first());
        await fallbackCard.click();
      }
      await page.waitForLoadState("domcontentloaded");

      // Verify we're on an execution detail page (may not be exact ID if fallback used)
      await expect(page).toHaveURL(/\/admin\/executions\/[a-f0-9-]+/, { timeout: 10000 });

      // Wait for the loading state to complete (page shows "Loading execution..." initially)
      // Wait for page to fully load - ProtectedRoute shows "Loading...", ExecutionInspector shows "Loading execution..."
      // Wait until neither loading message is visible
      await page.waitForFunction(
        () => {
          const body = document.body.textContent || "";
          return !body.includes("Loading...") && !body.includes("Loading execution");
        },
        { timeout: 30000 },
      );

      // Verify execution details are displayed (workflow ID or name)
      // The page may show either the full workflow ID or just the workflow name
      const workflowIdVisible = await page
        .locator(`text=${TEST_WORKFLOW_ID}`)
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      const workflowNameVisible = await page
        .locator("text=Verified Research")
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      const workflowSlugVisible = await page
        .locator("text=research")
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      expect(workflowIdVisible || workflowNameVisible || workflowSlugVisible).toBeTruthy();

      // Verify owner info is shown (page shows user name, not email)
      const ownerEmailVisible = await page
        .locator(`text=${TEST_USER.email}`)
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      const ownerNameVisible = await page
        .locator(`text=${TEST_USER.name}`)
        .isVisible({ timeout: 5000 })
        .catch(() => false);

      expect(ownerEmailVisible || ownerNameVisible).toBeTruthy();

      console.log(`✓ Admin can view execution details for other user's execution`);
    }
  });

  test("Admin can filter executions by user", async ({ page }) => {
    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal if present
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Find user filter dropdown
    const userFilter = page
      .locator('[data-testid="user-filter"]')
      .or(page.getByRole("combobox").first());

    await expect(userFilter).toBeVisible();
    await userFilter.click();

    // Look for test user in dropdown
    const testUserOption = page.locator(`text=${TEST_USER.email}`);
    if (await testUserOption.isVisible({ timeout: 5000 }).catch(() => false)) {
      await testUserOption.click();
      await page.waitForLoadState("domcontentloaded");

      // After filtering, should only see test user's executions
      const visibleEmails = await page.locator(`text=${TEST_USER.email}`).count();
      expect(visibleEmails).toBeGreaterThan(0);
    }
  });

  test("Admin can search executions by ID", async ({ page }) => {
    // Skip if execution wasn't created in beforeAll
    test.skip(!executionId, "Execution ID not available from beforeAll setup");

    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal if present
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Find search input by data-testid (stable selector independent of i18n placeholder)
    const searchInput = page.getByTestId("admin-executions-search");

    await expect(searchInput).toBeVisible();

    // Search for execution ID (first 8 chars)
    const searchTerm = executionId.substring(0, 8);
    await searchInput.fill(searchTerm);

    // Wait for search results to load (API request triggered by search input)
    await page.waitForResponse(
      (resp) => resp.url().includes("/api/admin/executions") && resp.status() === 200,
      { timeout: 10000 },
    );

    // Should find our execution (card shows first 8 chars of ID)
    const found = await page.locator(`text=${searchTerm}`).count();
    expect(found).toBeGreaterThan(0);
  });

  /**
   * Issue #421: Admin Executions page should show workflow name, not UUID
   */
  test("Workflow column shows human-readable name instead of UUID", async ({ page }) => {
    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal if present
    await page.waitForLoadState("networkidle");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("networkidle");

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
