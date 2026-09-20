/**
 * The one edge of the process diagrams. The map and the graph lay their lines out differently,
 * but every line is drawn here from the same vocabulary: a kind (`forward`, `skip`, `hub`,
 * `return`, `external`, `self`) selects its colour, weight and dash; a state (`lit`, `dim`,
 * `flash`) selects its emphasis; every arrowhead is the same size whatever the line's width.
 * Hovering lights the edge, clicking it goes to its far end, and a halo in the page colour lets
 * a crossing read as over and under.
 */

import React from "react";
import { BaseEdge } from "@xyflow/react";
import { INTERACTIVE_CURSOR } from "./interactive";

export type DiagramEdgeKind = "forward" | "skip" | "hub" | "return" | "external" | "self";

interface EdgeLook {
  stroke: string;
  width: number;
  opacity: number;
  dash?: string;
  marker: "plain" | "return";
}

/** The rest look of every kind: forward lines are solid and full, connectors recede. */
const EDGE_LOOK: Record<DiagramEdgeKind, EdgeLook> = {
  forward: { stroke: "var(--muted-foreground)", width: 2, opacity: 0.75, marker: "plain" },
  external: { stroke: "var(--muted-foreground)", width: 1.5, opacity: 0.5, marker: "plain" },
  skip: {
    stroke: "var(--muted-foreground)",
    width: 1.5,
    opacity: 0.5,
    dash: "2 4",
    marker: "plain",
  },
  hub: { stroke: "var(--muted-foreground)", width: 1.25, opacity: 0.4, marker: "plain" },
  return: { stroke: "var(--primary)", width: 1.5, opacity: 0.6, dash: "6 5", marker: "return" },
  self: { stroke: "var(--primary)", width: 1.5, opacity: 0.6, dash: "6 5", marker: "return" },
};

export const LIT_STROKE = "var(--primary)";
export const LIT_WIDTH = 2.5;

/** Marker ids, mounted once per diagram by `DiagramMarkers`. */
const MARKER = {
  plain: "diagram-arrow",
  return: "diagram-arrow-return",
  lit: "diagram-arrow-lit",
} as const;

/**
 * The arrowheads. `markerUnits="userSpaceOnUse"` keeps every head the same size: by default a
 * marker scales with its line's stroke width, so a lit or a forward edge would grow a bigger head
 * than its neighbours.
 */
export function DiagramMarkers(): React.JSX.Element {
  const marker = (id: string, fill: string, opacity = 1) => (
    <marker
      key={id}
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="9"
      markerHeight="9"
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} fillOpacity={opacity} />
    </marker>
  );
  return (
    <svg aria-hidden="true" style={{ position: "absolute", width: 0, height: 0 }}>
      <defs>
        {marker(MARKER.plain, "var(--muted-foreground)", 0.75)}
        {marker(MARKER.return, "var(--primary)", 0.7)}
        {marker(MARKER.lit, "var(--primary)")}
      </defs>
    </svg>
  );
}

export interface DiagramEdgeProps {
  id: string;
  path: string;
  kind: DiagramEdgeKind;
  /** The edge is under the reader's focus (hovered, or its card is pinned). */
  lit: boolean;
  /** Something else is focused: the edge recedes so the focused path can be followed. */
  dim?: boolean;
  /** The reader just jumped along this edge: it glows for a moment. */
  flash?: boolean;
  title: string;
  /** The transition key the probes and the focus store use. */
  transitionKey: string;
  onHover: (over: boolean) => void;
  /** Go to the far end of the edge. */
  onClick?: () => void;
  /** A halo under the line in the page colour; off where the lines never cross. */
  halo?: boolean;
}

export function DiagramEdge({
  id,
  path,
  kind,
  lit,
  dim = false,
  flash = false,
  title,
  transitionKey,
  onHover,
  onClick,
  halo = true,
}: DiagramEdgeProps): React.JSX.Element {
  const look = EDGE_LOOK[kind];
  const emphasised = lit || flash;
  return (
    <g
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={
        onClick
          ? (event) => {
              event.stopPropagation();
              onClick();
            }
          : undefined
      }
      style={{ cursor: onClick ? INTERACTIVE_CURSOR.clickable : INTERACTIVE_CURSOR.static }}
      data-edge-kind={kind}
      data-transition={transitionKey}
      data-focused={emphasised ? "true" : undefined}
      data-dimmed={dim ? "true" : undefined}
      // The edge explains itself through the application's hint, anchored at the pointer (a
      // long lane's box is nowhere near it), never through the browser's own title bubble; the
      // same text is the accessible name. It is named, not advertised as a control: travel along
      // it is a pointer gesture, the keyboard travels from the ports.
      data-hint={title}
      data-hint-at="pointer"
      role="img"
      aria-label={title}
    >
      {halo && (
        <path
          d={path}
          fill="none"
          stroke="var(--background)"
          strokeWidth={emphasised ? 8 : 6}
          strokeOpacity={dim ? 0 : 0.9}
          strokeLinecap="round"
        />
      )}
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={14}
        markerEnd={`url(#${emphasised ? MARKER.lit : MARKER[look.marker]})`}
        className={flash ? "edge-flash" : undefined}
        style={{
          stroke: emphasised ? LIT_STROKE : look.stroke,
          strokeWidth: emphasised ? LIT_WIDTH : look.width,
          strokeOpacity: dim ? 0.12 : emphasised ? 1 : look.opacity,
          strokeDasharray: look.dash,
          transition: "stroke-opacity 150ms, stroke-width 150ms",
        }}
      />
    </g>
  );
}
