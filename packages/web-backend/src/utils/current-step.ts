/**
 * The name of the step a run is on, as people read it — never a node id.
 */

import type { WorkflowExecution } from "@mcp-moira/workflow-engine";

export interface StepGraph {
  nodes?: Array<{
    id: string;
    metadata?: { displayName?: string };
    progressNodeId?: string;
    progressActiveLabel?: string;
  }>;
  progress?: { nodes?: Array<{ id: string; label?: string }> };
}

/**
 * The step a run is on, named in the run page's order: the node's active progress label (when it
 * is plain text, not a template), else its display name; where the run page would fall back to the
 * node id, the label of the progress block the node belongs to comes first. The step is the node
 * the run waits at, else its current node.
 */
export function currentStep(
  execution: WorkflowExecution,
  graphJson: string | undefined,
): { stepId: string | null; stepName: string | null } {
  const stepId = execution.waitingForInputNodeId ?? execution.currentNodeId ?? null;
  if (!stepId || !graphJson) return { stepId, stepName: null };
  let graph: StepGraph;
  try {
    graph = JSON.parse(graphJson) as StepGraph;
  } catch {
    // A graph that does not parse names no step; the id still identifies it
    return { stepId, stepName: null };
  }
  return { stepId, stepName: stepNameIn(graph, stepId) };
}

/** The name of step `stepId` in a parsed definition (see `currentStep`), or null. */
export function stepNameIn(graph: StepGraph, stepId: string): string | null {
  const node = graph.nodes?.find((candidate) => candidate.id === stepId);
  const activeLabel = node?.progressActiveLabel?.includes("{{")
    ? undefined
    : node?.progressActiveLabel;
  const blockLabel = graph.progress?.nodes?.find(
    (block) => block.id === node?.progressNodeId,
  )?.label;
  const stepName = [activeLabel, node?.metadata?.displayName, blockLabel]
    .map((name) => name?.trim())
    .find((name) => !!name);
  return stepName ?? null;
}
