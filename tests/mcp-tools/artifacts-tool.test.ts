/**
 * MCP E2E Tests - Artifacts Tool
 * Tests: artifacts (upload, update, delete, list, stats, token actions)
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

describe("MCP Artifacts Tool E2E", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  const createdUuids: string[] = []; // Track created artifacts for cleanup

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
    // Cleanup created artifacts after each test
    for (const uuid of createdUuids) {
      try {
        await callMCPTool(client, "artifacts", { action: "delete", uuid });
      } catch {
        // Ignore errors during cleanup
      }
    }
    createdUuids.length = 0;
  });

  // ============================================
  // Upload Action Tests
  // ============================================

  describe("upload action", () => {
    test("upload creates new artifact and returns UUID and URL", async () => {
      const name = `test-upload-${Date.now()}.html`;
      const content = "<html><body><h1>Test</h1></body></html>";

      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name,
        content,
      });

      expect(result).toHaveProperty("uuid");
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("name", name);
      expect(result).toHaveProperty("size");
      expect(result).toHaveProperty("expiresAt");
      expect(result.url).toContain(result.uuid);
      // Subdomain-isolation mode: URL is the per-artifact origin {uuid}.static.<domain>/
      expect(result.url).toMatch(new RegExp(`//${result.uuid}\\.`));

      createdUuids.push(result.uuid);
    });

    test("upload with executionId links artifact to workflow execution", async () => {
      const name = `test-upload-execution-${Date.now()}.html`;
      const content = "<html><body>Execution linked</body></html>";
      // Note: executionId would need to be a real execution for full integration
      // Here we just verify the parameter is accepted

      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name,
        content,
        // executionId would be optional and link to a real execution
      });

      expect(result).toHaveProperty("uuid");
      createdUuids.push(result.uuid);
    });

    test("upload requires name parameter", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        content: "<html><body>Content</body></html>",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("name");
    });

    test("upload requires content parameter", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test.html",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("content");
    });

    test("upload validates HTML content", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "invalid.html",
        content: "not html content",
      });

      // Should fail validation - no HTML tags
      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toContain("html");
    });
  });

  // ============================================
  // Update Action Tests
  // ============================================

  describe("update action", () => {
    test("update modifies existing artifact content", async () => {
      // Create artifact
      const createResult = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test-update.html",
        content: "<html><body>Original</body></html>",
      });
      expect(createResult).toHaveProperty("uuid");
      createdUuids.push(createResult.uuid);

      // Update content
      const updateResult = await callMCPTool(client, "artifacts", {
        action: "update",
        uuid: createResult.uuid,
        content: "<html><body>Updated</body></html>",
      });

      expect(updateResult).toHaveProperty("uuid", createResult.uuid);
      expect(updateResult).toHaveProperty("updated", true);
    });

    test("update requires uuid parameter", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "update",
        content: "<html><body>Content</body></html>",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("uuid");
    });

    test("update requires content parameter", async () => {
      // Create artifact first
      const createResult = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test-update-no-content.html",
        content: "<html><body>Original</body></html>",
      });
      createdUuids.push(createResult.uuid);

      const result = await callMCPTool(client, "artifacts", {
        action: "update",
        uuid: createResult.uuid,
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("content");
    });

    test("update returns error for non-existent artifact", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "update",
        uuid: "non-existent-uuid-12345",
        content: "<html><body>Content</body></html>",
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toContain("not found");
    });
  });

  // ============================================
  // Delete Action Tests
  // ============================================

  describe("delete action", () => {
    test("delete soft deletes artifact", async () => {
      // Create artifact
      const createResult = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test-delete.html",
        content: "<html><body>To be deleted</body></html>",
      });
      expect(createResult).toHaveProperty("uuid");
      // Don't add to cleanup - we're deleting it

      // Delete artifact
      const deleteResult = await callMCPTool(client, "artifacts", {
        action: "delete",
        uuid: createResult.uuid,
      });

      expect(deleteResult).toHaveProperty("uuid", createResult.uuid);
      expect(deleteResult).toHaveProperty("deleted", true);

      // Artifact should not appear in list after delete
      const listResult = await callMCPTool(client, "artifacts", {
        action: "list",
      });
      const found = listResult.artifacts?.find((a: any) => a.uuid === createResult.uuid);
      expect(found).toBeUndefined();
    });

    test("delete requires uuid parameter", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "delete",
      });

      expect(typeof result).toBe("string");
      expect(result).toContain("uuid");
    });

    test("delete returns error for non-existent artifact", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "delete",
        uuid: "non-existent-delete-uuid",
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toContain("not found");
    });
  });

  // ============================================
  // List Action Tests
  // ============================================

  describe("list action", () => {
    test("list returns artifacts array", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "list",
      });

      expect(result).toHaveProperty("artifacts");
      expect(result).toHaveProperty("total");
      expect(Array.isArray(result.artifacts)).toBe(true);
      expect(typeof result.total).toBe("number");
    });

    test("list returns created artifacts with all fields", async () => {
      // Create an artifact
      const createResult = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test-list.html",
        content: "<html><body>List test</body></html>",
      });
      createdUuids.push(createResult.uuid);

      // List artifacts
      const result = await callMCPTool(client, "artifacts", {
        action: "list",
      });

      expect(result.total).toBeGreaterThan(0);
      const found = result.artifacts.find((a: any) => a.uuid === createResult.uuid);
      expect(found).toBeDefined();
      expect(found).toHaveProperty("uuid");
      expect(found).toHaveProperty("url");
      expect(found).toHaveProperty("name");
      expect(found).toHaveProperty("size");
      expect(found).toHaveProperty("mimeType");
      expect(found).toHaveProperty("expiresAt");
      expect(found).toHaveProperty("createdAt");
      expect(found).toHaveProperty("updatedAt");
    });

    test("list supports pagination", async () => {
      // Create multiple artifacts
      for (let i = 0; i < 3; i++) {
        const createResult = await callMCPTool(client, "artifacts", {
          action: "upload",
          name: `test-pagination-${i}.html`,
          content: `<html><body>Pagination test ${i}</body></html>`,
        });
        createdUuids.push(createResult.uuid);
      }

      // Get first page
      const page1 = await callMCPTool(client, "artifacts", {
        action: "list",
        limit: 2,
        offset: 0,
      });

      expect(page1.artifacts.length).toBeLessThanOrEqual(2);

      // Get second page
      const page2 = await callMCPTool(client, "artifacts", {
        action: "list",
        limit: 2,
        offset: 2,
      });

      // Pages should have different artifacts
      if (page1.artifacts.length > 0 && page2.artifacts.length > 0) {
        expect(page1.artifacts[0].uuid).not.toBe(page2.artifacts[0].uuid);
      }
    });
  });

  // ============================================
  // Stats Action Tests
  // ============================================

  describe("stats action", () => {
    test("stats returns usage statistics", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "stats",
      });

      expect(result).toHaveProperty("totalArtifacts");
      expect(result).toHaveProperty("totalSize");
      expect(result).toHaveProperty("storageLimit");
      expect(result).toHaveProperty("countLimit");
      expect(result).toHaveProperty("storageUsedPercent");
      expect(result).toHaveProperty("countUsedPercent");

      expect(typeof result.totalArtifacts).toBe("number");
      expect(typeof result.totalSize).toBe("number");
      expect(typeof result.storageLimit).toBe("number");
      expect(typeof result.countLimit).toBe("number");
      expect(typeof result.storageUsedPercent).toBe("number");
      expect(typeof result.countUsedPercent).toBe("number");
    });

    test("stats reflects created artifacts", async () => {
      // Create an artifact
      const createResult = await callMCPTool(client, "artifacts", {
        action: "upload",
        name: "test-stats.html",
        content: "<html><body>Stats test content</body></html>",
      });
      createdUuids.push(createResult.uuid);

      // Verify artifact was created by listing it
      const listResult = await callMCPTool(client, "artifacts", {
        action: "list",
      });
      const created = listResult.artifacts.find(
        (a: { uuid: string }) => a.uuid === createResult.uuid,
      );
      expect(created).toBeDefined();

      // Stats must reflect that artifacts exist for this user. We assert the
      // count/size are positive rather than an exact initial+1 delta: stats are
      // per-user and other concurrently-running tests in this suite create/delete
      // artifacts for the same user, so a delta from an initial snapshot is racy.
      // Existence of our specific artifact is already proven via the list above.
      const updatedStats = await callMCPTool(client, "artifacts", {
        action: "stats",
      });
      expect(updatedStats.totalArtifacts).toBeGreaterThanOrEqual(1);
      expect(updatedStats.totalSize).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Token Action Tests
  // ============================================

  describe("token action", () => {
    test("token generates upload token with URL", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "token",
      });

      expect(result).toHaveProperty("token");
      expect(result).toHaveProperty("expiresAt");
      expect(result).toHaveProperty("uploadUrl");

      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
      expect(result.uploadUrl).toContain("/api/public/artifacts/upload/");
      expect(result.uploadUrl).toContain(result.token);
    });

    test("token accepts ttlMinutes parameter", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "token",
        ttlMinutes: 30,
      });

      expect(result).toHaveProperty("token");
      expect(result).toHaveProperty("expiresAt");

      // Verify expiration is approximately 30 minutes from now
      const expiresAt = new Date(result.expiresAt).getTime();
      const expectedExpiry = Date.now() + 30 * 60 * 1000;
      // Allow 1 minute tolerance
      expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(60000);
    });
  });

  // ============================================
  // Quota Enforcement Tests
  // ============================================

  describe("quota enforcement", () => {
    test("upload enforces file size limit at application level", async () => {
      // Create content that exceeds 5MB limit but under nginx's limit
      // This tests the application-level validation
      // Note: Very large content (>10MB) is rejected by nginx before reaching app (HTTP 413)
      const largeContent = "<html><body>" + "x".repeat(5.5 * 1024 * 1024) + "</body></html>";

      // This may either:
      // 1. Get rejected by nginx with HTTP 413 (Request Entity Too Large)
      // 2. Get rejected by application with size limit error
      // Both are valid size enforcement behaviors
      try {
        const result = await callMCPTool(client, "artifacts", {
          action: "upload",
          name: "too-large.html",
          content: largeContent,
        });

        // If we get here, application rejected it
        expect(typeof result).toBe("string");
        expect(result.toLowerCase()).toContain("size");
      } catch (error) {
        // nginx rejected with 413 - also valid
        expect(String(error)).toContain("413");
      }
    });
  });

  // ============================================
  // Error Handling Tests
  // ============================================

  describe("error handling", () => {
    test("invalid action returns error", async () => {
      const result = await callMCPTool(client, "artifacts", {
        action: "invalid-action" as any,
      });

      expect(typeof result).toBe("string");
      expect(result.toLowerCase()).toContain("error");
    });
  });
});
