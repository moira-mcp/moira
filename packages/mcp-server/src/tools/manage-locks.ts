/**
 * MCP Tool: Manage Locks
 * View and manage execution locks with action-based routing.
 * Actions: status, list, unlock, lock (create)
 */

import { z } from "zod";
import { ToolResult } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  getLockService,
  logAuditEventDirect,
  AuditAction,
  createLogger,
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "ManageLocks" });

export const manageLocksSchema = z.object({
  action: z.enum(["status", "list", "unlock", "lock"]).describe("Action to perform on locks"),
  executionId: z.string().describe("Execution ID (required for all actions)"),
  pin: z.string().optional().describe("PIN code to unlock (required for unlock action)"),
  reason: z
    .string()
    .optional()
    .describe("Reason for locking the execution (required for lock action)"),
});

type ManageLocksParams = z.infer<typeof manageLocksSchema>;

interface LockInfo {
  lockId: string;
  executionId: string;
  nodeId: string;
  reason: string;
  status: "active" | "unlocked";
  createdAt: string;
  unlockedAt: string | null;
}

type LockData =
  | { locked: boolean; lock?: LockInfo }
  | { locks: LockInfo[]; total: number }
  | { unlocked: boolean; lockId: string }
  | { lockId: string; locked: true };

export async function manageLocks(params: ManageLocksParams): Promise<ToolResult<LockData>> {
  try {
    const { userId } = getUserContext();
    const lockService = getLockService();
    const repository = new DatabaseRepository();
    const { action, executionId } = params;

    if (!executionId) {
      return {
        success: false,
        error: "executionId is required",
      };
    }

    // Verify execution exists and belongs to user
    const execution = await repository.getExecution(executionId);
    if (!execution) {
      return {
        success: false,
        error: `Execution '${executionId}' not found`,
      };
    }
    if (execution.userId !== userId) {
      return {
        success: false,
        error: `Access denied: execution belongs to another user`,
      };
    }

    switch (action) {
      case "status": {
        const activeLock = await lockService.getActiveLock(executionId);

        await logAuditEventDirect(repository, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "lock",
          resourceId: executionId,
          source: "mcp",
          metadata: { action: "lock_status", hasLock: !!activeLock },
        });

        if (!activeLock) {
          return {
            success: true,
            data: { locked: false },
          };
        }

        return {
          success: true,
          data: {
            locked: true,
            lock: {
              lockId: activeLock.id,
              executionId: activeLock.executionId,
              nodeId: activeLock.nodeId,
              reason: activeLock.reason,
              status: activeLock.status,
              createdAt: activeLock.createdAt.toISOString(),
              unlockedAt: activeLock.unlockedAt?.toISOString() ?? null,
            },
          },
        };
      }

      case "list": {
        const locks = await lockService.listLocks(executionId);

        await logAuditEventDirect(repository, {
          userId,
          action: AuditAction.MCP_SESSION_INFO,
          resource: "lock",
          resourceId: executionId,
          source: "mcp",
          metadata: { action: "lock_list", count: locks.length },
        });

        return {
          success: true,
          data: {
            locks: locks.map((lock) => ({
              lockId: lock.id,
              executionId: lock.executionId,
              nodeId: lock.nodeId,
              reason: lock.reason,
              status: lock.status,
              createdAt: lock.createdAt.toISOString(),
              unlockedAt: lock.unlockedAt?.toISOString() ?? null,
            })),
            total: locks.length,
          },
        };
      }

      case "unlock": {
        if (!params.pin) {
          return {
            success: false,
            error: "PIN is required for unlock action",
          };
        }

        const activeLock = await lockService.getActiveLock(executionId);
        if (!activeLock) {
          return {
            success: false,
            error: `No active lock found for execution '${executionId}'`,
          };
        }

        const result = await lockService.validatePin(activeLock.id, params.pin);
        if (!result.valid) {
          return {
            success: false,
            error: "Invalid PIN",
          };
        }

        return {
          success: true,
          data: {
            unlocked: true,
            lockId: activeLock.id,
          },
        };
      }

      case "lock": {
        if (!params.reason) {
          return {
            success: false,
            error: "reason is required for lock action",
          };
        }

        if (execution.status !== "running") {
          return {
            success: false,
            error: `Cannot lock execution with status '${execution.status}'. Only running executions can be locked.`,
          };
        }

        // Check if already locked
        const existingLock = await lockService.getActiveLock(executionId);
        if (existingLock) {
          return {
            success: false,
            error: `Execution already has an active lock (lockId: ${existingLock.id})`,
          };
        }

        const nodeId = execution.currentNodeId ?? "agent-lock";

        const lockResult = await lockService.createLock({
          executionId,
          nodeId,
          reason: params.reason,
          lockedBy: userId,
        });

        return {
          success: true,
          data: {
            lockId: lockResult.lockId,
            locked: true,
          },
        };
      }

      default: {
        return {
          success: false,
          error: `Unknown action: ${action}`,
        };
      }
    }
  } catch (error) {
    const appError = normalizeError(error);
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Lock management failed", appError, {
      code: appError.code,
      isOperational: appError.isOperational,
    });
    return {
      success: false,
      error: appError.message,
    };
  }
}
