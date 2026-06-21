/**
 * Dashboard E2E Tests
 * Tests dashboard statistics, recent activity, and navigation
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Dashboard Stats & Quick Actions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("dashboard loads with stat cards showing real data", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check stat cards are visible (using role=button stat cards)
    await expect(page.getByText("Total Workflows")).toBeVisible();
    await expect(page.getByRole("button", { name: /Total Workflows/i })).toBeVisible();

    // Check that stat cards have numeric values
    const workflowsCard = page.getByRole("button", { name: /Total Workflows/i });
    const valueEl = workflowsCard.locator(".text-2xl");
    const workflowsCount = await valueEl.textContent();
    expect(workflowsCount).not.toBe("-");
    expect(workflowsCount).not.toBe("");
    const count = parseInt(workflowsCount || "0");
    expect(count).toBeGreaterThanOrEqual(0);

    console.log(`✓ Dashboard stat cards loaded with real data (${count} workflows)`);
  });

  test("stat cards are clickable and navigate correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for stat cards to load with data
    await expect(page.getByText("Total Workflows")).toBeVisible();

    // Close beta modal if present
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Click on Workflows card (stat card with role=button)
    const workflowsCard = page.getByRole("button", { name: /Total Workflows/i });
    await workflowsCard.click();
    await page.waitForURL(`${BASE_URL}/workflows`);
    expect(page.url()).toBe(`${BASE_URL}/workflows`);

    // Go back to dashboard
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Close beta modal again (appears after navigation)
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Click on Notes stat card (use the card with Notes label text)
    const notesStatCards = page.locator('[role="button"]').filter({ hasText: /^Notes/ });
    await notesStatCards.first().click();
    await page.waitForURL(`${BASE_URL}/notes`);
    expect(page.url()).toBe(`${BASE_URL}/notes`);

    console.log("✓ Stat cards navigate correctly");
  });

  test("dashboard has no dead-end action buttons", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Close beta modal if present
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Quick Actions section should not exist (removed as dead-end)
    await expect(page.getByText("Quick Actions")).not.toBeVisible();

    // No "Run Workflow" or "Delete" buttons should exist on dashboard
    await expect(page.getByRole("button", { name: /Run Workflow/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /^Delete$/i })).not.toBeVisible();

    console.log("✓ No dead-end action buttons on dashboard");
  });

  test("recent workflows section displays correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check Recent Workflows section
    await expect(page.getByText("Recent Workflows")).toBeVisible();

    // Check if there's at least one workflow card or empty state
    const noWorkflows = await page.getByText(/No workflows yet/i).isVisible();

    if (!noWorkflows) {
      // Should have workflow items
      const workflowItems = await page.locator(".border-border .font-medium").count();
      expect(workflowItems).toBeGreaterThan(0);

      console.log(`✓ Recent workflows displayed (${workflowItems} workflows)`);
    } else {
      console.log("✓ Recent workflows empty state displayed");
    }
  });

  test("recent executions section displays correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check Recent Executions section
    await expect(page.getByText("Recent Executions")).toBeVisible();

    // Check if there's execution or empty state
    const noExecutions = await page.getByText(/No executions yet/i).isVisible();

    if (!noExecutions) {
      // Should have execution with status (completed/failed/running)
      const hasStatus = await page.locator("text=/completed|failed|running/i").count();
      expect(hasStatus).toBeGreaterThan(0);

      console.log(`✓ Recent executions displayed (${hasStatus} executions)`);
    } else {
      console.log("✓ Recent executions empty state displayed");
    }
  });

  test("dashboard loads data from API", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for stat cards to load with data
    await expect(page.getByText("Total Workflows")).toBeVisible();

    // Check that stat cards loaded (not showing loading state)
    const loadingText = await page.getByText("Loading dashboard data").isVisible();
    expect(loadingText).toBe(false);

    // Verify we have numeric data
    const workflowsStatCard = page.getByRole("button", { name: /Total Workflows/i });
    const hasWorkflowCount = await workflowsStatCard.locator(".text-2xl").textContent();
    expect(hasWorkflowCount).not.toBe("-");

    console.log("✓ Dashboard API integration working");
  });

  test("Quick Start card displays per-client tabs and configuration", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check Quick Start section exists
    await expect(page.getByText("Quick Start")).toBeVisible();

    // Check tab list with client names
    await expect(page.getByRole("tab", { name: "Claude Web" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Claude Code" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Cursor" })).toBeVisible();

    // Click Claude Code tab to see config with code block
    await page.getByRole("tab", { name: "Claude Code" }).click();
    const panel = page.getByRole("tabpanel", { name: "Claude Code" });
    await expect(panel).toBeVisible();
    await expect(panel.locator("code").first()).toBeVisible();
    const configText = await panel.locator("code").first().textContent();
    expect(configText).toContain("claude");
    expect(configText).toContain("mcp");
    expect(configText).toContain("moira");

    // Check documentation link in Quick Start card (not sidebar)
    await expect(page.getByRole("link", { name: "Read the documentation" })).toBeVisible();

    console.log("✓ Quick Start card displays correctly");
  });

  test("Quick Start copy button works", async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Close beta modal if present
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Switch to Claude Code tab which has a copy button
    await page.getByRole("tab", { name: "Claude Code" }).click();

    // Click copy button
    const copyButton = page.getByRole("button", { name: /Copy/i }).first();
    await copyButton.click();

    // Check button text changes to "Copied!"
    await expect(page.getByText("Copied!")).toBeVisible();

    // Verify clipboard content
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardContent).toContain("mcp");
    expect(clipboardContent).toContain("moira");

    console.log("✓ Quick Start copy functionality works");
  });
});

test.describe("Dashboard Documentation Link", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("sidebar contains docs link", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check docs link in sidebar (the link itself has data-sidebar attribute)
    // href can be /docs/ (English) or /ru/docs/ (Russian) depending on language
    const docsLink = page.locator('a[data-sidebar="menu-button"][href^="/docs"]');
    await expect(docsLink).toBeVisible();

    // Doc links should open in the same tab (no target="_blank")
    const target = await docsLink.getAttribute("target");
    expect(target).toBeNull();

    console.log("✓ Docs link in sidebar configured correctly (same tab)");
  });

  test("docs link opens documentation page in same tab", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Use sidebar docs link specifically (has data-sidebar attribute)
    const sidebarDocsLink = page.locator('a[data-sidebar="menu-button"][href^="/docs"]');

    // Click docs link — should navigate in same tab
    await sidebarDocsLink.click();
    await page.waitForLoadState("domcontentloaded");

    // Check URL is /docs/
    expect(page.url()).toContain("/docs/");

    console.log("✓ Docs link opens documentation in same tab");
  });
});
