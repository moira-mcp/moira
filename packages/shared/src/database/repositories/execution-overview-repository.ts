/**
 * Current work is selected before pagination. Only eligible owned runs and their required owned
 * ancestors remain; unrelated descendants never become visible merely because a parent matched.
 */
import type Database from "better-sqlite3";
import { registerExecutionManagementFunctions } from "../connection.js";
import type {
  OverviewChildCounts,
  OverviewQuery,
  OverviewStatus,
  OverviewStatusFilter,
} from "../../types/execution-management.js";
export type {
  OverviewQuery,
  OverviewStatus,
  OverviewStatusFilter,
  OverviewSort,
} from "../../types/execution-management.js";

export interface OverviewNode {
  executionId: string;
  parentExecutionId: string | null;
  rootId: string;
  depth: number;
  status: OverviewStatus;
  matches: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
  idleActivityAt: number | null;
  childrenTotal: OverviewChildCounts;
}
export interface OverviewRowFacts {
  executionId: string;
  status: OverviewStatus;
  createdAt: number | null;
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
  idleActivityAt: number | null;
  children: OverviewChildCounts;
}
export interface OverviewPage {
  total: number;
  roots: string[];
  nodes: OverviewNode[];
}
/** Private native transport: repeated field names never cross SQLite for every selected row. */
type StoredOverviewNode = [
  executionId: string,
  parentExecutionId: string | null,
  rootId: string,
  depth: number,
  status: OverviewStatus,
  matches: 0 | 1,
  createdAt: number | null,
  lastActivityAt: number | null,
  subtreeActivityAt: number | null,
  idleActivityAt: number | null,
  childrenTotal: number,
  childrenUnfinished: number,
];
const STATUS_SQL = `CASE
 WHEN r.stopReason IS NOT NULL THEN 'stopped'
 WHEN r.state IN ('completed', 'failed') THEN 'completed'
 WHEN EXISTS (SELECT 1 FROM executionLock l WHERE l.executionId=r.executionId AND l.status='active') THEN 'locked'
 WHEN r.gateWaiting=1 OR r.awaitingUser IS NOT NULL THEN 'waiting-user'
 ELSE 'waiting-agent' END`;
const ACTIVITY_SQL = "COALESCE(r.lastActivityAt,r.createdAt)";
function statusPredicate(filter: OverviewStatusFilter): string {
  return filter === "all"
    ? "1"
    : filter === "active"
      ? "m.status NOT IN ('completed','stopped')"
      : "m.status=@status";
}
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
export class ExecutionOverviewRepository {
  constructor(private readonly sqlite: Database.Database) {
    registerExecutionManagementFunctions(sqlite);
  }

  /** Snapshot changes across awaited authorized metadata/dependency discovery, including same-ms writes. */
  readVersion(): string {
    const external = this.sqlite.pragma("data_version", { simple: true });
    const own = this.sqlite.prepare("SELECT total_changes() AS changes").get() as {
      changes: number;
    };
    return `${external}:${own.changes}`;
  }

  /** Scalar identities for canonical heading discovery; no execution payload is transferred. */
  searchCandidates(query: OverviewQuery): Array<{ executionId: string; workflowId: string }> {
    const conditions = [statusPredicate(query.status)];
    if (query.refusalsOnly) conditions.push("m.refusalCount>0");
    if (query.workflowId) conditions.push("m.workflowId=@workflowId");
    if (query.activeSince !== undefined) conditions.push("m.activity>=@activeSince");
    if (query.activeUntil !== undefined) conditions.push("m.activity<=@activeUntil");
    return this.sqlite
      .prepare(
        `WITH mine AS MATERIALIZED (
      SELECT r.executionId,r.workflowId,r.refusalCount,${ACTIVITY_SQL} AS activity,
        ${STATUS_SQL} AS status FROM workflowExecution r WHERE r.userId=@userId
    ) SELECT m.executionId,m.workflowId FROM mine m WHERE ${conditions.join(" AND ")}`,
      )
      .all({
        userId: query.userId,
        status: query.status,
        workflowId: query.workflowId ?? null,
        activeSince: query.activeSince ?? null,
        activeUntil: query.activeUntil ?? null,
      }) as Array<{ executionId: string; workflowId: string }>;
  }

  /** Canonical heading matches are resolved in batch before this exact count/page selection. */
  page(query: OverviewQuery, headingMatches: readonly string[] = []): OverviewPage {
    // Corrupt ancestry is displayed without changing stored links: missing/foreign parents end
    // the owned path; each cycle is cut at its lexicographically smallest member. UNION closes
    // ancestry/subtree sets finitely, while the resulting display forest retains every eligible
    // member and all required ancestors. Valid deep paths have no artificial depth limit.
    const conditions = [statusPredicate(query.status)];
    if (query.refusalsOnly) conditions.push("m.refusalCount>0");
    if (query.workflowId) conditions.push("m.workflowId=@workflowId");
    if (query.activeSince !== undefined) conditions.push("m.activity>=@activeSince");
    if (query.activeUntil !== undefined) conditions.push("m.activity<=@activeUntil");
    if (query.search)
      conditions.push(`(moira_lower(m.note) LIKE @search ESCAPE '\\'
      OR moira_lower(m.executionId) LIKE @search ESCAPE '\\'
      OR moira_lower(w.name) LIKE @search ESCAPE '\\'
      OR m.executionId IN (SELECT executionId FROM heading_matches))`);
    const order =
      query.sort === "created"
        ? "COALESCE(createdAt,0) DESC, executionId ASC"
        : query.sort === "idle"
          ? "COALESCE(idleActivityAt,0) ASC, COALESCE(createdAt,0) DESC, executionId ASC"
          : "CAST(COALESCE(subtreeActivityAt,0)/3600000 AS INTEGER) DESC, COALESCE(createdAt,0) DESC, executionId ASC";
    const result = this.sqlite
      .prepare(
        `WITH RECURSIVE
      mine AS MATERIALIZED (
        SELECT r.executionId,r.parentExecutionId,r.workflowId,r.note,r.refusalCount,r.createdAt,
          r.lastActivityAt,${ACTIVITY_SQL} AS activity,${STATUS_SQL} AS status
        FROM workflowExecution r WHERE r.userId=@userId
      ),
      heading_matches AS MATERIALIZED (SELECT value AS executionId FROM json_each(@headingMatches)),
      potential AS MATERIALIZED (
        SELECT m.executionId FROM mine m LEFT JOIN workflow w ON w.id=m.workflowId
        WHERE ${conditions.join(" AND ")}
      ),
      idle_tree(rootId,executionId) AS (
        SELECT executionId,executionId FROM potential WHERE @idleSince IS NOT NULL
        UNION
        SELECT t.rootId,c.executionId FROM idle_tree t JOIN mine c ON c.parentExecutionId=t.executionId
      ),
      eligible AS MATERIALIZED (
        SELECT p.executionId FROM potential p
        WHERE @idleSince IS NULL OR COALESCE((SELECT MAX(m.activity) FROM idle_tree t JOIN mine m ON m.executionId=t.executionId WHERE t.rootId=p.executionId),0)<=@idleSince
      ),
      retained(executionId) AS (
        SELECT executionId FROM eligible
        UNION
        SELECT m.parentExecutionId FROM retained t JOIN mine m ON m.executionId=t.executionId
          JOIN mine parent ON parent.executionId=m.parentExecutionId
      ),
      ancestry(executionId,ancestorId) AS (
        SELECT m.executionId,m.parentExecutionId FROM mine m JOIN retained t ON t.executionId=m.executionId
          JOIN retained parent ON parent.executionId=m.parentExecutionId
        UNION
        SELECT a.executionId,m.parentExecutionId FROM ancestry a JOIN mine m ON m.executionId=a.ancestorId
          JOIN retained parent ON parent.executionId=m.parentExecutionId
      ),
      placement AS MATERIALIZED (
        SELECT m.*,
          CASE WHEN parent.executionId IS NULL THEN NULL
            WHEN EXISTS(SELECT 1 FROM ancestry a WHERE a.executionId=m.executionId AND a.ancestorId=m.executionId)
              AND m.executionId=(SELECT MIN(a.ancestorId) FROM ancestry a WHERE a.executionId=m.executionId)
            THEN NULL ELSE m.parentExecutionId END AS shownParent,
          CASE WHEN e.executionId IS NULL THEN 0 ELSE 1 END AS matches
        FROM mine m JOIN retained t ON t.executionId=m.executionId
          LEFT JOIN retained parent ON parent.executionId=m.parentExecutionId
          LEFT JOIN eligible e ON e.executionId=m.executionId
      ),
      tree(rootId,executionId,depth) AS (
        SELECT executionId,executionId,0 FROM placement WHERE shownParent IS NULL
        UNION ALL SELECT t.rootId,c.executionId,t.depth+1 FROM tree t JOIN placement c ON c.shownParent=t.executionId
      ),
      visible_subtree(rootId,executionId) AS (
        SELECT executionId,executionId FROM placement
        UNION SELECT t.rootId,c.executionId FROM visible_subtree t JOIN placement c ON c.shownParent=t.executionId
      ),
      visible_activity AS MATERIALIZED (
        SELECT t.rootId,MAX(CASE WHEN m.matches=1 THEN m.activity ELSE NULL END) AS subtreeActivityAt
        FROM visible_subtree t JOIN placement m ON m.executionId=t.executionId GROUP BY t.rootId
      ),
      owned_subtree(rootId,executionId) AS (
        SELECT executionId,executionId FROM placement
        UNION SELECT t.rootId,c.executionId FROM owned_subtree t JOIN mine c ON c.parentExecutionId=t.executionId
      ),
      owned_activity AS MATERIALIZED (
        SELECT t.rootId,MAX(m.activity) AS idleActivityAt FROM owned_subtree t JOIN mine m ON m.executionId=t.executionId GROUP BY t.rootId
      ),
      children AS MATERIALIZED (
        SELECT parentExecutionId,COUNT(*) AS total,
          SUM(CASE WHEN status NOT IN ('completed','stopped') THEN 1 ELSE 0 END) AS unfinished
        FROM mine GROUP BY parentExecutionId
      ),
      facts AS MATERIALIZED (
        SELECT p.*,v.subtreeActivityAt,o.idleActivityAt,
          COALESCE(c.total,0) AS childrenTotal,COALESCE(c.unfinished,0) AS childrenUnfinished
        FROM placement p JOIN visible_activity v ON v.rootId=p.executionId
          JOIN owned_activity o ON o.rootId=p.executionId LEFT JOIN children c ON c.parentExecutionId=p.executionId
      ),
      roots AS MATERIALIZED (SELECT * FROM facts WHERE shownParent IS NULL),
      page AS MATERIALIZED (SELECT * FROM roots ORDER BY ${order} LIMIT @limit OFFSET @offset)
      SELECT (SELECT COUNT(*) FROM roots) AS total,
        (SELECT json_group_array(executionId) FROM (SELECT * FROM page ORDER BY ${order})) AS roots,
        (SELECT json_group_array(json_array(
          m.executionId,m.shownParent,t.rootId,t.depth,m.status,m.matches,
          m.createdAt,m.lastActivityAt,m.subtreeActivityAt,m.idleActivityAt,m.childrenTotal,m.childrenUnfinished
        )) FROM tree t JOIN facts m ON m.executionId=t.executionId JOIN page p ON p.executionId=t.rootId) AS nodes`,
      )
      .get({
        userId: query.userId,
        status: query.status,
        workflowId: query.workflowId ?? null,
        search: query.search ? `%${escapeLike(query.search.toLowerCase())}%` : null,
        activeSince: query.activeSince ?? null,
        activeUntil: query.activeUntil ?? null,
        idleSince: query.idleSince ?? null,
        headingMatches: JSON.stringify([...new Set(headingMatches)]),
        limit: query.limit,
        offset: query.offset,
      }) as { total: number; roots: string; nodes: string };
    return {
      total: result.total,
      roots: JSON.parse(result.roots),
      nodes: (JSON.parse(result.nodes) as StoredOverviewNode[]).map(
        ([
          executionId,
          parentExecutionId,
          rootId,
          depth,
          status,
          matches,
          createdAt,
          lastActivityAt,
          subtreeActivityAt,
          idleActivityAt,
          childrenTotal,
          childrenUnfinished,
        ]) => ({
          executionId,
          parentExecutionId,
          rootId,
          depth,
          status,
          matches: matches === 1,
          createdAt,
          lastActivityAt,
          subtreeActivityAt,
          idleActivityAt,
          childrenTotal: { total: childrenTotal, unfinished: childrenUnfinished },
        }),
      ),
    };
  }

  /** Owner-only unfiltered row refresh. Whole-subtree idle facts are not page eligibility. */
  statuses(userId: string, executionIds: string[]): OverviewRowFacts[] {
    if (!executionIds.length) return [];
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE mine AS MATERIALIZED (
      SELECT r.executionId,r.parentExecutionId,r.createdAt,r.lastActivityAt,
        ${ACTIVITY_SQL} AS activity,${STATUS_SQL} AS status
      FROM workflowExecution r WHERE r.userId=@userId
    ), tree(rootId,executionId) AS (
      SELECT executionId,executionId FROM mine WHERE executionId IN(SELECT value FROM json_each(@ids))
      UNION SELECT t.rootId,c.executionId FROM tree t JOIN mine c ON c.parentExecutionId=t.executionId
    ), children AS (
      SELECT parentExecutionId,COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN('completed','stopped') THEN 1 ELSE 0 END) AS unfinished
      FROM mine GROUP BY parentExecutionId
    )
    SELECT root.executionId,root.status,root.createdAt,root.lastActivityAt,MAX(m.activity) AS idleActivityAt,
      COALESCE(c.total,0) AS total,COALESCE(c.unfinished,0) AS unfinished
    FROM tree t JOIN mine m ON m.executionId=t.executionId JOIN mine root ON root.executionId=t.rootId
      LEFT JOIN children c ON c.parentExecutionId=t.rootId GROUP BY t.rootId`,
      )
      .all({ userId, ids: JSON.stringify(executionIds) }) as Array<{
      executionId: string;
      status: OverviewStatus;
      createdAt: number | null;
      lastActivityAt: number | null;
      idleActivityAt: number | null;
      total: number;
      unfinished: number;
    }>;
    return rows.map(({ total, unfinished, ...row }) => ({
      ...row,
      subtreeActivityAt: row.idleActivityAt,
      children: { total, unfinished },
    }));
  }
}
