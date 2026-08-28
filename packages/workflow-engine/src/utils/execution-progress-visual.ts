import type {
  ExecutionProgress,
  ExecutionProgressContent,
  ExecutionProgressState,
  ProgressFactTone,
} from "./execution-progress-contract.js";
export type {
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";

export type ProgressTheme = "light" | "dark";
export interface ProgressVisualOptions {
  theme?: ProgressTheme;
  viewportWidth?: number;
  minWidth?: number;
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
  };
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
  const maxCardCharacters = Math.max(16, Math.floor((cardWidth - 34) / 8.2));
  const nodes = progress.nodes.map((node, index): ProgressVisualNode => {
    const labelLines = wrapProgressText(node.label, maxCardCharacters);
    const lines = contentLines(node.content, maxCardCharacters);
    return {
      id: node.id,
      label: node.label,
      labelLines,
      lines,
      state: node.state,
      row: Math.floor(index / actualColumns),
      x: PADDING_X + (index % actualColumns) * (cardWidth + CARD_GAP_X),
      y: 0,
      width: cardWidth,
      height:
        CARD_PADDING_Y * 2 +
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
  for (const source of progress.nodes) {
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
    edges.push({ source: source.id, target: targetEntry.node.id, direction, path });
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
    width,
    height,
    stagesTop: nodesTop,
    stagesHeight: height - nodesTop,
    nodes,
    edges,
  };
}
