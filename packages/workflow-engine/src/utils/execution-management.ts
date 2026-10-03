import {
  executionManagementFields,
  type ExecutionManagementFields,
} from "@mcp-moira/shared/execution-management";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type { WorkflowExecution } from "../types/base-types.js";

/** Reuse already-read execution facts; the only extra native payload is the executing IDs. */
export async function readExecutionManagement(
  repository: IDataRepository,
  executions: readonly WorkflowExecution[],
  actorId: string,
  lockedIds: ReadonlySet<string>,
): Promise<Map<string, ExecutionManagementFields>> {
  const executing = new Set(
    await repository.getExecutingExecutionIds(executions.map((execution) => execution.executionId)),
  );
  return new Map(
    executions.map((execution) => [
      execution.executionId,
      executionManagementFields(
        {
          status: execution.status,
          revision: execution.revision,
          userId: execution.userId,
          stopReason: execution.stopReason ?? null,
          hasExecutingAttempt: executing.has(execution.executionId),
          hasActiveLock: lockedIds.has(execution.executionId),
          gateWaiting: Boolean(execution.gateWaiting),
          awaitingUser: execution.awaitingUser != null,
        },
        actorId,
      ),
    ]),
  );
}
