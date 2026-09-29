/**
 * The agent's open question to the person (`session await-user`) and when it stops being open.
 *
 * The question belongs to the node the run stood on when it was asked. It is cleared by who acts,
 * not by how the row is written: the agent's own next action (a step, accepted or refused, a
 * variable it sets, a recovery, an explicit resolve) clears it, a person's edit does not, and the run
 * leaving that node by any path — or finishing — clears it too, so the question never hangs on a step
 * it was not asked on. The database applies the same rule in SQL on each write; this module is the
 * rule for everything that holds the run in memory.
 */

import type { ExecutionAwaitingUser, WorkflowExecution } from "../types/base-types.js";

/** Limits of an agent's question: the question's length, how many choices, each choice's length. */
export const AWAITING_USER_LIMITS = { question: 500, options: 4, option: 200 } as const;

/** The question as it stands after the run moved to `next`: kept only while it stays on its node. */
export function awaitingUserAfterMove(
  awaiting: ExecutionAwaitingUser | null | undefined,
  next: Pick<WorkflowExecution, "status" | "currentNodeId">,
): ExecutionAwaitingUser | null {
  if (!awaiting) return null;
  if (next.status === "completed" || next.status === "failed") return null;
  return awaiting.nodeId === next.currentNodeId ? awaiting : null;
}
