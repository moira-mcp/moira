/**
 * The horizontal lanes rail as flow coordinates: one row of equal, fixed lane cards with the
 * forward links' band above it and the return arcs' band beneath it. Pure, so the React Flow
 * instance only places nodes and draws edges where this module says, and a test can check the
 * positions and the viewport height without rendering.
 *
 * Vertical bands, top to bottom: links (`0 … rowTop`), cards (`rowTop … rowBottom`), arcs
 * (`rowBottom … height`). `arcGeometry` and `linkGeometry` keep producing coordinates relative to
 * their own band, so an arc path is translated by `rowBottom` and a link path by nothing.
 */

import { arcsHeight, linksHeight, type LaneArc, type LaneLink } from "./arcs";
import { diagramInteractionProps } from "../diagram/interaction";

export const LANE_WIDTH = 160;
export const LANE_GAP = 12;
/** Tall enough for the block number, a two-line name, a two-line summary and one chip. */
export const LANE_HEIGHT = 140;
/** Each chip beyond the first adds one row: chips stack in a column at the lane width. */
export const LANE_CHIP_ROW = 22;

/** The height of every lane card: one row per chip of the block with the most chips. */
export function laneCardHeight(maxChips: number): number {
  return LANE_HEIGHT + Math.max(0, maxChips - 1) * LANE_CHIP_ROW;
}
/** The viewport never shrinks below the zoom control cluster plus a little room around it. */
const RAIL_MIN_HEIGHT = 200;

export interface LaneRailLayout {
  /** Top-left corner of each lane card, in process order. */
  positions: Array<{ x: number; y: number }>;
  /** Height of every lane card (`laneCardHeight` of the block with the most chips). */
  cardHeight: number;
  rowTop: number;
  rowBottom: number;
  width: number;
  height: number;
}

export function laneCenter(index: number): number {
  return index * (LANE_WIDTH + LANE_GAP) + LANE_WIDTH / 2;
}

export function laneRailLayout(
  count: number,
  arcs: readonly LaneArc[],
  links: readonly LaneLink[],
  cardHeight: number = LANE_HEIGHT,
): LaneRailLayout {
  const rowTop = linksHeight(links);
  const rowBottom = rowTop + cardHeight;
  return {
    positions: Array.from({ length: count }, (_, i) => ({
      x: i * (LANE_WIDTH + LANE_GAP),
      y: rowTop,
    })),
    cardHeight,
    rowTop,
    rowBottom,
    width: count > 0 ? count * LANE_WIDTH + (count - 1) * LANE_GAP : 0,
    height: rowBottom + arcsHeight(arcs),
  };
}

/**
 * The fixed height of the rail's viewport: the geometry plus the fit-to-view padding the shared
 * policy applies, so a fit at zoom 1 shows the whole rail when the width allows it and the page
 * does not jump when a run adds or removes a return.
 */
export function laneViewportHeight(layout: LaneRailLayout): number {
  const { padding } = diagramInteractionProps("lanes").fitViewOptions;
  return Math.max(RAIL_MIN_HEIGHT, Math.ceil(layout.height * (1 + padding)));
}
