/**
 * Structural mutations of the node graph: add a node, insert one on an edge, remove one while
 * deciding every incoming edge, rename one with all its references, and set or remove a
 * connection. Each returns a new graph and never mutates its input; an invalid request throws an
 * `AuthoringError` whose message names the node, key or edge.
 *
 * Structure and the process contract are separate concerns: these functions keep the graph
 * well-formed (no dangling connection they could have prevented, unique kebab-case ids, a block for
 * every new node of a process-annotated flow) and leave the contract — labels on boundary edges,
 * explained returns — to `deriveProcess`, which reports what is still missing.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { ConnectionLabel } from "../types/base-types.js";
import type { GraphNode } from "../types/graph-nodes.js";
import { AuthoringError } from "./errors.js";
import { isValidConnectionKey, isValidNodeId, NODE_ID_PATTERN } from "./node-id.js";
import { primaryOutputOf } from "./outputs.js";
import { clone, requireNode, type EditableNode } from "./process.js";
import { rewriteNodeReferences, type ReferenceLocation } from "./references.js";

/** An edge, addressed the way the process derivation addresses it: `<node>.<key>`. */
export interface Edge {
  source: string;
  key: string;
  target: string;
}

export function edgeId(source: string, key: string): string {
  return `${source}.${key}`;
}

/** Every connection that leads into `nodeId` from another node. */
export function incomingEdges(workflow: WorkflowGraph, nodeId: string): Edge[] {
  const edges: Edge[] = [];
  for (const node of workflow.nodes as EditableNode[]) {
    if (node.id === nodeId) continue;
    for (const [key, target] of Object.entries(node.connections ?? {})) {
      if (target === nodeId) edges.push({ source: node.id, key, target });
    }
  }
  return edges;
}

function assertNewId(workflow: WorkflowGraph, id: string): void {
  if (!isValidNodeId(id)) {
    throw new AuthoringError(
      "invalid-node-id",
      `Node id '${id}' must be kebab-case (${NODE_ID_PATTERN.source})`,
    );
  }
  if (workflow.nodes.some((n) => n.id === id)) {
    throw new AuthoringError("node-exists", `Node already exists: ${id}`);
  }
}

function assertBlock(workflow: WorkflowGraph, blockId: string): void {
  if (!workflow.progress?.nodes.some((b) => b.id === blockId)) {
    throw new AuthoringError("block-not-found", `Progress block not found: ${blockId}`);
  }
}

/**
 * Add a node. In a flow with a process view every node belongs to a block: `blockId` (or the node's
 * own `progressNodeId`) must name an existing block. The node is not connected; until an edge leads
 * to it, validation reports it as unreachable.
 */
export function addNode(
  workflow: WorkflowGraph,
  node: GraphNode,
  options: { blockId?: string } = {},
): WorkflowGraph {
  assertNewId(workflow, node.id);
  if (node.type === "start" && workflow.nodes.some((n) => n.type === "start")) {
    throw new AuthoringError("duplicate-start", "A workflow has exactly one start node");
  }
  const next = clone(workflow);
  const added = clone(node) as EditableNode;
  if (next.progress) {
    const blockId = options.blockId ?? added.progressNodeId;
    if (!blockId) {
      throw new AuthoringError(
        "block-required",
        `Node '${node.id}' needs a block in a process-annotated flow`,
      );
    }
    assertBlock(next, blockId);
    added.progressNodeId = blockId;
  } else if (options.blockId) {
    throw new AuthoringError(
      "no-progress",
      "Workflow has no progress definition to place the node in",
    );
  }
  next.nodes.push(added);
  return next;
}

/**
 * Split the edge `source.key → B` into `source.key → node → B`: the new node continues to `B`
 * through its primary output. It joins the source's block unless `blockId` names another. The
 * edge's label (with its return explanation) moves with the part of the edge that crosses a block
 * boundary: it stays on `source.key` when the new node is in another block than the source, and
 * moves to the new node's output otherwise.
 */
export function insertNodeOnEdge(
  workflow: WorkflowGraph,
  edge: { source: string; key: string },
  node: GraphNode,
  options: { blockId?: string } = {},
): WorkflowGraph {
  const source = requireNode(workflow, edge.source);
  const target = source.connections?.[edge.key];
  if (!target) {
    throw new AuthoringError(
      "connection-not-found",
      `Node '${edge.source}' has no connection '${edge.key}'`,
    );
  }
  const output = primaryOutputOf(node.type);
  if (!output) {
    throw new AuthoringError(
      "terminal-node",
      `A node of type '${node.type}' has no output to continue through`,
    );
  }
  // Without a process view there are no blocks: a requested block is refused by addNode.
  const blockId = workflow.progress ? (options.blockId ?? source.progressNodeId) : options.blockId;
  const next = addNode(
    workflow,
    {
      ...node,
      connections: { ...((node as EditableNode).connections ?? {}), [output]: target },
    } as GraphNode,
    blockId ? { blockId } : {},
  );
  const nextSource = requireNode(next, edge.source);
  nextSource.connections = { ...(nextSource.connections ?? {}), [edge.key]: node.id };
  const label = nextSource.connectionLabels?.[edge.key];
  if (label !== undefined && next.progress && blockId === nextSource.progressNodeId) {
    const added = requireNode(next, node.id);
    added.connectionLabels = {
      ...(added.connectionLabels ?? {}),
      [output]: label as ConnectionLabel,
    };
    delete nextSource.connectionLabels![edge.key];
    if (Object.keys(nextSource.connectionLabels!).length === 0) delete nextSource.connectionLabels;
  }
  return next;
}

/**
 * What to do with one incoming edge of a node being removed: the id of the node it should lead to
 * instead, or `null` to remove the connection.
 */
export type IncomingDecision = string | null;

/**
 * Remove a node. Every incoming edge needs a decision, keyed by its edge id `<source>.<key>`:
 * retarget it to another node, or remove it. An edge left without a decision is refused, so a
 * removal never leaves a connection pointing at nothing. The node's own outputs and labels go with
 * it, and so do its entries in `runtimePolicy` write allowances. Template references to its values
 * are left for validation to report.
 */
export function removeNode(
  workflow: WorkflowGraph,
  nodeId: string,
  decisions: Record<string, IncomingDecision> = {},
): WorkflowGraph {
  const node = requireNode(workflow, nodeId);
  if (node.type === "start") {
    throw new AuthoringError("only-start", "The start node cannot be removed");
  }
  const incoming = incomingEdges(workflow, nodeId);
  const undecided = incoming.filter((e) => !(edgeId(e.source, e.key) in decisions));
  if (undecided.length > 0) {
    throw new AuthoringError(
      "incoming-edge-undecided",
      `Node '${nodeId}' is the target of ${undecided.map((e) => edgeId(e.source, e.key)).join(", ")}; retarget or remove each`,
    );
  }
  const next = clone(workflow);
  for (const edge of incoming) {
    const decision = decisions[edgeId(edge.source, edge.key)];
    const source = requireNode(next, edge.source);
    if (decision === null) {
      if (primaryOutputOf(source.type) === edge.key) {
        throw new AuthoringError(
          "protected-output",
          `'${edgeId(edge.source, edge.key)}' is the primary output of '${edge.source}' and cannot be removed; retarget it`,
        );
      }
      delete source.connections![edge.key];
      if (source.connectionLabels?.[edge.key] !== undefined) {
        delete source.connectionLabels[edge.key];
        if (Object.keys(source.connectionLabels).length === 0) delete source.connectionLabels;
      }
    } else {
      if (decision === nodeId || !next.nodes.some((n) => n.id === decision)) {
        throw new AuthoringError(
          "invalid-target",
          `'${edgeId(edge.source, edge.key)}' cannot be retargeted to '${decision}'`,
        );
      }
      source.connections![edge.key] = decision;
    }
  }
  next.nodes = next.nodes.filter((n) => n.id !== nodeId);
  const writes = next.runtimePolicy?.externalVariableWrites;
  if (writes) {
    for (const policy of Object.values(writes)) {
      if (policy?.allowedNodeIds) {
        policy.allowedNodeIds = policy.allowedNodeIds.filter((id) => id !== nodeId);
      }
    }
  }
  return next;
}

/**
 * Rename a node and every reference to it: connection targets and all the reference forms
 * `rewriteNodeReferences` knows. Prose that mentions the id outside a reference is not changed.
 * Returns the new graph and the rewritten reference locations with counts.
 */
export function renameNode(
  workflow: WorkflowGraph,
  from: string,
  to: string,
): { workflow: WorkflowGraph; rewritten: ReferenceLocation[] } {
  requireNode(workflow, from);
  if (from === to) return { workflow, rewritten: [] };
  assertNewId(workflow, to);
  const referenced = rewriteNodeReferences(workflow, from, to);
  const next = clone(referenced.workflow);
  // Locations inside the renamed node are reported under its new id, like every other location.
  const renamedAt = `nodes[${from}]`;
  const rewritten = referenced.rewritten.map((location) =>
    location.path.startsWith(`${renamedAt}.`)
      ? { ...location, path: `nodes[${to}]${location.path.slice(renamedAt.length)}` }
      : location,
  );
  for (const node of next.nodes as EditableNode[]) {
    if (node.id === from) node.id = to;
    let count = 0;
    for (const [key, target] of Object.entries(node.connections ?? {})) {
      if (target === from) {
        node.connections![key] = to;
        count++;
      }
    }
    if (count > 0) rewritten.push({ path: `nodes[${node.id}].connections`, count });
  }
  return { workflow: next, rewritten };
}

/**
 * Point `source.key` at `target`, creating the connection when the key is new. An end node has no
 * outputs; keys may not contain a dot.
 */
export function setConnection(
  workflow: WorkflowGraph,
  source: string,
  key: string,
  target: string,
): WorkflowGraph {
  const node = requireNode(workflow, source);
  if (node.type === "end") {
    throw new AuthoringError("terminal-node", `End node '${source}' has no outputs`);
  }
  if (!isValidConnectionKey(key)) {
    throw new AuthoringError(
      "invalid-connection-key",
      `Connection key '${key}' may use letters, digits, '_' and '-' only`,
    );
  }
  requireNode(workflow, target);
  const next = clone(workflow);
  const nextNode = requireNode(next, source);
  nextNode.connections = { ...(nextNode.connections ?? {}), [key]: target };
  return next;
}

/**
 * Remove the connection `source.key` and its label. The primary output of a node cannot be
 * removed. A key that a routing case names may be removed; validation then reports the case.
 */
export function removeConnection(
  workflow: WorkflowGraph,
  source: string,
  key: string,
): WorkflowGraph {
  const node = requireNode(workflow, source);
  if (!node.connections || !(key in node.connections)) {
    throw new AuthoringError("connection-not-found", `Node '${source}' has no connection '${key}'`);
  }
  if (primaryOutputOf(node.type) === key) {
    throw new AuthoringError(
      "protected-output",
      `'${edgeId(source, key)}' is the primary output of '${source}' and cannot be removed`,
    );
  }
  const next = clone(workflow);
  const nextNode = requireNode(next, source);
  delete nextNode.connections![key];
  if (nextNode.connectionLabels?.[key] !== undefined) {
    delete nextNode.connectionLabels[key];
    if (Object.keys(nextNode.connectionLabels).length === 0) delete nextNode.connectionLabels;
  }
  return next;
}
