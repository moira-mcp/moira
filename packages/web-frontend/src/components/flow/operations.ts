/**
 * The flow page's edit log — every change to the workflow definition as an ordered operation over
 * the saved definition, held in memory until saved.
 *
 * The draft is the fold of the log over the saved definition; nothing here mutates the saved
 * graph. Content operations (a block's name or description, a transition's label with its loop, a
 * step's block, a step's authored text, a registry entry) are applied as typed, so a half-typed
 * value stays in the draft and the process derivation reports it; consecutive edits of the same
 * field coalesce into one operation, so undo steps over whole edits rather than keystrokes.
 * Structural operations (add — alone or as the target of an output —, insert, remove and rename a
 * node, set or remove a connection, add
 * or remove a block) go through the engine's authoring functions: `appendOperation` applies one
 * to the current draft first, so a refused operation throws its `AuthoringError` and never enters
 * the log. `exportDiff` compares the saved definition with the draft, following node ids through
 * renames, and names exactly the flow-file entries that change.
 */

import {
  addBlock,
  addNode,
  insertNodeOnEdge,
  removeBlock,
  removeConnection,
  removeNode,
  renameNode,
  setConnection,
  type BlockInput,
  type IncomingDecision,
  type ReferenceLocation,
} from "@mcp-moira/workflow-engine/authoring";
import type {
  ConnectionLabel,
  RegistryVariable,
  WorkflowGraph,
  WorkflowNode,
} from "../../types/workflow-types";

/** Node fields the page edits in place. */
export type NodeTextField = "directive" | "completionCondition" | "message" | "expressions";

export type ContentOperation =
  | { kind: "block-text"; blockId: string; field: "label" | "summary"; value: string }
  /** One label for every authored edge of a transition (edge ids are `node.key`). */
  | { kind: "connection-label"; edges: string[]; value: ConnectionLabel }
  | { kind: "node-block"; nodeId: string; blockId: string }
  | { kind: "node-text"; nodeId: string; field: NodeTextField; value: string | string[] }
  /** A replaced registry entry, or null for a removed declaration. */
  | { kind: "registry"; name: string; entry: RegistryVariable | null };

export type StructuralOperation =
  | { kind: "add-node"; node: WorkflowNode; blockId?: string }
  /** A new step that the output `<source>.<key>` leads to (created, or retargeted, with it). */
  | {
      kind: "add-connected-node";
      node: WorkflowNode;
      blockId?: string;
      source: string;
      key: string;
    }
  | { kind: "insert-on-edge"; source: string; key: string; node: WorkflowNode; blockId?: string }
  /** Every incoming edge `<source>.<key>` decided: a node to lead to instead, or null to drop it. */
  | { kind: "remove-node"; nodeId: string; decisions: Record<string, IncomingDecision> }
  | { kind: "rename-node"; from: string; to: string }
  | { kind: "set-connection"; source: string; key: string; target: string }
  | { kind: "remove-connection"; source: string; key: string }
  | { kind: "add-block"; block: BlockInput; after?: string }
  | { kind: "remove-block"; blockId: string };

export type Operation = ContentOperation | StructuralOperation;

// The engine's authoring functions and the page describe the same JSON with two type
// declarations; the conversion is a cast in both directions.
type EngineGraph = Parameters<typeof addNode>[0];
type EngineNode = Parameters<typeof addNode>[1];
const toEngine = (graph: WorkflowGraph): EngineGraph => graph as unknown as EngineGraph;
const fromEngine = (graph: EngineGraph): WorkflowGraph => graph as unknown as WorkflowGraph;
const engineNode = (node: WorkflowNode): EngineNode => node as unknown as EngineNode;

function mapNodes(
  workflow: WorkflowGraph,
  nodeId: string,
  change: (node: WorkflowNode) => WorkflowNode,
): WorkflowGraph {
  if (!workflow.nodes.some((n) => n.id === nodeId)) return workflow;
  return { ...workflow, nodes: workflow.nodes.map((n) => (n.id === nodeId ? change(n) : n)) };
}

function applyContent(workflow: WorkflowGraph, op: ContentOperation): WorkflowGraph {
  switch (op.kind) {
    case "block-text": {
      if (!workflow.progress?.nodes.some((b) => b.id === op.blockId)) return workflow;
      return {
        ...workflow,
        progress: {
          ...workflow.progress,
          nodes: workflow.progress.nodes.map((block) =>
            block.id !== op.blockId
              ? block
              : op.field === "label"
                ? { ...block, label: op.value }
                : { ...block, content: { ...(block.content ?? {}), summary: op.value } },
          ),
        },
      };
    }
    case "connection-label": {
      let next = workflow;
      for (const edge of op.edges) {
        const dot = edge.indexOf(".");
        const key = edge.slice(dot + 1);
        next = mapNodes(next, edge.slice(0, dot), (node) => ({
          ...node,
          connectionLabels: { ...(node.connectionLabels ?? {}), [key]: op.value },
        }));
      }
      return next;
    }
    case "node-block":
      return mapNodes(workflow, op.nodeId, (node) => ({ ...node, progressNodeId: op.blockId }));
    case "node-text":
      return mapNodes(
        workflow,
        op.nodeId,
        (node) => ({ ...node, [op.field]: op.value }) as WorkflowNode,
      );
    case "registry": {
      const variableRegistry = { ...(workflow.variableRegistry ?? {}) };
      if (op.entry === null) delete variableRegistry[op.name];
      else variableRegistry[op.name] = op.entry;
      return { ...workflow, variableRegistry };
    }
  }
}

/** What a structural operation did besides producing the graph: a rename's rewritten references. */
interface Applied {
  workflow: WorkflowGraph;
  rewritten?: ReferenceLocation[];
}

function applyStructural(workflow: WorkflowGraph, op: StructuralOperation): Applied {
  const graph = toEngine(workflow);
  const block = (blockId?: string) => (blockId ? { blockId } : {});
  switch (op.kind) {
    case "add-node":
      return { workflow: fromEngine(addNode(graph, engineNode(op.node), block(op.blockId))) };
    case "add-connected-node": {
      const added = addNode(graph, engineNode(op.node), block(op.blockId));
      return { workflow: fromEngine(setConnection(added, op.source, op.key, op.node.id)) };
    }
    case "insert-on-edge":
      return {
        workflow: fromEngine(
          insertNodeOnEdge(
            graph,
            { source: op.source, key: op.key },
            engineNode(op.node),
            block(op.blockId),
          ),
        ),
      };
    case "remove-node":
      return { workflow: fromEngine(removeNode(graph, op.nodeId, op.decisions)) };
    case "rename-node": {
      const renamed = renameNode(graph, op.from, op.to);
      return { workflow: fromEngine(renamed.workflow), rewritten: renamed.rewritten };
    }
    case "set-connection":
      return { workflow: fromEngine(setConnection(graph, op.source, op.key, op.target)) };
    case "remove-connection":
      return { workflow: fromEngine(removeConnection(graph, op.source, op.key)) };
    case "add-block":
      return { workflow: fromEngine(addBlock(graph, op.block, op.after)) };
    case "remove-block":
      return { workflow: fromEngine(removeBlock(graph, op.blockId)) };
  }
}

function isContent(op: Operation): op is ContentOperation {
  return (
    op.kind === "block-text" ||
    op.kind === "connection-label" ||
    op.kind === "node-block" ||
    op.kind === "node-text" ||
    op.kind === "registry"
  );
}

/** The graph after one operation; a refused structural operation throws `AuthoringError`. */
export function applyOperation(workflow: WorkflowGraph, op: Operation): WorkflowGraph {
  return isContent(op) ? applyContent(workflow, op) : applyStructural(workflow, op).workflow;
}

/**
 * The field a typed edit targets, so the next keystroke replaces it instead of adding an entry;
 * null for a discrete action (moving a step, any structural operation), which is always its own.
 */
function coalesceKey(op: Operation): string | null {
  switch (op.kind) {
    case "block-text":
      return `block:${op.blockId}:${op.field}`;
    case "connection-label":
      return `label:${op.edges.join(",")}`;
    case "node-text":
      return `node:${op.nodeId}:${op.field}`;
    case "registry":
      return `registry:${op.name}`;
    default:
      return null;
  }
}

/** The draft: the saved definition with every operation applied. The saved graph is untouched. */
export function foldOperations(saved: WorkflowGraph, ops: readonly Operation[]): WorkflowGraph {
  return ops.reduce(applyOperation, saved);
}

/**
 * The log with `op` appended to it — or merged into the last entry when both edit the same field.
 * `draft` is the fold of `ops`; the operation is applied to it first, so a refused structural
 * operation throws and the log is left as it was.
 */
export function appendOperation(
  draft: WorkflowGraph,
  ops: readonly Operation[],
  op: Operation,
): Operation[] {
  if (!isContent(op)) applyStructural(draft, op);
  const key = coalesceKey(op);
  const last = ops[ops.length - 1];
  if (key !== null && last !== undefined && coalesceKey(last) === key) {
    return [...ops.slice(0, -1), op];
  }
  return [...ops, op];
}

// --- Export

export type ExportEntry =
  /** A flow-file value that changes: its JSON path, the saved value and the draft's. */
  | { kind: "change"; path: string; before: unknown; after: unknown }
  | { kind: "add-node"; id: string }
  | { kind: "remove-node"; id: string }
  /** A saved node under a new id, with the references the rename rewrote, per location. */
  | { kind: "rename-node"; from: string; to: string; rewritten: ReferenceLocation[] }
  | { kind: "add-block"; id: string }
  | { kind: "remove-block"; id: string };

/** One line of the export: how the entry reads as text. */
export function exportLine(entry: ExportEntry): string {
  switch (entry.kind) {
    case "change":
      return `${entry.path}: ${JSON.stringify(entry.before)} → ${JSON.stringify(entry.after)}`;
    case "add-node":
      return `+ node ${entry.id}`;
    case "remove-node":
      return `- node ${entry.id}`;
    case "rename-node":
      return `node ${entry.from} → ${entry.to}${
        entry.rewritten.length
          ? ` (${entry.rewritten.map((r) => `${r.path} ×${r.count}`).join(", ")})`
          : ""
      }`;
    case "add-block":
      return `+ block ${entry.id}`;
    case "remove-block":
      return `- block ${entry.id}`;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Rewrite the node id inside a flow-file path (`nodes[<from>]…`) after a later rename. */
function renamePath(path: string, from: string, to: string): string {
  const head = `nodes[${from}]`;
  return path.startsWith(head) ? `nodes[${to}]${path.slice(head.length)}` : path;
}

interface Lineage {
  draft: WorkflowGraph;
  /** Current node id → the saved id it descends from, or null for a node the draft added. */
  origin: Map<string, string | null>;
  /** Saved id → the last rename of its lineage, paths kept current through later renames. */
  renames: Map<string, { to: string; rewritten: ReferenceLocation[] }>;
  /**
   * The saved definition with only the renames applied — what the draft reads like where nothing
   * else was edited — and the id each saved node has there.
   */
  baseline: WorkflowGraph;
  baselineIds: Map<string, string>;
}

function lineageOf(saved: WorkflowGraph, ops: readonly Operation[]): Lineage {
  const origin = new Map<string, string | null>(saved.nodes.map((n) => [n.id, n.id]));
  const renames = new Map<string, { to: string; rewritten: ReferenceLocation[] }>();
  const baselineIds = new Map(saved.nodes.map((n) => [n.id, n.id]));
  let draft = saved;
  let baseline = saved;
  for (const op of ops) {
    if (isContent(op)) {
      draft = applyContent(draft, op);
      continue;
    }
    const applied = applyStructural(draft, op);
    draft = applied.workflow;
    if (op.kind === "add-node" || op.kind === "add-connected-node" || op.kind === "insert-on-edge")
      origin.set(op.node.id, null);
    if (op.kind === "remove-node") origin.delete(op.nodeId);
    if (op.kind !== "rename-node") continue;
    const source = origin.get(op.from) ?? null;
    origin.delete(op.from);
    origin.set(op.to, source);
    for (const rename of renames.values()) {
      rename.rewritten = rename.rewritten.map((r) => ({
        ...r,
        path: renamePath(r.path, op.from, op.to),
      }));
    }
    if (source === null) continue;
    renames.set(source, { to: op.to, rewritten: applied.rewritten ?? [] });
    // The baseline follows the rename where it can; a rename it cannot replay (its new id is
    // still taken there by a node the draft removed) leaves the node compared as it was saved.
    if (baselineIds.get(source) === op.from && !baseline.nodes.some((n) => n.id === op.to)) {
      baseline = fromEngine(renameNode(toEngine(baseline), op.from, op.to).workflow);
      baselineIds.set(source, op.to);
    }
  }
  return { draft, origin, renames, baseline, baselineIds };
}

/** The per-entry comparison of two maps (`connections`, `connectionLabels`, block `content`). */
function compareMap(
  out: ExportEntry[],
  path: string,
  base: Record<string, unknown> | undefined,
  draft: Record<string, unknown> | undefined,
  saved: Record<string, unknown> | undefined,
): void {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(draft ?? {})]);
  for (const key of keys) {
    if (!same(base?.[key], draft?.[key])) {
      out.push({
        kind: "change",
        path: `${path}.${key}`,
        before: saved?.[key],
        after: draft?.[key],
      });
    }
  }
}

const MAP_FIELDS = new Set(["connections", "connectionLabels"]);

/**
 * The flow-file entries the draft changes against the saved definition. A renamed node is one
 * entry with the references it rewrote; its values are compared under the new id against the
 * saved values with the rename applied, so a reference the rename rewrote is not listed again
 * while an edit made before or after the rename is. Edits typed back to the saved value are not
 * changes.
 */
export function exportDiff(saved: WorkflowGraph, ops: readonly Operation[]): ExportEntry[] {
  if (ops.length === 0) return [];
  const { draft, origin, renames, baseline, baselineIds } = lineageOf(saved, ops);
  const out: ExportEntry[] = [];

  const survivors = new Set([...origin.values()].filter((s): s is string => s !== null));
  for (const node of saved.nodes) {
    const rename = renames.get(node.id);
    if (rename && rename.to !== node.id && survivors.has(node.id)) {
      out.push({ kind: "rename-node", from: node.id, to: rename.to, rewritten: rename.rewritten });
    }
  }
  for (const node of saved.nodes) {
    if (!survivors.has(node.id)) out.push({ kind: "remove-node", id: node.id });
  }
  for (const node of draft.nodes) {
    if (origin.get(node.id) === null) out.push({ kind: "add-node", id: node.id });
  }

  const savedBlocks = saved.progress?.nodes ?? [];
  const draftBlocks = draft.progress?.nodes ?? [];
  for (const block of savedBlocks) {
    if (!draftBlocks.some((b) => b.id === block.id))
      out.push({ kind: "remove-block", id: block.id });
  }
  for (const block of draftBlocks) {
    if (!savedBlocks.some((b) => b.id === block.id)) out.push({ kind: "add-block", id: block.id });
  }
  savedBlocks.forEach((block, index) => {
    const after = draftBlocks.find((b) => b.id === block.id);
    const base = baseline.progress?.nodes.find((b) => b.id === block.id) ?? block;
    if (!after) return;
    const path = `progress.nodes[${index}]`;
    const record = (b: object) => b as Record<string, unknown>;
    const keys = new Set([...Object.keys(base), ...Object.keys(after)]);
    for (const key of keys) {
      if (key === "id") continue;
      if (key === "content") {
        compareMap(out, `${path}.content`, base.content, after.content, block.content);
      } else if (!same(record(base)[key], record(after)[key])) {
        out.push({
          kind: "change",
          path: `${path}.${key}`,
          before: record(block)[key],
          after: record(after)[key],
        });
      }
    }
  });

  const savedById = new Map(saved.nodes.map((n) => [n.id, n]));
  const baselineById = new Map(baseline.nodes.map((n) => [n.id, n]));
  for (const node of draft.nodes) {
    const source = origin.get(node.id);
    if (!source) continue;
    const before = savedById.get(source) as unknown as Record<string, unknown>;
    const base = (baselineById.get(baselineIds.get(source)!) ?? before) as unknown as Record<
      string,
      unknown
    >;
    const after = node as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(base), ...Object.keys(after)]);
    for (const key of keys) {
      if (key === "id") continue;
      const path = `nodes[${node.id}].${key}`;
      if (MAP_FIELDS.has(key)) {
        compareMap(
          out,
          path,
          base[key] as Record<string, unknown> | undefined,
          after[key] as Record<string, unknown> | undefined,
          before[key] as Record<string, unknown> | undefined,
        );
      } else if (!same(base[key], after[key])) {
        out.push({ kind: "change", path, before: before[key], after: after[key] });
      }
    }
  }

  const names = new Set([
    ...Object.keys(saved.variableRegistry ?? {}),
    ...Object.keys(draft.variableRegistry ?? {}),
  ]);
  for (const name of names) {
    const after = draft.variableRegistry?.[name];
    if (!same(baseline.variableRegistry?.[name], after)) {
      out.push({
        kind: "change",
        path: `variableRegistry.${name}`,
        before: saved.variableRegistry?.[name],
        after,
      });
    }
  }
  return out;
}
