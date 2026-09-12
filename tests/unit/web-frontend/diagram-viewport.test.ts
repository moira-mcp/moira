/**
 * The shared diagram interaction policy: every diagram kind pans on a plain wheel, zooms only on
 * a pinch (ctrl-wheel), pans on drag, never drags nodes, and keeps the page still under the
 * pointer; the zoom range and fit padding are the only per-kind differences.
 */

import { describe, expect, test } from "@jest/globals";
import {
  diagramInteractionProps,
  type DiagramKind,
} from "../../../packages/web-frontend/src/components/diagram/interaction.js";

const KINDS: DiagramKind[] = ["canvas", "lanes", "graph"];

describe("diagramInteractionProps", () => {
  test.each(KINDS)("%s: a plain wheel pans in both directions and never zooms", (kind) => {
    const props = diagramInteractionProps(kind);
    expect(props.panOnScroll).toBe(true);
    expect(props.panOnScrollMode).toBe("free");
    expect(props.zoomOnScroll).toBe(false);
    expect(props.zoomOnDoubleClick).toBe(false);
  });

  test.each(KINDS)("%s: pinch zooms, drag pans, nodes stay where the layout put them", (kind) => {
    const props = diagramInteractionProps(kind);
    expect(props.zoomOnPinch).toBe(true);
    expect(props.panOnDrag).toBe(true);
    expect(props.nodesDraggable).toBe(false);
    expect(props.selectNodesOnDrag).toBe(false);
  });

  test.each(KINDS)(
    "%s: the page does not scroll under the pointer and the view opens fitted",
    (kind) => {
      const props = diagramInteractionProps(kind);
      expect(props.preventScrolling).toBe(true);
      expect(props.fitView).toBe(true);
      expect(props.fitViewOptions.padding).toBeGreaterThan(0);
      // The opening fit never shrinks cards below legibility: lanes open at full size, the canvas
      // at three quarters or larger; only the technical graph may shrink to its floor.
      expect(props.fitViewOptions.minZoom).toBeGreaterThanOrEqual(props.minZoom);
      expect(props.fitViewOptions.maxZoom).toBeLessThanOrEqual(props.maxZoom);
      if (kind === "lanes") expect(props.fitViewOptions.minZoom).toBe(1);
      if (kind === "canvas") expect(props.fitViewOptions.minZoom).toBeGreaterThanOrEqual(0.75);
    },
  );

  test.each([
    ["canvas", 0.2, 1.5],
    ["lanes", 0.2, 1.5],
    ["graph", 0.1, 2],
  ] as const)("%s zooms between %s and %s", (kind, minZoom, maxZoom) => {
    const props = diagramInteractionProps(kind);
    expect(props.minZoom).toBe(minZoom);
    expect(props.maxZoom).toBe(maxZoom);
    expect(props.minZoom).toBeLessThan(props.maxZoom);
  });
});
