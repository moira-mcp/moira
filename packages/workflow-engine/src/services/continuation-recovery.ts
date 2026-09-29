import type { IDataRepository } from "../interfaces/data-repository.js";
import type { ExecutionContext, WorkflowExecution } from "../types/base-types.js";
import { PAUSING_NODE_TYPES } from "../utils/execution-visits.js";
import { validateDeclaredRegistryValues } from "../utils/registry-value-validator.js";
import { humanGateWaiting } from "../utils/human-gate.js";
import {
  diagnoseContinuation,
  missingExpressionVariables,
  unresolvedReferences,
} from "./continuation-diagnosis.js";
import type { ContinuationDiagnosis } from "./continuation-diagnosis.js";
import { ExecutionMutationCoordinator } from "./execution-mutation-coordinator.js";

/**
 * Return a genuinely broken run to a step it can resume from.
 *
 * Recovery moves the run to a node the caller names, merges the variable values the caller supplies,
 * and installs a fresh attempt bound to the current definition in the same guarded write — so the
 * caller's next action is an ordinary `step()`, and the run holds a usable attempt from the moment it
 * moves, whatever happens to the rendering that follows.
 *
 * The run then comes to rest on the named node and never advances past it. It is not, however, true
 * that nothing runs: the target node's own presentation path executes, which for three of the five
 * resumable types is inert but for the other two is not. Resuming at a `lock` node creates the lock
 * and dispatches its approval code; resuming at a `subgraph` node with no active child enters one.
 * Both are what those nodes do when a run arrives at them, and an operator choosing either as a
 * recovery target is choosing that effect.
 */

/**
 * Node types a run can wait on, and therefore the only ones recovery may resume at. Derived from the
 * handlers that ask the engine to pause: agent-directive, teleport, materialize, lock and subgraph.
 * Anything else — a condition, an expression, an end — does not hold a presentation, so resuming
 * "at" it would mean executing the graph forward from there and calling that a repair; recovery
 * refuses instead. A type wrongly absent from this list refuses a legitimate target loudly, which is
 * the safe direction for a list that governs what a mutation may touch.
 *
 * An extension node pauses only when its call fails, and a node error pauses on whatever node raised
 * it. Neither is a place an operator chooses to resume at, so neither is offered here.
 */
const RESUMABLE_NODE_TYPES = PAUSING_NODE_TYPES;

/**
 * The statuses a run can hold and still be something recovery may act on. The engine stores only
 * `running` and `completed`; `waiting` is here because the diagnosis treats it as live too, and one
 * definition of "live" across the two is worth more than a shorter list.
 */
const LIVE_EXECUTION_STATUSES = new Set(["running", "waiting"]);

/**
 * The gate is the security boundary, and it asks two separate questions.
 *
 * **Is this a run recovery may touch at all?** A completed run is history and a cancelled run is the
 * owner's deliberate instruction to stop — cancellation is stored as completion, so the two are one
 * state here. Neither is broken, and returning either to `running` at an operator-named node would be
 * resurrection rather than repair, with none of cancellation's authority behind it. Both are refused
 * before anything else is considered.
 *
 * **Is this run actually broken?** Decided by the diagnosis reporting at least one **blocking**
 * cause, which is the same judgement `diagnose` publishes: the gate and the explanation cannot
 * disagree, because there is only one of them. A healthy run — and a run whose only causes explain
 * something without standing in its way, such as a recorded error from an earlier rejected answer —
 * is refused, so recovery cannot be used to rewrite valid executions or skip steps.
 *
 * The two questions stay separate on purpose. Status is never read as evidence that a run is or is
 * not broken; a terminal run is still diagnosed, and still told why it cannot continue. What status
 * decides is only whether the mutation is permitted, which is why the run's own status being a
 * blocking diagnostic cause is not enough to make it eligible.
 */
export type ContinuationRecoveryRefusal =
  /** The run is over — completed or cancelled — so there is nothing to repair. */
  | { kind: "execution_terminal"; status: string }
  /** Nothing blocks this run; recovery must not touch it. */
  | { kind: "run_not_broken"; diagnosis: ContinuationDiagnosis }
  /** The workflow definition is gone, so there is no node to resume from. */
  | { kind: "workflow_unavailable"; workflowId: string }
  /** The named node is not in the current definition. */
  | { kind: "unknown_node"; nodeId: string; availableNodeIds: string[] }
  /** The named node exists but is not one a run can wait on, so resuming there would run the graph. */
  | { kind: "node_not_resumable"; nodeId: string; nodeType: string; resumableNodeIds: string[] }
  /** The target would be presented with references the context still cannot resolve. */
  | { kind: "missing_variables"; nodeId: string; references: string[] }
  /** Supplied values violate a declared variable's schema. */
  | { kind: "invalid_variable_values"; message: string }
  /** Another caller is executing the current attempt, or its outcome is unknown. */
  | { kind: "attempt_in_progress" }
  /** The execution changed under the caller between reading it and recovering it. */
  | { kind: "execution_changed" };

export interface ContinuationRecoveryResult {
  executionId: string;
  nodeId: string;
  /** The rendered presentation of the target node, carrying the fresh Step attempt ID. */
  presentation: string;
  /**
   * The variable names this recovery merged into the execution context — every name the caller
   * supplied, whether or not the value differed from the one already there. It is what was written,
   * not a diff of what changed.
   */
  appliedVariables: string[];
}

export type ContinuationRecoveryOutcome =
  | { outcome: "recovered"; result: ContinuationRecoveryResult }
  | { outcome: "refused"; refusal: ContinuationRecoveryRefusal };

function mergedContext(
  execution: WorkflowExecution,
  variables: Record<string, unknown>,
): ExecutionContext {
  return {
    ...execution.globalContext,
    variables: { ...(execution.globalContext?.variables ?? {}), ...variables },
  };
}

export async function recoverContinuation(
  repository: IDataRepository,
  execution: WorkflowExecution,
  nodeId: string,
  variables: Record<string, unknown>,
  presentCurrentNode: (executionId: string) => Promise<string>,
): Promise<ContinuationRecoveryOutcome> {
  if (!LIVE_EXECUTION_STATUSES.has(execution.status)) {
    return {
      outcome: "refused",
      refusal: { kind: "execution_terminal", status: execution.status },
    };
  }

  const attempt = await repository.getCurrentExecutionAttempt(
    execution.executionId,
    execution.userId,
  );
  const diagnosis = await diagnoseContinuation(repository, execution, attempt);
  if (!diagnosis.causes.some((cause) => cause.blocks)) {
    return { outcome: "refused", refusal: { kind: "run_not_broken", diagnosis } };
  }

  const graph = await repository.getWorkflowGraph(execution.workflowId, execution.userId);
  if (!graph) {
    return {
      outcome: "refused",
      refusal: { kind: "workflow_unavailable", workflowId: execution.workflowId },
    };
  }

  const resumableNodeIds = graph.nodes
    .filter((node) => RESUMABLE_NODE_TYPES.has(node.type))
    .map((node) => node.id)
    .sort();

  const target = graph.nodes.find((node) => node.id === nodeId);
  if (!target) {
    return {
      outcome: "refused",
      refusal: {
        kind: "unknown_node",
        nodeId,
        availableNodeIds: graph.nodes.map((node) => node.id).sort(),
      },
    };
  }
  if (!RESUMABLE_NODE_TYPES.has(target.type)) {
    return {
      outcome: "refused",
      refusal: {
        kind: "node_not_resumable",
        nodeId,
        nodeType: target.type,
        resumableNodeIds,
      },
    };
  }

  let validatedValues: Record<string, unknown>;
  try {
    validatedValues = validateDeclaredRegistryValues(
      variables,
      graph.variableRegistry,
      "execution.recover",
    );
  } catch (error) {
    return {
      outcome: "refused",
      refusal: {
        kind: "invalid_variable_values",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const globalContext = mergedContext(execution, validatedValues);
  const unresolved = await unresolvedReferences(
    target,
    { ...execution, globalContext },
    graph.variableRegistry,
  );
  const expressionVariables = missingExpressionVariables(
    target,
    globalContext.variables,
    graph.variableRegistry,
  );
  const missing = [...new Set([...unresolved, ...expressionVariables])].sort();
  if (missing.length > 0) {
    return {
      outcome: "refused",
      refusal: { kind: "missing_variables", nodeId, references: missing },
    };
  }

  // The run arrives at the node it is recovered to: the arrival is recorded like any other, so what
  // is keyed by the waited visit (the person's notification) does not move when a later adjustment
  // is appended. Recovered onto the step it already waits on, it keeps that open visit — the same
  // wait, not a second pass. The presentation that follows continues the open visit either way.
  const visits = execution.visits ?? [];
  const lastEngineVisit = [...visits].reverse().find((visit) => !visit.adjusted);
  const alreadyWaitingThere =
    lastEngineVisit !== undefined &&
    lastEngineVisit.nodeId === nodeId &&
    lastEngineVisit.exitKey === null;
  const moved: WorkflowExecution = {
    ...execution,
    status: "running",
    currentNodeId: nodeId,
    waitingForInputNodeId: nodeId,
    globalContext,
    visits: alreadyWaitingThere
      ? visits
      : [
          ...visits,
          {
            seq: visits.length,
            nodeId,
            exitKey: null,
            changes: {},
            waited: true,
            enteredAt: Date.now(),
          },
        ],
  };
  const recovered: WorkflowExecution = { ...moved, gateWaiting: humanGateWaiting(graph, moved) };
  const written = await repository.recoverExecutionToNode({
    execution: recovered,
    expectedExecution: execution,
    nextAttempt: new ExecutionMutationCoordinator(repository).newPresentedAttempt(
      { ...recovered, revision: execution.revision + 1 },
      graph,
      null,
    ),
  });
  if (written !== "recovered") {
    return { outcome: "refused", refusal: { kind: written } };
  }

  return {
    outcome: "recovered",
    result: {
      executionId: execution.executionId,
      nodeId,
      presentation: await presentCurrentNode(execution.executionId),
      appliedVariables: Object.keys(validatedValues).sort(),
    },
  };
}
