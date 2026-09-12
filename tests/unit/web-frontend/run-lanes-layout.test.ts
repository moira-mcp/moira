/**
 * The horizontal lanes rail's flow-coordinate layout: lane cards sit in one row at fixed, equal
 * spacing below the links band, arcs draw beneath the row, the arc and link geometry lands in the
 * band it belongs to, and the viewport height follows the geometry (plus the fit padding) with a
 * floor for the control cluster.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ARC_BASE,
  ARC_STEP,
  LINK_BASE,
  LINK_STEP,
  arcGeometry,
  arcsHeight,
  linkGeometry,
  linksHeight,
  type LaneArc,
  type LaneLink,
} from "../../../packages/web-frontend/src/components/run/arcs.js";
import {
  LANE_GAP,
  LANE_HEIGHT,
  LANE_WIDTH,
  laneCenter,
  laneRailLayout,
  laneViewportHeight,
} from "../../../packages/web-frontend/src/components/run/laneLayout.js";
import { diagramInteractionProps } from "../../../packages/web-frontend/src/components/diagram/interaction.js";

const arc = (from: number, to: number, depth: number): LaneArc => ({
  from,
  to,
  depth,
  label: `back ${from}→${to}`,
  cause: "cause",
  exit: "exit",
});
const link = (from: number, to: number, depth: number): LaneLink => ({
  from,
  to,
  depth,
  label: "skip",
});

describe("laneRailLayout", () => {
  test("places lane cards in one row at equal spacing and reports the rail width", () => {
    const layout = laneRailLayout(4, [], []);
    expect(layout.positions).toEqual([
      { x: 0, y: 0 },
      { x: LANE_WIDTH + LANE_GAP, y: 0 },
      { x: 2 * (LANE_WIDTH + LANE_GAP), y: 0 },
      { x: 3 * (LANE_WIDTH + LANE_GAP), y: 0 },
    ]);
    expect(layout.width).toBe(4 * LANE_WIDTH + 3 * LANE_GAP);
    expect(layout.rowTop).toBe(0);
    expect(layout.rowBottom).toBe(LANE_HEIGHT);
    expect(layout.height).toBe(LANE_HEIGHT);
    expect(laneRailLayout(0, [], []).width).toBe(0);
  });

  test("lane centres sit in the middle of each card so edges meet the cards", () => {
    const layout = laneRailLayout(3, [], []);
    layout.positions.forEach((p, i) => expect(laneCenter(i)).toBe(p.x + LANE_WIDTH / 2));
  });

  test("links push the row down by their band and arcs extend the height beneath the row", () => {
    const links = [link(0, 2, 0), link(1, 3, 1)];
    const arcs = [arc(2, 0, 0), arc(3, 1, 1)];
    const layout = laneRailLayout(4, arcs, links);
    expect(layout.rowTop).toBe(linksHeight(links));
    expect(layout.rowTop).toBe(LINK_BASE + LINK_STEP + 16);
    expect(layout.positions.every((p) => p.y === layout.rowTop)).toBe(true);
    expect(layout.rowBottom).toBe(layout.rowTop + LANE_HEIGHT);
    expect(layout.height).toBe(layout.rowBottom + arcsHeight(arcs));
    expect(layout.height).toBe(layout.rowBottom + ARC_BASE + ARC_STEP + 34);
  });

  test("arc geometry translated by the row bottom stays inside the arcs band; a link's path ends on the row top", () => {
    const links = [link(0, 2, 0)];
    const arcs = [arc(2, 0, 0)];
    const layout = laneRailLayout(3, arcs, links);
    const drawnArc = arcGeometry(arcs[0], laneCenter);
    expect(layout.rowBottom + drawnArc.y).toBeGreaterThan(layout.rowBottom);
    expect(layout.rowBottom + drawnArc.y).toBeLessThan(layout.height);
    expect(drawnArc.x1).toBe(laneCenter(2));
    expect(drawnArc.x2).toBe(laneCenter(0));
    const drawnLink = linkGeometry(links[0], laneCenter, layout.rowTop);
    expect(drawnLink.d.endsWith(`${layout.rowTop - 2}`)).toBe(true);
    expect(drawnLink.y).toBeGreaterThan(0);
    expect(drawnLink.y).toBeLessThan(layout.rowTop);
  });
});

describe("laneViewportHeight", () => {
  test("a rail with no connectors gets the floor height so the controls fit", () => {
    expect(laneViewportHeight(laneRailLayout(5, [], []))).toBe(200);
  });

  test("a rail with nested arcs and links grows by the geometry plus the fit padding", () => {
    const arcs = [arc(4, 0, 0), arc(3, 1, 1), arc(2, 1, 2)];
    const links = [link(0, 2, 0)];
    const layout = laneRailLayout(5, arcs, links);
    const { padding } = diagramInteractionProps("lanes").fitViewOptions;
    expect(laneViewportHeight(layout)).toBe(Math.ceil(layout.height * (1 + padding)));
    expect(laneViewportHeight(layout)).toBeGreaterThan(
      laneViewportHeight(laneRailLayout(5, [], [])),
    );
    expect(laneViewportHeight(layout)).toBeGreaterThan(layout.height);
  });
});
