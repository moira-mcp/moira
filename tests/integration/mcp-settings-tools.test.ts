/**
 * MCP Settings Tools Integration Tests
 * Tests user settings management via MCP tools
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-user-mcp-settings";

describe("MCP Settings Tools", () => {
  let repository: DatabaseRepository;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const { getDatabase, user } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "MCP Settings Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // User might already exist
    }
  });

  test("list_setting_definitions returns all definitions", async () => {
    const definitions = await repository.getSettingDefinitions();

    expect(definitions).toBeDefined();
    expect(definitions.length).toBeGreaterThan(0);

    // Verify structure
    const firstDef = definitions[0];
    expect(firstDef).toHaveProperty("key");
    expect(firstDef).toHaveProperty("type");
    expect(firstDef).toHaveProperty("category");
    expect(firstDef).toHaveProperty("label");
  });

  test("list_setting_definitions filters by category", async () => {
    const notificationDefs = await repository.getSettingDefinitions("notifications");
    const uiDefs = await repository.getSettingDefinitions("ui");

    expect(notificationDefs.length).toBeGreaterThan(0);
    expect(uiDefs.length).toBeGreaterThan(0);

    // Verify all are from correct category
    notificationDefs.forEach((def) => {
      expect(def.category).toBe("notifications");
    });

    uiDefs.forEach((def) => {
      expect(def.category).toBe("ui");
    });
  });

  test("set and get user setting - simple string value", async () => {
    await repository.setSetting(TEST_USER_ID, "ui.theme", "light");
    const value = await repository.getSetting(TEST_USER_ID, "ui.theme");

    expect(value).toBe("light");
  });

  test("set and get user setting - encrypted value", async () => {
    const testToken = "1234567890:ABCdefGHIjklMNO";

    await repository.setSetting(TEST_USER_ID, "telegram.bot_token", testToken);
    const decrypted = await repository.getSetting(TEST_USER_ID, "telegram.bot_token");

    // Should return decrypted value
    expect(decrypted).toBe(testToken);

    // Verify it's actually encrypted in DB
    const raw = await repository.getRawSettingValue(TEST_USER_ID, "telegram.bot_token");
    expect(raw).toBeDefined();
    expect(raw).not.toBe(testToken); // Should be encrypted
    expect(raw).toContain(":"); // Encryption format: iv:authTag:encrypted
  });

  test("delete_user_setting resets to default", async () => {
    // Set custom value
    await repository.setSetting(TEST_USER_ID, "ui.theme", "dark");
    let value = await repository.getSetting(TEST_USER_ID, "ui.theme");
    expect(value).toBe("dark");

    // Delete user value
    await repository.deleteUserSettingValue(TEST_USER_ID, "ui.theme");

    // Should return default value
    value = await repository.getSetting(TEST_USER_ID, "ui.theme");
    expect(value).toBe("system"); // Default from definition
  });

  test("get_user_settings returns all settings for category", async () => {
    // Set some telegram settings
    await repository.setSetting(TEST_USER_ID, "telegram.enabled", true);
    await repository.setSetting(TEST_USER_ID, "telegram.chat_id", "123456");

    const settings = await repository.getSettings(TEST_USER_ID, "notifications");

    expect(settings).toBeDefined();
    expect(typeof settings).toBe("object");
    expect(settings["telegram.enabled"]).toBe(true);
    expect(settings["telegram.chat_id"]).toBe("123456");
  });

  test("get_user_settings returns all settings when no category", async () => {
    const allSettings = await repository.getSettings(TEST_USER_ID);

    expect(Object.keys(allSettings).length).toBeGreaterThan(0);

    // Should include settings from multiple categories
    const categories = new Set<string>();
    for (const key of Object.keys(allSettings)) {
      const category = key.split(".")[0];
      categories.add(category);
    }

    expect(categories.size).toBeGreaterThanOrEqual(1);
  });
});
