/**
 * Execution Repository - Domain repository for workflow executions
 * Drizzle ORM queries for execution operations
 */

import { eq, and, or, like, inArray, isNotNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { workflowExecution } from "../schema.js";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import type * as schema from "../schema.js";
import { type ExecutionError, type LegacyExecutionStatus } from "../../types/execution-error.js";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

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

    if (existing.length > 0) {
      // Update (note can be updated via execution_note magic variable)
      await this.db
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
        })
        .where(eq(workflowExecution.executionId, execution.executionId));
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
      })
      .where(eq(workflowExecution.executionId, executionId));
  }

  /**
   * Update only the context (variables and node states) of an execution
   * Used for ExecutionInspector to modify running executions
   */
  async updateContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
  ): Promise<boolean> {
    // First get current execution to merge context
    const execution = await this.get(executionId);
    if (!execution) {
      return false;
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
      })
      .where(eq(workflowExecution.executionId, executionId));

    return result.changes > 0;
  }

  /**
   * Update a single value at an arbitrary nesting path inside the execution's
   * `variables`, reading the current context from the DB first so siblings and other
   * variables are preserved (stale-overwrite-safe at the path level).
   *
   * The path is relative to `variables` (e.g. ["review_findings", "blocking"]).
   * Returns the old value at the path (or undefined) on success, or the literal
   * string "__EXECUTION_NOT_FOUND__" if the execution does not exist.
   */
  async updateContextByPath(
    executionId: string,
    path: Array<string | number>,
    value: unknown,
  ): Promise<{ ok: boolean; oldValue?: unknown }> {
    // Reject prototype-pollution segments before walking the object. A path segment of
    // __proto__/constructor/prototype could otherwise write into Object.prototype.
    const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
    for (const seg of path) {
      if (typeof seg === "string" && FORBIDDEN_SEGMENTS.has(seg)) {
        return { ok: false };
      }
    }

    const execution = await this.get(executionId);
    if (!execution) {
      return { ok: false };
    }

    // Deep clone the current variables so we mutate a copy, then persist.
    const variables = JSON.parse(JSON.stringify(execution.globalContext.variables ?? {})) as Record<
      string,
      unknown
    >;

    // Walk to the parent of the target, creating containers as needed.
    let cursor: unknown = variables;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      if (cursor === null || typeof cursor !== "object") {
        return { ok: false };
      }
      const container = cursor as Record<string | number, unknown>;
      if (container[seg] === null || typeof container[seg] !== "object") {
        // Create an object/array container based on the next segment's type.
        container[seg] = typeof path[i + 1] === "number" ? [] : {};
      }
      cursor = container[seg];
    }
    if (cursor === null || typeof cursor !== "object") {
      return { ok: false };
    }
    const leafKey = path[path.length - 1];
    const parent = cursor as Record<string | number, unknown>;
    const oldValue = parent[leafKey];
    parent[leafKey] = value;

    const updatedContext = { ...execution.globalContext, variables };

    // Size validation: max 10MB for execution context
    const contextJson = JSON.stringify(updatedContext);
    const sizeBytes = Buffer.byteLength(contextJson, "utf8");
    const maxSize = 10 * 1024 * 1024;
    if (sizeBytes > maxSize) {
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      const maxMB = (maxSize / 1024 / 1024).toFixed(0);
      throw new Error(`Execution context size ${sizeMB}MB exceeds maximum ${maxMB}MB limit`);
    }

    const result = await this.db
      .update(workflowExecution)
      .set({ context: contextJson, updatedAt: new Date() })
      .where(eq(workflowExecution.executionId, executionId));

    return { ok: result.changes > 0, oldValue };
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
      })
      .where(eq(workflowExecution.executionId, executionId));

    return result.changes > 0;
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
