/**
 * Execution normalizer
 * Maps 3 different execution interfaces to a single normalized shape
 */

export interface NormalizedExecution {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  status: string;
  note?: string;
  errorCount?: number;
  error?: string;
  userDisplay?: string;
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
  userEmail: string;
  userName: string | null;
  status: string;
  createdAt?: number;
  completedAt?: number;
  error?: string;
  hasActiveLock?: boolean;
}

interface RecentExecution {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  note?: string | null;
  status: string;
  startTime: string;
  endTime?: string;
  duration: number | null;
}

type AnyExecution = ExecutionListItem | AdminExecution | RecentExecution;

function isRecentExecution(e: AnyExecution): e is RecentExecution {
  return "startTime" in e && "id" in e && !("executionId" in e);
}

function isAdminExecution(e: AnyExecution): e is AdminExecution {
  return "userEmail" in e;
}

export function normalizeExecution(execution: AnyExecution): NormalizedExecution {
  if (isRecentExecution(execution)) {
    return {
      id: execution.id,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      note: execution.note ?? undefined,
      status: execution.status,
      createdAt: new Date(execution.startTime).getTime(),
      completedAt: execution.endTime ? new Date(execution.endTime).getTime() : undefined,
      duration: execution.duration,
    };
  }

  if (isAdminExecution(execution)) {
    return {
      id: execution.executionId,
      workflowId: execution.workflowId,
      workflowName: execution.workflowName,
      status: execution.status,
      userDisplay: execution.userName || execution.userEmail,
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
