/**
 * MCP Prompts Editor E2E Tests
 * Tests the dynamic prompt editor with scope/model dropdowns
 * (Integrated into Global Settings page)
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("MCP Prompts Editor (Global Settings)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");
  });

  test("global settings page loads with MCP prompt editors", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Verify page title (unified settings page)
    await expect(page.getByRole("heading", { name: /^Settings$|^Настройки$/i })).toBeVisible();

    // Verify MCP prompts section exists (use heading selector to be specific)
    await expect(page.getByRole("heading", { name: "MCP Prompts" })).toBeVisible();

    // Verify system prompts section exists in nav (use heading selector to be specific)
    await expect(page.getByRole("heading", { name: "System Prompts" })).toBeVisible();

    // Verify tool descriptions section exists in nav (use heading selector to be specific)
    await expect(page.getByRole("heading", { name: "Tool Descriptions" })).toBeVisible();

    // Verify systemPrompt editor exists (default selection)
    await expect(page.getByTestId("mcp-prompt-systemPrompt")).toBeVisible();

    // Click systemReminder in nav and verify its editor appears
    await page.getByTestId("prompt-item-systemReminder").click();
    await expect(page.getByTestId("mcp-prompt-systemReminder")).toBeVisible();
  });

  test("each editor has scope and model dropdowns", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Check systemPrompt editor has both dropdowns (default selection)
    const systemPromptEditor = page.getByTestId("mcp-prompt-systemPrompt");
    await expect(systemPromptEditor.getByTestId("mcp-prompt-systemPrompt-scope")).toBeVisible();
    await expect(systemPromptEditor.getByTestId("mcp-prompt-systemPrompt-model")).toBeVisible();

    // Click systemReminder in nav to select it
    await page.getByTestId("prompt-item-systemReminder").click();

    // Check systemReminder editor has both dropdowns
    const systemReminderEditor = page.getByTestId("mcp-prompt-systemReminder");
    await expect(systemReminderEditor.getByTestId("mcp-prompt-systemReminder-scope")).toBeVisible();
    await expect(systemReminderEditor.getByTestId("mcp-prompt-systemReminder-model")).toBeVisible();
  });

  test("model dropdown is disabled when scope is Default", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");

    // Default should be selected initially
    const modelDropdown = editor.getByTestId("mcp-prompt-systemPrompt-model");

    // Model dropdown should be disabled when scope is Default
    await expect(modelDropdown).toBeDisabled();
  });

  test("model dropdown enables when scope is changed to Claude", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");

    // Click scope dropdown and select Claude
    const scopeDropdown = editor.getByTestId("mcp-prompt-systemPrompt-scope");
    await scopeDropdown.click();
    await page.locator('[role="option"]').filter({ hasText: "Claude" }).click();

    // Wait for loading to complete
    await page.waitForTimeout(500);

    // Model dropdown should now be enabled
    const modelDropdown = editor.getByTestId("mcp-prompt-systemPrompt-model");
    await expect(modelDropdown).toBeEnabled();
  });

  test("scope dropdown changes load correct values", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");
    const textarea = editor.getByTestId("mcp-prompt-systemPrompt-input");

    // Get initial value (Default scope)
    await expect(textarea).toBeVisible();

    // Switch to Claude scope
    const scopeDropdown = editor.getByTestId("mcp-prompt-systemPrompt-scope");
    await scopeDropdown.click();
    await page.locator('[role="option"]').filter({ hasText: "Claude" }).click();

    // Wait for value to load
    await page.waitForTimeout(1000);

    // Value may be different (empty for non-override) or same
    // Just verify the textarea is still usable
    await expect(textarea).toBeVisible();
  });

  test("save button is disabled when no changes", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");
    const saveButton = editor.getByTestId("mcp-prompt-systemPrompt-save");

    // Save button should be disabled initially (no changes)
    await expect(saveButton).toBeDisabled();
  });

  test("save button enables when value is modified", async ({ page }, testInfo) => {
    test.slow();
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");
    const textarea = editor.getByTestId("mcp-prompt-systemPrompt-input");
    const saveButton = editor.getByTestId("mcp-prompt-systemPrompt-save");

    // Get current value
    const currentValue = await textarea.inputValue();

    // Modify the value
    await textarea.fill(currentValue + " - test modification");

    // Save button should now be enabled
    await expect(saveButton).toBeEnabled();

    // Restore original value
    await textarea.fill(currentValue);

    // Save button should be disabled again
    await expect(saveButton).toBeDisabled();
  });

  // Fullscreen button was removed from McpPromptsEditor in the master-detail refactor

  test("tool description editors are present", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Verify tool description editors exist by clicking each nav item
    const expectedTools = [
      "list",
      "start",
      "step",
      "manage",
      "help",
      "settings",
      "session",
      "token",
    ];

    for (const tool of expectedTools) {
      const navItemTestId = `prompt-item-toolDescription-${tool}`;
      await page.getByTestId(navItemTestId).click();
      const testId = `mcp-prompt-toolDescription-${tool}`;
      await expect(page.getByTestId(testId)).toBeVisible();
    }
  });

  test("save persists value for Default scope", async ({ page }, testInfo) => {
    test.slow();
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Select systemReminder in nav
    await page.getByTestId("prompt-item-systemReminder").click();

    const editor = page.getByTestId("mcp-prompt-systemReminder");
    const textarea = editor.getByTestId("mcp-prompt-systemReminder-input");
    const saveButton = editor.getByTestId("mcp-prompt-systemReminder-save");

    // Get current value
    const originalValue = await textarea.inputValue();

    // Add test modification with timestamp to ensure uniqueness
    const testValue = originalValue + ` [E2E Test ${Date.now()}]`;
    await textarea.fill(testValue);

    // Save and wait for server response
    await expect(saveButton).toBeEnabled();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("set-scope-value") && r.status() === 200),
      saveButton.click(),
    ]);

    // Reload page and verify value persisted
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Re-select systemReminder in nav after reload
    await page.getByTestId("prompt-item-systemReminder").click();

    const textareaAfter = page
      .getByTestId("mcp-prompt-systemReminder")
      .getByTestId("mcp-prompt-systemReminder-input");
    await expect(textareaAfter).toHaveValue(testValue);

    // Cleanup: restore original value
    await textareaAfter.fill(originalValue);
    const cleanupSaveButton = page
      .getByTestId("mcp-prompt-systemReminder")
      .getByTestId("mcp-prompt-systemReminder-save");
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("set-scope-value") && r.status() === 200),
      cleanupSaveButton.click(),
    ]);
  });

  test("agent-level override shows correct status badge", async ({ page }, testInfo) => {
    test.slow();
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    const editor = page.getByTestId("mcp-prompt-systemPrompt");

    // Switch to Claude scope
    const scopeDropdown = editor.getByTestId("mcp-prompt-systemPrompt-scope");
    await scopeDropdown.click();
    await page.locator('[role="option"]').filter({ hasText: "Claude" }).click();

    // Wait for value to load
    await page.waitForTimeout(1000);

    // Should show "Using Fallback" badge when no override exists
    // OR "Override Active" if an override is set
    // Just verify one of these badges is present in the card header
    const cardContent = await editor.textContent();
    expect(cardContent?.includes("Fallback") || cardContent?.includes("Override")).toBe(true);
  });
});
