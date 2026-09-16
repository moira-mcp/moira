/**
 * The visit log: the record of a run's route. The stateless engine loop produces one entry per
 * node it ran (which node, the connection it left through, the variables the node changed, and
 * whether it paused for input); the stateful executor appends those entries to the execution with
 * sequence numbers, folding a resumed wait into the visit that opened it. Runtime adjustments
 * (a value set from outside the flow) are appended as visits flagged `adjusted` with their actor.
 * The log is append-only and travels with the execution's revisioned state.
 */

import type { ExecutionVisit, WorkflowExecution } from "../types/base-types.js";

/** One node visit as the engine loop reports it, before it is numbered on the execution. */
export interface EngineVisit {
  nodeId: string;
  /** Connection key taken on exit; `null` while the node waits, or at completion. */
  exitKey: string | null;
  /** Global variables and node-local outputs (`nodeId.field`) this visit changed. */
  changes: Record<string, unknown>;
  /** The visit paused for input. */
  waited: boolean;
  /** Epoch ms when the node was entered in this cycle. */
  enteredAt: number;
  /** Epoch ms when the node was left; absent while it waits. */
  leftAt?: number;
}

/** Exit key recorded on the visit a teleport jumped away from. */
export const TELEPORT_EXIT_KEY = "teleport";

export type VariableSnapshot = Map<string, string>;

/** JSON of every top-level variable, so a later diff sees value changes, not identity. */
export function snapshotVariables(variables: Record<string, unknown>): VariableSnapshot {
  const snapshot: VariableSnapshot = new Map();
  for (const [name, value] of Object.entries(variables)) {
    snapshot.set(name, JSON.stringify(value) ?? "undefined");
  }
  return snapshot;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Variables whose value changed between the snapshot and the current context. A node-local scope
 * (a top-level key named after a graph node holding an object) is flattened to `nodeId.field`
 * entries, one per changed field; every other changed key is reported by name.
 */
export function diffVariables(
  before: VariableSnapshot,
  after: Record<string, unknown>,
  nodeIds: ReadonlySet<string>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(after)) {
    const previous = before.get(name);
    const current = JSON.stringify(value) ?? "undefined";
    if (previous === current) continue;
    if (nodeIds.has(name) && isPlainObject(value)) {
      const previousObject: Record<string, unknown> =
        previous !== undefined && previous !== "undefined" ? JSON.parse(previous) : {};
      for (const [field, fieldValue] of Object.entries(value)) {
        if (JSON.stringify(previousObject[field]) !== JSON.stringify(fieldValue)) {
          changes[`${name}.${field}`] = fieldValue;
        }
      }
      continue;
    }
    changes[name] = value;
  }
  return changes;
}

/**
 * Append the visits of one engine cycle to the execution. A cycle that starts on the node whose
 * visit is still open (it paused last time) continues that visit instead of opening another: the
 * exit key and the changes of the resume land on it. A teleport closes the open visit with the
 * teleport exit before the target's visit is appended. When the input that resumed the wait came
 * from outside the flow (`answeredBy`, a person on the run page rather than the agent), the
 * accepted answer is also recorded as an adjustment visit on that node — flagged `adjusted` with
 * its actor and carrying the values the answer wrote — right after the wait it closed, so the
 * route shows who supplied the evidence. Mutates `execution.visits`.
 */
export function appendEngineVisits(
  execution: WorkflowExecution,
  visits: readonly EngineVisit[],
  teleportTo?: string,
  answeredBy?: NonNullable<ExecutionVisit["actor"]>,
): void {
  const log = (execution.visits ??= []);
  // The engine's last visit may sit under adjustment visits recorded during the same wait.
  const open = () => {
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const visit = log[index];
      if (visit.adjusted) continue;
      return visit.exitKey === null ? visit : undefined;
    }
    return undefined;
  };
  if (teleportTo) {
    const last = open();
    if (last) {
      last.exitKey = TELEPORT_EXIT_KEY;
      last.leftAt = Math.max(last.enteredAt ?? 0, Date.now());
    }
  }
  visits.forEach((visit, index) => {
    const last = index === 0 ? open() : undefined;
    if (last && last.nodeId === visit.nodeId) {
      last.exitKey = visit.exitKey;
      last.changes = { ...last.changes, ...visit.changes };
      if (visit.waited) last.waited = true;
      // The wait keeps the moment its directive was presented; the resume closes it.
      if (last.enteredAt === undefined) last.enteredAt = visit.enteredAt;
      if (visit.leftAt !== undefined) last.leftAt = Math.max(last.enteredAt, visit.leftAt);
      // An answer that left the node was accepted; one that paused again was rejected as
      // invalid and is not an adjustment of the run.
      if (answeredBy && visit.exitKey !== null) {
        log.push({
          seq: log.length,
          nodeId: visit.nodeId,
          exitKey: null,
          changes: { ...visit.changes },
          adjusted: true,
          actor: answeredBy,
          enteredAt: visit.leftAt ?? visit.enteredAt,
          leftAt: visit.leftAt ?? visit.enteredAt,
        });
      }
      return;
    }
    log.push({
      seq: log.length,
      nodeId: visit.nodeId,
      exitKey: visit.exitKey,
      changes: visit.changes,
      ...(visit.waited ? { waited: true } : {}),
      enteredAt: visit.enteredAt,
      ...(visit.leftAt !== undefined ? { leftAt: visit.leftAt } : {}),
    });
  });
}

/**
 * The execution as a node that runs mid-cycle sees it: the persisted log ends at the last pause,
 * so the visits of the current cycle are not yet appended. A synthetic open visit of `nodeId`
 * (nothing changed, not waiting) lets a projection made inside that cycle — a notification's
 * progress image — show the node's block as the active one. The returned copy is never persisted.
 */
export function withInFlightVisit(execution: WorkflowExecution, nodeId: string): WorkflowExecution {
  const visits = execution.visits ?? [];
  return {
    ...execution,
    currentNodeId: nodeId,
    visits: [
      ...visits,
      { seq: visits.length, nodeId, exitKey: null, changes: {}, enteredAt: Date.now() },
    ],
  };
}

/**
 * The node types a run pauses on, by who is waited for there: a `lock` gate waits for a person,
 * every other pausing node for the agent. Continuation recovery resumes at these same types.
 */
export const PAUSE_ACTOR_BY_NODE_TYPE: Readonly<Record<string, "agent" | "user">> = {
  "agent-directive": "agent",
  teleport: "agent",
  materialize: "agent",
  subgraph: "agent",
  lock: "user",
};
export const PAUSING_NODE_TYPES: ReadonlySet<string> = new Set(
  Object.keys(PAUSE_ACTOR_BY_NODE_TYPE),
);

/**
 * The execution as it stands once a notification node has sent: the notification's own open
 * visit (`withInFlightVisit`), and — when the node's single forward connection leads straight to a
 * node the run pauses on — that node as the one the run waits on, with a synthetic open visit that
 * carries no timestamp (the run has not entered it yet, so its pass has no duration). A projection
 * of this copy names the block and the actor the message's reader is about to wait for or on: a
 * `lock` gate reads as a person, a directive, teleport, materialize or subgraph wait as the agent. A
 * successor that pauses nowhere (a routing node, an end) leaves the copy as `withInFlightVisit`
 * makes it. The returned copy is never persisted.
 */
export function withInFlightPause(
  graph: { nodes: ReadonlyArray<{ id: string; type: string; connections?: unknown }> },
  execution: WorkflowExecution,
  nodeId: string,
): WorkflowExecution {
  const inFlight = withInFlightVisit(execution, nodeId);
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  const connections = (node?.connections ?? {}) as Record<string, string | undefined>;
  const nextId = connections.default ?? connections.success;
  const next = nextId ? graph.nodes.find((candidate) => candidate.id === nextId) : undefined;
  if (!next || !PAUSING_NODE_TYPES.has(next.type)) return inFlight;
  const visits = inFlight.visits ?? [];
  // The visit is a wait, so the projection marks the block `waiting` and words the actor.
  return {
    ...inFlight,
    currentNodeId: next.id,
    waitingForInputNodeId: next.id,
    visits: [
      ...visits,
      { seq: visits.length, nodeId: next.id, exitKey: null, changes: {}, waited: true },
    ],
  };
}

/** Build the adjustment visit recorded when a value is set on a paused execution from outside. */
export function adjustmentVisit(
  execution: WorkflowExecution,
  changes: Record<string, unknown>,
  actor: NonNullable<ExecutionVisit["actor"]>,
): Omit<ExecutionVisit, "seq"> {
  const now = Date.now();
  return {
    nodeId: execution.currentNodeId ?? execution.waitingForInputNodeId ?? "",
    exitKey: null,
    changes,
    adjusted: true,
    actor,
    enteredAt: now,
    leftAt: now,
  };
}
