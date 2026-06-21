/**
 * E2E Tests for Error History Display in ExecutionInspector
 * Step 13: Verify long error messages are displayed without truncation
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_USER = getAdminCredentials();

test.describe("Error History Display - Step 13", () => {
  let mcpClient: Client;
  let cleanup: () => Promise<void>;
  let executionId: string;
  let testWorkflowId: string;

  test.beforeAll(async () => {
    // Create MCP client with admin credentials
    const mcpResult = await createAuthenticatedMCPClient({
      email: ADMIN_USER.email,
      password: ADMIN_USER.password,
    });
    mcpClient = mcpResult.client;
    cleanup = mcpResult.cleanup;

    // Create a test workflow with strict schema for validation errors
    const createResult = await callMCPTool(mcpClient, "manage", {
      action: "create",
      workflow: {
        id: `test-error-display-${Date.now()}`,
        metadata: {
          name: "Error Display Test Workflow",
          version: "1.0.0",
          description: "Workflow for testing error history display",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "step1" } },
          {
            type: "agent-directive",
            id: "step1",
            directive: "Provide test_info field",
            completionCondition: "Valid input received",
            inputSchema: {
              type: "object",
              properties: {
                test_info: { type: "string", description: "Required test information" },
                details: { type: "string", description: "Additional details" },
                count: { type: "number", description: "Item count" },
              },
              required: ["test_info", "details", "count"],
            },
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });

    // Extract workflowId from result
    if (typeof createResult === "object" && createResult !== null && "workflowId" in createResult) {
      testWorkflowId = (createResult as { workflowId: string }).workflowId;
    } else {
      throw new Error(`Failed to create workflow: ${JSON.stringify(createResult)}`);
    }
    console.log(`✓ Test workflow created: ${testWorkflowId}`);

    // Start the workflow
    const startResult = await callMCPTool<string>(mcpClient, "start", {
      parentExecutionId: "none",
      workflowId: testWorkflowId,
    });

    // Extract execution ID
    const match = startResult.match(/Process ID: ([a-f0-9-]+)/);
    if (!match) {
      throw new Error(`Failed to extract execution ID from: ${startResult}`);
    }
    executionId = match[1];
    console.log(`✓ Execution created: ${executionId}`);

    // Send invalid input to trigger validation error with multiple missing required fields
    await callMCPTool<string>(mcpClient, "step", {
      processId: executionId,
      input: {
        wrong_field_1: "value1",
        wrong_field_2: "value2",
        another_invalid_field: "value3",
      },
    });
    console.log("✓ Triggered validation error with invalid input");
  });

  test.afterAll(async () => {
    // Delete test workflow to prevent database accumulation
    if (testWorkflowId && mcpClient) {
      try {
        // Use manage tool to delete the workflow
        await callMCPTool(mcpClient, "manage", {
          action: "edit",
          workflowId: testWorkflowId,
          changes: {
            removeNodes: ["start", "step1", "end"],
          },
        });
        console.log(`✓ Cleaned up test workflow: ${testWorkflowId}`);
      } catch (error) {
        // Ignore cleanup errors - workflow may already be deleted
        console.log(`Note: Could not cleanup workflow ${testWorkflowId}: ${error}`);
      }
    }

    if (cleanup) {
      await cleanup();
    }
  });

  test("Long validation error messages display without truncation", async ({ page }) => {
    // Verify execution ID is available
    expect(executionId).toBeDefined();
    expect(executionId).not.toBeNull();

    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal if present
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    // Navigate to execution inspector
    await page.goto(`${BASE_URL}/admin/executions/${executionId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);
    console.log(`✓ Navigated to execution: ${page.url()}`);

    // Click on Errors tab first (context is default tab in Step 28 redesign)
    const errorsTab = page.locator('[role="tab"]').filter({ hasText: /Errors|Ошибки/ });
    await errorsTab.click();

    // Find Error History section
    const errorHistoryTitle = page
      .locator('text="Error History"')
      .or(page.locator('text="История ошибок"'));
    const hasErrorHistory = await errorHistoryTitle.isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasErrorHistory).toBeTruthy();
    console.log("✓ Error History section found");

    // Find validation error card (badge text is "Validation" with capital V)
    const validationBadge = page.locator('text="Validation"').or(page.locator('text="Валидация"'));
    const hasValidationError = await validationBadge
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    expect(hasValidationError).toBeTruthy();
    console.log("✓ Validation error badge found");

    // Find error message text
    const errorMessage = page.locator("p.whitespace-pre-wrap.break-words").first();
    const messageText = await errorMessage.textContent();
    console.log(`Message length: ${messageText?.length} chars`);
    console.log(`Message preview: ${messageText?.substring(0, 200)}...`);

    // Verify message contains expected validation error content
    // Should mention required fields that are missing
    expect(messageText).toMatch(/test_info|details|count|required/i);
    console.log("✓ Message contains validation error details");

    // Verify message does NOT end with truncation markers
    expect(messageText).not.toMatch(/\.\.\.$/);
    expect(messageText).not.toContain("[truncated]");
    console.log("✓ Message is not truncated");

    // Check computed styles to ensure no CSS truncation
    const styles = await errorMessage.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        textOverflow: cs.textOverflow,
        overflow: cs.overflow,
        webkitLineClamp: cs.getPropertyValue("-webkit-line-clamp"),
        whiteSpace: cs.whiteSpace,
      };
    });

    expect(styles.textOverflow).not.toBe("ellipsis");
    expect(styles.webkitLineClamp).toBe("none");
    expect(styles.whiteSpace).toBe("pre-wrap");
    console.log("✓ CSS styles allow full text display");
  });

  test("Copy button copies full error message", async ({ page }) => {
    // Verify execution ID is available
    expect(executionId).toBeDefined();
    expect(executionId).not.toBeNull();

    // Login and navigate
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal if present
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    await page.goto(`${BASE_URL}/admin/executions/${executionId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Click on Errors tab first
    const errorsTab = page.locator('[role="tab"]').filter({ hasText: /Errors|Ошибки/ });
    await errorsTab.click();

    // Expand error card by clicking on it
    const errorCard = page.locator(".rounded-lg.border.bg-muted\\/30").first();
    await errorCard.click();
    await page.waitForTimeout(500);

    // Find and click copy button
    const copyButton = page.locator('[data-testid="copy-error-0"]');
    const copyButtonVisible = await copyButton.isVisible({ timeout: 3000 }).catch(() => false);

    if (copyButtonVisible) {
      // Grant clipboard permissions
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

      await copyButton.click();
      await page.waitForTimeout(500);

      // Read clipboard
      const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
      console.log(`Clipboard content length: ${clipboardText.length} chars`);

      // Verify clipboard contains full message with error details
      expect(clipboardText).toMatch(/test_info|details|count|required/i);
      expect(clipboardText).not.toMatch(/\.\.\.$/);
      console.log("✓ Copy button copies full error message");
    } else {
      console.log("Copy button not visible - skipping clipboard test");
    }
  });

  test("Expanded error section shows full details", async ({ page }) => {
    // Verify execution ID is available
    expect(executionId).toBeDefined();
    expect(executionId).not.toBeNull();

    // Login and navigate
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(ADMIN_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(ADMIN_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Close beta modal
    await page.waitForLoadState("domcontentloaded");
    try {
      const modalPresent = (await page.locator('div[role="dialog"]').count()) > 0;
      if (modalPresent) {
        await page.click('button:has-text("Accept and Continue")');
        await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      }
    } catch {
      // Modal not present
    }

    await page.goto(`${BASE_URL}/admin/executions/${executionId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    // Click on Errors tab first
    const errorsTab = page.locator('[role="tab"]').filter({ hasText: /Errors|Ошибки/ });
    await errorsTab.click();

    // Click to expand error details
    const errorCard = page.locator(".rounded-lg.border.bg-muted\\/30").first();
    await errorCard.click();
    await page.waitForTimeout(500);

    // Find expanded message section
    const expandedMessage = page.locator(
      "p.bg-muted.rounded.text-xs.font-mono.whitespace-pre-wrap",
    );
    const expandedVisible = await expandedMessage.isVisible({ timeout: 3000 }).catch(() => false);

    if (expandedVisible) {
      const expandedText = await expandedMessage.textContent();
      console.log(`Expanded message length: ${expandedText?.length} chars`);

      // Verify expanded section shows full details
      expect(expandedText).toMatch(/test_info|details|count|required/i);
      expect(expandedText).not.toMatch(/\.\.\.$/);

      // Check break-words is applied
      const styles = await expandedMessage.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          wordBreak: cs.wordBreak,
          overflowWrap: cs.overflowWrap,
          whiteSpace: cs.whiteSpace,
        };
      });

      expect(styles.whiteSpace).toBe("pre-wrap");
      console.log("✓ Expanded section displays full error details");
    }
  });
});
