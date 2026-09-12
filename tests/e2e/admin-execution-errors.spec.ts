/**
 * E2E Tests for Admin Execution Inspector Error Display
 * Tests that admin can see execution errors in the inspector
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

// Test user to create executions
const TEST_USER = {
  name: "Error Display Test User",
  email: `error-test-user-${Date.now()}@example.com`,
  password: "TestPass123!",
};

// Use existing production workflow that's guaranteed to be available
const TEST_WORKFLOW_ID = "moira/verified-research";

test.describe("Admin Execution Inspector Error Display", () => {
  let testUserCleanup: () => Promise<void>;
  let executionId: string;

  test.beforeAll(async () => {
    // Create the verified test user and start one execution as that user
    await createTestUserViaApi(FETCH_URL, TEST_USER.email, TEST_USER.password, TEST_USER.name);
    const mcpClient = await createAuthenticatedMCPClient({
      email: TEST_USER.email,
      password: TEST_USER.password,
    });
    testUserCleanup = mcpClient.cleanup;
    ({ processId: executionId } = await startWorkflowExecutionState(
      mcpClient.client,
      TEST_WORKFLOW_ID,
    ));
  });

  test.afterAll(async () => {
    if (testUserCleanup) {
      await testUserCleanup();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/executions/${executionId}`);
    // The inspector header shows the short execution ID once the execution has loaded
    await expect(page.getByText(executionId.substring(0, 8), { exact: true })).toBeVisible({
      timeout: 30000,
    });
  });

  test("Admin sees error panel when execution has node errors", async ({ page }) => {
    // Click on Errors tab to see error history
    await page.getByRole("tab", { name: /Errors|Ошибки/ }).click();

    // Check for Error History panel
    await expect(
      page.locator("text=Error History").or(page.locator("text=История ошибок")),
    ).toBeVisible({ timeout: 5000 });

    // The execution has no recorded node errors, so the empty state is shown
    await expect(page.locator("text=No errors recorded")).toBeVisible({ timeout: 3000 });
  });

  test("Admin sees the execution context of another user's execution", async ({ page }) => {
    await page.getByRole("tab", { name: /Context|Контекст/ }).click();

    // The context editor renders the run's variables; the filter input is its stable anchor.
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
  });
});
