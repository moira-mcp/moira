import type { ExecutionProgress, ExecutionProgressState } from "./execution-progress-contract.js";
export type {
  ExecutionProgress,
  ExecutionProgressNode,
  ExecutionProgressState,
} from "./execution-progress-contract.js";

export type ProgressTheme = "light" | "dark";

export interface ProgressVisualOptions {
  theme?: ProgressTheme;
  viewportWidth?: number;
}

export interface ProgressVisualNode {
  id: string;
  label: string;
  state: ExecutionProgressState;
  x: number;
  y: number;
  width: number;
  height: number;
  focusNodeId: string | null;
}

export interface ProgressVisualEdge {
  source: string;
  target: string;
  direction: "forward" | "backward";
  path: string;
}

export interface ProgressVisualModel {
  title: string | null;
  theme: ProgressTheme;
  width: number;
  height: number;
  nodes: ProgressVisualNode[];
  edges: ProgressVisualEdge[];
}

const NODE_WIDTH = 176;
const NODE_MIN_WIDTH = 120;
const NODE_HEIGHT = 72;
const NODE_GAP = 48;
const PADDING_X = 40;
const NODE_Y = 70;
const BACK_EDGE_BASE_Y = 184;
export const PROGRESS_IMAGE_MAX_WIDTH = 4096;
export const PROGRESS_IMAGE_MIN_WIDTH = 480;

export function normalizeProgressVisualOptions(
  options: ProgressVisualOptions = {},
): Required<ProgressVisualOptions> {
  const requested = Math.round(options.viewportWidth ?? 1280);
  return {
    theme: options.theme === "dark" ? "dark" : "light",
    viewportWidth: Math.min(
      PROGRESS_IMAGE_MAX_WIDTH,
      Math.max(PROGRESS_IMAGE_MIN_WIDTH, requested),
    ),
  };
}

export function buildExecutionProgressVisualModel(
  progress: ExecutionProgress,
  options: ProgressVisualOptions = {},
): ProgressVisualModel {
  const normalized = normalizeProgressVisualOptions(options);
  const compactGap = progress.nodes.length > 1 ? 20 : 0;
  const fittedNodeWidth = Math.floor(
    (normalized.viewportWidth -
      PADDING_X * 2 -
      compactGap * Math.max(0, progress.nodes.length - 1)) /
      Math.max(1, progress.nodes.length),
  );
  const nodeWidth = Math.min(NODE_WIDTH, Math.max(NODE_MIN_WIDTH, fittedNodeWidth));
  const nodeGap = nodeWidth < NODE_WIDTH ? compactGap : NODE_GAP;
  const contentWidth =
    PADDING_X * 2 +
    progress.nodes.length * nodeWidth +
    Math.max(0, progress.nodes.length - 1) * nodeGap;
  const width = Math.min(
    PROGRESS_IMAGE_MAX_WIDTH,
    Math.max(normalized.viewportWidth, contentWidth),
  );
  const nodes = progress.nodes.map((node, index): ProgressVisualNode => ({
    id: node.id,
    label: node.label,
    state: node.state,
    x: PADDING_X + index * (nodeWidth + nodeGap),
    y: NODE_Y,
    width: nodeWidth,
    height: NODE_HEIGHT,
    focusNodeId: node.focusNodeId,
  }));
  const byId = new Map(nodes.map((node, index) => [node.id, { node, index }]));
  const edges: ProgressVisualEdge[] = [];
  for (const source of progress.nodes) {
    const targetId = source.connections.default;
    const sourceEntry = byId.get(source.id);
    const targetEntry = targetId ? byId.get(targetId) : undefined;
    if (!sourceEntry || !targetEntry) continue;
    const forward = targetEntry.index > sourceEntry.index;
    const startX = forward
      ? sourceEntry.node.x + sourceEntry.node.width
      : sourceEntry.node.x + sourceEntry.node.width / 2;
    const endX = forward ? targetEntry.node.x : targetEntry.node.x + targetEntry.node.width / 2;
    const path = forward
      ? `M ${startX} ${NODE_Y + NODE_HEIGHT / 2} L ${endX} ${NODE_Y + NODE_HEIGHT / 2}`
      : `M ${startX} ${NODE_Y + NODE_HEIGHT} C ${startX} ${BACK_EDGE_BASE_Y}, ${endX} ${BACK_EDGE_BASE_Y}, ${endX} ${NODE_Y + NODE_HEIGHT}`;
    edges.push({
      source: source.id,
      target: targetEntry.node.id,
      direction: forward ? "forward" : "backward",
      path,
    });
  }
  return {
    title: progress.title,
    theme: normalized.theme,
    width,
    height: edges.some((edge) => edge.direction === "backward") ? 224 : 176,
    nodes,
    edges,
  };
}
