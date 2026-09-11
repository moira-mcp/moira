/**
 * Derivation of the block model from an annotated workflow.
 *
 * Nothing here is authored twice: blocks come from `progress.nodes`, ownership from each node's
 * `progressNodeId`, transitions from the authored edges that cross a block boundary, cycles from
 * back-edges of a depth-first walk from the start node or from a transition to an earlier block,
 * and block order from the authored order of `progress.nodes`. Human wording comes from `connectionLabels` on the edge. Every rule
 * the annotation can violate is reported as a diagnostic instead of being silently patched.
 */

import type {
  AnnotatedWorkflow,
  AuthoredNode,
  BlockRunState,
  ConnectionLabel,
  ProcessBlock,
  ProcessProjection,
  Transition,
} from "./model";

export interface DerivationIssue {
  kind:
    | "unowned-node"
    | "unknown-block"
    | "empty-block"
    | "empty-description"
    | "unlabeled-edge"
    | "unexplained-cycle"
    | "no-start";
  detail: string;
}

export interface Derivation {
  projection: ProcessProjection;
  diagnostics: DerivationIssue[];
  /** Every edge classified as a back-edge, as "node.key". */
  backEdges: string[];
}

function labelText(label: ConnectionLabel | undefined): string | undefined {
  if (label === undefined) return undefined;
  return typeof label === "string" ? label : label.label;
}

function cycleOf(label: ConnectionLabel | undefined): Transition["cycle"] | undefined {
  return typeof label === "object" ? label.cycle : undefined;
}

/** Back-edges of the authored graph: edges whose target is on the DFS stack when they are walked. */
export function findBackEdges(authored: AuthoredNode[], startId: string): Set<string> {
  const adjacency = new Map(authored.map((n) => [n.id, Object.entries(n.connections)]));
  const color = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const visit = (id: string): void => {
    color.set(id, 1);
    for (const [key, target] of adjacency.get(id) ?? []) {
      const state = color.get(target);
      if (state === 1) back.add(`${id}.${key}`);
      else if (state === undefined) visit(target);
    }
    color.set(id, 2);
  };
  if (adjacency.has(startId)) visit(startId);
  return back;
}

export function deriveProjection(
  workflow: AnnotatedWorkflow,
  authored: AuthoredNode[],
  run: Record<string, BlockRunState> = {},
): Derivation {
  const diagnostics: DerivationIssue[] = [];
  const blockIds = new Set(workflow.blocks.map((b) => b.id));

  // Ownership.
  const owner = new Map<string, string>();
  const members = new Map<string, string[]>(workflow.blocks.map((b) => [b.id, []]));
  for (const node of authored) {
    const blockId = node.progressNodeId ?? null;
    if (!blockId) {
      diagnostics.push({ kind: "unowned-node", detail: node.id });
      continue;
    }
    if (!blockIds.has(blockId)) {
      diagnostics.push({ kind: "unknown-block", detail: `${node.id} → ${blockId}` });
      continue;
    }
    owner.set(node.id, blockId);
    members.get(blockId)!.push(node.id);
  }
  for (const block of workflow.blocks) {
    if (!block.summary.trim()) diagnostics.push({ kind: "empty-description", detail: block.id });
    if ((members.get(block.id) ?? []).length === 0)
      diagnostics.push({ kind: "empty-block", detail: block.id });
  }

  // Cycles.
  const start = authored.find((n) => n.type === "start") ?? authored[0];
  if (!start) diagnostics.push({ kind: "no-start", detail: workflow.slug });
  const backEdges = start ? findBackEdges(authored, start.id) : new Set<string>();

  // Transitions: boundary edges, plus back-edges that stay inside a block (self-returns).
  const transitionsByBlock = new Map<string, Transition[]>(workflow.blocks.map((b) => [b.id, []]));
  for (const node of authored) {
    const from = owner.get(node.id);
    if (!from) continue;
    for (const [key, target] of Object.entries(node.connections)) {
      const to = owner.get(target);
      if (!to) continue;
      const edgeId = `${node.id}.${key}`;
      const isBack = backEdges.has(edgeId);
      if (from === to && !isBack) continue;
      const raw = node.connectionLabels?.[key];
      let label = labelText(raw);
      if (!label) {
        diagnostics.push({ kind: "unlabeled-edge", detail: `${edgeId} → ${target}` });
        label = edgeId;
      }
      let cycle = cycleOf(raw);
      if (isBack && !cycle) {
        diagnostics.push({ kind: "unexplained-cycle", detail: edgeId });
        cycle = { cause: label, exit: "" };
      }
      const list = transitionsByBlock.get(from)!;
      const same = list.find(
        (t) => t.to === to && t.label === label && Boolean(t.cycle) === Boolean(cycle),
      );
      if (same) {
        same.edges?.push(edgeId);
        continue;
      }
      // A label that explains a return marks the transition as a cycle even when the node walk did
      // not classify the edge as a back-edge; a return to an earlier block is confirmed below.
      list.push(
        isBack || cycle ? { to, label, cycle, edges: [edgeId] } : { to, label, edges: [edgeId] },
      );
    }
  }

  // The authored array order of `progress.nodes` is the process order (#179 rule). A boundary
  // transition to a block at a lower index is a return even when the node walk finished that
  // block's nodes before reaching the edge, so it must carry a cycle explanation.
  const index = new Map(workflow.blocks.map((b, i) => [b.id, i]));
  for (const [from, list] of transitionsByBlock) {
    for (const t of list) {
      if (t.cycle || index.get(t.to)! >= index.get(from)!) continue;
      t.cycle = { cause: t.label, exit: "" };
      diagnostics.push({ kind: "unexplained-cycle", detail: `${from} → ${t.to} (${t.label})` });
    }
  }
  const order = workflow.blocks.map((b) => b.id);

  const blocks: ProcessBlock[] = order.map((id) => {
    const block = workflow.blocks.find((b) => b.id === id)!;
    return {
      id,
      name: block.label,
      description: block.summary,
      nodeIds: members.get(id) ?? [],
      transitions: transitionsByBlock.get(id) ?? [],
    };
  });

  return {
    projection: {
      slug: workflow.slug,
      title: workflow.title,
      goal: workflow.goal,
      blocks,
      authored,
      run,
    },
    diagnostics,
    backEdges: [...backEdges],
  };
}

export interface ProjectionDifference {
  kind: "blocks" | "order" | "membership" | "transitions" | "cycles";
  blockId?: string;
  detail: string;
}

function transitionKey(t: Transition): string {
  return `${t.to} · ${t.label}${t.cycle ? " (cycle)" : ""}`;
}

/** Differences between two projections of the same workflow, fixture first, derived second. */
export function compareProjections(
  fixture: ProcessProjection,
  derived: ProcessProjection,
): ProjectionDifference[] {
  const out: ProjectionDifference[] = [];
  const fixtureIds = fixture.blocks.map((b) => b.id);
  const derivedIds = derived.blocks.map((b) => b.id);
  const onlyFixture = fixtureIds.filter((id) => !derivedIds.includes(id));
  const onlyDerived = derivedIds.filter((id) => !fixtureIds.includes(id));
  if (onlyFixture.length || onlyDerived.length) {
    out.push({
      kind: "blocks",
      detail: `fixture only: ${onlyFixture.join(", ") || "—"}; derived only: ${onlyDerived.join(", ") || "—"}`,
    });
  }
  if (fixtureIds.join(",") !== derivedIds.join(",")) {
    out.push({ kind: "order", detail: `${fixtureIds.join(" → ")} ⇄ ${derivedIds.join(" → ")}` });
  }
  for (const f of fixture.blocks) {
    const d = derived.blocks.find((b) => b.id === f.id);
    if (!d) continue;
    const fm = [...f.nodeIds].sort().join(",");
    const dm = [...d.nodeIds].sort().join(",");
    if (fm !== dm) {
      out.push({
        kind: "membership",
        blockId: f.id,
        detail: `fixture: ${f.nodeIds.length} nodes; derived: ${d.nodeIds.length} nodes (${
          f.nodeIds.filter((n) => !d.nodeIds.includes(n)).join(", ") || "—"
        } ⇄ ${d.nodeIds.filter((n) => !f.nodeIds.includes(n)).join(", ") || "—"})`,
      });
    }
    const ft = new Set(f.transitions.map(transitionKey));
    const dt = new Set(d.transitions.map(transitionKey));
    const missing = [...ft].filter((k) => !dt.has(k));
    const extra = [...dt].filter((k) => !ft.has(k));
    if (missing.length || extra.length) {
      out.push({
        kind: "transitions",
        blockId: f.id,
        detail: `fixture only: ${missing.join("; ") || "—"} | derived only: ${extra.join("; ") || "—"}`,
      });
    }
  }
  const fc = fixture.blocks
    .flatMap((b) => b.transitions.filter((t) => t.cycle).length)
    .reduce((a, b) => a + b, 0);
  const dc = derived.blocks
    .flatMap((b) => b.transitions.filter((t) => t.cycle).length)
    .reduce((a, b) => a + b, 0);
  if (fc !== dc)
    out.push({ kind: "cycles", detail: `fixture: ${fc} cycle transitions; derived: ${dc}` });
  return out;
}
