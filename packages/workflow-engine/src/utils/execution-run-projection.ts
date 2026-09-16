/**
 * Run projection: an execution's recorded route projected onto the process derived from its
 * workflow. Block statuses, pass counts, the ordered route with loop markers and the variables
 * with their history all come from the visit log; nothing is inferred from block order. An
 * execution without a recorded route reports only the block it is on as active or waiting, every
 * other block pending, and `routeRecorded: false`. A cursor (`at`, a visit sequence number)
 * projects the run as it stood when that visit was the last one: the route is cut there, the
 * execution is treated as running on that visit's node, and variables carry the last value
 * written up to it. Pure: never persists or mutates its inputs.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { GraphTemplateProcessor } from "../templates/graph-template-processor.js";
import type {
  ExecutionVisit,
  ProgressContentTemplate,
  WorkflowExecution,
} from "../types/base-types.js";
import type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ExecutionRouteEntry,
  ExecutionVariableState,
} from "./execution-progress-contract.js";
import { EXECUTION_PROGRESS_TEXT_LIMITS } from "./execution-progress-contract.js";
import { deriveProcess, type ProcessProjection } from "./process-derivation.js";
import {
  blockTimings,
  itemIndexResolver,
  resolveBlockList,
  variablesObject,
  type PassSelector,
} from "./execution-progress-lists.js";
export type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
  ExecutionRouteEntry,
  ExecutionVariableState,
} from "./execution-progress-contract.js";

/** Node types that route without doing a block's work; their visits are not passes. */
const ROUTING_NODE_TYPES: ReadonlySet<string> = new Set(["start", "condition", "expression"]);

/**
 * Which visits count as passes of which block: a visit of a working step, or of any node in a
 * block made of routing nodes alone; adjustments are never passes. The same rule the status
 * projection counts iterations with.
 */
export function passSelector(
  process: ProcessProjection,
  nodeTypes: ReadonlyMap<string, string>,
): PassSelector {
  const owner = new Map<string, string>();
  for (const block of process.blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  // An end node does no work either: its visit is a pass only in a block that has no working
  // step at all, so a completed run's end does not add a zero-length pass to its last block.
  const isNonWorking = (nodeId: string) => {
    const type = nodeTypes.get(nodeId) ?? "";
    return ROUTING_NODE_TYPES.has(type) || type === "end";
  };
  const nonWorkingOnly = new Set(
    process.blocks.filter((block) => block.nodeIds.every(isNonWorking)).map((block) => block.id),
  );
  return {
    blockOf: (nodeId) => owner.get(nodeId),
    isPass: (visit) => {
      if (visit.adjusted) return false;
      const blockId = owner.get(visit.nodeId);
      if (!blockId) return false;
      return !isNonWorking(visit.nodeId) || nonWorkingOnly.has(blockId);
    },
  };
}

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

interface BlockStats {
  entries: number;
  visits: number;
  workingVisits: number;
  iterations: number;
}

/** Per-block visit statistics of a route. */
export function blockVisitStats(
  process: ProcessProjection,
  nodeTypes: ReadonlyMap<string, string>,
  visits: readonly ExecutionVisit[],
): Map<string, BlockStats> {
  const owner = new Map<string, string>();
  for (const block of process.blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  const isRouting = (nodeId: string) => ROUTING_NODE_TYPES.has(nodeTypes.get(nodeId) ?? "");
  // A block made only of routing nodes does its work by routing: its visits are passes.
  const routingOnly = new Set(
    process.blocks.filter((block) => block.nodeIds.every(isRouting)).map((block) => block.id),
  );
  const stats = new Map<string, BlockStats>(
    process.blocks.map((block) => [
      block.id,
      { entries: 0, visits: 0, workingVisits: 0, iterations: 0 },
    ]),
  );
  const perNode = new Map<string, number>();
  let previousBlock: string | undefined;
  for (const visit of visits) {
    const blockId = owner.get(visit.nodeId);
    if (!blockId) continue;
    const s = stats.get(blockId)!;
    s.visits += 1;
    const routing = isRouting(visit.nodeId) && !routingOnly.has(blockId);
    if (!routing && !visit.adjusted) s.workingVisits += 1;
    const count = (perNode.get(visit.nodeId) ?? 0) + (visit.adjusted ? 0 : 1);
    perNode.set(visit.nodeId, count);
    // Passes are counted on working steps; a routing check runs once more than the loop body.
    if (!visit.adjusted && (!routing || s.workingVisits === 0)) {
      s.iterations = Math.max(s.iterations, count);
    }
    if (blockId !== previousBlock) s.entries += 1;
    previousBlock = blockId;
  }
  return stats;
}

function coarseState(status: ExecutionBlockStatus): ExecutionProgressState {
  if (status === "done" || status === "repeated") return "completed";
  if (status === "active" || status === "waiting") return "current";
  return "pending";
}

/**
 * The visit that says where the run is: the engine's own visits, and an adjustment that carries
 * an exit key (a closed adjusted visit is a closed visit — it neither reopens a wait nor is
 * skipped when it is the last thing the run did). An open adjustment (the usual kind, written
 * after the wait it answered) is skipped so the wait it sits on stays the run's position.
 */
const closesOrIsEngine = (visit: ExecutionVisit): boolean =>
  !visit.adjusted || visit.exitKey !== null;

/**
 * Block statuses from the route: the block of the last visit is active, or waiting when that
 * visit is open on the node the execution waits for; visited blocks are done, or repeated with
 * the pass count of their working steps; blocks where only routing nodes ran (unless the block
 * consists of routing nodes alone, whose routing is its work), and unvisited
 * blocks before the furthest visited block in process order, are skipped; the rest are pending.
 * A finished run has no active block unless it stopped on an open wait, which stays active as
 * the frontier. Nothing unvisited is ever reported done.
 */
export function blockStatuses(
  process: ProcessProjection,
  nodeTypes: ReadonlyMap<string, string>,
  execution: Pick<WorkflowExecution, "status" | "currentNodeId" | "waitingForInputNodeId">,
  visits: readonly ExecutionVisit[],
): Map<string, { status: ExecutionBlockStatus; iterations: number; visits: number }> {
  const stats = blockVisitStats(process, nodeTypes, visits);
  const owner = new Map<string, string>();
  for (const block of process.blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  // Cancellation also ends in "completed" (its error log says why), so this is the only terminal.
  const finished = execution.status === "completed";
  // Adjustments sit on the node the run is on; the engine's own last visit says where it is.
  const last = [...visits].reverse().find(closesOrIsEngine);
  const currentBlock = last ? owner.get(last.nodeId) : undefined;
  // An open last visit on a finished execution is where the run stopped (cancelled or aborted
  // while waiting): that block stays the frontier, never done.
  const lastOpen = last !== undefined && last.exitKey === null && Boolean(last.waited);
  const waiting =
    lastOpen && !finished && execution.waitingForInputNodeId === (last?.nodeId ?? null);
  const order = process.blocks.map((block) => block.id);
  const furthestVisited = Math.max(
    -1,
    ...order.map((id, index) => ((stats.get(id)?.entries ?? 0) > 0 ? index : -1)),
  );
  const result = new Map<
    string,
    { status: ExecutionBlockStatus; iterations: number; visits: number }
  >();
  order.forEach((id, index) => {
    const s = stats.get(id)!;
    if (s.entries === 0) {
      result.set(id, {
        status: index < furthestVisited ? "skipped" : "pending",
        iterations: 0,
        visits: 0,
      });
      return;
    }
    if (id === currentBlock && (!finished || lastOpen)) {
      result.set(id, {
        status: waiting ? "waiting" : "active",
        iterations: s.iterations,
        visits: s.visits,
      });
      return;
    }
    if (s.workingVisits === 0) {
      result.set(id, { status: "skipped", iterations: 0, visits: s.visits });
      return;
    }
    result.set(id, {
      status: s.iterations > 1 ? "repeated" : "done",
      iterations: s.iterations,
      visits: s.visits,
    });
  });
  return result;
}

/**
 * The route with block ids, changed names and loop markers: a visit is a loop when its node was
 * already visited (a repeat inside a block) or when it re-enters a block the route had left.
 */
export function projectRoute(
  process: ProcessProjection,
  visits: readonly ExecutionVisit[],
): ExecutionRouteEntry[] {
  const owner = new Map<string, string>();
  for (const block of process.blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  const left = new Set<string>();
  const seenNodes = new Set<string>();
  let previousBlock: string | null = null;
  return visits.map((visit) => {
    const blockId = owner.get(visit.nodeId) ?? null;
    const entering = blockId !== previousBlock;
    const loop =
      !visit.adjusted &&
      ((entering && blockId !== null && left.has(blockId)) || seenNodes.has(visit.nodeId));
    seenNodes.add(visit.nodeId);
    if (entering && previousBlock !== null) left.add(previousBlock);
    previousBlock = blockId;
    return {
      seq: visit.seq,
      nodeId: visit.nodeId,
      blockId,
      exitKey: visit.exitKey,
      changed: Object.keys(visit.changes),
      ...(visit.waited ? { waited: true } : {}),
      ...(visit.adjusted ? { adjusted: true } : {}),
      ...(visit.actor ? { actor: visit.actor } : {}),
      ...(loop ? { loop: true } : {}),
      ...(visit.enteredAt !== undefined ? { enteredAt: visit.enteredAt } : {}),
      ...(visit.leftAt !== undefined ? { leftAt: visit.leftAt } : {}),
    };
  });
}

/**
 * Every global variable and node-local output with its current value (from the execution
 * context) and its history (from the route). Registry defaults appear for variables the context
 * has not set yet. Under a cursor the current value is the last one the truncated route wrote,
 * or the registry default when the route wrote it only later; a value the route never wrote is
 * the context's, since nothing changed it.
 */
export function projectVariables(
  workflow: WorkflowGraph,
  execution: WorkflowExecution,
  visits: readonly ExecutionVisit[],
  cursor: number | null = null,
): ExecutionVariableState[] {
  const nodeIds = new Set(workflow.nodes.map((node) => node.id));
  const states = new Map<string, ExecutionVariableState>();
  const ensure = (name: string): ExecutionVariableState => {
    let state = states.get(name);
    if (!state) {
      state = {
        name,
        kind: name.includes(".") ? "output" : "variable",
        current: undefined,
        history: [],
        adjusted: false,
      };
      states.set(name, state);
    }
    return state;
  };
  for (const [name, definition] of Object.entries(workflow.variableRegistry ?? {})) {
    if (definition.default !== undefined) ensure(name).current = definition.default;
  }
  for (const [name, value] of Object.entries(execution.globalContext.variables)) {
    if (nodeIds.has(name) && typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        ensure(`${name}.${field}`).current = fieldValue;
      }
      continue;
    }
    ensure(name).current = value;
  }
  const writtenLater = new Set<string>();
  for (const visit of visits) {
    for (const [name, value] of Object.entries(visit.changes)) {
      const state = ensure(name);
      if (cursor !== null && visit.seq > cursor) {
        writtenLater.add(name);
        continue;
      }
      state.history.push({
        seq: visit.seq,
        nodeId: visit.nodeId,
        value,
        ...(visit.adjusted ? { adjusted: true } : {}),
      });
      state.adjusted = Boolean(visit.adjusted);
      if (cursor !== null) state.current = value;
    }
  }
  if (cursor !== null) {
    for (const name of writtenLater) {
      const state = states.get(name)!;
      if (state.history.length > 0) continue;
      state.current = workflow.variableRegistry?.[name]?.default;
      state.adjusted = false;
    }
  }
  return [...states.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "variable" ? -1 : 1,
  );
}

export interface ProjectExecutionRunOptions {
  /**
   * Route cursor: project the run as of this visit sequence number. A cursor at or beyond the
   * last recorded visit projects the whole route, as if no cursor were given.
   */
  at?: number;
  /** The moment open passes are measured to; defaults to the wall clock. */
  now?: number;
}

/**
 * The execution as it stood when the visit at the cursor was the last one: the route cut there,
 * the run still running on that visit's node, waiting there if the visit paused.
 */
function executionAtCursor(execution: WorkflowExecution, at: number): WorkflowExecution {
  const visits = (execution.visits ?? []).filter((visit) => visit.seq <= at);
  const last = [...visits].reverse().find(closesOrIsEngine) ?? visits[visits.length - 1];
  const open = last !== undefined && last.exitKey === null && Boolean(last.waited);
  return {
    ...execution,
    status: "running",
    currentNodeId: last?.nodeId ?? execution.currentNodeId,
    waitingForInputNodeId: open ? last.nodeId : null,
    visits,
  };
}

/** Project an execution's recorded route onto its workflow's derived process. */
export function projectExecutionRun(
  workflow: WorkflowGraph,
  source: WorkflowExecution,
  options: ProjectExecutionRunOptions = {},
): ExecutionProgress | null {
  const definition = workflow.progress;
  const process = deriveProcess(workflow);
  if (!definition || !process) return null;

  const recorded = source.visits ?? [];
  const lastSeq = recorded.length > 0 ? recorded[recorded.length - 1].seq : -1;
  const cursor =
    options.at !== undefined && recorded.length > 0 && options.at < lastSeq
      ? Math.max(0, options.at)
      : null;
  const execution = cursor === null ? source : executionAtCursor(source, cursor);

  const templateProcessor = new GraphTemplateProcessor();
  const registryDefaults = Object.fromEntries(
    Object.entries(workflow.variableRegistry ?? {})
      .filter(([, variable]) => variable.default !== undefined)
      .map(([name, variable]) => [name, variable.default]),
  );
  const context = {
    ...execution.globalContext,
    variables: { ...registryDefaults, ...execution.globalContext.variables },
    _templateFragmentVars: GraphTemplateProcessor.computeFragmentVars(workflow.variableRegistry),
  };
  const nodeTypes = new Map(workflow.nodes.map((node) => [node.id, node.type]));
  const owner = new Map<string, string>();
  for (const block of process.blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  const visits = execution.visits ?? [];
  const routeRecorded = visits.length > 0;
  const finished = execution.status === "completed";
  const diagnostics: string[] = [];

  const currentPrimaryNode = workflow.nodes.find((node) => node.id === execution.currentNodeId);
  if (!finished && execution.currentNodeId && !currentPrimaryNode?.progressNodeId) {
    diagnostics.push(`Current primary node '${execution.currentNodeId}' has no progressNodeId`);
  }

  // Statuses: from the route, or — without one — only the block the run is on.
  let statuses: Map<string, { status: ExecutionBlockStatus; iterations: number; visits: number }>;
  let activeNodeId: string | null;
  let activePrimaryNodeId: string | null;
  let openVisitSeq: number | null = null;
  if (routeRecorded) {
    statuses = blockStatuses(process, nodeTypes, execution, visits);
    const last = [...visits].reverse().find(closesOrIsEngine) ?? visits[0];
    const stoppedOnWait = last.exitKey === null && Boolean(last.waited);
    activeNodeId = finished && !stoppedOnWait ? null : (owner.get(last.nodeId) ?? null);
    activePrimaryNodeId = finished && !stoppedOnWait ? null : last.nodeId;
    // The pass the run is on is open only while the run is there: not on a finished run's
    // last visit unless it stopped on a wait.
    if (last.exitKey === null && (!finished || stoppedOnWait)) openVisitSeq = last.seq;
  } else {
    diagnostics.push("No route was recorded for this execution");
    const currentBlock = finished ? null : (currentPrimaryNode?.progressNodeId ?? null);
    const waiting =
      Boolean(execution.currentNodeId) &&
      execution.waitingForInputNodeId === execution.currentNodeId;
    statuses = new Map(
      process.blocks.map((block) => [
        block.id,
        block.id === currentBlock
          ? { status: waiting ? "waiting" : "active", iterations: 0, visits: 0 }
          : { status: "pending", iterations: 0, visits: 0 },
      ]),
    );
    activeNodeId = currentBlock && statuses.has(currentBlock) ? currentBlock : null;
    activePrimaryNodeId = activeNodeId ? (execution.currentNodeId ?? null) : null;
  }

  const primaryNodesByBlock = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    if (!node.progressNodeId) continue;
    const ids = primaryNodesByBlock.get(node.progressNodeId) ?? [];
    ids.push(node.id);
    primaryNodesByBlock.set(node.progressNodeId, ids);
  }

  const renderedTitleValue = definition.title
    ? templateProcessor.processDirective(definition.title, context).trim()
    : "";
  const renderedTitle = renderedTitleValue
    ? enforceResolvedLimit(renderedTitleValue, EXECUTION_PROGRESS_TEXT_LIMITS.title, "title")
    : null;

  const activeLabelNode =
    activePrimaryNodeId === execution.currentNodeId ? currentPrimaryNode : undefined;

  // Timings and bound lists: the variables at the cursor, the passes of every block, and — for
  // a bound block — the item each pass worked on.
  const now = options.now ?? Date.now();
  const variableStates = projectVariables(workflow, execution, visits, cursor);
  const variablesAtCursor = variablesObject(variableStates);
  const bindings = new Map(
    definition.nodes.filter((node) => node.list).map((node) => [node.id, node.list!]),
  );
  const itemResolvers = new Map(
    [...bindings].map(([blockId, binding]) => [
      blockId,
      itemIndexResolver(binding, variableStates, variablesAtCursor),
    ]),
  );
  const timings = blockTimings(
    process.blocks.map((block) => block.id),
    visits,
    passSelector(process, nodeTypes),
    openVisitSeq,
    now,
    (blockId, visit) => itemResolvers.get(blockId)?.(visit) ?? null,
  );
  const lists = new Map(
    [...bindings].map(([blockId, binding]) => {
      const itemDurations = new Map<number, number>();
      for (const pass of timings.get(blockId)?.passes ?? []) {
        if (pass.itemIndex === null || pass.durationMs === null) continue;
        itemDurations.set(
          pass.itemIndex,
          (itemDurations.get(pass.itemIndex) ?? 0) + pass.durationMs,
        );
      }
      const resolved = resolveBlockList(binding, variablesAtCursor, itemDurations);
      if (resolved.diagnostic) diagnostics.push(`Block '${blockId}': ${resolved.diagnostic}`);
      return [blockId, resolved.list];
    }),
  );

  const nodes = definition.nodes.map((node, index): ExecutionProgressNode => {
    const run = statuses.get(node.id) ?? { status: "pending", iterations: 0, visits: 0 };
    const primaryNodeIds = primaryNodesByBlock.get(node.id) ?? [];
    const isActive = node.id === activeNodeId;
    const focusNodeId = isActive ? activePrimaryNodeId : (primaryNodeIds[0] ?? null);
    const labelTemplate =
      isActive && activeLabelNode?.progressActiveLabel
        ? activeLabelNode.progressActiveLabel
        : node.label;
    const content = resolveContent(
      node.content,
      isActive ? activeLabelNode?.progressActiveContent : undefined,
      templateProcessor,
      context,
    );
    if (run.status === "pending" || run.status === "skipped") content.outcome = null;
    const next = definition.nodes[index + 1];
    return {
      id: node.id,
      label: enforceResolvedLimit(
        templateProcessor.processDirective(labelTemplate, context).trim(),
        EXECUTION_PROGRESS_TEXT_LIMITS.nodeLabel,
        `nodes.${node.id}.label`,
      ),
      state: coarseState(run.status),
      status: run.status,
      iterations: run.iterations,
      visits: run.visits,
      currentNodeId: isActive ? activePrimaryNodeId : null,
      connections: next ? { default: next.id } : {},
      primaryNodeIds,
      focusNodeId,
      content,
      timing: timings.get(node.id) ?? {
        passes: [],
        totalMs: null,
        currentMs: null,
        recorded: false,
      },
      list: lists.get(node.id) ?? null,
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
    // A fact over a variable the run has not set yet (the template processor's undefined
    // marker) or that resolves to nothing is left out rather than shown as a marker.
    facts: (definition.facts ?? [])
      .map((fact) => ({
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
      }))
      .filter(
        (fact) =>
          fact.label !== "" &&
          fact.value !== "" &&
          !fact.label.includes(GraphTemplateProcessor.UNDEFINED_PLACEHOLDER) &&
          !fact.value.includes(GraphTemplateProcessor.UNDEFINED_PLACEHOLDER),
      ),
    activeNodeId,
    nodes,
    workflowVersion: workflow.metadata.version,
    executionWorkflowVersion: execution.workflowVersion ?? null,
    executionRevision: execution.revision,
    executionStatus: execution.status,
    diagnostics,
    process,
    route: projectRoute(process, visits),
    variables: variableStates,
    routeRecorded,
    cursor,
    source: "trace",
    projectedAt: now,
  };
}
