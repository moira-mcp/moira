/**
 * Layered layout for the aggregated block graph.
 *
 * Forward transitions define the layering (dagre, left-to-right, so the drawing follows process
 * direction across a wide viewport). Edges are then routed by kind so nothing crosses a block:
 *
 * - adjacent-rank forward edges are elbows whose vertical run sits in the gap between ranks;
 * - forward edges that skip ranks travel along lanes above the graph;
 * - cycles travel along lanes below the graph, dashed, one lane per cycle;
 * - transitions into a hub — a block that many blocks exit into, such as "Replan" or "Stopped" —
 *   are not drawn as edges at all but as exit chips inside the source block, the way process
 *   diagrams use off-page connectors; otherwise every block sprouts a long line to the same sink.
 *
 * Everything is a pure function of the projection, so the same input yields the same placement.
 */

import dagre from "dagre";
import type { ProcessProjection, Transition } from "../model";

export const BLOCK_WIDTH = 256;
const BLOCK_BASE_HEIGHT = 74;
const LINE_HEIGHT = 18;
const NAME_LINE_HEIGHT = 20;
const CHARS_PER_LINE = 38;
const NAME_CHARS_PER_LINE = 22;
const MAX_DESCRIPTION_LINES = 3;
const NODE_SEP = 40;
/** Wide enough for a transition label pill to sit between two blocks without touching either. */
const RANK_SEP = 150;
const LANE_GAP = 40;
const LANE_STEP = 26;
const SELF_LOOP_DEPTH = 36;
/** A block entered by at least this many other blocks is drawn as a hub with exit chips. */
export const HUB_IN_DEGREE = 3;

export interface LaidOutBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rank: number;
  /** Transitions rendered as exit chips inside the block rather than as edges. */
  exits: Transition[];
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  transition: Transition;
  kind: "forward" | "skip" | "cycle";
  /** SVG path in graph coordinates. */
  path: string;
  /** Label anchor in graph coordinates. */
  labelX: number;
  labelY: number;
  /** How the label is anchored relative to labelX/labelY. */
  labelAnchor: "center" | "above" | "below";
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
export function estimateBlockHeight(
  name: string,
  description: string,
  hasNote: boolean,
  exitCount: number,
): number {
  return (
    BLOCK_BASE_HEIGHT +
    lineCount(name, NAME_CHARS_PER_LINE, 3) * NAME_LINE_HEIGHT +
    lineCount(description, CHARS_PER_LINE, MAX_DESCRIPTION_LINES) * LINE_HEIGHT +
    (hasNote ? LINE_HEIGHT : 0) +
    (exitCount > 0 ? 26 : 0)
  );
}

export function hubBlockIds(projection: ProcessProjection): Set<string> {
  const inDegree = new Map<string, number>();
  for (const block of projection.blocks) {
    for (const transition of block.transitions) {
      if (transition.cycle || transition.to === block.id) continue;
      inDegree.set(transition.to, (inDegree.get(transition.to) ?? 0) + 1);
    }
  }
  return new Set([...inDegree.entries()].filter(([, n]) => n >= HUB_IN_DEGREE).map(([id]) => id));
}

export function layoutBlocks(
  projection: ProcessProjection,
  options: { extraHeight?: number } = {},
): BlockLayout {
  const hubs = hubBlockIds(projection);
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 24, marginy: 24 });

  const exitsOf = new Map<string, Transition[]>();
  for (const block of projection.blocks) {
    const exits = block.transitions.filter((t) => !t.cycle && hubs.has(t.to) && t.to !== block.id);
    exitsOf.set(block.id, exits);
    graph.setNode(block.id, {
      width: BLOCK_WIDTH,
      height:
        estimateBlockHeight(
          block.name,
          block.description,
          Boolean(projection.run[block.id]?.note),
          exits.length,
        ) + (options.extraHeight ?? 0),
    });
  }
  // Hub edges still take part in ranking so a hub lands after the blocks that exit into it.
  for (const block of projection.blocks) {
    for (const transition of block.transitions) {
      if (!transition.cycle) graph.setEdge(block.id, transition.to);
    }
  }
  dagre.layout(graph);

  const xs = [...new Set(projection.blocks.map((b) => Math.round(graph.node(b.id).x)))].sort(
    (a, b) => a - b,
  );
  const blocks: LaidOutBlock[] = projection.blocks.map((block) => {
    const node = graph.node(block.id);
    return {
      id: block.id,
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
      rank: xs.indexOf(Math.round(node.x)),
      exits: exitsOf.get(block.id) ?? [],
    };
  });
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const top = Math.min(...blocks.map((b) => b.y));
  const bottom = Math.max(...blocks.map((b) => b.y + b.height));

  const edges: LaidOutEdge[] = [];
  let bottomLane = 0;
  let topLane = 0;

  for (const block of projection.blocks) {
    const source = byId.get(block.id)!;
    for (const transition of block.transitions) {
      const target = byId.get(transition.to);
      if (!target) continue;
      const id = `${block.id}->${transition.to}:${transition.label}`;

      if (!transition.cycle && hubs.has(transition.to)) continue; // drawn as an exit chip

      if (!transition.cycle) {
        const x1 = source.x + source.width;
        const y1 = source.y + source.height / 2;
        const x2 = target.x;
        const y2 = target.y + target.height / 2;

        if (target.rank - source.rank <= 1) {
          // Adjacent rank: elbow with its vertical run inside the inter-rank gap.
          const midX = x1 + (x2 - x1) / 2;
          const path =
            Math.abs(y1 - y2) < 1
              ? `M ${x1} ${y1} L ${x2} ${y2}`
              : `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
          edges.push({
            id,
            from: block.id,
            to: transition.to,
            transition,
            kind: "forward",
            path,
            labelX: midX,
            labelY: y1 - 4,
            labelAnchor: "above",
          });
        } else {
          // Skips ranks: over the top so it never crosses the blocks in between.
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
        // Self-loop: a small hook below the block.
        const y = source.y + source.height;
        const xLeft = source.x + source.width * 0.35;
        const xRight = source.x + source.width * 0.65;
        const dip = y + SELF_LOOP_DEPTH;
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

      // Returning edge: down from the source, along its own lane below the graph, up into the
      // target's bottom.
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
  const width = Math.max(...blocks.map((b) => b.x + b.width)) + 24;
  const height = bottom + bottomExtent + topExtent + 24;
  return { blocks, edges, hubIds: [...hubs], width, height };
}
