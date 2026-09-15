/**
 * Recording what a step ran without.
 *
 * A playbook that cannot be read does not stop a step: the agent gets a visible placeholder. The
 * run must still carry the fact, otherwise a person reading it later sees an ordinary step and a
 * reference inside a materialized file leaves no trace at all.
 *
 * The recording lives here rather than in each handler because it is one rule: every node that
 * presents resolved text to an agent reports the same way.
 */

import type { IDataRepository } from "../interfaces/data-repository.js";
import type { UnresolvedPlaybookReference } from "./graph-template-processor.js";

/** Attach any unresolved playbook references from this presentation to the execution. */
export async function recordUnresolvedPlaybooks(
  unresolved: UnresolvedPlaybookReference[],
  nodeId: string,
  executionId: string,
  repository: IDataRepository,
): Promise<void> {
  if (unresolved.length === 0) return;

  await repository.appendError(executionId, {
    timestamp: Date.now(),
    nodeId,
    errorType: "degradation",
    message:
      `The step ran without ${unresolved.length === 1 ? "a playbook" : "playbooks"} it references: ` +
      unresolved.map((entry) => entry.reference).join(", "),
  });
}
