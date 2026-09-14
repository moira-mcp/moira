/**
 * Process derivation — the aggregated block view of a workflow, computed from its authored graph.
 *
 * A workflow that declares `progress` describes a process of blocks. Nothing about that process is
 * authored twice: blocks come from `progress.nodes` (in array order, which is the process order),
 * every authored node belongs to exactly one block through `progressNodeId`, transitions are the
 * authored edges that cross a block boundary, returns are edges that stay inside a block (node-level
 * back-edges) and any transition to a block at a lower index, and the human wording of a transition comes from `connectionLabels`
 * on the edge. Every rule the annotation can violate is reported as a diagnostic instead of being
 * silently repaired, so validation, the CLI, the API and the UI agree on the same facts.
 *
 * The function is pure: it never mutates the workflow and has no I/O.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { ConnectionLabel } from "../types/base-types.js";
import type { GraphNode } from "../types/graph-nodes.js";

export type ProcessDiagnosticCode =
  | "unowned-node"
  | "unknown-block"
  | "empty-block"
  | "empty-description"
  | "unlabeled-edge"
  | "unexplained-cycle"
  | "outcome-duplicate"
  | "outcome-unowned"
  | "unconnected-block"
  | "no-start";

export interface ProcessDiagnostic {
  code: ProcessDiagnosticCode;
  message: string;
  nodeId?: string;
  blockId?: string;
  /** Authored edge as "nodeId.key". */
  edge?: string;
}

export interface ProcessCycle {
  cause: string;
  exit: string;
}

export interface ProcessTransition {
  /** Target block id. */
  to: string;
  /** Human label of the transition. */
  label: string;
  /** Present when the transition returns to an earlier block or to the same block. */
  cycle?: ProcessCycle;
  /** Authored edges ("nodeId.key") this transition aggregates, in authored order. */
  edges: string[];
}

export interface ProcessBlock {
  id: string;
  label: string;
  /** `progress.nodes[].content.summary`, the mandatory block description. */
  description: string;
  /** Outcome template of the block, when it carries one. */
  outcome: string | null;
  /** Authored node ids owned by the block, in workflow order. */
  nodeIds: string[];
  transitions: ProcessTransition[];
}

export interface ProcessProjection {
  /** Blocks in process order (the authored array order of `progress.nodes`). */
  blocks: ProcessBlock[];
  /** Blocks that at least this many other blocks lead into. */
  hubs: string[];
  /** Node-level back-edges ("nodeId.key") found by the walk from the start node. */
  backEdges: string[];
  diagnostics: ProcessDiagnostic[];
}

export const HUB_IN_DEGREE = 3;

const OUTCOME_VARIABLE = /^\{\{\s*(progress_[A-Za-z0-9_]+_outcome)\s*\}\}$/;

function labelText(label: ConnectionLabel | undefined): string | undefined {
  if (label === undefined) return undefined;
  return typeof label === "string" ? label : label.label;
}

function cycleOf(label: ConnectionLabel | undefined): ProcessCycle | undefined {
  return typeof label === "object" ? label.cycle : undefined;
}

function connectionsOf(node: GraphNode): Array<[string, string]> {
  const connections = (node as { connections?: Record<string, string> }).connections ?? {};
  return Object.entries(connections);
}

/** Back-edges of the authored graph: edges whose target is on the DFS stack when they are walked. */
export function findBackEdges(nodes: GraphNode[], startId: string): Set<string> {
  const adjacency = new Map(nodes.map((n) => [n.id, connectionsOf(n)]));
  const color = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const [key, target] of adjacency.get(id) ?? []) {
      const state = color.get(target);
      if (state === 1) back.add(`${id}.${key}`);
      else if (state === undefined && adjacency.has(target)) visit(target);
    }
    color.set(id, 2);
  };
  if (adjacency.has(startId)) visit(startId);
  return back;
}

/** Variables a node writes: its declared global inputs. */
function writtenGlobals(node: GraphNode): string[] {
  const schema = (node as { inputSchema?: { globalInputs?: string[] } }).inputSchema;
  return schema?.globalInputs ?? [];
}

/**
 * Derive the process projection of a workflow. Returns null when the workflow declares no
 * `progress`; a workflow without `progress` has no block view and no diagnostics.
 */
export function deriveProcess(workflow: WorkflowGraph): ProcessProjection | null {
  const progress = workflow.progress;
  if (!progress) return null;
  const diagnostics: ProcessDiagnostic[] = [];
  const blockIds = new Set(progress.nodes.map((b) => b.id));
  const index = new Map(progress.nodes.map((b, i) => [b.id, i]));

  // Ownership.
  const owner = new Map<string, string>();
  const members = new Map<string, string[]>(progress.nodes.map((b) => [b.id, []]));
  for (const node of workflow.nodes) {
    const blockId = node.progressNodeId;
    if (!blockId) {
      diagnostics.push({
        code: "unowned-node",
        nodeId: node.id,
        message: `Node '${node.id}' must declare progressNodeId: every node belongs to exactly one progress block.`,
      });
      continue;
    }
    if (!blockIds.has(blockId)) {
      diagnostics.push({
        code: "unknown-block",
        nodeId: node.id,
        blockId,
        message: `Node '${node.id}' references unknown progress block '${blockId}'.`,
      });
      continue;
    }
    owner.set(node.id, blockId);
    members.get(blockId)!.push(node.id);
  }
  for (const block of progress.nodes) {
    if (!block.content?.summary?.trim()) {
      diagnostics.push({
        code: "empty-description",
        blockId: block.id,
        message: `Progress block '${block.id}' must carry a description in content.summary.`,
      });
    }
    if ((members.get(block.id) ?? []).length === 0) {
      diagnostics.push({
        code: "empty-block",
        blockId: block.id,
        message: `Progress block '${block.id}' owns no authored node.`,
      });
    }
  }

  // Outcome templates: each progress_*_outcome variable on exactly one block that owns a writer.
  const carriers = new Map<string, string[]>();
  for (const block of progress.nodes) {
    const match = block.content?.outcome ? OUTCOME_VARIABLE.exec(block.content.outcome) : null;
    if (!match) continue;
    const variable = match[1];
    carriers.set(variable, [...(carriers.get(variable) ?? []), block.id]);
  }
  for (const [variable, blocks] of carriers) {
    if (blocks.length > 1) {
      for (const blockId of blocks) {
        diagnostics.push({
          code: "outcome-duplicate",
          blockId,
          message: `Outcome variable '${variable}' is carried by ${blocks.length} progress blocks (${blocks.join(", ")}); exactly one block may carry it.`,
        });
      }
      continue;
    }
    const blockId = blocks[0];
    const writes = (members.get(blockId) ?? []).some((nodeId) => {
      const node = workflow.nodes.find((n) => n.id === nodeId);
      return node ? writtenGlobals(node).includes(variable) : false;
    });
    if (!writes) {
      diagnostics.push({
        code: "outcome-unowned",
        blockId,
        message: `Progress block '${blockId}' carries outcome variable '${variable}' but owns no node that writes it.`,
      });
    }
  }

  // Cycles at node level.
  const start = workflow.nodes.find((n) => n.type === "start");
  if (!start) diagnostics.push({ code: "no-start", message: "Workflow has no start node." });
  const backEdges = start ? findBackEdges(workflow.nodes, start.id) : new Set<string>();

  // Transitions: boundary edges, plus back-edges that stay inside a block.
  const transitionsByBlock = new Map<string, ProcessTransition[]>(
    progress.nodes.map((b) => [b.id, []]),
  );
  for (const node of workflow.nodes) {
    const from = owner.get(node.id);
    if (!from) continue;
    for (const [key, target] of connectionsOf(node)) {
      const to = owner.get(target);
      if (!to) continue;
      const edgeId = `${node.id}.${key}`;
      const isBack = backEdges.has(edgeId);
      if (from === to && !isBack) continue;
      const raw = node.connectionLabels?.[key];
      let label = labelText(raw);
      if (!label) {
        diagnostics.push({
          code: "unlabeled-edge",
          nodeId: node.id,
          edge: edgeId,
          message: `Edge '${edgeId}' crosses from block '${from}' to '${to}' (or returns) and must carry a connectionLabels entry.`,
        });
        label = edgeId;
      }
      let cycle = cycleOf(raw);
      // A return is an edge that stays inside its block (a node-level back-edge) or one that
      // leads to a block earlier in process order. A boundary edge to a later block is forward
      // even when the node walk happened to classify it as a back-edge; its author may still
      // explain it as a cycle through the label.
      const returns = from === to || index.get(to)! < index.get(from)!;
      if (returns && !cycle) {
        diagnostics.push({
          code: "unexplained-cycle",
          nodeId: node.id,
          edge: edgeId,
          message: `Edge '${edgeId}' returns from block '${from}' to '${to}' and must explain the cycle (connectionLabels.${key}.cycle with cause and exit).`,
        });
        cycle = { cause: label, exit: "" };
      }
      const list = transitionsByBlock.get(from)!;
      const same = list.find(
        (t) => t.to === to && t.label === label && Boolean(t.cycle) === Boolean(cycle),
      );
      if (same) {
        same.edges.push(edgeId);
        continue;
      }
      // A transition is a cycle when it returns, or when its author explained it as one.
      list.push(cycle ? { to, label, cycle, edges: [edgeId] } : { to, label, edges: [edgeId] });
    }
  }

  const inDegree = new Map<string, Set<string>>(progress.nodes.map((b) => [b.id, new Set()]));
  for (const [from, list] of transitionsByBlock) {
    for (const t of list) if (t.to !== from) inDegree.get(t.to)?.add(from);
  }

  // Connectivity: every block takes part in the process through at least one transition to or
  // from another block; a self-return alone connects a block to nothing. The block owning the
  // start node is exempt (a one-block process leads nowhere), and a terminal block — one owning an
  // `end` node that another block leads into — is connected by that incoming transition.
  const startBlock = start ? owner.get(start.id) : undefined;
  for (const block of progress.nodes) {
    if (block.id === startBlock) continue;
    const leadsOut = (transitionsByBlock.get(block.id) ?? []).some((t) => t.to !== block.id);
    const ledInto = (inDegree.get(block.id)?.size ?? 0) > 0;
    if (leadsOut || ledInto) continue;
    diagnostics.push({
      code: "unconnected-block",
      blockId: block.id,
      message: `Progress block '${block.id}' has no transition to or from another block; every block except the start block and a terminal block must be connected to the process.`,
    });
  }

  const blocks: ProcessBlock[] = progress.nodes.map((block) => ({
    id: block.id,
    label: block.label,
    description: block.content?.summary ?? "",
    outcome: block.content?.outcome ?? null,
    nodeIds: members.get(block.id) ?? [],
    transitions: transitionsByBlock.get(block.id) ?? [],
  }));

  return {
    blocks,
    hubs: progress.nodes
      .filter((b) => (inDegree.get(b.id)?.size ?? 0) >= HUB_IN_DEGREE)
      .map((b) => b.id),
    backEdges: [...backEdges],
    diagnostics,
  };
}
