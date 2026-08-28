/**
 * Execution Repository - Domain repository for workflow executions
 * Drizzle ORM queries for execution operations
 */

import { eq, ne, and, or, like, inArray, isNotNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { workflowExecution } from "../schema.js";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import type * as schema from "../schema.js";
import { type ExecutionError, type LegacyExecutionStatus } from "../../types/execution-error.js";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";
import { ConflictError, ValidationError } from "../../errors/index.js";

const EXECUTION_LIST_CONFIG: ListQueryConfig<"createdAt" | "updatedAt"> = {
  table: workflowExecution,
  sortableColumns: {
    createdAt: workflowExecution.createdAt,
    updatedAt: workflowExecution.updatedAt,
  },
  defaultSort: { field: "createdAt", order: "desc" },
  defaultLimit: 20,
  maxLimit: 100,
};

/**
 * Filter options for listing executions with pagination
 */
export interface ExecutionFilter {
  userId?: string;
  status?: ("running" | "waiting" | "completed" | "failed")[];
  workflowId?: string;
  search?: string; // Search in note field
  sort?: "createdAt" | "updatedAt";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Result of paginated execution list
 */
export interface ExecutionListResult {
  executions: WorkflowExecution[];
  total: number;
}

export class ExecutionRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  async save(execution: WorkflowExecution): Promise<void> {
    // Convert timestamps to Date objects for Drizzle
    const createdAt = execution.createdAt ? new Date(execution.createdAt) : null;
    const updatedAt = execution.updatedAt ? new Date(execution.updatedAt) : null;
    const completedAt = execution.completedAt ? new Date(execution.completedAt) : null;

    const existing = await this.db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, execution.executionId))
      .limit(1);

    // Serialize errors array to JSON (null if empty/undefined)
    const errorsJson =
      execution.errors && execution.errors.length > 0 ? JSON.stringify(execution.errors) : null;
    const remindersJson = JSON.stringify(execution.reminders ?? []);

    if (existing.length > 0) {
      // Update (note can be updated via execution_note magic variable)
      const expectedRevision = execution.revision;
      const result = await this.db
        .update(workflowExecution)
        .set({
          state: execution.status,
          currentNodeId: execution.currentNodeId,
          waitingForInputNodeId: execution.waitingForInputNodeId || null,
          context: JSON.stringify(execution.globalContext),
          error: execution.error || null,
          errors: errorsJson,
          note: execution.note || null,
          updatedAt,
          completedAt,
          revision: expectedRevision + 1,
          reminders: remindersJson,
        })
        .where(
          and(
            eq(workflowExecution.executionId, execution.executionId),
            eq(workflowExecution.revision, expectedRevision),
          ),
        );
      if (result.changes === 0) {
        const current = await this.get(execution.executionId);
        throw new ConflictError("Execution state changed; reload before writing", {
          executionId: execution.executionId,
          expectedRevision,
          currentRevision: current?.revision,
        });
      }
      execution.revision = expectedRevision + 1;
    } else {
      // Insert
      await this.db.insert(workflowExecution).values({
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        userId: execution.userId,
        state: execution.status,
        currentNodeId: execution.currentNodeId,
        waitingForInputNodeId: execution.waitingForInputNodeId || null,
        context: JSON.stringify(execution.globalContext),
        error: execution.error || null,
        errors: errorsJson,
        note: execution.note || null,
        parentExecutionId: execution.parentExecutionId || null,
        revision: execution.revision,
        reminders: remindersJson,
        createdAt,
        updatedAt,
        completedAt,
      });
    }
  }

  async get(executionId: string): Promise<WorkflowExecution | null> {
    const [row] = await this.db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, executionId))
      .limit(1);

    if (!row) {
      return null;
    }

    return this.rowToExecution(row);
  }

  /**
   * Convert database row to WorkflowExecution object
   * Centralizes the mapping logic for reuse
   */
  private rowToExecution(row: typeof workflowExecution.$inferSelect): WorkflowExecution {
    // Parse errors array from JSON (null/empty string → undefined)
    let errors: ExecutionError[] | undefined;
    if (row.errors) {
      try {
        errors = JSON.parse(row.errors) as ExecutionError[];
      } catch {
        errors = undefined;
      }
    }
    let reminders: WorkflowExecution["reminders"] = [];
    try {
      reminders = JSON.parse(row.reminders) as WorkflowExecution["reminders"];
      if (!Array.isArray(reminders)) reminders = [];
    } catch {
      reminders = [];
    }

    // Parse context JSON defensively: a single malformed row must not crash listing
    // of all executions (e.g. analytics that map over every execution).
    let globalContext: WorkflowExecution["globalContext"];
    try {
      globalContext = JSON.parse(row.context);
    } catch {
      globalContext = {
        variables: {},
        nodeStates: {},
        executionId: row.executionId,
        workflowId: row.workflowId,
        userId: row.userId,
      };
    }

    // Drizzle returns Date objects for timestamp_ms - convert to number (ms)
    return {
      executionId: row.executionId,
      workflowId: row.workflowId,
      userId: row.userId,
      currentNodeId: row.currentNodeId,
      waitingForInputNodeId: row.waitingForInputNodeId ?? undefined,
      globalContext,
      status: row.state as LegacyExecutionStatus,
      note: row.note ?? undefined,
      parentExecutionId: row.parentExecutionId ?? undefined,
      revision: row.revision,
      reminders,
      createdAt: row.createdAt ? (row.createdAt as Date).getTime() : Date.now(),
      updatedAt: row.updatedAt ? (row.updatedAt as Date).getTime() : Date.now(),
      completedAt: row.completedAt ? (row.completedAt as Date).getTime() : undefined,
      error: row.error ?? undefined,
      errors,
    };
  }

  async list(): Promise<WorkflowExecution[]> {
    const rows = await this.db
      .select()
      .from(workflowExecution)
      .orderBy(workflowExecution.createdAt);

    return rows.map((row) => this.rowToExecution(row));
  }

  async listByUser(userId: string): Promise<WorkflowExecution[]> {
    const rows = await this.db
      .select()
      .from(workflowExecution)
      .where(eq(workflowExecution.userId, userId))
      .orderBy(workflowExecution.createdAt);

    return rows.map((row) => this.rowToExecution(row));
  }

  /**
   * List executions with filters, sorting, and pagination
   * Returns both the filtered results and total count for pagination
   *
   * Status filter mapping (backward compatibility):
   * - Legacy 'waiting' → maps to 'running' (both mean active execution)
   * - Legacy 'failed' → maps to 'completed' (failed = completed with errors)
   * This allows old clients to use legacy status values in queries.
   */
  async listWithFilters(filter: ExecutionFilter): Promise<ExecutionListResult> {
    const { userId, status, workflowId, search } = filter;

    // Build WHERE conditions
    const conditions = [];

    if (userId) {
      conditions.push(eq(workflowExecution.userId, userId));
    }

    // Map status filter to include legacy equivalents
    if (status && status.length > 0) {
      const expandedStatuses = new Set<string>();
      for (const s of status) {
        expandedStatuses.add(s);
        if (s === "running") expandedStatuses.add("waiting");
        if (s === "waiting") expandedStatuses.add("running");
        if (s === "completed") expandedStatuses.add("failed");
        if (s === "failed") expandedStatuses.add("completed");
      }
      conditions.push(inArray(workflowExecution.state, Array.from(expandedStatuses)));
    }

    if (workflowId) {
      conditions.push(eq(workflowExecution.workflowId, workflowId));
    }

    if (search) {
      conditions.push(
        or(
          like(workflowExecution.executionId, `%${search}%`),
          like(workflowExecution.workflowId, `%${search}%`),
          like(workflowExecution.note, `%${search}%`),
        ),
      );
    }

    const { rows, total } = await executeListQuery(
      this.db,
      EXECUTION_LIST_CONFIG,
      filter,
      conditions,
    );

    const executions = rows.map((row) => this.rowToExecution(row));
    return { executions, total };
  }

  async delete(executionId: string): Promise<void> {
    await this.db.delete(workflowExecution).where(eq(workflowExecution.executionId, executionId));
  }

  /**
   * Delete completed executions older than the cutoff (retention cleanup).
   *
   * Only `completed` executions are eligible — running executions are never
   * deleted. A completed parent is preserved while it still has any running
   * child (so child-continuation links are not broken). Age is measured by
   * `completedAt` when present, else `updatedAt`.
   *
   * @param cutoff delete executions whose completion time is strictly before this Date
   * @returns number of executions deleted
   */
  async deleteCompletedOlderThan(cutoff: Date): Promise<number> {
    // Parents that still have a running child must be kept.
    const activeParents = await this.db
      .select({ parentExecutionId: workflowExecution.parentExecutionId })
      .from(workflowExecution)
      .where(
        and(eq(workflowExecution.state, "running"), isNotNull(workflowExecution.parentExecutionId)),
      );
    const protectedParentIds = activeParents
      .map((r) => r.parentExecutionId)
      .filter((id): id is string => !!id);

    // Eligible: completed AND aged out (by completedAt, falling back to updatedAt).
    const eligible = await this.db
      .select({
        executionId: workflowExecution.executionId,
        completedAt: workflowExecution.completedAt,
        updatedAt: workflowExecution.updatedAt,
      })
      .from(workflowExecution)
      .where(eq(workflowExecution.state, "completed"));

    const toDelete = eligible
      .filter((row) => {
        const ts = (row.completedAt as Date | null) ?? (row.updatedAt as Date | null);
        return ts != null && ts.getTime() < cutoff.getTime();
      })
      .map((row) => row.executionId)
      .filter((id) => !protectedParentIds.includes(id));

    if (toDelete.length === 0) return 0;

    await this.db.delete(workflowExecution).where(inArray(workflowExecution.executionId, toDelete));
    return toDelete.length;
  }

  /**
   * Update execution note
   * Used by session(action: "update-note") and magic variable execution_note
   */
  async updateNote(executionId: string, note: string): Promise<void> {
    await this.db
      .update(workflowExecution)
      .set({
        note,
        updatedAt: new Date(),
        revision: sql`${workflowExecution.revision} + 1`,
      })
      .where(eq(workflowExecution.executionId, executionId));
  }

  async setParent(
    executionId: string,
    parentExecutionId: string | null,
    userId: string,
    expectedRevision: number,
  ): Promise<WorkflowExecution> {
    const child = await this.get(executionId);
    if (!child) throw new ValidationError("Execution must exist");
    if (child.userId !== userId)
      throw new ValidationError("Execution must belong to the authenticated user");
    if (child.status !== "running") throw new ValidationError("Execution must be running");
    if ((child.parentExecutionId ?? null) === parentExecutionId) return child;
    if (child.revision !== expectedRevision) {
      throw new ConflictError("Execution state changed; reload before changing parent", {
        executionId,
        expectedRevision,
        currentRevision: child.revision,
      });
    }
    if (parentExecutionId) {
      const parent = await this.get(parentExecutionId);
      if (!parent) throw new ValidationError("Parent execution must exist");
      if (parent.userId !== userId)
        throw new ValidationError("Parent execution must belong to the authenticated user");
      if (parent.status !== "running")
        throw new ValidationError("Parent execution must be running");
      if (child.executionId === parent.executionId)
        throw new ValidationError("An execution cannot be its own parent");
      const visited = new Set<string>();
      let cursor: WorkflowExecution | null = parent;
      while (cursor) {
        if (cursor.executionId === child.executionId)
          throw new ValidationError("Parent change would create an execution cycle");
        if (visited.has(cursor.executionId))
          throw new ValidationError("Existing execution ancestry contains a cycle");
        visited.add(cursor.executionId);
        cursor = cursor.parentExecutionId ? await this.get(cursor.parentExecutionId) : null;
      }
    }
    const parentGuard = parentExecutionId
      ? sql`EXISTS (
          SELECT 1 FROM workflowExecution AS requested_parent
          WHERE requested_parent.executionId = ${parentExecutionId}
            AND requested_parent.userId = ${userId}
            AND requested_parent.state = 'running'
        ) AND NOT EXISTS (
          WITH RECURSIVE ancestors(executionId, parentExecutionId) AS (
            SELECT executionId, parentExecutionId
            FROM workflowExecution
            WHERE executionId = ${parentExecutionId}
            UNION
            SELECT candidate.executionId, candidate.parentExecutionId
            FROM workflowExecution AS candidate
            JOIN ancestors ON candidate.executionId = ancestors.parentExecutionId
          )
          SELECT 1 FROM ancestors WHERE executionId = ${executionId}
        )`
      : sql`1 = 1`;
    const result = await this.db
      .update(workflowExecution)
      .set({ parentExecutionId, revision: expectedRevision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(workflowExecution.executionId, executionId),
          eq(workflowExecution.revision, expectedRevision),
          eq(workflowExecution.state, "running"),
          parentGuard,
        ),
      );
    if (result.changes === 0) {
      const current = await this.get(executionId);
      throw new ConflictError("Execution state changed; reload before changing parent", {
        executionId,
        expectedRevision,
        currentRevision: current?.revision,
      });
    }
    const updated = await this.get(executionId);
    if (!updated) throw new ValidationError("Execution disappeared after parent change");
    return updated;
  }

  /**
   * Update only the context (variables and node states) of an execution
   * Used for ExecutionInspector to modify running executions
   */
  async updateContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
    expectedRevision: number,
  ): Promise<boolean> {
    // First get current execution to merge context
    const execution = await this.get(executionId);
    if (!execution) {
      return false;
    }
    if (execution.revision !== expectedRevision) {
      throw new ConflictError("Execution state changed; reload before updating context", {
        executionId,
        expectedRevision,
        currentRevision: execution.revision,
      });
    }

    // Merge new context with existing
    const updatedContext = {
      ...execution.globalContext,
      ...(context.variables && {
        variables: { ...execution.globalContext.variables, ...context.variables },
      }),
      ...(context.nodeStates && {
        nodeStates: { ...execution.globalContext.nodeStates, ...context.nodeStates },
      }),
    };

    // Size validation: max 10MB for execution context
    const contextJson = JSON.stringify(updatedContext);
    const sizeBytes = Buffer.byteLength(contextJson, "utf8");
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (sizeBytes > maxSize) {
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      const maxMB = (maxSize / 1024 / 1024).toFixed(0);
      throw new Error(`Execution context size ${sizeMB}MB exceeds maximum ${maxMB}MB limit`);
    }

    const result = await this.db
      .update(workflowExecution)
      .set({
        context: JSON.stringify(updatedContext),
        updatedAt: new Date(),
        revision: expectedRevision + 1,
      })
      .where(
        and(
          eq(workflowExecution.executionId, executionId),
          eq(workflowExecution.revision, expectedRevision),
        ),
      );

    if (result.changes === 0) {
      throw new ConflictError("Execution state changed; reload before updating context", {
        executionId,
        expectedRevision,
      });
    }

    return result.changes > 0;
  }

  /**
   * Append an error to execution's errors array atomically
   *
   * This is the primary method for logging errors during workflow execution.
   * Uses read-modify-write pattern with proper JSON handling.
   *
   * @param executionId - The execution to append error to
   * @param error - ExecutionError object to append
   * @returns true if error was appended, false if execution not found
   */
  async appendError(executionId: string, error: ExecutionError): Promise<boolean> {
    // Get current errors array
    const [row] = await this.db
      .select({ errors: workflowExecution.errors })
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, executionId))
      .limit(1);

    if (!row) {
      return false;
    }

    // Parse existing errors or start with empty array
    let errors: ExecutionError[] = [];
    if (row.errors) {
      try {
        errors = JSON.parse(row.errors) as ExecutionError[];
      } catch {
        errors = [];
      }
    }

    // Append new error
    errors.push(error);

    // Size validation: max 1MB for errors array to prevent unbounded growth
    const errorsJson = JSON.stringify(errors);
    const sizeBytes = Buffer.byteLength(errorsJson, "utf8");
    const maxSize = 1 * 1024 * 1024; // 1MB

    if (sizeBytes > maxSize) {
      // If too large, keep only last 100 errors
      errors = errors.slice(-100);
    }

    // Update database
    const result = await this.db
      .update(workflowExecution)
      .set({
        errors: JSON.stringify(errors),
        updatedAt: new Date(),
        revision: sql`${workflowExecution.revision} + 1`,
      })
      .where(eq(workflowExecution.executionId, executionId));

    return result.changes > 0;
  }

  async cancelExecution(
    executionId: string,
    error: ExecutionError,
  ): Promise<{ changed: boolean; execution: WorkflowExecution | null }> {
    const now = new Date();
    const errorJson = JSON.stringify(error);
    const result = await this.db
      .update(workflowExecution)
      .set({
        state: "completed",
        errors: sql<string>`CASE
          WHEN ${workflowExecution.errors} IS NULL OR json_valid(${workflowExecution.errors}) = 0
            THEN json_array(json(${errorJson}))
          ELSE json_insert(${workflowExecution.errors}, '$[#]', json(${errorJson}))
        END`,
        updatedAt: now,
        completedAt: now,
        revision: sql`${workflowExecution.revision} + 1`,
      })
      .where(
        and(
          eq(workflowExecution.executionId, executionId),
          ne(workflowExecution.state, "completed"),
        ),
      );

    return {
      changed: result.changes > 0,
      execution: await this.get(executionId),
    };
  }

  /**
   * Get errors array for an execution
   *
   * @param executionId - The execution to get errors for
   * @returns Array of errors, empty if none, null if execution not found
   */
  async getErrors(executionId: string): Promise<ExecutionError[] | null> {
    const [row] = await this.db
      .select({ errors: workflowExecution.errors })
      .from(workflowExecution)
      .where(eq(workflowExecution.executionId, executionId))
      .limit(1);

    if (!row) {
      return null;
    }

    if (!row.errors) {
      return [];
    }

    try {
      return JSON.parse(row.errors) as ExecutionError[];
    } catch {
      return [];
    }
  }

  /**
   * Clear all errors for an execution
   *
   * @param executionId - The execution to clear errors for
   * @returns true if cleared, false if execution not found
   */
  async clearErrors(executionId: string): Promise<boolean> {
    const result = await this.db
      .update(workflowExecution)
      .set({
        errors: null,
        updatedAt: new Date(),
      })
      .where(eq(workflowExecution.executionId, executionId));

    return result.changes > 0;
  }

  /**
   * Find active (running/waiting) child executions for a parent execution
   * Returns executionIds of children that are still running
   */
  async findActiveChildExecutions(parentExecutionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ executionId: workflowExecution.executionId })
      .from(workflowExecution)
      .where(
        and(
          eq(workflowExecution.parentExecutionId, parentExecutionId),
          inArray(workflowExecution.state, ["running", "waiting"]),
        ),
      );

    return rows.map((row) => row.executionId);
  }
}
