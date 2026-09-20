/**
 * A real Quick Task run for the specs that need a run with something to read: a recorded route,
 * a block that ran more than once, and a return transition on the diagram. It is driven through
 * the MCP tools exactly as an agent would drive it, so the projection the page renders is the
 * projection the product produces — not a fixture written to match the assertions.
 */

import {
  advanceWorkflowExecution,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../../utils/mcp-auth.js";

/** The workspace path the Quick Task steps are answered with. */
export const QUICK_TASK_WORKSPACE = "./moira-ws/quick-task-0000aaaa-0000-4000-8000-000000000000";

/** Drive a Quick Task through one rejected plan review into the second review: a real loop. */
export async function quickTaskWithRepairLoop(
  client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"],
): Promise<RunningWorkflowExecution> {
  const workspace = QUICK_TASK_WORKSPACE;
  const run = await startWorkflowExecutionState(client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  await advanceWorkflowExecution(client, run, {
    task_file: `${workspace}/task.md`,
    execution_file: `${workspace}/execution.md`,
    operating_mode: "autonomous",
    progress_scope_outcome: "Task contract captured",
  });
  await advanceWorkflowExecution(client, run, {
    current_plan_file: `${workspace}/plans/001/plan.md`,
    total_steps: 3,
    progress_plan_outcome: "Three-unit plan ready for review",
  });
  await advanceWorkflowExecution(client, run, {
    review_file: `${workspace}/plans/001/review.md`,
    issues_count: 1,
    progress_plan_outcome: "Plan review found a blocking issue",
  });
  await advanceWorkflowExecution(client, run, {
    current_plan_file: `${workspace}/plans/002/plan.md`,
    total_steps: 3,
    progress_plan_outcome: "Corrected plan replaced the rejected revision",
  });
  return run;
}
