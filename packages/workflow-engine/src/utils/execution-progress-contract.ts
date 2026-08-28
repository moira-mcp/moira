export type ExecutionProgressState = "completed" | "current" | "pending";

export interface ExecutionProgressNode {
  id: string;
  label: string;
  state: ExecutionProgressState;
  connections: { default?: string };
  primaryNodeIds: string[];
  focusNodeId: string | null;
}

export interface ExecutionProgress {
  title: string | null;
  activeNodeId: string | null;
  nodes: ExecutionProgressNode[];
  workflowVersion: string;
  executionRevision: number;
  executionStatus: string;
  diagnostics: string[];
}
