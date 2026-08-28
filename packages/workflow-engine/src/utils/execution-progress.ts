import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import type { WorkflowExecution } from "../types/base-types.js";
import type { ProgressContentTemplate } from "../types/base-types.js";
import type {
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";
import { EXECUTION_PROGRESS_TEXT_LIMITS } from "./execution-progress-contract.js";
export type {
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";

function enforceResolvedLimit(value: string, maxLength: number, field: string): string {
  if ([...value].length > maxLength) {
    throw new Error(
      `Execution progress ${field} exceeds ${maxLength} characters after template resolution`,
    );
  }
  return value;
}

function resolveOptional(
  template: string | undefined,
  processor: GraphTemplateProcessor,
  context: WorkflowExecution["globalContext"],
  maxLength: number,
  field: string,
): string | null {
  if (!template) return null;
  const value = processor.processDirective(template, context).trim();
  return value ? enforceResolvedLimit(value, maxLength, field) : null;
}

function resolveContent(
  base: ProgressContentTemplate | undefined,
  active: ProgressContentTemplate | undefined,
  processor: GraphTemplateProcessor,
  context: WorkflowExecution["globalContext"],
): ExecutionProgressContent {
  const merged = { ...base, ...active };
  return {
    summary: resolveOptional(
      merged.summary,
      processor,
      context,
      EXECUTION_PROGRESS_TEXT_LIMITS.summary,
      "content.summary",
    ),
    details: (merged.details ?? [])
      .map((item) => processor.processDirective(item, context).trim())
      .filter(Boolean)
      .map((item) =>
        enforceResolvedLimit(item, EXECUTION_PROGRESS_TEXT_LIMITS.detail, "content.details[]"),
      ),
    outcome: resolveOptional(
      merged.outcome,
      processor,
      context,
      EXECUTION_PROGRESS_TEXT_LIMITS.outcome,
      "content.outcome",
    ),
    next: resolveOptional(
      merged.next,
      processor,
      context,
      EXECUTION_PROGRESS_TEXT_LIMITS.next,
      "content.next",
    ),
  };
}

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
  const terminalPrimaryNode = successfulCompletion
    ? workflow.nodes.find((node) => node.id === execution.waitingForInputNodeId)
    : undefined;
  const terminalProgressNodeId = terminalPrimaryNode?.progressNodeId ?? null;
  const terminalIndex = definition.nodes.findIndex((node) => node.id === terminalProgressNodeId);
  const diagnostics: string[] = [];
  const renderedTitleValue = definition.title
    ? templateProcessor.processDirective(definition.title, context).trim()
    : "";
  const renderedTitle = renderedTitleValue
    ? enforceResolvedLimit(renderedTitleValue, EXECUTION_PROGRESS_TEXT_LIMITS.title, "title")
    : null;

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
    if (successfulCompletion) {
      if (terminalIndex === -1 || index <= terminalIndex) state = "completed";
    } else if (activeIndex >= 0) {
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
    const content = resolveContent(
      node.content,
      node.id === activeNodeId ? currentPrimaryNode?.progressActiveContent : undefined,
      templateProcessor,
      context,
    );
    if (state === "pending") content.outcome = null;
    return {
      id: node.id,
      label: enforceResolvedLimit(
        templateProcessor.processDirective(labelTemplate, context).trim(),
        EXECUTION_PROGRESS_TEXT_LIMITS.nodeLabel,
        `nodes.${node.id}.label`,
      ),
      state,
      connections: { ...node.connections },
      primaryNodeIds,
      focusNodeId,
      content,
    };
  });

  return {
    taskTitle: execution.note?.trim()
      ? enforceResolvedLimit(
          execution.note.trim(),
          EXECUTION_PROGRESS_TEXT_LIMITS.taskTitle,
          "taskTitle",
        )
      : (renderedTitle ??
        enforceResolvedLimit(
          workflow.metadata.name.trim(),
          EXECUTION_PROGRESS_TEXT_LIMITS.taskTitle,
          "taskTitle",
        )),
    title: renderedTitle,
    goal: resolveOptional(
      definition.goal,
      templateProcessor,
      context,
      EXECUTION_PROGRESS_TEXT_LIMITS.goal,
      "goal",
    ),
    facts: (definition.facts ?? []).map((fact) => ({
      label: enforceResolvedLimit(
        templateProcessor.processDirective(fact.label, context).trim(),
        EXECUTION_PROGRESS_TEXT_LIMITS.factLabel,
        "facts[].label",
      ),
      value: enforceResolvedLimit(
        templateProcessor.processDirective(fact.value, context).trim(),
        EXECUTION_PROGRESS_TEXT_LIMITS.factValue,
        "facts[].value",
      ),
      tone: fact.tone ?? "neutral",
    })),
    activeNodeId: activeIndex >= 0 ? activeNodeId : null,
    nodes,
    workflowVersion: workflow.metadata.version,
    executionRevision: execution.revision,
    executionStatus: execution.status,
    diagnostics,
  };
}
