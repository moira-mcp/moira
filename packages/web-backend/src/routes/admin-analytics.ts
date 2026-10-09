/**
 * Administrator analytics: bounded SQL projections with common periods and exclusions.
 */
import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import {
  auditLog,
  getDatabase,
  workflowExecution,
  AdminAnalyticsRepository,
  parseAnalyticsQuery,
  analyticsBounds,
} from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { and, gte, lt, count, desc, sql, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { withExecutionTaskTitles } from "../utils/execution-task-titles.js";
const router = Router();
const repository = new DatabaseRepository();
const analytics = () => new AdminAnalyticsRepository(getDatabase());
function exclusions(req: Request, column: SQLWrapper): SQL {
  const query = parseAnalyticsQuery(req.query);
  if (query.exclusions.mode === "default-admins")
    return sql`${column} NOT IN (SELECT id FROM user WHERE coalesce(isAdmin,0)=1)`;
  return query.exclusions.userIds.length
    ? sql`${column} NOT IN (${sql.join(
        query.exclusions.userIds.map((id) => sql`${id}`),
        sql`,`,
      )})`
    : sql`1=1`;
}
function getTimeRange(range: string): { start: number; end: number } {
  const parsed = parseAnalyticsQuery({ range });
  const bounds = analyticsBounds(parsed.range, Date.now());
  return { start: bounds.startAt, end: bounds.endAt };
}
router.get(
  "/overview",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().overview(parseAnalyticsQuery(req.query)),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().users(parseAnalyticsQuery(req.query, "30m")),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/registrations",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().registrations(parseAnalyticsQuery(req.query, "week")),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/attention",
  asyncHandler(async (req: Request, res: Response) => {
    const data = await withExecutionTaskTitles((db) =>
      new AdminAnalyticsRepository(db).attention(
        parseAnalyticsQuery(req.query, "week"),
        (req as AuthenticatedRequest).userId,
      ),
    );
    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/top-workflows",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().topWorkflows(parseAnalyticsQuery(req.query, "month", 10)),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/executions",
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseAnalyticsQuery(req.query);
    const repo = analytics();
    const overview = repo.overview(query);
    const workflows = repo.topWorkflows({ ...query, limit: 20 });
    res.json({
      success: true,
      data: {
        ...overview,
        total: overview.totalExecutions,
        completed: overview.completedExecutions,
        failed: overview.failedExecutions,
        stopped: overview.stoppedExecutions,
        active: overview.activeExecutions,
        byWorkflow: workflows.workflows.map((w) => ({
          workflowId: w.workflowId,
          count: w.executionCount,
          completed: w.completedCount,
          failed: w.failedCount,
          stopped: w.stoppedCount,
        })),
        byWorkflowTotal: workflows.total,
        byWorkflowLimited: workflows.total > workflows.workflows.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);
/**
 * GET /api/admin/analytics/audit-summary
 * Returns audit log summary by action type
 */
router.get(
  "/audit-summary",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);

    const db = getDatabase();

    // Count by action using raw SQL for grouping
    const actionCounts = await db
      .select({
        action: auditLog.action,
        count: count(),
      })
      .from(auditLog)
      .where(
        and(
          exclusions(req, auditLog.userId),
          gte(auditLog.createdAt, new Date(start)),
          lt(auditLog.createdAt, new Date(end)),
        ),
      )
      .groupBy(auditLog.action)
      .orderBy(desc(count()));

    // Group by category (prefix before colon)
    const byCategory: Record<string, number> = {};
    for (const row of actionCounts) {
      const category = row.action.split(":")[0];
      byCategory[category] = (byCategory[category] || 0) + row.count;
    }

    // Recent activity trend (hourly for today, daily for longer ranges)
    const bucketSize = range === "today" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const activityTrend: Record<string, number> = {};

    // Get recent audit entries for trend
    const recentEntries = await db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(
        and(
          exclusions(req, auditLog.userId),
          gte(auditLog.createdAt, new Date(start)),
          lt(auditLog.createdAt, new Date(end)),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(10000);

    for (const entry of recentEntries) {
      const ts = (entry.createdAt as Date).getTime();
      const bucketStart = Math.floor(ts / bucketSize) * bucketSize;
      const bucketKey =
        range === "today"
          ? new Date(bucketStart).toISOString().slice(11, 16) // HH:mm
          : new Date(bucketStart).toISOString().split("T")[0]; // YYYY-MM-DD
      activityTrend[bucketKey] = (activityTrend[bucketKey] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        byAction: actionCounts.map((row) => ({
          action: row.action,
          count: row.count,
        })),
        byCategory: Object.entries(byCategory)
          .map(([category, count]) => ({ category, count }))
          .sort((a, b) => b.count - a.count),
        activityTrend: Object.entries(activityTrend)
          .map(([time, count]) => ({ time, count }))
          .sort((a, b) => a.time.localeCompare(b.time)),
        totalEntries: actionCounts.reduce((sum, row) => sum + row.count, 0),
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/analytics/workflow-quality/:workflowId
 * Returns workflow quality analytics: problematic, dead, and hot steps
 */
router.get(
  "/workflow-quality/:workflowId",
  asyncHandler(async (req: Request, res: Response) => {
    const { workflowId } = req.params;
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);

    const db = getDatabase();

    // Get workflow to find all node IDs
    const workflow = await repository.getWorkflow(workflowId, "system-admin");
    if (!workflow) {
      throw createApiError.notFound("Workflow not found", { workflowId });
    }

    const allNodeIds = new Set(workflow.workflow.nodes.map((n: { id: string }) => n.id));

    // Get execution:step events for this workflow
    const stepEvents = await db
      .select({
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          exclusions(req, auditLog.userId),
          eq(auditLog.resource, "execution"),
          eq(auditLog.action, "execution:step"),
          gte(auditLog.createdAt, new Date(start)),
          lt(auditLog.createdAt, new Date(end)),
        ),
      );

    // Filter to this workflow's step events
    const workflowStepEvents = stepEvents.filter((e) => {
      try {
        const meta = e.metadata ? JSON.parse(e.metadata as string) : {};
        return meta.workflowId === workflowId && meta.toNodeId;
      } catch {
        return false;
      }
    });

    // Count steps by nodeId
    const nodeExecutionCounts: Record<string, number> = {};
    for (const event of workflowStepEvents) {
      try {
        const meta = JSON.parse(event.metadata as string);
        const nodeId = meta.toNodeId;
        nodeExecutionCounts[nodeId] = (nodeExecutionCounts[nodeId] || 0) + 1;
      } catch {
        // Skip invalid metadata
      }
    }

    // Get step_fail events for this workflow
    const failEvents = await db
      .select({
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          exclusions(req, auditLog.userId),
          eq(auditLog.resource, "execution"),
          eq(auditLog.action, "execution:step_fail"),
          gte(auditLog.createdAt, new Date(start)),
          lt(auditLog.createdAt, new Date(end)),
        ),
      );

    const workflowFailEvents = failEvents.filter((e) => {
      try {
        const meta = e.metadata ? JSON.parse(e.metadata as string) : {};
        return meta.workflowId === workflowId;
      } catch {
        return false;
      }
    });

    // Count failures by nodeId
    const nodeFailureCounts: Record<string, number> = {};
    for (const event of workflowFailEvents) {
      try {
        const meta = JSON.parse(event.metadata as string);
        if (meta.nodeId) {
          nodeFailureCounts[meta.nodeId] = (nodeFailureCounts[meta.nodeId] || 0) + 1;
        }
      } catch {
        // Skip invalid metadata
      }
    }

    // Helper to get node name (directive or id)
    const getNodeName = (nodeId: string): string => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const node = workflow.workflow.nodes.find((n: any) => n.id === nodeId);
      if (node && "directive" in node && typeof node.directive === "string") {
        return node.directive.slice(0, 50);
      }
      return nodeId;
    };

    // Calculate hot steps (most executed)
    const hotSteps = Object.entries(nodeExecutionCounts)
      .map(([nodeId, count]) => ({
        nodeId,
        executionCount: count,
        nodeName: getNodeName(nodeId),
      }))
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, 10);

    // Calculate dead steps (nodes never reached)
    const deadSteps = (Array.from(allNodeIds) as string[])
      .filter((nodeId: string) => !nodeExecutionCounts[nodeId])
      .map((nodeId: string) => ({
        nodeId,
        nodeName: getNodeName(nodeId),
      }));

    // Calculate problematic steps (high failure rate)
    const problematicSteps = Object.entries(nodeFailureCounts)
      .filter(([, count]) => count > 0)
      .map(([nodeId, failCount]) => {
        const execCount = nodeExecutionCounts[nodeId] || 0;
        return {
          nodeId,
          failureCount: failCount,
          executionCount: execCount,
          failureRate: execCount > 0 ? Math.round((failCount / execCount) * 10000) / 100 : 100,
          nodeName: getNodeName(nodeId),
        };
      })
      .sort((a, b) => b.failureRate - a.failureRate)
      .slice(0, 10);

    // Get completion stats
    const [completion] = await db
      .select({
        total: count(),
        completed: sql<number>`coalesce(sum(${workflowExecution.state}='completed' AND ${workflowExecution.stopReason} IS NULL),0)`,
        stopped: sql<number>`coalesce(sum(${workflowExecution.stopReason} IS NOT NULL),0)`,
      })
      .from(workflowExecution)
      .where(
        and(
          exclusions(req, workflowExecution.userId),
          eq(workflowExecution.workflowId, workflowId),
          gte(workflowExecution.createdAt, new Date(start)),
          lt(workflowExecution.createdAt, new Date(end)),
        ),
      );
    const completedCount = completion?.completed ?? 0;
    const stoppedCount = completion?.stopped ?? 0;
    const totalCount = completion?.total ?? 0;
    const completionRate =
      totalCount > 0 ? Math.round((completedCount / totalCount) * 10000) / 100 : 0;

    res.json({
      success: true,
      data: {
        workflowId,
        workflowName: workflow.metadata?.name || workflowId,
        totalNodes: allNodeIds.size,
        completionRate,
        totalExecutions: totalCount,
        completedExecutions: completedCount,
        stoppedExecutions: stoppedCount,
        hotSteps,
        deadSteps,
        problematicSteps,
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// Existing advanced endpoints share repository scope, normalized time and bounded series.
router.get(
  "/conversion-funnel",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().conversion(parseAnalyticsQuery(req.query)),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/engagement",
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      success: true,
      data: analytics().engagement(parseAnalyticsQuery(req.query)),
      timestamp: new Date().toISOString(),
    });
  }),
);
router.get(
  "/operational",
  asyncHandler(async (req: Request, res: Response) => {
    const query = parseAnalyticsQuery(req.query, "week");
    const granularity = req.query.granularity ?? "auto";
    if (granularity !== "auto" && granularity !== "daily" && granularity !== "hourly")
      throw createApiError.validationFailed("Invalid operational granularity");
    const filters: { action?: string; source?: string; resource?: string } = {};
    for (const field of ["action", "source", "resource"] as const) {
      const value = req.query[field];
      if (value !== undefined && typeof value !== "string")
        throw createApiError.validationFailed(`Invalid operational ${field}`);
      if (typeof value === "string" && value) filters[field] = value;
    }
    res.json({
      success: true,
      data: analytics().operational(query.range, granularity, filters),
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as adminAnalyticsRoutes };
