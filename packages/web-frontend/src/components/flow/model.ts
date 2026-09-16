/**
 * View model of the flow page: the definition's derived process read through the run page's
 * projection shape with no run in it, so the lanes, canvas and outline modes render the
 * definition exactly as they render a run — every block pending, no route, no cursor.
 */

import type { ProcessProjection } from "@mcp-moira/workflow-engine/process";
import type { ExecutionProgress } from "@mcp-moira/workflow-engine/progress-visual";
import type { WorkflowGraph } from "../../types/workflow-types";

/** A run-less projection of a definition: the process with every block pending. */
export function definitionProgress(
  workflow: WorkflowGraph,
  process: ProcessProjection,
): ExecutionProgress {
  return {
    taskTitle: workflow.metadata.name,
    // The authored run title is a template rendered by a run; a definition shows none.
    title: null,
    goal: workflow.metadata.description || null,
    facts: [],
    activeNodeId: null,
    nodes: process.blocks.map((block) => ({
      id: block.id,
      label: block.label,
      state: "pending",
      status: "pending",
      iterations: 0,
      visits: 0,
      currentNodeId: null,
      connections: {},
      primaryNodeIds: block.nodeIds,
      focusNodeId: null,
      content: { summary: null, details: [], outcome: null, next: null },
      timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
      list: null,
    })),
    workflowVersion: workflow.metadata.version,
    executionWorkflowVersion: null,
    projectedAt: 0,
    executionRevision: 0,
    executionStatus: "definition",
    diagnostics: process.diagnostics.map((d) => d.message),
    process,
    route: [],
    variables: [],
    routeRecorded: false,
    cursor: null,
    source: "trace",
  };
}
