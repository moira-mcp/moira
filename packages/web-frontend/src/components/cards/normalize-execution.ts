/**
 * Execution normalizer
 * Maps the user and admin execution list items to a single normalized shape
 */

export interface NormalizedExecution {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  status: string;
  note?: string;
  errorCount?: number;
  error?: string;
  /**
   * Admin views only: who owns the execution. `null` when it has an owner whose account can no
   * longer be found; the card words that in the reader's language.
   */
  userDisplay?: string | null;
  createdAt?: number;
  completedAt?: number;
  duration?: number | null;
  hasActiveLock?: boolean;
}

interface ExecutionListItem {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  status: string;
  note?: string;
  createdAt?: number;
  completedAt?: number;
  error?: string;
  errorCount?: number;
  hasActiveLock?: boolean;
}

interface AdminExecution {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  userEmail: string | null;
  userName: string | null;
  status: string;
  createdAt?: number;
  completedAt?: number;
  error?: string;
  hasActiveLock?: boolean;
}

type AnyExecution = ExecutionListItem | AdminExecution;

function isAdminExecution(e: AnyExecution): e is AdminExecution {
  return "userEmail" in e;
}

export function normalizeExecution(execution: AnyExecution): NormalizedExecution {
  if (isAdminExecution(execution)) {
    return {
      id: execution.executionId,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      status: execution.status,
      userDisplay: execution.userName || execution.userEmail || null,
      createdAt: execution.createdAt,
      completedAt: execution.completedAt,
      error: execution.error,
      hasActiveLock: execution.hasActiveLock,
    };
  }

  return {
    id: execution.executionId,
    workflowId: execution.workflowId,
    workflowName: execution.workflowName,
    status: execution.status,
    note: execution.note,
    errorCount: execution.errorCount,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt,
    error: execution.error,
    hasActiveLock: execution.hasActiveLock,
  };
}
