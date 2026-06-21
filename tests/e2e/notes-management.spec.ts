/**
 * Notes Management E2E Tests
 * Tests for notes list, creation, editing, history, and deletion
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

// Generate unique test user for isolation
const testUser = {
  email: `notes-test-${Date.now()}@example.com`,
  password: "TestPassword123!",
  name: "Notes Test User",
};

test.describe("Notes Management", () => {
  test.beforeAll(async () => {
    // Create test user once before all tests
    const result = await createTestUser(testUser.email, testUser.password, testUser.name, true);
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }
  });

  test.beforeEach(async ({ page }) => {
    // Login as test user before each test
    await login(page, testUser.email, testUser.password);
  });

  test("notes page displays empty state for new user", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Check page title (use main content h1, not sidebar)
    await expect(
      page.getByRole("heading", { name: /Notes|Заметки/, level: 1 }).last(),
    ).toBeVisible();

    // Check empty state message
    await expect(page.getByText(/No notes yet|Заметок пока нет/)).toBeVisible();

    // Check create button is present
    await expect(page.getByTestId("create-note-button")).toBeVisible();

    // Check quota indicator is present
    await expect(page.getByTestId("quota-indicator")).toBeVisible();
  });

  test("sidebar shows notes navigation link", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Find notes link in sidebar
    const notesLink = page.locator('a[href="/notes"]');
    await expect(notesLink).toBeVisible();

    // Click and navigate to notes
    await notesLink.click();
    await page.waitForURL("**/notes");

    // Verify we're on notes page (use main content h1, not sidebar)
    await expect(
      page.getByRole("heading", { name: /Notes|Заметки/, level: 1 }).last(),
    ).toBeVisible();
  });

  test("create new note with key and content", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Click create button
    await page.getByTestId("create-note-button").click();

    // Wait for inline editor to appear
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();

    // Fill in note details
    const testKey = `test-note-${Date.now()}`;
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("This is test content for the note.");

    // Add a tag
    await page.getByTestId("note-tag-input").fill("test-tag");
    await page.keyboard.press("Enter");

    // Save the note
    await page.getByTestId("save-note-button").click();

    // Wait for inline editor to close
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Verify note appears in the list
    await expect(page.getByTestId(`note-row-${testKey}`)).toBeVisible();

    // Verify tag is shown
    await expect(page.getByTestId("tag-test-tag")).toBeVisible();
  });

  test("edit existing note content", async ({ page }) => {
    // First create a note
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `edit-test-${Date.now()}`;

    await page.getByTestId("create-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();

    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Original content");
    await page.getByTestId("save-note-button").click();

    await expect(page.getByTestId("note-inline-editor")).toBeHidden();
    await expect(page.getByTestId(`note-row-${testKey}`)).toBeVisible();

    // Now edit the note by clicking the edit action
    await page.getByTestId(`edit-note-${testKey}`).click();

    // Wait for inline editor and content to load
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    await expect(page.getByTestId("note-content-input")).toHaveValue("Original content");

    // Update content
    await page.getByTestId("note-content-input").fill("Updated content");
    await page.getByTestId("save-note-button").click();

    // Wait for inline editor to close
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Verify note still exists
    await expect(page.getByTestId(`note-row-${testKey}`)).toBeVisible();
  });

  test("view note version history", async ({ page }) => {
    // Create a note with multiple versions
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `history-test-${Date.now()}`;

    // Create initial version
    await page.getByTestId("create-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Version 1 content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Edit to create version 2
    await page.getByTestId(`edit-note-${testKey}`).click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    await page.getByTestId("note-content-input").fill("Version 2 content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open history dialog
    await page.getByTestId(`history-note-${testKey}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Verify we see version entries
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByTestId("version-2")).toBeVisible();

    // Click version 1 to view content
    await page.getByTestId("version-1").click();

    // Verify version 1 content is shown in the content viewer
    await expect(page.locator("pre").getByText("Version 1 content")).toBeVisible();
  });

  test("restore old version creates new version", async ({ page }) => {
    test.slow();
    // Create a note with multiple versions
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `restore-test-${Date.now()}`;

    // Create initial version
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("First version");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create second version
    await page.getByTestId(`edit-note-${testKey}`).click();
    await page.getByTestId("note-content-input").fill("Second version");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open history and restore version 1
    await page.getByTestId(`history-note-${testKey}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.getByTestId("version-1").click();
    await page.getByTestId("restore-version-button").click();

    // Confirm restore
    await page.getByRole("button", { name: /Restore|Восстановить/ }).click();

    // Dialog should close
    await expect(page.getByRole("dialog")).toBeHidden();

    // Open history again to verify new version was created
    await page.getByTestId(`history-note-${testKey}`).click();
    await expect(page.getByTestId("version-3")).toBeVisible();
  });

  test("diff view shows changes between versions", async ({ page }) => {
    // Create a note with multiple versions with different content
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `diff-test-${Date.now()}`;

    // Create initial version
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Line one\nLine two\nLine three");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create second version with changed content
    await page.getByTestId(`edit-note-${testKey}`).click();
    await page
      .getByTestId("note-content-input")
      .fill("Line one\nLine modified\nLine three\nLine four");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open history dialog
    await page.getByTestId(`history-note-${testKey}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Select version 1 (older version, not current)
    await page.getByTestId("version-1").click();
    await expect(page.getByTestId("version-content")).toBeVisible();

    // Switch to diff tab
    const diffTab = page.getByRole("tab", { name: "Diff" });
    await expect(diffTab).toBeEnabled();
    await diffTab.click();

    // Verify diff view is rendered
    await expect(page.getByTestId("diff-view")).toBeVisible();
  });

  test("diff tab is disabled for current version", async ({ page }) => {
    // Create a note with 2 versions
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `diff-disabled-${Date.now()}`;

    // Create initial version
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Initial content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create second version
    await page.getByTestId(`edit-note-${testKey}`).click();
    await page.getByTestId("note-content-input").fill("Updated content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open history dialog
    await page.getByTestId(`history-note-${testKey}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Select current (latest) version - version 2
    await page.getByTestId("version-2").click();

    // Diff tab should be disabled for current version
    const diffTab = page.getByRole("tab", { name: "Diff" });
    await expect(diffTab).toBeDisabled();

    // Restore button should not be visible for current version
    await expect(page.getByTestId("restore-version-button")).toBeHidden();
  });

  test("delete note removes from list", async ({ page }) => {
    // Create a note to delete
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `delete-test-${Date.now()}`;

    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Content to delete");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Verify note exists
    await expect(page.getByTestId(`note-row-${testKey}`)).toBeVisible();

    // Click delete button
    await page.getByTestId(`delete-note-${testKey}`).click();

    // Confirm deletion
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: /Delete|Удалить/ }).click();

    // Verify note is removed
    await expect(page.getByTestId(`note-row-${testKey}`)).toBeHidden();
  });

  test("tag click filters notes by tag", async ({ page }) => {
    // Create notes with different tags
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey1 = `tag-filter-1-${Date.now()}`;
    const testKey2 = `tag-filter-2-${Date.now()}`;
    const uniqueTag = `unique-tag-${Date.now()}`;

    // Create first note with unique tag
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey1);
    await page.getByTestId("note-content-input").fill("Content 1");
    await page.getByTestId("note-tag-input").fill(uniqueTag);
    await page.keyboard.press("Enter");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create second note without tag
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey2);
    await page.getByTestId("note-content-input").fill("Content 2");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Verify both notes are visible
    await expect(page.getByTestId(`note-row-${testKey1}`)).toBeVisible();
    await expect(page.getByTestId(`note-row-${testKey2}`)).toBeVisible();

    // Click tag to filter
    await page.getByTestId(`tag-${uniqueTag}`).click();

    // Verify only first note is visible
    await expect(page.getByTestId(`note-row-${testKey1}`)).toBeVisible();
    await expect(page.getByTestId(`note-row-${testKey2}`)).toBeHidden();

    // Clear filter
    await page.getByTestId("clear-tag-filter").click();

    // Both notes should be visible again
    await expect(page.getByTestId(`note-row-${testKey1}`)).toBeVisible();
    await expect(page.getByTestId(`note-row-${testKey2}`)).toBeVisible();
  });

  test("search filters notes by key name", async ({ page }) => {
    // Create notes with different keys
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const uniquePrefix = `search-${Date.now()}`;
    const testKey1 = `${uniquePrefix}-alpha`;
    const testKey2 = `other-note-${Date.now()}`;

    // Create first note
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey1);
    await page.getByTestId("note-content-input").fill("Content 1");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create second note
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey2);
    await page.getByTestId("note-content-input").fill("Content 2");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Search by unique prefix
    await page.getByTestId("notes-search").fill(uniquePrefix);

    // Wait for debounce
    await page.waitForTimeout(400);

    // Verify only matching note is visible
    await expect(page.getByTestId(`note-row-${testKey1}`)).toBeVisible();
    await expect(page.getByTestId(`note-row-${testKey2}`)).toBeHidden();

    // Clear search
    await page.getByTestId("notes-search").fill("");
    await page.waitForTimeout(400);

    // Both notes should be visible again
    await expect(page.getByTestId(`note-row-${testKey1}`)).toBeVisible();
    await expect(page.getByTestId(`note-row-${testKey2}`)).toBeVisible();
  });

  test("quota indicator shows usage percentage", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Quota indicator should be visible
    const quotaIndicator = page.getByTestId("quota-indicator");
    await expect(quotaIndicator).toBeVisible();

    // Should show some percentage text (e.g., "0.0% used" or "X KB / 1 MB")
    await expect(quotaIndicator).toContainText(/KB|MB|%/);
  });

  test("key validation shows error for invalid format", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("create-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();

    // Enter invalid key with spaces
    await page.getByTestId("note-key-input").fill("invalid key with spaces");

    // Should show validation error
    await expect(
      page.getByText(/only contain letters|может содержать только буквы/i),
    ).toBeVisible();

    // Save button should be disabled
    await expect(page.getByTestId("save-note-button")).toBeDisabled();
  });

  test("markdown preview toggle shows rendered content", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Create note with markdown content
    const testKey = `md-preview-${Date.now()}`;

    await page.getByTestId("create-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();

    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("# Heading\n\n**bold text**\n\n- list item");

    // Initially should show textarea
    await expect(page.getByTestId("note-content-input")).toBeVisible();
    await expect(page.getByTestId("note-content-preview")).toBeHidden();

    // Click preview toggle
    await page.getByTestId("markdown-preview-toggle").click();

    // Should now show preview
    await expect(page.getByTestId("note-content-preview")).toBeVisible();
    await expect(page.getByTestId("note-content-input")).toBeHidden();

    // Preview should contain rendered markdown (h1, strong, li elements)
    await expect(page.getByTestId("note-content-preview").locator("h1")).toBeVisible();
    await expect(page.getByTestId("note-content-preview").locator("strong")).toBeVisible();

    // Toggle back to edit
    await page.getByTestId("markdown-preview-toggle").click();

    // Should show textarea again
    await expect(page.getByTestId("note-content-input")).toBeVisible();
    await expect(page.getByTestId("note-content-preview")).toBeHidden();
  });

  test("tag autocomplete suggests existing tags", async ({ page }) => {
    // Create a note with a tag first
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    const testKey = `autocomplete-${Date.now()}`;
    const existingTag = `existing-tag-${Date.now()}`;

    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Content");
    await page.getByTestId("note-tag-input").fill(existingTag);
    await page.keyboard.press("Enter");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Create another note and check autocomplete
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(`${testKey}-2`);

    // Type part of existing tag
    await page.getByTestId("note-tag-input").fill(existingTag.substring(0, 8));

    // Wait a bit for suggestions
    await page.waitForTimeout(200);

    // Autocomplete suggestion should appear (as a button in dropdown)
    await expect(page.locator(`button:has-text("${existingTag}")`)).toBeVisible();
  });

  test("persistent new note card expands to inline editor", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Persistent card visible when not editing
    const newNoteCard = page.getByTestId("new-note-card");
    await expect(newNoteCard).toBeVisible();

    // Click it → inline editor appears
    await newNoteCard.click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    await expect(page.getByTestId("note-key-input")).toBeVisible();

    // Persistent card hidden while editing
    await expect(newNoteCard).toBeHidden();

    // Cancel → persistent card reappears
    await page.getByTestId("cancel-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();
    await expect(newNoteCard).toBeVisible();
  });

  test("version switcher shows versions in inline editor", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Create a note with initial content
    const testKey = `version-switch-${Date.now()}`;
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Version 1 content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Edit and save again to create version 2
    await page.getByText(testKey).click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    await page.getByTestId("note-content-input").fill("Version 2 content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open editor again — version switcher should be visible
    await page.getByText(testKey).click();
    await expect(page.getByTestId("note-inline-editor")).toBeVisible();
    const versionSwitcher = page.getByTestId("version-switcher");
    await expect(versionSwitcher).toBeVisible();

    // Open version dropdown
    await versionSwitcher.click();
    const dropdown = page.getByTestId("version-dropdown");
    await expect(dropdown).toBeVisible();

    // Select version 1 → content becomes read-only
    await page.getByTestId("version-option-1").click();
    await expect(page.getByTestId("older-version-indicator")).toBeVisible();
    await expect(page.getByTestId("note-content-preview")).toBeVisible();
    await expect(page.getByTestId("note-content-preview")).toContainText("Version 1 content");

    // Restore button appears instead of Save
    await expect(page.getByTestId("restore-version-button")).toBeVisible();
    await expect(page.getByTestId("save-note-button")).toBeHidden();

    // Cancel out
    await page.getByTestId("cancel-note-button").click();
  });

  test("restore from version switcher creates new version", async ({ page }) => {
    await page.goto(`${BASE_URL}/notes`);
    await page.waitForLoadState("domcontentloaded");

    // Create note v1
    const testKey = `restore-vs-${Date.now()}`;
    await page.getByTestId("create-note-button").click();
    await page.getByTestId("note-key-input").fill(testKey);
    await page.getByTestId("note-content-input").fill("Original content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Edit to create v2
    await page.getByText(testKey).click();
    await page.getByTestId("note-content-input").fill("Modified content");
    await page.getByTestId("save-note-button").click();
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Open editor, switch to v1, restore
    await page.getByText(testKey).click();
    await page.getByTestId("version-switcher").click();
    await page.getByTestId("version-option-1").click();
    await page.getByTestId("restore-version-button").click();

    // Confirm restore dialog
    await page.getByTestId("confirm-restore-button").click();

    // Editor closes, note refreshed
    await expect(page.getByTestId("note-inline-editor")).toBeHidden();

    // Verify restored content — reopen editor
    await page.getByText(testKey).click();
    await expect(page.getByTestId("note-content-input")).toHaveValue("Original content");
    await page.getByTestId("cancel-note-button").click();
  });
});
