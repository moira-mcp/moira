/**
 * Unit tests for WorkflowRepository validation cache operations (Issue #463)
 * Tests the new validation cache columns and related methods
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WorkflowRepository } from "@mcp-moira/shared";
import path from "path";

// Import all schema tables for drizzle
import * as schema from "../../../packages/shared/src/database/schema.js";

// Test workflow graph helper
function createTestGraph(name: string, version = "1.0.0") {
  return {
    id: `test-${Date.now()}`,
    metadata: {
      name,
      version,
      description: "Test workflow",
    },
    nodes: [
      {
        id: "start",
        type: "start" as const,
        directive: "Test directive",
        connections: { default: "end" },
      },
      {
        id: "end",
        type: "end" as const,
        directive: "End",
        connections: {},
      },
    ],
  };
}

describe("WorkflowRepository Validation Cache", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: WorkflowRepository;
  let sqlite: Database.Database;

  const TEST_USER_ID = "test-user-validation-cache";

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    repository = new WorkflowRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("schema validation", () => {
    it("workflow table has isValid column", () => {
      const result = sqlite.prepare("PRAGMA table_info(workflow)").all() as Array<{
        name: string;
        type: string;
      }>;
      const isValidColumn = result.find((col) => col.name === "isValid");
      expect(isValidColumn).toBeDefined();
      expect(isValidColumn?.type.toLowerCase()).toBe("integer");
    });

    it("workflow table has validationErrors column", () => {
      const result = sqlite.prepare("PRAGMA table_info(workflow)").all() as Array<{
        name: string;
        type: string;
      }>;
      const validationErrorsColumn = result.find((col) => col.name === "validationErrors");
      expect(validationErrorsColumn).toBeDefined();
      expect(validationErrorsColumn?.type.toLowerCase()).toBe("text");
    });

    it("workflow table has validatedAt column", () => {
      const result = sqlite.prepare("PRAGMA table_info(workflow)").all() as Array<{
        name: string;
        type: string;
      }>;
      const validatedAtColumn = result.find((col) => col.name === "validatedAt");
      expect(validatedAtColumn).toBeDefined();
      expect(validatedAtColumn?.type.toLowerCase()).toBe("integer");
    });
  });

  describe("updateValidationCache", () => {
    it("sets validation cache for valid workflow", async () => {
      // Create workflow first
      const graph = createTestGraph("Valid Workflow");
      const { id } = await repository.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Update validation cache
      const success = await repository.updateValidationCache(id, true, []);
      expect(success).toBe(true);

      // Verify cache was set
      const cache = await repository.getValidationCache(id);
      expect(cache).not.toBeNull();
      expect(cache?.status).toBe("valid");
      expect(cache?.errors).toEqual([]);
      expect(cache?.validatedAt).toBeGreaterThan(0);
    });

    it("sets validation cache for invalid workflow with errors", async () => {
      const graph = createTestGraph("Invalid Workflow");
      const { id } = await repository.save({
        graph,
        userId: TEST_USER_ID,
      });

      const errors = ["Node 'missing' referenced but not found", "Circular dependency detected"];
      const success = await repository.updateValidationCache(id, false, errors);
      expect(success).toBe(true);

      const cache = await repository.getValidationCache(id);
      expect(cache?.status).toBe("invalid");
      expect(cache?.errors).toEqual(errors);
      expect(cache?.validatedAt).toBeGreaterThan(0);
    });

    it("returns false for non-existent workflow", async () => {
      const success = await repository.updateValidationCache("non-existent-workflow-id", true, []);
      expect(success).toBe(false);
    });

    it("updates existing validation cache", async () => {
      const graph = createTestGraph("Update Cache Test");
      const { id } = await repository.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Set initial cache (invalid)
      await repository.updateValidationCache(id, false, ["Error 1"]);

      // Update to valid
      const success = await repository.updateValidationCache(id, true, []);
      expect(success).toBe(true);

      const cache = await repository.getValidationCache(id);
      expect(cache?.status).toBe("valid");
      expect(cache?.errors).toEqual([]);
    });
  });

  describe("getValidationCache", () => {
    it("returns null for non-existent workflow", async () => {
      const cache = await repository.getValidationCache("non-existent-id");
      expect(cache).toBeNull();
    });

    it("returns unknown status for workflow without validation cache", async () => {
      const graph = createTestGraph("No Cache Workflow");
      const { id } = await repository.save({
        graph,
        userId: TEST_USER_ID,
      });

      const cache = await repository.getValidationCache(id);
      expect(cache).not.toBeNull();
      expect(cache?.status).toBe("unknown");
      expect(cache?.errors).toEqual([]);
      expect(cache?.validatedAt).toBeNull();
    });
  });

  describe("getUnvalidatedWorkflows", () => {
    it("returns workflows without validation cache", async () => {
      // Create workflows without validation cache
      const graph1 = createTestGraph("Unvalidated 1");
      const graph2 = createTestGraph("Unvalidated 2");

      const { id: id1 } = await repository.save({ graph: graph1, userId: TEST_USER_ID });
      const { id: id2 } = await repository.save({ graph: graph2, userId: TEST_USER_ID });

      const unvalidated = await repository.getUnvalidatedWorkflows();
      expect(unvalidated.length).toBeGreaterThanOrEqual(2);

      const ids = unvalidated.map((w) => w.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it("excludes workflows with validation cache", async () => {
      const graph = createTestGraph("Validated Workflow");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      // Set validation cache
      await repository.updateValidationCache(id, true, []);

      const unvalidated = await repository.getUnvalidatedWorkflows();
      const ids = unvalidated.map((w) => w.id);
      expect(ids).not.toContain(id);
    });

    it("excludes deleted workflows", async () => {
      const graph = createTestGraph("Deleted Workflow");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      // Soft delete the workflow
      await repository.softDelete(id, TEST_USER_ID);

      const unvalidated = await repository.getUnvalidatedWorkflows();
      const ids = unvalidated.map((w) => w.id);
      expect(ids).not.toContain(id);
    });

    it("respects limit parameter", async () => {
      // Create 5 workflows
      for (let i = 0; i < 5; i++) {
        const graph = createTestGraph(`Batch ${i}`);
        await repository.save({ graph, userId: TEST_USER_ID });
      }

      const unvalidated = await repository.getUnvalidatedWorkflows(3);
      expect(unvalidated.length).toBeLessThanOrEqual(3);
    });

    it("returns workflow graphs for validation", async () => {
      const graph = createTestGraph("Graph Check");
      await repository.save({ graph, userId: TEST_USER_ID });

      const unvalidated = await repository.getUnvalidatedWorkflows();
      const workflow = unvalidated.find((w) => w.graph.metadata.name === "Graph Check");

      expect(workflow).toBeDefined();
      expect(workflow?.graph.nodes).toHaveLength(2);
      expect(workflow?.graph.metadata.version).toBe("1.0.0");
    });
  });

  describe("list methods include validation cache", () => {
    it("list() returns workflows with validation cache", async () => {
      const graph = createTestGraph("List Test");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID, visibility: "public" });

      // Set validation to invalid
      await repository.updateValidationCache(id, false, ["Error in list test"]);

      const workflows = await repository.list(TEST_USER_ID);
      const found = workflows.find((w) => w.id === id);

      expect(found).toBeDefined();
      expect(found?.validation).toBeDefined();
      expect(found?.validation.status).toBe("invalid");
      expect(found?.validation.errors).toEqual(["Error in list test"]);
      expect(found?.validation.validatedAt).toBeGreaterThan(0);
    });

    it("listWithFilters() returns workflows with validation cache", async () => {
      const graph = createTestGraph("Filter Test");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, true, []);

      const result = await repository.listWithFilters({ userId: TEST_USER_ID });
      const found = result.workflows.find((w) => w.id === id);

      expect(found?.validation).toBeDefined();
      expect(found?.validation.status).toBe("valid");
      expect(found?.validation.errors).toEqual([]);
    });

    it("listWithFilters() returns unknown status for workflows without cache", async () => {
      const graph = createTestGraph("No Cache Test");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      const result = await repository.listWithFilters({ userId: TEST_USER_ID });
      const found = result.workflows.find((w) => w.id === id);

      expect(found?.validation).toBeDefined();
      expect(found?.validation.status).toBe("unknown");
      expect(found?.validation.validatedAt).toBeNull();
    });

    it("getFullInfo() returns validation cache", async () => {
      const graph = createTestGraph("Full Info Test");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, false, ["Full info error"]);

      const info = await repository.getFullInfo(id, TEST_USER_ID);

      expect(info?.validation).toBeDefined();
      expect(info?.validation.status).toBe("invalid");
      expect(info?.validation.errors).toEqual(["Full info error"]);
    });

    it("listDeleted() returns validation cache", async () => {
      const graph = createTestGraph("Deleted With Cache");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, true, []);
      await repository.softDelete(id, TEST_USER_ID);

      const deleted = await repository.listDeleted(TEST_USER_ID);
      const found = deleted.find((w) => w.id === id);

      expect(found?.validation).toBeDefined();
      expect(found?.validation.status).toBe("valid");
    });
  });

  describe("validation cache parsing", () => {
    it("parses valid status correctly", async () => {
      const graph = createTestGraph("Parse Valid");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, true, []);

      const cache = await repository.getValidationCache(id);
      expect(cache?.status).toBe("valid");
    });

    it("parses invalid status correctly", async () => {
      const graph = createTestGraph("Parse Invalid");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, false, ["Error"]);

      const cache = await repository.getValidationCache(id);
      expect(cache?.status).toBe("invalid");
    });

    it("parses empty errors array correctly", async () => {
      const graph = createTestGraph("Empty Errors");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      await repository.updateValidationCache(id, true, []);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors).toEqual([]);
    });

    it("parses multiple errors correctly", async () => {
      const graph = createTestGraph("Multiple Errors");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      const errors = ["Error 1", "Error 2", "Error 3"];
      await repository.updateValidationCache(id, false, errors);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors).toEqual(errors);
    });

    it("handles malformed JSON in validationErrors gracefully", async () => {
      const graph = createTestGraph("Malformed JSON");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      // Directly insert malformed JSON
      sqlite.exec(`UPDATE workflow SET validationErrors = 'not valid json' WHERE id = '${id}'`);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors).toEqual([]); // Graceful fallback to empty array
    });
  });

  describe("edge cases", () => {
    it("validation cache survives workflow update", async () => {
      const graph = createTestGraph("Update Test");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      // Set validation cache
      await repository.updateValidationCache(id, true, []);

      // Update the workflow
      graph.id = id;
      graph.metadata.version = "2.0.0";
      await repository.save({ graph, userId: TEST_USER_ID });

      // Validation cache should still exist (though may be stale)
      const cache = await repository.getValidationCache(id);
      expect(cache).not.toBeNull();
      expect(cache?.status).toBe("valid");
    });

    it("handles unicode in error messages", async () => {
      const graph = createTestGraph("Unicode Errors");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      const errors = ["节点 'start' 无效", "Ошибка валидации", "エラー: 無効なノード"];
      await repository.updateValidationCache(id, false, errors);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors).toEqual(errors);
    });

    it("handles very long error messages", async () => {
      const graph = createTestGraph("Long Errors");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      const longError = "E".repeat(10000);
      await repository.updateValidationCache(id, false, [longError]);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors[0]).toBe(longError);
    });

    it("handles many errors", async () => {
      const graph = createTestGraph("Many Errors");
      const { id } = await repository.save({ graph, userId: TEST_USER_ID });

      const errors = Array.from({ length: 100 }, (_, i) => `Error ${i + 1}`);
      await repository.updateValidationCache(id, false, errors);

      const cache = await repository.getValidationCache(id);
      expect(cache?.errors).toHaveLength(100);
    });
  });
});
