/**
 * Admin Analytics API Routes
 * Analytics endpoints for audit data aggregation and dashboards
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import { auditLog, user, getDatabase, workflowExecution } from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { and, gte, lte, count, desc, sql, countDistinct, eq, type SQL } from "drizzle-orm";

const router = Router();
const repository = new DatabaseRepository();

// All analytics routes protected by requireAdmin middleware
router.use(requireAdmin);

/**
 * Helper to get time range boundaries
 */
function getTimeRange(range: string): { start: number; end: number } {
  const now = Date.now();
  const end = now;
  let start: number;

  switch (range) {
    case "today": {
      // Start of today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      start = todayStart.getTime();
      break;
    }
    case "week":
      start = now - 7 * 24 * 60 * 60 * 1000;
      break;
    case "month":
      start = now - 30 * 24 * 60 * 60 * 1000;
      break;
    case "year":
      start = now - 365 * 24 * 60 * 60 * 1000;
      break;
    case "all":
    default:
      start = 0;
      break;
  }

  return { start, end };
}

/**
 * GET /api/admin/analytics/overview
 * Returns high-level totals: executions, users, workflows
 */
router.get(
  "/overview",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "all";
    const { start, end } = getTimeRange(range);

    const db = getDatabase();

    // Total users
    const [usersResult] = await db.select({ count: count() }).from(user);
    const totalUsers = usersResult?.count ?? 0;

    // Total workflows (from repository)
    const workflows = await repository.listWorkflows("system-admin");
    const totalWorkflows = workflows.length;

    // Total executions (from repository)
    const executions = await repository.listExecutions();
    let filteredExecutions = executions;
    if (start > 0) {
      filteredExecutions = executions.filter((e) => e.createdAt >= start && e.createdAt <= end);
    }
    const totalExecutions = filteredExecutions.length;

    // Active executions (Issue #386: only "running" status exists for active)
    const activeExecutions = filteredExecutions.filter((e) => e.status === "running").length;

    // Completed executions (includes both successful and failed completions)
    const completedExecutions = filteredExecutions.filter((e) => e.status === "completed").length;

    // Failed executions (Issue #386: executions that completed with errors)
    const failedExecutions = filteredExecutions.filter(
      (e) => e.status === "completed" && e.errors && e.errors.length > 0,
    ).length;

    res.json({
      success: true,
      data: {
        totalUsers,
        totalWorkflows,
        totalExecutions,
        activeExecutions,
        completedExecutions,
        failedExecutions,
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/analytics/executions
 * Returns execution statistics: success rate, by workflow, over time
 */
router.get(
  "/executions",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);

    // Get all executions
    const executions = await repository.listExecutions();
    const filteredExecutions =
      start > 0 ? executions.filter((e) => e.createdAt >= start && e.createdAt <= end) : executions;

    // Calculate success rate
    // Issue #386: "failed" = completed with errors, "success" = completed without errors
    const completed = filteredExecutions.filter((e) => e.status === "completed").length;
    const failed = filteredExecutions.filter(
      (e) => e.status === "completed" && e.errors && e.errors.length > 0,
    ).length;
    const successful = completed - failed;
    const successRate = completed > 0 ? (successful / completed) * 100 : 0;

    // Executions by workflow
    const byWorkflow: Record<string, { count: number; completed: number; failed: number }> = {};
    for (const exec of filteredExecutions) {
      if (!byWorkflow[exec.workflowId]) {
        byWorkflow[exec.workflowId] = { count: 0, completed: 0, failed: 0 };
      }
      byWorkflow[exec.workflowId].count++;
      if (exec.status === "completed") {
        byWorkflow[exec.workflowId].completed++;
        // Issue #386: count as failed if has errors
        if (exec.errors && exec.errors.length > 0) {
          byWorkflow[exec.workflowId].failed++;
        }
      }
    }

    // Executions over time (daily buckets)
    const overTime: Record<
      string,
      { date: string; count: number; completed: number; failed: number }
    > = {};
    for (const exec of filteredExecutions) {
      const date = new Date(exec.createdAt).toISOString().split("T")[0];
      if (!overTime[date]) {
        overTime[date] = { date, count: 0, completed: 0, failed: 0 };
      }
      overTime[date].count++;
      if (exec.status === "completed") {
        overTime[date].completed++;
        // Issue #386: count as failed if has errors
        if (exec.errors && exec.errors.length > 0) {
          overTime[date].failed++;
        }
      }
    }

    // Sort by date
    const overTimeArray = Object.values(overTime).sort((a, b) => a.date.localeCompare(b.date));

    // Average duration for completed executions
    const completedWithDuration = filteredExecutions.filter(
      (e) => e.status === "completed" && e.completedAt && e.createdAt,
    );
    const avgDurationMs =
      completedWithDuration.length > 0
        ? completedWithDuration.reduce((sum, e) => sum + ((e.completedAt || 0) - e.createdAt), 0) /
          completedWithDuration.length
        : 0;

    res.json({
      success: true,
      data: {
        total: filteredExecutions.length,
        completed,
        failed,
        // Issue #386: only "running" status for active
        active: filteredExecutions.filter((e) => e.status === "running").length,
        successRate: Math.round(successRate * 100) / 100,
        avgDurationMs: Math.round(avgDurationMs),
        byWorkflow: Object.entries(byWorkflow).map(([workflowId, stats]) => ({
          workflowId,
          ...stats,
        })),
        overTime: overTimeArray,
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/analytics/top-workflows
 * Returns most used workflows (by execution count)
 */
router.get(
  "/top-workflows",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const limit = parseInt((req.query.limit as string) || "10", 10);
    const { start, end } = getTimeRange(range);

    // Get all executions
    const executions = await repository.listExecutions();
    const filteredExecutions =
      start > 0 ? executions.filter((e) => e.createdAt >= start && e.createdAt <= end) : executions;

    // Count by workflow
    const workflowCounts: Record<
      string,
      { count: number; completed: number; failed: number; avgDuration: number; durations: number[] }
    > = {};

    for (const exec of filteredExecutions) {
      if (!workflowCounts[exec.workflowId]) {
        workflowCounts[exec.workflowId] = {
          count: 0,
          completed: 0,
          failed: 0,
          avgDuration: 0,
          durations: [],
        };
      }
      workflowCounts[exec.workflowId].count++;
      if (exec.status === "completed") {
        workflowCounts[exec.workflowId].completed++;
        if (exec.completedAt) {
          workflowCounts[exec.workflowId].durations.push(exec.completedAt - exec.createdAt);
        }
        // Issue #386: count as failed if has errors
        if (exec.errors && exec.errors.length > 0) {
          workflowCounts[exec.workflowId].failed++;
        }
      }
    }

    // Calculate average durations
    for (const wfId of Object.keys(workflowCounts)) {
      const durations = workflowCounts[wfId].durations;
      workflowCounts[wfId].avgDuration =
        durations.length > 0
          ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
          : 0;
    }

    // Get workflow names
    const workflows = await repository.listWorkflows("system-admin");
    const workflowMap = new Map(workflows.map((w) => [w.id, w.metadata?.name || w.id]));

    // Sort by count and take top N
    const topWorkflows = Object.entries(workflowCounts)
      .map(([workflowId, stats]) => ({
        workflowId,
        workflowName: workflowMap.get(workflowId) || workflowId,
        executionCount: stats.count,
        completedCount: stats.completed,
        failedCount: stats.failed,
        successRate:
          stats.completed + stats.failed > 0
            ? Math.round((stats.completed / (stats.completed + stats.failed)) * 10000) / 100
            : 0,
        avgDurationMs: stats.avgDuration,
      }))
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, limit);

    res.json({
      success: true,
      data: {
        workflows: topWorkflows,
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/analytics/users
 * Returns user activity statistics
 */
router.get(
  "/users",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);

    const db = getDatabase();

    // Get all users
    const users = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
      })
      .from(user);

    // Get executions for activity stats
    const executions = await repository.listExecutions();
    const filteredExecutions =
      start > 0 ? executions.filter((e) => e.createdAt >= start && e.createdAt <= end) : executions;

    // Count executions per user
    const executionsByUser: Record<string, number> = {};
    for (const exec of filteredExecutions) {
      executionsByUser[exec.userId] = (executionsByUser[exec.userId] || 0) + 1;
    }

    // Get workflows per user
    const workflows = await repository.listWorkflows("system-admin");
    const workflowsByUser: Record<string, number> = {};
    for (const wf of workflows) {
      workflowsByUser[wf.userId] = (workflowsByUser[wf.userId] || 0) + 1;
    }

    // Active users (had executions in time range)
    const activeUserIds = new Set(filteredExecutions.map((e) => e.userId));
    const activeUsers = activeUserIds.size;

    // New users in time range
    const newUsers =
      start > 0
        ? users.filter((u) => {
            const createdAtTs = new Date(u.createdAt).getTime();
            return createdAtTs >= start && createdAtTs <= end;
          }).length
        : users.length;

    // Top users by activity
    const topUsers = users
      .map((u) => ({
        userId: u.id,
        email: u.email,
        name: u.name,
        executionCount: executionsByUser[u.id] || 0,
        workflowCount: workflowsByUser[u.id] || 0,
      }))
      .filter((u) => u.executionCount > 0)
      .sort((a, b) => b.executionCount - a.executionCount)
      .slice(0, 10);

    res.json({
      success: true,
      data: {
        totalUsers: users.length,
        activeUsers,
        newUsers,
        topUsers,
        timeRange: range,
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
        start > 0
          ? and(gte(auditLog.createdAt, new Date(start)), lte(auditLog.createdAt, new Date(end)))
          : undefined,
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
        start > 0
          ? and(gte(auditLog.createdAt, new Date(start)), lte(auditLog.createdAt, new Date(end)))
          : undefined,
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
      .where(and(gte(auditLog.createdAt, new Date(start)), lte(auditLog.createdAt, new Date(end))));

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
      .where(and(gte(auditLog.createdAt, new Date(start)), lte(auditLog.createdAt, new Date(end))));

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
    const executions = await repository.listExecutions();
    const workflowExecutions = executions.filter(
      (e) => e.workflowId === workflowId && e.createdAt >= start && e.createdAt <= end,
    );
    const completedCount = workflowExecutions.filter((e) => e.status === "completed").length;
    const totalCount = workflowExecutions.length;
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
        hotSteps,
        deadSteps,
        problematicSteps,
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// === Business Analytics: Conversion Funnel ===

/**
 * GET /api/admin/analytics/conversion-funnel
 * Returns user conversion funnel: registered → verified → first workflow → active (2+ executions)
 * Query params: range (today|week|month|year|all)
 */
router.get(
  "/conversion-funnel",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);
    const db = getDatabase();

    // Stage 1: Total registered users in time range
    const registeredResult = await db
      .select({ count: count() })
      .from(user)
      .where(
        and(
          gte(user.createdAt, new Date(start).toISOString()),
          lte(user.createdAt, new Date(end).toISOString()),
        ),
      );
    const totalRegistered = registeredResult[0]?.count ?? 0;

    // Stage 2: Email verified users in time range
    const verifiedResult = await db
      .select({ count: count() })
      .from(user)
      .where(
        and(
          gte(user.createdAt, new Date(start).toISOString()),
          lte(user.createdAt, new Date(end).toISOString()),
          eq(user.emailVerified, true),
        ),
      );
    const totalVerified = verifiedResult[0]?.count ?? 0;

    // Stage 3: Users who started at least one workflow (any time, registered in range)
    const startedWorkflowResult = await db
      .select({ count: countDistinct(workflowExecution.userId) })
      .from(workflowExecution)
      .innerJoin(user, eq(workflowExecution.userId, user.id))
      .where(
        and(
          gte(user.createdAt, new Date(start).toISOString()),
          lte(user.createdAt, new Date(end).toISOString()),
        ),
      );
    const totalStartedWorkflow = startedWorkflowResult[0]?.count ?? 0;

    // Stage 4: Active users with 2+ executions
    const activeUsersSubquery = db
      .select({
        userId: workflowExecution.userId,
        execCount: count().as("exec_count"),
      })
      .from(workflowExecution)
      .innerJoin(user, eq(workflowExecution.userId, user.id))
      .where(
        and(
          gte(user.createdAt, new Date(start).toISOString()),
          lte(user.createdAt, new Date(end).toISOString()),
        ),
      )
      .groupBy(workflowExecution.userId)
      .as("active_sq");

    const activeResult = await db
      .select({ count: count() })
      .from(activeUsersSubquery)
      .where(gte(activeUsersSubquery.execCount, 2));
    const totalActive = activeResult[0]?.count ?? 0;

    // Registration time series (for trend chart)
    const registrationDayExpr = sql<string>`date(${user.createdAt})`;
    const registrationSeries = await db
      .select({
        date: registrationDayExpr.as("date"),
        value: count(),
      })
      .from(user)
      .where(
        and(
          gte(user.createdAt, new Date(start).toISOString()),
          lte(user.createdAt, new Date(end).toISOString()),
        ),
      )
      .groupBy(registrationDayExpr)
      .orderBy(registrationDayExpr);

    const funnel = [
      { stage: "registered", label: "Registered", count: totalRegistered },
      { stage: "verified", label: "Email Verified", count: totalVerified },
      { stage: "first_workflow", label: "Started Workflow", count: totalStartedWorkflow },
      { stage: "active", label: "Active (2+ runs)", count: totalActive },
    ];

    res.json({
      success: true,
      data: {
        funnel,
        registrationTrend: registrationSeries.map((r) => ({ date: r.date, value: r.value })),
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// === Business Analytics: Engagement Metrics ===

/**
 * GET /api/admin/analytics/engagement
 * Returns engagement metrics: returning users, avg executions per user, time-to-first-workflow
 * Query params: range (today|week|month|year|all)
 */
router.get(
  "/engagement",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "month";
    const { start, end } = getTimeRange(range);
    const db = getDatabase();

    // 1. Returning users rate: users with executions in BOTH current and previous period
    const periodMs = end - start;
    const prevStart = start - periodMs;

    const currentPeriodUsers = await db
      .select({ userId: workflowExecution.userId })
      .from(workflowExecution)
      .where(
        and(
          gte(workflowExecution.createdAt, new Date(start)),
          lte(workflowExecution.createdAt, new Date(end)),
        ),
      )
      .groupBy(workflowExecution.userId);

    const prevPeriodUsers = await db
      .select({ userId: workflowExecution.userId })
      .from(workflowExecution)
      .where(
        and(
          gte(workflowExecution.createdAt, new Date(prevStart)),
          lte(workflowExecution.createdAt, new Date(start)),
        ),
      )
      .groupBy(workflowExecution.userId);

    const prevUserIds = new Set(prevPeriodUsers.map((r) => r.userId));
    const returningCount = currentPeriodUsers.filter((r) => prevUserIds.has(r.userId)).length;
    const returningRate =
      currentPeriodUsers.length > 0
        ? Math.round((returningCount / currentPeriodUsers.length) * 10000) / 100
        : 0;

    // 2. Average executions per active user in period
    const execPerUserResult = await db
      .select({
        userId: workflowExecution.userId,
        execCount: count().as("exec_count"),
      })
      .from(workflowExecution)
      .where(
        and(
          gte(workflowExecution.createdAt, new Date(start)),
          lte(workflowExecution.createdAt, new Date(end)),
        ),
      )
      .groupBy(workflowExecution.userId);

    const totalExecCounts = execPerUserResult.reduce((sum, r) => sum + r.execCount, 0);
    const avgExecsPerUser =
      execPerUserResult.length > 0
        ? Math.round((totalExecCounts / execPerUserResult.length) * 100) / 100
        : 0;

    // 3. Time-to-first-workflow: avg days between user registration and first execution
    const firstExecPerUser = await db
      .select({
        userId: workflowExecution.userId,
        firstExecAt: sql<number>`MIN(${workflowExecution.createdAt})`.as("first_exec_at"),
      })
      .from(workflowExecution)
      .groupBy(workflowExecution.userId);

    let totalDaysToFirst = 0;
    let usersWithFirstExec = 0;

    // Get user registration dates for these users
    if (firstExecPerUser.length > 0) {
      const userIds = firstExecPerUser.map((r) => r.userId);
      const userRegDates = await db
        .select({ id: user.id, createdAt: user.createdAt })
        .from(user)
        .where(
          sql`${user.id} IN (${sql.join(
            userIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );

      const regMap = new Map(userRegDates.map((u) => [u.id, u.createdAt]));

      for (const exec of firstExecPerUser) {
        const regDate = regMap.get(exec.userId);
        if (regDate && exec.firstExecAt) {
          const regMs = new Date(regDate).getTime();
          const firstMs =
            typeof exec.firstExecAt === "number"
              ? exec.firstExecAt
              : new Date(exec.firstExecAt).getTime();
          const daysDiff = (firstMs - regMs) / (1000 * 60 * 60 * 24);
          if (daysDiff >= 0) {
            totalDaysToFirst += daysDiff;
            usersWithFirstExec++;
          }
        }
      }
    }

    const avgTimeToFirstWorkflow =
      usersWithFirstExec > 0
        ? Math.round((totalDaysToFirst / usersWithFirstExec) * 100) / 100
        : null;

    // 4. Active users trend (time series)
    const activeUsersDayExpr = sql<string>`date(${workflowExecution.createdAt} / 1000, 'unixepoch')`;
    const activeUsersTrend = await db
      .select({
        date: activeUsersDayExpr.as("date"),
        value: countDistinct(workflowExecution.userId),
      })
      .from(workflowExecution)
      .where(
        and(
          gte(workflowExecution.createdAt, new Date(start)),
          lte(workflowExecution.createdAt, new Date(end)),
        ),
      )
      .groupBy(activeUsersDayExpr)
      .orderBy(activeUsersDayExpr);

    res.json({
      success: true,
      data: {
        returningUsersRate: returningRate,
        returningUsersCount: returningCount,
        totalActiveUsers: currentPeriodUsers.length,
        avgExecutionsPerUser: avgExecsPerUser,
        avgTimeToFirstWorkflowDays: avgTimeToFirstWorkflow,
        activeUsersTrend: activeUsersTrend.map((r) => ({ date: r.date, value: r.value })),
        timeRange: range,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// === Operational Metrics ===

interface OperationalMetric {
  name: string;
  value: number | null;
  unit: string;
  available: boolean;
  unavailableReason?: string;
}

interface TimeSeriesPoint {
  date: string;
  value: number;
}

interface OperationalMetricWithTimeSeries extends OperationalMetric {
  timeSeries?: TimeSeriesPoint[];
}

/**
 * GET /api/admin/analytics/operational
 * Returns 6 operational metrics with time-range support, granularity, and breakdowns
 * Query params: range (today|week|month|year|all), granularity (auto|hourly|daily)
 */
router.get(
  "/operational",
  asyncHandler(async (req: Request, res: Response) => {
    const range = (req.query.range as string) || "week";
    const granularityParam = (req.query.granularity as string) || "auto";
    const filterAction = req.query.action as string | undefined;
    const filterSource = req.query.source as string | undefined;
    const filterResource = req.query.resource as string | undefined;
    const { start, end } = getTimeRange(range);

    // Resolve granularity: auto = hourly for today/week, daily for month/year/all
    const granularity =
      granularityParam === "auto"
        ? range === "today" || range === "week"
          ? "hourly"
          : "daily"
        : granularityParam;

    const db = getDatabase();
    const metrics: OperationalMetricWithTimeSeries[] = [];

    // Build audit log filter conditions (time range + optional filters)
    function auditTimeAndFilters(): SQL[] {
      const conditions: SQL[] = [
        gte(auditLog.createdAt, new Date(start)),
        lte(auditLog.createdAt, new Date(end)),
      ];
      if (filterAction) conditions.push(eq(auditLog.action, filterAction));
      if (filterSource) conditions.push(eq(auditLog.source, filterSource));
      if (filterResource) conditions.push(eq(auditLog.resource, filterResource));
      return conditions;
    }

    // Time grouping expressions based on granularity
    const auditDayExpr = sql<string>`date(${auditLog.createdAt} / 1000, 'unixepoch')`;
    const auditHourExpr = sql<string>`strftime('%Y-%m-%d %H:00', ${auditLog.createdAt} / 1000, 'unixepoch')`;
    const auditGroupExpr = granularity === "hourly" ? auditHourExpr : auditDayExpr;

    // 1. Unique users per day (from audit log)
    try {
      const uniqueUsersTimeSeries = await db
        .select({
          period: auditGroupExpr.as("period"),
          value: countDistinct(auditLog.userId),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditGroupExpr)
        .orderBy(auditGroupExpr);

      const totalUniqueUsers = uniqueUsersTimeSeries.reduce((sum, row) => sum + row.value, 0);

      metrics.push({
        name: "unique_users_per_day",
        value: totalUniqueUsers,
        unit: "users",
        available: true,
        timeSeries: uniqueUsersTimeSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "unique_users_per_day",
        value: null,
        unit: "users",
        available: false,
        unavailableReason: "Failed to query audit log",
      });
    }

    // 2. Total MCP/API calls per day (from audit log)
    try {
      const callsTimeSeries = await db
        .select({
          period: auditGroupExpr.as("period"),
          value: count(),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditGroupExpr)
        .orderBy(auditGroupExpr);

      const totalCalls = callsTimeSeries.reduce((sum, row) => sum + row.value, 0);

      metrics.push({
        name: "total_calls_per_day",
        value: totalCalls,
        unit: "calls",
        available: true,
        timeSeries: callsTimeSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "total_calls_per_day",
        value: null,
        unit: "calls",
        available: false,
        unavailableReason: "Failed to query audit log",
      });
    }

    // 3. API calls per second (current rate from audit log — last 60 seconds)
    try {
      const sixtySecondsAgo = Date.now() - 60_000;
      const recentFilters: SQL[] = [gte(auditLog.createdAt, new Date(sixtySecondsAgo))];
      if (filterAction) recentFilters.push(eq(auditLog.action, filterAction));
      if (filterSource) recentFilters.push(eq(auditLog.source, filterSource));
      if (filterResource) recentFilters.push(eq(auditLog.resource, filterResource));

      const recentCallsResult = await db
        .select({ value: count() })
        .from(auditLog)
        .where(and(...recentFilters));

      const recentCount = recentCallsResult[0]?.value ?? 0;
      const rate = Math.round((recentCount / 60) * 100) / 100;

      // Time series using selected granularity
      const callsRateSeries = await db
        .select({
          period: auditGroupExpr.as("period"),
          value: count(),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditGroupExpr)
        .orderBy(auditGroupExpr);

      metrics.push({
        name: "calls_per_second",
        value: rate,
        unit: "req/s",
        available: true,
        timeSeries: callsRateSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "calls_per_second",
        value: null,
        unit: "req/s",
        available: false,
        unavailableReason: "Failed to query audit log",
      });
    }

    // 4. Workflows started per day (from DB)
    try {
      const wfDayExpr = sql<string>`date(${workflowExecution.createdAt} / 1000, 'unixepoch')`;
      const wfHourExpr = sql<string>`strftime('%Y-%m-%d %H:00', ${workflowExecution.createdAt} / 1000, 'unixepoch')`;
      const wfGroupExpr = granularity === "hourly" ? wfHourExpr : wfDayExpr;

      const startedTimeSeries = await db
        .select({
          period: wfGroupExpr.as("period"),
          value: count(),
        })
        .from(workflowExecution)
        .where(
          and(
            gte(workflowExecution.createdAt, new Date(start)),
            lte(workflowExecution.createdAt, new Date(end)),
          ),
        )
        .groupBy(wfGroupExpr)
        .orderBy(wfGroupExpr);

      const totalStarted = startedTimeSeries.reduce((sum, row) => sum + row.value, 0);

      metrics.push({
        name: "workflows_started_per_day",
        value: totalStarted,
        unit: "workflows",
        available: true,
        timeSeries: startedTimeSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "workflows_started_per_day",
        value: null,
        unit: "workflows",
        available: false,
        unavailableReason: "Failed to query workflow executions",
      });
    }

    // 5. Workflows completed per day (from DB)
    try {
      const wfcDayExpr = sql<string>`date(${workflowExecution.completedAt} / 1000, 'unixepoch')`;
      const wfcHourExpr = sql<string>`strftime('%Y-%m-%d %H:00', ${workflowExecution.completedAt} / 1000, 'unixepoch')`;
      const wfcGroupExpr = granularity === "hourly" ? wfcHourExpr : wfcDayExpr;

      const completedTimeSeries = await db
        .select({
          period: wfcGroupExpr.as("period"),
          value: count(),
        })
        .from(workflowExecution)
        .where(
          and(
            eq(workflowExecution.state, "completed"),
            gte(workflowExecution.completedAt, new Date(start)),
            lte(workflowExecution.completedAt, new Date(end)),
          ),
        )
        .groupBy(wfcGroupExpr)
        .orderBy(wfcGroupExpr);

      const totalCompleted = completedTimeSeries.reduce((sum, row) => sum + row.value, 0);

      metrics.push({
        name: "workflows_completed_per_day",
        value: totalCompleted,
        unit: "workflows",
        available: true,
        timeSeries: completedTimeSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "workflows_completed_per_day",
        value: null,
        unit: "workflows",
        available: false,
        unavailableReason: "Failed to query workflow executions",
      });
    }

    // 6. MCP calls per second (from audit log — source='mcp' last 60 seconds)
    try {
      const sixtySecondsAgo = Date.now() - 60_000;
      const recentMcpFilters: SQL[] = [
        gte(auditLog.createdAt, new Date(sixtySecondsAgo)),
        eq(auditLog.source, "mcp"),
      ];
      if (filterAction) recentMcpFilters.push(eq(auditLog.action, filterAction));
      if (filterResource) recentMcpFilters.push(eq(auditLog.resource, filterResource));

      const recentMcpResult = await db
        .select({ value: count() })
        .from(auditLog)
        .where(and(...recentMcpFilters));

      const recentMcpCount = recentMcpResult[0]?.value ?? 0;
      const mcpRate = Math.round((recentMcpCount / 60) * 100) / 100;

      // Time series for MCP calls using selected granularity
      const mcpTimeFilters: SQL[] = [...auditTimeAndFilters(), eq(auditLog.source, "mcp")];
      const mcpSeries = await db
        .select({
          period: auditGroupExpr.as("period"),
          value: count(),
        })
        .from(auditLog)
        .where(and(...mcpTimeFilters))
        .groupBy(auditGroupExpr)
        .orderBy(auditGroupExpr);

      metrics.push({
        name: "mcp_calls_per_second",
        value: mcpRate,
        unit: "req/s",
        available: true,
        timeSeries: mcpSeries.map((row) => ({
          date: row.period,
          value: row.value,
        })),
      });
    } catch {
      metrics.push({
        name: "mcp_calls_per_second",
        value: null,
        unit: "req/s",
        available: false,
        unavailableReason: "Failed to query audit log",
      });
    }

    // === Breakdowns: action types, sources, resources ===
    interface BreakdownItem {
      label: string;
      count: number;
    }

    const breakdowns: {
      byAction: BreakdownItem[];
      bySource: BreakdownItem[];
      byResource: BreakdownItem[];
    } = { byAction: [], bySource: [], byResource: [] };

    try {
      // Top 15 actions
      const actionBreakdown = await db
        .select({
          label: auditLog.action,
          count: count(),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditLog.action)
        .orderBy(desc(count()))
        .limit(15);

      breakdowns.byAction = actionBreakdown.map((r) => ({
        label: r.label,
        count: r.count,
      }));

      // By source (mcp / web / api / system)
      const sourceBreakdown = await db
        .select({
          label: auditLog.source,
          count: count(),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditLog.source)
        .orderBy(desc(count()));

      breakdowns.bySource = sourceBreakdown.map((r) => ({
        label: r.label ?? "unknown",
        count: r.count,
      }));

      // By resource type
      const resourceBreakdown = await db
        .select({
          label: auditLog.resource,
          count: count(),
        })
        .from(auditLog)
        .where(and(...auditTimeAndFilters()))
        .groupBy(auditLog.resource)
        .orderBy(desc(count()));

      breakdowns.byResource = resourceBreakdown.map((r) => ({
        label: r.label ?? "unknown",
        count: r.count,
      }));
    } catch {
      // Breakdowns are best-effort, don't fail the entire response
    }

    res.json({
      success: true,
      data: {
        metrics,
        breakdowns,
        timeRange: range,
        granularity,
        activeFilters: {
          action: filterAction || null,
          source: filterSource || null,
          resource: filterResource || null,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as adminAnalyticsRoutes };
