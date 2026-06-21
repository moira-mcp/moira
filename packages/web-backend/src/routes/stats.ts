/**
 * Stats API Routes
 * User-specific statistics for dashboard
 */

import { Router, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { note, getDatabase } from "@mcp-moira/shared";

const router = Router();
const repository = new DatabaseRepository();

/**
 * GET /api/stats/summary
 * Returns user-specific statistics for dashboard
 */
router.get(
  "/summary",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId;

    if (!userId) {
      throw createApiError.unauthorized("Unauthorized");
    }

    // Get workflows count
    const workflows = await repository.listWorkflows(userId);
    const workflowsCount = workflows.length;

    // Get executions count (user-filtered at repository level)
    const userExecutions = await repository.listUserExecutions(userId);
    const executionsCount = userExecutions.length;

    // Get notes count
    const db = getDatabase();
    const noteCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(note)
      .where(eq(note.userId, userId));
    const notesCount = noteCountResult[0]?.count ?? 0;

    // Build workflow name lookup for recent executions
    const workflowNameMap = new Map(workflows.map((w) => [w.id, w.metadata?.name || w.id]));

    // Get recent workflows (last 5)
    const recentWorkflows = workflows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((w) => ({
        id: w.id,
        name: w.metadata?.name || w.id,
        description: w.metadata?.description || null,
        visibility: w.visibility,
        createdAt: new Date(w.createdAt).toISOString(),
      }));

    // Get recent executions (last 5) with workflow name and note
    const recentExecutions = userExecutions
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((e) => ({
        id: e.executionId,
        workflowId: e.workflowId,
        workflowName: workflowNameMap.get(e.workflowId) || null,
        note: e.note || null,
        status: e.status,
        startTime: new Date(e.createdAt).toISOString(),
        endTime: e.completedAt ? new Date(e.completedAt).toISOString() : undefined,
        duration: e.completedAt ? e.completedAt - e.createdAt : null,
      }));

    res.json({
      success: true,
      data: {
        stats: {
          workflowsCount,
          executionsCount,
          notesCount,
        },
        recentWorkflows,
        recentExecutions,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
