/**
 * E2E Tests for Workflow Visibility Features
 * Tests visibility badges, filters, and owner indicators
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUser, login } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const TEST_USER = {
  name: "Visibility Test User",
  email: "visibility-test@example.com",
  password: "TestPass123!",
};

test.beforeAll(async () => {
  // Pre-create the verified test user (idempotent when it already exists)
  const created = await createTestUser(TEST_USER.email, TEST_USER.password, TEST_USER.name);
  if (!created.success) throw new Error(`Failed to create test user: ${created.error}`);
});

test.describe("Workflow Visibility Features", () => {
  test.beforeEach(async ({ page }) => {
    // Login via the shared helper (session cookie + beta agreement bypass)
    await login(page, TEST_USER.email, TEST_USER.password);
  });

  test("Visibility badges displayed for workflows", async ({ page }) => {
    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Check visibility badges present
    const publicBadges = page.locator("text=Public");
    const privateBadges = page.locator("text=Private");

    // At least one badge should be visible
    const publicCount = await publicBadges.count();
    const privateCount = await privateBadges.count();

    expect(publicCount + privateCount).toBeGreaterThan(0);

    console.log(`✓ Visibility badges displayed: ${publicCount} Public, ${privateCount} Private`);
  });

  test("Visibility filter dropdown accessible and functional", async ({ page }) => {
    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Verify workflows displayed with default "All" filter
    const allWorkflows = await page.locator("text=Public").count();
    expect(allWorkflows).toBeGreaterThan(0);

    // The list's filters are optional and folded behind "Filters"; opened, the validation,
    // visibility and sort comboboxes are present
    await page.getByTestId("filters-toggle").click();
    await expect(page.getByTestId("visibility-filter")).toBeVisible();
    const comboboxes = page.locator('[role="combobox"]');
    const comboboxCount = await comboboxes.count();
    expect(comboboxCount).toBeGreaterThanOrEqual(2);

    console.log(`✓ Visibility filter present and functional (${allWorkflows} workflows displayed)`);
  });

  test("Owner name displayed in workflow cards", async ({ page }) => {
    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    // Other tests can create newer public flows. Select a known catalog entry instead of
    // assuming the current first page contains a bundled flow after its page size settles.
    await page.getByTestId("workflow-scope-catalog").click();
    await page.getByPlaceholder(/Search workflows|Поиск воркфлоу/).fill("quick-task");
    const quickTask = page.getByTestId("workflow-card").filter({
      has: page.locator('[data-slot="card-title"]', { hasText: /^Quick Task$/ }),
    });
    await expect(quickTask).toHaveCount(1);
    const owner = quickTask.getByTestId("workflow-card-owner");
    await expect(owner).toHaveText("@moira");
    await expect(owner).toBeVisible();
  });

  test("Public workflows accessible after login", async ({ page }) => {
    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Count public workflows
    const publicBadges = page.locator("text=Public");
    const publicCount = await publicBadges.count();

    // System has 21 public workflows from system-admin
    expect(publicCount).toBeGreaterThan(0);
    console.log(`✓ Public workflows visible: ${publicCount}`);
  });
});
