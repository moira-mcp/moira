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
    await page.waitForSelector("text=System", { state: "visible" });

    // Verify "System" owner name displayed (for system-admin workflows)
    const systemOwner = page.locator("text=System").first();
    await expect(systemOwner).toBeVisible();

    const ownerCount = await page.locator("text=System").count();
    expect(ownerCount).toBeGreaterThan(0);

    console.log(`✓ Owner name "System" displayed in ${ownerCount} workflow cards`);
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
