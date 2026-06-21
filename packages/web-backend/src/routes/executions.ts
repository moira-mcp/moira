/**
 * Execution Management Routes
 * REST API endpoints for workflow execution viewing and context editing
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { DatabaseRepository, WorkflowExecution } from "@mcp-moira/workflow-engine";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getExecutionService,
  getLockService,
  mapLegacyStatusArray,
  LegacyExecutionStatus,
  workflow,
  getDatabase,
} from "@mcp-moira/shared";

const router = Router();

// Create repository instance (uses shared database singleton)
const repository = new DatabaseRepository();

// Get ExecutionService for operations with automatic audit
const executionService = getExecutionService();

/**
 * GET /api/executions
 * List user's executions with filters, sorting, and pagination (admins see all)
 * Query params: status, workflowId, search, sort, sortOrder, limit, offset
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const userInfo = (req as AuthenticatedRequest).userInfo;
    const isAdmin = userInfo?.isAdmin || false;

    // Parse query parameters
    // Issue #386: Map legacy statuses for backward compatibility
    // Old clients may send "failed" or "waiting" - map to new status values
    const statusParam = req.query.status as string | undefined;
    const rawStatus = statusParam
      ? (statusParam
          .split(",")
          .filter((s) =>
            ["running", "waiting", "completed", "failed", "locked"].includes(s),
          ) as LegacyExecutionStatus[])
      : undefined; // No default - return all statuses for API (unlike MCP which defaults to active)

    let dbStatuses: ReturnType<typeof mapLegacyStatusArray>["dbStatuses"] | undefined;
    let hasLockedFilter = false;
    let originalIncludedRunning = false;
    if (rawStatus) {
      const mapped = mapLegacyStatusArray(rawStatus);
      dbStatuses = mapped.dbStatuses;
      hasLockedFilter = mapped.hasLockedFilter;
      originalIncludedRunning = dbStatuses.includes("running");
      // If filtering by "locked", ensure "running" is included (locked = running + lock)
      if (hasLockedFilter && !originalIncludedRunning) {
        dbStatuses = [...dbStatuses, "running"];
      }
    }

    const workflowId = req.query.workflowId as string | undefined;
    const search = req.query.search as string | undefined;
    const sort = (req.query.sort as "createdAt" | "updatedAt") || "createdAt";
    const sortOrder = (req.query.sortOrder as "asc" | "desc") || "desc";
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 20), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    // Get executions with filters
    const result = await repository.listExecutionsWithFilters({
      userId: isAdmin ? undefined : userId, // Admins see all, users see only their own
      status: dbStatuses,
      workflowId,
      search,
      sort,
      sortOrder,
      limit,
      offset,
    });

    // Issue #421: Get workflow names for display
    const db = getDatabase();
    const workflows = await db
      .select({
        id: workflow.id,
        name: workflow.name,
      })
      .from(workflow);
    const workflowNameMap = new Map(workflows.map((w) => [w.id, w.name]));

    // Get active lock execution IDs for lock status enrichment
    const lockService = getLockService();
    const lockedExecutionIds = await lockService.getActiveExecutionIds();

    let enrichedExecutions = result.executions.map((exec: WorkflowExecution) => {
      const isLocked = exec.status === "running" && lockedExecutionIds.has(exec.executionId);
      return {
        executionId: exec.executionId,
        workflowId: exec.workflowId,
        // Issue #421: Include workflow name for UI display
        workflowName: workflowNameMap.get(exec.workflowId) || null,
        userId: exec.userId,
        status: isLocked ? ("locked" as const) : exec.status,
        currentNodeId: exec.currentNodeId,
        note: exec.note,
        createdAt: exec.createdAt,
        updatedAt: exec.updatedAt,
        completedAt: exec.completedAt,
        error: exec.error, // deprecated, use errors array
        hasActiveLock: isLocked,
        // Issue #386: Include error count for list view badge
        errorCount: exec.errors?.length ?? 0,
      };
    });

    // If filtering by "locked" only (not explicitly "running"), remove non-locked running execs
    let totalCount = result.total;
    if (hasLockedFilter && !originalIncludedRunning) {
      enrichedExecutions = enrichedExecutions.filter((e) => e.status !== "running");
      totalCount = enrichedExecutions.length;
    }

    res.json({
      success: true,
      data: {
        executions: enrichedExecutions,
        total: totalCount,
        limit,
        offset,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/executions/:id
 * Get execution detail with full context
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userInfo = (req as any).userInfo;
    const isAdmin = userInfo?.isAdmin || false;

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Permission check: user can only view own executions, admins see all
    if (!isAdmin && execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    // Issue #421: Resolve workflow name
    const db = getDatabase();
    const allWorkflows = await db.select({ id: workflow.id, name: workflow.name }).from(workflow);
    const workflowNameMap = new Map(allWorkflows.map((w) => [w.id, w.name]));

    // Lock enrichment for detail endpoint
    const lockService = getLockService();
    const activeLock = await lockService.getActiveLock(executionId);
    const isLocked = execution.status === "running" && activeLock !== null;

    res.json({
      success: true,
      data: {
        execution: {
          executionId: execution.executionId,
          workflowId: execution.workflowId,
          workflowName: workflowNameMap.get(execution.workflowId) || null,
          userId: execution.userId,
          status: isLocked ? ("locked" as const) : execution.status,
          currentNodeId: execution.currentNodeId,
          waitingForInputNodeId: execution.waitingForInputNodeId,
          note: execution.note,
          context: execution.globalContext,
          createdAt: execution.createdAt,
          updatedAt: execution.updatedAt,
          completedAt: execution.completedAt,
          error: execution.error, // deprecated, use errors array
          // Issue #386: Include full errors array for detail view
          errors: execution.errors ?? [],
          activeLock: activeLock
            ? {
                id: activeLock.id,
                nodeId: activeLock.nodeId,
                reason: activeLock.reason,
                status: activeLock.status,
                createdAt: activeLock.createdAt,
              }
            : null,
        },
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * PUT /api/executions/:id/context
 * Update execution context variables (only for waiting status)
 * Size validation handled by repository layer (max 10MB)
 */
router.put(
  "/:id/context",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (req as any).userId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userInfo = (req as any).userInfo;
    const isAdmin = userInfo?.isAdmin || false;
    const { variables, nodeStates, variablePath } = req.body;

    // Get execution
    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Permission check: user can only edit own executions, admins can edit all
    if (!isAdmin && execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    // Only allow editing for "running" status executions (Issue #386: "waiting" merged into "running")
    if (execution.status !== "running") {
      throw createApiError.badRequest(
        `Cannot edit context - execution is ${execution.status}. Only running executions can be edited.`,
        { executionId, status: execution.status },
      );
    }

    // Per-path update: set a value at any nesting path inside variables without overwriting
    // the rest of the object. Body: { variablePath: (string|number)[], value }.
    if (variablePath !== undefined) {
      if (!Array.isArray(variablePath) || variablePath.length === 0) {
        throw createApiError.validationFailed(
          "variablePath must be a non-empty array of path segments",
          { executionId },
        );
      }
      // Reject prototype-pollution segments (defense in depth; repository also guards).
      const forbidden = new Set(["__proto__", "constructor", "prototype"]);
      if (variablePath.some((seg) => typeof seg === "string" && forbidden.has(seg))) {
        throw createApiError.validationFailed("variablePath contains a forbidden segment", {
          executionId,
        });
      }
      const updatedByPath = await executionService.updateContextPath(
        executionId,
        userId,
        variablePath,
        req.body.value,
      );
      if (!updatedByPath) {
        throw createApiError.internal("Failed to update execution context", { executionId });
      }
      res.json({
        success: true,
        data: { executionId, updated: true },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate input
    if (!variables && !nodeStates) {
      throw createApiError.validationFailed(
        "At least one of variables or nodeStates must be provided",
        { executionId },
      );
    }

    // Update context via service (handles audit automatically)
    const updated = await executionService.updateContext(executionId, userId, {
      variables,
      nodeStates,
    });

    if (!updated) {
      throw createApiError.internal("Failed to update execution context", { executionId });
    }

    res.json({
      success: true,
      data: {
        executionId,
        updated: true,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/executions/:id/locks
 * List locks for user's own execution (all locks: active + historical)
 */
router.get(
  "/:id/locks",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;
    const userId = (req as AuthenticatedRequest).userId;
    const userInfo = (req as AuthenticatedRequest).userInfo;
    const isAdmin = userInfo?.isAdmin || false;

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Permission check: user can only view locks on own executions, admins see all
    if (!isAdmin && execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    const lockService = getLockService();
    const locks = await lockService.listLocks(executionId);

    res.json({
      success: true,
      data: {
        locks: locks.map((lock) => ({
          id: lock.id,
          nodeId: lock.nodeId,
          reason: lock.reason,
          lockedBy: lock.lockedBy,
          status: lock.status,
          // The PIN is stored hashed and shown only once at creation; it is never
          // returned here. Lost-PIN recovery is via owner/admin unlock (no PIN).
          createdAt: lock.createdAt,
          unlockedAt: lock.unlockedAt,
        })),
        total: locks.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/executions/:id/locks/:lockId/validate-pin
 * Submit PIN to validate and unlock a lock on user's own execution
 */
router.post(
  "/:id/locks/:lockId/validate-pin",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId, lockId } = req.params;
    const userId = (req as AuthenticatedRequest).userId;
    const userInfo = (req as AuthenticatedRequest).userInfo;
    const isAdmin = userInfo?.isAdmin || false;
    const { pin } = req.body;

    if (!pin || typeof pin !== "string") {
      throw createApiError.validationFailed("PIN is required", { executionId, lockId });
    }

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Permission check: user can only validate PIN on own executions, admins see all
    if (!isAdmin && execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    const lockService = getLockService();
    const lock = await lockService.getLock(lockId);

    if (!lock) {
      throw createApiError.notFound(`Lock '${lockId}' not found`, { executionId, lockId });
    }

    // Verify lock belongs to this execution
    if (lock.executionId !== executionId) {
      throw createApiError.badRequest("Lock does not belong to this execution", {
        executionId,
        lockId,
      });
    }

    const result = await lockService.validatePin(lockId, pin);

    res.json({
      success: true,
      data: {
        valid: result.valid,
        lockStatus: result.lockStatus,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/executions/:id/locks/:lockId/unlock
 * Owner unlock - execution owner can unlock without PIN via web UI
 */
router.post(
  "/:id/locks/:lockId/unlock",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId, lockId } = req.params;
    const userId = (req as AuthenticatedRequest).userId;

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Only the execution owner can unlock (not admin — admin has their own endpoint)
    if (execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    const lockService = getLockService();
    const lock = await lockService.getLock(lockId);

    if (!lock) {
      throw createApiError.notFound(`Lock '${lockId}' not found`, { executionId, lockId });
    }

    if (lock.executionId !== executionId) {
      throw createApiError.badRequest("Lock does not belong to this execution", {
        executionId,
        lockId,
      });
    }

    if (lock.status !== "active") {
      throw createApiError.badRequest(`Lock is already '${lock.status}', cannot unlock`, {
        executionId,
        lockId,
      });
    }

    await lockService.ownerUnlock(lockId, userId);

    res.json({
      success: true,
      data: { lockId, status: "unlocked", ownerUnlock: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/executions/:id/lock
 * Create a lock on user's own running execution via web UI
 */
router.post(
  "/:id/lock",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;
    const userId = (req as AuthenticatedRequest).userId;
    const { reason } = req.body as { reason?: string };

    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throw createApiError.badRequest("reason is required", { executionId });
    }

    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    if (execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    if (execution.status !== "running") {
      throw createApiError.badRequest(
        `Cannot lock execution with status '${execution.status}'. Only running executions can be locked.`,
        { executionId, status: execution.status },
      );
    }

    const lockService = getLockService();
    const existingLock = await lockService.getActiveLock(executionId);
    if (existingLock) {
      throw createApiError.badRequest("Execution already has an active lock", {
        executionId,
        existingLockId: existingLock.id,
      });
    }

    const nodeId = execution.currentNodeId ?? "web-lock";
    const result = await lockService.createLock({
      executionId,
      nodeId,
      reason: reason.trim(),
      lockedBy: userId,
    });

    res.json({
      success: true,
      data: { lockId: result.lockId, pin: result.pin, locked: true },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as executionRoutes };
