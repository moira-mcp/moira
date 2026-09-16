import type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ProgressFactTone,
} from "./execution-progress-contract.js";
import type { ProcessProjection, ProcessTransition } from "./process-derivation.js";
import {
  ellipsizeProgressText,
  formatProgressDuration,
  progressTextWidth,
  wrapProgressTextToWidth,
} from "./execution-progress-text.js";
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

export type ProgressTheme = "light" | "dark";
/** `cards`: every block as a content card (the default). `process`: the aggregated block view —
 * compact blocks with the process's labelled transitions and loops, as the run page's canvas. */
export type ProgressView = "cards" | "process";
export interface ProgressVisualOptions {
  theme?: ProgressTheme;
  viewportWidth?: number;
  minWidth?: number;
  view?: ProgressView;
  /** Block ids (or authored node ids, resolved to their block) left out of the image. */
  hide?: string[];
  /** Block ids (or authored node ids) drawn as a label-only chip. */
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
/** The repeat-count badge beside a repeated block's state mark. */
export interface ProgressVisualBadge extends ProgressVisualBox {
  text: string;
}
export interface ProgressVisualNode {
  id: string;
  label: string;
  labelLines: string[];
  /** The state mark (✓ ◐ ● – ○) and where it is drawn; the title starts at `titleX`. */
  mark: string;
  markX: number;
  titleX: number;
  /** `×N` for a repeated block, placed beside the mark and clear of the title. */
  badge: ProgressVisualBadge | null;
  /** The status word under the title: who is on the block, or what became of it. */
  statusLine: string;
  /** Time spent and, for a bound block, `done/total: current item`; one line, ellipsised. */
  factsLine: string;
  lines: ProgressVisualLine[];
  /** Baselines of the first title line, the status line, the facts line and the first content line. */
  titleY: number;
  statusY: number;
  factsY: number;
  contentY: number;
  /** Content lines start at `contentX`; every text line of the block ends before `textRight`. */
  contentX: number;
  textRight: number;
  state: ExecutionProgressState;
  status: ExecutionBlockStatus;
  /** Completed passes; shown for repeated blocks. */
  iterations: number;
  /** Drawn as a label-only chip. */
  collapsed: boolean;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  focusNodeId: string | null;
}
export interface ProgressVisualEdge {
  source: string;
  target: string;
  direction: "forward" | "backward" | "cross-row";
  path: string;
  /** Transition label (process view only). */
  label: string | null;
  labelLines: string[];
  /** Anchor of the label text. */
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "middle" | "end";
  /** The label's box; null when the edge carries no gutter or connector label. */
  labelBox: ProgressVisualBox | null;
  /** A return to an earlier block (or to itself), drawn dashed with the transition label. */
  cycle: boolean;
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
  /** Header text (task, title, goal) starts at `headerX`, its first baseline at `headerY`, and stays narrower than `headerWidth`. */
  headerX: number;
  headerY: number;
  headerWidth: number;
  stagesTop: number;
  stagesHeight: number;
  nodes: ProgressVisualNode[];
  edges: ProgressVisualEdge[];
}

const CARD_WIDTH = 280;
const CARD_MIN_WIDTH = 240;
const CARD_GAP_X = 32;
const CARD_GAP_Y = 52;
const PADDING_X = 40;
const PADDING_BOTTOM = 32;
const HEADER_TOP = 28;
const CARD_PADDING_TOP = 12;
const CARD_PADDING_BOTTOM = 14;
const CONTENT_GAP = 8;
const FACT_GAP = 12;
const FACT_MIN_WIDTH = 180;
const FACT_PADDING_X = 12;
const LABEL_GAP = 4;
/** A viewport this wide or narrower is a phone: one column and the larger type. */
export const PROGRESS_PHONE_MAX_WIDTH = 720;

/** Font sizes (px) and the line heights they are set on; `header` and `fact` are the top of the image. */
export interface ProgressTypeScale {
  /** Block title. */
  title: number;
  titleLine: number;
  /** Block content, the status word and the facts line. */
  content: number;
  contentLine: number;
  /** Transition labels beside connectors and in the gutters. */
  label: number;
  labelLine: number;
  /** The `×n` badge and its box height. */
  badge: number;
  badgeHeight: number;
  /** The state mark (✓ ◐ ● – ○). */
  mark: number;
  header: {
    task: number;
    taskLine: number;
    title: number;
    titleLine: number;
    goal: number;
    goalLine: number;
  };
  fact: { label: number; value: number; line: number };
}

const DESKTOP_TYPE: ProgressTypeScale = {
  title: 14,
  titleLine: 20,
  content: 12,
  contentLine: 18,
  label: 11,
  labelLine: 14,
  badge: 11,
  badgeHeight: 16,
  mark: 18,
  header: { task: 20, taskLine: 26, title: 13, titleLine: 18, goal: 14, goalLine: 20 },
  fact: { label: 11, value: 13, line: 17 },
};

const PHONE_TYPE: ProgressTypeScale = {
  title: 18,
  titleLine: 24,
  content: 14,
  contentLine: 20,
  label: 12,
  labelLine: 16,
  badge: 12,
  badgeHeight: 18,
  mark: 22,
  header: { task: 24, taskLine: 30, title: 15, titleLine: 20, goal: 16, goalLine: 22 },
  fact: { label: 12, value: 15, line: 19 },
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
        const same = list.find((t) => t.to === visible.to && t.cycle === visible.cycle);
        if (same) {
          if (!same.label.includes(visible.label)) same.label = `${same.label}; ${visible.label}`;
        } else list.push(visible);
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

/**
 * The facts of a block on one line, from the fullest form to the one that must survive: the time
 * spent (`total`, plus the open pass while one runs) and, for a bound block, `done/total` with the
 * current item. Nothing measured reads `—`; an unknown done count reads `?`, as the notification
 * footer does. `progressFactsCandidates` lists the forms in order of preference — with the open
 * pass, without it, without the item's title, the count alone — so a narrow box drops the least
 * important part before anything is cut; `progressFactsText` is the fullest form.
 */
export function progressFactsCandidates(node: ExecutionProgressNode): string[] {
  const total = formatProgressDuration(node.timing.totalMs);
  const withPass =
    node.timing.currentMs !== null
      ? `${total} · this pass ${formatProgressDuration(node.timing.currentMs)}`
      : null;
  const list = node.list;
  if (!list || (list.done === null && list.total === null))
    return withPass ? [withPass, total] : [total];
  const count = `${list.done ?? "?"}/${list.total ?? "?"}`;
  const titled = list.currentTitle ? `${count}: ${list.currentTitle}` : count;
  const forms = [
    withPass ? `${withPass} · ${titled}` : null,
    `${total} · ${titled}`,
    `${total} · ${count}`,
    count,
  ].filter((form): form is string => form !== null);
  return [...new Set(forms)];
}

export function progressFactsText(node: ExecutionProgressNode): string {
  return progressFactsCandidates(node)[0];
}

/**
 * The facts line that fits the box: the fullest form that fits, else the titled form ellipsised
 * while the ellipsis still leaves the count intact (the item's title is what gets cut), else the
 * shorter forms, the last one ellipsised when even it does not fit.
 */
function fitFactsLine(node: ExecutionProgressNode, width: number, font: number): string {
  const candidates = progressFactsCandidates(node);
  const fits = (text: string) => progressTextWidth(text, font) <= width;
  const list = node.list;
  const count =
    list && (list.done !== null || list.total !== null)
      ? `${list.done ?? "?"}/${list.total ?? "?"}`
      : null;
  if (fits(candidates[0])) return candidates[0];
  // The fullest form does not fit: cut the item's title on the form without the open pass, as
  // long as the count stays intact — a cut title still names the item, a dropped one does not;
  // otherwise the shorter whole forms, then the count alone, cut if even that is too wide.
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

/** The mark for a block status; the repeat count is a badge of its own, not part of the mark. */
function progressStatusMark(status: ExecutionBlockStatus): string {
  return status === "repeated" || status === "done"
    ? "✓"
    : status === "waiting"
      ? "◐"
      : status === "active"
        ? "●"
        : status === "skipped"
          ? "–"
          : "○";
}

/**
 * A block's header row: the mark, the optional count badge beside it and the title after both,
 * wrapped to the width that remains. The badge's `y` is relative to the block top until the
 * block is placed.
 */
function blockHeader(
  status: ExecutionBlockStatus,
  iterations: number,
  label: string,
  x: number,
  width: number,
  type: ProgressTypeScale,
): Pick<ProgressVisualNode, "mark" | "markX" | "titleX" | "badge" | "labelLines" | "textRight"> {
  const mark = progressStatusMark(status);
  const markX = x + 14;
  let titleX = Math.max(x + 38, markX + progressTextWidth(mark, type.mark, "bold") + 8);
  let badge: ProgressVisualBadge | null = null;
  const titleY = CARD_PADDING_TOP + type.title;
  if (status === "repeated") {
    const text = `×${iterations}`;
    const badgeWidth = progressTextWidth(text, type.badge, "semibold") + 10;
    badge = {
      text,
      x: titleX - 2,
      y: titleY - type.badgeHeight + 4,
      width: badgeWidth,
      height: type.badgeHeight,
    };
    titleX = badge.x + badgeWidth + 8;
  }
  const textRight = x + width - 14;
  const labelLines = wrapProgressTextToWidth(
    label,
    Math.max(40, textRight - titleX),
    type.title,
    "bold",
  );
  return {
    mark,
    markX,
    titleX,
    badge,
    labelLines: labelLines.length ? labelLines : [label],
    textRight,
  };
}

/**
 * A block's body under its title: the status word, the facts line (ellipsised to the text
 * width) and the content lines, with every baseline relative to the block top and the height
 * the block needs. A collapsed block is its title alone.
 */
function blockBody(
  node: ExecutionProgressNode,
  waitingFor: ExecutionProgress["waitingFor"],
  header: Pick<ProgressVisualNode, "titleX" | "labelLines" | "textRight">,
  x: number,
  collapsed: boolean,
  lines: ProgressVisualLine[],
  type: ProgressTypeScale,
): Pick<
  ProgressVisualNode,
  "statusLine" | "factsLine" | "titleY" | "statusY" | "factsY" | "contentY" | "contentX" | "height"
> {
  const titleY = CARD_PADDING_TOP + type.title;
  const titleBottom = titleY + (header.labelLines.length - 1) * type.titleLine;
  const textWidth = Math.max(24, header.textRight - header.titleX);
  const statusLine = ellipsizeProgressText(
    progressStatusText(node.status, node.iterations, waitingFor),
    textWidth,
    type.content,
    "semibold",
  );
  const factsLine = fitFactsLine(node, textWidth, type.content);
  const statusY = titleBottom + type.contentLine + 2;
  const factsY = statusY + type.contentLine;
  const contentY = factsY + type.contentLine + CONTENT_GAP;
  const lastBaseline = collapsed
    ? titleBottom
    : lines.length
      ? contentY + (lines.length - 1) * type.contentLine
      : factsY;
  return {
    statusLine,
    factsLine,
    titleY,
    statusY,
    factsY,
    contentY,
    contentX: x + 18,
    height: lastBaseline + CARD_PADDING_BOTTOM,
  };
}

/** Move a block whose baselines and badge are relative to its top to the absolute `y`. */
function placeBlock(node: ProgressVisualNode, y: number): void {
  node.y = y;
  node.titleY += y;
  node.statusY += y;
  node.factsY += y;
  node.contentY += y;
  if (node.badge) node.badge.y += y;
}

export function buildExecutionProgressVisualModel(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
): ProgressVisualModel {
  const normalized = normalizeProgressVisualOptions(options);
  const processView = normalized.view === "process";
  const visible = applyProgressVisibility(progress, normalized.hide, normalized.collapse);
  const shownNodes = visible.nodes;
  const width = normalized.viewportWidth;
  const type = progressTypeScale(width);
  const phone = width <= PROGRESS_PHONE_MAX_WIDTH;
  const availableWidth = width - PADDING_X * 2;
  // A phone reads one column of full-width cards; wider viewports keep the card grid.
  const columns = phone
    ? 1
    : Math.max(1, Math.floor((availableWidth + CARD_GAP_X) / (CARD_MIN_WIDTH + CARD_GAP_X)));
  const cardWidth = phone
    ? availableWidth
    : Math.min(
        CARD_WIDTH,
        Math.floor((availableWidth - CARD_GAP_X * Math.max(0, columns - 1)) / columns),
      );
  const actualColumns = Math.max(
    1,
    Math.floor((availableWidth + CARD_GAP_X) / (cardWidth + CARD_GAP_X)),
  );
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
  if (processView) {
    return layoutProcessColumn(progress, normalized, visible, {
      width,
      type,
      taskTitle,
      taskTitleLines,
      titleLines,
      goalLines,
      facts,
      nodesTop,
    });
  }
  const nodes = shownNodes.map((node, index): ProgressVisualNode => {
    const x = PADDING_X + (index % actualColumns) * (cardWidth + CARD_GAP_X);
    const header = blockHeader(node.status, node.iterations, node.label, x, cardWidth, type);
    const collapsed = visible.collapsed.has(node.id);
    const lines = collapsed ? [] : contentLines(node.content, header.textRight - (x + 18), type);
    const body = blockBody(node, progress.waitingFor, header, x, collapsed, lines, type);
    return {
      id: node.id,
      label: node.label,
      ...header,
      ...body,
      lines,
      state: node.state,
      status: node.status,
      iterations: node.iterations,
      collapsed,
      row: Math.floor(index / actualColumns),
      x,
      y: 0,
      width: cardWidth,
      focusNodeId: node.focusNodeId,
    };
  });
  const rowHeights: number[] = [];
  const rowTops: number[] = [];
  nodes.forEach((node) => {
    rowHeights[node.row] = Math.max(rowHeights[node.row] ?? 0, node.height);
  });
  let rowY = nodesTop;
  for (let row = 0; row < rowHeights.length; row++) {
    rowTops[row] = rowY;
    nodes.forEach((node) => {
      if (node.row === row) placeBlock(node, rowY);
    });
    rowY += rowHeights[row] + CARD_GAP_Y;
  }

  const byId = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const edges: ProgressVisualEdge[] = [];
  // Cards view: the display chain, unlabelled.
  for (const source of shownNodes) {
    const sourceEntry = byId.get(source.id);
    const targetEntry = source.connections.default
      ? byId.get(source.connections.default)
      : undefined;
    if (!sourceEntry || !targetEntry) continue;
    const sameRow = sourceEntry.node.row === targetEntry.node.row;
    const forward = targetEntry.index > sourceEntry.index;
    let direction: ProgressVisualEdge["direction"];
    let path: string;
    if (!sameRow) {
      direction = "cross-row";
      const startX = sourceEntry.node.x + sourceEntry.node.width / 2;
      const endX = targetEntry.node.x + targetEntry.node.width / 2;
      const movingDown = targetEntry.node.row > sourceEntry.node.row;
      const startY = movingDown ? sourceEntry.node.y + sourceEntry.node.height : sourceEntry.node.y;
      const sourceBoundary = movingDown
        ? rowTops[sourceEntry.node.row] + rowHeights[sourceEntry.node.row]
        : rowTops[sourceEntry.node.row];
      const targetBoundary = movingDown
        ? rowTops[targetEntry.node.row]
        : rowTops[targetEntry.node.row] + rowHeights[targetEntry.node.row];
      const corridorX = PADDING_X / 2;
      path = `M ${startX} ${startY} L ${startX} ${sourceBoundary} L ${corridorX} ${sourceBoundary} L ${corridorX} ${targetBoundary} L ${endX} ${targetBoundary}`;
    } else if (forward) {
      direction = "forward";
      const y = sourceEntry.node.y + Math.min(sourceEntry.node.height, targetEntry.node.height) / 2;
      path = `M ${sourceEntry.node.x + sourceEntry.node.width} ${y} L ${targetEntry.node.x} ${y}`;
    } else {
      direction = "backward";
      const startX = sourceEntry.node.x + sourceEntry.node.width / 2;
      const endX = targetEntry.node.x + targetEntry.node.width / 2;
      const edgeY =
        sourceEntry.node.y + Math.max(sourceEntry.node.height, targetEntry.node.height) + 24;
      path = `M ${startX} ${sourceEntry.node.y + sourceEntry.node.height} C ${startX} ${edgeY}, ${endX} ${edgeY}, ${endX} ${targetEntry.node.y + targetEntry.node.height}`;
    }
    edges.push({
      source: source.id,
      target: targetEntry.node.id,
      direction,
      path,
      label: null,
      labelLines: [],
      labelX: 0,
      labelY: 0,
      labelAnchor: "middle",
      labelBox: null,
      cycle: false,
    });
  }
  const height = Math.max(nodesTop + 96, rowY - CARD_GAP_Y + PADDING_BOTTOM);
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
    nodes,
    edges,
  };
}

const COLUMN_MAX_WIDTH = 440;
const COLUMN_MIN_WIDTH = 220;
const COLUMN_GAP_Y = 44;
const LANE_STEP = 26;
const LANE_BASE = 22;

interface ProcessArc {
  source: string;
  target: string;
  label: string;
  cycle: boolean;
  from: number;
  to: number;
  lane: number;
  /** A forward transition into a hub: drawn on the hub's bundled lane, labelled inside its source. */
  hub: boolean;
}

/** Lanes by span: an arc nested inside another takes the lane inside it; returns the lane count. */
function assignLanes(side: ProcessArc[]): number {
  const sorted = [...side].sort(
    (a, b) => Math.abs(a.to - a.from) - Math.abs(b.to - b.from) || a.from - b.from,
  );
  const placed: ProcessArc[] = [];
  for (const arc of sorted) {
    const lo = Math.min(arc.from, arc.to);
    const hi = Math.max(arc.from, arc.to);
    let lane = 0;
    for (;;) {
      const clash = placed.some((other) => {
        const olo = Math.min(other.from, other.to);
        const ohi = Math.max(other.from, other.to);
        return other.lane === lane && olo < hi && ohi > lo;
      });
      if (!clash) break;
      lane += 1;
    }
    arc.lane = lane;
    placed.push(arc);
  }
  return placed.length ? Math.max(...placed.map((arc) => arc.lane)) + 1 : 0;
}

/**
 * The aggregated block view: one column of compact blocks in process order. Adjacent forward
 * transitions are short connectors with their label beside them; forward skips are arcs in the
 * right gutter and returns dashed arcs in the left gutter, each on a lane by its span so arcs nest
 * instead of crossing, labelled at their midpoint. Forward transitions into a hub block share one
 * bundled lane per hub in the right gutter and enter the hub at a single port; their labels are
 * written inside the source block rather than beside the bundle, so the connection is visible
 * without the gutter labels of several sources piling up. It is the run page's lanes picture turned
 * vertical, which any viewport width can hold.
 */
function layoutProcessColumn(
  progress: ExecutionProgress,
  normalized: Required<ProgressVisualOptions>,
  visible: ReturnType<typeof applyProgressVisibility>,
  header: {
    width: number;
    type: ProgressTypeScale;
    taskTitle: string;
    taskTitleLines: string[];
    titleLines: string[];
    goalLines: string[];
    facts: ProgressVisualFact[];
    nodesTop: number;
  },
): ProgressVisualModel {
  const { width, nodesTop, type } = header;
  const labelFont = type.label;
  const labelLine = type.labelLine;
  const blockLabel = new Map(visible.nodes.map((node) => [node.id, node.label]));
  const index = new Map(visible.nodes.map((node, i) => [node.id, i]));

  const arcs: ProcessArc[] = [];
  const inline = new Map<string, string[]>();
  for (const node of visible.nodes) {
    for (const transition of visible.transitions.get(node.id) ?? []) {
      const to = index.get(transition.to);
      const from = index.get(node.id);
      if (to === undefined || from === undefined) continue;
      const hub = !transition.cycle && visible.hubs.has(transition.to) && to > from + 1;
      if (hub) {
        inline.set(node.id, [
          ...(inline.get(node.id) ?? []),
          `${transition.label} → ${blockLabel.get(transition.to) ?? transition.to}`,
        ]);
      }
      arcs.push({
        source: node.id,
        target: transition.to,
        label: transition.label,
        cycle: transition.cycle || to <= from,
        from,
        to,
        lane: 0,
        hub,
      });
    }
  }
  // Every forward skip takes a right-gutter lane by its span; the skips into one hub are laid out
  // as a single bundle spanning from the earliest source to the hub, and each takes the bundle's lane.
  const skips = arcs.filter((arc) => !arc.cycle && arc.to !== arc.from + 1);
  const bundles = new Map<string, ProcessArc>();
  for (const arc of skips.filter((arc) => arc.hub)) {
    const bundle = bundles.get(arc.target);
    if (bundle) bundle.from = Math.min(bundle.from, arc.from);
    else bundles.set(arc.target, { ...arc });
  }
  const rightLanes = assignLanes([...skips.filter((arc) => !arc.hub), ...bundles.values()]);
  for (const arc of skips) if (arc.hub) arc.lane = bundles.get(arc.target)!.lane;
  const leftLanes = assignLanes(arcs.filter((arc) => arc.cycle));

  // Gutter labels: every arc that is neither an adjacent connector nor a hub bundle. Each side's
  // gutter holds its lanes plus a label area sized by the widest label (bounded), and the column
  // keeps its minimum width by shrinking the label areas rather than overflowing the viewport;
  // labels wrap to whatever the area leaves them.
  const labelWidthOf = (label: string) => progressTextWidth(label, labelFont, "semibold");
  const gutterArcs = arcs.filter((arc) => !arc.hub && (arc.cycle || arc.to !== arc.from + 1));
  const leftArcs = gutterArcs.filter((arc) => arc.cycle);
  const rightArcs = gutterArcs.filter((arc) => !arc.cycle);
  const lanesPart = (lanes: number) => (lanes ? LANE_BASE + lanes * LANE_STEP : 0);
  // A side's label area never drops below its widest word, so labels wrap between words and
  // never split one.
  const widestWordOf = (side: ProcessArc[]) =>
    Math.max(0, ...side.flatMap((a) => a.label.split(/\s+/u).map(labelWidthOf)));
  const labelSpaceOf = (side: ProcessArc[]) =>
    side.length
      ? Math.min(240, Math.max(120, Math.max(...side.map((a) => labelWidthOf(a.label))) + 8))
      : 0;
  const leftFloor = leftArcs.length ? Math.max(72, widestWordOf(leftArcs) + 8) : 0;
  const rightFloor = rightArcs.length ? Math.max(72, widestWordOf(rightArcs) + 8) : 0;
  let leftLabelSpace = Math.max(labelSpaceOf(leftArcs), leftFloor);
  let rightLabelSpace = Math.max(labelSpaceOf(rightArcs), rightFloor);
  const gutterOf = (lanes: number, labelSpace: number) =>
    Math.max(PADDING_X, lanesPart(lanes) + labelSpace + (labelSpace ? 12 : 0));
  const overBudget = () =>
    gutterOf(leftLanes, leftLabelSpace) + gutterOf(rightLanes, rightLabelSpace) + COLUMN_MIN_WIDTH >
    width;
  if (overBudget()) {
    const cut = Math.ceil(
      (gutterOf(leftLanes, leftLabelSpace) +
        gutterOf(rightLanes, rightLabelSpace) +
        COLUMN_MIN_WIDTH -
        width) /
        2,
    );
    if (leftLabelSpace) leftLabelSpace = Math.max(leftFloor, leftLabelSpace - cut);
    if (rightLabelSpace) rightLabelSpace = Math.max(rightFloor, rightLabelSpace - cut);
  }
  // When the viewport cannot hold the lanes, the column and both label areas, a side's labels
  // move inside their source blocks (as the hub labels always are): first the forward skips on
  // the right, then the returns on the left. The arcs stay drawn; nothing is truncated.
  let rightInline = false;
  let leftInline = false;
  if (overBudget() && rightLabelSpace) {
    rightInline = true;
    rightLabelSpace = 0;
  }
  if (overBudget() && leftLabelSpace) {
    leftInline = true;
    leftLabelSpace = 0;
  }
  for (const arc of gutterArcs) {
    const inlined = arc.cycle ? leftInline : rightInline;
    if (!inlined) continue;
    inline.set(arc.source, [
      ...(inline.get(arc.source) ?? []),
      `${arc.cycle ? "↩ " : ""}${arc.label} → ${blockLabel.get(arc.target) ?? arc.target}`,
    ]);
  }
  const leftGutter = gutterOf(leftLanes, leftLabelSpace);
  const rightGutter = gutterOf(rightLanes, rightLabelSpace);
  const columnWidth = Math.max(
    COLUMN_MIN_WIDTH,
    Math.min(COLUMN_MAX_WIDTH, width - leftGutter - rightGutter),
  );
  const columnX =
    leftGutter + Math.max(0, Math.floor((width - leftGutter - rightGutter - columnWidth) / 2));
  // Gutter labels sit beyond the outermost lane of their side, never across a lane line.
  const leftOuter = columnX - LANE_BASE - Math.max(0, leftLanes - 1) * LANE_STEP;
  const rightOuter = columnX + columnWidth + LANE_BASE + Math.max(0, rightLanes - 1) * LANE_STEP;
  const leftArea = { x0: PADDING_X / 2, x1: leftOuter - 8 };
  const rightArea = { x0: rightOuter + 8, x1: width - PADDING_X / 2 };
  const areaWidth = (area: { x0: number; x1: number }) => Math.max(48, area.x1 - area.x0);

  // Adjacent connectors carry their label beside the line, inside the gap between the two
  // blocks; a label that needs more lines than the gap holds widens that gap.
  const connectorLabelWidth = Math.max(60, Math.floor(columnWidth / 2) - 14);
  const gapAfter = new Map<string, number>();
  const connectorLines = new Map<string, string[]>();
  for (const arc of arcs) {
    if (arc.cycle || arc.hub || arc.to !== arc.from + 1) continue;
    const lines = wrapProgressTextToWidth(
      arc.label,
      Math.max(connectorLabelWidth, widestWordOf([arc])),
      labelFont,
      "semibold",
    );
    connectorLines.set(`${arc.source}>${arc.target}`, lines);
    const needed = lines.length * labelLine + 16;
    gapAfter.set(arc.source, Math.max(gapAfter.get(arc.source) ?? COLUMN_GAP_Y, needed));
  }

  let y = nodesTop;
  const nodes: ProgressVisualNode[] = visible.nodes.map((node, i): ProgressVisualNode => {
    const collapsed = visible.collapsed.has(node.id);
    const header = blockHeader(
      node.status,
      node.iterations,
      node.label,
      columnX,
      columnWidth,
      type,
    );
    const inlineWidth = header.textRight - (columnX + 18);
    const lines: ProgressVisualLine[] = collapsed
      ? []
      : (inline.get(node.id) ?? []).flatMap((text) =>
          wrapContentLines(text, "next", inlineWidth, type),
        );
    const body = blockBody(node, progress.waitingFor, header, columnX, collapsed, lines, type);
    const placed: ProgressVisualNode = {
      id: node.id,
      label: node.label,
      ...header,
      ...body,
      lines,
      state: node.state,
      status: node.status,
      iterations: node.iterations,
      collapsed,
      row: i,
      x: columnX,
      y: 0,
      width: columnWidth,
      focusNodeId: node.focusNodeId,
    };
    placeBlock(placed, y);
    y += placed.height + (gapAfter.get(node.id) ?? COLUMN_GAP_Y);
    return placed;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: ProgressVisualEdge[] = [];
  // Gutter labels are placed after every arc is known: each starts centred on its arc's start
  // and may slide along the arc's vertical run; the labels of one side are then stacked in
  // vertical order so no two overlap, whichever block their arcs leave.
  interface PendingLabel {
    edge: ProgressVisualEdge;
    right: boolean;
    top: number;
    lo: number;
    hi: number;
    width: number;
    height: number;
    order: number;
  }
  const pending: PendingLabel[] = [];
  for (const arc of arcs) {
    const source = byId.get(arc.source)!;
    const target = byId.get(arc.target)!;
    const adjacent = !arc.cycle && arc.to === arc.from + 1;
    if (adjacent) {
      const lines = connectorLines.get(`${arc.source}>${arc.target}`) ?? [];
      const x = source.x + source.width / 2;
      const y1 = source.y + source.height;
      const y2 = target.y;
      const boxHeight = lines.length * labelLine;
      const top = y1 + Math.max(2, (y2 - y1 - boxHeight) / 2);
      const boxWidth = Math.max(0, ...lines.map(labelWidthOf));
      edges.push({
        source: arc.source,
        target: arc.target,
        direction: "forward",
        path: `M ${x} ${y1} L ${x} ${y2}`,
        label: arc.label,
        labelLines: lines,
        labelX: x + 10,
        labelY: top + labelFont,
        labelAnchor: "start",
        labelBox: lines.length ? { x: x + 10, y: top, width: boxWidth, height: boxHeight } : null,
        cycle: false,
      });
      continue;
    }
    const right = !arc.cycle;
    const laneX = right
      ? columnX + columnWidth + LANE_BASE + arc.lane * LANE_STEP
      : columnX - LANE_BASE - arc.lane * LANE_STEP;
    // A self-return leaves the block's upper half and re-enters its lower half, so the loop is
    // a visible bracket rather than a flat stub.
    const self = arc.source === arc.target;
    const startY = self ? source.y + source.height / 3 : source.y + source.height / 2;
    const endY = self ? target.y + (target.height * 2) / 3 : target.y + target.height / 2;
    const startX = right ? source.x + source.width : source.x;
    const endX = right ? target.x + target.width : target.x;
    const area = right ? rightArea : leftArea;
    // A hub connector carries its label inside the source block (the "next" line), not in the
    // gutter; so does every arc of a side whose labels moved inline.
    const inlined = arc.hub || (right ? rightInline : leftInline);
    const lines = inlined
      ? []
      : wrapProgressTextToWidth(arc.label, areaWidth(area), labelFont, "semibold");
    const edge: ProgressVisualEdge = {
      source: arc.source,
      target: arc.target,
      direction: right ? "forward" : "backward",
      path: `M ${startX} ${startY} L ${laneX} ${startY} L ${laneX} ${endY} L ${endX} ${endY}`,
      label: arc.label,
      labelLines: lines,
      labelX: right ? area.x0 : area.x1,
      labelY: startY,
      labelAnchor: right ? "start" : "end",
      labelBox: null,
      cycle: arc.cycle,
    };
    edges.push(edge);
    if (!lines.length) continue;
    const boxHeight = lines.length * labelLine + 2;
    const lo = Math.min(startY, endY);
    const hi = Math.max(startY, endY) - boxHeight;
    const centred = startY - boxHeight / 2;
    pending.push({
      edge,
      right,
      top: hi >= lo ? Math.min(Math.max(centred, lo), hi) : centred,
      lo,
      hi,
      width: Math.max(0, ...lines.map(labelWidthOf)),
      height: boxHeight,
      order: arc.from,
    });
  }
  for (const side of [false, true]) {
    const labels = pending
      .filter((label) => label.right === side)
      .sort((a, b) => a.top - b.top || a.order - b.order);
    let floor = -Infinity;
    for (const label of labels) {
      const top = Math.max(label.top, floor);
      const area = side ? rightArea : leftArea;
      label.edge.labelBox = {
        x: side ? area.x0 : area.x1 - label.width,
        y: top,
        width: label.width,
        height: label.height,
      };
      label.edge.labelY = top + labelFont;
      floor = top + label.height + LABEL_GAP;
    }
  }
  const lowestLabel = Math.max(
    0,
    ...edges.map((edge) => (edge.labelBox ? edge.labelBox.y + edge.labelBox.height : 0)),
  );
  const height = Math.max(
    nodesTop + 96,
    y - COLUMN_GAP_Y + PADDING_BOTTOM,
    lowestLabel + PADDING_BOTTOM,
  );
  return {
    taskTitle: header.taskTitle,
    taskTitleLines: header.taskTitleLines,
    title: progress.title,
    titleLines: header.titleLines,
    goal: progress.goal,
    goalLines: header.goalLines,
    facts: header.facts,
    theme: normalized.theme,
    view: "process",
    type,
    width,
    height,
    headerX: PADDING_X,
    headerY: HEADER_TOP,
    headerWidth: width - PADDING_X * 2,
    stagesTop: nodesTop,
    stagesHeight: height - nodesTop,
    nodes,
    edges,
  };
}
