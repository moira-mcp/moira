/**
 * Integration tests for WorkflowMutationService (Issue #463)
 * Tests centralized workflow mutations with validation caching
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WorkflowRepository, AuditRepository } from "@mcp-moira/shared";
import { WorkflowMutationService } from "@mcp-moira/shared";
import path from "path";

// Import all schema tables for drizzle
import * as schema from "../../packages/shared/src/database/schema.js";

// Test workflow graph helpers
function createValidGraph(name: string, version = "1.0.0") {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
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

function createInvalidGraph(name: string, version = "1.0.0") {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    metadata: {
      name,
      version,
      description: "Invalid workflow",
    },
    nodes: [
      // Missing start node - invalid!
      {
        id: "end",
        type: "end" as const,
        directive: "End",
        connections: {},
      },
    ],
  };
}

function createBrokenConnectionGraph(name: string) {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
    metadata: {
      name,
      version: "1.0.0",
      description: "Workflow with broken connection",
    },
    nodes: [
      {
        id: "start",
        type: "start" as const,
        directive: "Test directive",
        connections: { default: "nonexistent-node" }, // Points to non-existent node
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

describe("WorkflowMutationService", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let workflowRepo: WorkflowRepository;
  let auditRepo: AuditRepository;
  let mutationService: WorkflowMutationService;

  const TEST_USER_ID = "test-user-mutation-service";

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    // Create repositories and service
    workflowRepo = new WorkflowRepository(db);
    auditRepo = new AuditRepository(db);
    mutationService = new WorkflowMutationService(workflowRepo, auditRepo);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("save()", () => {
    it("saves valid workflow and caches validation as valid", async () => {
      const graph = createValidGraph("Valid Save Test");

      const result = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Check save result
      expect(result.id).toBeDefined();
      expect(result.slug).toBeDefined();
      expect(result.isNew).toBe(true);
      expect(result.validation.status).toBe("valid");
      expect(result.validation.errors).toEqual([]);
      expect(result.validation.validatedAt).toBeGreaterThan(0);

      // Verify validation cache in database
      const cache = await workflowRepo.getValidationCache(result.id);
      expect(cache?.status).toBe("valid");
      expect(cache?.errors).toEqual([]);
    });

    it("saves invalid workflow and caches validation as invalid", async () => {
      const graph = createInvalidGraph("Invalid Save Test");

      const result = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Workflow should still be saved
      expect(result.id).toBeDefined();
      expect(result.slug).toBeDefined();
      expect(result.isNew).toBe(true);

      // But validation should show invalid
      expect(result.validation.status).toBe("invalid");
      expect(result.validation.errors.length).toBeGreaterThan(0);
      // Schema requires at least 2 nodes (start + end), so missing start is caught by schema
      // Error could be about minimum nodes or missing start - both indicate invalid workflow

      // Verify cache in database
      const cache = await workflowRepo.getValidationCache(result.id);
      expect(cache?.status).toBe("invalid");
      expect(cache?.errors.length).toBeGreaterThan(0);
    });

    it("saves workflow with broken connections and reports validation errors", async () => {
      const graph = createBrokenConnectionGraph("Broken Connections Test");

      const result = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      expect(result.validation.status).toBe("invalid");
      expect(result.validation.errors.some((e) => e.includes("nonexistent"))).toBe(true);
    });

    it("updates existing workflow and updates validation cache", async () => {
      // First create a valid workflow
      const graph = createValidGraph("Update Test");
      const createResult = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      expect(createResult.isNew).toBe(true);
      expect(createResult.validation.status).toBe("valid");

      // Now update it to be invalid (remove start node)
      const updatedGraph = {
        ...graph,
        id: createResult.id,
        metadata: { ...graph.metadata, version: "1.1.0" },
        nodes: [
          {
            id: "end",
            type: "end" as const,
            directive: "End only",
            connections: {},
          },
        ],
      };

      const updateResult = await mutationService.save({
        graph: updatedGraph,
        userId: TEST_USER_ID,
      });

      // Should be update, not create
      expect(updateResult.isNew).toBe(false);
      expect(updateResult.id).toBe(createResult.id);

      // Validation should now be invalid
      expect(updateResult.validation.status).toBe("invalid");
      expect(updateResult.validation.errors.length).toBeGreaterThan(0);

      // Database should reflect updated cache
      const cache = await workflowRepo.getValidationCache(updateResult.id);
      expect(cache?.status).toBe("invalid");
    });

    it("creates audit log entry on save", async () => {
      const graph = createValidGraph("Audit Test");

      await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Check audit log
      const auditEntries = await auditRepo.list({ userId: TEST_USER_ID });
      const createEntry = auditEntries.find(
        (e) => e.action === "workflow:create" && e.resource === "workflow",
      );

      expect(createEntry).toBeDefined();
      expect(createEntry?.metadata).toContain("Audit Test");
    });

    it("skips audit log when skipAudit is true", async () => {
      const graph = createValidGraph("Skip Audit Test");

      const countBefore = (await auditRepo.list({ userId: TEST_USER_ID })).length;

      await mutationService.save({
        graph,
        userId: TEST_USER_ID,
        skipAudit: true,
      });

      const countAfter = (await auditRepo.list({ userId: TEST_USER_ID })).length;
      expect(countAfter).toBe(countBefore);
    });
  });

  describe("validate()", () => {
    it("validates valid graph without saving", async () => {
      const graph = createValidGraph("Validate Only Test");

      const result = await mutationService.validate(graph);

      expect(result.status).toBe("valid");
      expect(result.errors).toEqual([]);

      // Workflow should NOT be in database
      const saved = await workflowRepo.get(graph.id, TEST_USER_ID);
      expect(saved).toBeNull();
    });

    it("validates invalid graph without saving", async () => {
      const graph = createInvalidGraph("Validate Invalid Test");

      const result = await mutationService.validate(graph);

      expect(result.status).toBe("invalid");
      expect(result.errors.length).toBeGreaterThan(0);

      // Workflow should NOT be in database
      const saved = await workflowRepo.get(graph.id, TEST_USER_ID);
      expect(saved).toBeNull();
    });
  });

  describe("migrateUnvalidatedWorkflows()", () => {
    it("validates workflows with null isValid", async () => {
      // Create workflows directly via repository (bypassing mutation service)
      // so they have isValid=null
      const graph1 = createValidGraph("Migration Valid");
      const graph2 = createInvalidGraph("Migration Invalid");

      // Save returns new ID (UUID generated by repository)
      const { id: id1 } = await workflowRepo.save({ graph: graph1, userId: TEST_USER_ID });
      const { id: id2 } = await workflowRepo.save({ graph: graph2, userId: TEST_USER_ID });

      // Verify they have null validation (unknown status)
      const cache1Before = await workflowRepo.getValidationCache(id1);
      expect(cache1Before?.status).toBe("unknown");

      // Run migration
      const result = await mutationService.migrateUnvalidatedWorkflows(100);

      expect(result.processed).toBe(2);
      expect(result.valid).toBe(1);
      expect(result.invalid).toBe(1);
      expect(result.hasMore).toBe(false);

      // Verify caches are now set
      const cache1After = await workflowRepo.getValidationCache(id1);
      expect(cache1After?.status).toBe("valid");

      const cache2After = await workflowRepo.getValidationCache(id2);
      expect(cache2After?.status).toBe("invalid");
    });

    it("respects batch size limit", async () => {
      // Create 5 workflows via repository (they'll have null isValid)
      for (let i = 0; i < 5; i++) {
        const graph = createValidGraph(`Batch Test ${i}`);
        await workflowRepo.save({ graph, userId: TEST_USER_ID });
      }

      // Migrate with batch size 2
      const result1 = await mutationService.migrateUnvalidatedWorkflows(2);
      expect(result1.processed).toBe(2);
      expect(result1.hasMore).toBe(true);

      // Continue migration
      const result2 = await mutationService.migrateUnvalidatedWorkflows(2);
      expect(result2.processed).toBe(2);
      expect(result2.hasMore).toBe(true);

      // Final batch
      const result3 = await mutationService.migrateUnvalidatedWorkflows(2);
      expect(result3.processed).toBe(1);
      expect(result3.hasMore).toBe(false);
    });

    it("is idempotent - does not reprocess validated workflows", async () => {
      // Create workflow
      const graph = createValidGraph("Idempotent Test");
      await workflowRepo.save({ graph, userId: TEST_USER_ID });

      // First migration
      const result1 = await mutationService.migrateUnvalidatedWorkflows(100);
      expect(result1.processed).toBe(1);

      // Second migration should process 0
      const result2 = await mutationService.migrateUnvalidatedWorkflows(100);
      expect(result2.processed).toBe(0);
      expect(result2.hasMore).toBe(false);
    });

    it("handles validation errors gracefully", async () => {
      // Directly insert a workflow with invalid JSON structure that will cause validation to fail
      // This simulates a corrupted workflow in the database
      const workflowId = `corrupted-${Date.now()}`;
      const now = Date.now();

      // Use raw SQL to insert workflow with semantically broken graph
      // (missing required node fields, unknown node type)
      sqlite.exec(`
        INSERT INTO workflow (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
        VALUES (
          '${workflowId}',
          '${TEST_USER_ID}',
          'corrupted-slug-${now}',
          'Corrupted Workflow',
          '1.0.0',
          '{"id":"${workflowId}","metadata":{"name":"Corrupted","version":"1.0.0","description":"test"},"nodes":[{"id":"bad","type":"unknown-type","directive":"test","connections":{}}]}',
          'private',
          ${now},
          ${now}
        )
      `);

      // Migration should handle this gracefully
      const result = await mutationService.migrateUnvalidatedWorkflows(100);

      expect(result.processed).toBe(1);
      expect(result.invalid).toBe(1);

      // Check that validation cache was set to invalid
      const cache = await workflowRepo.getValidationCache(workflowId);
      expect(cache?.status).toBe("invalid");
    });
  });

  describe("revalidate()", () => {
    it("revalidates existing workflow and updates cache", async () => {
      // Create workflow with mutation service (gets validated)
      const graph = createValidGraph("Revalidate Test");
      const { id } = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Manually corrupt the cache to simulate stale data
      await workflowRepo.updateValidationCache(id, false, ["Fake error"]);

      // Verify cache is corrupted
      const cacheBefore = await workflowRepo.getValidationCache(id);
      expect(cacheBefore?.status).toBe("invalid");

      // Revalidate
      const result = await mutationService.revalidate(id, TEST_USER_ID);

      // Should now show valid
      expect(result?.status).toBe("valid");
      expect(result?.errors).toEqual([]);

      // Database should be updated
      const cacheAfter = await workflowRepo.getValidationCache(id);
      expect(cacheAfter?.status).toBe("valid");
    });

    it("returns null for non-existent workflow", async () => {
      const result = await mutationService.revalidate("nonexistent-id", TEST_USER_ID);
      expect(result).toBeNull();
    });
  });

  describe("initialize()", () => {
    it("runs migration on initialize", async () => {
      // Create workflow via repository (bypassing mutation service)
      const graph = createValidGraph("Initialize Test");
      const { id } = await workflowRepo.save({ graph, userId: TEST_USER_ID });

      // Create fresh service instance
      const freshService = new WorkflowMutationService(workflowRepo, auditRepo);

      // Initialize should run migration
      await freshService.initialize();

      // Workflow should now be validated
      const cache = await workflowRepo.getValidationCache(id);
      expect(cache?.status).toBe("valid");
    });

    it("is idempotent - can be called multiple times", async () => {
      const graph = createValidGraph("Idempotent Init Test");
      const { id } = await workflowRepo.save({ graph, userId: TEST_USER_ID });

      const freshService = new WorkflowMutationService(workflowRepo, auditRepo);

      // Call initialize twice
      await freshService.initialize();
      await freshService.initialize();

      // Should work without errors
      const cache = await workflowRepo.getValidationCache(id);
      expect(cache?.status).toBe("valid");
    });
  });

  describe("edge cases", () => {
    it("handles workflows with many validation errors", async () => {
      // Create workflow with multiple issues
      const graph = {
        id: `multi-error-${Date.now()}`,
        metadata: {
          name: "Multi Error Test",
          version: "1.0.0",
          description: "Test",
        },
        nodes: [
          // No start node
          // End node with broken connection
          {
            id: "end",
            type: "end" as const,
            directive: "End",
            connections: { default: "nowhere" },
          },
        ],
      };

      const result = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      // Should be invalid with at least one error
      expect(result.validation.status).toBe("invalid");
      expect(result.validation.errors.length).toBeGreaterThanOrEqual(1);
      // Workflow has only 1 node (missing start), schema requires at least 2
      // Error could be about minimum nodes count or structural issues
    });

    it("preserves validation cache on workflow update without graph changes", async () => {
      const graph = createValidGraph("Preserve Cache Test");
      const { id } = await mutationService.save({
        graph,
        userId: TEST_USER_ID,
      });

      const cacheBefore = await workflowRepo.getValidationCache(id);

      // Update with same graph
      await mutationService.save({
        graph: { ...graph, id },
        userId: TEST_USER_ID,
      });

      const cacheAfter = await workflowRepo.getValidationCache(id);

      // Status should still be valid (cache is updated, but status same)
      expect(cacheAfter?.status).toBe("valid");
    });
  });
});
