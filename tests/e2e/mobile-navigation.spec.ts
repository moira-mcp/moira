/**
 * E2E Test: Mobile Navigation Visibility
 *
 * Tests that navigation buttons are visible and meet accessibility guidelines
 * on mobile viewports.
 *
 * Related issue: #253
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

// Mobile viewport (iPhone X)
const MOBILE_VIEWPORT = { width: 375, height: 812 };

// Apple touch target minimum size
const MIN_TOUCH_TARGET = 44;

test.describe("Mobile Navigation", () => {
  test.describe("Web App", () => {
    test("Mobile header with sidebar trigger is visible", async ({ browser }) => {
      const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
      const page = await context.newPage();

      await loginAsAdmin(page); // autoAcceptBeta=true by default
      await page.waitForLoadState("domcontentloaded");

      // Mobile header should be visible
      const mobileHeader = page.locator("header.flex.md\\:hidden");
      await expect(mobileHeader).toBeVisible();

      await context.close();
    });

    test("Sidebar trigger meets minimum touch target size (44x44px)", async ({ browser }) => {
      const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
      const page = await context.newPage();

      await loginAsAdmin(page);
      await page.waitForLoadState("domcontentloaded");

      const trigger = page.locator('[data-sidebar="trigger"]');
      await expect(trigger).toBeVisible();

      const box = await trigger.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(box!.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

      await context.close();
    });

    test("Sidebar opens when trigger is clicked", async ({ browser }) => {
      const context = await browser.newContext({ viewport: MOBILE_VIEWPORT });
      const page = await context.newPage();

      await loginAsAdmin(page);
      await page.waitForLoadState("domcontentloaded");

      // Click sidebar trigger
      const trigger = page.locator('[data-sidebar="trigger"]');
      await trigger.click();

      // Mobile sidebar should open (it's a Sheet component)
      const sidebar = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
      await expect(sidebar).toBeVisible();

      await context.close();
    });
  });
});
