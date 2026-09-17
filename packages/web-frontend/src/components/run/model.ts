/**
 * View model of the run page: the unit 3 projection (`ExecutionProgress`) read as blocks with
 * their run state, plus the definition facts a block's steps show (type, summary, expected
 * evidence). Nothing here derives run state: statuses, pass counts, the route and the variables
 * are the server's; this module only joins the process blocks with the per-block run facts and
 * looks up the steps' authored text in the workflow definition.
 */

import type { WorkflowGraph, WorkflowNode } from "../../types/workflow-types";
import type {
  BlockDurationStatistics,
  ExecutionBlockList,
  ExecutionBlockStatus,
  ExecutionBlockTiming,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionRouteEntry,
  WorkflowVersionStatistics,
} from "@mcp-moira/workflow-engine/progress-visual";

export type { ExecutionBlockStatus, ExecutionProgress };
export type { BlockDurationStatistics, WorkflowVersionStatistics };

/** A block's passes with their durations, as the projection carries them. */
export type RunTiming = ExecutionBlockTiming;
/** The list a block is bound to, as the projection carries it; null when it binds none. */
export type RunList = ExecutionBlockList | null;

/**
 * The projection as the pages receive it: `GET /api/executions/:id/progress` attaches the typical
 * durations of the version the run started on, which the engine's own projection does not carry.
 */
export interface RunProgress extends ExecutionProgress {
  statistics?: WorkflowVersionStatistics | null;
}

export interface RunTransition {
  to: string;
  label: string;
  cycle?: { cause: string; exit: string };
  edges: string[];
}

/** One process block with the run's projection of it. */
export interface RunBlock {
  id: string;
  /** Zero-based position in process order. */
  index: number;
  name: string;
  description: string;
  nodeIds: string[];
  transitions: RunTransition[];
  status: ExecutionBlockStatus;
  iterations: number;
  visits: number;
  currentNodeId: string | null;
  content: ExecutionProgressContent;
  /** The block's passes with their durations, live pass included. */
  timing: RunTiming;
  /** The list the block is bound to, with its done/total; null when it binds none. */
  list: RunList;
  /** Typical durations of this block over earlier runs; absent when no statistics were given. */
  stats?: BlockDurationStatistics;
}

const PENDING: Pick<
  ExecutionProgressNode,
  "status" | "iterations" | "visits" | "currentNodeId" | "content" | "timing" | "list"
> = {
  status: "pending",
  iterations: 0,
  visits: 0,
  currentNodeId: null,
  content: { summary: null, details: [], outcome: null, next: null },
  timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
  list: null,
};

/**
 * The process blocks in order, each joined with the run's projection of it and, when statistics
 * are given, with the typical durations recorded for it.
 */
export function runBlocks(
  progress: ExecutionProgress,
  statistics?: WorkflowVersionStatistics | null,
): RunBlock[] {
  const byId = new Map(progress.nodes.map((node) => [node.id, node]));
  const statsById = new Map((statistics?.blocks ?? []).map((entry) => [entry.blockId, entry]));
  return progress.process.blocks.map((block, index) => {
    const run = byId.get(block.id) ?? PENDING;
    const stats = statsById.get(block.id);
    return {
      id: block.id,
      index,
      name: byId.get(block.id)?.label ?? block.label,
      description: block.description,
      nodeIds: block.nodeIds,
      transitions: block.transitions,
      status: run.status,
      iterations: run.iterations,
      visits: run.visits,
      currentNodeId: run.currentNodeId,
      content: renderedContent(run.content, [
        block.description,
        byId.get(block.id)?.label ?? block.label,
      ]),
      timing: run.timing,
      list: run.list,
      ...(stats ? { stats } : {}),
    };
  });
}

/**
 * The run's rendered content without the summary when it says what the block's title or
 * description already says: the description is derived from the same summary text, and a
 * summary template may render to the block's name, so either would appear twice under the title.
 */
function renderedContent(
  content: ExecutionProgressContent,
  shownAlready: readonly string[],
): ExecutionProgressContent {
  if (content.summary === null) return content;
  const summary = content.summary.trim();
  if (!shownAlready.some((text) => text.trim() === summary)) return content;
  return { ...content, summary: null };
}

export function blockById(blocks: readonly RunBlock[]): Map<string, RunBlock> {
  return new Map(blocks.map((block) => [block.id, block]));
}

/** The block the run is on: active or waiting. */
export function currentBlockId(blocks: readonly RunBlock[]): string | null {
  return blocks.find((b) => b.status === "active" || b.status === "waiting")?.id ?? null;
}

/** Which block owns each node. */
export function nodeOwners(blocks: readonly RunBlock[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const block of blocks) for (const id of block.nodeIds) owner.set(id, block.id);
  return owner;
}

/** Node types whose visits route the run instead of doing a block's work. */
export const ROUTING_NODE_TYPES: ReadonlySet<string> = new Set([
  "start",
  "condition",
  "expression",
]);

/** One expected-evidence field of a step: a property of its input schema. */
export interface EvidenceField {
  name: string;
  type: string | null;
  description: string | null;
  required: boolean;
  enum: unknown[] | null;
}

/** A step of a block as the run page describes it. */
export interface StepInfo {
  id: string;
  type: string;
  displayName: string | null;
  /** First sentence of the directive or message, bounded; empty for routing nodes. */
  summary: string;
  /** The full directive or message text, when the node has one. */
  text: string | null;
  evidence: EvidenceField[];
  routing: boolean;
  /** The directive's completion condition, when the node has one. */
  completionCondition: string | null;
  /** Expressions the node evaluates before it routes. */
  expressions: string[];
  /** The node's routing cases, in authored order. */
  cases: Array<{ when: unknown; output: string }>;
  /** The authored progress label and content of the node, when given. */
  progressLabel: string | null;
  progressContent: string | null;
}

/** One outgoing connection of a step: inside its block (points at a sibling step) or out of it. */
export interface StepConnection {
  label: string;
  target: string;
  internal: boolean;
  /** The block the target belongs to when the connection leaves the step's block. */
  targetBlockId: string | null;
  /** What the chip shows: the sibling step's id, or the target block's name. */
  targetName: string;
}

/** An edge arriving at a step that the graph names in the card instead of drawing as a line. */
export interface StepArrival {
  /** The link's id, which the focus context lights. */
  linkId: string;
  sourceId: string;
  sourceName: string;
  /** The block the source belongs to, when it is another block. */
  sourceBlockName: string | null;
  label: string;
  /** A transition back to an earlier block or to its own block. */
  isReturn: boolean;
}

/**
 * The connections of a step as the cards show them: the same classification on the run page's
 * block panel, the flow page's split view and the technical graph, so a step reads the same
 * everywhere.
 */
export function stepConnections(
  node: { connections?: Record<string, string> } | undefined,
  block: Pick<RunBlock, "id" | "nodeIds">,
  blocks: readonly RunBlock[],
): StepConnection[] {
  if (!node?.connections) return [];
  const inBlock = new Set(block.nodeIds);
  const owners = nodeOwners(blocks);
  const byId = blockById(blocks);
  return Object.entries(node.connections).map(([label, target]) => {
    const internal = inBlock.has(target);
    const targetBlockId = internal ? null : (owners.get(target) ?? null);
    return {
      label,
      target,
      internal,
      targetBlockId,
      targetName: internal ? target : (byId.get(targetBlockId ?? "")?.name ?? target),
    };
  });
}

const SUMMARY_LIMIT = 180;

/** The first sentence of an authored text, cut at a sentence end or the limit. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > SUMMARY_LIMIT
    ? `${sentence.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
    : sentence;
}

interface SchemaLike {
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  /** Declared global variables the step writes; the engine inlines their registry schema. */
  globalInputs?: string[];
}

function fieldOf(
  name: string,
  property: Record<string, unknown> | undefined,
  required: boolean,
): EvidenceField {
  return {
    name,
    type: typeof property?.type === "string" ? property.type : null,
    description: typeof property?.description === "string" ? property.description : null,
    required,
    enum: Array.isArray(property?.enum) ? property.enum : null,
  };
}

/**
 * The fields a step's input schema demands, in schema order: its own properties, then the
 * global inputs it declares, described by the workflow's variable registry the way the engine
 * inlines them before validation.
 */
export function evidenceFields(
  schema: unknown,
  registry?: Record<string, Record<string, unknown>>,
): EvidenceField[] {
  if (!schema || typeof schema !== "object") return [];
  const { properties, required, globalInputs } = schema as SchemaLike;
  const requiredSet = new Set(required ?? []);
  const fields = Object.entries(properties ?? {}).map(([name, property]) =>
    fieldOf(name, property, requiredSet.has(name)),
  );
  for (const name of globalInputs ?? []) {
    if (fields.some((field) => field.name === name)) continue;
    fields.push(fieldOf(name, registry?.[name], requiredSet.has(name)));
  }
  return fields;
}

function authoredText(node: WorkflowNode): string | null {
  const record = node as unknown as Record<string, unknown>;
  for (const key of ["directive", "message", "expression"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      return (value as string[]).join("\n");
  }
  return null;
}

/** Describe the steps of a block from the workflow definition, in the block's node order. */
/**
 * A block's node ids in the order the process runs them: from the block's entry nodes (the ones
 * no other node of the block leads to, or the first when every node has a predecessor), along
 * the connections in authored order, depth first; what the walk never reaches keeps its
 * definition order at the end.
 */
export function orderNodeIds(
  workflow: WorkflowGraph | undefined,
  nodeIds: readonly string[],
): string[] {
  const inBlock = new Set(nodeIds);
  const nodes = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const targetsOf = (id: string): string[] => {
    const connections = (nodes.get(id) as { connections?: Record<string, string> } | undefined)
      ?.connections;
    return Object.values(connections ?? {}).filter((to) => inBlock.has(to));
  };
  const hasPredecessor = new Set<string>();
  for (const id of nodeIds) for (const to of targetsOf(id)) if (to !== id) hasPredecessor.add(to);
  const entries = nodeIds.filter((id) => !hasPredecessor.has(id));
  const order: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    for (const to of targetsOf(id)) walk(to);
  };
  for (const id of entries.length > 0 ? entries : nodeIds.slice(0, 1)) walk(id);
  for (const id of nodeIds) walk(id);
  return order;
}

/**
 * `done/total` of a bound list as one wording everywhere: a counter the binding did not resolve
 * reads as "—" (never "0", never "?"), on the card, in the contents and in the panel alike.
 */
export function listProgressLabel(
  list: { done: number | null; total: number | null } | null | undefined,
): string | null {
  if (!list || (list.done === null && list.total === null)) return null;
  const part = (n: number | null) => (n === null ? "—" : String(n));
  return `${part(list.done)}/${part(list.total)}`;
}

export function stepsOf(
  workflow: WorkflowGraph | undefined,
  nodeIds: readonly string[],
): StepInfo[] {
  const nodes = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  return nodeIds.map((id) => {
    const node = nodes.get(id);
    if (!node) {
      return {
        id,
        type: "unknown",
        displayName: null,
        summary: "",
        text: null,
        evidence: [],
        routing: false,
        completionCondition: null,
        expressions: [],
        cases: [],
        progressLabel: null,
        progressContent: null,
      };
    }
    const text = authoredText(node);
    const routing = ROUTING_NODE_TYPES.has(node.type);
    return {
      id,
      type: node.type,
      displayName: node.metadata?.displayName ?? null,
      summary: !routing && text ? firstSentence(text) : "",
      text,
      evidence: evidenceFields(
        (node as { inputSchema?: unknown }).inputSchema,
        workflow?.variableRegistry as unknown as
          Record<string, Record<string, unknown>> | undefined,
      ),
      routing,
      completionCondition: stringField(node, "completionCondition"),
      expressions: Array.isArray((node as { expressions?: unknown }).expressions)
        ? ((node as { expressions: unknown[] }).expressions.filter(
            (e): e is string => typeof e === "string",
          ) as string[])
        : [],
      cases: Array.isArray((node as { cases?: unknown }).cases)
        ? ((node as { cases: Array<{ when: unknown; output: string }> }).cases ?? [])
        : [],
      progressLabel: stringField(node, "progressActiveLabel"),
      progressContent: stringField(node, "progressActiveContent"),
    };
  });
}

function stringField(node: object, key: string): string | null {
  const value = (node as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** The node the run waits for, with its expected evidence, or null when nothing waits. */
export function waitingStep(
  workflow: WorkflowGraph | undefined,
  waitingForInputNodeId: string | null | undefined,
): StepInfo | null {
  if (!waitingForInputNodeId) return null;
  return stepsOf(workflow, [waitingForInputNodeId])[0] ?? null;
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "—";
  return JSON.stringify(value);
}

/** Props every mode of the run page receives. */
export interface RunViewProps {
  /** The projection shown: the whole run, or the run at the cursor while one is set. */
  progress: ExecutionProgress;
  blocks: RunBlock[];
  /** The whole recorded route, whatever the cursor: the route mode lists every visit and dims later ones. */
  route: ExecutionRouteEntry[];
  workflow?: WorkflowGraph;
  selectedBlockId: string | null;
  onSelectBlock: (blockId: string | null) => void;
  /** Route cursor (visit sequence number); null means the whole run. */
  cursor: number | null;
  onSetCursor: (at: number | null) => void;
  /** Open a step on the technical graph (the page switches views for it). */
  onFocusNode?: (nodeId: string) => void;
  /** A list item on a block card was clicked: select the block and show that item in its panel. */
  onSelectListItem?: (blockId: string, index: number) => void;
}

/** What a block's visits wrote up to the cursor: the latest value per name, with its visit. */
export function blockWrites(
  progress: ExecutionProgress,
  blockId: string,
  cursor: number | null,
): Array<{ name: string; value: unknown; seq: number; adjusted: boolean }> {
  const history = new Map<string, Map<number, { value: unknown; adjusted: boolean }>>();
  for (const variable of progress.variables) {
    history.set(
      variable.name,
      new Map(
        variable.history.map((change) => [
          change.seq,
          { value: change.value, adjusted: Boolean(change.adjusted) },
        ]),
      ),
    );
  }
  const latest = new Map<
    string,
    { name: string; value: unknown; seq: number; adjusted: boolean }
  >();
  for (const visit of progress.route) {
    if (visit.blockId !== blockId) continue;
    if (cursor !== null && visit.seq > cursor) break;
    for (const name of visit.changed) {
      const change = history.get(name)?.get(visit.seq);
      latest.set(name, {
        name,
        value: change?.value,
        seq: visit.seq,
        adjusted: change?.adjusted ?? Boolean(visit.adjusted),
      });
    }
  }
  return [...latest.values()];
}
