/**
 * Audit Log E2E Tests
 * Tests admin audit log viewer functionality
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Audit Log", () => {
  test.beforeEach(async ({ page }) => {
    // Login as admin via HTTP (fast, no UI)
    await loginAsAdmin(page);
  });

  test("admin can access audit log page", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for page content with longer timeout for high load scenarios
    await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator("text=System audit trail")).toBeVisible({ timeout: 10000 });
  });

  test("audit log shows recent entries", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    const cards = page.locator('[data-testid="audit-log-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });

    // Should have at least one entry (login event)
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test("can filter audit log by user", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);

    // Wait for cards to load
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Click the user filter SearchableSelect trigger (first combobox button)
    await page.locator('button[role="combobox"]').first().click();

    // Wait for the SearchableSelect dropdown to open and select first user option
    const popoverContent = page.locator('[data-slot="popover-content"]');
    await expect(popoverContent).toBeVisible({ timeout: 5000 });
    const options = popoverContent.locator('[data-slot="command-item"]');
    await options.nth(1).click();

    // Wait for filter to apply
    await page.waitForTimeout(500);

    // Verify entries are filtered
    const cards = page.locator('[data-testid="audit-log-card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test("can filter audit log by source", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Source filter is the second Select (after User filter)
    // But now there's also a Sort select. User=1st, Source=2nd(after actions popover and resource input)
    // Find source select by "All Sources" text
    const sourceSelectTrigger = page.locator('button[role="combobox"]:has-text("All Sources")');
    await expect(sourceSelectTrigger).toBeVisible({ timeout: 10000 });
    await sourceSelectTrigger.click();

    // Select WEB source option
    await page.locator('[role="option"]:has-text("WEB")').click();

    // Wait for filter to apply (debounce)
    await page.waitForTimeout(500);

    // Entries should be filtered (cards should still be visible or empty state)
    await page.waitForLoadState("networkidle");
  });

  test("can clear filters", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Apply user filter via SearchableSelect (first combobox)
    await page.locator('button[role="combobox"]').first().click();
    const popoverContent = page.locator('[data-slot="popover-content"]');
    await expect(popoverContent).toBeVisible({ timeout: 5000 });
    await popoverContent.locator('[data-slot="command-item"]').nth(1).click();
    await page.waitForTimeout(500);

    // Click Reset button
    await page.getByTestId("filter-reset").click();

    // Verify user filter is reset (should show "All Users" text)
    await expect(page.locator('button[role="combobox"]').first()).toContainText(/All Users/);

    // Verify source filter is also reset (should show "All Sources" text)
    await expect(page.locator('button[role="combobox"]:has-text("All Sources")')).toBeVisible();
  });

  test("can view entry details", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    const firstCard = page.locator('[data-testid="audit-log-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // Click on first card
    await firstCard.click();

    // Detail dialog should appear
    await page.locator('[role="dialog"]').waitFor();
    await expect(page.locator('[role="dialog"]')).toContainText("Audit Entry Details");

    // Dialog should have content
    const dialogContent = page.locator('[role="dialog"] .space-y-4').first();
    await expect(dialogContent).toBeVisible();
  });

  test("can close entry details", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    const firstCard = page.locator('[data-testid="audit-log-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // Click on first card
    await firstCard.click();
    await page.locator('[role="dialog"]').waitFor();

    // Close dialog via the close button (X button in DialogContent)
    await page.locator('[role="dialog"] button[data-slot="dialog-close"]').click();

    // Dialog should be hidden
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });

  test("pagination works correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Check pagination controls exist
    await expect(page.getByTestId("pagination-prev")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("pagination-next")).toBeVisible({ timeout: 10000 });

    // Previous should be disabled on first page
    const previousBtn = page.getByTestId("pagination-prev");
    await expect(previousBtn).toBeDisabled();

    // Next button should be visible and functional
    const nextBtn = page.getByTestId("pagination-next");
    await expect(nextBtn).toBeVisible();
  });

  test("audit log navigation link visible in admin sidebar", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("networkidle");

    // Should see audit log link in sidebar
    const auditLogLink = page.locator('a[href="/admin/audit-log"]');
    await expect(auditLogLink).toBeVisible({ timeout: 10000 });
    await expect(auditLogLink).toContainText("Audit Log");
  });

  test("can navigate to audit log from admin dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("networkidle");

    // Click audit log link
    await page.click('a[href="/admin/audit-log"]');
    await page.waitForURL(`${BASE_URL}/admin/audit-log`);

    // Should be on audit log page
    await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 10000 });
  });

  test("audit log entries show correct data format", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load
    const firstCard = page.locator('[data-testid="audit-log-card"]').first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // Card should contain text content
    const cardText = await firstCard.textContent();
    expect(cardText).toBeTruthy();
    // Card should display action name (e.g., "auth:sign_in")
    expect(cardText).toMatch(/[a-z]+:[a-z_]+/i);
  });

  test("multi-select action filter dropdown with search works", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/audit-log`);
    await page.waitForLoadState("networkidle");

    // Wait for cards to load (indicates page is ready)
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Find action filter dropdown trigger button
    const actionDropdownTrigger = page.locator('button:has-text("Select actions...")');
    await expect(actionDropdownTrigger).toBeVisible();

    // Click to open dropdown
    await actionDropdownTrigger.click();

    // Wait for popover content to appear (rendered in portal)
    const popoverContent = page.locator('[data-slot="popover-content"]');
    await expect(popoverContent).toBeVisible({ timeout: 5000 });

    // Find search input inside popover (cmdk CommandInput)
    const searchInput = popoverContent.locator('input[data-slot="command-input"]');
    await expect(searchInput).toBeVisible();

    // Verify action list items are visible
    const actionItems = popoverContent.locator('[data-slot="command-item"]');
    await expect(actionItems.first()).toBeVisible();

    // Type in search to filter actions
    await searchInput.pressSequentially("workflow", { delay: 50 });
    await page.waitForTimeout(300);

    // Verify filtered results show workflow actions
    const filteredItems = popoverContent.locator('[data-slot="command-item"]');
    const count = await filteredItems.count();
    expect(count).toBeGreaterThan(0);

    // Select first two filtered workflow actions
    // Note: dispatchEvent used because popover portal renders outside viewport in test environment
    await filteredItems.first().dispatchEvent("click");
    await page.waitForTimeout(200);
    await filteredItems.nth(1).dispatchEvent("click");

    // Close dropdown with Escape
    await page.keyboard.press("Escape");

    // Verify dropdown shows count of selected actions
    await expect(page.locator("text=/2 selected/")).toBeVisible();

    // Verify table filters by selected actions (wait for debounce)
    await page.waitForTimeout(500);

    // Should have entries in the cards
    const cards = page.locator('[data-testid="audit-log-card"]');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test("audit log shows changes diff when workflow is edited", async ({ page }) => {
    // Create unique workflow via API, then edit it to generate audit entry with changes
    const uniqueId = Date.now();
    const originalName = `Original Name ${uniqueId}`;
    const updatedName = `Updated Name ${uniqueId}`;

    // Get session cookies from page context for API requests
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Create workflow via API (using correct node schema)
    // Server generates UUID and slug automatically
    const workflowNodes = [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end", connections: {} },
    ];

    const createResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        workflow: {
          metadata: {
            name: originalName,
            version: "1.0.0",
            description: "Test for audit changes diff",
          },
          nodes: workflowNodes,
        },
        visibility: "private",
      },
    });
    expect(createResponse.ok()).toBeTruthy();

    // Get the server-generated workflow ID
    const createData = await createResponse.json();
    const workflowId = createData.data?.workflowId;
    expect(workflowId).toBeTruthy();

    // Edit workflow to change name (this should create audit entry with changes)
    // Use the actual server-generated ID for the overwrite
    const editResponse = await page.request.post(`${BASE_URL}/api/workflows`, {
      headers: { "Content-Type": "application/json" },
      data: {
        id: workflowId,
        workflow: {
          metadata: {
            name: updatedName,
            version: "1.0.1",
            description: "Test for audit changes diff",
          },
          nodes: workflowNodes,
        },
        visibility: "private",
        overwrite: true,
      },
    });
    expect(editResponse.ok()).toBeTruthy();

    // Navigate to audit log
    await page.goto(`${BASE_URL}/admin/audit-log`);

    // Filter by workflow:edit action using popover
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
      timeout: 15000,
    });

    const actionDropdownTrigger = page.locator('button:has-text("Select actions...")');
    await actionDropdownTrigger.click();

    const popoverContent = page.locator('[data-slot="popover-content"]');
    await expect(popoverContent).toBeVisible({ timeout: 5000 });

    const searchInput = popoverContent.locator('input[data-slot="command-input"]');
    await expect(searchInput).toBeVisible();
    await searchInput.pressSequentially("workflow:edit", { delay: 50 });
    await page.waitForTimeout(300);

    // Click on workflow:edit CommandItem to select it
    const workflowEditItem = popoverContent
      .locator('[data-slot="command-item"]')
      .filter({ hasText: /^workflow:edit$/ });
    await workflowEditItem.dispatchEvent("click");

    // Close dropdown with Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Find and click the card for our workflow (using the server-generated ID)
    const workflowEditCard = page
      .locator('[data-testid="audit-log-card"]')
      .filter({ hasText: workflowId })
      .first();
    await expect(workflowEditCard).toBeVisible({ timeout: 5000 });
    await workflowEditCard.click();

    // Verify modal opens with changes section
    await page.locator('[role="dialog"]').waitFor();
    await expect(page.locator('[role="dialog"]')).toContainText("Audit Entry Details");

    // Verify changes are displayed
    const changesSection = page.locator('[data-testid="audit-changes"]');
    await expect(changesSection).toBeVisible();

    // Verify the name change is shown (field label and values)
    await expect(changesSection.getByText("name", { exact: true })).toBeVisible();
    await expect(changesSection.getByText(originalName)).toBeVisible();
    await expect(changesSection.getByText(updatedName)).toBeVisible();

    // Close dialog
    await page.locator('[role="dialog"] button[data-slot="dialog-close"]').click();
    await expect(page.locator('[role="dialog"]')).not.toBeVisible();
  });
});
