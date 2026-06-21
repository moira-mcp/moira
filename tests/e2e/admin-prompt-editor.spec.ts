import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

test.describe("Admin Settings - Prompt Editor Master-Detail", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/admin/settings?tab=values");
    await page.waitForLoadState("networkidle");
  });

  test("master-detail layout renders with left panel and right editor", async ({ page }) => {
    // Master-detail container
    const editor = page.locator('[data-testid="mcp-prompts-editor"]');
    await expect(editor).toBeVisible();

    // Left panel with prompt list
    const promptList = page.locator('[data-testid="prompt-list"]');
    await expect(promptList).toBeVisible();

    // All 10 prompt items
    const items = page.locator('[data-testid^="prompt-item-"]');
    await expect(items).toHaveCount(10);

    // Section headers
    await expect(promptList.getByText("System Prompts")).toBeVisible();
    await expect(promptList.getByText("Tool Descriptions")).toBeVisible();

    // Default editor (systemPrompt) visible in right panel
    const defaultEditor = page.locator('[data-testid="mcp-prompt-systemPrompt"]');
    await expect(defaultEditor).toBeVisible();
  });

  test("clicking prompt item switches editor panel", async ({ page }) => {
    // Wait for initial load
    await expect(page.locator('[data-testid="mcp-prompt-systemPrompt-input"]')).toBeVisible({
      timeout: 10000,
    });

    // Click systemReminder
    await page.locator('[data-testid="prompt-item-systemReminder"]').click();
    await expect(page.locator('[data-testid="mcp-prompt-systemReminder"]')).toBeVisible();
    await expect(page.locator('[data-testid="mcp-prompt-systemReminder-input"]')).toBeVisible({
      timeout: 5000,
    });

    // Click tool description
    await page.locator('[data-testid="prompt-item-toolDescription-list"]').click();
    await expect(page.locator('[data-testid="mcp-prompt-toolDescription-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="mcp-prompt-toolDescription-list-input"]')).toBeVisible(
      { timeout: 5000 },
    );
  });

  test("editor shows scope selector and save button", async ({ page }) => {
    // Wait for textarea to appear
    await expect(page.locator('[data-testid="mcp-prompt-systemPrompt-input"]')).toBeVisible({
      timeout: 10000,
    });

    // Scope dropdown
    await expect(page.locator('[data-testid="mcp-prompt-systemPrompt-scope"]')).toBeVisible();

    // Save button (disabled when no changes)
    const saveBtn = page.locator('[data-testid="mcp-prompt-systemPrompt-save"]');
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();

    // No fullscreen modal or maximize button
    await expect(page.locator('[data-testid="fullscreen-modal"]')).toHaveCount(0);
  });

  test("apply from history sets textarea value and enables save", async ({ page }) => {
    const promptType = "toolDescription-manage";

    // Navigate to a prompt that we can modify without conflicting with other tests
    await page.locator('[data-testid="prompt-item-toolDescription-manage"]').click();
    await page.waitForTimeout(500);

    const textarea = page.locator(`[data-testid="mcp-prompt-${promptType}-input"]`);
    const saveBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-save"]`);
    const historyBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-history"]`);

    await expect(textarea).toBeVisible({ timeout: 10000 });

    // Save original value for cleanup
    const originalValue = await textarea.inputValue();

    // Create a unique value and save it — this creates a history entry with newValue
    const testValue = `APPLY_HISTORY_TEST_${Date.now()}`;
    await textarea.fill(testValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Change to something else so we can apply the historical version
    const otherValue = `OTHER_VALUE_${Date.now()}`;
    await textarea.fill(otherValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Open history panel and capture audit log API response
    const auditUrl = "/api/admin/audit-log";
    const [auditResponse] = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes(auditUrl) && resp.ok()),
      historyBtn.click(),
    ]);
    await page.waitForTimeout(1000);

    const versionPanel = page.locator(`[data-testid="mcp-prompt-${promptType}-version-panel"]`);
    await expect(versionPanel).toBeVisible();

    // Find the entry with newValue === testValue from the API response
    const auditJson = await auditResponse.json();
    const entries = auditJson.data.entries;
    const targetIndex = entries.findIndex((e: { changes?: string }) => {
      try {
        const changes = JSON.parse(e.changes ?? "[]");
        return (
          Array.isArray(changes) &&
          changes.some(
            (c: { field?: string; newValue?: string }) =>
              c.field === "value" && c.newValue === testValue,
          )
        );
      } catch {
        return false;
      }
    });
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    // Open version dropdown and select by computed index
    const versionSelect = page.locator(`[data-testid="mcp-prompt-${promptType}-version-select"]`);
    await versionSelect.click();

    const options = page.getByRole("option");
    const optionCount = await options.count();
    // Determine offset: if more options than entries, placeholder "Select version..." is counted
    const placeholderOffset = optionCount > entries.length ? 1 : 0;
    await options.nth(targetIndex + placeholderOffset).click();
    await page.waitForTimeout(500);

    // Apply button should be visible (newValue exists for this entry)
    const applyBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-apply-version"]`);
    await expect(applyBtn).toBeVisible();

    // Click Apply
    await applyBtn.click();
    await page.waitForTimeout(500);

    // History panel should close
    await expect(versionPanel).not.toBeVisible();

    // Textarea should contain the applied historical value (newValue = testValue)
    const appliedValue = await textarea.inputValue();
    expect(appliedValue).toBe(testValue);

    // Save button should be enabled (unsaved changes indicator)
    await expect(saveBtn).toBeEnabled();

    // Clean up: restore original value
    await textarea.fill(originalValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);
  });

  test("diff mode toggle switches between 'vs current' and 'changes' views", async ({ page }) => {
    const promptType = "toolDescription-manage";

    await page.locator('[data-testid="prompt-item-toolDescription-manage"]').click();
    await page.waitForTimeout(500);

    const textarea = page.locator(`[data-testid="mcp-prompt-${promptType}-input"]`);
    const saveBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-save"]`);
    const historyBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-history"]`);

    await expect(textarea).toBeVisible({ timeout: 10000 });
    const originalValue = await textarea.inputValue();

    // Create two saves to have history entries with different values
    const val1 = `DIFF_MODE_A_${Date.now()}`;
    await textarea.fill(val1);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    const val2 = `DIFF_MODE_B_${Date.now()}`;
    await textarea.fill(val2);
    await saveBtn.click();
    await page.waitForTimeout(1000);

    // Open history and capture audit log response
    const auditUrl = "/api/admin/audit-log";
    const [auditResponse] = await Promise.all([
      page.waitForResponse((resp) => resp.url().includes(auditUrl) && resp.ok()),
      historyBtn.click(),
    ]);
    await page.waitForTimeout(1000);

    // Find any entry with a non-null newValue for the diff view
    const auditJson = await auditResponse.json();
    const entries = auditJson.data.entries;
    const targetIndex = entries.findIndex((e: { changes?: string }) => {
      try {
        const changes = JSON.parse(e.changes ?? "[]");
        return (
          Array.isArray(changes) &&
          changes.some(
            (c: { field?: string; newValue?: string | null }) =>
              c.field === "value" && c.newValue != null,
          )
        );
      } catch {
        return false;
      }
    });
    expect(targetIndex).toBeGreaterThanOrEqual(0);

    // Select the entry by computed index
    const versionSelect = page.locator(`[data-testid="mcp-prompt-${promptType}-version-select"]`);
    await versionSelect.click();
    const options = page.getByRole("option");
    const optionCount = await options.count();
    const placeholderOffset = optionCount > entries.length ? 1 : 0;
    await options.nth(targetIndex + placeholderOffset).click();
    await page.waitForTimeout(500);

    // Diff mode toggle should be visible
    const toggle = page.locator(`[data-testid="mcp-prompt-${promptType}-diff-mode-toggle"]`);
    await expect(toggle).toBeVisible();

    // Default mode is "vs Current" — diff panel should exist
    const diffView = page.locator('[data-testid="inline-diff-view"]');
    await expect(diffView).toBeVisible();

    // "vs Current" button should be active (has bg-primary class)
    const currentBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-diff-mode-current"]`);
    const changesBtn = page.locator(`[data-testid="mcp-prompt-${promptType}-diff-mode-changes"]`);
    await expect(currentBtn).toHaveClass(/bg-primary/);

    // Switch to "Changes" mode
    await changesBtn.click();
    await page.waitForTimeout(300);
    await expect(changesBtn).toHaveClass(/bg-primary/);
    await expect(diffView).toBeVisible();

    // Switch back to "vs Current" mode
    await currentBtn.click();
    await page.waitForTimeout(300);
    await expect(currentBtn).toHaveClass(/bg-primary/);

    // Cleanup
    await page.locator(`[data-testid="mcp-prompt-${promptType}-history"]`).click();
    await page.waitForTimeout(300);
    await textarea.fill(originalValue);
    await saveBtn.click();
    await page.waitForTimeout(1000);
  });
});
