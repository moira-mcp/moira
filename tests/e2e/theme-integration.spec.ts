/**
 * Theme Integration Tests
 *
 * IMPORTANT: This is the ONLY test file that should modify theme settings.
 * All theme-related checks are consolidated here to avoid conflicts between tests.
 * Other tests must NOT click on theme toggle or modify theme settings.
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

test.describe("Theme Integration", () => {
  test.setTimeout(60000);

  test("complete theme functionality - toggle, persistence, and React Flow", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Dismiss Beta Version banner — it overlaps the sidebar avatar button
    const betaDismiss = page.locator(
      'button[aria-label="Dismiss beta warning"], button:has-text("Dismiss beta warning")',
    );
    if (await betaDismiss.isVisible({ timeout: 3000 }).catch(() => false)) {
      await betaDismiss.click();
      await expect(betaDismiss)
        .not.toBeVisible({ timeout: 3000 })
        .catch(() => {});
    }

    // Workflow 'react-flow-theme-test' is created in global-setup.ts
    // No need to load it here

    const avatar = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();

    // Dismiss Radix dropdown menu safely using outside-click handler
    const dismissMenu = async () => {
      const menu = page.locator('[role="menu"]');
      if (await menu.isVisible().catch(() => false)) {
        // Radix DismissableLayer listens for pointerdown outside menu
        await page.evaluate(() => {
          document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        });
        await page.waitForTimeout(300);
      }
    };

    // Helper to get current theme from dropdown
    const getCurrentTheme = async (): Promise<string> => {
      await avatar.click({ force: true });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      const themeText = await page.locator('[role="menu"]').locator("text=/Theme:/").textContent();
      await dismissMenu();
      return themeText?.replace("Theme: ", "") || "unknown";
    };

    // Helper to click theme and wait for save
    const clickThemeToggle = async () => {
      await dismissMenu();

      await avatar.click({ force: true });
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible();

      // Get current theme text before click
      const themeTextBefore = await menu.locator("text=/Theme:/").textContent();

      // Click theme toggle
      await menu.locator("text=/Theme:/").click({ force: true });

      // Wait for either PUT response OR theme text change (handles case when no network request)
      await Promise.race([
        page
          .waitForResponse(
            (response) =>
              response.url().includes("/api/settings") && response.request().method() === "PUT",
            { timeout: 5000 },
          )
          .catch(() => {}),
        page
          .waitForFunction(
            (before) => {
              const menuEl = document.querySelector('[role="menu"]');
              const themeEl = menuEl?.querySelector('[class*="text-"]');
              return themeEl?.textContent !== before;
            },
            themeTextBefore,
            { timeout: 5000 },
          )
          .catch(() => {}),
      ]);

      // Dismiss menu if still open after toggle
      await dismissMenu();
    };

    // Helper to verify current theme
    const verifyTheme = async (expected: string) => {
      await avatar.click({ force: true });
      await expect(page.locator('[role="menu"]')).toBeVisible();
      await expect(
        page.locator('[role="menu"]').locator(`text=/Theme: ${expected}/`),
      ).toBeVisible();
      await dismissMenu();
    };

    // === PART 0: Initialize to system theme ===
    // Ensure test starts from known state regardless of previous test runs
    let currentTheme = await getCurrentTheme();
    let initAttempts = 0;
    while (currentTheme !== "system" && initAttempts < 3) {
      await clickThemeToggle();
      currentTheme = await getCurrentTheme();
      initAttempts++;
    }

    // === PART 1: Theme Toggle Cycles ===
    // Now we're at system theme - start cycling
    // Click 1: system → light
    await clickThemeToggle();
    await verifyTheme("light");

    // Click 2: light → dark
    await clickThemeToggle();
    await expect(page.locator("html")).toHaveClass(/dark/);

    // Click 3: dark → system
    await clickThemeToggle();
    await verifyTheme("system");

    // === PART 2: Theme Persistence ===
    // Set to dark for persistence test (system → light → dark)
    await clickThemeToggle(); // system → light
    await clickThemeToggle(); // light → dark

    await expect(page.locator("html")).toHaveClass(/dark/);

    // Reload page
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Dismiss Beta banner again after reload
    if (await betaDismiss.isVisible({ timeout: 3000 }).catch(() => false)) {
      await betaDismiss.click();
      await expect(betaDismiss)
        .not.toBeVisible({ timeout: 3000 })
        .catch(() => {});
    }

    // Verify dark theme persisted
    await expect(page.locator("html")).toHaveClass(/dark/);

    // === PART 3: React Flow Theme Integration ===
    // Re-define helpers with fresh locators after reload
    const avatarFresh = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();

    const clickThemeToggleFresh = async () => {
      await dismissMenu();

      await avatarFresh.click({ force: true });
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible();

      // Get current theme text before click
      const themeTextBefore = await menu.locator("text=/Theme:/").textContent();

      // Click theme toggle
      await menu.locator("text=/Theme:/").click({ force: true });

      // Wait for either PUT response OR theme text change
      await Promise.race([
        page
          .waitForResponse(
            (response) =>
              response.url().includes("/api/settings") && response.request().method() === "PUT",
            { timeout: 5000 },
          )
          .catch(() => {}),
        page
          .waitForFunction(
            (before) => {
              const menuEl = document.querySelector('[role="menu"]');
              const themeEl = menuEl?.querySelector('[class*="text-"]');
              return themeEl?.textContent !== before;
            },
            themeTextBefore,
            { timeout: 5000 },
          )
          .catch(() => {}),
      ]);

      // Dismiss menu if still open
      await dismissMenu();
    };

    // Navigate to workflows
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Dismiss Beta banner on new page
    if (await betaDismiss.isVisible({ timeout: 2000 }).catch(() => false)) {
      await betaDismiss.click();
    }

    // Search for test workflow (required because there are 800+ workflows)
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("react-flow-theme-test");
    await page.waitForTimeout(500);

    // Click on test workflow
    await page.click("text=React Flow Theme Test");

    // Wait for React Flow to load
    const reactFlowDiv = page.locator(".react-flow").first();
    await expect(reactFlowDiv).toBeVisible({ timeout: 10000 });

    // Verify nodes exist in dark theme
    const nodesCount = await page.evaluate(() => {
      return document.querySelectorAll(".react-flow__node").length;
    });
    expect(nodesCount).toBeGreaterThan(0);

    // Switch to light theme (dark → system → light)
    await clickThemeToggleFresh(); // dark → system
    await clickThemeToggleFresh(); // system → light

    // Verify nodes still visible in light theme
    const lightNodesCount = await page.evaluate(() => {
      return document.querySelectorAll(".react-flow__node").length;
    });
    expect(lightNodesCount).toBe(nodesCount);

    // Get background in light theme
    const lightBg = await page.evaluate(() => {
      const reactFlow = document.querySelector(".react-flow");
      return reactFlow ? window.getComputedStyle(reactFlow).backgroundColor : null;
    });

    // Verify background is valid React Flow color
    const validBgs = ["rgb(250, 251, 252)", "rgb(26, 26, 26)"];
    expect(validBgs).toContain(lightBg);

    // === CLEANUP: Reset to system theme ===
    // light → dark → system
    await clickThemeToggleFresh(); // light → dark
    await clickThemeToggleFresh(); // dark → system
  });
});
