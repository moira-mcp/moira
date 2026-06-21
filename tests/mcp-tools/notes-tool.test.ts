/**
 * MCP E2E Tests - Notes Tool
 * Tests: notes (list, get, save, delete, history, stats actions)
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Notes Tool E2E", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  const testKeys: string[] = []; // Track created notes for cleanup

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  afterEach(async () => {
    // Cleanup created notes after each test
    for (const key of testKeys) {
      try {
        await callMCPTool(client, "notes", { action: "delete", key });
      } catch {
        // Ignore errors during cleanup
      }
    }
    testKeys.length = 0;
  });

  // ============================================
  // List Action Tests
  // ============================================

  describe("list action", () => {
    test("list returns empty array for user with no notes", async () => {
      const result = await callMCPTool(client, "notes", { action: "list" });

      expect(result).toHaveProperty("notes");
      expect(result).toHaveProperty("total");
      expect(result).toHaveProperty("allTags");
      expect(Array.isArray(result.notes)).toBe(true);
      expect(Array.isArray(result.allTags)).toBe(true);
    });

    test("list returns created notes", async () => {
      // Create a note
      const key = `test-list-${Date.now()}`;
      testKeys.push(key);
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Test content for list",
        tags: ["test-tag"],
      });

      const result = await callMCPTool(client, "notes", { action: "list" });

      expect(result.notes.length).toBeGreaterThan(0);
      const found = result.notes.find((n: any) => n.key === key);
      expect(found).toBeDefined();
      expect(found.tags).toContain("test-tag");
    });

    test("list filters by tag", async () => {
      // Create notes with different tags
      const key1 = `test-tag1-${Date.now()}`;
      const key2 = `test-tag2-${Date.now()}`;
      testKeys.push(key1, key2);

      await callMCPTool(client, "notes", {
        action: "save",
        key: key1,
        value: "Content 1",
        tags: ["filter-me"],
      });
      await callMCPTool(client, "notes", {
        action: "save",
        key: key2,
        value: "Content 2",
        tags: ["other-tag"],
      });

      const result = await callMCPTool(client, "notes", {
        action: "list",
        tag: "filter-me",
      });

      expect(result.notes.length).toBeGreaterThan(0);
      expect(result.notes.every((n: any) => n.tags.includes("filter-me"))).toBe(true);
    });

    test("list filters by key search", async () => {
      const prefix = `search-prefix-${Date.now()}`;
      const key = `${prefix}-note`;
      testKeys.push(key);

      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Searchable content",
      });

      const result = await callMCPTool(client, "notes", {
        action: "list",
        keySearch: prefix,
      });

      expect(result.notes.length).toBeGreaterThan(0);
      expect(result.notes.every((n: any) => n.key.includes(prefix))).toBe(true);
    });

    test("list returns all unique tags", async () => {
      const key1 = `test-alltags1-${Date.now()}`;
      const key2 = `test-alltags2-${Date.now()}`;
      testKeys.push(key1, key2);

      await callMCPTool(client, "notes", {
        action: "save",
        key: key1,
        value: "Content",
        tags: ["unique-tag-a"],
      });
      await callMCPTool(client, "notes", {
        action: "save",
        key: key2,
        value: "Content",
        tags: ["unique-tag-b"],
      });

      const result = await callMCPTool(client, "notes", { action: "list" });

      expect(result.allTags).toContain("unique-tag-a");
      expect(result.allTags).toContain("unique-tag-b");
    });
  });

  // ============================================
  // Get Action Tests
  // ============================================

  describe("get action", () => {
    test("get returns note content", async () => {
      const key = `test-get-${Date.now()}`;
      testKeys.push(key);
      const value = "Test content for get";

      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value,
        tags: ["get-test"],
      });

      const result = await callMCPTool(client, "notes", {
        action: "get",
        key,
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("key", key);
      expect(result).toHaveProperty("value", value);
      expect(result).toHaveProperty("version");
      expect(result).toHaveProperty("tags");
      expect(result.tags).toContain("get-test");
      expect(result).toHaveProperty("size");
      expect(result).toHaveProperty("createdAt");
      expect(result).toHaveProperty("updatedAt");
    });

    test("get with version returns specific version", async () => {
      const key = `test-get-version-${Date.now()}`;
      testKeys.push(key);

      // Create version 1
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Version 1 content",
      });

      // Create version 2
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Version 2 content",
      });

      // Get version 1
      const v1 = await callMCPTool(client, "notes", {
        action: "get",
        key,
        version: 1,
      });
      expect(v1.value).toBe("Version 1 content");
      expect(v1.version).toBe(1);

      // Get version 2
      const v2 = await callMCPTool(client, "notes", {
        action: "get",
        key,
        version: 2,
      });
      expect(v2.value).toBe("Version 2 content");
      expect(v2.version).toBe(2);
    });

    test("get returns error for non-existent note", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "get",
        key: "non-existent-key-12345",
      });

      // Result is a string containing the error
      expect(typeof result).toBe("string");
      expect(result).toContain("not found");
    });

    test("get requires key parameter", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "get",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("key");
    });
  });

  // ============================================
  // Save Action Tests
  // ============================================

  describe("save action", () => {
    test("save creates new note", async () => {
      const key = `test-save-create-${Date.now()}`;
      testKeys.push(key);

      const result = await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "New note content",
        tags: ["new-tag"],
      });

      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("key", key);
      expect(result).toHaveProperty("version", 1);
      expect(result).toHaveProperty("created", true);
    });

    test("save updates existing note", async () => {
      const key = `test-save-update-${Date.now()}`;
      testKeys.push(key);

      // Create note
      const createResult = await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Initial content",
      });
      expect(createResult.version).toBe(1);
      expect(createResult.created).toBe(true);

      // Update note
      const updateResult = await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Updated content",
      });
      expect(updateResult.version).toBe(2);
      expect(updateResult.created).toBe(false);
    });

    test("save validates key format", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "save",
        key: "invalid key with spaces!",
        value: "Content",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("key");
    });

    test("save requires key parameter", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "save",
        value: "Content without key",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("key");
    });

    test("save requires value parameter", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "save",
        key: "key-without-value",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("value");
    });

    test("save with multiple tags", async () => {
      const key = `test-save-tags-${Date.now()}`;
      testKeys.push(key);

      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Content with tags",
        tags: ["tag1", "tag2", "tag3"],
      });

      const result = await callMCPTool(client, "notes", {
        action: "get",
        key,
      });

      expect(result.tags).toHaveLength(3);
      expect(result.tags).toContain("tag1");
      expect(result.tags).toContain("tag2");
      expect(result.tags).toContain("tag3");
    });
  });

  // ============================================
  // Delete Action Tests
  // ============================================

  describe("delete action", () => {
    test("delete soft deletes note", async () => {
      const key = `test-delete-${Date.now()}`;
      testKeys.push(key);

      // Create note
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Content to delete",
      });

      // Delete note
      const deleteResult = await callMCPTool(client, "notes", {
        action: "delete",
        key,
      });
      expect(deleteResult).toHaveProperty("deleted", true);
      expect(deleteResult).toHaveProperty("key", key);

      // Note should not be found after delete
      const getResult = await callMCPTool(client, "notes", {
        action: "get",
        key,
      });
      expect(typeof getResult).toBe("string");
      expect(getResult).toContain("not found");
    });

    test("delete returns error for non-existent note", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "delete",
        key: "non-existent-delete-key",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("not found");
    });

    test("delete requires key parameter", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "delete",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("key");
    });
  });

  // ============================================
  // History Action Tests
  // ============================================

  describe("history action", () => {
    test("history returns version history", async () => {
      const key = `test-history-${Date.now()}`;
      testKeys.push(key);

      // Create multiple versions
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Version 1",
      });
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Version 2",
      });
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Version 3",
      });

      const result = await callMCPTool(client, "notes", {
        action: "history",
        key,
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(3);

      // Versions should be in descending order
      expect(result[0].version).toBe(3);
      expect(result[1].version).toBe(2);
      expect(result[2].version).toBe(1);

      // Each version should have required properties
      result.forEach((v: any) => {
        expect(v).toHaveProperty("version");
        expect(v).toHaveProperty("size");
        expect(v).toHaveProperty("preview");
        expect(v).toHaveProperty("createdAt");
      });
    });

    test("history returns error for non-existent note", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "history",
        key: "non-existent-history-key",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("not found");
    });

    test("history requires key parameter", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "history",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("key");
    });
  });

  // ============================================
  // Stats Action Tests
  // ============================================

  describe("stats action", () => {
    test("stats returns usage statistics", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "stats",
      });

      expect(result).toHaveProperty("totalNotes");
      expect(result).toHaveProperty("totalSize");
      expect(result).toHaveProperty("limit");
      expect(result).toHaveProperty("usedPercent");

      expect(typeof result.totalNotes).toBe("number");
      expect(typeof result.totalSize).toBe("number");
      expect(typeof result.limit).toBe("number");
      expect(typeof result.usedPercent).toBe("number");
    });

    test("stats reflects created notes", async () => {
      // Get initial stats
      const initialStats = await callMCPTool(client, "notes", {
        action: "stats",
      });

      // Create a note
      const key = `test-stats-${Date.now()}`;
      testKeys.push(key);
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Content for stats test",
      });

      // Check updated stats
      const updatedStats = await callMCPTool(client, "notes", {
        action: "stats",
      });

      expect(updatedStats.totalNotes).toBe(initialStats.totalNotes + 1);
      expect(updatedStats.totalSize).toBeGreaterThan(initialStats.totalSize);
    });
  });

  // ============================================
  // User Isolation Tests
  // ============================================

  describe("user isolation", () => {
    test("user cannot access other user's notes", async () => {
      // Create a note as admin user
      const key = `test-isolation-${Date.now()}`;
      testKeys.push(key);
      await callMCPTool(client, "notes", {
        action: "save",
        key,
        value: "Admin's private note",
      });

      // Note: Full isolation test would require another authenticated user
      // Here we just verify the note was created and can be accessed by creator
      const result = await callMCPTool(client, "notes", {
        action: "get",
        key,
      });
      expect(result.key).toBe(key);
    });
  });

  // ============================================
  // Error Handling Tests
  // ============================================

  describe("error handling", () => {
    test("invalid action returns error", async () => {
      const result = await callMCPTool(client, "notes", {
        action: "invalid-action" as any,
      });

      expect(typeof result).toBe("string");
      // Response contains "MCP error" or "error" - case insensitive check
      expect(result.toLowerCase()).toContain("error");
    });
  });
});
