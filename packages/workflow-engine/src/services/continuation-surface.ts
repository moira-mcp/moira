import { createHash } from "node:crypto";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { GraphNode } from "../types/graph-nodes.js";
import { canonicalJson } from "../extensions/declared-schema.js";

/**
 * The continuation surface of a paused execution: everything about the workflow definition that can
 * change what the run does next. A paused step attempt is bound to a digest of this surface instead
 * of to a digest of the whole definition, so a change that cannot reach the paused step — a version
 * or tag bump, a workflow description, a system reminder, a node the run is not on — leaves the run
 * continuable.
 *
 * The surface is defined by what it leaves out, not by what it lists. Any node type can end up
 * being the node a run is paused on: five handlers pause deliberately (`agent-directive`,
 * `teleport`, `materialize`, `lock`, `subgraph`), an extension node pauses on itself when its call
 * fails, and the engine turns a node error into a pause on that same node regardless of type. A
 * list of "the fields that matter" would therefore have to know every type, and would silently omit
 * whichever it forgot — a `materialize` node's file list or a `lock` node's reason are that node's
 * directive just as much as an `agent-directive` node's `directive` field is.
 *
 * So the whole node is bound, minus the fields every node inherits that describe how it is
 * *displayed* rather than what it does. Those are named in `DISPLAY_ONLY_NODE_FIELDS` and read off
 * `BaseNode`; a field added there in future binds until it is deliberately added to this list, which
 * is a visible correction rather than a silently stale step.
 *
 * The surface also carries the `variableRegistry` entries for the global names the node declares in
 * `inputSchema.globalInputs`: the engine inlines those descriptors into the schema the agent is
 * validated against, so editing one changes the presented contract without touching the node.
 *
 * Outside the surface: all of `graph.metadata`, `systemReminder`, `progress`, and every node the run
 * is not paused on.
 *
 * A node that no longer exists has no continuation surface: the digest covers an explicit `missing`
 * shape keyed by the node id, so it cannot collide with any live node's and a deleted current node
 * always invalidates.
 *
 * The surface is also expressed as **facts**: one digest per bound thing, keyed by name
 * (`node.directive`, `registry.target`, and so on). The binding digest is the digest of that map, so
 * the two can never disagree, and a run that no longer matches can be told *which* facts differ
 * rather than only that something did. That is what `diagnose` reports, and it is why the facts are
 * persisted alongside the digest on the attempt.
 */
export interface ContinuationSurface {
  nodeId: string;
  node: Record<string, unknown> | null;
  registry: Record<string, unknown>;
}

/**
 * Inherited `BaseNode` fields that decide only how a node is drawn or labelled, never what it asks
 * of the agent or where it continues. Everything else a node declares is part of the binding,
 * including `hooks` and `timeout`, which are execution behaviour.
 */
const DISPLAY_ONLY_NODE_FIELDS = new Set([
  "metadata",
  "progressNodeId",
  "progressActiveLabel",
  "progressActiveContent",
  "connectionLabels",
]);

function declaredGlobalInputs(node: GraphNode): string[] {
  const schema = (node as { inputSchema?: unknown }).inputSchema;
  if (!schema || typeof schema !== "object") return [];
  const declared = (schema as { globalInputs?: unknown }).globalInputs;
  if (!Array.isArray(declared)) return [];
  return declared.filter((name): name is string => typeof name === "string");
}

/** Prefix separating the two kinds of fact, so a node field and a variable name cannot collide. */
export const NODE_FACT_PREFIX = "node.";
export const REGISTRY_FACT_PREFIX = "registry.";

function factDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function continuationSurface(graph: WorkflowGraph, nodeId: string): ContinuationSurface {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return { nodeId, node: null, registry: {} };

  const bound: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(node as unknown as Record<string, unknown>)) {
    if (DISPLAY_ONLY_NODE_FIELDS.has(field)) continue;
    if (value !== undefined) bound[field] = value;
  }

  const registry: Record<string, unknown> = {};
  for (const name of declaredGlobalInputs(node)) {
    registry[name] = graph.variableRegistry?.[name] ?? null;
  }

  return { nodeId, node: bound, registry };
}

/**
 * Whether replacing a workflow with `incomingGraph` would stop a run paused on `nodeId` from
 * continuing, given the continuation its attempt is bound to.
 *
 * This is the judgement the deploy-time warning injects into the catalog loader, which cannot import
 * it: the loader lives in the package this one depends on. Exported as one function so the deploy
 * path and its tests share a single definition — two copies of this expression could disagree, and
 * the one in the deploy path is the one nobody would notice being wrong.
 */
export function wouldInvalidatePausedRun(input: {
  incomingGraph: WorkflowGraph;
  nodeId: string;
  boundContinuationDigest: string | null;
}): boolean {
  return (
    input.boundContinuationDigest !== continuationSurfaceDigest(input.incomingGraph, input.nodeId)
  );
}

/**
 * The continuation surface as one digest per bound fact, keyed by name. A missing node is a single
 * `node.missing` fact, so the absence is itself a fact that can be named and compared.
 */
export function continuationFacts(graph: WorkflowGraph, nodeId: string): Record<string, string> {
  const surface = continuationSurface(graph, nodeId);
  if (surface.node === null) return { [`${NODE_FACT_PREFIX}missing`]: factDigest(nodeId) };

  const facts: Record<string, string> = {};
  for (const [field, value] of Object.entries(surface.node)) {
    facts[`${NODE_FACT_PREFIX}${field}`] = factDigest(value);
  }
  for (const [name, entry] of Object.entries(surface.registry)) {
    facts[`${REGISTRY_FACT_PREFIX}${name}`] = factDigest(entry);
  }
  return facts;
}

/**
 * Digest of the run's continuation surface; the value a paused step attempt is bound to. It is the
 * digest of the fact map, so the compared value and the explanation of a mismatch are the same
 * thing seen at two resolutions.
 */
export function continuationSurfaceDigest(graph: WorkflowGraph, nodeId: string): string {
  return factDigest(continuationFacts(graph, nodeId));
}

/**
 * The facts that differ between what a run is bound to and what the definition says now: facts whose
 * digest changed, facts the definition no longer has, and facts it gained. Names only — the values
 * are digests, so nothing about either definition's content is exposed.
 */
export function continuationFactDifference(
  bound: Record<string, string>,
  current: Record<string, string>,
): { changed: string[]; removed: string[]; added: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [name, digest] of Object.entries(bound)) {
    if (!(name in current)) removed.push(name);
    else if (current[name] !== digest) changed.push(name);
  }
  for (const name of Object.keys(current)) {
    if (!(name in bound)) added.push(name);
  }
  return { changed: changed.sort(), removed: removed.sort(), added: added.sort() };
}
