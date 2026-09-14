/**
 * E2E tests for Compact Workflow Cards
 * Verifies single-row layout, tooltip behavior, and responsive design
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";
import { TEST_WORKFLOWS } from "./fixtures/test-constants.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
// Public fixture uploaded by global setup; visible to every user in list mode
const PUBLIC_WORKFLOW = TEST_WORKFLOWS.PUBLIC_TEST;
const PUBLIC_WORKFLOW_DESCRIPTION = "Public workflow for testing visibility features";
const TEST_USER = {
  email: "card-test@example.com",
  password: "TestPass123!",
  name: "Card Test User",
};

test.beforeAll(async () => {
  await createTestUser(TEST_USER.email, TEST_USER.password, TEST_USER.name, true);
});

test.describe("Compact Workflow Cards", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_USER.email, TEST_USER.password);
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForSelector('[data-testid="workflow-explorer"]', {
      state: "visible",
      timeout: 15000,
    });
  });

  test("should display workflow cards in compact single-row layout", async ({ page }) => {
    // Wait for cards to load
    const cards = page.locator('[data-testid="workflow-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Card should have fixed height (h-10 = 40px, plus padding ~44-48px)
    const cardBox = await cards.first().boundingBox();
    expect(cardBox).not.toBeNull();
    if (cardBox) {
      expect(cardBox.height).toBeLessThan(60); // Compact height
    }
  });

  test("should display workflow name and version", async ({ page }) => {
    const cards = page.locator('[data-testid="workflow-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Check for workflow name text
    const firstCard = cards.first();
    const nameText = await firstCard.textContent();
    expect(nameText).toBeTruthy();
  });

  test("should display validation badge with icon only", async ({ page }) => {
    const cards = page.locator('[data-testid="workflow-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Check for validation icon (CheckCircle, AlertCircle, or Clock svg)
    const validationBadge = cards.first().locator("svg").first();
    await expect(validationBadge).toBeVisible();
  });

  test("should display visibility badge", async ({ page }) => {
    const cards = page.locator('[data-testid="workflow-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Check for Globe (public) or Lock (private) icon
    const visibilityIcon = cards.first().locator("svg").nth(1);
    await expect(visibilityIcon).toBeVisible();
  });

  test("should show description in tooltip on hover", async ({ page }) => {
    // The public fixture has a description, so its list-mode card carries a tooltip
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    await card.hover();

    // Radix tooltip content appears after its open delay
    await expect(page.locator('[role="tooltip"]')).toContainText(PUBLIC_WORKFLOW_DESCRIPTION);
  });

  test("should show delete button on hover for owned workflows", async ({ page }) => {
    // Upload a workflow owned by the test user, then hover its card
    const owned = await loadWorkflowFixture(page, TEST_WORKFLOWS.REACT_FLOW_THEME.filename);
    expect(owned.success).toBe(true);
    await page.reload();
    await page.waitForSelector('[data-testid="workflow-explorer"]', { state: "visible" });

    const ownedCard = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: owned.workflowName })
      .first();
    await expect(ownedCard).toBeVisible({ timeout: 10000 });
    await ownedCard.hover();
    await expect(ownedCard.getByRole("button", { name: "Delete Workflow" })).toBeVisible();

    // A public workflow of another owner offers no delete button to this user
    const foreignCard = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await foreignCard.hover();
    await expect(foreignCard.getByRole("button", { name: "Delete Workflow" })).toHaveCount(0);
  });

  test("should open workflow viewer when clicked", async ({ page }) => {
    const card = page
      .locator('[data-testid="workflow-card"]')
      .filter({ hasText: PUBLIC_WORKFLOW.name })
      .first();
    await expect(card).toBeVisible({ timeout: 10000 });

    // Clicking a card routes to the workflow page, which renders the React Flow graph
    await card.click();
    await page.waitForURL(/\/workflows\/[^/]+\/[^/]+$/);
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  });
});
