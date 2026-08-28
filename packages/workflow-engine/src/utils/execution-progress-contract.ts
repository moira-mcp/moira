import type { ProgressFactTone } from "../types/base-types.js";
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

export type ExecutionProgressState = "completed" | "current" | "pending";

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
}
