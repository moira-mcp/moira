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
}

export interface ExecutionProgress {
  taskTitle: string | null;
  title: string | null;
  goal: string | null;
  facts: ExecutionProgressFact[];
  activeNodeId: string | null;
  nodes: ExecutionProgressNode[];
  workflowVersion: string;
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
}
