/**
 * Get Session Info MCP Tool
 * Consolidated tool for session-related information with action-based routing
 * Replaces: get_current_user, list_active_executions, get_execution_context, get_current_step
 */

import { z } from "zod";
import { ToolResult } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  getDatabase,
  ExecutionError,
  mapLegacyStatusArray,
  LegacyExecutionStatus,
  ExecutionStatusResponse,
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
  getLockService,
} from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../core/mcp-engine.js";
import { ERRORS, formatDomainError } from "../messages/index.js";

const logger = createLogger({ component: "GetSessionInfo" });

const GetSessionInfoParamsSchema = z.object({
  action: z
    .enum(["user", "executions", "execution_context", "current_step", "update-note"])
    .describe("Action to perform"),
  executionId: z
    .string()
    .optional()
    .describe(
      "Execution ID (required for execution_context, current_step, and update-note actions)",
    ),
  // Parameters for executions action
  // Issue #386: 2-status model - "running" (active) and "completed" (finished)
  // Old values "waiting" and "failed" accepted for backward compatibility (mapped to new values)
  status: z
    .array(z.enum(["running", "waiting", "completed", "failed", "locked"]))
    .optional()
    .describe('Filter by status (default: ["running"] for active only)'),
  workflowId: z.string().optional().describe("Filter by workflow ID"),
  search: z.string().optional().describe("Search in note field"),
  sort: z.enum(["createdAt", "updatedAt"]).optional().describe("Sort field (default: createdAt)"),
  sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results (default: 20, max: 100)"),
  offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
  // Parameters for update-note action
  note: z
    .string()
    .max(500)
    .optional()
    .describe("New note value (max 500 chars, required for update-note action)"),
  // Parameters for execution_context action
  variables: z
    .array(z.string())
    .optional()
    .describe(
      "Filter context.variables to only include these variable names (execution_context action)",
    ),
});

type GetSessionInfoParams = z.infer<typeof GetSessionInfoParamsSchema>;

interface UserInfo {
  email: string;
  name: string | null;
}

interface ExecutionItem {
  executionId: string;
  workflowId: string;
  workflowSlug: string;
  workflowOwnerHandle: string;
  status: ExecutionStatusResponse | "waiting" | "failed";
  currentNodeId: string | null;
  note?: string | null;
  parentExecutionId?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Number of errors in errors array (for list view badge) */
  errorCount?: number;
}

interface ExecutionsResponse {
  executions: ExecutionItem[];
  total: number;
}

interface ExecutionContextData {
  executionId: string;
  workflowId: string;
  workflowSlug: string;
  workflowOwnerHandle: string;
  status: ExecutionStatusResponse | "waiting" | "failed";
  currentNodeId: string | null;
  waitingForInputNodeId: string | null;
  note?: string | null;
  context: {
    variables: Record<string, unknown>;
    nodeStates: Record<string, unknown>;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** @deprecated Use errors array instead */
  error?: string;
  /** Persistent error log (Issue #386) */
  errors?: ExecutionError[];
  activeLock?: {
    lockId: string;
    reason?: string;
    lockedAt: string;
  };
}

interface NoteUpdateResult {
  executionId: string;
  note: string;
  message: string;
}

type SessionInfoData =
  | UserInfo
  | ExecutionsResponse
  | ExecutionContextData
  | NoteUpdateResult
  | string;

export async function getSessionInfo(
  params: GetSessionInfoParams,
): Promise<ToolResult<SessionInfoData>> {
  try {
    const { action, executionId } = params;
    const { userId } = getUserContext();

    switch (action) {
      case "user": {
        const db = getDatabase();
        const user = await db.query.user.findFirst({
          where: (user, { eq }) => eq(user.id, userId),
          columns: {
            id: true,
            email: true,
            name: true,
          },
        });

        if (!user) {
          return {
            success: false,
            error: ERRORS.user_not_found(userId),
          };
        }

        // Audit log for session info read
        const auditRepo = new DatabaseRepository();
        await logAuditEventDirect(auditRepo, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "session",
          resourceId: userId,
          source: "mcp",
          metadata: { action: "user" },
        });

        return {
          success: true,
          data: {
            email: user.email,
            name: user.name,
          },
        };
      }

      case "executions": {
        const repository = new DatabaseRepository();

        // Default to active status if not specified
        // Issue #386: 2-status model - "running" is the only active status now
        // Old clients may send "failed" or "waiting" - map to new status values
        const rawStatusFilter = params.status ?? ["running"];
        const { dbStatuses, hasLockedFilter } = mapLegacyStatusArray(
          rawStatusFilter as LegacyExecutionStatus[],
        );

        // If filtering by "locked", ensure "running" is included (locked = running + lock)
        const statusFilter =
          hasLockedFilter && !dbStatuses.includes("running")
            ? [...dbStatuses, "running" as const]
            : dbStatuses;

        const result = await repository.listExecutionsWithFilters({
          userId,
          status: statusFilter,
          workflowId: params.workflowId,
          search: params.search,
          sort: params.sort ?? "updatedAt", // Default: last updated first
          sortOrder: params.sortOrder ?? "desc",
          limit: params.limit ?? 20,
          offset: params.offset ?? 0,
        });

        // Get active lock execution IDs for lock status enrichment
        const lockService = getLockService();
        const lockedExecutionIds = await lockService.getActiveExecutionIds();

        // Batch fetch workflow info for all unique workflow IDs
        const uniqueWorkflowIds = [...new Set(result.executions.map((e) => e.workflowId))];
        const workflowInfoMap = new Map<string, { slug: string; ownerHandle: string }>();

        // Fetch workflow info in parallel
        await Promise.all(
          uniqueWorkflowIds.map(async (wfId) => {
            const workflowInfo = await repository.getWorkflow(wfId, userId);
            if (workflowInfo) {
              workflowInfoMap.set(wfId, {
                slug: workflowInfo.slug,
                ownerHandle: workflowInfo.ownerHandle,
              });
            }
          }),
        );

        let executionsList: ExecutionItem[] = result.executions.map((exec) => {
          const wfInfo = workflowInfoMap.get(exec.workflowId);
          const isLocked = exec.status === "running" && lockedExecutionIds.has(exec.executionId);
          return {
            executionId: exec.executionId,
            workflowId: exec.workflowId,
            workflowSlug: wfInfo?.slug ?? exec.workflowId, // Fallback to ID if workflow not found
            workflowOwnerHandle: wfInfo?.ownerHandle ?? "unknown",
            status: isLocked ? "locked" : exec.status,
            currentNodeId: exec.currentNodeId,
            note: exec.note,
            parentExecutionId: exec.parentExecutionId,
            createdAt: new Date(exec.createdAt).toISOString(),
            updatedAt: new Date(exec.updatedAt).toISOString(),
            completedAt: exec.completedAt ? new Date(exec.completedAt).toISOString() : undefined,
            // Issue #386: Include error count for list view
            errorCount: exec.errors?.length ?? 0,
          };
        });

        // If filtering by "locked", keep only locked executions
        let totalCount = result.total;
        if (hasLockedFilter && dbStatuses.length === 0) {
          // Only "locked" was requested — filter to locked only
          executionsList = executionsList.filter((e) => e.status === "locked");
          totalCount = executionsList.length;
        } else if (hasLockedFilter) {
          // "locked" + other statuses — keep all (locked are already enriched)
        }

        // Audit log for executions list
        await logAuditEventDirect(repository, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "execution",
          resourceId: "list",
          source: "mcp",
          metadata: {
            action: "executions",
            resultCount: executionsList.length,
          },
        });

        return {
          success: true,
          data: {
            executions: executionsList,
            total: totalCount,
          },
        };
      }

      case "execution_context": {
        if (!executionId) {
          return {
            success: false,
            error: ERRORS.execution_id_required("execution_context"),
          };
        }

        const repository = MCPEngine.getInstance().repository;
        const execution = await repository.getExecution(executionId);

        if (!execution) {
          return {
            success: false,
            error: ERRORS.execution_not_found(executionId),
          };
        }

        if (execution.userId !== userId) {
          return {
            success: false,
            error: ERRORS.execution_access_denied,
          };
        }

        // Filter variables if specified
        let filteredVariables = execution.globalContext.variables;
        if (params.variables && params.variables.length > 0) {
          filteredVariables = {};
          for (const varName of params.variables) {
            if (varName in execution.globalContext.variables) {
              filteredVariables[varName] = execution.globalContext.variables[varName];
            }
          }
        }

        // Fetch workflow info for slug and owner handle
        const workflowInfo = await repository.getWorkflow(execution.workflowId, userId);

        // Check if execution is locked
        const lockServiceCtx = getLockService();
        const activeLockCtx = await lockServiceCtx.getActiveLock(execution.executionId);
        const isLockedCtx = execution.status === "running" && activeLockCtx !== null;

        const contextData: ExecutionContextData = {
          executionId: execution.executionId,
          workflowId: execution.workflowId,
          workflowSlug: workflowInfo?.slug ?? execution.workflowId,
          workflowOwnerHandle: workflowInfo?.ownerHandle ?? "unknown",
          status: isLockedCtx ? "locked" : execution.status,
          currentNodeId: execution.currentNodeId,
          waitingForInputNodeId: execution.waitingForInputNodeId || null,
          note: execution.note,
          context: {
            variables: filteredVariables,
            nodeStates: execution.globalContext.nodeStates,
          },
          createdAt: new Date(execution.createdAt).toISOString(),
          updatedAt: new Date(execution.updatedAt).toISOString(),
          completedAt: execution.completedAt
            ? new Date(execution.completedAt).toISOString()
            : undefined,
          error: execution.error,
          // Issue #386: Include errors array
          errors: execution.errors ?? [],
          ...(activeLockCtx
            ? {
                activeLock: {
                  lockId: activeLockCtx.id,
                  reason: activeLockCtx.reason ?? undefined,
                  lockedAt: new Date(activeLockCtx.createdAt).toISOString(),
                },
              }
            : {}),
        };

        // Audit log for execution context read
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "execution",
          resourceId: executionId,
          source: "mcp",
          metadata: {
            action: "execution_context",
            variablesFilter: params.variables,
          },
        });

        return {
          success: true,
          data: contextData,
        };
      }

      case "current_step": {
        if (!executionId) {
          return {
            success: false,
            error: ERRORS.execution_id_required("current_step"),
          };
        }

        const repository = MCPEngine.getInstance().repository;
        const execution = await repository.getExecution(executionId);

        if (!execution) {
          return {
            success: false,
            error: ERRORS.execution_not_found(executionId),
          };
        }

        if (execution.userId !== userId) {
          return {
            success: false,
            error: ERRORS.access_denied_to_execution,
          };
        }

        // Issue #386: 2-status model - "running" means active and can accept input
        if (execution.status !== "running") {
          return {
            success: false,
            error: ERRORS.execution_not_waiting(execution.status),
          };
        }

        const formattedText = await MCPEngine.getInstance().executeStep(executionId, undefined);

        // Audit log for current step read
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "execution",
          resourceId: executionId,
          source: "mcp",
          metadata: { action: "current_step" },
        });

        return {
          success: true,
          data: formattedText,
        };
      }

      case "update-note": {
        if (!executionId) {
          return {
            success: false,
            error: ERRORS.execution_id_required("update-note"),
          };
        }

        if (params.note === undefined) {
          return {
            success: false,
            error: "Note is required for update-note action",
          };
        }

        const repository = MCPEngine.getInstance().repository;
        const execution = await repository.getExecution(executionId);

        if (!execution) {
          return {
            success: false,
            error: ERRORS.execution_not_found(executionId),
          };
        }

        if (execution.userId !== userId) {
          return {
            success: false,
            error: ERRORS.execution_access_denied,
          };
        }

        // Update the note
        await repository.updateExecutionNote(executionId, params.note);

        // Audit log for note update
        await logAuditEventDirect(repository as DatabaseRepository, {
          userId,
          action: AuditAction.EXECUTION_UPDATE_CONTEXT,
          resource: "execution",
          resourceId: executionId,
          source: "mcp",
          metadata: { action: "update-note" },
        });

        return {
          success: true,
          data: {
            executionId,
            note: params.note,
            message: "Note updated successfully",
          },
        };
      }

      default:
        return {
          success: false,
          error: ERRORS.unknown_action(action),
        };
    }
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to get session info", appError, {
      action: params.action,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Use domain error formatting which handles slug/handle errors with proper codes
    return {
      success: false,
      error: formatDomainError(error),
    };
  }
}

export const getSessionInfoSchema = GetSessionInfoParamsSchema;
