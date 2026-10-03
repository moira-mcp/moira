/**
 * Execution Repository - Domain repository for workflow executions
 * Drizzle ORM queries for execution operations
 */

import {
  eq,
  ne,
  and,
  or,
  like,
  inArray,
  isNotNull,
  isNull,
  sql,
  desc,
  type SQL,
} from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { workflowExecution } from "../schema.js";
import type { ExecutionAwaitingUser, WorkflowExecution } from "@mcp-moira/workflow-engine";
import type * as schema from "../schema.js";
import { type ExecutionError, type LegacyExecutionStatus } from "../../types/execution-error.js";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";
import { ConflictError, ValidationError } from "../../errors/index.js";
import { metadataRevision } from "../../utils/metadata-revision.js";
import { awaitingUserAfterWrite, executionRowFields } from "../execution-row.js";
import { executionActivity, parseStoredErrors, parseStoredVisits } from "../execution-activity.js";

import { enqueueWaitingNotification } from "../execution-notification.js";
import {
  recordExecutionChange,
  recordExecutionsDeleted,
  trackExecutionChange,
} from "../execution-change.js";

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

/** Variables and write histories required by a current progress projection. Null means all variables. */
export interface ExecutionProgressRead {
  executionId: string;
  visits?: boolean;
  variables: string[] | null;
  historyRoots: string[];
  arrayWindows?: Array<{
    name: string;
    start: number;
    size: number;
  }>;
}

/** Preserve JSON scalar types when SQLite exposes booleans as integer values. */
function storedJsonValue(type: SQL, value: SQL): SQL {
  return sql`CASE ${type}
    WHEN 'true' THEN json('true')
    WHEN 'false' THEN json('false')
    WHEN 'array' THEN json(${value})
    WHEN 'object' THEN json(${value})
    ELSE ${value} END`;
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

    const row = executionRowFields(execution);

    if (existing.length > 0) {
      // Update (note can be updated via execution_note magic variable)
      const expectedRevision = execution.revision;
      // One synchronous transaction: the write and the person's notification it may cause commit
      // together, so a write refused by the revision guard queues nothing.
      const changes = this.db.transaction(
        (tx) => {
          const result = trackExecutionChange(
            tx,
            execution.executionId,
            () =>
              tx
                .update(workflowExecution)
                .set({
                  state: row.state,
                  currentNodeId: row.currentNodeId,
                  waitingForInputNodeId: row.waitingForInputNodeId,
                  context: row.context,
                  error: row.error,
                  errors: row.errors,
                  note: row.note,
                  stopReason: row.stopReason,
                  updatedAt,
                  completedAt,
                  revision: expectedRevision + 1,
                  reminders: row.reminders,
                  visits: row.visits,
                  gateWaiting: row.gateWaiting === 1,
                  lastActivityAt: row.lastActivityAt,
                  refusalCount: row.refusalCount,
                  // The agent's question is not the saver's to write: it stays while the run stays on its
                  // node and is cleared when the run leaves it or finishes (see awaitingUserAfterMove).
                  awaitingUser: awaitingUserAfterWrite(row.state, row.currentNodeId),
                })
                .where(
                  and(
                    eq(workflowExecution.executionId, execution.executionId),
                    eq(workflowExecution.revision, expectedRevision),
                  ),
                )
                .run(),
            (written) => written.changes > 0,
          );
          if (result.changes > 0) enqueueWaitingNotification(tx, execution.executionId);
          return result.changes;
        },
        { behavior: "immediate" },
      );
      if (changes === 0) {
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
      this.db.transaction(
        (tx) => {
          tx.insert(workflowExecution)
            .values({
              executionId: execution.executionId,
              workflowId: execution.workflowId,
              userId: execution.userId,
              state: row.state,
              currentNodeId: row.currentNodeId,
              waitingForInputNodeId: row.waitingForInputNodeId,
              context: row.context,
              error: row.error,
              errors: row.errors,
              note: row.note,
              stopReason: row.stopReason,
              parentExecutionId: row.parentExecutionId,
              revision: execution.revision,
              reminders: row.reminders,
              visits: row.visits,
              gateWaiting: row.gateWaiting === 1,
              lastActivityAt: row.lastActivityAt,
              refusalCount: row.refusalCount,
              workflowVersion: execution.workflowVersion ?? null,
              createdAt,
              updatedAt,
              completedAt,
            })
            .run();
          recordExecutionChange(tx, {
            executionId: execution.executionId,
            userId: execution.userId,
            kind: "created",
          });
          enqueueWaitingNotification(tx, execution.executionId);
        },
        { behavior: "immediate" },
      );
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

  /** The runs with these ids, in one query; unknown ids are left out. */
  async getMany(executionIds: string[]): Promise<WorkflowExecution[]> {
    if (executionIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(workflowExecution)
      .where(inArray(workflowExecution.executionId, executionIds));
    return rows.map((row) => this.rowToExecution(row));
  }

  /** Definition identities for a bounded set, before selecting definition-dependent progress inputs. */
  async getManyWorkflowReferences(
    executionIds: string[],
  ): Promise<Array<{ executionId: string; workflowId: string }>> {
    if (!executionIds.length) return [];
    return this.db
      .select({
        executionId: workflowExecution.executionId,
        workflowId: workflowExecution.workflowId,
      })
      .from(workflowExecution)
      .where(inArray(workflowExecution.executionId, executionIds));
  }

  /**
   * Current progress inputs, without journals, reminders, node states or unrelated variables.
   * With no read specification this returns only scalar headers. Full engine/detail reads use
   * get/getMany; the narrowed values here are never saved back as an execution.
   */
  async getManyForProgress(
    executionIds: string[],
    reads?: ExecutionProgressRead[],
  ): Promise<WorkflowExecution[]> {
    if (!executionIds.length) return [];
    const historyGroups: string[][] = [];
    const historyGroupIds = new Map<string, number>();
    const readById = new Map(reads?.map((read) => [read.executionId, read]));
    const specifications = JSON.stringify(
      Object.fromEntries(
        (reads ?? []).map((read) => {
          const key = JSON.stringify(read.historyRoots);
          let historyGroup = historyGroupIds.get(key);
          if (historyGroup === undefined) {
            historyGroup = historyGroups.length;
            historyGroupIds.set(key, historyGroup);
            historyGroups.push(read.historyRoots);
          }
          return [read.executionId, { ...read, historyGroup }];
        }),
      ),
    );
    const spec = sql`requested.value`;
    const contextJson = sql`stored_context.value`;
    const historyArray = (names: string[]) =>
      sql`json_array(${sql.join(
        names.map((name) => {
          const path = `$.changes.${JSON.stringify(name)}`;
          return sql`json_array(CASE WHEN json_type(v.value, ${path}) IS NOT NULL THEN 1 ELSE 0 END, ${storedJsonValue(sql`json_type(v.value, ${path})`, sql`json_extract(v.value, ${path})`)})`;
        }),
        sql`, `,
      )})`;
    const historyValues =
      historyGroups.length <= 1
        ? historyArray(historyGroups[0] ?? [])
        : sql`CASE json_extract(${spec}, '$.historyGroup') ${sql.join(
            historyGroups.map((names, index) => sql`WHEN ${index} THEN ${historyArray(names)}`),
            sql` `,
          )} ELSE json('[]') END`;
    const variables = reads
      ? sql`COALESCE((SELECT json_group_object(key,
          ${storedJsonValue(sql`type`, sql`value`)})
        FROM jsonb_each(${contextJson}, '$.variables')
        WHERE (json_type(${spec}, '$.variables') = 'null'
          OR key IN (SELECT value FROM json_each(${spec}, '$.variables')))
          AND NOT (type = 'array' AND key IN (SELECT json_extract(value, '$.name') FROM json_each(${spec}, '$.arrayWindows')))), '{}')`
      : sql`'{}'`;
    const compactVisits = reads
      ? sql`COALESCE((SELECT json_group_array(json_array(
          json(json_extract(v.value, '$.seq', '$.nodeId', '$.exitKey', '$.enteredAt', '$.leftAt')),
          (CASE WHEN json_extract(v.value, '$.waited') THEN 1 ELSE 0 END)
            + (CASE WHEN json_extract(v.value, '$.adjusted') THEN 2 ELSE 0 END),
          ${historyValues}))
        FROM jsonb_each(jsonb(CASE WHEN json_valid(${workflowExecution.visits})
          AND json_type(${workflowExecution.visits}) = 'array'
          THEN ${workflowExecution.visits} ELSE '[]' END)) v), '[]')`
      : sql`'[]'`;
    const arrayWindows = reads
      ? sql<string>`(
      WITH arrays AS MATERIALIZED (
        SELECT json_extract(w.value, '$.name') AS name,
          jsonb_extract(${contextJson}, '$.variables.' || json_quote(json_extract(w.value, '$.name'))) AS items,
          json_extract(w.value, '$.start') AS start,
          json_extract(w.value, '$.size') AS size
        FROM json_each(${spec}, '$.arrayWindows') w
      )
      SELECT json_group_array(json_object('name', name, 'length', json_array_length(items), 'start', start,
        'items', json((SELECT json_group_array(${storedJsonValue(sql`type`, sql`value`)})
          FROM json_each(items) WHERE key >= start AND key < start + size)))) FROM arrays
          WHERE json_type(CASE WHEN typeof(items) = 'blob' THEN items ELSE NULL END) = 'array'
    )`
      : sql<string>`'[]'`;
    const rows = await this.db
      .select({
        executionId: workflowExecution.executionId,
        workflowId: workflowExecution.workflowId,
        userId: workflowExecution.userId,
        state: workflowExecution.state,
        currentNodeId: workflowExecution.currentNodeId,
        waitingForInputNodeId: workflowExecution.waitingForInputNodeId,
        note: workflowExecution.note,
        stopReason: workflowExecution.stopReason,
        parentExecutionId: workflowExecution.parentExecutionId,
        revision: workflowExecution.revision,
        gateWaiting: workflowExecution.gateWaiting,
        lastActivityAt: workflowExecution.lastActivityAt,
        refusalCount: workflowExecution.refusalCount,
        awaitingUser: workflowExecution.awaitingUser,
        workflowVersion: workflowExecution.workflowVersion,
        createdAt: workflowExecution.createdAt,
        updatedAt: workflowExecution.updatedAt,
        completedAt: workflowExecution.completedAt,
        context: sql<string>`json_object('variables', json(${variables}), 'nodeStates', json('{}'),
        'executionId', ${workflowExecution.executionId}, 'workflowId', ${workflowExecution.workflowId},
        'userId', ${workflowExecution.userId})`,
        visits:
          sql`CASE WHEN json_extract(${spec}, '$.visits') = 0 THEN '[]' ELSE ${compactVisits} END`.mapWith(
            String,
          ),
        arrayWindows,
        error: sql<null>`NULL`,
        errors: sql<null>`NULL`,
        reminders: sql<string>`'[]'`,
      })
      .from(workflowExecution)
      .leftJoin(
        sql`json_each(${specifications}) AS requested`,
        sql`requested.key = ${workflowExecution.executionId}`,
      )
      .leftJoin(
        sql`jsonb_each(jsonb_array(jsonb(${reads ? sql`CASE WHEN json_valid(${workflowExecution.context}) THEN ${workflowExecution.context} ELSE '{}' END` : sql`'{}'`}))) AS stored_context`,
        sql`1`,
      )
      .where(inArray(workflowExecution.executionId, executionIds));
    return rows.map((row) => {
      const execution = this.rowToExecution({ ...row, visits: "[]" });
      for (const window of JSON.parse(row.arrayWindows) as Array<{
        name: string;
        length: number;
        start: number;
        items: unknown[];
      }>) {
        const items = new Array<unknown>(window.length);
        window.items.forEach((item, index) => {
          items[window.start + index] = item;
        });
        Object.defineProperty(execution.globalContext.variables, window.name, {
          value: items,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      const tuples = JSON.parse(row.visits) as Array<
        [
          [number, string, string | null, number | null, number | null],
          number,
          Array<[number, unknown]>,
        ]
      >;
      const historyRoots = readById.get(row.executionId)?.historyRoots ?? [];
      execution.visits = tuples.map(
        ([[seq, nodeId, exitKey, enteredAt, leftAt], flags, values]) => ({
          seq,
          nodeId,
          exitKey,
          changes: Object.fromEntries(
            values.flatMap(([present, value], index) =>
              present ? [[historyRoots[index], value]] : [],
            ),
          ),
          ...(enteredAt !== null ? { enteredAt } : {}),
          ...(leftAt !== null ? { leftAt } : {}),
          ...(flags & 1 ? { waited: true } : {}),
          ...(flags & 2 ? { adjusted: true } : {}),
        }),
      );
      return execution;
    });
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

    let visits: WorkflowExecution["visits"] = [];
    try {
      visits = JSON.parse(row.visits) as WorkflowExecution["visits"];
      if (!Array.isArray(visits)) visits = [];
    } catch {
      visits = [];
    }

    let awaitingUser: ExecutionAwaitingUser | null = null;
    if (row.awaitingUser) {
      try {
        awaitingUser = JSON.parse(row.awaitingUser) as ExecutionAwaitingUser;
      } catch {
        awaitingUser = null;
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
      stopReason: row.stopReason ?? null,
      parentExecutionId: row.parentExecutionId ?? undefined,
      revision: row.revision,
      reminders,
      visits,
      gateWaiting: row.gateWaiting,
      lastActivityAt: row.lastActivityAt ?? null,
      refusalCount: row.refusalCount,
      awaitingUser,
      workflowVersion: row.workflowVersion ?? null,
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

  /** One user's completed runs of a workflow that started on the given definition version. */
  async listByWorkflowVersion(
    workflowId: string,
    workflowVersion: string,
    userId: string,
  ): Promise<WorkflowExecution[]> {
    const rows = await this.db
      .select()
      .from(workflowExecution)
      .where(
        and(
          eq(workflowExecution.workflowId, workflowId),
          eq(workflowExecution.userId, userId),
          eq(workflowExecution.state, "completed"),
          isNull(workflowExecution.stopReason),
          eq(workflowExecution.workflowVersion, workflowVersion),
        ),
      )
      .orderBy(workflowExecution.createdAt);
    return rows.map((row) => this.rowToExecution(row));
  }

  /**
   * Cache signature of that sample: how many completed runs, when the latest completed, and how
   * many of the user's completed runs of the workflow carry no version stamp.
   */
  async summarizeByWorkflowVersion(
    workflowId: string,
    workflowVersion: string,
    userId: string,
  ): Promise<{ count: number; lastCompletedAt: number | null; unstamped: number }> {
    const owned = and(
      eq(workflowExecution.workflowId, workflowId),
      eq(workflowExecution.userId, userId),
      eq(workflowExecution.state, "completed"),
      isNull(workflowExecution.stopReason),
    );
    const [stamped] = await this.db
      .select({
        count: sql<number>`count(*)`,
        last: sql<number | null>`max(coalesce(completedAt, updatedAt))`,
      })
      .from(workflowExecution)
      .where(and(owned, eq(workflowExecution.workflowVersion, workflowVersion)));
    const [unstamped] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workflowExecution)
      .where(and(owned, isNull(workflowExecution.workflowVersion)));
    return {
      count: Number(stamped?.count ?? 0),
      lastCompletedAt:
        stamped?.last === null || stamped?.last === undefined ? null : Number(stamped.last),
      unstamped: Number(unstamped?.count ?? 0),
    };
  }

  /**
   * The workflows one user runs most: how many runs each has and when the latest started, most
   * runs first and then the most recent. Counted in SQL, so no execution is loaded.
   */
  async countRunsByWorkflow(
    userId: string,
    limit: number,
  ): Promise<Array<{ workflowId: string; runs: number; lastRunAt: number }>> {
    const runs = sql<number>`count(*)`;
    const lastRunAt = sql<number>`max(${workflowExecution.createdAt})`;
    const rows = await this.db
      .select({ workflowId: workflowExecution.workflowId, runs, lastRunAt })
      .from(workflowExecution)
      .where(eq(workflowExecution.userId, userId))
      .groupBy(workflowExecution.workflowId)
      .orderBy(desc(runs), desc(lastRunAt))
      .limit(limit);
    return rows.map((row) => ({
      workflowId: row.workflowId,
      runs: Number(row.runs),
      lastRunAt: Number(row.lastRunAt),
    }));
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
    this.db.transaction(
      (tx) => {
        recordExecutionsDeleted(tx, { executionIds: [executionId] });
        tx.delete(workflowExecution).where(eq(workflowExecution.executionId, executionId)).run();
      },
      { behavior: "immediate" },
    );
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

    this.db.transaction(
      (tx) => {
        recordExecutionsDeleted(tx, { executionIds: toDelete });
        tx.delete(workflowExecution).where(inArray(workflowExecution.executionId, toDelete)).run();
      },
      { behavior: "immediate" },
    );
    return toDelete.length;
  }

  /**
   * Update execution note
   * Used by session(action: "update-note") and magic variable execution_note
   */
  async updateNote(executionId: string, note: string): Promise<void> {
    this.db.transaction(
      (tx) =>
        trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({ note, updatedAt: new Date() })
              .where(eq(workflowExecution.executionId, executionId))
              .run(),
          (written) => written.changes > 0,
        ),
      { behavior: "immediate" },
    );
  }

  /**
   * Raise, replace or clear the agent's open question on a running run. Raising binds the question
   * to the node the run stands on, in the same statement, so a run that moved meanwhile is refused
   * instead of getting a question about a step it has left. The step-generation `revision` is not
   * touched: the agent's presented Step attempt stays valid.
   */
  async setAwaitingUser(
    executionId: string,
    userId: string,
    question: Omit<ExecutionAwaitingUser, "nodeId"> | null,
  ): Promise<WorkflowExecution> {
    const execution = await this.get(executionId);
    if (!execution || execution.userId !== userId) {
      throw new ValidationError("Execution must belong to the authenticated user");
    }
    if (execution.status === "completed" || execution.status === "failed") {
      throw new ValidationError("Execution is already finished");
    }
    if (question && !execution.currentNodeId) {
      throw new ValidationError("Execution is not standing on a step");
    }
    const awaitingUser = question
      ? JSON.stringify({ ...question, nodeId: execution.currentNodeId })
      : null;
    // The raise and the person's notification commit together.
    const changes = this.db.transaction(
      (tx) => {
        const result = trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({ awaitingUser, updatedAt: new Date() })
              .where(
                and(
                  eq(workflowExecution.executionId, executionId),
                  eq(workflowExecution.userId, userId),
                  ne(workflowExecution.state, "completed"),
                  execution.currentNodeId === null
                    ? isNull(workflowExecution.currentNodeId)
                    : eq(workflowExecution.currentNodeId, execution.currentNodeId),
                ),
              )
              .run(),
          (written) => written.changes > 0,
        );
        if (result.changes > 0 && question) enqueueWaitingNotification(tx, executionId);
        return result.changes;
      },
      { behavior: "immediate" },
    );
    if (changes === 0) {
      throw new ConflictError("Execution moved while the question was being recorded; retry", {
        executionId,
      });
    }
    return (await this.get(executionId))!;
  }

  async setParent(
    executionId: string,
    parentExecutionId: string | null,
    userId: string,
    expectedRevision: number,
    expectedParentRevision: string,
  ): Promise<WorkflowExecution> {
    const child = await this.get(executionId);
    if (!child) throw new ValidationError("Execution must exist");
    if (child.userId !== userId)
      throw new ValidationError("Execution must belong to the authenticated user");
    if (child.status !== "running") throw new ValidationError("Execution must be running");
    if ((child.parentExecutionId ?? null) === parentExecutionId) return child;
    if (metadataRevision(child.parentExecutionId ?? null) !== expectedParentRevision) {
      throw new ConflictError("Execution parent changed; reload before changing parent", {
        executionId,
        expectedParentRevision,
      });
    }
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
    const result = this.db.transaction(
      (tx) =>
        trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({ parentExecutionId, updatedAt: new Date() })
              .where(
                and(
                  eq(workflowExecution.executionId, executionId),
                  eq(workflowExecution.revision, expectedRevision),
                  eq(workflowExecution.state, "running"),
                  child.parentExecutionId
                    ? eq(workflowExecution.parentExecutionId, child.parentExecutionId)
                    : isNull(workflowExecution.parentExecutionId),
                  parentGuard,
                ),
              )
              .run(),
          (written) => written.changes > 0,
        ),
      { behavior: "immediate" },
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

  async updateReminders(
    executionId: string,
    userId: string,
    expectedRevision: number,
    expectedReminders: WorkflowExecution["reminders"],
    reminders: WorkflowExecution["reminders"],
  ): Promise<boolean> {
    const result = this.db.transaction(
      (tx) =>
        trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({ reminders: JSON.stringify(reminders ?? []), updatedAt: new Date() })
              .where(
                and(
                  eq(workflowExecution.executionId, executionId),
                  eq(workflowExecution.userId, userId),
                  eq(workflowExecution.state, "running"),
                  eq(workflowExecution.revision, expectedRevision),
                  eq(workflowExecution.reminders, JSON.stringify(expectedReminders ?? [])),
                ),
              )
              .run(),
          (written) => written.changes > 0,
        ),
      { behavior: "immediate" },
    );
    return result.changes === 1;
  }

  /**
   * Update only the context (variables and node states) of an execution
   * Used for ExecutionInspector to modify running executions
   */
  async updateContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
    expectedRevision: number,
    expectedContextRevision: string,
    visit?: Omit<NonNullable<WorkflowExecution["visits"]>[number], "seq">,
  ): Promise<boolean> {
    // Read, check and write in one IMMEDIATE transaction: the context, the adjustment visit and the
    // activity derived from the visits are stored together from the row as it is.
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(workflowExecution)
          .where(eq(workflowExecution.executionId, executionId))
          .get();
        if (!row) return false;
        const execution = this.rowToExecution(row);
        if (execution.revision !== expectedRevision) {
          throw new ConflictError("Execution state changed; reload before updating context", {
            executionId,
            expectedRevision,
            currentRevision: execution.revision,
          });
        }
        if (metadataRevision(execution.globalContext) !== expectedContextRevision) {
          throw new ConflictError("Execution context changed; reload before updating context", {
            executionId,
            expectedContextRevision,
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

        // The route log gains the adjustment in the same write as the context it changed.
        const nextVisits = visit
          ? [...(execution.visits ?? []), { seq: (execution.visits ?? []).length, ...visit }]
          : undefined;
        const result = trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({
                context: contextJson,
                ...(nextVisits !== undefined
                  ? {
                      visits: JSON.stringify(nextVisits),
                      lastActivityAt: executionActivity({
                        visits: nextVisits,
                        completedAt: execution.completedAt ?? null,
                      }).lastActivityAt,
                    }
                  : {}),
                // A variable the agent sets is the agent acting: its open question is answered. A
                // person's edit is not an answer and leaves the question open.
                ...(visit?.actor?.role === "agent" ? { awaitingUser: null } : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(workflowExecution.executionId, executionId),
                  eq(workflowExecution.revision, expectedRevision),
                ),
              )
              .run(),
          (written) => written.changes > 0,
        );
        if (result.changes === 0) {
          throw new ConflictError("Execution state changed; reload before updating context", {
            executionId,
            expectedRevision,
          });
        }
        return true;
      },
      { behavior: "immediate" },
    );
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
    // Read, append and write in one IMMEDIATE transaction, so the journal and the refusal count
    // derived from it are stored together and no concurrent append is lost.
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select({ errors: workflowExecution.errors })
          .from(workflowExecution)
          .where(eq(workflowExecution.executionId, executionId))
          .get();
        if (!row) return false;
        let errors: ExecutionError[] = parseStoredErrors(row.errors);
        errors.push(error);
        if (Buffer.byteLength(JSON.stringify(errors), "utf8") > 1024 * 1024) {
          errors = errors.slice(-100);
        }
        trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({
                errors: JSON.stringify(errors),
                refusalCount: executionActivity({ errors }).refusalCount,
                updatedAt: new Date(),
              })
              .where(eq(workflowExecution.executionId, executionId))
              .run(),
          (written) => written.changes > 0,
        );
        return true;
      },
      { behavior: "immediate" },
    );
  }

  async cancelExecution(
    executionId: string,
    error: ExecutionError,
  ): Promise<{ changed: boolean; execution: WorkflowExecution | null }> {
    const now = new Date();
    const changed = this.db.transaction(
      (tx) => {
        const row = tx
          .select({ errors: workflowExecution.errors, visits: workflowExecution.visits })
          .from(workflowExecution)
          .where(
            and(
              eq(workflowExecution.executionId, executionId),
              ne(workflowExecution.state, "completed"),
            ),
          )
          .get();
        if (!row) return false;
        const errors = [...parseStoredErrors(row.errors), error];
        const activity = executionActivity({
          visits: parseStoredVisits(row.visits),
          completedAt: now.getTime(),
          errors,
        });
        const result = trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({
                state: "completed",
                gateWaiting: false,
                awaitingUser: null,
                errors: JSON.stringify(errors),
                lastActivityAt: activity.lastActivityAt,
                refusalCount: activity.refusalCount,
                updatedAt: now,
                completedAt: now,
              })
              .where(
                and(
                  eq(workflowExecution.executionId, executionId),
                  ne(workflowExecution.state, "completed"),
                ),
              )
              .run(),
          (written) => written.changes > 0,
        );
        return result.changes > 0;
      },
      { behavior: "immediate" },
    );

    return {
      changed,
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
    const result = this.db.transaction(
      (tx) =>
        trackExecutionChange(
          tx,
          executionId,
          () =>
            tx
              .update(workflowExecution)
              .set({ errors: null, refusalCount: 0, updatedAt: new Date() })
              .where(eq(workflowExecution.executionId, executionId))
              .run(),
          (written) => written.changes > 0,
        ),
      { behavior: "immediate" },
    );

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
