/**
 * The technical graph's pieces: a step node (the shared step card with handles), a block group
 * node (the tinted container a block's steps sit in, named and numbered like the process views),
 * and one edge component for every connection — forward inside a block with its label, forward
 * into another block muted, a return dashed in the primary colour and unlabelled at rest, lit with
 * its label when its source card's chip or the edge is hovered.
 */

import React, { useEffect } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  getSmoothStepPath,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { StepCard } from "../run/StepCard";
import { STATUS_STYLE } from "../run/status";
import { isLit, useTransitionFocus } from "../run/focus";
import type { GraphLink, GraphStep } from "../run/graphModel";
import type { ExecutionBlockStatus } from "../run/model";
import { GRAPH_CARD_WIDTH, type GraphRoute } from "./graphLayout";

export type StepNodeData = Record<string, unknown> & {
  graph: GraphStep;
  current: boolean;
  error: boolean;
  horizontal: boolean;
};
export type StepNode = Node<StepNodeData>;

export type BlockGroupData = {
  blockId: string;
  index: number;
  name: string;
  status: ExecutionBlockStatus;
};
export type BlockGroupNode = Node<BlockGroupData, "block-group">;

export type GraphEdgeData = {
  link: GraphLink;
  /** Set when the edge is routed around the cards; absent when it runs straight to its target. */
  route?: GraphRoute;
  /** Whether the cards' handles sit on their left and right (blocks stacked top to bottom). */
  horizontal: boolean;
};

/** An SVG path along `points` with the corners rounded. */
export function roundedPath(points: ReadonlyArray<[number, number]>, radius = 10): string {
  if (points.length < 2) return "";
  const parts = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0 || inLen === 0 || outLen === 0) {
      parts.push(`L ${cx} ${cy}`);
      continue;
    }
    const ax = cx - ((cx - px) / inLen) * r;
    const ay = cy - ((cy - py) / inLen) * r;
    const bx = cx + ((nx - cx) / outLen) * r;
    const by = cy + ((ny - cy) / outLen) * r;
    parts.push(`L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`);
  }
  const [lx, ly] = points[points.length - 1];
  parts.push(`L ${lx} ${ly}`);
  return parts.join(" ");
}

/**
 * The points a routed edge passes, from the source handle to the target handle: out along the
 * card axis to the stub, along the lane waypoints, in from the side to the target.
 */
export function routedPoints(
  route: GraphRoute,
  horizontal: boolean,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): Array<[number, number]> {
  return horizontal
    ? [
        [sourceX, sourceY],
        [route.stub, sourceY],
        ...route.lane,
        [route.side, targetY],
        [targetX, targetY],
      ]
    : [
        [sourceX, sourceY],
        [sourceX, route.stub],
        ...route.lane,
        [targetX, route.side],
        [targetX, targetY],
      ];
}
export type GraphEdge = Edge<GraphEdgeData, "graph">;

export function StepNodeView({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const focus = useTransitionFocus();
  const { graph, current, error, horizontal } = data;
  return (
    <div
      style={{ width: GRAPH_CARD_WIDTH }}
      className={cn(
        "rounded-lg",
        selected && "ring-2 ring-ring",
        error && "ring-2 ring-destructive",
      )}
      data-graph-node={graph.id}
    >
      <Handle
        type="target"
        position={horizontal ? Position.Left : Position.Top}
        id="input"
        className="!opacity-0"
      />
      <ul className="list-none">
        <StepCard
          step={graph.step}
          current={current}
          connections={graph.connections}
          onConnectionHover={(connection) =>
            focus.setHovered(connection ? [`${graph.id}.${connection.label}`] : null)
          }
        />
      </ul>
      <Handle
        type="source"
        position={horizontal ? Position.Right : Position.Bottom}
        id="output"
        className="!opacity-0"
      />
    </div>
  );
}

export function BlockGroupView({ data }: NodeProps<BlockGroupNode>): React.JSX.Element {
  const style = STATUS_STYLE[data.status];
  return (
    <div
      className={cn("h-full w-full rounded-2xl border-2 px-4 pt-2", style.surface)}
      data-block-id={data.blockId}
      data-graph-group=""
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide">
        <span className="mr-1.5 tabular-nums opacity-70">{data.index + 1}.</span>
        {data.name}
      </p>
    </div>
  );
}

export function GraphEdgeView({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<GraphEdge>): React.JSX.Element | null {
  const focus = useTransitionFocus();
  if (!data) return null;
  const { link, route, horizontal } = data;
  const isReturn = link.kind === "return";
  const lit = isLit(focus, link.id, link.source);
  let path: string;
  let labelX: number;
  let labelY: number;
  if (route) {
    // The label sits on the first lane run, which lies in a corridor clear of the cards.
    path = roundedPath(routedPoints(route, horizontal, sourceX, sourceY, targetX, targetY));
    const [[ax, ay], [bx, by]] = route.lane;
    labelX = (ax + bx) / 2;
    labelY = (ay + by) / 2;
  } else {
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 12,
    });
  }
  const showLabel = link.kind === "forward" || lit;
  return (
    <>
      <g
        onMouseEnter={() => focus.setHovered([link.id])}
        onMouseLeave={() => focus.setHovered(null)}
        style={{ cursor: "default" }}
      >
        <title>{link.label}</title>
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={14}
          markerEnd={
            lit
              ? "url(#graph-arrow-return)"
              : isReturn
                ? "url(#graph-arrow-return-muted)"
                : "url(#graph-arrow)"
          }
          style={{
            stroke: lit || isReturn ? "var(--primary)" : "var(--muted-foreground)",
            strokeWidth: lit ? 2 : 1.5,
            strokeOpacity: lit ? 1 : isReturn ? 0.55 : link.kind === "external" ? 0.4 : 0.5,
            strokeDasharray: isReturn ? "6 5" : undefined,
          }}
          data-edge-kind={link.kind}
          data-transition={link.id}
          data-focused={lit ? "true" : undefined}
        />
      </g>
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              "nodrag nopan absolute inline-flex max-w-[180px] items-center gap-1 truncate rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium leading-4",
              isReturn ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
              lit && "z-10 shadow-sm",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-edge-label={link.kind}
            data-transition={link.id}
            title={link.label}
          >
            {isReturn && <RotateCcw className="size-3 shrink-0" aria-hidden="true" />}
            {link.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * Reports the step cards' measured heights whenever React Flow has measured them (mounted inside
 * the viewport, where the store is): the graph lays itself out again with the real heights when
 * they differ from its estimates.
 */
export function GraphMeasuredHeights({
  onMeasured,
}: {
  onMeasured: (heights: Map<string, number>) => void;
}): null {
  // The graph is controlled without a change handler, so the measured sizes never reach the
  // `nodes` it passes; the store's internal nodes carry them. The selector folds them into one
  // string so the effect runs only when a height changes, and only once every card is measured.
  const signature = useStore((state) => {
    const parts: string[] = [];
    for (const node of state.nodeLookup.values()) {
      if (node.type === "block-group") continue;
      const height = node.measured?.height;
      if (!height) return "";
      parts.push(`${node.id}\u0000${height}`);
    }
    return parts.join("\u0001");
  });
  useEffect(() => {
    if (!signature) return;
    onMeasured(
      new Map(
        signature.split("\u0001").map((part) => {
          const [id, height] = part.split("\u0000");
          return [id, Number(height)];
        }),
      ),
    );
  }, [signature, onMeasured]);
  return null;
}

/** Arrowheads for the graph's edges, mounted once inside the viewport. */
export function GraphDefs(): React.JSX.Element {
  const marker = (id: string, fill: string, opacity = 1) => (
    <marker
      key={id}
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} fillOpacity={opacity} />
    </marker>
  );
  return (
    <svg aria-hidden="true">
      <defs>
        {marker("graph-arrow", "var(--muted-foreground)", 0.5)}
        {marker("graph-arrow-return", "var(--primary)")}
        {marker("graph-arrow-return-muted", "var(--primary)", 0.5)}
      </defs>
    </svg>
  );
}
