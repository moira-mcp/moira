/**
 * Execution Management Routes
 * REST API endpoints for workflow execution viewing and context editing
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import {
  DatabaseRepository,
  WorkflowExecution,
  prepareExecutionVariablePathWrite,
  prepareExecutionVariableWrite,
  queryExecutionVariables,
} from "@mcp-moira/workflow-engine";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getLockService,
  mapLegacyStatusArray,
  LegacyExecutionStatus,
  workflow,
  getDatabase,
  isExecutionParentReference,
  logAuditEventDirect,
  AuditAction,
} from "@mcp-moira/shared";

const router = Router();

// Create repository instance (uses shared database singleton)
const repository = new DatabaseRepository();

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
    const authenticatedRequest = req as AuthenticatedRequest;
    const userId = authenticatedRequest.userId;
    const isAdmin = authenticatedRequest.userInfo?.isAdmin ?? false;

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
          parentExecutionId: execution.parentExecutionId ?? null,
          revision: execution.revision,
          reminders: execution.reminders ?? [],
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

router.get(
  "/:id/reminders",
  asyncHandler(async (req: Request, res: Response) => {
    const execution = await repository.getExecution(req.params.id);
    const userId = (req as AuthenticatedRequest).userId;
    if (!execution) throw createApiError.notFound("Execution not found");
    if (execution.userId !== userId) throw createApiError.unauthorized("Access denied");
    const status = req.query.status as "active" | "cancelled" | undefined;
    const search = String(req.query.search ?? "").toLowerCase();
    const reminders = (execution.reminders ?? []).filter(
      (item) =>
        (!status || item.status === status) &&
        (!search || item.text.toLowerCase().includes(search)),
    );
    res.json({
      success: true,
      data: { reminders, revision: execution.revision },
      timestamp: new Date().toISOString(),
    });
  }),
);

router.post(
  "/:id/reminders",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { text, idempotencyKey, expectedRevision } = req.body;
    if (!Number.isInteger(expectedRevision))
      throw createApiError.validationFailed("integer expectedRevision is required");
    const result = await repository.mutateExecutionReminder(
      req.params.id,
      userId,
      expectedRevision,
      { action: "add", text: typeof text === "string" ? text : "", idempotencyKey },
    );
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  }),
);

router.patch(
  "/:id/reminders/:reminderId",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { text, expectedRevision } = req.body;
    if (!Number.isInteger(expectedRevision))
      throw createApiError.validationFailed("integer expectedRevision is required");
    const result = await repository.mutateExecutionReminder(
      req.params.id,
      userId,
      expectedRevision,
      {
        action: "update",
        reminderId: req.params.reminderId,
        text: typeof text === "string" ? text : "",
      },
    );
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  }),
);

router.delete(
  "/:id/reminders/:reminderId",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const expectedRevision = Number(req.body.expectedRevision);
    if (!Number.isInteger(expectedRevision))
      throw createApiError.validationFailed("integer expectedRevision is required");
    const result = await repository.mutateExecutionReminder(
      req.params.id,
      userId,
      expectedRevision,
      { action: "cancel", reminderId: req.params.reminderId },
    );
    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  }),
);

router.get(
  "/:id/variables",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const execution = await repository.getExecution(req.params.id);
    if (!execution || execution.userId !== userId)
      throw createApiError.unauthorized("Access denied");
    const graph = await repository.getWorkflowGraph(execution.workflowId, userId);
    if (!graph) throw createApiError.notFound("Workflow not found");
    const result = queryExecutionVariables(execution, graph, {
      names: String(req.query.names ?? "")
        .split(",")
        .filter(Boolean),
      search: String(req.query.search ?? ""),
      types: String(req.query.types ?? "")
        .split(",")
        .filter(Boolean),
      editable: req.query.editable === undefined ? undefined : req.query.editable === "true",
      hasValue: req.query.hasValue === undefined ? undefined : req.query.hasValue === "true",
      writePhase:
        req.query.writePhase === "current" || req.query.writePhase === "other"
          ? req.query.writePhase
          : undefined,
    });
    res.json({
      success: true,
      data: result,
    });
  }),
);

router.put(
  "/:id/variables/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const execution = await repository.getExecution(req.params.id);
    if (!execution || execution.userId !== userId)
      throw createApiError.unauthorized("Access denied");
    const graph = await repository.getWorkflowGraph(execution.workflowId, userId);
    if (!graph) throw createApiError.notFound("Workflow not found");
    const updated = prepareExecutionVariableWrite(
      execution,
      graph,
      req.params.name,
      req.body.value,
      req.body.expectedRevision,
    );
    await repository.saveExecution(updated);
    await logAuditEventDirect(repository, {
      userId,
      action: AuditAction.EXECUTION_UPDATE_CONTEXT,
      resource: "execution",
      resourceId: req.params.id,
      source: "api",
      metadata: {
        action: "set-variable",
        variableName: req.params.name,
        revision: updated.revision,
      },
    });
    res.json({
      success: true,
      data: { name: req.params.name, value: req.body.value, revision: updated.revision },
    });
  }),
);

/**
 * POST /api/executions/:id/parent
 * Attach a same-owner running parent once, using optimistic concurrency.
 */
router.post(
  "/:id/parent",
  asyncHandler(async (req: Request, res: Response) => {
    const { id: executionId } = req.params;
    const userId = (req as AuthenticatedRequest).userId;
    const { parentExecutionId, expectedRevision } = req.body;
    if (typeof parentExecutionId !== "string" || !Number.isInteger(expectedRevision)) {
      throw createApiError.validationFailed(
        "parentExecutionId and integer expectedRevision are required",
        { executionId },
      );
    }
    if (!isExecutionParentReference(parentExecutionId)) {
      throw createApiError.validationFailed('parentExecutionId must be a UUID or "none"', {
        executionId,
      });
    }
    const updated = await repository.setExecutionParent(
      executionId,
      parentExecutionId === "none" ? null : parentExecutionId,
      userId,
      expectedRevision,
    );
    res.json({
      success: true,
      data: {
        executionId,
        parentExecutionId: updated.parentExecutionId ?? null,
        revision: updated.revision,
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
    const userId = (req as AuthenticatedRequest).userId;
    const { variables, nodeStates, variablePath, expectedRevision } = req.body;

    // Get execution
    const execution = await repository.getExecution(executionId);

    if (!execution) {
      throw createApiError.notFound(`Execution '${executionId}' not found`, { executionId });
    }

    // Parent linkage and execution policy grant no authority. This owner route never elevates an
    // administrator into another user's workflow execution.
    if (execution.userId !== userId) {
      throw createApiError.unauthorized("Access denied - not your execution", { executionId });
    }

    // Only allow editing for "running" status executions (Issue #386: "waiting" merged into "running")
    if (execution.status !== "running") {
      throw createApiError.badRequest(
        `Cannot edit context - execution is ${execution.status}. Only running executions can be edited.`,
        { executionId, status: execution.status },
      );
    }
    if (!Number.isInteger(expectedRevision)) {
      throw createApiError.validationFailed("integer expectedRevision is required", {
        executionId,
      });
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
      const graph = await repository.getWorkflowGraph(execution.workflowId, userId);
      if (!graph) throw createApiError.notFound("Workflow not found");
      const updated = prepareExecutionVariablePathWrite(
        execution,
        graph,
        variablePath,
        req.body.value,
        expectedRevision,
      );
      await repository.saveExecution(updated);
      const variablePathText = variablePath
        .map((segment, index) =>
          typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
        )
        .join("");
      await logAuditEventDirect(repository, {
        userId,
        action: AuditAction.EXECUTION_UPDATE_CONTEXT,
        resource: "execution",
        resourceId: executionId,
        source: "api",
        metadata: {
          action: "set-variable-path",
          variablePath: variablePathText,
          revision: updated.revision,
        },
      });
      res.json({
        success: true,
        data: { executionId, updated: true, revision: updated.revision },
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

    throw createApiError.badRequest(
      "Arbitrary variables/nodeStates mutation is disabled; use the policy-governed variable API",
    );
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
