/**
 * Unit tests for GlobalSettingsRepository
 * Tests global settings CRUD operations with in-memory database
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { GlobalSettingsRepository } from "@mcp-moira/shared";
import * as schema from "@mcp-moira/shared";

describe("GlobalSettingsRepository", () => {
  let sqlite: ReturnType<typeof Database>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repository: GlobalSettingsRepository;
  const adminUserId = "admin-user-123";

  beforeEach(() => {
    // Create in-memory SQLite database
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Create globalSetting table
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS globalSetting (
        key TEXT PRIMARY KEY,
        value TEXT,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'general',
        sortOrder INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT
      )
    `);

    repository = new GlobalSettingsRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // Helper to seed test data
  const seedSetting = (
    key: string,
    value: string | null,
    type: string,
    category: string = "general",
  ) => {
    sqlite
      .prepare(
        `
      INSERT INTO globalSetting (key, value, type, label, description, category, sortOrder, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `,
      )
      .run(key, value, type, `Label for ${key}`, `Description for ${key}`, category, Date.now());
  };

  describe("getAll", () => {
    it("returns empty array when no settings exist", async () => {
      const settings = await repository.getAll();
      expect(settings).toEqual([]);
    });

    it("returns all settings ordered by category and sortOrder", async () => {
      seedSetting("b.setting", "value-b", "string", "beta");
      seedSetting("a.setting", "value-a", "string", "alpha");
      seedSetting("c.setting", "value-c", "string", "gamma");

      const settings = await repository.getAll();

      expect(settings).toHaveLength(3);
      expect(settings[0].category).toBe("alpha");
      expect(settings[1].category).toBe("beta");
      expect(settings[2].category).toBe("gamma");
    });

    it("returns settings with all fields populated", async () => {
      seedSetting("mcp.systemReminder", "Test reminder", "text", "mcp");

      const settings = await repository.getAll();

      expect(settings).toHaveLength(1);
      expect(settings[0]).toMatchObject({
        key: "mcp.systemReminder",
        value: "Test reminder",
        type: "text",
        label: "Label for mcp.systemReminder",
        description: "Description for mcp.systemReminder",
        category: "mcp",
        sortOrder: 0,
      });
      expect(settings[0].updatedAt).toBeGreaterThan(0);
    });
  });

  describe("get", () => {
    it("returns null for non-existent setting", async () => {
      const setting = await repository.get("non.existent");
      expect(setting).toBeNull();
    });

    it("returns setting by key", async () => {
      seedSetting("test.setting", "test-value", "string");

      const setting = await repository.get("test.setting");

      expect(setting).not.toBeNull();
      expect(setting?.key).toBe("test.setting");
      expect(setting?.value).toBe("test-value");
    });
  });

  describe("getValue", () => {
    it("returns null for non-existent setting", async () => {
      const value = await repository.getValue("non.existent");
      expect(value).toBeNull();
    });

    it("returns null for setting with null value", async () => {
      seedSetting("test.null", null, "string");

      const value = await repository.getValue("test.null");
      expect(value).toBeNull();
    });

    it("returns string value for string type", async () => {
      seedSetting("test.string", "hello", "string");

      const value = await repository.getValue<string>("test.string");
      expect(value).toBe("hello");
    });

    it("returns string value for text type", async () => {
      seedSetting("test.text", "multi\nline\ntext", "text");

      const value = await repository.getValue<string>("test.text");
      expect(value).toBe("multi\nline\ntext");
    });

    it("converts number type to number", async () => {
      seedSetting("test.number", "42", "number");

      const value = await repository.getValue<number>("test.number");
      expect(value).toBe(42);
      expect(typeof value).toBe("number");
    });

    it("converts boolean type true", async () => {
      seedSetting("test.bool.true", "true", "boolean");

      const value = await repository.getValue<boolean>("test.bool.true");
      expect(value).toBe(true);
    });

    it("converts boolean type 1", async () => {
      seedSetting("test.bool.one", "1", "boolean");

      const value = await repository.getValue<boolean>("test.bool.one");
      expect(value).toBe(true);
    });

    it("converts boolean type false", async () => {
      seedSetting("test.bool.false", "false", "boolean");

      const value = await repository.getValue<boolean>("test.bool.false");
      expect(value).toBe(false);
    });
  });

  describe("setValue", () => {
    it("updates existing setting value", async () => {
      seedSetting("test.update", "old-value", "string");

      await repository.setValue("test.update", "new-value", adminUserId);

      const setting = await repository.get("test.update");
      expect(setting?.value).toBe("new-value");
      expect(setting?.updatedBy).toBe(adminUserId);
    });

    it("sets value to null", async () => {
      seedSetting("test.nullable", "some-value", "string");

      await repository.setValue("test.nullable", null, adminUserId);

      const setting = await repository.get("test.nullable");
      expect(setting?.value).toBeNull();
    });

    it("updates updatedAt timestamp", async () => {
      seedSetting("test.timestamp", "value", "string");
      const before = await repository.get("test.timestamp");

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      await repository.setValue("test.timestamp", "new-value", adminUserId);
      const after = await repository.get("test.timestamp");

      expect(after?.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt || 0);
    });
  });

  describe("getByCategory", () => {
    it("returns empty array for non-existent category", async () => {
      const settings = await repository.getByCategory("non-existent");
      expect(settings).toEqual([]);
    });

    it("returns only settings from specified category", async () => {
      seedSetting("mcp.setting1", "v1", "string", "mcp");
      seedSetting("mcp.setting2", "v2", "string", "mcp");
      seedSetting("ui.theme", "dark", "string", "ui");

      const mcpSettings = await repository.getByCategory("mcp");

      expect(mcpSettings).toHaveLength(2);
      expect(mcpSettings.every((s) => s.category === "mcp")).toBe(true);
    });

    it("returns settings ordered by sortOrder within category", async () => {
      // Insert in reverse order to verify sorting
      sqlite
        .prepare(
          `
        INSERT INTO globalSetting (key, value, type, label, category, sortOrder, updatedAt)
        VALUES (?, ?, 'string', ?, 'test', ?, ?)
      `,
        )
        .run("test.third", "v3", "Third", 3, Date.now());

      sqlite
        .prepare(
          `
        INSERT INTO globalSetting (key, value, type, label, category, sortOrder, updatedAt)
        VALUES (?, ?, 'string', ?, 'test', ?, ?)
      `,
        )
        .run("test.first", "v1", "First", 1, Date.now());

      sqlite
        .prepare(
          `
        INSERT INTO globalSetting (key, value, type, label, category, sortOrder, updatedAt)
        VALUES (?, ?, 'string', ?, 'test', ?, ?)
      `,
        )
        .run("test.second", "v2", "Second", 2, Date.now());

      const settings = await repository.getByCategory("test");

      expect(settings).toHaveLength(3);
      expect(settings[0].sortOrder).toBe(1);
      expect(settings[1].sortOrder).toBe(2);
      expect(settings[2].sortOrder).toBe(3);
    });
  });
});
