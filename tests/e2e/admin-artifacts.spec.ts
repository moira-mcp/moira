/**
 * Admin Artifacts E2E Tests
 * Tests admin artifact management functionality
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Helper to create an artifact for a user via API
async function createArtifactForUser(
  sessionCookie: string,
  name: string,
): Promise<{ uuid: string; url: string }> {
  const response = await fetch(`${FETCH_URL}/api/artifacts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessionCookie,
    },
    body: JSON.stringify({
      name,
      content: `<!DOCTYPE html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create artifact: ${response.status}`);
  }
  const result = await response.json();
  return result.data;
}

// Helper to get session cookie for a user
async function getSessionCookie(email: string, password: string): Promise<string> {
  const response = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("No session cookie returned");
  // Extract the cookie value and format it
  const match = setCookie.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("Could not extract session cookie");
  const isSecure = FETCH_URL.startsWith("https://");
  const cookieName = isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
  return `${cookieName}=${match[1]}`;
}

test.describe("Admin Artifacts Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin can access artifacts page via navigation", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("domcontentloaded");

    // Click on Artifacts in the sidebar
    await page.click('a[href="/admin/artifacts"]');
    await page.waitForURL(`${BASE_URL}/admin/artifacts`);

    // Check page title is visible (use the main content h1, not sidebar)
    await expect(page.getByRole("heading", { name: "Artifacts Management" })).toBeVisible();
  });

  test("admin artifacts page shows stats cards", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for stats to load
    await expect(page.locator("text=Total Artifacts")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Total Size")).toBeVisible();
    await expect(
      page.locator("text=Users with Artifacts").or(page.locator("text=Пользователей")),
    ).toBeVisible();
  });

  test("admin artifacts page shows filters", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Check filter elements are present
    await expect(page.getByTestId("user-search-input")).toBeVisible();
    await expect(page.getByTestId("include-expired-checkbox")).toBeVisible();
    await expect(page.getByTestId("include-deleted-checkbox")).toBeVisible();
    await expect(page.getByTestId("filter-reset")).toBeVisible();
  });

  test("admin can toggle include expired filter", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Toggle include expired checkbox
    const checkbox = page.getByTestId("include-expired-checkbox");
    await checkbox.check();
    expect(await checkbox.isChecked()).toBe(true);

    // Uncheck
    await checkbox.uncheck();
    expect(await checkbox.isChecked()).toBe(false);
  });

  test("admin can clear filters", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Enter some filter values
    await page.getByTestId("user-search-input").fill("test@example.com");
    await page.getByTestId("include-expired-checkbox").check();

    // Clear filters via Reset button
    await page.getByTestId("filter-reset").click();

    // Check filters are reset
    await expect(page.getByTestId("user-search-input")).toHaveValue("");
    expect(await page.getByTestId("include-expired-checkbox").isChecked()).toBe(false);
  });
});

test.describe("Admin Artifacts - With Test Data", () => {
  let testUserEmail: string;
  let testUserPassword: string;
  let testArtifactUuid: string;

  test.beforeAll(async () => {
    // Create a test user and artifact
    testUserEmail = `e2e-artifact-test-${Date.now()}@test.local`;
    testUserPassword = "TestPassword123!";

    // Create verified test user via API
    const result = await createTestUser(
      testUserEmail,
      testUserPassword,
      "E2E Artifact Test User",
      true,
    );
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }

    // Login and create an artifact
    const sessionCookie = await getSessionCookie(testUserEmail, testUserPassword);
    const artifact = await createArtifactForUser(sessionCookie, `E2E Test Artifact ${Date.now()}`);
    testArtifactUuid = artifact.uuid;
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin can see test user artifact in list", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for the card list to load
    await expect(
      page
        .getByTestId("artifact-card")
        .first()
        .or(page.getByTestId(`artifact-row-${testArtifactUuid}`)),
    ).toBeVisible({ timeout: 10000 });

    // Check the artifact is visible in the list (card uses artifact-row-{uuid} testId in list mode)
    await expect(page.getByTestId(`artifact-row-${testArtifactUuid}`)).toBeVisible({
      timeout: 10000,
    });
  });

  test("admin can see open artifact button", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for card list to load
    await expect(
      page
        .getByTestId("artifact-card")
        .first()
        .or(page.getByTestId(`artifact-row-${testArtifactUuid}`)),
    ).toBeVisible({ timeout: 10000 });

    // Find the open button for our artifact - verify it exists and is enabled
    const openButton = page.getByTestId(`open-${testArtifactUuid}`);
    await expect(openButton).toBeVisible();
    await expect(openButton).toBeEnabled();
  });

  test("admin can delete artifact via UI", async ({ page }) => {
    // First create a new artifact that we can delete
    const sessionCookie = await getSessionCookie(testUserEmail, testUserPassword);
    const artifactToDelete = await createArtifactForUser(
      sessionCookie,
      `Artifact To Delete ${Date.now()}`,
    );

    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for card list to load
    await expect(page.locator('[data-testid^="artifact-row-"]').first()).toBeVisible({
      timeout: 10000,
    });

    // Find and click delete button
    const deleteButton = page.getByTestId(`delete-${artifactToDelete.uuid}`);
    await deleteButton.click();

    // Confirm deletion in dialog (ConfirmDialog wraps AlertDialog)
    await expect(page.locator('[role="alertdialog"]')).toBeVisible();
    // ConfirmDialog doesn't have delete-confirm testId; click the confirm button
    await page.locator('[role="alertdialog"] button').last().click();

    // Wait for deletion to complete and dialog to disappear
    await expect(page.locator('[role="alertdialog"]')).not.toBeVisible({ timeout: 10000 });
  });

  test("admin can filter by user", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for initial load
    await expect(page.locator('[data-testid^="artifact-"]').first()).toBeVisible({
      timeout: 10000,
    });

    // Enter user filter - the API will reload with the new filter
    await page.getByTestId("user-search-input").fill("nonexistent-filter-value");

    // Wait for the filter to apply (debounced) and API call to complete
    await page.waitForTimeout(600);

    // The list should be empty or show no artifact cards
    const cards = page.locator('[data-testid^="artifact-row-"]');
    await expect(cards).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe("Admin User Detail - Artifact Quota", () => {
  let testUserId: string;

  test.beforeAll(async () => {
    // Create a test user
    const testUserEmail = `e2e-quota-test-${Date.now()}@test.local`;
    const testUserPassword = "TestPassword123!";

    const result = await createTestUser(
      testUserEmail,
      testUserPassword,
      "E2E Quota Test User",
      true,
    );
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }
    if (!result.userId) {
      throw new Error("createTestUser did not return userId");
    }
    testUserId = result.userId;
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin can see artifact quota section in user detail", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/users/${testUserId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for the page to load
    await expect(page.getByTestId("artifact-quota-card")).toBeVisible({ timeout: 10000 });

    // Check quota card content
    await expect(page.locator("text=Storage").or(page.locator("text=Хранилище"))).toBeVisible();
    await expect(page.locator("text=Files").or(page.locator("text=Файлы"))).toBeVisible();
  });

  test("admin can open quota edit form", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/users/${testUserId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for quota card
    await expect(page.getByTestId("artifact-quota-card")).toBeVisible({ timeout: 10000 });

    // Click edit button
    await page.getByTestId("edit-quota-button").click();

    // Check edit form is visible
    await expect(page.getByTestId("quota-edit-form")).toBeVisible();
    await expect(page.getByTestId("quota-mb-input")).toBeVisible();
    await expect(page.getByTestId("quota-max-files-input")).toBeVisible();
  });

  test("admin can set custom quota for user", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/users/${testUserId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for quota card
    await expect(page.getByTestId("artifact-quota-card")).toBeVisible({ timeout: 10000 });

    // Click edit button
    await page.getByTestId("edit-quota-button").click();

    // Fill in custom quota values
    await page.getByTestId("quota-mb-input").fill("200");
    await page.getByTestId("quota-max-files-input").fill("100");

    // Save
    await page.getByTestId("save-quota-button").click();

    // Wait for save to complete and form to close
    await expect(page.getByTestId("quota-edit-form")).not.toBeVisible({ timeout: 10000 });

    // Check custom quota is now shown
    await expect(page.locator("text=200 MB")).toBeVisible();
    await expect(page.locator("text=100 files")).toBeVisible();
  });

  test("admin can reset quota to default", async ({ page }) => {
    // First set a custom quota
    await page.goto(`${BASE_URL}/admin/users/${testUserId}`);
    await page.waitForLoadState("domcontentloaded");

    await expect(page.getByTestId("artifact-quota-card")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("edit-quota-button").click();

    // Set custom values first
    await page.getByTestId("quota-mb-input").fill("150");
    await page.getByTestId("quota-max-files-input").fill("75");
    await page.getByTestId("save-quota-button").click();
    await expect(page.getByTestId("quota-edit-form")).not.toBeVisible({ timeout: 10000 });

    // Now reset to default
    await page.getByTestId("edit-quota-button").click();
    await page.getByTestId("reset-quota-button").click();

    // Wait for reset to complete
    await expect(page.getByTestId("quota-edit-form")).not.toBeVisible({ timeout: 10000 });

    // Check that "Using global default" message is shown
    await expect(
      page.locator("text=Using global default").or(page.locator("text=глобальное значение")),
    ).toBeVisible();
  });
});

test.describe("Admin Artifacts - Access Control", () => {
  test("non-admin cannot access admin artifacts page", async ({ page }) => {
    // Create a regular user
    const testUserEmail = `e2e-nonadmin-${Date.now()}@test.local`;
    const testUserPassword = "TestPassword123!";
    const result = await createTestUser(testUserEmail, testUserPassword, "Non-Admin Test", true);
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }

    // Login as regular user
    await login(page, testUserEmail, testUserPassword);

    // Try to access admin artifacts page
    await page.goto(`${BASE_URL}/admin/artifacts`);

    // Should be redirected or see error (depends on implementation)
    // Either redirected to app or shown forbidden error
    await page.waitForLoadState("domcontentloaded");

    // Should not see the admin artifacts page content
    const url = page.url();
    const hasAdminContent = await page
      .locator("h1:has-text('Artifacts Management')")
      .isVisible()
      .catch(() => false);

    // Either redirected away from admin or page doesn't show admin content
    expect(url.includes("/admin/artifacts") && hasAdminContent).toBe(false);
  });
});
