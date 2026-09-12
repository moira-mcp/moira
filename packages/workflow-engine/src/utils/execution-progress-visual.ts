import type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ProgressFactTone,
} from "./execution-progress-contract.js";
import type { ProcessProjection, ProcessTransition } from "./process-derivation.js";
export type {
  ExecutionBlockStatus,
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressNode,
  ExecutionProgressState,
  ExecutionRouteEntry,
  ExecutionVariableChange,
  ExecutionVariableState,
} from "./execution-progress-contract.js";

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
  marker: boolean;
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
export interface ProgressVisualNode {
  id: string;
  label: string;
  labelLines: string[];
  lines: ProgressVisualLine[];
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
  width: number;
  height: number;
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
const TEXT_LINE_HEIGHT = 18;
const LABEL_LINE_HEIGHT = 20;
const CARD_PADDING_Y = 18;
const CARD_FIXED_HEIGHT = 42;
const FACT_GAP = 12;
const FACT_MIN_WIDTH = 180;
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

export function wrapProgressText(value: string, maxCharacters: number): string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) lines.push(current);
    current = "";
  };
  for (const word of normalized.split(" ")) {
    const codePoints = [...word];
    if (codePoints.length > maxCharacters) {
      flush();
      for (let index = 0; index < codePoints.length; index += maxCharacters)
        lines.push(codePoints.slice(index, index + maxCharacters).join(""));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length <= maxCharacters) current = candidate;
    else {
      flush();
      current = word;
    }
  }
  flush();
  return lines;
}

function contentLines(
  content: ExecutionProgressContent,
  maxCharacters: number,
): ProgressVisualLine[] {
  const lines: ProgressVisualLine[] = [];
  const append = (value: string | null, kind: ProgressVisualLineKind) => {
    if (value)
      wrapProgressText(value, maxCharacters).forEach((text, index) =>
        lines.push({ text, kind, marker: index === 0 }),
      );
  };
  append(content.summary, "summary");
  content.details.forEach((detail) => append(detail, "detail"));
  append(content.outcome, "outcome");
  append(content.next, "next");
  return lines;
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
  const availableWidth = width - PADDING_X * 2;
  const columns = Math.max(
    1,
    Math.floor((availableWidth + CARD_GAP_X) / (CARD_MIN_WIDTH + CARD_GAP_X)),
  );
  const cardWidth = Math.min(
    CARD_WIDTH,
    Math.floor((availableWidth - CARD_GAP_X * Math.max(0, columns - 1)) / columns),
  );
  const actualColumns = Math.max(
    1,
    Math.floor((availableWidth + CARD_GAP_X) / (cardWidth + CARD_GAP_X)),
  );
  const taskCharacters = Math.max(16, Math.floor(availableWidth / 13));
  const titleCharacters = Math.max(20, Math.floor(availableWidth / 9));
  const goalCharacters = Math.max(20, Math.floor(availableWidth / 9));
  const taskTitle = progress.taskTitle || progress.title || "Execution progress";
  const taskTitleLines = wrapProgressText(taskTitle, taskCharacters);
  const titleLines =
    progress.title && progress.title !== taskTitle
      ? wrapProgressText(progress.title, titleCharacters)
      : [];
  const goalLines = progress.goal ? wrapProgressText(progress.goal, goalCharacters) : [];
  let cursorY = HEADER_TOP + taskTitleLines.length * 26;
  if (titleLines.length) cursorY += 6 + titleLines.length * 18;
  if (goalLines.length) cursorY += 10 + goalLines.length * 20;

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
    const maxCharacters = Math.max(12, Math.floor((factWidth - 24) / 8.2));
    const labelLines = wrapProgressText(fact.label, maxCharacters);
    const valueLines = wrapProgressText(fact.value, maxCharacters);
    const height = 24 + (labelLines.length + valueLines.length) * 17;
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
      taskTitle,
      taskTitleLines,
      titleLines,
      goalLines,
      facts,
      nodesTop,
    });
  }
  const maxCardCharacters = Math.max(16, Math.floor((cardWidth - 34) / 8.2));
  const nodes = shownNodes.map((node, index): ProgressVisualNode => {
    const labelLines = wrapProgressText(node.label, maxCardCharacters);
    const collapsed = visible.collapsed.has(node.id);
    const lines = collapsed ? [] : contentLines(node.content, maxCardCharacters);
    return {
      id: node.id,
      label: node.label,
      labelLines,
      lines,
      state: node.state,
      status: node.status,
      iterations: node.iterations,
      collapsed,
      row: Math.floor(index / actualColumns),
      x: PADDING_X + (index % actualColumns) * (cardWidth + CARD_GAP_X),
      y: 0,
      width: cardWidth,
      height: collapsed
        ? CARD_PADDING_Y +
          CARD_FIXED_HEIGHT +
          Math.max(0, labelLines.length - 1) * LABEL_LINE_HEIGHT
        : CARD_PADDING_Y * 2 +
          CARD_FIXED_HEIGHT +
          labelLines.length * LABEL_LINE_HEIGHT +
          lines.length * TEXT_LINE_HEIGHT,
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
      if (node.row === row) node.y = rowY;
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
    width,
    height,
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
 * instead of crossing, labelled at their midpoint; transitions into hub blocks are written inside
 * the source block instead of drawn. It is the run page's lanes picture turned vertical, which any
 * viewport width can hold.
 */
function layoutProcessColumn(
  progress: ExecutionProgress,
  normalized: Required<ProgressVisualOptions>,
  visible: ReturnType<typeof applyProgressVisibility>,
  header: {
    width: number;
    taskTitle: string;
    taskTitleLines: string[];
    titleLines: string[];
    goalLines: string[];
    facts: ProgressVisualFact[];
    nodesTop: number;
  },
): ProgressVisualModel {
  const { width, nodesTop } = header;
  const blockLabel = new Map(visible.nodes.map((node) => [node.id, node.label]));
  const index = new Map(visible.nodes.map((node, i) => [node.id, i]));

  const arcs: ProcessArc[] = [];
  const inline = new Map<string, string[]>();
  for (const node of visible.nodes) {
    for (const transition of visible.transitions.get(node.id) ?? []) {
      const to = index.get(transition.to);
      const from = index.get(node.id);
      if (to === undefined || from === undefined) continue;
      if (!transition.cycle && visible.hubs.has(transition.to) && to !== from + 1) {
        inline.set(node.id, [
          ...(inline.get(node.id) ?? []),
          `${transition.label} → ${blockLabel.get(transition.to) ?? transition.to}`,
        ]);
        continue;
      }
      arcs.push({
        source: node.id,
        target: transition.to,
        label: transition.label,
        cycle: transition.cycle || to <= from,
        from,
        to,
        lane: 0,
      });
    }
  }
  const rightLanes = assignLanes(arcs.filter((arc) => !arc.cycle && arc.to !== arc.from + 1));
  const leftLanes = assignLanes(arcs.filter((arc) => arc.cycle));

  const gutterFor = (lanes: number) => (lanes ? LANE_BASE + lanes * LANE_STEP + 150 : 24);
  const leftGutter = Math.max(PADDING_X, gutterFor(leftLanes));
  const rightGutter = Math.max(PADDING_X, gutterFor(rightLanes));
  const columnWidth = Math.max(
    COLUMN_MIN_WIDTH,
    Math.min(COLUMN_MAX_WIDTH, width - leftGutter - rightGutter),
  );
  const columnX = Math.max(PADDING_X, Math.floor((width - columnWidth) / 2));
  const labelCharacters = Math.max(16, Math.floor((columnWidth - 60) / 8.2));
  // Gutter labels sit beyond the outermost lane of their side, never across a lane line.
  const leftOuter = columnX - LANE_BASE - Math.max(0, leftLanes - 1) * LANE_STEP;
  const rightOuter = columnX + columnWidth + LANE_BASE + Math.max(0, rightLanes - 1) * LANE_STEP;
  const gutterCharacters = Math.max(
    12,
    Math.floor((Math.min(leftOuter, width - rightOuter) - 24) / 6.4),
  );

  let y = nodesTop;
  const nodes: ProgressVisualNode[] = visible.nodes.map((node, i): ProgressVisualNode => {
    const collapsed = visible.collapsed.has(node.id);
    const labelLines = wrapProgressText(node.label, labelCharacters);
    const lines: ProgressVisualLine[] = collapsed
      ? []
      : (inline.get(node.id) ?? []).flatMap((text) =>
          wrapProgressText(text, labelCharacters).map((line, lineIndex): ProgressVisualLine => ({
            text: line,
            kind: "next",
            marker: lineIndex === 0,
          })),
        );
    const height =
      CARD_PADDING_Y +
      CARD_FIXED_HEIGHT +
      Math.max(0, labelLines.length - 1) * LABEL_LINE_HEIGHT +
      lines.length * TEXT_LINE_HEIGHT;
    const placed: ProgressVisualNode = {
      id: node.id,
      label: node.label,
      labelLines,
      lines,
      state: node.state,
      status: node.status,
      iterations: node.iterations,
      collapsed,
      row: i,
      x: columnX,
      y,
      width: columnWidth,
      height,
      focusNodeId: node.focusNodeId,
    };
    y += height + COLUMN_GAP_Y;
    return placed;
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: ProgressVisualEdge[] = [];
  // Arc labels sit at the arc's source end, stacked when several arcs leave one block on one side.
  const leaving = new Map<string, number>();
  for (const arc of arcs) {
    const source = byId.get(arc.source)!;
    const target = byId.get(arc.target)!;
    const adjacent = !arc.cycle && arc.to === arc.from + 1;
    const labelLines = wrapProgressText(
      arc.label,
      adjacent ? labelCharacters : gutterCharacters,
    ).slice(0, 2);
    if (adjacent) {
      const x = source.x + source.width / 2;
      const y1 = source.y + source.height;
      const y2 = target.y;
      edges.push({
        source: arc.source,
        target: arc.target,
        direction: "forward",
        path: `M ${x} ${y1} L ${x} ${y2}`,
        label: arc.label,
        labelLines,
        labelX: x + 10,
        labelY: y1 + (y2 - y1) / 2 + 4 - (labelLines.length - 1) * 7,
        labelAnchor: "start",
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
    const sideKey = `${arc.source}:${right ? "r" : "l"}`;
    const stack = leaving.get(sideKey) ?? 0;
    leaving.set(sideKey, stack + 1);
    edges.push({
      source: arc.source,
      target: arc.target,
      direction: right ? "forward" : "backward",
      path: `M ${startX} ${startY} L ${laneX} ${startY} L ${laneX} ${endY} L ${endX} ${endY}`,
      label: arc.label,
      labelLines,
      labelX: right ? rightOuter + 8 : leftOuter - 8,
      labelY: startY - 6 - stack * (labelLines.length * 14 + 4),
      labelAnchor: right ? "start" : "end",
      cycle: arc.cycle,
    });
  }
  const height = Math.max(nodesTop + 96, y - COLUMN_GAP_Y + PADDING_BOTTOM);
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
    width,
    height,
    stagesTop: nodesTop,
    stagesHeight: height - nodesTop,
    nodes,
    edges,
  };
}
