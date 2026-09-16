/**
 * Authoring mutations for the process block contract, as pure functions over a workflow graph:
 * set the label (and optional cycle explanation) of one connection, move a node to a block, and
 * add or edit a progress block with its description. The CLI applies them behind its usual
 * backup, validation and save; scripts may apply them directly. Each function returns a new
 * graph and never mutates its input; invalid targets throw with a message that names them.
 */

import type { WorkflowGraph, ProgressListBinding } from "@mcp-moira/workflow-engine";
import type { ConnectionLabel, GraphNode } from "@mcp-moira/workflow-engine/types";

export interface CycleExplanation {
  cause: string;
  exit: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireNode(workflow: WorkflowGraph, nodeId: string): GraphNode {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function requireProgress(workflow: WorkflowGraph): NonNullable<WorkflowGraph["progress"]> {
  if (!workflow.progress) {
    throw new Error("Workflow has no progress definition; add a block first with add-block");
  }
  return workflow.progress;
}

/** Set `connectionLabels[key]` on a node; `cycle` marks the connection as an explained return. */
export function setConnectionLabel(
  workflow: WorkflowGraph,
  nodeId: string,
  key: string,
  label: string,
  cycle?: CycleExplanation,
): WorkflowGraph {
  const next = clone(workflow);
  const node = requireNode(next, nodeId) as GraphNode & {
    connections?: Record<string, string>;
    connectionLabels?: Record<string, ConnectionLabel>;
  };
  if (!node.connections || !(key in node.connections)) {
    throw new Error(
      `Node '${nodeId}' has no connection '${key}' (has: ${Object.keys(node.connections ?? {}).join(", ") || "none"})`,
    );
  }
  const text = label.trim();
  if (!text) throw new Error("Label must not be empty");
  if (cycle && (!cycle.cause.trim() || !cycle.exit.trim())) {
    throw new Error("A cycle explanation needs both a cause and an exit");
  }
  node.connectionLabels = {
    ...(node.connectionLabels ?? {}),
    [key]: cycle
      ? { label: text, cycle: { cause: cycle.cause.trim(), exit: cycle.exit.trim() } }
      : text,
  };
  return next;
}

/** Remove the label of one connection. */
export function clearConnectionLabel(
  workflow: WorkflowGraph,
  nodeId: string,
  key: string,
): WorkflowGraph {
  const next = clone(workflow);
  const node = requireNode(next, nodeId) as GraphNode & {
    connectionLabels?: Record<string, ConnectionLabel>;
  };
  if (!node.connectionLabels || !(key in node.connectionLabels)) {
    throw new Error(`Node '${nodeId}' has no label for connection '${key}'`);
  }
  delete node.connectionLabels[key];
  if (Object.keys(node.connectionLabels).length === 0) delete node.connectionLabels;
  return next;
}

/** Move a node to a block (sets `progressNodeId`); the block must exist. */
export function setNodeBlock(
  workflow: WorkflowGraph,
  nodeId: string,
  blockId: string,
): WorkflowGraph {
  const next = clone(workflow);
  const node = requireNode(next, nodeId);
  const progress = requireProgress(next);
  if (!progress.nodes.some((b) => b.id === blockId)) {
    throw new Error(
      `Progress block not found: ${blockId} (blocks: ${progress.nodes.map((b) => b.id).join(", ")})`,
    );
  }
  node.progressNodeId = blockId;
  return next;
}

export interface BlockInput {
  id: string;
  label: string;
  /** The block description (`content.summary`). */
  summary: string;
  /** Optional outcome template, e.g. `{{progress_plan_outcome}}`. */
  outcome?: string;
  /** Optional `content.next`. */
  next?: string;
  /** Optional list binding; `null` removes it on edit. */
  list?: ProgressListBinding | null;
}

/** Parse a `--list` value: a JSON binding object, or `none` to remove the binding. */
export function parseListBinding(value: string): ProgressListBinding | null {
  if (value === "none") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      '--list expects a JSON object such as {"items":"tasks","current":"current_task"}',
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--list expects a JSON object");
  }
  const binding = parsed as Record<string, unknown>;
  const allowed = new Set(["items", "title", "current", "done", "total", "indexBase"]);
  for (const key of Object.keys(binding)) {
    if (!allowed.has(key)) throw new Error(`--list: unknown field '${key}'`);
  }
  for (const key of ["items", "title", "current", "done", "total"]) {
    if (binding[key] !== undefined && (typeof binding[key] !== "string" || !binding[key])) {
      throw new Error(`--list: '${key}' must be a non-empty variable path`);
    }
  }
  if (binding.indexBase !== undefined && binding.indexBase !== 0 && binding.indexBase !== 1) {
    throw new Error("--list: 'indexBase' must be 0 or 1");
  }
  if (!binding.items && !binding.current && !binding.total) {
    throw new Error("--list needs at least one of items, current or total");
  }
  return binding as ProgressListBinding;
}

/**
 * Add a block. Without `after` it is appended; with `after` it is inserted right after that block
 * (array order is process order). Creates the progress definition when the workflow has none.
 */
export function addBlock(
  workflow: WorkflowGraph,
  block: BlockInput,
  after?: string,
): WorkflowGraph {
  const next = clone(workflow);
  if (!block.id.trim() || !block.label.trim() || !block.summary.trim()) {
    throw new Error("A block needs an id, a label and a summary");
  }
  next.progress ??= { nodes: [] };
  if (next.progress.nodes.some((b) => b.id === block.id)) {
    throw new Error(`Progress block already exists: ${block.id}`);
  }
  const entry = {
    id: block.id,
    label: block.label,
    content: {
      summary: block.summary,
      ...(block.outcome ? { outcome: block.outcome } : {}),
      ...(block.next ? { next: block.next } : {}),
    },
    ...(block.list ? { list: block.list } : {}),
  };
  if (after === undefined) {
    next.progress.nodes.push(entry);
    return next;
  }
  const index = next.progress.nodes.findIndex((b) => b.id === after);
  if (index === -1) throw new Error(`Progress block not found: ${after}`);
  next.progress.nodes.splice(index + 1, 0, entry);
  return next;
}

/** Edit a block's label, summary, outcome or next; omitted fields stay as they are. */
export function editBlock(
  workflow: WorkflowGraph,
  blockId: string,
  patch: Partial<Omit<BlockInput, "id">>,
): WorkflowGraph {
  const next = clone(workflow);
  const progress = requireProgress(next);
  const block = progress.nodes.find((b) => b.id === blockId);
  if (!block) throw new Error(`Progress block not found: ${blockId}`);
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new Error("Label must not be empty");
    block.label = patch.label;
  }
  const content = { ...(block.content ?? {}) };
  if (patch.summary !== undefined) {
    if (!patch.summary.trim()) throw new Error("Summary must not be empty");
    content.summary = patch.summary;
  }
  if (patch.outcome !== undefined) {
    if (patch.outcome.trim()) content.outcome = patch.outcome;
    else delete content.outcome;
  }
  if (patch.next !== undefined) {
    if (patch.next.trim()) content.next = patch.next;
    else delete content.next;
  }
  block.content = content;
  if (patch.list !== undefined) {
    if (patch.list === null) delete block.list;
    else block.list = patch.list;
  }
  return next;
}
