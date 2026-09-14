/**
 * The process projection of a saved workflow, as the API serves it: the derived blocks with their
 * transitions, returns and diagnostics, and nothing about any run. Non-browser consumers and the
 * flow page read this instead of deriving from the workflow JSON themselves.
 */
import {
  deriveProcess,
  type ProcessProjection,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

export interface WorkflowProcessResponse {
  workflowId: string;
  version: string;
  /** Null when the workflow declares no `progress`: it has no block view. */
  process: ProcessProjection | null;
}

export function buildWorkflowProcessResponse(
  workflowId: string,
  workflow: WorkflowGraph,
): WorkflowProcessResponse {
  return {
    workflowId,
    version: workflow.metadata.version,
    process: deriveProcess(workflow),
  };
}
