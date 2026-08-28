import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import type { WorkflowExecution } from "../types/base-types.js";
import type {
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";
export type {
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";

/**
 * Project current execution state onto the workflow's static user-facing progress graph.
 * The function is pure with respect to workflow/execution state: it never persists or mutates.
 */
export function projectExecutionProgress(
  workflow: WorkflowGraph,
  execution: WorkflowExecution,
): ExecutionProgress | null {
  const definition = workflow.progress;
  if (!definition) return null;

  const templateProcessor = new GraphTemplateProcessor();
  const registryDefaults = Object.fromEntries(
    Object.entries(workflow.variableRegistry ?? {})
      .filter(([, definition]) => definition.default !== undefined)
      .map(([name, definition]) => [name, definition.default]),
  );
  const context = {
    ...execution.globalContext,
    variables: { ...registryDefaults, ...execution.globalContext.variables },
    _templateFragmentVars: GraphTemplateProcessor.computeFragmentVars(workflow.variableRegistry),
  };
  const currentPrimaryNode = workflow.nodes.find((node) => node.id === execution.currentNodeId);
  const activeNodeId = currentPrimaryNode?.progressNodeId ?? null;
  const activeIndex = definition.nodes.findIndex((node) => node.id === activeNodeId);
  const successfulCompletion = execution.status === "completed" && execution.currentNodeId === null;
  const diagnostics: string[] = [];

  if (!successfulCompletion && execution.currentNodeId && !activeNodeId) {
    diagnostics.push(`Current primary node '${execution.currentNodeId}' has no progressNodeId`);
  } else if (activeNodeId && activeIndex === -1) {
    diagnostics.push(`Current primary node references unknown progress node '${activeNodeId}'`);
  }

  const primaryNodesByProgress = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    if (!node.progressNodeId) continue;
    const ids = primaryNodesByProgress.get(node.progressNodeId) ?? [];
    ids.push(node.id);
    primaryNodesByProgress.set(node.progressNodeId, ids);
  }

  const nodes = definition.nodes.map((node, index): ExecutionProgressNode => {
    let state: ExecutionProgressState = "pending";
    if (successfulCompletion) state = "completed";
    else if (activeIndex >= 0) {
      if (index < activeIndex) state = "completed";
      else if (index === activeIndex) state = "current";
    }
    const primaryNodeIds = primaryNodesByProgress.get(node.id) ?? [];
    const focusNodeId =
      node.id === activeNodeId && execution.currentNodeId
        ? execution.currentNodeId
        : (primaryNodeIds[0] ?? null);
    const labelTemplate =
      node.id === activeNodeId && currentPrimaryNode?.progressActiveLabel
        ? currentPrimaryNode.progressActiveLabel
        : node.label;
    return {
      id: node.id,
      label: templateProcessor.processDirective(labelTemplate, context),
      state,
      connections: { ...node.connections },
      primaryNodeIds,
      focusNodeId,
    };
  });

  return {
    title: definition.title ? templateProcessor.processDirective(definition.title, context) : null,
    activeNodeId: activeIndex >= 0 ? activeNodeId : null,
    nodes,
    workflowVersion: workflow.metadata.version,
    executionRevision: execution.revision,
    executionStatus: execution.status,
    diagnostics,
  };
}
