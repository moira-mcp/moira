/**
 * The overview of a person's runs: which runs a page shows, how they nest, and in what order.
 *
 * Everything that decides membership and order is SQL, so filters and pagination agree:
 *
 * - **Status** is one of four, each a predicate on the stored row: `completed` (the run ended),
 *   `locked` (running with an active execution lock), `waiting-user` (running, not locked, paused on
 *   a gate the engine marked or with the agent's open question), `waiting-agent` (every other running
 *   run). The status filter defines the candidate set.
 * - **Placement.** A root is a run in the candidate set with no ancestor in it: its parent is absent,
 *   deleted, or outside the set, and so is every ancestor above. Under a root the tree holds all its
 *   descendants of any status, so every run appears exactly once.
 * - **Filters by subtree.** Refusals-only, flow and search decide whether a run *matches*; a root is
 *   shown when some run of its tree is in the candidate set and matches. Runs of a shown tree that do
 *   not match are returned with `matches: false` (shown muted), not dropped.
 * - **Idleness** reads subtree activity: the latest `lastActivityAt` of the root and all descendants.
 * - **Order.** Trees holding a run that waits for its person come first; then the chosen sort.
 *
 * Only the owner's runs are read. The page's rows are projected elsewhere; this module returns ids,
 * placement and the per-tree facts that need the whole tree.
 */

import type Database from "better-sqlite3";

export type OverviewStatus = "waiting-user" | "waiting-agent" | "locked" | "completed" | "stopped";
export type OverviewStatusFilter = "active" | OverviewStatus | "all";
export type OverviewSort = "activity" | "idle" | "created";

export interface OverviewQuery {
  userId: string;
  status: OverviewStatusFilter;
  refusalsOnly?: boolean;
  workflowId?: string;
  /** Matched against the note, the run id and the flow's name. */
  search?: string;
  /** Show a tree only when its latest activity is at or before this moment (epoch ms). */
  idleSince?: number;
  /** Show a tree only when its latest activity is at or after this moment (epoch ms). */
  activeSince?: number;
  sort: OverviewSort;
  limit: number;
  offset: number;
}

export interface OverviewNode {
  executionId: string;
  parentExecutionId: string | null;
  rootId: string;
  depth: number;
  status: OverviewStatus;
  /** In the candidate set and passing the filters; a tree's other runs are shown muted. */
  matches: boolean;
  lastActivityAt: number | null;
}

/** A refreshed row's own facts and the facts of its subtree. */
export interface OverviewRowFacts {
  executionId: string;
  status: OverviewStatus;
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
  children: { total: number; unfinished: number };
}

export interface OverviewPage {
  /** Number of trees (roots) the filters show. */
  total: number;
  /** The page's roots, in order. */
  roots: string[];
  /** Every run of the page's trees, roots included. */
  nodes: OverviewNode[];
}

/** SQL for the status of the run aliased `r`. */
const STATUS_SQL = `CASE
  WHEN r.stopReason IS NOT NULL THEN 'stopped'
  WHEN r.state IN ('completed', 'failed') THEN 'completed'
  WHEN EXISTS (
    SELECT 1 FROM executionLock l WHERE l.executionId = r.executionId AND l.status = 'active'
  ) THEN 'locked'
  WHEN r.gateWaiting = 1 OR r.awaitingUser IS NOT NULL THEN 'waiting-user'
  ELSE 'waiting-agent'
END`;

/** Deep enough for any real nesting; bounds a malformed parent chain. */
const MAX_DEPTH = 32;

function statusPredicate(filter: OverviewStatusFilter): string {
  switch (filter) {
    case "all":
      return "1";
    case "active":
      return "m.status NOT IN ('completed', 'stopped')";
    default:
      return "m.status = @status";
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class ExecutionOverviewRepository {
  constructor(private readonly sqlite: Database.Database) {}

  page(query: OverviewQuery): OverviewPage {
    const filters: string[] = [];
    if (query.refusalsOnly) filters.push("m.refusalCount > 0");
    if (query.workflowId) filters.push("m.workflowId = @workflowId");
    if (query.search) {
      filters.push(
        "(m.note LIKE @search ESCAPE '\\' OR m.executionId LIKE @search ESCAPE '\\' OR w.name LIKE @search ESCAPE '\\')",
      );
    }
    const matchWhere = [statusPredicate(query.status), ...filters].join(" AND ");
    const idle: string[] = [];
    if (query.idleSince !== undefined) idle.push("COALESCE(s.subtreeActivity, 0) <= @idleSince");
    if (query.activeSince !== undefined) idle.push("s.subtreeActivity >= @activeSince");
    const order =
      query.sort === "idle"
        ? "COALESCE(s.subtreeActivity, 0) ASC, root.createdAt ASC"
        : query.sort === "created"
          ? "root.createdAt DESC"
          : "COALESCE(s.subtreeActivity, 0) DESC, root.createdAt DESC";

    const params = {
      userId: query.userId,
      status: query.status,
      workflowId: query.workflowId ?? null,
      search: query.search ? `%${escapeLike(query.search)}%` : null,
      idleSince: query.idleSince ?? null,
      activeSince: query.activeSince ?? null,
      maxDepth: MAX_DEPTH,
      limit: query.limit,
      offset: query.offset,
    };

    const shown = `
      WITH RECURSIVE
        mine AS (
          SELECT r.executionId, r.parentExecutionId, r.workflowId, r.note, r.refusalCount,
                 r.lastActivityAt, r.createdAt, ${STATUS_SQL} AS status
          FROM workflowExecution r
          WHERE r.userId = @userId ${query.status === "active" ? "AND r.stopReason IS NULL" : ""}
        ),
        candidate AS (
          SELECT m.executionId FROM mine m WHERE ${statusPredicate(query.status)}
        ),
        ancestry(id, ancestor, depth) AS (
          SELECT m.executionId, m.parentExecutionId, 1
            FROM mine m JOIN candidate c ON c.executionId = m.executionId
            WHERE m.parentExecutionId IS NOT NULL
          UNION
          SELECT a.id, p.parentExecutionId, a.depth + 1
            FROM ancestry a JOIN mine p ON p.executionId = a.ancestor
            WHERE p.parentExecutionId IS NOT NULL AND a.depth < @maxDepth
        ),
        roots AS (
          SELECT c.executionId FROM candidate c
          WHERE NOT EXISTS (
            SELECT 1 FROM ancestry a JOIN candidate up ON up.executionId = a.ancestor
            WHERE a.id = c.executionId
          )
        ),
        tree(rootId, executionId, depth) AS (
          SELECT executionId, executionId, 0 FROM roots
          UNION ALL
          SELECT t.rootId, child.executionId, t.depth + 1
            FROM tree t JOIN mine child ON child.parentExecutionId = t.executionId
            WHERE t.depth < @maxDepth AND child.executionId <> t.rootId
        ),
        matched AS (
          SELECT m.executionId FROM mine m LEFT JOIN workflow w ON w.id = m.workflowId
          WHERE ${matchWhere}
        ),
        s AS (
          SELECT t.rootId,
                 MAX(m.lastActivityAt) AS subtreeActivity,
                 MAX(CASE WHEN x.executionId IS NOT NULL THEN 1 ELSE 0 END) AS anyMatch,
                 MAX(CASE WHEN m.status = 'waiting-user' THEN 1 ELSE 0 END) AS anyWaitingUser
          FROM tree t
            JOIN mine m ON m.executionId = t.executionId
            LEFT JOIN matched x ON x.executionId = t.executionId
          GROUP BY t.rootId
        ),
        shown AS (
          SELECT s.rootId, s.subtreeActivity, s.anyWaitingUser, root.createdAt
          FROM s JOIN mine root ON root.executionId = s.rootId
          WHERE s.anyMatch = 1 ${idle.length ? `AND ${idle.join(" AND ")}` : ""}
        )`;

    const total = (
      this.sqlite.prepare(`${shown} SELECT COUNT(*) AS n FROM shown s`).get(params) as {
        n: number;
      }
    ).n;
    const roots = (
      this.sqlite
        .prepare(
          `${shown}
           SELECT s.rootId FROM shown s JOIN mine root ON root.executionId = s.rootId
           ORDER BY s.anyWaitingUser DESC, ${order}, root.executionId
           LIMIT @limit OFFSET @offset`,
        )
        .all(params) as Array<{ rootId: string }>
    ).map((row) => row.rootId);
    if (roots.length === 0) return { total, roots, nodes: [] };

    const nodes = this.sqlite
      .prepare(
        `WITH RECURSIVE
           mine AS (
             SELECT r.executionId, r.parentExecutionId, r.workflowId, r.note, r.refusalCount,
                    r.lastActivityAt, ${STATUS_SQL} AS status
             FROM workflowExecution r
             WHERE r.userId = @userId ${query.status === "active" ? "AND r.stopReason IS NULL" : ""}
           ),
           tree(rootId, executionId, depth) AS (
             SELECT value, value, 0 FROM json_each(@roots)
             UNION ALL
             SELECT t.rootId, child.executionId, t.depth + 1
               FROM tree t JOIN mine child ON child.parentExecutionId = t.executionId
               WHERE t.depth < @maxDepth AND child.executionId <> t.rootId
           )
         SELECT t.rootId, t.executionId, t.depth, m.parentExecutionId, m.status, m.lastActivityAt,
                CASE WHEN ${matchWhere} THEN 1 ELSE 0 END AS matches
         FROM tree t
           JOIN mine m ON m.executionId = t.executionId
           LEFT JOIN workflow w ON w.id = m.workflowId`,
      )
      .all({ ...params, roots: JSON.stringify(roots) }) as Array<{
      rootId: string;
      executionId: string;
      depth: number;
      parentExecutionId: string | null;
      status: OverviewStatus;
      lastActivityAt: number | null;
      matches: number;
    }>;

    return {
      total,
      roots,
      nodes: nodes.map((node) => ({
        executionId: node.executionId,
        parentExecutionId: node.parentExecutionId,
        rootId: node.rootId,
        depth: node.depth,
        status: node.status,
        matches: node.matches === 1,
        lastActivityAt: node.lastActivityAt,
      })),
    };
  }

  /**
   * The owner's runs with these ids, for refreshing single rows: each run's status and activity, the
   * latest activity of its whole subtree, and its direct children counted in total and unfinished —
   * in one query, whatever the number of ids. Runs of other users and unknown ids are left out.
   */
  statuses(userId: string, executionIds: string[]): OverviewRowFacts[] {
    if (executionIds.length === 0) return [];
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE
           mine AS (
             SELECT r.executionId, r.parentExecutionId, r.lastActivityAt, ${STATUS_SQL} AS status
             FROM workflowExecution r
             WHERE r.userId = @userId
           ),
           tree(rootId, executionId, depth) AS (
             SELECT m.executionId, m.executionId, 0
               FROM mine m WHERE m.executionId IN (SELECT value FROM json_each(@ids))
             UNION ALL
             SELECT t.rootId, child.executionId, t.depth + 1
               FROM tree t JOIN mine child ON child.parentExecutionId = t.executionId
               WHERE t.depth < @maxDepth AND child.executionId <> t.rootId
           )
         SELECT root.executionId, root.status, root.lastActivityAt,
                MAX(m.lastActivityAt) AS subtreeActivityAt,
                SUM(CASE WHEN t.depth = 1 THEN 1 ELSE 0 END) AS childrenTotal,
                SUM(CASE WHEN t.depth = 1 AND m.status NOT IN ('completed', 'stopped') THEN 1 ELSE 0 END)
                  AS childrenUnfinished
         FROM tree t
           JOIN mine m ON m.executionId = t.executionId
           JOIN mine root ON root.executionId = t.rootId
         GROUP BY t.rootId`,
      )
      .all({ userId, ids: JSON.stringify(executionIds), maxDepth: MAX_DEPTH }) as Array<{
      executionId: string;
      status: OverviewStatus;
      lastActivityAt: number | null;
      subtreeActivityAt: number | null;
      childrenTotal: number;
      childrenUnfinished: number;
    }>;
    return rows.map((row) => ({
      executionId: row.executionId,
      status: row.status,
      lastActivityAt: row.lastActivityAt,
      subtreeActivityAt: row.subtreeActivityAt,
      children: { total: row.childrenTotal, unfinished: row.childrenUnfinished },
    }));
  }
}
