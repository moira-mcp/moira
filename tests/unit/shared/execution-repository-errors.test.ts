/**
 * Unit tests for ExecutionRepository error handling methods
 * Tests appendError, getErrors, clearErrors, and errors serialization
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ExecutionRepository } from "@mcp-moira/shared";
import type { ExecutionError, LegacyExecutionStatus } from "@mcp-moira/shared";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import { randomUUID } from "crypto";
import path from "path";

// Import all schema tables for drizzle
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("ExecutionRepository Error Methods", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: ExecutionRepository;
  let sqlite: Database.Database;

  const TEST_USER_ID = "test-user-123";
  const TEST_WORKFLOW_ID = "test-workflow";

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    repository = new ExecutionRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createTestExecution(): WorkflowExecution {
    return {
      executionId: randomUUID(),
      workflowId: TEST_WORKFLOW_ID,
      userId: TEST_USER_ID,
      currentNodeId: "start",
      globalContext: {
        variables: {},
        nodeStates: {},
        executionId: "",
        workflowId: TEST_WORKFLOW_ID,
        userId: TEST_USER_ID,
      },
      status: "running" as LegacyExecutionStatus,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function createTestError(nodeId: string = "node1"): ExecutionError {
    return {
      timestamp: Date.now(),
      nodeId,
      errorType: "validation",
      message: `Error in ${nodeId}`,
      input: { test: true },
    };
  }

  describe("save and get with errors", () => {
    it("saves execution without errors", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const loaded = await repository.get(execution.executionId);
      expect(loaded).not.toBeNull();
      expect(loaded?.errors).toBeUndefined();
    });

    it("saves and retrieves execution with errors array", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("node1"), createTestError("node2")];
      await repository.save(execution);

      const loaded = await repository.get(execution.executionId);
      expect(loaded).not.toBeNull();
      expect(loaded?.errors).toHaveLength(2);
      expect(loaded?.errors?.[0].nodeId).toBe("node1");
      expect(loaded?.errors?.[1].nodeId).toBe("node2");
    });

    it("updates errors array on save", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("node1")];
      await repository.save(execution);

      // Update with more errors
      execution.errors.push(createTestError("node2"));
      await repository.save(execution);

      const loaded = await repository.get(execution.executionId);
      expect(loaded?.errors).toHaveLength(2);
    });
  });

  describe("appendError", () => {
    it("appends error to empty errors array", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const error = createTestError("task-node");
      const result = await repository.appendError(execution.executionId, error);

      expect(result).toBe(true);

      const loaded = await repository.get(execution.executionId);
      expect(loaded?.errors).toHaveLength(1);
      expect(loaded?.errors?.[0].nodeId).toBe("task-node");
      expect(loaded?.errors?.[0].errorType).toBe("validation");
    });

    it("appends multiple errors sequentially", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      await repository.appendError(execution.executionId, createTestError("node1"));
      await repository.appendError(execution.executionId, createTestError("node2"));
      await repository.appendError(execution.executionId, createTestError("node3"));

      const loaded = await repository.get(execution.executionId);
      expect(loaded?.errors).toHaveLength(3);
      expect(loaded?.errors?.map((e) => e.nodeId)).toEqual(["node1", "node2", "node3"]);
    });

    it("returns false for non-existent execution", async () => {
      const error = createTestError();
      const result = await repository.appendError("non-existent-id", error);
      expect(result).toBe(false);
    });

    it("preserves existing errors when appending", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("existing")];
      await repository.save(execution);

      await repository.appendError(execution.executionId, createTestError("new"));

      const loaded = await repository.get(execution.executionId);
      expect(loaded?.errors).toHaveLength(2);
      expect(loaded?.errors?.[0].nodeId).toBe("existing");
      expect(loaded?.errors?.[1].nodeId).toBe("new");
    });
  });

  describe("getErrors", () => {
    it("returns null for non-existent execution", async () => {
      const errors = await repository.getErrors("non-existent-id");
      expect(errors).toBeNull();
    });

    it("returns empty array for execution without errors", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const errors = await repository.getErrors(execution.executionId);
      expect(errors).toEqual([]);
    });

    it("returns errors array for execution with errors", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("node1"), createTestError("node2")];
      await repository.save(execution);

      const errors = await repository.getErrors(execution.executionId);
      expect(errors).toHaveLength(2);
    });
  });

  describe("clearErrors", () => {
    it("clears all errors from execution", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("node1"), createTestError("node2")];
      await repository.save(execution);

      const result = await repository.clearErrors(execution.executionId);
      expect(result).toBe(true);

      const loaded = await repository.get(execution.executionId);
      expect(loaded?.errors).toBeUndefined();
    });

    it("returns false for non-existent execution", async () => {
      const result = await repository.clearErrors("non-existent-id");
      expect(result).toBe(false);
    });
  });

  describe("listWithFilters with errors", () => {
    it("returns executions with errors in results", async () => {
      const execution = createTestExecution();
      execution.errors = [createTestError("node1")];
      await repository.save(execution);

      const result = await repository.listWithFilters({ userId: TEST_USER_ID });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0].errors).toHaveLength(1);
    });
  });

  describe("error types", () => {
    it("handles validation error type", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const error: ExecutionError = {
        timestamp: Date.now(),
        nodeId: "validate-node",
        errorType: "validation",
        message: "Invalid input format",
        input: { field: "value" },
      };

      await repository.appendError(execution.executionId, error);
      const errors = await repository.getErrors(execution.executionId);
      expect(errors?.[0].errorType).toBe("validation");
    });

    it("handles handler error type", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const error: ExecutionError = {
        timestamp: Date.now(),
        nodeId: "handler-node",
        errorType: "handler",
        message: "Handler threw exception",
      };

      await repository.appendError(execution.executionId, error);
      const errors = await repository.getErrors(execution.executionId);
      expect(errors?.[0].errorType).toBe("handler");
    });

    it("handles system error type", async () => {
      const execution = createTestExecution();
      await repository.save(execution);

      const error: ExecutionError = {
        timestamp: Date.now(),
        nodeId: "system-node",
        errorType: "system",
        message: "Network timeout",
      };

      await repository.appendError(execution.executionId, error);
      const errors = await repository.getErrors(execution.executionId);
      expect(errors?.[0].errorType).toBe("system");
    });
  });

  describe("status mapping and filtering", () => {
    it("filter 'running' finds executions with status 'waiting'", async () => {
      const execution = createTestExecution();
      execution.status = "waiting"; // legacy status in DB
      await repository.save(execution);

      // Query with 'running' should also find 'waiting' (legacy equivalent)
      const result = await repository.listWithFilters({
        userId: TEST_USER_ID,
        status: ["running"],
      });
      expect(result.executions).toHaveLength(1);
    });

    it("filter 'waiting' finds executions with status 'running'", async () => {
      const execution = createTestExecution();
      execution.status = "running";
      await repository.save(execution);

      // Query with legacy 'waiting' should find 'running'
      const result = await repository.listWithFilters({
        userId: TEST_USER_ID,
        status: ["waiting"],
      });
      expect(result.executions).toHaveLength(1);
    });

    it("filter 'completed' finds executions with status 'failed'", async () => {
      const execution = createTestExecution();
      execution.status = "failed"; // legacy status in DB
      await repository.save(execution);

      // Query with 'completed' should also find 'failed' (legacy equivalent)
      const result = await repository.listWithFilters({
        userId: TEST_USER_ID,
        status: ["completed"],
      });
      expect(result.executions).toHaveLength(1);
    });

    it("filter 'failed' finds executions with status 'completed'", async () => {
      const execution = createTestExecution();
      execution.status = "completed";
      await repository.save(execution);

      // Query with legacy 'failed' should find 'completed'
      const result = await repository.listWithFilters({
        userId: TEST_USER_ID,
        status: ["failed"],
      });
      expect(result.executions).toHaveLength(1);
    });

    it("filter ['running', 'waiting'] finds both statuses", async () => {
      const exec1 = createTestExecution();
      exec1.status = "running";
      await repository.save(exec1);

      const exec2 = createTestExecution();
      exec2.status = "waiting";
      await repository.save(exec2);

      const result = await repository.listWithFilters({
        userId: TEST_USER_ID,
        status: ["running", "waiting"],
      });
      expect(result.executions).toHaveLength(2);
    });
  });
});
