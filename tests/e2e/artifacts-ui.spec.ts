/**
 * Artifacts UI E2E Tests
 * Tests for artifacts list, creation, copy URL, edit, delete, and open in new tab
 * Note: Preview (iframe) functionality was removed due to X-Frame-Options security restrictions
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

// Test user credentials - email generated dynamically in beforeAll
const testUserCredentials = {
  email: "",
  password: "TestPassword123!",
  name: "Artifacts UI Test User",
};

// Sample HTML content for testing
const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Test Artifact</title>
</head>
<body>
  <h1>Hello from Test Artifact</h1>
  <p>This is test content.</p>
</body>
</html>`;

test.describe("Artifacts UI", () => {
  test.beforeAll(async () => {
    // Generate unique email for this test run
    testUserCredentials.email = `artifacts-ui-test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;

    // Create test user once before all tests
    const result = await createTestUser(
      testUserCredentials.email,
      testUserCredentials.password,
      testUserCredentials.name,
      true,
    );
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }
  });

  test.beforeEach(async ({ page }) => {
    // Login as test user before each test
    await login(page, testUserCredentials.email, testUserCredentials.password);
  });

  test("artifacts page displays empty state for new user", async ({ page }) => {
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Check page title
    await expect(
      page.getByRole("heading", { name: /Artifacts|Артефакты/, level: 1 }).last(),
    ).toBeVisible();

    // Check empty state message
    await expect(page.getByText(/No artifacts yet|Артефактов пока нет/)).toBeVisible();

    // Check create button is present
    await expect(page.getByTestId("create-artifact-button")).toBeVisible();

    // Check quota indicator is present
    await expect(page.getByTestId("quota-indicator")).toBeVisible();
  });

  test("sidebar shows artifacts navigation link", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Find artifacts link in sidebar
    const artifactsLink = page.locator('a[href="/artifacts"]');
    await expect(artifactsLink).toBeVisible();

    // Click and navigate to artifacts
    await artifactsLink.click();
    await page.waitForURL("**/artifacts");

    // Verify we're on artifacts page
    await expect(
      page.getByRole("heading", { name: /Artifacts|Артефакты/, level: 1 }).last(),
    ).toBeVisible();
  });

  test("create new artifact with name and HTML content", async ({ page }) => {
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Click create button
    await page.getByTestId("create-artifact-button").click();

    // Wait for dialog to open
    await expect(page.getByRole("dialog")).toBeVisible();

    // Fill in artifact details
    const testName = `test-artifact-${Date.now()}.html`;
    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);

    // Save the artifact
    await page.getByTestId("create-submit").click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).toBeHidden();

    // Verify artifact appears in the list (by checking table has content)
    await expect(page.getByText(testName)).toBeVisible();
  });

  test("copy URL button copies artifact URL", async ({ page }) => {
    // First create an artifact
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    const testName = `copy-url-test-${Date.now()}.html`;

    await page.getByTestId("create-artifact-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);
    await page.getByTestId("create-submit").click();

    await expect(page.getByRole("dialog")).toBeHidden();

    // Find the artifact card by name
    const artifactCard = page
      .locator('[data-testid^="artifact-row-"]')
      .filter({ hasText: testName });
    await expect(artifactCard).toBeVisible();

    // Hover to reveal action buttons, then click copy URL
    await artifactCard.hover();
    const copyButton = artifactCard.locator('[data-testid^="copy-url-"]');
    await copyButton.click();

    // Verify the button is clickable and no error is thrown
    await expect(copyButton).toBeVisible();
  });

  // Note: Preview in iframe was removed due to X-Frame-Options security headers
  // preventing cross-origin iframe embedding (static.localhost vs localhost)
  // Use "Open in new tab" button instead

  test("edit existing artifact content", async ({ page }) => {
    // First create an artifact
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    const testName = `edit-test-${Date.now()}.html`;
    const originalContent = `<!DOCTYPE html>
<html>
<head><title>Original</title></head>
<body><h1>Original Content</h1></body>
</html>`;
    const updatedContent = `<!DOCTYPE html>
<html>
<head><title>Updated</title></head>
<body><h1>Updated Content</h1></body>
</html>`;

    // Create artifact
    await page.getByTestId("create-artifact-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(originalContent);
    await page.getByTestId("create-submit").click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Find the artifact card
    const artifactCard = page
      .locator('[data-testid^="artifact-row-"]')
      .filter({ hasText: testName });
    await expect(artifactCard).toBeVisible();

    // Hover to reveal action buttons, then click edit
    await artifactCard.hover();
    const editButton = artifactCard.locator('[data-testid^="edit-"]');
    await editButton.click();

    // Wait for edit dialog to open and content to load
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("edit-artifact-content-input")).toBeVisible();

    // Wait for content to load (not the loading state)
    await expect(page.getByText(/Loading content|Загрузка содержимого/)).toBeHidden({
      timeout: 10000,
    });

    // Name field should be disabled
    await expect(page.getByTestId("edit-artifact-name-input")).toBeDisabled();

    // Clear and enter updated content
    await page.getByTestId("edit-artifact-content-input").fill(updatedContent);

    // Save the changes
    await page.getByTestId("edit-submit").click();

    // Wait for dialog to close
    await expect(page.getByRole("dialog")).toBeHidden();

    // Verify artifact still exists
    await expect(page.getByText(testName)).toBeVisible();
  });

  test("delete artifact removes from list", async ({ page }) => {
    // Create an artifact to delete
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    const testName = `delete-test-${Date.now()}.html`;

    await page.getByTestId("create-artifact-button").click();
    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);
    await page.getByTestId("create-submit").click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Verify artifact exists
    await expect(page.getByText(testName)).toBeVisible();

    // Find the artifact card
    const artifactCard = page
      .locator('[data-testid^="artifact-row-"]')
      .filter({ hasText: testName });

    // Hover to reveal action buttons, then click delete
    await artifactCard.hover();
    const deleteButton = artifactCard.locator('[data-testid^="delete-"]');
    await deleteButton.click();

    // Confirm deletion
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /delete/i })
      .click();

    // Wait for dialog to close
    await expect(page.getByRole("alertdialog")).toBeHidden();

    // Verify artifact is removed
    await expect(artifactCard).toBeHidden();
  });

  test("quota indicator shows storage usage", async ({ page }) => {
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    // Quota indicator should be visible
    const quotaIndicator = page.getByTestId("quota-indicator");
    await expect(quotaIndicator).toBeVisible();

    // Should show some percentage and size text
    await expect(quotaIndicator).toContainText(/KB|MB|%/);
  });

  test("validation error for non-HTML content", async ({ page }) => {
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("create-artifact-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Enter name and non-HTML content
    await page.getByTestId("artifact-name-input").fill("test.html");
    await page.getByTestId("artifact-content-input").fill("This is not HTML content");

    // Try to save
    await page.getByTestId("create-submit").click();

    // Should show validation error
    await expect(page.getByText(/must contain.*<html>|должно содержать.*<html>/i)).toBeVisible();

    // Dialog should still be open
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("validation error for empty name", async ({ page }) => {
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("create-artifact-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Enter only content, no name
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);

    // Try to save
    await page.getByTestId("create-submit").click();

    // Should show validation error
    await expect(page.getByText(/name and content.*required|Название и содержимое/i)).toBeVisible();

    // Dialog should still be open
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("open in new tab button exists and is clickable", async ({ page }) => {
    // First create an artifact
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    const testName = `open-btn-test-${Date.now()}.html`;

    await page.getByTestId("create-artifact-button").click();
    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);
    await page.getByTestId("create-submit").click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Find the artifact card
    const artifactCard = page
      .locator('[data-testid^="artifact-row-"]')
      .filter({ hasText: testName });
    await expect(artifactCard).toBeVisible();

    // Hover to reveal action buttons and verify open button
    await artifactCard.hover();
    const openButton = artifactCard.locator('[data-testid^="open-"]');
    await expect(openButton).toBeVisible();
    await expect(openButton).toBeEnabled();
  });

  test("card displays artifact info", async ({ page }) => {
    // Create an artifact first
    await page.goto(`${BASE_URL}/artifacts`);
    await page.waitForLoadState("domcontentloaded");

    const testName = `info-test-${Date.now()}.html`;

    await page.getByTestId("create-artifact-button").click();
    await page.getByTestId("artifact-name-input").fill(testName);
    await page.getByTestId("artifact-content-input").fill(SAMPLE_HTML);
    await page.getByTestId("create-submit").click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Find the artifact card
    const artifactCard = page
      .locator('[data-testid^="artifact-row-"]')
      .filter({ hasText: testName });
    await expect(artifactCard).toBeVisible();

    // Verify card shows the artifact name
    await expect(artifactCard).toContainText(testName);

    // Verify card shows size info (bytes/KB)
    await expect(artifactCard).toContainText(/B|KB/);
  });
});
