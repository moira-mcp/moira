/**
 * What the structural dialogs need to know before they commit an operation — pure readings of the
 * draft, so each dialog shows the consequence of the action before the author confirms it:
 *
 * - a rename: whether the new id is acceptable, every reference the rename rewrites, the prose that
 *   mentions the old id and stays as it is, and whether agents address the node by id (a teleport);
 * - a delete: every incoming edge with its default decision (its source leads on to where the
 *   deleted node led), whether it may be dropped, and the template references that will dangle;
 * - a connection: the keys a node may not lose, and the steps a connection may lead to, by block;
 * - a new step: the node types whose required fields the dialog can ask for, and — inserted on a
 *   connection between two blocks — which of the two it may join;
 * - a save: the owner's paused runs sitting on a node the draft renames or removes.
 *
 * The rules themselves (id format, protected outputs, which references exist) are the engine's
 * authoring functions; nothing here re-decides them.
 */

import {
  NODE_ID_PATTERN,
  edgeId,
  findNodeReferences,
  findProseMentions,
  incomingEdges,
  isValidNodeId,
  primaryOutputOf,
  type ReferenceLocation,
} from "@mcp-moira/workflow-engine/authoring";
import { deriveProcess } from "@mcp-moira/workflow-engine/process";
import type { NodeTypeDescriptor } from "../../types/node-type-catalog";
import type { WorkflowGraph, WorkflowNode } from "../../types/workflow-types";
import type { RunBlock } from "../run/model";
import type { ExportEntry } from "./operations";
import type { ExecutionStopCapability } from "@mcp-moira/shared/execution-management";

type EngineGraph = Parameters<typeof findNodeReferences>[0];
const engine = (graph: WorkflowGraph): EngineGraph => graph as unknown as EngineGraph;

export { NODE_ID_PATTERN };

// --- Rename

export type RenameProblem = "empty" | "invalid" | "exists" | "unchanged";

export interface RenamePreview {
  problem: RenameProblem | null;
  /** Every location the rename rewrites, with how many references each holds. */
  references: ReferenceLocation[];
  /** Texts that mention the id outside a reference; the rename leaves them as they are. */
  prose: ReferenceLocation[];
  /** Agents jump to a teleport node by its id: a rename breaks jumps that name the old one. */
  teleport: boolean;
}

/** Why `id` cannot name a new node of this workflow, or null when it can. */
export function newIdProblem(
  workflow: WorkflowGraph,
  id: string,
): Exclude<RenameProblem, "unchanged"> | null {
  return id.length === 0
    ? "empty"
    : !isValidNodeId(id)
      ? "invalid"
      : workflow.nodes.some((n) => n.id === id)
        ? "exists"
        : null;
}

export function renamePreview(
  workflow: WorkflowGraph,
  nodeId: string,
  next: string,
): RenamePreview {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  const problem: RenameProblem | null =
    next === nodeId ? "unchanged" : newIdProblem(workflow, next);
  // The engine reports connection targets apart from the other references; a rename rewrites both.
  const leadingIn = new Map<string, number>();
  for (const edge of incomingEdges(engine(workflow), nodeId)) {
    leadingIn.set(edge.source, (leadingIn.get(edge.source) ?? 0) + 1);
  }
  return {
    problem,
    references: [
      ...findNodeReferences(engine(workflow), nodeId),
      ...[...leadingIn].map(([source, count]) => ({ path: `nodes[${source}].connections`, count })),
    ],
    prose: findProseMentions(engine(workflow), nodeId),
    teleport: (node?.type as string | undefined) === "teleport",
  };
}

// --- Delete

export interface IncomingDecisionRow {
  /** `<source>.<key>`. */
  edge: string;
  source: string;
  key: string;
  /** The edge is its source's primary output: it can be retargeted but not dropped. */
  protected: boolean;
  /** Where the edge leads by default: on to the deleted node's primary target, when it has one. */
  proposed: string | null;
}

export interface DeletePlan {
  /** The start node cannot be removed. */
  refused: "only-start" | null;
  incoming: IncomingDecisionRow[];
  /** Template and path references to the node's values, which the delete leaves dangling. */
  dangling: ReferenceLocation[];
  teleport: boolean;
}

export function deletePlan(workflow: WorkflowGraph, nodeId: string): DeletePlan {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  const successorKey = node ? primaryOutputOf(node.type) : null;
  const successor = successorKey ? (node?.connections?.[successorKey] ?? null) : null;
  const proposed = successor && successor !== nodeId ? successor : null;
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const incoming = incomingEdges(engine(workflow), nodeId).map((edge) => {
    const source = byId.get(edge.source);
    return {
      edge: edgeId(edge.source, edge.key),
      source: edge.source,
      key: edge.key,
      protected: source !== undefined && primaryOutputOf(source.type) === edge.key,
      proposed: proposed === edge.source ? null : proposed,
    };
  });
  return {
    refused: node?.type === "start" ? "only-start" : null,
    incoming,
    // References inside the deleted step go with it; the ones elsewhere are left without a source.
    dangling: findNodeReferences(engine(workflow), nodeId).filter(
      (location) => !location.path.startsWith(`nodes[${nodeId}]`),
    ),
    teleport: (node?.type as string | undefined) === "teleport",
  };
}

// --- Connections

/** The output a node must keep: its primary output, or none. */
export function protectedKey(node: Pick<WorkflowNode, "type">): string | null {
  return primaryOutputOf(node.type);
}

export interface TargetGroup {
  /** The block's id, or null for steps that belong to no block. */
  blockId: string | null;
  name: string;
  steps: { id: string; name: string }[];
}

/** Every step a connection may lead to, grouped by block in process order. */
export function targetGroups(workflow: WorkflowGraph, blocks: readonly RunBlock[]): TargetGroup[] {
  const nameOf = (node: WorkflowNode) => node.metadata?.displayName ?? node.id;
  const candidates = workflow.nodes.filter((n) => n.type !== "start");
  const groups: TargetGroup[] = blocks.map((block) => ({
    blockId: block.id,
    name: block.name,
    steps: candidates
      .filter((n) => n.progressNodeId === block.id)
      .map((n) => ({ id: n.id, name: nameOf(n) })),
  }));
  const blockIds = new Set(blocks.map((b) => b.id));
  const unowned = candidates.filter((n) => !n.progressNodeId || !blockIds.has(n.progressNodeId));
  if (unowned.length > 0) {
    groups.push({
      blockId: null,
      name: "",
      steps: unowned.map((n) => ({ id: n.id, name: nameOf(n) })),
    });
  }
  return groups.filter((g) => g.steps.length > 0);
}

// --- New step

export interface CreatableField {
  name: string;
  /**
   * A text the author types, a list of lines, or a structure (a condition's cases, a subgraph's
   * mappings, an extension's configuration) written as JSON.
   */
  kind: "text" | "lines" | "json";
  /** For JSON: the shape an empty value starts from (`[]` for a list, `{}` otherwise). */
  initial?: string;
  /** Not required by the type: left out of the node when empty. */
  optional?: boolean;
  description?: string;
}

export interface CreatableType {
  type: string;
  title: string;
  description: string;
  /** The fields the type requires besides its id, type and connections. */
  fields: CreatableField[];
}

const STRUCTURAL = new Set(["type", "id", "connections", "progressNodeId"]);

type SchemaProperty = { type?: string; description?: string; items?: { type?: string } };

/**
 * Every node type of the catalog a new step can be created as — all but `start`, which exists
 * once per workflow — with the fields the type requires. A built-in type's required texts and
 * lists of texts are typed as such; any other required field is written as JSON. An extension type
 * takes its configuration as JSON, required when its schema requires any key. The server's check
 * of the draft judges whether the values satisfy the type.
 */
export function creatableTypes(catalog: readonly NodeTypeDescriptor[]): CreatableType[] {
  const out: CreatableType[] = [];
  for (const entry of catalog) {
    if (entry.type === "start") continue;
    const schema = (entry.schema ?? {}) as {
      required?: string[];
      properties?: Record<string, SchemaProperty>;
    };
    const fields: CreatableField[] = [];
    if (entry.schemaScope === "config") {
      fields.push({
        name: "config",
        kind: "json",
        initial: "{}",
        optional: (schema.required ?? []).length === 0,
      });
    } else {
      for (const name of schema.required ?? []) {
        if (STRUCTURAL.has(name)) continue;
        const property: SchemaProperty = schema.properties?.[name] ?? {};
        if (property.type === "string") {
          fields.push({ name, kind: "text", description: property.description });
        } else if (property.type === "array" && property.items?.type === "string") {
          fields.push({ name, kind: "lines", description: property.description });
        } else {
          fields.push({
            name,
            kind: "json",
            initial: property.type === "array" ? "[]" : "{}",
            description: property.description,
          });
        }
      }
    }
    out.push({ type: entry.type, title: entry.title, description: entry.description, fields });
  }
  return out;
}

/** Why a field's value cannot be used as typed, or null. A JSON field must parse. */
export function fieldProblem(
  field: CreatableField,
  value: string | undefined,
): "missing" | "json" | null {
  const text = (value ?? "").trim();
  if (!text) return field.optional ? null : "missing";
  if (field.kind !== "json") return null;
  try {
    JSON.parse(text);
    return null;
  } catch {
    return "json";
  }
}

/**
 * The blocks a step inserted on `source.key` may join, or null when there is no choice. The step
 * joins the source's block by default; the target's block is offered only on a forward connection
 * between two blocks. On a return — an edge the process walk classifies as a back-edge, the same
 * walk that asks for a return's label and explanation — the step always joins the source's block:
 * there the label and explanation move to the step's output, which still leads back, whereas in
 * the target's block the step's edge would loop inside that block unexplained.
 */
export function insertBlockChoice(
  workflow: WorkflowGraph,
  edge: { source: string; key: string },
): { source: string; target: string } | null {
  const node = workflow.nodes.find((n) => n.id === edge.source);
  const targetId = node?.connections?.[edge.key];
  const target = workflow.nodes.find((n) => n.id === targetId);
  const from = node?.progressNodeId;
  const to = target?.progressNodeId;
  if (!from || !to || from === to) return null;
  const process = deriveProcess(engine(workflow) as Parameters<typeof deriveProcess>[0]);
  if (!process || process.backEdges.includes(edgeId(edge.source, edge.key))) return null;
  return { source: from, target: to };
}

/**
 * The node a new step starts as: its type, id and the fields as the author typed them — lines
 * split, JSON parsed, an empty optional field left out. Call it only when no field has a problem.
 */
export function newNode(
  type: CreatableType,
  id: string,
  values: Record<string, string>,
): WorkflowNode {
  const fields: Record<string, unknown> = {};
  for (const field of type.fields) {
    const value = (values[field.name] ?? "").trim();
    if (!value && field.optional) continue;
    fields[field.name] =
      field.kind === "lines"
        ? value.split("\n").filter((line) => line.trim())
        : field.kind === "json"
          ? JSON.parse(value)
          : (values[field.name] ?? "");
  }
  return { id, type: type.type, ...fields } as unknown as WorkflowNode;
}

// --- Paused runs

export interface RunOnNode {
  executionId: string;
  status: string;
  currentNodeId: string | null;
  waitingForInputNodeId?: string | null;
  taskTitle?: string;
  workflowName?: string | null;
  note?: string | null;
  revision?: number | null;
  stopReason?: string | null;
  stopCapability?: ExecutionStopCapability;
}

export interface PausedRunWarning {
  executionId: string;
  nodeId: string;
  change: "renamed" | "removed";
  /** The node's new id, for a rename. */
  to?: string;
  taskTitle?: string;
  workflowName?: string | null;
  note?: string | null;
  revision?: number | null;
  stopCapability?: ExecutionStopCapability;
}

/**
 * The visible runs that actually wait on a node the draft renames or removes. A run reads the stored
 * definition at its next step, so such a run would look for a node that no longer exists; the
 * warning names it before the save, together with `session recover`.
 */
export function pausedRunWarnings(
  runs: readonly RunOnNode[],
  diff: readonly ExportEntry[],
): PausedRunWarning[] {
  const touched = new Map<string, { change: "renamed" | "removed"; to?: string }>();
  for (const entry of diff) {
    if (entry.kind === "rename-node") touched.set(entry.from, { change: "renamed", to: entry.to });
    if (entry.kind === "remove-node") touched.set(entry.id, { change: "removed" });
  }
  if (touched.size === 0) return [];
  return runs.flatMap((run) => {
    if (
      !["running", "waiting", "locked"].includes(run.status) ||
      run.stopReason != null ||
      !run.currentNodeId ||
      run.waitingForInputNodeId !== run.currentNodeId
    )
      return [];
    const hit = touched.get(run.currentNodeId);
    return hit
      ? [
          {
            executionId: run.executionId,
            nodeId: run.currentNodeId,
            ...hit,
            revision: run.revision,
            stopCapability: run.stopCapability,
            ...(run.taskTitle ? { taskTitle: run.taskTitle } : {}),
            ...(run.workflowName ? { workflowName: run.workflowName } : {}),
            ...(run.note ? { note: run.note } : {}),
          },
        ]
      : [];
  });
}
