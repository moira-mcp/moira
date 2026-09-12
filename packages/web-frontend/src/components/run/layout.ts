/**
 * Layered layout of the block graph for the canvas mode.
 *
 * Forward transitions define the layering (ELK layered, left to right, so the drawing follows
 * process direction across a wide viewport). Edges are then routed by kind so nothing crosses a
 * block:
 *
 * - adjacent-rank forward edges are elbows whose vertical run sits in the gap between ranks;
 * - forward edges that skip ranks travel along lanes above the graph;
 * - cycles travel along lanes below the graph, dashed, one lane per cycle;
 * - transitions into a hub — a block that many blocks exit into, such as "Replan" or "Stopped" —
 *   are bundled: one muted edge per source and hub, leaving the source's right edge, rising in the
 *   gap after its rank to a channel above the graph that the hub owns, and dropping in the gap
 *   before the hub's rank into one port on the hub's left edge. Vertical runs stay in the gaps
 *   between ranks, so a bundle never crosses a block placed above its source or its hub. The
 *   labels stay as exit chips inside the source block, the way process diagrams use off-page
 *   connectors.
 *
 * The layout is a pure function of its input: ELK is run with a fixed seed and only forward edges,
 * so the same blocks always yield the same placement. The engine is loaded on first use so the
 * page pays for it only when the canvas opens.
 */

import type { RunBlock, RunTransition } from "./model";
import { PARALLEL_CHIP_MIN, canvasChipsOf, hubExitsOf } from "./chips";

export const BLOCK_WIDTH = 256;
const BLOCK_BASE_HEIGHT = 74;
const LINE_HEIGHT = 18;
const NAME_LINE_HEIGHT = 20;
const CHARS_PER_LINE = 38;
const NAME_CHARS_PER_LINE = 22;
const MAX_DESCRIPTION_LINES = 3;
const NODE_SEP = 40;
/** The least gap between ranks; it grows to hold the widest label pill drawn at rest in a gap. */
const MIN_RANK_SEP = 150;
/** A forward label pill is truncated beyond this width (the `max-w` of the pill in `CanvasView`). */
export const LABEL_MAX_WIDTH = 200;
/** Label metric of the pill's 11 px medium face: an upper bound per character plus the padding. */
const LABEL_CHAR_WIDTH = 6.4;
const LABEL_PADDING = 18;
/** Clear space between a pill at rest and the blocks on either side of its gap. */
const LABEL_CLEARANCE = 10;
const LANE_GAP = 40;
const LANE_STEP = 26;
const SELF_LOOP_DEPTH = 36;
const MARGIN = 24;
/** How far into the gap between ranks a hub bundle's vertical run sits, off the label pills' centre. */
const HUB_GAP_INSET = 24;
/** The hub port sits this far below the hub's top on its left edge, clear of skip-lane landings. */
const HUB_PORT_INSET = 24;

export interface LaidOutBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  /** The transition drawn; for a hub bundle, the first of the source's transitions into the hub. */
  transition: RunTransition;
  kind: "forward" | "skip" | "cycle" | "hub";
  /** SVG path in graph coordinates. */
  path: string;
  labelX: number;
  labelY: number;
  labelAnchor: "center" | "above" | "below";
  /** How many adjacent forward transitions share this edge's pair of blocks (forward edges). */
  parallelCount?: number;
}

export interface BlockLayout {
  blocks: LaidOutBlock[];
  edges: LaidOutEdge[];
  hubIds: string[];
  width: number;
  height: number;
}

function lineCount(text: string, charsPerLine: number, max: number): number {
  return Math.min(max, Math.max(1, Math.ceil(text.length / charsPerLine)));
}

/** Height is a pure function of the block's text so layout stays deterministic. */
/** Chips (hub exits, skips, returns) wrap inside the block; two fit one row at the block width. */
const CHIPS_PER_ROW = 2;
const CHIP_ROW_HEIGHT = 24;
/** Parallel forward transitions between one pair of blocks spread by this much per transition. */
const PARALLEL_STEP = 26;

export function estimateBlockHeight(
  name: string,
  description: string,
  hasNote: boolean,
  chipCount: number,
): number {
  return (
    BLOCK_BASE_HEIGHT +
    lineCount(name, NAME_CHARS_PER_LINE, 3) * NAME_LINE_HEIGHT +
    lineCount(description, CHARS_PER_LINE, MAX_DESCRIPTION_LINES) * LINE_HEIGHT +
    (hasNote ? LINE_HEIGHT : 0) +
    Math.ceil(chipCount / CHIPS_PER_ROW) * CHIP_ROW_HEIGHT
  );
}

interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many adjacent forward transitions join each `from->to` pair (cycles and hubs excluded). */
function parallelCounts(
  blocks: readonly RunBlock[],
  hubs: ReadonlySet<string>,
): Map<string, number> {
  const parallel = new Map<string, number>();
  for (const block of blocks) {
    for (const tr of block.transitions) {
      if (tr.cycle || hubs.has(tr.to)) continue;
      const pair = `${block.id}->${tr.to}`;
      parallel.set(pair, (parallel.get(pair) ?? 0) + 1);
    }
  }
  return parallel;
}

/** The width a label pill takes at rest, bounded by the pill's own cap. */
export function labelPillWidth(label: string): number {
  return Math.min(LABEL_MAX_WIDTH, label.length * LABEL_CHAR_WIDTH + LABEL_PADDING);
}

/**
 * The gap between ranks: at least `MIN_RANK_SEP`, and wide enough that every forward label drawn
 * at rest — an adjacent transition whose pair is not folded into a forward chip — sits between its
 * blocks with clearance on both sides, so no pill runs under the next card.
 */
export function rankSeparation(blocks: readonly RunBlock[], hubIds: readonly string[]): number {
  const hubs = new Set(hubIds);
  const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
  const parallel = parallelCounts(blocks, hubs);
  let widest = 0;
  for (const block of blocks) {
    for (const tr of block.transitions) {
      if (tr.cycle || hubs.has(tr.to) || indexOf.get(tr.to) !== block.index + 1) continue;
      if ((parallel.get(`${block.id}->${tr.to}`) ?? 1) >= PARALLEL_CHIP_MIN) continue;
      widest = Math.max(widest, labelPillWidth(tr.label));
    }
  }
  return Math.max(MIN_RANK_SEP, Math.ceil(widest + 2 * LABEL_CLEARANCE));
}

/** Layer the blocks with ELK over their forward (non-cycle) transitions. */
async function placeBlocks(
  blocks: readonly RunBlock[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  rankSep: number,
): Promise<Placed[]> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const ids = new Set(blocks.map((b) => b.id));
  const edges = blocks.flatMap((block) =>
    block.transitions
      .filter((t) => !t.cycle && t.to !== block.id && ids.has(t.to))
      .map((t) => ({ id: `${block.id}->${t.to}`, sources: [block.id], targets: [t.to] })),
  );
  const seen = new Set<string>();
  const laid = await elk.layout({
    id: "process",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": String(NODE_SEP),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(rankSep),
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
    },
    children: blocks.map((block) => ({ id: block.id, ...sizes.get(block.id)! })),
    edges: edges.filter((edge) => (seen.has(edge.id) ? false : (seen.add(edge.id), true))),
  });
  return (laid.children ?? []).map((child) => ({
    id: child.id,
    x: child.x ?? 0,
    y: child.y ?? 0,
    width: child.width ?? BLOCK_WIDTH,
    height: child.height ?? BLOCK_BASE_HEIGHT,
  }));
}

/** Where every bundled hub edge enters a hub: a point near the top of its left edge. */
export function hubPort(block: Pick<LaidOutBlock, "x" | "y">): { x: number; y: number } {
  return { x: block.x, y: block.y + HUB_PORT_INSET };
}

export async function layoutBlocks(
  blocks: readonly RunBlock[],
  hubIds: readonly string[],
): Promise<BlockLayout> {
  const hubs = new Set(hubIds);
  const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
  const sizes = new Map<string, { width: number; height: number }>();
  for (const block of blocks) {
    // Every connector away from the rail (hub exit, skip, return) is a chip inside the block.
    sizes.set(block.id, {
      width: BLOCK_WIDTH,
      height: estimateBlockHeight(
        block.name,
        block.description,
        false,
        canvasChipsOf(block, hubIds, blocks).length,
      ),
    });
  }
  const placed = await placeBlocks(blocks, sizes, rankSeparation(blocks, hubIds));
  const placedById = new Map(placed.map((p) => [p.id, p]));
  const xs = [...new Set(placed.map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const laidBlocks: LaidOutBlock[] = blocks.map((block) => {
    const p = placedById.get(block.id)!;
    return {
      id: block.id,
      x: p.x,
      y: p.y,
      width: p.width,
      height: p.height,
      rank: xs.indexOf(Math.round(p.x)),
    };
  });
  const byId = new Map(laidBlocks.map((b) => [b.id, b]));
  const top = Math.min(...laidBlocks.map((b) => b.y));
  const bottom = Math.max(...laidBlocks.map((b) => b.y + b.height));

  const edges: LaidOutEdge[] = [];
  let bottomLane = 0;
  // Hubs take the channels nearest the graph, one per hub, in the derivation's hub order; skip
  // edges stack above them. Only hubs that actually receive a transition get a channel.
  const receiving = new Set(
    blocks.flatMap((b) => hubExitsOf(b, hubIds, blocks).map((chip) => chip.transition.to)),
  );
  // Adjacent forward transitions that join the same pair of blocks share the gap between them:
  // each takes its own horizontal line and its own label row so nothing stacks on one point.
  const parallel = parallelCounts(blocks, hubs);
  const parallelIndex = new Map<string, number>();
  const hubLane = new Map([...hubs].filter((id) => receiving.has(id)).map((id, i) => [id, i]));
  let topLane = hubLane.size;
  const bundled = new Set<string>();

  for (const block of blocks) {
    const source = byId.get(block.id)!;
    for (const transition of block.transitions) {
      const target = byId.get(transition.to);
      if (!target) continue;
      const id = `${block.id}->${transition.to}:${transition.label}`;

      if (!transition.cycle && hubs.has(transition.to)) {
        const bundleId = `${block.id}->${transition.to}:hub`;
        if (bundled.has(bundleId)) continue; // one edge per source and hub; the chips carry the labels
        bundled.add(bundleId);
        const laneY = top - LANE_GAP - hubLane.get(transition.to)! * LANE_STEP;
        const x1 = source.x + source.width;
        const y1 = source.y + HUB_PORT_INSET;
        const xa = x1 + HUB_GAP_INSET;
        const port = hubPort(target);
        const xb = port.x - HUB_GAP_INSET;
        const path = `M ${x1} ${y1} L ${xa} ${y1} L ${xa} ${laneY} L ${xb} ${laneY} L ${xb} ${port.y} L ${port.x} ${port.y}`;
        edges.push({
          id: bundleId,
          from: block.id,
          to: transition.to,
          transition,
          kind: "hub",
          path,
          labelX: (xa + xb) / 2,
          labelY: laneY,
          labelAnchor: "above",
        });
        continue;
      }

      if (!transition.cycle) {
        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x;
        const y2 = target.y + target.height / 2;
        // Adjacent in process order (the same rule the chips use): an elbow in the gap with its
        // label; anything further is a skip lane above the graph named by a chip in the source.
        if (indexOf.get(transition.to)! <= block.index + 1) {
          const pair = `${block.id}->${transition.to}`;
          const count = parallel.get(pair) ?? 1;
          const index = parallelIndex.get(pair) ?? 0;
          parallelIndex.set(pair, index + 1);
          const offset = (index - (count - 1) / 2) * PARALLEL_STEP;
          const ya = y1 + offset;
          const yb = y2 + offset;
          const midX = x1 + (x2 - x1) / 2;
          const path =
            Math.abs(ya - yb) < 1
              ? `M ${x1} ${ya} L ${x2} ${yb}`
              : `M ${x1} ${ya} L ${midX} ${ya} L ${midX} ${yb} L ${x2} ${yb}`;
          edges.push({
            id,
            from: block.id,
            to: transition.to,
            transition,
            kind: "forward",
            path,
            labelX: midX,
            labelY: ya - 4,
            labelAnchor: "above",
            parallelCount: count,
          });
        } else {
          const laneY = top - LANE_GAP - topLane * LANE_STEP;
          topLane += 1;
          const xa = source.x + source.width * 0.7;
          const xb = target.x + target.width * 0.3;
          const path = `M ${xa} ${source.y} L ${xa} ${laneY} L ${xb} ${laneY} L ${xb} ${target.y}`;
          edges.push({
            id,
            from: block.id,
            to: transition.to,
            transition,
            kind: "skip",
            path,
            labelX: (xa + xb) / 2,
            labelY: laneY,
            labelAnchor: "above",
          });
        }
        continue;
      }

      if (transition.to === block.id) {
        // Several self-loops of one block dip further one by one, each with its own label row.
        const selfIndex = parallelIndex.get(`${block.id}->${block.id}:self`) ?? 0;
        parallelIndex.set(`${block.id}->${block.id}:self`, selfIndex + 1);
        const y = source.y + source.height;
        const xLeft = source.x + source.width * 0.35;
        const xRight = source.x + source.width * 0.65;
        const dip = y + SELF_LOOP_DEPTH + selfIndex * PARALLEL_STEP;
        const path = `M ${xRight} ${y} L ${xRight} ${dip} L ${xLeft} ${dip} L ${xLeft} ${y}`;
        edges.push({
          id,
          from: block.id,
          to: transition.to,
          transition,
          kind: "cycle",
          path,
          labelX: (xLeft + xRight) / 2,
          labelY: dip + 4,
          labelAnchor: "below",
        });
        continue;
      }

      const laneY = bottom + LANE_GAP + bottomLane * LANE_STEP;
      bottomLane += 1;
      const x1 = source.x + source.width * 0.3;
      const y1 = source.y + source.height;
      const x2 = target.x + target.width * 0.7;
      const y2 = target.y + target.height;
      const path = `M ${x1} ${y1} L ${x1} ${laneY} L ${x2} ${laneY} L ${x2} ${y2}`;
      edges.push({
        id,
        from: block.id,
        to: transition.to,
        transition,
        kind: "cycle",
        path,
        labelX: (x1 + x2) / 2,
        labelY: laneY,
        labelAnchor: "above",
      });
    }
  }

  const bottomExtent = bottomLane > 0 ? LANE_GAP + bottomLane * LANE_STEP + 16 : 0;
  const topExtent = topLane > 0 ? LANE_GAP + topLane * LANE_STEP + 16 : 0;
  const width = Math.max(...laidBlocks.map((b) => b.x + b.width)) + MARGIN;
  const height = bottom + bottomExtent + topExtent + MARGIN;
  return { blocks: laidBlocks, edges, hubIds: [...hubs], width, height };
}

/** Pairs of blocks whose rectangles overlap; empty for a readable layout. */
export function overlappingBlocks(layout: BlockLayout): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const { blocks } = layout;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      if (!apart) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
