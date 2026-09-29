/**
 * Human gates — steps a workflow marks as waiting for a person's decision.
 *
 * A marked step is an ordinary `agent-directive`: the agent still presents the question and submits
 * the answer. The mark only says who the run is waiting for while it stands there, so the rules live
 * in one place: the engine stores the result when a run pauses, recovery and a new workflow version
 * recompute it, and the progress projection reads it.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import type { AgentDirectiveNode, HumanGate } from "../types/graph-nodes.js";
import { isAgentDirectiveNode } from "../types/graph-nodes.js";
import { evaluateStructuredCondition } from "../services/node-routing.js";

/** The execution facts a gate decision reads. */
export type HumanGateExecution = Pick<
  WorkflowExecution,
  | "status"
  | "currentNodeId"
  | "waitingForInputNodeId"
  | "globalContext"
  | "executionId"
  | "workflowId"
>;

/** The marked directive a paused run stands on, or null when it stands on anything else. */
export function currentGatedNode(
  graph: Pick<WorkflowGraph, "nodes">,
  execution: HumanGateExecution,
): (AgentDirectiveNode & { humanGate: HumanGate }) | null {
  if (execution.status !== "running" && execution.status !== "waiting") return null;
  if (!execution.currentNodeId || execution.waitingForInputNodeId !== execution.currentNodeId) {
    return null;
  }
  const node = graph.nodes.find((candidate) => candidate.id === execution.currentNodeId);
  if (!node || !isAgentDirectiveNode(node) || !node.humanGate) return null;
  return node as AgentDirectiveNode & { humanGate: HumanGate };
}

/**
 * Whether the run waits for a person: it is paused on a marked directive whose `when` holds against
 * the run's context. A condition that cannot be evaluated counts as not holding — the validator
 * refuses malformed conditions, and a run must never fail because of how it is displayed.
 */
export function humanGateWaiting(
  graph: Pick<WorkflowGraph, "nodes">,
  execution: HumanGateExecution,
): boolean {
  const node = currentGatedNode(graph, execution);
  if (!node) return false;
  const when = node.humanGate.when;
  if (!when) return true;
  try {
    return evaluateStructuredCondition(when, {
      variables: execution.globalContext?.variables ?? {},
      executionId: execution.executionId,
      workflowId: execution.workflowId,
      userId: execution.globalContext?.userId,
    });
  } catch {
    return false;
  }
}

/** A value as JSON with object keys sorted, so equal gates compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Whether a new definition changes the gate of the node a run stands on: its `humanGate` mark
 * (present, absent or different) or the node's type. The decision is taken when the run arrives, so
 * a new version re-decides only the runs whose gate it changed; any other save leaves the arrival
 * decision alone even if the run's variables have moved since. An unknown previous definition counts
 * as changed.
 */
export function humanGateChanged(
  previous: Pick<WorkflowGraph, "nodes"> | null,
  next: Pick<WorkflowGraph, "nodes">,
  nodeId: string | null,
): boolean {
  if (!nodeId) return false;
  if (!previous) return true;
  const gateOf = (graph: Pick<WorkflowGraph, "nodes">) => {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return "absent";
    return canonical({
      type: node.type,
      gate: isAgentDirectiveNode(node) ? node.humanGate : undefined,
    });
  };
  return gateOf(previous) !== gateOf(next);
}

/** Matches the duration form `remindAfter` accepts: a positive integer and m, h or d. */
export const HUMAN_GATE_DURATION_PATTERN = /^[1-9][0-9]{0,4}[mhd]$/;

/** `remindAfter` in milliseconds, or null when absent or not in the accepted form. */
export function humanGateRemindAfterMs(gate: Pick<HumanGate, "remindAfter">): number | null {
  const value = gate.remindAfter;
  if (value === undefined || !HUMAN_GATE_DURATION_PATTERN.test(value)) return null;
  const amount = Number(value.slice(0, -1));
  const unit = value.slice(-1);
  const minute = 60_000;
  return amount * (unit === "m" ? minute : unit === "h" ? 60 * minute : 24 * 60 * minute);
}
