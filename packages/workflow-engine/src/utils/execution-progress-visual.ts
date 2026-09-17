/**
 * The visual model of the progress picture: the run's header (task, title, goal, facts) above the
 * process drawn the way the run page's map draws it — every block a ported card with a title band
 * (index badge, name, status chip, pass count), input ports on the left named by the transitions
 * that arrive, output ports on the right named by the transitions that leave, a double port at the
 * bottom for the transitions back to the card itself, and a centre with the description, the run
 * facts (time spent, `done/total` with the current item, the typical durations of the version)
 * and, in the `cards` view, the block's content lines. The geometry is the map's own
 * (`process-layout`, `process-geometry`): the same blocks and transitions go through the same
 * layout, the picture measuring its cards with its own text metric and passing the sizes in.
 *
 * The rows preset is drawn when the viewport holds it at the type scale; otherwise — and always
 * below the phone width — the stacked preset, which a viewport of any width holds one column at a
 * time; a drawing still wider than the viewport is scaled down as one piece, never re-wrapped.
 * Everything here is pure and deterministic; the renderer draws exactly what was measured.
 */

import type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ProgressFactTone,
} from "./execution-progress-contract.js";
import type { ProcessProjection, ProcessTransition } from "./process-derivation.js";
import type { BlockDurationStatistics, WorkflowVersionStatistics } from "./execution-statistics.js";
import {
  ellipsizeProgressText,
  formatProgressDuration,
  progressTextWidth,
  wrapProgressTextToWidth,
} from "./execution-progress-text.js";
import { listProgressLabel } from "./progress-facts.js";
import {
  layoutBlocks,
  transitionKey,
  type BlockLayout,
  type LayoutBlock,
  type LayoutBlocksOptions,
} from "./process-layout.js";
import { portRanks, portedPath } from "./process-geometry.js";
export type {
  ExecutionBlockList,
  ExecutionBlockStatus,
  ExecutionBlockTiming,
  ExecutionListItem,
  ExecutionPassTiming,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ExecutionRouteEntry,
  ExecutionVariableChange,
  ExecutionVariableState,
} from "./execution-progress-contract.js";
/** The typical durations a run is compared with; the run page and the flow page both read them. */
export type {
  BlockDurationStatistics,
  DurationSample,
  WorkflowVersionStatistics,
} from "./execution-statistics.js";
/** The one model the map and the picture share: the facts wording and the process geometry. */
export * from "./progress-facts.js";
export * from "./process-layout.js";
export * from "./process-geometry.js";

export type ProgressTheme = "light" | "dark";
/** `cards`: every block with its content lines (the default). `process`: the compact cards alone,
 * the run page's map as a picture. */
export type ProgressView = "cards" | "process";
export interface ProgressVisualOptions {
  theme?: ProgressTheme;
  viewportWidth?: number;
  minWidth?: number;
  view?: ProgressView;
  /** Block ids (or authored node ids, resolved to their block) left out of the image. */
  hide?: string[];
  /** Block ids (or authored node ids) drawn as a title band alone. */
  collapse?: string[];
}
export type ProgressVisualLineKind = "summary" | "detail" | "outcome" | "next";
export interface ProgressVisualLine {
  text: string;
  kind: ProgressVisualLineKind;
  /** The marker drawn before the text (`• `, `✓ `, `→ `); empty on a continuation line. */
  prefix: string;
}
export interface ProgressVisualFact {
  label: string;
  value: string;
  tone: ProgressFactTone;
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
  valueLines: string[];
}
/** An axis-aligned box in image pixels. */
export interface ProgressVisualBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A pill of text with its box: the `×n` badge, the status chip, the index badge. */
export interface ProgressVisualBadge extends ProgressVisualBox {
  text: string;
}
/** The card's colour, as the map's `BLOCK_TONE` selects it from the run status. */
export type ProgressCardTone = "neutral" | "active" | "waiting" | "done";
/** The port's colour, as the map's `PORT_TONE`: an ordinary transition, one into a hub, a return. */
export type ProgressPortKind = "forward" | "external" | "return";
/** The edge's colour, weight and dash, as the map's `EDGE_LOOK`. */
export type ProgressEdgeKind = "forward" | "skip" | "hub" | "return" | "self";

/** One port on a card: a pill inside the card and the handle on the card's border. */
export interface ProgressVisualPort extends ProgressVisualBox {
  /** The transition key the port and its edge share. */
  id: string;
  kind: ProgressPortKind;
  /** The port's name: the source block for an input, the transition label for an output. */
  label: string;
  /** Secondary text: the transition label for an input, the target block for an output. */
  detail: string | null;
  /** What is drawn, fitted to the pill: the name, and the detail after it when there is room. */
  text: string;
  detailText: string | null;
  /** Where the drawn text starts; the detail starts at `detailX` (right after the name). */
  textX: number;
  detailX: number;
  /** Where the edge attaches, on the card's border. */
  handleX: number;
  handleY: number;
}

export interface ProgressVisualNode extends ProgressVisualBox {
  id: string;
  label: string;
  labelLines: string[];
  /** One-based position in process order, the index badge's number. */
  index: number;
  state: ExecutionProgressState;
  status: ExecutionBlockStatus;
  tone: ProgressCardTone;
  /** Completed passes; `×n` is shown when the block ran more than once. */
  iterations: number;
  /** Drawn as the title band alone, without ports. */
  collapsed: boolean;
  /** The row and the drawn column the layout gave the block. */
  row: number;
  rank: number;
  /** The title band: its height, the index badge, the title's first baseline and start. */
  bandHeight: number;
  indexBadge: ProgressVisualBadge;
  titleX: number;
  titleY: number;
  /** The status chip at the band's right, and the pass count before it when the block repeated. */
  chip: ProgressVisualBadge;
  /** The chip's words, as the map words them (`agent on the step`, `waiting for you`, …). */
  statusLine: string;
  badge: ProgressVisualBadge | null;
  /** The centre: its left edge and right edge (text never passes `textRight`). */
  contentX: number;
  textRight: number;
  /** The description, two lines at most; baseline of the first at `descriptionY`. */
  descriptionLines: string[];
  descriptionY: number;
  /** Time spent and, for a bound block, `done/total: current item`; one line, ellipsised. */
  factsLine: string;
  factsY: number;
  /** `typically …` from the version's statistics; null when none were given or sampled. */
  typicalLine: string | null;
  typicalY: number;
  /** Content lines (`cards` view); baseline of the first at `contentY`. */
  lines: ProgressVisualLine[];
  contentY: number;
  inputs: ProgressVisualPort[];
  outputs: ProgressVisualPort[];
  /** Transitions back to the card itself, on the band beneath the centre; empty without any. */
  selfPorts: ProgressVisualPort[];
  /** The top of the self-loop band, or null when the card has none. */
  selfBandY: number | null;
  focusNodeId: string | null;
}

export interface ProgressVisualEdge {
  id: string;
  source: string;
  target: string;
  kind: ProgressEdgeKind;
  /** SVG path in diagram coordinates, from the source port's handle to the target port's. */
  path: string;
  /** The transition label; the ports name it, the line itself carries no text. */
  label: string;
  cycle: boolean;
}

/** Where the diagram (the laid-out process) sits in the image and how it was scaled to fit. */
export interface ProgressVisualDiagram {
  x: number;
  y: number;
  /** The drawing's own size, before scaling. */
  width: number;
  height: number;
  /** ≤ 1: the drawing was wider than the image and was scaled down as one piece. */
  scale: number;
  preset: "default" | "vertical";
}

export interface ProgressVisualModel {
  taskTitle: string;
  taskTitleLines: string[];
  title: string | null;
  titleLines: string[];
  goal: string | null;
  goalLines: string[];
  facts: ProgressVisualFact[];
  theme: ProgressTheme;
  view: ProgressView;
  /** The font sizes and line heights every text of the image is measured and drawn with. */
  type: ProgressTypeScale;
  width: number;
  height: number;
  /** Header text starts at `headerX`, its first baseline at `headerY`, and stays narrower than `headerWidth`. */
  headerX: number;
  headerY: number;
  headerWidth: number;
  stagesTop: number;
  stagesHeight: number;
  diagram: ProgressVisualDiagram;
  /** The shared layout the cards and edges were placed by (diagram coordinates). */
  layout: BlockLayout;
  nodes: ProgressVisualNode[];
  edges: ProgressVisualEdge[];
}

const PADDING_X = 40;
const PADDING_BOTTOM = 32;
const HEADER_TOP = 28;
const FACT_GAP = 12;
const FACT_MIN_WIDTH = 180;
const FACT_PADDING_X = 12;
/** A viewport this wide or narrower is a phone: the stacked preset and the larger type. */
export const PROGRESS_PHONE_MAX_WIDTH = 720;

/** Font sizes (px) and the line heights they are set on; `header` and `fact` are the top of the image. */
export interface ProgressTypeScale {
  /** Block title. */
  title: number;
  titleLine: number;
  /** Block description, facts and content. */
  content: number;
  contentLine: number;
  /** Port pills and the status chip. */
  label: number;
  labelLine: number;
  /** The `×n` badge, the index badge and their box height. */
  badge: number;
  badgeHeight: number;
  header: {
    task: number;
    taskLine: number;
    title: number;
    titleLine: number;
    goal: number;
    goalLine: number;
  };
  fact: { label: number; value: number; line: number };
  /** The ported card's measures at this scale. */
  card: {
    /** Width of a port column and of the centre column. */
    portColumn: number;
    centre: number;
    /** Height of a port pill and the step between two pills. */
    pill: number;
    pillStep: number;
    /** Padding inside the card and inside a pill. */
    padding: number;
    pillPadding: number;
  };
}

const DESKTOP_TYPE: ProgressTypeScale = {
  title: 14,
  titleLine: 18,
  content: 12,
  contentLine: 17,
  label: 11,
  labelLine: 14,
  badge: 11,
  badgeHeight: 18,
  header: { task: 20, taskLine: 26, title: 13, titleLine: 18, goal: 14, goalLine: 20 },
  fact: { label: 11, value: 13, line: 17 },
  card: { portColumn: 150, centre: 220, pill: 20, pillStep: 26, padding: 10, pillPadding: 8 },
};

const PHONE_TYPE: ProgressTypeScale = {
  title: 18,
  titleLine: 22,
  content: 14,
  contentLine: 19,
  label: 12,
  labelLine: 16,
  badge: 12,
  badgeHeight: 20,
  header: { task: 24, taskLine: 30, title: 15, titleLine: 20, goal: 16, goalLine: 22 },
  fact: { label: 12, value: 15, line: 19 },
  card: { portColumn: 132, centre: 168, pill: 22, pillStep: 28, padding: 10, pillPadding: 8 },
};

/** The type scale for a viewport: the phone scale up to `PROGRESS_PHONE_MAX_WIDTH`, the desktop one above. */
export function progressTypeScale(viewportWidth: number): ProgressTypeScale {
  return viewportWidth <= PROGRESS_PHONE_MAX_WIDTH ? PHONE_TYPE : DESKTOP_TYPE;
}
export const PROGRESS_IMAGE_MAX_WIDTH = 4096;
export const PROGRESS_IMAGE_MIN_WIDTH = 480;
export const PROGRESS_VISUAL_MIN_WIDTH = 320;

const sortedUnique = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

export function normalizeProgressVisualOptions(
  options: ProgressVisualOptions = {},
): Required<ProgressVisualOptions> {
  const requested = Math.round(options.viewportWidth ?? 1280);
  const minimum = Math.min(
    PROGRESS_IMAGE_MIN_WIDTH,
    Math.max(PROGRESS_VISUAL_MIN_WIDTH, Math.round(options.minWidth ?? PROGRESS_IMAGE_MIN_WIDTH)),
  );
  return {
    theme: options.theme === "dark" ? "dark" : "light",
    viewportWidth: Math.min(PROGRESS_IMAGE_MAX_WIDTH, Math.max(minimum, requested)),
    minWidth: minimum,
    view: options.view === "process" ? "process" : "cards",
    hide: sortedUnique(options.hide),
    collapse: sortedUnique(options.collapse),
  };
}

/**
 * Resolve block or authored node ids against a process: a node id names the block that owns it.
 * Returns the block ids in process order and the ids that name nothing.
 */
export function resolveProgressBlockIds(
  process: ProcessProjection,
  ids: readonly string[],
): { blockIds: string[]; unknown: string[] } {
  const owner = new Map<string, string>();
  for (const block of process.blocks) {
    owner.set(block.id, block.id);
    for (const nodeId of block.nodeIds) if (!owner.has(nodeId)) owner.set(nodeId, block.id);
  }
  const unknown: string[] = [];
  const resolved = new Set<string>();
  for (const id of ids) {
    const blockId = owner.get(id);
    if (blockId) resolved.add(blockId);
    else unknown.push(id);
  }
  const order = new Map(process.blocks.map((block, index) => [block.id, index]));
  return {
    blockIds: [...resolved].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    unknown,
  };
}

/** A transition of the aggregated view after hidden blocks are collapsed out of it. */
export interface VisibleTransition {
  to: string;
  label: string;
  cycle: boolean;
}

/**
 * The projection with hidden blocks removed: `nodes` keep their order minus the hidden ones, the
 * display chain (`connections.default`) skips them, and every process transition into a hidden
 * block is re-targeted to where that block leads (labels joined), so the picture stays connected.
 * Unknown ids are ignored here; the mint path refuses them before a token exists.
 */
export function applyProgressVisibility(
  progress: ExecutionProgress,
  hide: readonly string[],
  collapse: readonly string[] = [],
): {
  nodes: ExecutionProgressNode[];
  transitions: Map<string, VisibleTransition[]>;
  collapsed: Set<string>;
  hubs: Set<string>;
} {
  const hidden = new Set(resolveProgressBlockIds(progress.process, hide).blockIds);
  const collapsed = new Set(
    resolveProgressBlockIds(progress.process, collapse).blockIds.filter((id) => !hidden.has(id)),
  );
  const shownOrder = progress.nodes.filter((node) => !hidden.has(node.id)).map((node) => node.id);
  const shownSet = new Set(shownOrder);
  const successor = new Map<string, string | undefined>();
  const skipHidden = (target: string | undefined, seen = new Set<string>()): string | undefined => {
    let cursor = target;
    while (cursor && hidden.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = successor.get(cursor);
    }
    return cursor && shownSet.has(cursor) ? cursor : undefined;
  };
  for (const node of progress.nodes) successor.set(node.id, node.connections.default);
  const nodes = progress.nodes
    .filter((node) => !hidden.has(node.id))
    .map((node) => {
      const next = skipHidden(node.connections.default);
      return { ...node, connections: next ? { default: next } : {} };
    });

  const byId = new Map(progress.process.blocks.map((block) => [block.id, block]));
  const transitions = new Map<string, VisibleTransition[]>();
  const expand = (
    transition: ProcessTransition,
    seen: Set<string>,
    label: string,
    cycle: boolean,
  ): VisibleTransition[] => {
    if (!hidden.has(transition.to)) return [{ to: transition.to, label, cycle }];
    if (seen.has(transition.to)) return [];
    const next = byId.get(transition.to);
    if (!next) return [];
    const nextSeen = new Set(seen).add(transition.to);
    return next.transitions.flatMap((onward) =>
      expand(onward, nextSeen, `${label} → ${onward.label}`, cycle || Boolean(onward.cycle)),
    );
  };
  for (const block of progress.process.blocks) {
    if (hidden.has(block.id)) continue;
    const list: VisibleTransition[] = [];
    for (const transition of block.transitions) {
      for (const visible of expand(
        transition,
        new Set([block.id]),
        transition.label,
        Boolean(transition.cycle),
      )) {
        if (!shownSet.has(visible.to)) continue;
        // Two authored transitions between one pair of blocks stay two ports, as on the map;
        // only an exact repeat (the same label through the same hidden blocks) is folded.
        const same = list.some(
          (t) => t.to === visible.to && t.cycle === visible.cycle && t.label === visible.label,
        );
        if (!same) list.push(visible);
      }
    }
    transitions.set(block.id, list);
  }
  const hubs = new Set(progress.process.hubs.filter((id) => shownSet.has(id)));
  return { nodes, transitions, collapsed, hubs };
}

/** The marker a content line is drawn with; the model owns it so the renderer draws what was measured. */
function linePrefix(kind: ProgressVisualLineKind): string {
  return kind === "detail" ? "• " : kind === "outcome" ? "✓ " : kind === "next" ? "→ " : "";
}

/** Wrap `value` as content lines of `kind`: the first carries the marker, every line fits `maxWidth`. */
function wrapContentLines(
  value: string,
  kind: ProgressVisualLineKind,
  maxWidth: number,
  type: ProgressTypeScale,
): ProgressVisualLine[] {
  const prefix = linePrefix(kind);
  const weight = kind === "summary" ? "semibold" : "regular";
  const prefixWidth = progressTextWidth(prefix, type.content, weight);
  return wrapProgressTextToWidth(
    value,
    Math.max(24, maxWidth - prefixWidth),
    type.content,
    weight,
  ).map((text, index) => ({ text, kind, prefix: index === 0 ? prefix : "" }));
}

function contentLines(
  content: ExecutionProgressContent,
  maxWidth: number,
  type: ProgressTypeScale,
): ProgressVisualLine[] {
  const lines: ProgressVisualLine[] = [];
  const append = (value: string | null, kind: ProgressVisualLineKind) => {
    if (value) lines.push(...wrapContentLines(value, kind, maxWidth, type));
  };
  append(content.summary, "summary");
  content.details.forEach((detail) => append(detail, "detail"));
  append(content.outcome, "outcome");
  append(content.next, "next");
  return lines;
}

/**
 * The status word of a block, as the web map words it: only a person being waited for reads
 * `waiting for you`; the agent on the waiting or active block is `agent on the step`.
 */
export function progressStatusText(
  status: ExecutionBlockStatus,
  iterations: number,
  waitingFor: ExecutionProgress["waitingFor"],
): string {
  switch (status) {
    case "waiting":
      return waitingFor === "user" ? "waiting for you" : "agent on the step";
    case "active":
      return "agent on the step";
    case "done":
      return "completed";
    case "repeated":
      return `repeated ×${iterations}`;
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

/** The card tone a block's run status selects; the map's `BLOCK_TONE`. */
export function progressCardTone(status: ExecutionBlockStatus): ProgressCardTone {
  switch (status) {
    case "active":
      return "active";
    case "waiting":
      return "waiting";
    case "done":
    case "repeated":
      return "done";
    default:
      return "neutral";
  }
}

/**
 * The facts of a block on one line, from the fullest form to the one that must survive: the time
 * spent (`total`, plus the open pass while one runs) and, for a bound block, `done/total` with the
 * current item. Nothing measured reads `—`; a counter the binding did not resolve reads `—` too,
 * as the map's `listProgressLabel` words it. `progressFactsCandidates` lists the forms in order of
 * preference — with the open pass, without it, without the item's title, the count alone — so a
 * narrow box drops the least important part before anything is cut; `progressFactsText` is the
 * fullest form.
 */
export function progressFactsCandidates(node: ExecutionProgressNode): string[] {
  // As the map's chips: a block the run has not measured carries no time at all (never `0 s`,
  // and no dash either), and a block bound to no list carries no count.
  const measured = node.timing.totalMs !== null || node.timing.currentMs !== null;
  const total = measured ? formatProgressDuration(node.timing.totalMs) : null;
  const withPass =
    node.timing.currentMs !== null
      ? `${total} · this pass ${formatProgressDuration(node.timing.currentMs)}`
      : null;
  const list = node.list;
  const count = listProgressLabel(list);
  if (!list || count === null) return [withPass, total].filter((f): f is string => f !== null);
  const titled = list.currentTitle ? `${count}: ${list.currentTitle}` : count;
  const forms = [
    withPass ? `${withPass} · ${titled}` : null,
    total ? `${total} · ${titled}` : titled,
    total ? `${total} · ${count}` : count,
    count,
  ].filter((form): form is string => form !== null);
  return [...new Set(forms)];
}

/** The fullest facts form; empty for a block with nothing measured and no list. */
export function progressFactsText(node: ExecutionProgressNode): string {
  return progressFactsCandidates(node)[0] ?? "";
}

/**
 * What the block typically costs on this version, as the map's typical durations read: the median
 * time a run spends in the block, the median pass when the block usually repeats, and the median
 * pass count. Null when the version has no sampled run for the block.
 */
export function progressTypicalCandidates(stats: BlockDurationStatistics | undefined): string[] {
  if (!stats) return [];
  const sampled = Math.max(stats.pass.sampleCount, stats.run.sampleCount);
  if (sampled === 0 || stats.run.medianMs === null) return [];
  const run = `typically ${formatProgressDuration(stats.run.medianMs)}`;
  if (stats.typicalPasses === null || stats.typicalPasses <= 1) return [run];
  const passes = `×${stats.typicalPasses}`;
  const forms = [
    stats.pass.medianMs !== null
      ? `${run} · pass ${formatProgressDuration(stats.pass.medianMs)} · ${passes}`
      : null,
    `${run} · ${passes}`,
    run,
  ];
  return forms.filter((form): form is string => form !== null);
}

/** The fullest typical form; null when the version has no sampled run for the block. */
export function progressTypicalText(stats: BlockDurationStatistics | undefined): string | null {
  return progressTypicalCandidates(stats)[0] ?? null;
}

/** The typical form that fits the box, the last one ellipsised when even it does not. */
function fitTypicalLine(
  stats: BlockDurationStatistics | undefined,
  width: number,
  font: number,
): string | null {
  const candidates = progressTypicalCandidates(stats);
  if (!candidates.length) return null;
  const whole = candidates.find((text) => progressTextWidth(text, font) <= width);
  return whole ?? ellipsizeProgressText(candidates[candidates.length - 1], width, font);
}

/**
 * The facts line that fits the box: the fullest form that fits, else the titled form ellipsised
 * while the ellipsis still leaves the count intact (the item's title is what gets cut), else the
 * shorter forms, the last one ellipsised when even it does not fit.
 */
function fitFactsLine(node: ExecutionProgressNode, width: number, font: number): string {
  const candidates = progressFactsCandidates(node);
  if (!candidates.length) return "";
  const fits = (text: string) => progressTextWidth(text, font) <= width;
  const list = node.list;
  const count = listProgressLabel(list);
  if (fits(candidates[0])) return candidates[0];
  const titled = candidates.find(
    (candidate) =>
      !!count &&
      !!list?.currentTitle &&
      !candidate.includes("this pass") &&
      candidate.endsWith(list.currentTitle),
  );
  if (titled) {
    const cut = ellipsizeProgressText(titled, width, font);
    if (cut.includes(`${count}: `)) return cut;
  }
  const whole = candidates.find(fits);
  return whole ?? ellipsizeProgressText(candidates[candidates.length - 1], width, font);
}

/** A pill's width for its text at the badge face: text plus padding. */
function pillWidth(text: string, type: ProgressTypeScale): number {
  return progressTextWidth(text, type.badge, "semibold") + 2 * type.card.pillPadding;
}

interface PortSpec {
  id: string;
  kind: ProgressPortKind;
  label: string;
  detail: string | null;
}

/**
 * A port's pill at the badge face: the name first, ellipsised to the pill when it alone does not
 * fit; the detail after it in the room that remains, dropped when fewer than a few glyphs would
 * fit. Positions are relative to the pill's left edge.
 */
function fitPort(
  spec: PortSpec,
  pillInner: number,
  type: ProgressTypeScale,
): Pick<ProgressVisualPort, "text" | "detailText" | "textX" | "detailX"> {
  const font = type.label;
  // A return port carries the return glyph before its name.
  const prefix = spec.kind === "return" ? "↩ " : "";
  const name = ellipsizeProgressText(prefix + spec.label, pillInner, font, "semibold");
  const nameWidth = progressTextWidth(name, font, "semibold");
  const gap = progressTextWidth(" ", font);
  const room = pillInner - nameWidth - gap;
  let detailText: string | null = null;
  if (spec.detail && room >= progressTextWidth("abc…", font)) {
    detailText = ellipsizeProgressText(spec.detail, room, font);
  }
  return {
    text: name,
    detailText,
    textX: type.card.pillPadding,
    detailX: type.card.pillPadding + nameWidth + gap,
  };
}

/** A block's ports, from the visible transitions: inputs from other blocks, outputs, self loops. */
function portSpecs(
  id: string,
  nodes: readonly ExecutionProgressNode[],
  transitions: ReadonlyMap<string, VisibleTransition[]>,
  hubs: ReadonlySet<string>,
): { inputs: PortSpec[]; outputs: PortSpec[]; self: PortSpec[] } {
  const nameOf = (blockId: string) => {
    const index = nodes.findIndex((node) => node.id === blockId);
    return index === -1 ? blockId : `${index + 1}. ${nodes[index].label}`;
  };
  const inputs: PortSpec[] = [];
  for (const other of nodes) {
    if (other.id === id) continue;
    for (const transition of transitions.get(other.id) ?? []) {
      if (transition.to !== id) continue;
      inputs.push({
        id: transitionKey(other.id, transition),
        kind: transition.cycle ? "return" : "forward",
        label: nameOf(other.id),
        detail: transition.label,
      });
    }
  }
  const outputs: PortSpec[] = [];
  const self: PortSpec[] = [];
  for (const transition of transitions.get(id) ?? []) {
    const spec: PortSpec = {
      id: transitionKey(id, transition),
      kind: transition.cycle ? "return" : hubs.has(transition.to) ? "external" : "forward",
      label: transition.label,
      detail: transition.to === id ? null : nameOf(transition.to),
    };
    (transition.to === id ? self : outputs).push(spec);
  }
  return { inputs, outputs, self };
}

/**
 * A card measured with the picture's text metric: its size, and every text and box relative to
 * the card's top-left corner. `placeCard` moves it to where the layout put it.
 */
function measureCard(
  node: ExecutionProgressNode,
  index: number,
  description: string,
  ports: { inputs: PortSpec[]; outputs: PortSpec[]; self: PortSpec[] },
  options: {
    collapsed: boolean;
    view: ProgressView;
    waitingFor: ExecutionProgress["waitingFor"];
    stats: BlockDurationStatistics | undefined;
    type: ProgressTypeScale;
  },
): ProgressVisualNode {
  const { type, collapsed, view } = options;
  const { card } = type;
  const inputs = collapsed ? [] : ports.inputs;
  const outputs = collapsed ? [] : ports.outputs;
  const selfPorts = collapsed ? [] : ports.self;
  const leftColumn = inputs.length ? card.portColumn : 0;
  const rightColumn = outputs.length ? card.portColumn : 0;
  const width = leftColumn + card.centre + rightColumn;

  // The title band: index badge, the title wrapped between the badge and the chip (two lines at
  // most), the pass count and the status chip at the right.
  const statusLine = progressStatusText(node.status, node.iterations, options.waitingFor);
  // The chip is the map's status word alone; the pass count is the `×n` badge beside it.
  const chipText = ellipsizeProgressText(
    node.status === "repeated" ? "repeated" : statusLine,
    Math.floor(width * 0.4),
    type.badge,
    "semibold",
  );
  const chipWidth = pillWidth(chipText, type);
  const badgeText = node.iterations > 1 ? `×${node.iterations}` : null;
  const badgeWidth = badgeText ? progressTextWidth(badgeText, type.badge, "semibold") : 0;
  const indexText = String(index + 1);
  const indexWidth = Math.max(type.badgeHeight, pillWidth(indexText, type));
  const titleX = card.padding + indexWidth + 8;
  const titleRight = width - card.padding - chipWidth - (badgeText ? badgeWidth + 8 : 0) - 8;
  const titleWidth = Math.max(40, titleRight - titleX);
  const wrapped = wrapProgressTextToWidth(node.label, titleWidth, type.title, "bold");
  const labelLines = wrapped.length
    ? wrapped.length > 2
      ? [
          wrapped[0],
          ellipsizeProgressText(wrapped.slice(1).join(" "), titleWidth, type.title, "bold"),
        ]
      : wrapped
    : [node.label];
  const bandHeight = Math.max(
    type.badgeHeight + 2 * card.padding,
    labelLines.length * type.titleLine + 2 * card.padding,
  );
  const titleY = Math.round((bandHeight - labelLines.length * type.titleLine) / 2) + type.title;
  const badgeY = Math.round((bandHeight - type.badgeHeight) / 2);
  const indexBadge = {
    text: indexText,
    x: card.padding,
    y: badgeY,
    width: indexWidth,
    height: type.badgeHeight,
  };
  const chip = {
    text: chipText,
    x: width - card.padding - chipWidth,
    y: badgeY,
    width: chipWidth,
    height: type.badgeHeight,
  };
  const badge = badgeText
    ? {
        text: badgeText,
        x: chip.x - 8 - badgeWidth,
        y: badgeY,
        width: badgeWidth,
        height: type.badgeHeight,
      }
    : null;

  // The centre: description (two lines), facts, typical, content lines.
  const contentX = leftColumn + card.padding;
  const textRight = leftColumn + card.centre - card.padding;
  const centreWidth = Math.max(24, textRight - contentX);
  let cursor = bandHeight + card.padding + type.content;
  let descriptionLines: string[] = [];
  let factsLine = "";
  let typicalLine: string | null = null;
  let lines: ProgressVisualLine[] = [];
  let descriptionY = 0;
  let factsY = 0;
  let typicalY = 0;
  let contentY = 0;
  let centreBottom = bandHeight;
  if (!collapsed) {
    const described = wrapProgressTextToWidth(description, centreWidth, type.content);
    descriptionLines =
      described.length > 2
        ? [
            described[0],
            ellipsizeProgressText(described.slice(1).join(" "), centreWidth, type.content),
          ]
        : described;
    descriptionY = cursor;
    cursor += descriptionLines.length * type.contentLine;
    if (descriptionLines.length) cursor += 2;
    factsLine = fitFactsLine(node, centreWidth, type.content);
    if (factsLine) {
      factsY = cursor;
      cursor += type.contentLine;
    }
    const typical = fitTypicalLine(options.stats, centreWidth, type.content);
    if (typical) {
      typicalLine = typical;
      typicalY = cursor;
      cursor += type.contentLine;
    }
    if (view === "cards") {
      // A summary that says what the description or the name already says is not repeated, as
      // the map's `runBlocks` drops it.
      const summary = node.content.summary?.trim();
      const content =
        summary && [description, node.label].some((text) => text.trim() === summary)
          ? { ...node.content, summary: null }
          : node.content;
      lines = contentLines(content, centreWidth, type);
      if (lines.length) {
        cursor += 4;
        contentY = cursor;
        cursor += lines.length * type.contentLine;
      }
    }
    centreBottom = cursor - type.content + card.padding;
  }
  const rows = Math.max(inputs.length, outputs.length);
  const portsBottom =
    bandHeight +
    card.padding +
    rows * card.pillStep -
    (rows ? card.pillStep - card.pill : 0) +
    card.padding;
  const bodyBottom = collapsed
    ? bandHeight
    : Math.max(centreBottom, portsBottom, bandHeight + 2 * card.padding + card.pill);
  const selfBandHeight = selfPorts.length ? card.pill + 2 * card.padding : 0;
  const selfBandY = selfPorts.length ? bodyBottom : null;
  const height = bodyBottom + selfBandHeight;

  // Ports: a column of pills centred vertically in the body, the handle on the border beside each.
  const column = (specs: PortSpec[], side: "in" | "out"): ProgressVisualPort[] => {
    const columnTop =
      bandHeight +
      Math.round(
        (bodyBottom - bandHeight - (specs.length * card.pillStep - (card.pillStep - card.pill))) /
          2,
      );
    const pillW = card.portColumn - 2 * card.padding;
    return specs.map((spec, i) => {
      const x = side === "in" ? card.padding : width - card.portColumn + card.padding;
      const y = columnTop + i * card.pillStep;
      return {
        ...spec,
        ...fitPort(spec, pillW - 2 * card.pillPadding, type),
        x,
        y,
        width: pillW,
        height: card.pill,
        handleX: side === "in" ? 0 : width,
        handleY: y + card.pill / 2,
      };
    });
  };
  const selfRow = (specs: PortSpec[]): ProgressVisualPort[] => {
    if (!specs.length) return [];
    const gap = 8;
    const pillW = Math.min(
      Math.floor((width - 2 * card.padding - gap * (specs.length - 1)) / specs.length),
      card.portColumn + 40,
    );
    const total = pillW * specs.length + gap * (specs.length - 1);
    const startX = Math.round((width - total) / 2);
    return specs.map((spec, i) => ({
      ...spec,
      ...fitPort(spec, pillW - 2 * card.pillPadding, type),
      x: startX + i * (pillW + gap),
      y: selfBandY! + card.padding,
      width: pillW,
      height: card.pill,
      // One double port for every self loop: the edge leaves the left dot (`handleX`) and
      // re-enters the right one, 18 px on.
      handleX: width / 2 - 9,
      handleY: height,
    }));
  };
  return {
    id: node.id,
    label: node.label,
    labelLines,
    index: index + 1,
    state: node.state,
    status: node.status,
    tone: progressCardTone(node.status),
    iterations: node.iterations,
    collapsed,
    row: 0,
    rank: 0,
    bandHeight,
    indexBadge,
    titleX,
    titleY,
    chip,
    statusLine,
    badge,
    contentX,
    textRight,
    descriptionLines,
    descriptionY,
    factsLine,
    factsY,
    typicalLine,
    typicalY,
    lines,
    contentY,
    inputs: column(inputs, "in"),
    outputs: column(outputs, "out"),
    selfPorts: selfRow(selfPorts),
    selfBandY,
    x: 0,
    y: 0,
    width,
    height,
    focusNodeId: node.focusNodeId,
  };
}

/** Move a measured card (everything relative to its corner) to `x`, `y`. */
function placeCard(
  card: ProgressVisualNode,
  x: number,
  y: number,
  row: number,
  rank: number,
): void {
  card.x = x;
  card.y = y;
  card.row = row;
  card.rank = rank;
  card.titleY += y;
  card.titleX += x;
  card.contentX += x;
  card.textRight += x;
  card.descriptionY += y;
  card.factsY += y;
  card.typicalY += y;
  card.contentY += y;
  if (card.selfBandY !== null) card.selfBandY += y;
  for (const box of [card.indexBadge, card.chip, card.badge]) {
    if (!box) continue;
    box.x += x;
    box.y += y;
  }
  for (const port of [...card.inputs, ...card.outputs, ...card.selfPorts]) {
    port.x += x;
    port.y += y;
    port.handleX += x;
    port.handleY += y;
  }
}

/** The blocks the shared layout reads, from the visible projection. */
export function progressLayoutBlocks(
  progress: ExecutionProgress,
  visible: ReturnType<typeof applyProgressVisibility>,
): LayoutBlock[] {
  const description = new Map(
    progress.process.blocks.map((block) => [block.id, block.description]),
  );
  return visible.nodes.map((node, index) => ({
    id: node.id,
    index,
    description: description.get(node.id) ?? "",
    transitions: (visible.transitions.get(node.id) ?? []).map((transition) => ({
      to: transition.to,
      label: transition.label,
      cycle: transition.cycle,
    })),
  }));
}

export async function buildExecutionProgressVisualModel(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
  statistics?: WorkflowVersionStatistics | null,
): Promise<ProgressVisualModel> {
  const normalized = normalizeProgressVisualOptions(options);
  const visible = applyProgressVisibility(progress, normalized.hide, normalized.collapse);
  const width = normalized.viewportWidth;
  const type = progressTypeScale(width);
  const phone = width <= PROGRESS_PHONE_MAX_WIDTH;
  const availableWidth = width - PADDING_X * 2;
  const taskTitle = progress.taskTitle || progress.title || "Execution progress";
  const taskTitleLines = wrapProgressTextToWidth(
    taskTitle,
    availableWidth,
    type.header.task,
    "bold",
  );
  const titleLines =
    progress.title && progress.title !== taskTitle
      ? wrapProgressTextToWidth(progress.title, availableWidth, type.header.title, "semibold")
      : [];
  const goalLines = progress.goal
    ? wrapProgressTextToWidth(progress.goal, availableWidth, type.header.goal)
    : [];
  let cursorY = HEADER_TOP + taskTitleLines.length * type.header.taskLine;
  if (titleLines.length) cursorY += 6 + titleLines.length * type.header.titleLine;
  if (goalLines.length) cursorY += 10 + goalLines.length * type.header.goalLine;

  const factColumns = Math.max(
    1,
    Math.floor((availableWidth + FACT_GAP) / (FACT_MIN_WIDTH + FACT_GAP)),
  );
  const factWidth = Math.floor(
    (availableWidth - FACT_GAP * Math.max(0, factColumns - 1)) / factColumns,
  );
  const factRows: number[] = [];
  const facts = progress.facts.map((fact, index): ProgressVisualFact => {
    const row = Math.floor(index / factColumns);
    const column = index % factColumns;
    const textWidth = Math.max(24, factWidth - FACT_PADDING_X * 2);
    const labelLines = wrapProgressTextToWidth(fact.label, textWidth, type.fact.label, "semibold");
    const valueLines = wrapProgressTextToWidth(fact.value, textWidth, type.fact.value, "semibold");
    const height = 24 + (labelLines.length + valueLines.length) * type.fact.line;
    factRows[row] = Math.max(factRows[row] ?? 0, height);
    return {
      ...fact,
      x: PADDING_X + column * (factWidth + FACT_GAP),
      y: 0,
      width: factWidth,
      height,
      labelLines,
      valueLines,
    };
  });
  if (facts.length) cursorY += 16;
  let factY = cursorY;
  for (let row = 0; row < factRows.length; row++) {
    facts.forEach((fact, index) => {
      if (Math.floor(index / factColumns) === row) fact.y = factY;
    });
    factY += factRows[row] + FACT_GAP;
  }
  const nodesTop = facts.length ? factY + 18 : cursorY + 24;

  // The cards, measured; then the shared layout with those sizes.
  const statsById = new Map((statistics?.blocks ?? []).map((entry) => [entry.blockId, entry]));
  const layoutInput = progressLayoutBlocks(progress, visible);
  const descriptionOf = new Map(layoutInput.map((block) => [block.id, block.description]));
  const cards = visible.nodes.map((node, index) =>
    measureCard(
      node,
      index,
      descriptionOf.get(node.id) ?? "",
      portSpecs(node.id, visible.nodes, visible.transitions, visible.hubs),
      {
        collapsed: visible.collapsed.has(node.id),
        view: normalized.view,
        waitingFor: progress.waitingFor,
        stats: statsById.get(node.id),
        type,
      },
    ),
  );
  const sizes = new Map(cards.map((card) => [card.id, { width: card.width, height: card.height }]));
  const hubIds = [...visible.hubs];
  const lay = (preset: LayoutBlocksOptions["preset"]) =>
    layoutBlocks(layoutInput, hubIds, { preset, sizes });
  // The rows preset when the image holds it at the type scale; the stacked preset otherwise,
  // and always on a phone.
  let preset: ProgressVisualDiagram["preset"] = "vertical";
  let layout: BlockLayout;
  if (phone) layout = await lay("vertical");
  else {
    const rows = await lay("default");
    if (rows.width <= availableWidth) {
      preset = "default";
      layout = rows;
    } else layout = await lay("vertical");
  }
  const scale = layout.width > availableWidth ? availableWidth / layout.width : 1;
  const diagram: ProgressVisualDiagram = {
    x: PADDING_X,
    y: nodesTop,
    width: layout.width,
    height: layout.height,
    scale,
    preset,
  };
  const laidById = new Map(layout.blocks.map((block) => [block.id, block]));
  for (const card of cards) {
    const laid = laidById.get(card.id)!;
    placeCard(card, laid.x, laid.y, laid.row, laid.rank);
  }
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const portOf = (card: ProgressVisualNode, key: string, side: "in" | "out") => {
    const ports =
      side === "in" ? [...card.inputs, ...card.selfPorts] : [...card.outputs, ...card.selfPorts];
    return ports.find((port) => port.id === key) ?? null;
  };
  const ports = new Map(
    cards.map((card) => [
      card.id,
      {
        outputs: [...card.outputs, ...card.selfPorts].map((port) => port.id),
        inputs: [...card.inputs, ...card.selfPorts].map((port) => port.id),
      },
    ]),
  );
  const ranks = portRanks(layout.edges, ports, new Map(layout.blocks.map((b) => [b.id, b.y])));
  const edges: ProgressVisualEdge[] = layout.edges.map((laid) => {
    const key = transitionKey(laid.from, laid.transition);
    const source = cardById.get(laid.from)!;
    const target = cardById.get(laid.to)!;
    const self = laid.from === laid.to;
    // A collapsed card has no ports: its edges meet the card at the middle of its borders.
    const out = portOf(source, key, "out");
    const into = portOf(target, key, "in");
    const sx = out ? out.handleX : source.x + source.width;
    const sy = out ? out.handleY : source.y + source.height / 2;
    const tx = into ? (self ? into.handleX + 18 : into.handleX) : target.x;
    const ty = into ? into.handleY : target.y + target.height / 2;
    // A self loop of a collapsed card still dips beneath the card, out of its bottom edge.
    const [fx, fy, gx, gy] =
      self && !out
        ? [
            source.x + source.width / 2 - 9,
            source.y + source.height,
            source.x + source.width / 2 + 9,
            source.y + source.height,
          ]
        : [sx, sy, tx, ty];
    const routed = portedPath(laid, fx, fy, gx, gy, Boolean(layout.transposed), {
      outRank: ranks.out.get(laid.id) ?? 0,
      inRank: ranks.in.get(laid.id) ?? 0,
    });
    const kind: ProgressEdgeKind = self ? "self" : laid.kind === "cycle" ? "return" : laid.kind;
    return {
      id: laid.id,
      source: laid.from,
      target: laid.to,
      kind,
      path: routed.path,
      label: laid.transition.label,
      cycle: laid.kind === "cycle",
    };
  });
  const stagesHeight = Math.round(layout.height * scale);
  const height = Math.max(nodesTop + 96, nodesTop + stagesHeight + PADDING_BOTTOM);
  return {
    taskTitle,
    taskTitleLines,
    title: progress.title,
    titleLines,
    goal: progress.goal,
    goalLines,
    facts,
    theme: normalized.theme,
    view: normalized.view,
    type,
    width,
    height,
    headerX: PADDING_X,
    headerY: HEADER_TOP,
    headerWidth: availableWidth,
    stagesTop: nodesTop,
    stagesHeight: height - nodesTop,
    diagram,
    layout,
    nodes: cards,
    edges,
  };
}
