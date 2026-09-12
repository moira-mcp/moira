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
  ARC_TAIL,
  LINK_BASE,
  LINK_STEP,
  LINK_TAIL,
  arcGeometry,
  arcsHeight,
  linkGeometry,
  linksHeight,
  PILL_ROW,
  pillRows,
  type LaneArc,
  type LaneLink,
} from "../../../packages/web-frontend/src/components/run/arcs.js";
import {
  LANE_CHIP_ROW,
  LANE_GAP,
  LANE_HEIGHT,
  LANE_WIDTH,
  laneCardHeight,
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

  test("lane cards grow one row per chip beyond the first, so a chip column never spills out", () => {
    expect(laneCardHeight(0)).toBe(LANE_HEIGHT);
    expect(laneCardHeight(1)).toBe(LANE_HEIGHT);
    expect(laneCardHeight(6)).toBe(LANE_HEIGHT + 5 * LANE_CHIP_ROW);
    const tall = laneRailLayout(3, [], [], laneCardHeight(6));
    expect(tall.cardHeight).toBe(laneCardHeight(6));
    expect(tall.rowBottom).toBe(tall.rowTop + laneCardHeight(6));
    expect(tall.height).toBe(tall.rowBottom);
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
    expect(layout.rowTop).toBe(LINK_BASE + LINK_STEP + LINK_TAIL);
    expect(layout.positions.every((p) => p.y === layout.rowTop)).toBe(true);
    expect(layout.rowBottom).toBe(layout.rowTop + LANE_HEIGHT);
    expect(layout.height).toBe(layout.rowBottom + arcsHeight(arcs));
    expect(layout.height).toBe(layout.rowBottom + ARC_BASE + ARC_STEP + ARC_TAIL);
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

describe("pillRows", () => {
  test("pills of connectors lit together take one row each beyond the outermost of them", () => {
    // Six self-return arcs of one lane at consecutive depths, all lit by one folded chip.
    const lit = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, y: ARC_BASE + i * ARC_STEP }));
    const rows = pillRows(lit, 1);
    const ys = [...rows.values()].sort((a, b) => a - b);
    expect(ys).toHaveLength(6);
    expect(ys[0]).toBe(ARC_BASE + 5 * ARC_STEP + 3);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i] - ys[i - 1]).toBe(PILL_ROW);
    // The deepest arc gets the first row, so its pill sits right under its line.
    expect(rows.get("k5")).toBe(ys[0]);
    // Links mirror upward from the highest link.
    const up = pillRows(
      [
        { key: "a", y: 30 },
        { key: "b", y: 18 },
      ],
      -1,
    );
    expect(up.get("b")).toBe(15);
    expect(up.get("a")).toBe(15 - PILL_ROW);
    expect(pillRows([], 1).size).toBe(0);
  });
});

describe("bands reserve the lit pill rows", () => {
  test("a source with several arcs adds a pill row per extra arc to the arcs band", () => {
    const one = [arc(3, 0, 0)];
    const three = [arc(3, 0, 0), arc(3, 1, 1), arc(3, 2, 2)];
    expect(arcsHeight(three) - (ARC_BASE + 2 * ARC_STEP + ARC_TAIL)).toBe(2 * PILL_ROW);
    expect(arcsHeight(one)).toBe(ARC_BASE + ARC_TAIL);
    // The same depth from different sources needs no extra row: they are never lit together.
    expect(arcsHeight([arc(2, 0, 0), arc(3, 1, 1)])).toBe(ARC_BASE + ARC_STEP + ARC_TAIL);
    const rows = pillRows(
      three.map((a, i) => ({ key: `k${i}`, y: arcGeometry(a, laneCenter).y })),
      1,
    );
    const deepest = Math.max(...rows.values());
    expect(deepest + PILL_ROW).toBeLessThanOrEqual(arcsHeight(three));
    expect(linksHeight([link(0, 2, 0), link(0, 3, 1)])).toBe(
      LINK_BASE + LINK_STEP + LINK_TAIL + PILL_ROW,
    );
  });
});
