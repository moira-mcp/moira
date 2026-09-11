/**
 * Aggregated process view — prototype block model.
 *
 * This is fixture-level modelling for the #180 interface prototypes. It stands in for the
 * authoring contract that #179 will define; nothing here is a runtime contract. Its purpose is to
 * make the visual language judgeable on real workflows before the schema is designed.
 */

export type AuthoredNodeType =
  | "start"
  | "end"
  | "agent-directive"
  | "condition"
  | "expression"
  | "teleport"
  | "materialize"
  | "user-notification"
  | "telegram-notification"
  | "subgraph"
  | "lock"
  | "read-note"
  | "write-note"
  | "upsert-note";

/** One authored node as it exists in the workflow definition. */
export interface AuthoredNode {
  id: string;
  type: AuthoredNodeType | string;
  /** First sentence of the directive or message, bounded; empty for routing nodes. */
  summary: string;
  connections: Record<string, string>;
  /** Human labels for connections, keyed like `connections`; present on boundary edges and returns. */
  connectionLabels?: Record<string, ConnectionLabel>;
  /** Routing semantics, as authored: a structured condition or arithmetic expressions. */
  condition?: unknown;
  expressions?: string[];
  /** Field names the step returns (its inputSchema properties). */
  inputs?: string[];
  progressNodeId?: string | null;
}

/** A connection label as authored in the flow file: plain text, or text plus the return it explains. */
export type ConnectionLabel = string | { label: string; cycle?: { cause: string; exit: string } };

/** One block as authored in `progress.nodes` of an annotated workflow. */
export interface AnnotatedBlock {
  id: string;
  label: string;
  /** `content.summary` — the block description #179 makes mandatory. */
  summary: string;
  outcome?: string;
  next?: string;
  /** `connections.default` — the authored reading order. */
  next_block?: string;
}

/**
 * The surface of an annotated workflow the derivation reads. Generated from the flow file by
 * scripts/generate-process-view-snapshot.ts; authored nodes come from the matching `*_AUTHORED`.
 */
export interface AnnotatedWorkflow {
  slug: string;
  title: string;
  goal: string;
  version: string;
  blocks: AnnotatedBlock[];
  nodeCount: number;
}

/**
 * Block status vocabulary from #179: beyond active / done / pending the view must distinguish
 * repeated (with iteration count), skipped by routing, and waiting on the user.
 */
export type BlockStatus = "pending" | "active" | "done" | "repeated" | "skipped" | "waiting";

export interface Transition {
  /** Target block id. */
  to: string;
  /** Required label explaining the transition, e.g. "review found issues". */
  label: string;
  /** Present when the transition returns to an earlier block or to itself. */
  cycle?: {
    /** What causes the repetition. */
    cause: string;
    /** What ends it. */
    exit: string;
  };
  /** Authored edges ("node.key") this transition was derived from; absent on hand fixtures. */
  edges?: string[];
}

export interface ProcessBlock {
  id: string;
  name: string;
  /** Required by #179: a block without a description fails validation. */
  description: string;
  /** Authored node ids this block implements. Every authored node belongs to exactly one block. */
  nodeIds: string[];
  transitions: Transition[];
}

/** A snapshot of one execution, projected onto blocks. */
export interface BlockRunState {
  status: BlockStatus;
  /** Number of completed passes through the block; shown for repeated blocks. */
  iterations?: number;
  /** For an active block: which authored node the execution is currently paused on. */
  currentNodeId?: string;
  /** Short human-readable note for the current state, e.g. "step 3 of 5". */
  note?: string;
}

export interface ProcessProjection {
  slug: string;
  title: string;
  goal: string;
  blocks: ProcessBlock[];
  authored: AuthoredNode[];
  run: Record<string, BlockRunState>;
}

export interface ProjectionIssue {
  kind: "unclaimed" | "double-claimed" | "unknown-id" | "empty-description" | "unknown-target";
  detail: string;
}

/**
 * The completeness rules #179 asks validation to enforce, applied to a fixture projection.
 * Used by unit 1's acceptance check and surfaced in the host so a broken fixture is visible.
 */
export function validateProjection(projection: ProcessProjection): ProjectionIssue[] {
  const issues: ProjectionIssue[] = [];
  const authoredIds = new Set(projection.authored.map((node) => node.id));
  const blockIds = new Set(projection.blocks.map((block) => block.id));
  const claims = new Map<string, string[]>();

  for (const block of projection.blocks) {
    if (!block.description.trim()) {
      issues.push({ kind: "empty-description", detail: block.id });
    }
    for (const nodeId of block.nodeIds) {
      if (!authoredIds.has(nodeId)) {
        issues.push({ kind: "unknown-id", detail: `${block.id} claims ${nodeId}` });
      }
      claims.set(nodeId, [...(claims.get(nodeId) ?? []), block.id]);
    }
    for (const transition of block.transitions) {
      if (!blockIds.has(transition.to)) {
        issues.push({ kind: "unknown-target", detail: `${block.id} -> ${transition.to}` });
      }
    }
  }
  for (const id of authoredIds) {
    const owners = claims.get(id) ?? [];
    if (owners.length === 0) issues.push({ kind: "unclaimed", detail: id });
    if (owners.length > 1)
      issues.push({ kind: "double-claimed", detail: `${id}: ${owners.join(", ")}` });
  }
  return issues;
}

export function blockById(projection: ProcessProjection): Map<string, ProcessBlock> {
  return new Map(projection.blocks.map((block) => [block.id, block]));
}

export function nodeById(projection: ProcessProjection): Map<string, AuthoredNode> {
  return new Map(projection.authored.map((node) => [node.id, node]));
}

/** Which block owns an authored node. */
export function ownerOf(projection: ProcessProjection, nodeId: string): ProcessBlock | undefined {
  return projection.blocks.find((block) => block.nodeIds.includes(nodeId));
}

export function cycleTransitions(
  projection: ProcessProjection,
): Array<{ from: ProcessBlock; transition: Transition }> {
  return projection.blocks.flatMap((from) =>
    from.transitions.filter((t) => t.cycle).map((transition) => ({ from, transition })),
  );
}

export function runStateOf(projection: ProcessProjection, blockId: string): BlockRunState {
  return projection.run[blockId] ?? { status: "pending" };
}
