/**
 * What is wrong with a definition, and where the page shows it.
 *
 * Two layers report problems. The process derivation runs in the browser on every change and
 * names the block contract's violations (`ProcessDiagnostic`); the server's validation — the dry
 * run of the draft, or the answer to a refused save — names everything else, located by node and
 * field (`ValidationIssue`), restating the block contract's diagnostics among them, which are shown
 * once, from the browser's layer. `placeIssues` turns both into one placement: on an edge when the
 * problem is about one connection, on a node, on a block, or on the page when the definition has no
 * place for it. `saveGate` decides whether the draft may be saved: only a changed draft without
 * process diagnostics whose dry run is finished, belongs to exactly this draft and found no error.
 */

import { edgeId } from "@mcp-moira/workflow-engine/authoring";
import {
  isProcessDiagnosticMessage,
  type ProcessDiagnostic,
} from "@mcp-moira/workflow-engine/process";
import type { ValidationIssue, WorkflowValidationStatus } from "../../types/react-flow-types";
import type { WorkflowGraph } from "../../types/workflow-types";

export interface PlacedIssue {
  /** Which layer found it: the browser's process derivation or the server's validation. */
  source: "process" | "server";
  severity: "error" | "warning";
  /** The diagnostic code, or the validation issue's type. */
  code: string;
  message: string;
  nodeId?: string;
  /** `<node>.<key>` when the problem is about one connection. */
  edge?: string;
  /** The output key of that connection. */
  connection?: string;
  blockId?: string;
  /** The node field a server issue names, e.g. `directive` or `connections.retry`. */
  field?: string;
}

export interface IssuePlacement {
  /** Every problem, in the order the layers reported them (process first). */
  all: PlacedIssue[];
  /** Problems of a node that are not about one of its connections. */
  nodes: ReadonlyMap<string, PlacedIssue[]>;
  edges: ReadonlyMap<string, PlacedIssue[]>;
  /** Problems of a block that name no node or edge. */
  blocks: ReadonlyMap<string, PlacedIssue[]>;
  /** Problems the definition has no place for (a registry entry, the graph as a whole). */
  page: PlacedIssue[];
}

export const NO_ISSUES: IssuePlacement = {
  all: [],
  nodes: new Map(),
  edges: new Map(),
  blocks: new Map(),
  page: [],
};

const EDGE_FIELD = /^(?:connections|connectionLabels)\.(.+)$/;

/**
 * The server's issues. A status from a server that predates `issues` is read from its per-node and
 * global lists, which carry the same messages without the field.
 */
function serverIssues(validation: WorkflowValidationStatus): ValidationIssue[] {
  if (validation.issues) return validation.issues;
  const issues: ValidationIssue[] = [];
  for (const [nodeId, node] of Object.entries(validation.nodeValidation ?? {})) {
    for (const message of node.errors)
      issues.push({ type: "node", severity: "error", nodeId, message });
    for (const message of node.warnings)
      issues.push({ type: "node", severity: "warning", nodeId, message });
  }
  for (const message of validation.globalErrors ?? [])
    issues.push({ type: "structure", severity: "error", message });
  for (const message of validation.globalWarnings ?? [])
    issues.push({ type: "structure", severity: "warning", message });
  return issues;
}

export function placeIssues(
  workflow: WorkflowGraph,
  diagnostics: readonly ProcessDiagnostic[],
  validation: WorkflowValidationStatus | null | undefined,
): IssuePlacement {
  const nodes = new Map<string, PlacedIssue[]>();
  const edges = new Map<string, PlacedIssue[]>();
  const blocks = new Map<string, PlacedIssue[]>();
  const page: PlacedIssue[] = [];
  const all: PlacedIssue[] = [];
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const blockIds = new Set((workflow.progress?.nodes ?? []).map((b) => b.id));
  const add = (map: Map<string, PlacedIssue[]>, key: string, issue: PlacedIssue) =>
    map.set(key, [...(map.get(key) ?? []), issue]);
  const place = (issue: PlacedIssue) => {
    all.push(issue);
    if (issue.edge) add(edges, issue.edge, issue);
    else if (issue.nodeId) add(nodes, issue.nodeId, issue);
    else if (issue.blockId) add(blocks, issue.blockId, issue);
    else page.push(issue);
  };

  for (const d of diagnostics) {
    // An edge diagnostic names its source node too; the key is what follows it in the edge id.
    const known = d.nodeId !== undefined && byId.has(d.nodeId);
    const key =
      known && d.edge?.startsWith(`${d.nodeId}.`) ? d.edge.slice(d.nodeId!.length + 1) : undefined;
    place({
      source: "process",
      severity: "error",
      code: d.code,
      message: d.message,
      ...(known ? { nodeId: d.nodeId } : {}),
      ...(key !== undefined ? { edge: edgeId(d.nodeId!, key), connection: key } : {}),
      ...(d.blockId && blockIds.has(d.blockId) ? { blockId: d.blockId } : {}),
    });
  }
  for (const issue of validation ? serverIssues(validation) : []) {
    // The server restates the block contract's diagnostics as issues; the browser's derivation of
    // the same draft already placed them, and it stays current while a dry run is pending.
    if (isProcessDiagnosticMessage(issue.message)) continue;
    const node = issue.nodeId ? byId.get(issue.nodeId) : undefined;
    const key = issue.field?.match(EDGE_FIELD)?.[1];
    const onEdge = node && key !== undefined && key in (node.connections ?? {});
    place({
      source: "server",
      severity: issue.severity,
      code: issue.type,
      message: issue.message,
      ...(issue.field ? { field: issue.field } : {}),
      ...(node ? { nodeId: node.id } : {}),
      ...(onEdge ? { edge: edgeId(node.id, key), connection: key } : {}),
    });
  }
  return { all, nodes, edges, blocks, page };
}

/** The problems of a node's outgoing connections, by output key. */
export function connectionIssuesOf(
  placement: IssuePlacement,
  nodeId: string,
): ReadonlyMap<string, PlacedIssue[]> {
  const byKey = new Map<string, PlacedIssue[]>();
  for (const issues of placement.edges.values()) {
    for (const issue of issues) {
      if (issue.nodeId !== nodeId || issue.connection === undefined) continue;
      byKey.set(issue.connection, [...(byKey.get(issue.connection) ?? []), issue]);
    }
  }
  return byKey;
}

/** A node's own problems together with those of its outgoing connections. */
export function issuesOfNode(placement: IssuePlacement, nodeId: string): PlacedIssue[] {
  return [
    ...(placement.nodes.get(nodeId) ?? []),
    ...[...connectionIssuesOf(placement, nodeId).values()].flat(),
  ];
}

// --- Save gate

/** The server's judgement of a draft: waiting for it, or its answer for the draft it was asked about. */
export type DryRun =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; draft: WorkflowGraph; validation: WorkflowValidationStatus }
  | { status: "failed"; draft: WorkflowGraph; message: string };

export type SaveGateReason =
  "unchanged" | "diagnostics" | "checking" | "stale" | "check-failed" | "invalid" | "ready";

export interface SaveGate {
  enabled: boolean;
  reason: SaveGateReason;
}

export function hasErrors(validation: WorkflowValidationStatus): boolean {
  return !validation.isValid || serverIssues(validation).some((i) => i.severity === "error");
}

/**
 * Whether the draft may be saved. A dry-run answer counts only for the very draft it judged: an
 * answer for an earlier draft is stale however recent it is.
 */
export function saveGate(input: {
  changed: boolean;
  diagnostics: number;
  draft: WorkflowGraph;
  dryRun: DryRun;
}): SaveGate {
  const { changed, diagnostics, draft, dryRun } = input;
  const reason: SaveGateReason = !changed
    ? "unchanged"
    : diagnostics > 0
      ? "diagnostics"
      : dryRun.status === "idle" || dryRun.status === "pending"
        ? "checking"
        : dryRun.draft !== draft
          ? "stale"
          : dryRun.status === "failed"
            ? "check-failed"
            : hasErrors(dryRun.validation)
              ? "invalid"
              : "ready";
  return { enabled: reason === "ready", reason };
}
