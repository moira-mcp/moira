/**
 * Mutations of the process block contract: the label (and optional return explanation) of one
 * connection, which block a node belongs to, and adding, editing or removing a block. Each returns
 * a new graph and never mutates its input; an invalid target throws an `AuthoringError` whose
 * message names it.
 */

import type {
  ProgressListBinding,
  WorkflowGraph,
  WorkflowProgressNode,
} from "../interfaces/core-interfaces.js";
import type { ConnectionLabel } from "../types/base-types.js";
import type { GraphNode } from "../types/graph-nodes.js";
import { AuthoringError } from "./errors.js";

export interface CycleExplanation {
  cause: string;
  exit: string;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export type EditableNode = GraphNode & {
  connections?: Record<string, string>;
  connectionLabels?: Record<string, ConnectionLabel>;
};

export function requireNode(workflow: WorkflowGraph, nodeId: string): EditableNode {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (!node) throw new AuthoringError("node-not-found", `Node not found: ${nodeId}`);
  return node as EditableNode;
}

function requireProgress(workflow: WorkflowGraph): NonNullable<WorkflowGraph["progress"]> {
  if (!workflow.progress) {
    throw new AuthoringError(
      "no-progress",
      "Workflow has no progress definition; add a block first with add-block",
    );
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
  const node = requireNode(next, nodeId);
  if (!node.connections || !(key in node.connections)) {
    throw new AuthoringError(
      "connection-not-found",
      `Node '${nodeId}' has no connection '${key}' (has: ${Object.keys(node.connections ?? {}).join(", ") || "none"})`,
    );
  }
  const text = label.trim();
  if (!text) throw new AuthoringError("invalid-label", "Label must not be empty");
  if (cycle && (!cycle.cause.trim() || !cycle.exit.trim())) {
    throw new AuthoringError("invalid-label", "A cycle explanation needs both a cause and an exit");
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
  const node = requireNode(next, nodeId);
  if (!node.connectionLabels || !(key in node.connectionLabels)) {
    throw new AuthoringError(
      "label-not-found",
      `Node '${nodeId}' has no label for connection '${key}'`,
    );
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
    throw new AuthoringError(
      "block-not-found",
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
    throw new AuthoringError("invalid-block", "A block needs an id, a label and a summary");
  }
  next.progress ??= { nodes: [] };
  if (next.progress.nodes.some((b) => b.id === block.id)) {
    throw new AuthoringError("block-exists", `Progress block already exists: ${block.id}`);
  }
  const entry: WorkflowProgressNode = {
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
  if (index === -1)
    throw new AuthoringError("block-not-found", `Progress block not found: ${after}`);
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
  if (!block) throw new AuthoringError("block-not-found", `Progress block not found: ${blockId}`);
  if (patch.label !== undefined) {
    if (!patch.label.trim()) throw new AuthoringError("invalid-block", "Label must not be empty");
    block.label = patch.label;
  }
  const content = { ...(block.content ?? {}) };
  if (patch.summary !== undefined) {
    if (!patch.summary.trim())
      throw new AuthoringError("invalid-block", "Summary must not be empty");
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

/**
 * Remove a block that no node belongs to. A block that still owns a node is refused: its steps
 * must be moved or deleted first, so no node is left pointing at a block that does not exist.
 */
export function removeBlock(workflow: WorkflowGraph, blockId: string): WorkflowGraph {
  const progress = requireProgress(workflow);
  if (!progress.nodes.some((b) => b.id === blockId)) {
    throw new AuthoringError("block-not-found", `Progress block not found: ${blockId}`);
  }
  const owners = workflow.nodes.filter((n) => n.progressNodeId === blockId).map((n) => n.id);
  if (owners.length > 0) {
    throw new AuthoringError(
      "block-not-empty",
      `Progress block '${blockId}' still owns nodes: ${owners.join(", ")}`,
    );
  }
  const next = clone(workflow);
  const nextProgress = requireProgress(next);
  nextProgress.nodes = nextProgress.nodes
    .filter((b) => b.id !== blockId)
    .map((b) => {
      if (b.connections?.default !== blockId) return b;
      const { default: _removed, ...rest } = b.connections;
      return Object.keys(rest).length
        ? { ...b, connections: rest }
        : { ...b, connections: undefined };
    })
    .map((b) => {
      if (b.connections !== undefined) return b;
      const { connections: _unused, ...rest } = b;
      return rest;
    });
  return next;
}
