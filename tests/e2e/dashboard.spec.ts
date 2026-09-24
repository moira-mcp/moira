/**
 * Dashboard E2E Tests
 * The home page: its work area (runs in progress with their step, recent runs, the flows run
 * most, each with a ready-to-say prompt), the connection card and the documentation links.
 */

import { test, expect } from "./fixtures.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";
import {
  callMCPTool,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
} from "../utils/mcp-auth.js";

import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Home work area", () => {
  const password = "TestPass123!";

  test("a new user gets one empty state with the prompt to start", async ({ page }) => {
    const email = `work-new-${Date.now()}@example.com`;
    expect((await createTestUser(email, password, "Work New")).success).toBe(true);
    await login(page, email, password);
    await page.goto(`${BASE_URL}/`);

    const empty = page.getByTestId("work-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText(/Use Moira to run/);
    await expect(page.getByTestId("work-in-progress")).toHaveCount(0);
    await expect(page.getByTestId("stat-card")).toHaveCount(0);

    // While the recommended flows are shown the empty state points to them; once the reader
    // hides that panel for good, it points to the flow list instead
    const next = page.getByTestId("work-empty-next");
    await expect(next).toHaveText("Or pick one of the recommended flows above.");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings") && response.request().method() === "PUT",
    );
    await page.locator('[data-testid="hide-panel"][data-panel="home-recommended"]').click();
    expect((await saved).ok()).toBe(true);
    await next.getByRole("link").click();
    await expect(page).toHaveURL(/\/workflows$/);
  });

  test("a run in progress shows its step, opens, and copies a prompt to continue; the flow offers its prompt", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const email = `work-returning-${Date.now()}@example.com`;
    expect((await createTestUser(email, password, "Work Returning", true)).success).toBe(true);
    const mcp = await createAuthenticatedMCPClient({ email, password });
    const name = `Work area flow ${Date.now()}`;
    let processId: string;
    let workflowId: string;
    try {
      workflowId = (
        await callMCPTool(mcp.client, "manage", {
          action: "create",
          workflow: {
            metadata: { name, version: "1.0.0", description: "A flow the home page lists" },
            nodes: [
              { id: "start", type: "start", connections: { default: "draft" } },
              {
                id: "draft",
                type: "agent-directive",
                metadata: { displayName: "Write the draft" },
                directive: "Write the draft.",
                completionCondition: "The draft is written.",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
        })
      ).workflowId;
      processId = (await startWorkflowExecutionState(mcp.client, workflowId)).processId;
    } finally {
      await mcp.cleanup();
    }

    await login(page, email, password);
    await page.goto(`${BASE_URL}/`);

    const run = page.getByTestId(`work-active-${processId}`);
    await expect(run).toBeVisible();
    await expect(run.locator('[data-slot="card-title"]')).toHaveText(name);
    await expect(run.getByTestId("work-active-step")).toHaveText("At: Write the draft");

    await run.hover();
    await page.getByTestId(`work-resume-${processId}`).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `Continue the Moira run ${processId} from where it stopped.`,
    );

    const flow = page.getByTestId(`work-flow-${workflowId}`);
    await expect(flow.getByTestId("work-flow-prompt")).toHaveText(
      `Use Moira to run ${name} for this task: …`,
    );
    await expect(flow.locator('[data-slot="card-meta"]')).toContainText("1 run");

    await run.locator('[data-slot="card-title"]').click();
    await expect(page).toHaveURL(new RegExp(`/executions/${processId}`));
  });
});

test.describe("Dashboard Quick Actions", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
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

  test("Quick Start card displays per-client tabs and configuration", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check the connection section exists (step 1 of the home page's three steps)
    await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeVisible();

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

  test("documentation links open the Russian documentation for a Russian reader", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/?lang=ru`);
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator('a[data-sidebar="menu-button"][href="/ru/docs/"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "Читать документацию" })).toHaveAttribute(
      "href",
      "/ru/docs/getting-started/quickstart/",
    );
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
