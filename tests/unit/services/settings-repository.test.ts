/**
 * Unit tests for Settings via InMemoryRepository
 * Tests actual implementation used in workflow engine tests
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { InMemoryRepository } from "@mcp-moira/workflow-engine";
import { generateEncryptionKey } from "@mcp-moira/workflow-engine";
import type { SettingDefinition } from "@mcp-moira/workflow-engine";

describe("Settings Repository (InMemory)", () => {
  let repository: InMemoryRepository;
  const testUserId = "test-user-123";

  beforeEach(() => {
    process.env.TELEGRAM_ENCRYPTION_KEY = generateEncryptionKey();
    repository = new InMemoryRepository();
  });

  describe("getSetting / setSetting", () => {
    beforeEach(() => {
      const now = Date.now();
      repository.addSettingDefinition({
        key: "test.string",
        type: "string",
        category: "test",
        label: "Test String",
        description: "Test",
        defaultValue: "default",
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("returns null for non-existent setting", async () => {
      const value = await repository.getSetting(testUserId, "non.existent");
      expect(value).toBeNull();
    });

    it("returns default value if no user value set", async () => {
      const value = await repository.getSetting(testUserId, "test.string");
      expect(value).toBe("default");
    });

    it("sets and gets value correctly", async () => {
      await repository.setSetting(testUserId, "test.string", "custom");
      const value = await repository.getSetting(testUserId, "test.string");
      expect(value).toBe("custom");
    });

    it("updates existing value", async () => {
      await repository.setSetting(testUserId, "test.string", "v1");
      await repository.setSetting(testUserId, "test.string", "v2");
      const value = await repository.getSetting(testUserId, "test.string");
      expect(value).toBe("v2");
    });
  });

  describe("type conversions", () => {
    beforeEach(() => {
      const now = Date.now();

      const defs: SettingDefinition[] = [
        {
          key: "test.number",
          type: "number",
          category: "test",
          label: "Number",
          description: null,
          defaultValue: null,
          required: false,
          validation: null,
          adminOnly: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          key: "test.boolean",
          type: "boolean",
          category: "test",
          label: "Boolean",
          description: null,
          defaultValue: null,
          required: false,
          validation: null,
          adminOnly: false,
          createdAt: now,
          updatedAt: now,
        },
        {
          key: "test.json",
          type: "json",
          category: "test",
          label: "JSON",
          description: null,
          defaultValue: null,
          required: false,
          validation: null,
          adminOnly: false,
          createdAt: now,
          updatedAt: now,
        },
      ];

      defs.forEach((d) => repository.addSettingDefinition(d));
    });

    it("handles number type", async () => {
      await repository.setSetting(testUserId, "test.number", 42);
      const value = await repository.getSetting<number>(testUserId, "test.number");
      expect(value).toBe(42);
      expect(typeof value).toBe("number");
    });

    it("handles boolean type", async () => {
      await repository.setSetting(testUserId, "test.boolean", true);
      const value = await repository.getSetting<boolean>(testUserId, "test.boolean");
      expect(value).toBe(true);

      await repository.setSetting(testUserId, "test.boolean", false);
      const value2 = await repository.getSetting<boolean>(testUserId, "test.boolean");
      expect(value2).toBe(false);
    });

    it("handles json type", async () => {
      const data = { foo: "bar", num: 123 };
      await repository.setSetting(testUserId, "test.json", data);
      const value = await repository.getSetting<object>(testUserId, "test.json");
      expect(value).toEqual(data);
    });
  });

  describe("encrypted type", () => {
    beforeEach(() => {
      const now = Date.now();
      repository.addSettingDefinition({
        key: "test.encrypted",
        type: "encrypted",
        category: "test",
        label: "Encrypted",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("encrypts on save, decrypts on get", async () => {
      const plaintext = "secret-value";
      await repository.setSetting(testUserId, "test.encrypted", plaintext);
      const value = await repository.getSetting<string>(testUserId, "test.encrypted");

      expect(value).toBe(plaintext);
    });
  });

  describe("getSettings bulk", () => {
    beforeEach(() => {
      const now = Date.now();

      repository.addSettingDefinition({
        key: "cat1.s1",
        type: "string",
        category: "cat1",
        label: "S1",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });

      repository.addSettingDefinition({
        key: "cat2.s2",
        type: "number",
        category: "cat2",
        label: "S2",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("gets settings by category", async () => {
      await repository.setSetting(testUserId, "cat1.s1", "value1");
      await repository.setSetting(testUserId, "cat2.s2", 42);

      const cat1Settings = await repository.getSettings(testUserId, "cat1");
      expect(cat1Settings["cat1.s1"]).toBe("value1");
      expect(cat1Settings["cat2.s2"]).toBeUndefined();
    });
  });

  describe("user isolation", () => {
    beforeEach(() => {
      const now = Date.now();
      repository.addSettingDefinition({
        key: "test.setting",
        type: "string",
        category: "test",
        label: "Test",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("isolates settings between users", async () => {
      await repository.setSetting("user1", "test.setting", "value1");
      await repository.setSetting("user2", "test.setting", "value2");

      const v1 = await repository.getSetting("user1", "test.setting");
      const v2 = await repository.getSetting("user2", "test.setting");

      expect(v1).toBe("value1");
      expect(v2).toBe("value2");
    });
  });

  describe("getSettingsForApi - encrypted masking (Issue #374)", () => {
    beforeEach(() => {
      const now = Date.now();

      // Add encrypted setting (like telegram bot token)
      repository.addSettingDefinition({
        key: "telegram.bot_token",
        type: "encrypted",
        category: "telegram",
        label: "Bot Token",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });

      // Add regular string setting
      repository.addSettingDefinition({
        key: "telegram.chat_id",
        type: "string",
        category: "telegram",
        label: "Chat ID",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });

      // Add boolean setting
      repository.addSettingDefinition({
        key: "notifications.enabled",
        type: "boolean",
        category: "notifications",
        label: "Enabled",
        description: null,
        defaultValue: null,
        required: false,
        validation: null,
        adminOnly: false,
        createdAt: now,
        updatedAt: now,
      });
    });

    it("masks encrypted values with [encrypted]", async () => {
      // Set both encrypted and regular values
      await repository.setSetting(testUserId, "telegram.bot_token", "secret-token-123");
      await repository.setSetting(testUserId, "telegram.chat_id", "123456789");

      // getSettingsForApi should mask encrypted
      const apiSettings = await repository.getSettingsForApi(testUserId, "telegram");

      expect(apiSettings["telegram.bot_token"]).toBe("[encrypted]");
      expect(apiSettings["telegram.chat_id"]).toBe("123456789");
    });

    it("returns decrypted value for internal getSettings", async () => {
      await repository.setSetting(testUserId, "telegram.bot_token", "secret-token-123");

      // Internal getSettings should return decrypted value
      const internalSettings = await repository.getSettings(testUserId, "telegram");

      expect(internalSettings["telegram.bot_token"]).toBe("secret-token-123");
    });

    it("does not include encrypted setting if not set", async () => {
      // Only set chat_id, not bot_token
      await repository.setSetting(testUserId, "telegram.chat_id", "123456789");

      const apiSettings = await repository.getSettingsForApi(testUserId, "telegram");

      // bot_token should not be in response at all (no value set)
      expect(apiSettings["telegram.bot_token"]).toBeUndefined();
      expect(apiSettings["telegram.chat_id"]).toBe("123456789");
    });

    it("handles mixed categories correctly", async () => {
      await repository.setSetting(testUserId, "telegram.bot_token", "secret");
      await repository.setSetting(testUserId, "notifications.enabled", true);

      // Get all settings for API
      const allApiSettings = await repository.getSettingsForApi(testUserId);

      expect(allApiSettings["telegram.bot_token"]).toBe("[encrypted]");
      expect(allApiSettings["notifications.enabled"]).toBe(true);
    });
  });
});
