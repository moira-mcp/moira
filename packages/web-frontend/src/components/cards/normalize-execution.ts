/**
 * Execution normalizer
 * Maps the user and admin execution list items to a single normalized shape
 */

import type { ExecutionTaskIdentity } from "@mcp-moira/shared";

export interface NormalizedExecution {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  taskTitle?: string;
  status: string;
  stopReason?: string | null;
  note?: string | null;
  errorCount?: number;
  error?: string;
  /**
   * Admin views only: who owns the execution. `null` when it has an owner whose account can no
   * longer be found; the card words that in the reader's language.
   */
  userDisplay?: string | null;
  createdAt?: number | null;
  lastStepAt?: number | null;
  completedAt?: number;
  duration?: number | null;
  hasActiveLock?: boolean;
}

interface ExecutionListItem {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  taskTitle?: string;
  taskIdentity?: ExecutionTaskIdentity | null;
  status: string;
  stopReason?: string | null;
  note?: string | null;
  createdAt?: number | null;
  lastStepAt?: number | null;
  completedAt?: number;
  error?: string;
  errorCount?: number;
  hasActiveLock?: boolean;
}

interface AdminExecution {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  taskTitle?: string;
  taskIdentity?: ExecutionTaskIdentity | null;
  userEmail: string | null;
  userName: string | null;
  status: string;
  stopReason?: string | null;
  createdAt?: number | null;
  lastStepAt?: number | null;
  note?: string | null;
  errorCount?: number;
  completedAt?: number;
  error?: string;
  hasActiveLock?: boolean;
}

type AnyExecution = ExecutionListItem | AdminExecution;

function isAdminExecution(e: AnyExecution): e is AdminExecution {
  return "userEmail" in e;
}

export function normalizeExecution(execution: AnyExecution): NormalizedExecution {
  const taskTitle =
    execution.taskTitle ??
    execution.taskIdentity?.title ??
    execution.workflowName ??
    execution.workflowId;
  if (isAdminExecution(execution)) {
    return {
      id: execution.executionId,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      taskTitle,
      status: execution.status,
      stopReason: execution.stopReason,
      userDisplay: execution.userName || execution.userEmail || null,
      createdAt: execution.createdAt,
      lastStepAt: execution.lastStepAt,
      note: execution.note,
      errorCount: execution.errorCount,
      completedAt: execution.completedAt,
      error: execution.error,
      hasActiveLock: execution.hasActiveLock,
    };
  }

  return {
    id: execution.executionId,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    taskTitle,
    status: execution.status,
    stopReason: execution.stopReason,
    note: execution.note,
    errorCount: execution.errorCount,
    createdAt: execution.createdAt,
    lastStepAt: execution.lastStepAt,
    completedAt: execution.completedAt,
    error: execution.error,
    hasActiveLock: execution.hasActiveLock,
  };
}
