import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

test.describe("UserMenu Verification", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");
  });

  test("1. UserMenu component exists in sidebar", async ({ page }) => {
    // Use sidebar-footer selector - email is in nested element inside button
    const sidebarFooter = page.locator('[data-slot="sidebar-footer"]');
    const userMenuButton = sidebarFooter.locator("button");
    await expect(userMenuButton).toBeVisible();
    // Verify email text is visible somewhere in sidebar footer
    await expect(sidebarFooter.locator(`text=${ADMIN_CREDENTIALS.email}`)).toBeVisible();
    console.log("✅ Function 1: UserMenu component visible");
  });

  test("2. Sidebar contains UserMenu at bottom", async ({ page }) => {
    const sidebarFooter = page.locator('[data-slot="sidebar-footer"]');
    const userMenuButton = sidebarFooter.locator("button");
    await expect(userMenuButton).toBeVisible();
    // Verify email is visible in the button (expanded sidebar shows email)
    await expect(page.locator(`text=${ADMIN_CREDENTIALS.email}`)).toBeVisible();
    console.log("✅ Function 2: UserMenu in sidebar bottom");
  });

  test("3. Adaptive display - expanded shows name+email", async ({ page }) => {
    // Sidebar is expanded by default
    const userEmail = page.locator(`text=${ADMIN_CREDENTIALS.email}`);
    await expect(userEmail).toBeVisible({ timeout: 10000 });
    console.log("✅ Function 3: Adaptive display works (expanded)");
  });

  test("4. Theme toggle inside dropdown", async ({ page }) => {
    const avatar = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
    await avatar.click();

    // Wait for dropdown to be visible
    await expect(page.locator("text=/Theme:/")).toBeVisible();

    const themeItem = page.locator("text=/Theme:/");
    await expect(themeItem).toBeVisible();
    console.log("✅ Function 4: Theme toggle in dropdown");
  });

  test("5. Better Auth UI replaced with custom", async ({ page }) => {
    // Check no Better Auth UI button exists
    const betterAuthButton = page.locator('[class*="better-auth"]');
    const count = await betterAuthButton.count();
    expect(count).toBe(0);
    console.log("✅ Function 5: Better Auth UI removed");
  });

  test("6. AppHeader removed - no duplicate logo", async ({ page }) => {
    // Check there's no separate header element outside sidebar
    // The logo should be in sidebar header only
    const sidebarHeader = page.locator('[data-slot="sidebar-header"]');
    await expect(sidebarHeader).toBeVisible();

    // Mobile header is allowed (for mobile navigation trigger)
    // but should not have duplicate logo/branding as the old AppHeader did
    const mainContent = page.locator('[data-slot="sidebar-inset"]');
    const headersInMain = mainContent.locator("header");
    const count = await headersInMain.count();
    // Allow 0 or 1 header (mobile header is ok, it's for navigation trigger only)
    expect(count).toBeLessThanOrEqual(1);

    // If there's a header in main, it should be the mobile navigation header (hidden on desktop)
    if (count === 1) {
      const mobileHeader = headersInMain.first();
      // Mobile header should have md:hidden class (hidden on desktop)
      await expect(mobileHeader).toHaveClass(/md:hidden/);
    }
    console.log("✅ Function 6: No duplicate logo header (mobile nav header allowed)");
  });

  test("7. AppFooter removed", async ({ page }) => {
    const footer = await page.locator("footer").count();
    expect(footer).toBe(0);
    console.log("✅ Function 7: No footer");
  });

  test("8. Refresh button removed", async ({ page }) => {
    const refreshButton = page.locator('text="Refresh"');
    const count = await refreshButton.count();
    expect(count).toBe(0);
    console.log("✅ Function 8: Refresh button removed");
  });

  test("9. Connection status removed", async ({ page }) => {
    const statusBadge = page.locator("text=/Connected|Disconnected/");
    const count = await statusBadge.count();
    expect(count).toBe(0);
    console.log("✅ Function 9: Status badge removed");
  });

  test("10. Logout works from dropdown", async ({ page }) => {
    const avatar = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
    await avatar.click();

    // Wait for dropdown to be visible
    await expect(page.locator("text=Logout")).toBeVisible();

    const logoutItem = page.locator("text=Logout");
    await expect(logoutItem).toBeVisible();
    await logoutItem.click();

    await page.waitForURL("**/login");
    console.log("✅ Function 10: Logout works");
  });
});
