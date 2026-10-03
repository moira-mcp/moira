/**
 * Stats API Routes
 * The home page's work area for the signed-in user: the runs in progress with the step each one
 * is on, the runs that finished most recently, and the flows the user runs most.
 */

import { Router, Request, Response } from "express";
import { eq, inArray } from "drizzle-orm";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import {
  DatabaseRepository,
  WorkflowExecution,
  readExecutionManagement,
} from "@mcp-moira/workflow-engine";
import { countRefusals, getDatabase, getLockService, user, workflow } from "@mcp-moira/shared";
import { currentStep } from "../utils/current-step.js";
import { executionTaskTitles } from "../utils/execution-task-titles.js";

const router = Router();
const repository = new DatabaseRepository();

/** How many runs in progress, recently finished runs and most-run flows the work area shows. */
const ACTIVE_LIMIT = 5;
const RECENT_LIMIT = 5;
const FLOWS_LIMIT = 4;

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  deleted: boolean | null;
  ownerHandle: string | null;
}

/**
 * GET /api/stats/summary
 * The work area of the signed-in user's home page.
 */
router.get(
  "/summary",
  asyncHandler(async (req: Request, res: Response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId;

    if (!userId) {
      throw createApiError.unauthorized("Unauthorized");
    }

    const [active, recent, counts, lockedIds] = await Promise.all([
      repository.listExecutionsWithFilters({
        userId,
        status: ["running"],
        includeStopped: false,
        sort: "updatedAt",
        sortOrder: "desc",
        limit: ACTIVE_LIMIT,
      }),
      // Finished runs only: the ones still going are listed as in progress
      repository.listExecutionsWithFilters({
        userId,
        status: ["completed"],
        includeStopped: true,
        sort: "updatedAt",
        sortOrder: "desc",
        limit: RECENT_LIMIT,
      }),
      // A few more than shown, so deleted flows can be left out
      repository.countRunsByWorkflow(userId, FLOWS_LIMIT * 2),
      getLockService().getActiveExecutionIds(),
    ]);

    // Only the flows the work area names are read, and a graph only for the runs in progress
    const db = getDatabase();
    const flowIds = [
      ...new Set([
        ...active.executions.map((e) => e.workflowId),
        ...recent.executions.map((e) => e.workflowId),
        ...counts.map((c) => c.workflowId),
      ]),
    ];
    const flows: FlowRow[] =
      flowIds.length === 0
        ? []
        : await db
            .select({
              id: workflow.id,
              name: workflow.name,
              description: workflow.description,
              slug: workflow.slug,
              deleted: workflow.deleted,
              ownerHandle: user.handle,
            })
            .from(workflow)
            .leftJoin(user, eq(workflow.userId, user.id))
            .where(inArray(workflow.id, flowIds));
    const flowById = new Map(flows.map((flow) => [flow.id, flow]));
    const activeFlowIds = [...new Set(active.executions.map((e) => e.workflowId))];
    const graphs =
      activeFlowIds.length === 0
        ? []
        : await db
            .select({ id: workflow.id, graph: workflow.graph })
            .from(workflow)
            .where(inArray(workflow.id, activeFlowIds));
    const graphById = new Map(graphs.map((row) => [row.id, row.graph]));
    const taskTitles = await executionTaskTitles([...active.executions, ...recent.executions]);
    const management = await readExecutionManagement(
      repository,
      [...active.executions, ...recent.executions],
      userId,
      lockedIds,
    );

    const status = (e: WorkflowExecution) =>
      e.status === "running" && lockedIds.has(e.executionId) ? "locked" : e.status;

    const activeRuns = active.executions.map((e) => ({
      executionId: e.executionId,
      workflowId: e.workflowId,
      workflowName: flowById.get(e.workflowId)?.name ?? null,
      taskTitle: taskTitles.get(e.executionId),
      taskIdentity: e.taskIdentity ?? null,
      note: e.note ?? null,
      status: status(e),
      ...management.get(e.executionId),
      hasActiveLock: lockedIds.has(e.executionId),
      errorCount: countRefusals(e.errors),
      ...currentStep(e, graphById.get(e.workflowId)),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));

    const recentRuns = recent.executions.map((e) => ({
      executionId: e.executionId,
      workflowId: e.workflowId,
      workflowName: flowById.get(e.workflowId)?.name ?? null,
      taskTitle: taskTitles.get(e.executionId),
      taskIdentity: e.taskIdentity ?? null,
      note: e.note ?? undefined,
      status: status(e),
      ...management.get(e.executionId),
      hasActiveLock: lockedIds.has(e.executionId),
      errorCount: countRefusals(e.errors),
      createdAt: e.createdAt,
      completedAt: e.completedAt,
    }));

    const topFlows = counts
      .map((count) => ({ count, flow: flowById.get(count.workflowId) }))
      .filter(({ flow }) => flow && !flow.deleted)
      .slice(0, FLOWS_LIMIT)
      .map(({ count, flow }) => ({
        id: flow!.id,
        ownerHandle: flow!.ownerHandle,
        slug: flow!.slug,
        name: flow!.name,
        description: flow!.description,
        runs: count.runs,
        lastRunAt: count.lastRunAt,
      }));

    res.json({
      success: true,
      data: { activeRuns, recentRuns, topFlows },
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
