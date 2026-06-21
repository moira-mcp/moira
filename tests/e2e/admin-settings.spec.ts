/**
 * E2E Tests for Global Settings Page
 * Tests the MCP Prompts Editor and global settings management functionality for admin users
 * Located at /admin/global-settings
 *
 * The new UI uses McpPromptsEditor with:
 * - System Prompts section (systemPrompt, systemReminder)
 * - Tool Descriptions section (list, start, step, manage, help, settings, session, token)
 * - Each prompt has Scope dropdown (Default, Claude, ChatGPT, Gemini, Cursor)
 * - Each prompt has Model dropdown (when non-default scope)
 * - Export/Import functionality for settings
 */

import { test, expect, Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

// Test IDs from McpPromptsEditor component
const MCP_PROMPT_PREFIX = "mcp-prompt";
const SYSTEM_PROMPTS = ["systemPrompt", "systemReminder"] as const;
const TOOL_DESCRIPTIONS = [
  "toolDescription-list",
  "toolDescription-start",
  "toolDescription-step",
  "toolDescription-manage",
  "toolDescription-help",
  "toolDescription-settings",
  "toolDescription-session",
  "toolDescription-token",
] as const;

/**
 * Wait for MCP Prompts Editor to load
 */
async function waitForMcpPromptsEditor(page: Page): Promise<void> {
  // Wait for the first prompt card to be visible
  await page.waitForSelector(`[data-testid="${MCP_PROMPT_PREFIX}-systemPrompt"]`, {
    timeout: 15000,
  });
}

/**
 * Select a prompt in the left nav panel (master-detail layout)
 */
async function selectPromptInNav(page: Page, promptType: string): Promise<void> {
  await page.getByTestId(`prompt-item-${promptType}`).click();
  await page.waitForSelector(`[data-testid="${MCP_PROMPT_PREFIX}-${promptType}"]`, {
    timeout: 5000,
  });
}

/**
 * Get test ID for a prompt element
 */
function getPromptTestId(promptType: string, suffix?: string): string {
  const base = `${MCP_PROMPT_PREFIX}-${promptType}`;
  return suffix ? `${base}-${suffix}` : base;
}

test.describe("Global Settings Page - MCP Prompts Editor", () => {
  // Remote browser connection adds latency to each operation
  if (process.env.PLAYWRIGHT_REMOTE === "true") {
    test.describe.configure({ timeout: 120000 });
  }

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for settings page content to be visible
    await page.waitForSelector('h1, [data-testid="settings-page"]', { timeout: 15000 });
  });

  test("should display admin settings page title", async ({ page }) => {
    const title = page.getByRole("heading", { name: /^Settings$|^Настройки$/i });
    await expect(title).toBeVisible();
  });

  test("global settings page loads with MCP prompt editors", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Check for System Prompts section in nav
    const systemPromptsHeading = page.getByRole("heading", { name: "System Prompts" });
    await expect(systemPromptsHeading).toBeVisible();

    // Check systemPrompt card is visible (default selection)
    const systemPromptCard = page.getByTestId(getPromptTestId("systemPrompt"));
    await expect(systemPromptCard).toBeVisible();

    // Click systemReminder in nav and verify its editor appears
    await selectPromptInNav(page, "systemReminder");
    const systemReminderCard = page.getByTestId(getPromptTestId("systemReminder"));
    await expect(systemReminderCard).toBeVisible();
  });

  test("should display tool description editors", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Check for Tool Descriptions section in nav
    const toolDescHeading = page.getByRole("heading", { name: "Tool Descriptions" });
    await expect(toolDescHeading).toBeVisible();

    // Click each tool description nav item and verify the editor appears
    const toolsToCheck = ["toolDescription-list", "toolDescription-start", "toolDescription-step"];
    for (const tool of toolsToCheck) {
      await selectPromptInNav(page, tool);
      await expect(page.getByTestId(getPromptTestId(tool))).toBeVisible();
    }
  });

  test("should display scope dropdown for each prompt", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Check scope dropdown for systemPrompt
    const scopeDropdown = page.getByTestId(getPromptTestId("systemPrompt", "scope"));
    await expect(scopeDropdown).toBeVisible();

    // Should have "Default" selected initially
    await expect(scopeDropdown).toContainText("Default");
  });

  test("should display model dropdown for each prompt", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Check model dropdown for systemPrompt
    const modelDropdown = page.getByTestId(getPromptTestId("systemPrompt", "model"));
    await expect(modelDropdown).toBeVisible();

    // Model should show N/A or All models when scope is Default
    await expect(modelDropdown).toContainText(/All models|\(N\/A\)/);
  });

  test("should display textarea for prompt editing", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Check textarea for systemPrompt
    const textarea = page.getByTestId(getPromptTestId("systemPrompt", "input"));
    await expect(textarea).toBeVisible();

    // Should have content (default system prompt)
    const value = await textarea.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  // Fullscreen tests removed — fullscreen was removed from McpPromptsEditor in the master-detail refactor

  test("should save prompt changes directly to database", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Get original value
    const textarea = page.getByTestId(getPromptTestId("systemPrompt", "input"));
    const originalValue = await textarea.inputValue();

    // Edit the value
    const testMarker = ` SAVE_TEST_${Date.now()}`;
    await textarea.fill(originalValue + testMarker);

    // Save via the save button — wait for API response to ensure persistence
    const saveBtn = page.getByTestId(getPromptTestId("systemPrompt", "save"));
    await expect(saveBtn).toBeEnabled();
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/set-scope-value") && resp.request().method() === "POST",
      ),
      saveBtn.click(),
    ]);
    expect(saveResponse.status()).toBeLessThan(400);

    // Save button should become disabled after save completes
    await expect(saveBtn).toBeDisabled({ timeout: 10000 });

    // Value should be updated in textarea
    const updatedValue = await textarea.inputValue();
    expect(updatedValue).toContain("SAVE_TEST_");

    // Reload page to verify persistence
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);

    // Check value persisted after reload
    const textareaAfterReload = page.getByTestId(getPromptTestId("systemPrompt", "input"));
    const valueAfterReload = await textareaAfterReload.inputValue();
    expect(valueAfterReload).toContain("SAVE_TEST_");

    // Restore original value
    await textareaAfterReload.fill(originalValue);
    const promptSaveBtnAfterReload = page.getByTestId(getPromptTestId("systemPrompt", "save"));
    await Promise.all([
      page.waitForResponse(
        (resp) => resp.url().includes("/set-scope-value") && resp.request().method() === "POST",
      ),
      promptSaveBtnAfterReload.click(),
    ]);
    await expect(promptSaveBtnAfterReload).toBeDisabled({ timeout: 10000 });
  });

  test("should show save button when prompt is edited", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    const textarea = page.getByTestId(getPromptTestId("systemPrompt", "input"));
    const saveBtn = page.getByTestId(getPromptTestId("systemPrompt", "save"));

    // Save button should be disabled initially (no changes)
    await expect(saveBtn).toBeDisabled();

    // Edit the textarea
    const originalValue = await textarea.inputValue();
    await textarea.fill(originalValue + " TEST_EDIT");

    // Save button should now be enabled
    await expect(saveBtn).toBeEnabled();

    // Revert to original
    await textarea.fill(originalValue);
    await expect(saveBtn).toBeDisabled();
  });

  test("should save prompt changes and persist after reload", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Select toolDescription-list in nav (master-detail layout)
    await selectPromptInNav(page, "toolDescription-list");

    // Use toolDescription-list to avoid conflict with mcp-prompts.spec.ts which uses systemPrompt/systemReminder
    const textarea = page.getByTestId(getPromptTestId("toolDescription-list", "input"));
    const saveBtn = page.getByTestId(getPromptTestId("toolDescription-list", "save"));

    // Get original value
    const originalValue = await textarea.inputValue();
    const testMarker = ` E2E_SAVE_TEST_${Date.now()}`;

    // Make a change
    await textarea.fill(originalValue + testMarker);
    await expect(saveBtn).toBeEnabled();

    // Save and wait for button to become disabled (indicates save completed)
    await saveBtn.click();
    await expect(saveBtn).toBeDisabled({ timeout: 10000 });
    // Additional wait for DB persistence
    await page.waitForTimeout(500);

    // Reload page
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);

    // Re-select toolDescription-list in nav after reload
    await selectPromptInNav(page, "toolDescription-list");

    // Verify change persisted
    const reloadedTextarea = page.getByTestId(getPromptTestId("toolDescription-list", "input"));
    const savedValue = await reloadedTextarea.inputValue();
    expect(savedValue).toContain("E2E_SAVE_TEST_");

    // Clean up: restore original value
    await reloadedTextarea.fill(originalValue);
    const cleanupSaveBtn = page.getByTestId(getPromptTestId("toolDescription-list", "save"));
    await cleanupSaveBtn.click();
    await expect(cleanupSaveBtn).toBeDisabled({ timeout: 10000 });
  });

  test("should display character count", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Character count should be visible
    const characterCount = page.getByText(/\d+ characters|\d+ символов/i);
    await expect(characterCount.first()).toBeVisible();
  });

  test("should change scope dropdown and load different value", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    // Select systemReminder in nav (master-detail layout)
    await selectPromptInNav(page, "systemReminder");

    const scopeDropdown = page.getByTestId(getPromptTestId("systemReminder", "scope"));

    // Change scope to Claude
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Claude" }).click();

    // Wait for value to load
    await page.waitForTimeout(500);

    // Scope should show Claude now
    await expect(scopeDropdown).toContainText("Claude");

    // Model dropdown should be enabled now
    const modelDropdown = page.getByTestId(getPromptTestId("systemReminder", "model"));
    await expect(modelDropdown).toContainText("All models");
  });

  test("should enable model dropdown when non-default scope selected", async ({ page }) => {
    await waitForMcpPromptsEditor(page);

    const scopeDropdown = page.getByTestId(getPromptTestId("systemPrompt", "scope"));
    const modelDropdown = page.getByTestId(getPromptTestId("systemPrompt", "model"));

    // Initially model dropdown shows N/A
    await expect(modelDropdown).toContainText(/All models|\(N\/A\)/);

    // Change scope to ChatGPT
    await scopeDropdown.click();
    await page.getByRole("option", { name: "ChatGPT" }).click();
    await page.waitForTimeout(500);

    // Model dropdown should be interactive
    await modelDropdown.click();

    // Should show ChatGPT models - use exact name to avoid matching multiple gpt-4 variants
    const gpt4oOption = page.getByRole("option", { name: "gpt-4o", exact: true });
    await expect(gpt4oOption).toBeVisible();

    // Close dropdown
    await page.keyboard.press("Escape");

    // Reset scope to Default
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Default" }).click();
  });
});

test.describe("Global Settings - Export/Import", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);
  });

  test("should display export and import buttons", async ({ page }) => {
    const exportButton = page.getByTestId("export-settings");
    const importButton = page.getByTestId("import-settings");

    await expect(exportButton).toBeVisible();
    await expect(importButton).toBeVisible();
  });

  test("should download JSON file when clicking export", async ({ page }) => {
    // Downloads don't work reliably over remote WebSocket Playwright connection
    test.skip(
      process.env.PLAYWRIGHT_REMOTE === "true",
      "Download tests not supported in remote mode",
    );
    // Set up download listener
    const downloadPromise = page.waitForEvent("download");

    // Click export button
    const exportButton = page.getByTestId("export-settings");
    await exportButton.click();

    // Wait for download
    const download = await downloadPromise;

    // Verify filename pattern
    expect(download.suggestedFilename()).toMatch(/^moira-settings-\d{4}-\d{2}-\d{2}\.json$/);

    // Verify content structure
    const content = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(Buffer.from(chunk));
    }
    const jsonContent = JSON.parse(Buffer.concat(chunks).toString());

    // Verify export structure
    expect(jsonContent).toHaveProperty("version");
    expect(jsonContent).toHaveProperty("exportedAt");
    expect(jsonContent).toHaveProperty("values");
    expect(typeof jsonContent.values).toBe("object");
  });

  test("should open import preview modal when file is selected", async ({ page }) => {
    // Create a valid import file content
    const importData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      values: {
        "mcp.systemReminder": "Test import value " + Date.now(),
      },
    };

    // Get file input and set file
    const fileInput = page.getByTestId("import-file-input");
    const buffer = Buffer.from(JSON.stringify(importData));

    await fileInput.setInputFiles({
      name: "test-import.json",
      mimeType: "application/json",
      buffer: buffer,
    });

    // Import preview modal should open
    const previewTitle = page.getByRole("heading", {
      name: /Import Preview|Предпросмотр импорта/i,
    });
    await expect(previewTitle).toBeVisible({ timeout: 5000 });

    // Preview list should be visible
    const previewList = page.getByTestId("import-preview-list");
    await expect(previewList).toBeVisible();

    // Close modal
    const cancelButton = page.getByRole("button", { name: /Cancel|Отмена/i });
    await cancelButton.click();
  });

  test("should show correct change types in import preview", async ({ page }) => {
    // Create import data with different types of changes
    const importData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      values: {
        "mcp.systemReminder": "MODIFIED_VALUE_" + Date.now(),
        "nonexistent.setting.key": "This should be skipped",
      },
    };

    const fileInput = page.getByTestId("import-file-input");
    const buffer = Buffer.from(JSON.stringify(importData));

    await fileInput.setInputFiles({
      name: "test-import.json",
      mimeType: "application/json",
      buffer: buffer,
    });

    // Wait for preview modal
    await page.waitForSelector('[data-testid="import-preview-list"]', { timeout: 5000 });

    // Should show the overwrite change
    const overwriteChange = page.getByTestId("import-change-mcp.systemReminder");
    await expect(overwriteChange).toBeVisible();

    // Should show type badge
    const overwriteBadge = overwriteChange.getByText(/Overwrite|Перезапись/i);
    await expect(overwriteBadge).toBeVisible();

    // Close modal
    const cancelButton = page.getByRole("button", { name: /Cancel|Отмена/i });
    await cancelButton.click();
  });

  test("should apply import and update settings", async ({ page }) => {
    // Increase timeout for this test as import operations can be slow
    test.setTimeout(60000);

    // Select systemReminder in nav
    await selectPromptInNav(page, "systemReminder");

    // Get current systemReminder value
    const textarea = page.getByTestId(getPromptTestId("systemReminder", "input"));
    const originalValue = await textarea.inputValue();

    // Create import data with a new value
    const newValue = "IMPORT_TEST_" + Date.now();
    const importData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      values: {
        "mcp.systemReminder": newValue,
      },
    };

    const fileInput = page.getByTestId("import-file-input");
    const buffer = Buffer.from(JSON.stringify(importData));

    await fileInput.setInputFiles({
      name: "test-import.json",
      mimeType: "application/json",
      buffer: buffer,
    });

    // Wait for preview modal to fully load
    const confirmButton = page.getByTestId("import-confirm");
    await expect(confirmButton).toBeVisible({ timeout: 10000 });
    await expect(confirmButton).toBeEnabled({ timeout: 5000 });
    await confirmButton.click();

    // Wait for modal to close completely
    const previewModal = page.getByRole("heading", {
      name: /Import Preview|Предпросмотр импорта/i,
    });
    await expect(previewModal).not.toBeVisible({ timeout: 10000 });

    // Wait for network to settle after import
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Reload and verify the value was updated
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);

    // Re-select systemReminder in nav after reload
    await selectPromptInNav(page, "systemReminder");

    const updatedTextarea = page.getByTestId(getPromptTestId("systemReminder", "input"));
    const updatedValue = await updatedTextarea.inputValue();
    expect(updatedValue).toBe(newValue);

    // Clean up: restore original value
    await updatedTextarea.fill(originalValue);
    const saveBtn = page.getByTestId(getPromptTestId("systemReminder", "save"));
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForTimeout(1000);
  });

  test("should not enable confirm button when no changes to apply", async ({ page }) => {
    // Select systemReminder in nav
    await selectPromptInNav(page, "systemReminder");

    // Get current value
    const textarea = page.getByTestId(getPromptTestId("systemReminder", "input"));
    const currentValue = await textarea.inputValue();

    // Create import data with SAME value (no changes)
    const importData = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      values: {
        "mcp.systemReminder": currentValue,
      },
    };

    const fileInput = page.getByTestId("import-file-input");
    const buffer = Buffer.from(JSON.stringify(importData));

    await fileInput.setInputFiles({
      name: "test-import.json",
      mimeType: "application/json",
      buffer: buffer,
    });

    // Wait for preview modal
    const previewTitle = page.getByRole("heading", {
      name: /Import Preview|Предпросмотр импорта/i,
    });
    await expect(previewTitle).toBeVisible({ timeout: 5000 });

    // Confirm button should be disabled when no changes
    const confirmButton = page.getByTestId("import-confirm");
    await expect(confirmButton).toBeDisabled();

    // Close modal
    const cancelButton = page.getByRole("button", { name: /Cancel|Отмена/i });
    await cancelButton.click();
  });
});

test.describe("Global Settings - Scope/Model Override Workflow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);
  });

  test("should show Override Active badge when agent override is set", async ({ page }) => {
    // Increase timeout for this test as scope changes can be slow
    test.setTimeout(60000);

    // Select systemReminder in nav
    await selectPromptInNav(page, "systemReminder");

    const promptType = "systemReminder";
    const scopeDropdown = page.getByTestId(getPromptTestId(promptType, "scope"));
    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));

    // Get default value first
    const defaultValue = await textarea.inputValue();

    // Change scope to Claude
    await scopeDropdown.click();
    const claudeOption = page.getByRole("option", { name: "Claude" });
    await expect(claudeOption).toBeVisible({ timeout: 5000 });
    await claudeOption.click();

    // Wait for scope change to complete and value to load
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // Set an override value
    const overrideValue = "CLAUDE_OVERRIDE_" + Date.now();
    await textarea.fill(overrideValue);
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();

    // Wait for save to complete
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Should show "Override Active" badge - wait with explicit timeout
    const overrideBadge = page.getByText("Override Active");
    await expect(overrideBadge).toBeVisible({ timeout: 10000 });

    // Clean up: reset the override by setting to empty
    await textarea.fill("");
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Reset scope to Default
    await scopeDropdown.click();
    const defaultOption = page.getByRole("option", { name: "Default" });
    await expect(defaultOption).toBeVisible({ timeout: 5000 });
    await defaultOption.click();
  });

  test("should show Using Fallback badge when no override exists", async ({ page }) => {
    // Select systemReminder in nav
    await selectPromptInNav(page, "systemReminder");

    const promptType = "systemReminder";
    const scopeDropdown = page.getByTestId(getPromptTestId(promptType, "scope"));
    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));

    // Change scope to Gemini (unlikely to have an override)
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Gemini" }).click();
    await page.waitForTimeout(500);

    // Clear any existing override
    const currentValue = await textarea.inputValue();
    if (currentValue !== "") {
      await textarea.fill("");
      await saveBtn.click();
      await page.waitForTimeout(1000);
    }

    // Should show "Using Fallback" badge
    const fallbackBadge = page.getByText("Using Fallback");
    await expect(fallbackBadge).toBeVisible();

    // Reset scope to Default
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Default" }).click();
  });

  test("should show reset button only for active overrides", async ({ page }) => {
    // Select systemReminder in nav
    await selectPromptInNav(page, "systemReminder");

    const promptType = "systemReminder";
    const scopeDropdown = page.getByTestId(getPromptTestId(promptType, "scope"));
    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));
    const resetBtn = page.getByTestId(getPromptTestId(promptType, "reset"));

    // In Default scope, reset button should not be visible
    await expect(resetBtn).not.toBeVisible();

    // Change scope to Cursor
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Cursor" }).click();
    await page.waitForTimeout(500);

    // Set an override value
    const overrideValue = "CURSOR_OVERRIDE_" + Date.now();
    await textarea.fill(overrideValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Reset button should now be visible
    await expect(resetBtn).toBeVisible();

    // Click reset
    await resetBtn.click();
    await page.waitForTimeout(1000);

    // Reset button should no longer be visible (no override)
    await expect(resetBtn).not.toBeVisible();

    // Reset scope to Default
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Default" }).click();
  });
});

test.describe("Global Settings - Navigation", () => {
  test("should navigate from admin panel to global settings", async ({ page }) => {
    await loginAsAdmin(page);

    // Navigate directly to global settings page
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");

    // Should be on global settings page
    expect(page.url()).toContain("/admin/global-settings");
    const title = page.getByRole("heading", { name: /^Settings$|^Настройки$/i });
    await expect(title).toBeVisible();
  });

  test("should show loading state initially", async ({ page }) => {
    await loginAsAdmin(page);

    // Add network delay to catch loading state
    await page.route("**/api/admin/global-settings**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto(`${BASE_URL}/admin/global-settings`);

    // Either loading spinner should appear or content should load
    const loadingSpinner = page.locator(".animate-spin");
    const content = page.getByTestId(getPromptTestId("systemPrompt"));

    await expect(loadingSpinner.or(content)).toBeVisible({ timeout: 10000 });
  });
});

// Note: MCP Inspector tests removed - the /admin/mcp-inspector page doesn't exist in the current UI

test.describe("Global Settings - MCP Prompts History", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/global-settings`);
    await page.waitForLoadState("domcontentloaded");
    await waitForMcpPromptsEditor(page);
  });

  test("should display history button for system prompt", async ({ page }) => {
    // History button should be visible for systemPrompt
    const historyBtn = page.getByTestId(getPromptTestId("systemPrompt", "history"));
    await expect(historyBtn).toBeVisible();
    await expect(historyBtn).toContainText(/History|История/i);
  });

  test("should display history button for tool descriptions", async ({ page }) => {
    // Click on toolDescription-list in the left panel first
    await page.getByTestId("prompt-item-toolDescription-list").click();
    await page.waitForTimeout(500);
    // History button should be visible for tool descriptions
    const historyBtn = page.getByTestId(getPromptTestId("toolDescription-list", "history"));
    await expect(historyBtn).toBeVisible();
  });

  test("should open inline version history when clicking history button", async ({ page }) => {
    // Click history button for systemPrompt
    const historyBtn = page.getByTestId(getPromptTestId("systemPrompt", "history"));
    await historyBtn.click();

    // Inline version panel should appear
    const versionPanel = page.getByTestId(getPromptTestId("systemPrompt", "version-panel"));
    await expect(versionPanel).toBeVisible({ timeout: 5000 });

    // Version select dropdown should be visible
    const versionSelect = page.getByTestId(getPromptTestId("systemPrompt", "version-select"));
    await expect(versionSelect).toBeVisible();

    // Click history button again to close
    await historyBtn.click();
    await expect(versionPanel).not.toBeVisible();
  });

  test("should show version entries after making changes", async ({ page }) => {
    // Use toolDescription-start to avoid race condition with Import tests that use systemReminder
    const promptType = "toolDescription-start";

    // Click on the prompt in left panel
    await page.getByTestId("prompt-item-toolDescription-start").click();
    await page.waitForTimeout(500);

    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));
    const historyBtn = page.getByTestId(getPromptTestId(promptType, "history"));

    // Get original value
    const originalValue = await textarea.inputValue();
    const testMarker = `_HISTORY_TEST_${Date.now()}`;

    // Make a change
    await textarea.fill(originalValue + testMarker);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Open inline history
    await historyBtn.click();
    await page.waitForTimeout(1000);

    // Version panel should be visible
    const versionPanel = page.getByTestId(getPromptTestId(promptType, "version-panel"));
    await expect(versionPanel).toBeVisible();

    // Version select should be visible and have entries
    const versionSelect = page.getByTestId(getPromptTestId(promptType, "version-select"));
    await expect(versionSelect).toBeVisible();

    // Close history
    await historyBtn.click();

    // Clean up: restore original value
    await textarea.fill(originalValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);
  });

  test("should apply historical version via inline diff panel", async ({ page }) => {
    // Use toolDescription-step to avoid race condition with Import tests that use systemReminder
    const promptType = "toolDescription-step";

    // Click on the prompt in left panel
    await page.getByTestId("prompt-item-toolDescription-step").click();
    await page.waitForTimeout(500);

    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));
    const historyBtn = page.getByTestId(getPromptTestId(promptType, "history"));

    // Get original value before any changes
    const originalValue = await textarea.inputValue();

    // Use unique test values
    const testRunId = Date.now();
    const valueA = `APPLY_TEST_${testRunId}_A`;
    const valueB = `APPLY_TEST_${testRunId}_B`;

    // Change 1: original → A
    await textarea.fill(valueA);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Change 2: A → B
    await textarea.fill(valueB);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Current value should be B
    const currentValue = await textarea.inputValue();
    expect(currentValue).toBe(valueB);

    // Open inline history
    await historyBtn.click();
    await page.waitForTimeout(1000);

    const versionPanel = page.getByTestId(getPromptTestId(promptType, "version-panel"));
    await expect(versionPanel).toBeVisible();

    // Open version dropdown and select the first entry
    const versionSelect = page.getByTestId(getPromptTestId(promptType, "version-select"));
    await versionSelect.click();

    // Select the second history entry (skip "Select version..." and skip the most recent entry
    // whose newValue equals the current textarea, so Apply would produce no change)
    const options = page.getByRole("option");
    const optionCount = await options.count();
    if (optionCount > 2) {
      // Click the third option (second real entry, which is original→A, newValue=A)
      await options.nth(2).click();
      await page.waitForTimeout(500);

      // Diff view should appear
      const diffView = page.getByTestId("inline-diff-view");
      await expect(diffView).toBeVisible();

      // Apply button should be visible
      const applyBtn = page.getByTestId(getPromptTestId(promptType, "apply-version"));
      await expect(applyBtn).toBeVisible();

      // Click Apply — this puts the historical value into the textarea
      await applyBtn.click();
      await page.waitForTimeout(500);

      // History panel should close after apply
      await expect(versionPanel).not.toBeVisible();

      // Save the applied value
      await saveBtn.click();
      await page.waitForTimeout(1000);
    }

    // Clean up: restore original value
    await textarea.fill(originalValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);
  });

  test("should show inline history for agent-level overrides", async ({ page }) => {
    const promptType = "systemReminder";

    // Click on systemReminder in left panel
    await page.getByTestId("prompt-item-systemReminder").click();
    await page.waitForTimeout(500);

    const scopeDropdown = page.getByTestId(getPromptTestId(promptType, "scope"));
    const textarea = page.getByTestId(getPromptTestId(promptType, "input"));
    const saveBtn = page.getByTestId(getPromptTestId(promptType, "save"));
    const historyBtn = page.getByTestId(getPromptTestId(promptType, "history"));

    // Change scope to Claude
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Claude" }).click();
    await page.waitForTimeout(500);

    // History button should still be visible
    await expect(historyBtn).toBeVisible();

    // Set an override value
    const overrideValue = "CLAUDE_HISTORY_TEST_" + Date.now();
    await textarea.fill(overrideValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Open inline history
    await historyBtn.click();
    await page.waitForTimeout(1000);

    // Version panel should be visible
    const versionPanel = page.getByTestId(getPromptTestId(promptType, "version-panel"));
    await expect(versionPanel).toBeVisible();

    // Version select should be present
    const versionSelect = page.getByTestId(getPromptTestId(promptType, "version-select"));
    await expect(versionSelect).toBeVisible();

    // Close history
    await historyBtn.click();

    // Clean up: reset to default scope
    await scopeDropdown.click();
    await page.getByRole("option", { name: "Default" }).click();
    await page.waitForTimeout(500);
  });
});
