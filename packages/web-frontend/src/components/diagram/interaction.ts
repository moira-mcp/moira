/**
 * The interaction policy every diagram shares, as plain React Flow props: a plain wheel or
 * two-finger scroll pans in both directions, a pinch (a `ctrlKey` wheel in the browser) zooms,
 * drag on empty space pans, nothing needs a prior click, and the page does not scroll while the
 * pointer is over the diagram. Nodes are never draggable: positions come from our layouts.
 *
 * Pure so a unit test can assert the policy without rendering; `DiagramViewport` applies it.
 */

import type { PanOnScrollMode } from "@xyflow/react";

export type DiagramKind = "canvas" | "graph";

export interface DiagramInteractionProps {
  panOnScroll: true;
  panOnScrollMode: PanOnScrollMode;
  zoomOnScroll: false;
  zoomOnPinch: true;
  zoomOnDoubleClick: false;
  panOnDrag: true;
  nodesDraggable: false;
  selectNodesOnDrag: false;
  preventScrolling: true;
  fitView: true;
  /** The fit never shrinks a diagram below `fitMinZoom` (cards stay legible) or grows it past `fitMaxZoom`. */
  fitViewOptions: { padding: number; minZoom: number; maxZoom: number };
  minZoom: number;
  maxZoom: number;
}

/** Zoom range and fit padding per diagram kind; the gesture policy is the same for all. */
const RANGE: Record<
  DiagramKind,
  { minZoom: number; maxZoom: number; padding: number; fitMinZoom: number; fitMaxZoom: number }
> = {
  // Block cards are large: the user may shrink a canvas to a fifth, but the opening fit stops at
  // three quarters so a dense flow opens readable and is panned, not squinted at.
  canvas: { minZoom: 0.2, maxZoom: 1.5, padding: 0.1, fitMinZoom: 0.75, fitMaxZoom: 1 },
  // The technical graph has many small nodes: it must shrink further to fit a dense flow.
  graph: { minZoom: 0.1, maxZoom: 2, padding: 0.2, fitMinZoom: 0.1, fitMaxZoom: 1 },
};

export function diagramInteractionProps(kind: DiagramKind): DiagramInteractionProps {
  const { minZoom, maxZoom, padding, fitMinZoom, fitMaxZoom } = RANGE[kind];
  return {
    panOnScroll: true,
    // The enum's value; typed through the enum so the props stay assignable to React Flow, and
    // written as its literal so this module stays free of runtime imports.
    panOnScrollMode: "free" as PanOnScrollMode,
    zoomOnScroll: false,
    zoomOnPinch: true,
    zoomOnDoubleClick: false,
    panOnDrag: true,
    nodesDraggable: false,
    selectNodesOnDrag: false,
    preventScrolling: true,
    fitView: true,
    fitViewOptions: { padding, minZoom: fitMinZoom, maxZoom: fitMaxZoom },
    minZoom,
    maxZoom,
  };
}
