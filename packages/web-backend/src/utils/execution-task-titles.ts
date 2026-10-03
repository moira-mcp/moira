import { getDatabase, WorkflowRepository } from "@mcp-moira/shared";
import { resolveExecutionTaskTitle, type WorkflowExecution } from "@mcp-moira/workflow-engine";

/** Resolve headings for an already-authorized execution list, loading each owner's flows in bulk. */
export async function executionTaskTitles(
  executions: WorkflowExecution[],
): Promise<Map<string, string>> {
  const owners = new Map<string, WorkflowExecution[]>();
  for (const execution of executions) {
    const owned = owners.get(execution.userId) ?? [];
    owned.push(execution);
    owners.set(execution.userId, owned);
  }
  const workflows = new WorkflowRepository(getDatabase());
  const titles = new Map<string, string>();
  await Promise.all(
    [...owners].map(async ([ownerId, owned]) => {
      const graphs = await workflows.getManyForUser(
        [...new Set(owned.map((execution) => execution.workflowId))],
        ownerId,
      );
      for (const execution of owned) {
        const flow = graphs.get(execution.workflowId);
        if (flow) {
          titles.set(execution.executionId, resolveExecutionTaskTitle(flow.graph, execution));
        } else if (execution.taskIdentity) {
          titles.set(execution.executionId, execution.taskIdentity.title);
        }
      }
    }),
  );
  return titles;
}
