import {
  ConflictError,
  getDatabase,
  getSqliteInstance,
  ExecutionRepository,
  ExecutionOverviewRepository,
  WorkflowRepository,
} from "@mcp-moira/shared";
import type { WorkflowExecution } from "@mcp-moira/workflow-engine";
import { readExecutionTaskTitles } from "../services/execution-overview.js";

type HeadingReference = Pick<WorkflowExecution, "executionId" | "workflowId" | "userId"> & {
  workflowName?: string | null;
  taskTitle?: string;
};

async function titleValues(
  executions: readonly HeadingReference[],
  check: () => void,
  snapshots?: readonly WorkflowExecution[],
): Promise<Map<string, string>> {
  const owners = new Map<string, string[]>();
  for (const execution of executions) {
    const owned = owners.get(execution.userId) ?? [];
    owned.push(execution.executionId);
    owners.set(execution.userId, owned);
  }
  const db = getDatabase();
  const deps = { executions: new ExecutionRepository(db), workflows: new WorkflowRepository(db) };
  const titles = await Promise.all(
    [...owners].map(([ownerId, ids]) =>
      readExecutionTaskTitles(ids, ownerId, deps, check, snapshots),
    ),
  );
  check();
  return new Map(titles.flatMap((values) => [...values]));
}

/** The existing generation guard includes the caller's native inventory/count/page read. */
async function coherentRead<T>(read: (check: () => void) => Promise<T>): Promise<T> {
  const overview = new ExecutionOverviewRepository(getSqliteInstance());
  for (let attempt = 0; ; attempt++) {
    const version = overview.readVersion();
    const check = () => {
      if (overview.readVersion() !== version)
        throw new ConflictError("Execution headings changed while reading; retry");
    };
    try {
      const result = await read(check);
      check();
      return result;
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= 3) throw error;
    }
  }
}

/** Resolve full authorized snapshots without replacing their identity or context from storage. */
export function executionTaskTitles(
  executions: readonly WorkflowExecution[],
): Promise<Map<string, string>> {
  return coherentRead((check) => titleValues(executions, check, executions));
}

/** Preserve every native wrapper field while returning its identity and heading from one generation. */
export function withExecutionTaskTitles<T extends { executions: readonly HeadingReference[] }>(
  read: () => T | Promise<T>,
): Promise<T> {
  return coherentRead(async (check) => {
    const data = await read();
    check();
    const titles = await titleValues(data.executions, check);
    return {
      ...data,
      executions: data.executions.map((execution) => ({
        ...execution,
        taskTitle:
          titles.get(execution.executionId) ??
          execution.taskTitle ??
          execution.workflowName ??
          "Workflow unavailable",
      })),
    };
  });
}
