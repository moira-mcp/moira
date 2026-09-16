import type { ProgressFactTone } from "../types/base-types.js";
import type { ExecutionVisitActorRole } from "../types/base-types.js";
import type { ProcessProjection } from "./process-derivation.js";
export type { ProgressFactTone } from "../types/base-types.js";

export const EXECUTION_PROGRESS_TEXT_LIMITS = {
  taskTitle: 500,
  title: 200,
  goal: 1000,
  factLabel: 100,
  factValue: 500,
  nodeLabel: 200,
  summary: 1000,
  detail: 500,
  outcome: 1000,
  next: 500,
} as const;

/** Coarse state old clients read; derived from `status`. */
export type ExecutionProgressState = "completed" | "current" | "pending";

/**
 * Block status projected from the route log: `done` and `repeated` (with the pass count) for
 * visited blocks, `active` or `waiting` for the block of the last visit, `skipped` for a block the
 * run passed without doing its work or bypassed, `pending` for everything else.
 */
export type ExecutionBlockStatus =
  "pending" | "active" | "done" | "repeated" | "skipped" | "waiting";

/** One route entry: a visit with the block it belongs to and the names of what it changed. */
export interface ExecutionRouteEntry {
  seq: number;
  nodeId: string;
  blockId: string | null;
  exitKey: string | null;
  changed: string[];
  waited?: boolean;
  adjusted?: boolean;
  actor?: { role: ExecutionVisitActorRole; userId: string };
  /** The visit re-entered a block the route had already left. */
  loop?: boolean;
  /** Epoch ms the node was entered; absent for visits recorded before timestamps. */
  enteredAt?: number;
  /** Epoch ms the node was left; absent while open or when not recorded. */
  leftAt?: number;
}

/** One pass through a block's working step, with the time it took. */
export interface ExecutionPassTiming {
  seq: number;
  nodeId: string;
  enteredAt: number | null;
  leftAt: number | null;
  /** Closed pass: left − entered; open pass: now − entered; null when not recorded. */
  durationMs: number | null;
  /** The run is still on this pass. */
  open: boolean;
  /** Index (from 0) of the bound list item the pass was working on, when the block binds a list. */
  itemIndex: number | null;
}

/** A block's timings derived from the route; `recorded` is false for runs without timestamps. */
export interface ExecutionBlockTiming {
  passes: ExecutionPassTiming[];
  /** Sum of every measured pass (open pass included); null when nothing was measured. */
  totalMs: number | null;
  /** Duration of the open pass so far; null when the block is not open. */
  currentMs: number | null;
  recorded: boolean;
}

export interface ExecutionListItem {
  /** Position in the list, from 0. */
  index: number;
  title: string;
  done: boolean;
  current: boolean;
  /** Time the block's passes spent on this item; null when none was measured. */
  durationMs: number | null;
}

/** The list a block is bound to, resolved from the run's variables at the cursor. */
export interface ExecutionBlockList {
  /** Null when the binding names no items array (counters only). */
  items: ExecutionListItem[] | null;
  done: number | null;
  total: number | null;
  /** Index (from 0) of the item in progress; null when none. */
  current: number | null;
  currentTitle: string | null;
}

export interface ExecutionVariableChange {
  seq: number;
  nodeId: string;
  value: unknown;
  adjusted?: boolean;
}

/** A global variable or a node-local output (`nodeId.field`) with its value and history. */
export interface ExecutionVariableState {
  name: string;
  kind: "variable" | "output";
  current: unknown;
  history: ExecutionVariableChange[];
  /** The current value came from a runtime adjustment. */
  adjusted: boolean;
}

export interface ExecutionProgressContent {
  summary: string | null;
  details: string[];
  outcome: string | null;
  next: string | null;
}

export interface ExecutionProgressFact {
  label: string;
  value: string;
  tone: ProgressFactTone;
}

export interface ExecutionProgressNode {
  id: string;
  label: string;
  state: ExecutionProgressState;
  status: ExecutionBlockStatus;
  /** Completed passes through the block's working steps. */
  iterations: number;
  /** Visits of any node of the block. */
  visits: number;
  /** For the active or waiting block: the node the run is on. */
  currentNodeId: string | null;
  /** Display order: the next block in process order. */
  connections: { default?: string };
  primaryNodeIds: string[];
  focusNodeId: string | null;
  content: ExecutionProgressContent;
  timing: ExecutionBlockTiming;
  /** The bound list; null when the block binds none or the binding did not resolve. */
  list: ExecutionBlockList | null;
}

export interface ExecutionProgress {
  taskTitle: string | null;
  title: string | null;
  goal: string | null;
  facts: ExecutionProgressFact[];
  activeNodeId: string | null;
  nodes: ExecutionProgressNode[];
  /** `metadata.version` of the definition the projection used (the current one). */
  workflowVersion: string;
  /** Version stamped on the execution when it started; null for runs recorded before the stamp. */
  executionWorkflowVersion: string | null;
  executionRevision: number;
  executionStatus: string;
  diagnostics: string[];
  /** The derived process the run is projected onto. */
  process: ProcessProjection;
  /** The recorded route in order; empty when no route was recorded. */
  route: ExecutionRouteEntry[];
  variables: ExecutionVariableState[];
  /** False for an execution created before routes were recorded: nothing is inferred for it. */
  routeRecorded: boolean;
  /**
   * The route cursor the projection was made at: the sequence number of the last visit taken
   * into account, or null when the whole recorded route was projected.
   */
  cursor: number | null;
  source: "trace";
  /** Epoch ms the projection was made at; open passes are measured to it. */
  projectedAt: number;
  /**
   * Who the run waits for while it pauses: `user` at a gate a person clears (a lock's PIN),
   * `agent` on a step the agent must complete (a directive, teleport or materialize wait),
   * `null` when the run is not waiting.
   */
  waitingFor: "agent" | "user" | null;
}
