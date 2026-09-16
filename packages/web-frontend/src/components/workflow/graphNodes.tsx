/**
 * The technical graph's pieces: a step node (the shared step card, one handle per connection on
 * each side, its arrivals named as chips), a block group node (the tinted container a block's
 * steps sit in, named and numbered like the process views), and one edge component for every
 * connection. A line is drawn at rest only where it runs straight from card to card, with its
 * label; an edge that needs a corridor is named by chips in both cards instead and is drawn, with
 * its label, while it is lit — by hovering either chip, either card or the edge itself, which
 * dims everything else.
 */

import React, { useEffect } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FileText, FunctionSquare, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortedCard, type FactChip, type PortInfo } from "../diagram/PortedCard";
import { ConditionText, ExpressionText, TemplateText } from "../diagram/VariableText";
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
  /** The edges arriving at the card, one input port each, in layout order. */
  inputs: PortInfo[];
  /** The edges leaving the card, one output port each. */
  outputs: PortInfo[];
  /** The edges from the card to itself; they share the bottom double port. */
  selfLoops: PortInfo[];
  /** Brings the card at the other end of an arrival into view. */
  onFocusStep?: (id: string) => void;
  /** The reader just arrived at this step from the map or the finder. */
  arrived?: boolean;
};

/** Where the `index`-th of `count` handles sits along a card's edge, as a CSS percentage. */
export function handleOffset(index: number, count: number): string {
  return `${((index + 1) / (count + 1)) * 100}%`;
}
export type StepNode = Node<StepNodeData>;

export type BlockGroupData = {
  blockId: string;
  index: number;
  name: string;
  status: ExecutionBlockStatus;
  /** The block the page has selected: the map's selection carried onto the graph. */
  selected?: boolean;
  /** The reader just arrived in this block from the map. */
  arrived?: boolean;
};
export type BlockGroupNode = Node<BlockGroupData, "block-group">;

export type GraphEdgeData = {
  link: GraphLink;
  /**
   * The edge is named by chips in both cards and drawn only on demand: at rest a long line
   * through a corridor cannot be told from its neighbours, so it is not drawn at all.
   */
  chipped?: boolean;
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

/** The fact chips of a step: the directive, what it returns, its expressions, its cases. */
function stepFacts(graph: GraphStep): FactChip[] {
  const step = graph.step;
  const facts: FactChip[] = [];
  if (step.text) {
    facts.push({
      key: "directive",
      icon: <FileText className="size-3" aria-hidden="true" />,
      label: step.routing ? "message" : "directive",
      tip: (
        <>
          <TemplateText text={step.text} />
          {step.completionCondition && (
            <>
              {"\n\n"}
              <b>completion</b>
              {"\n"}
              <TemplateText text={step.completionCondition} />
            </>
          )}
        </>
      ),
    });
  }
  if (step.evidence.length > 0) {
    facts.push({
      key: "returns",
      icon: <Undo2 className="size-3" aria-hidden="true" />,
      label: "returns",
      count: step.evidence.length,
      tip: step.evidence
        .map(
          (field) =>
            `${field.name}${field.type ? `: ${field.type}` : ""}${field.required ? " · required" : ""}${
              field.description ? ` — ${field.description}` : ""
            }`,
        )
        .join("\n"),
    });
  }
  if (step.expressions.length > 0) {
    facts.push({
      key: "expressions",
      icon: <FunctionSquare className="size-3" aria-hidden="true" />,
      label: "expressions",
      count: step.expressions.length,
      tip: (
        <>
          {step.expressions.map((expression, index) => (
            <React.Fragment key={index}>
              {index > 0 && "\n"}
              <ExpressionText text={expression} />
            </React.Fragment>
          ))}
        </>
      ),
    });
  }
  return facts;
}

export function StepNodeView({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const focus = useTransitionFocus();
  const { graph, current, error, horizontal, inputs, outputs, selfLoops, arrived } = data;
  const links = [...inputs, ...outputs, ...selfLoops].map((port) => port.id);
  // Hovering the card lights every connection it takes part in, and the cards at their far end.
  const near = focus.hovered !== null && links.some((id) => focus.hovered!.has(id));
  const step = graph.step;
  return (
    <PortedCard
      type={step.type}
      title={step.progressLabel ?? step.displayName ?? step.id}
      subtitle={step.progressLabel || step.displayName ? step.id : null}
      description={step.progressContent ?? step.summary ?? null}
      descriptionTip={
        step.progressContent ? (
          <TemplateText text={step.progressContent} />
        ) : step.text ? (
          <TemplateText text={step.text} />
        ) : null
      }
      facts={stepFacts(graph)}
      inputs={inputs}
      outputs={outputs}
      selfLoops={selfLoops}
      horizontal={horizontal}
      width={GRAPH_CARD_WIDTH}
      current={current}
      selected={selected}
      error={error}
      near={near}
      arrived={Boolean(arrived)}
      litIds={focus.hovered}
      onHover={(ids) => focus.setHovered(ids)}
      allLinkIds={links}
      dataAttributes={{ "data-graph-node": graph.id }}
    />
  );
}

/** The tooltip of an output port: the case that selects it, or the default output. */
export function outputTip(graph: GraphStep, label: string, targetName: string): React.ReactNode {
  const cases = graph.step.cases.filter((c) => c.output === label);
  if (cases.length > 0) {
    return (
      <>
        {cases.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && "\n"}
            <b>case</b> <ConditionText when={c.when} />
          </React.Fragment>
        ))}
        {"\n→ "}
        {targetName}
      </>
    );
  }
  if (label === "error" || label === "timeout") return `${label} — control output\n→ ${targetName}`;
  return `${label} — taken when no case holds\n→ ${targetName}`;
}

export function BlockGroupView({ data }: NodeProps<BlockGroupNode>): React.JSX.Element {
  const style = STATUS_STYLE[data.status];
  return (
    <div
      className={cn(
        "pointer-events-none h-full w-full rounded-2xl border-2 px-4 pt-2",
        style.surface,
        data.selected && "ring-2 ring-ring",
        data.arrived && "animate-pulse ring-4 ring-primary/70",
      )}
      data-block-id={data.blockId}
      data-graph-group=""
      data-selected={data.selected ? "true" : undefined}
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
  const { link, route, horizontal, chipped } = data;
  const isReturn = link.kind === "return";
  const lit = isLit(focus, link.id, link.source);
  let path: string;
  let labelX: number;
  let labelY: number;
  if (link.source === link.target) {
    // A self-loop: out of the bottom double port's left dot, a short dip, back into its right dot.
    const dip = Math.max(sourceY, targetY) + 26;
    path = roundedPath([
      [sourceX, sourceY],
      [sourceX, dip],
      [targetX, dip],
      [targetX, targetY],
    ]);
    labelX = (sourceX + targetX) / 2;
    labelY = dip + 10;
  } else if (route) {
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
  // While something is hovered, everything else recedes, so one path can be followed across the
  // whole graph instead of being read out of a bundle of equally dark lines.
  const dim = focus.hovered !== null && !lit;
  // Every edge is drawn at rest, arrowhead included; a routed (corridor) edge is drawn muted and
  // without its label until it is lit, since its label would collide with its neighbours'.
  // The transition is named by its ports (the output name on the source, the source on the
  // target, each with a tooltip); the line itself carries no label.
  const showLabel = false;
  return (
    <>
      <g
        onMouseEnter={() => focus.setHovered([link.id])}
        onMouseLeave={() => focus.setHovered(null)}
        style={{ cursor: "default" }}
      >
        <title>{link.label}</title>
        {/* A halo in the page colour under the line: where two edges cross, the one drawn later
            interrupts the other, so the crossing reads as over and under instead of a junction. */}
        <path
          d={path}
          fill="none"
          stroke="var(--background)"
          strokeWidth={lit ? 8 : 6}
          strokeOpacity={dim ? 0 : 0.9}
          strokeLinecap="round"
        />
        <BaseEdge
          id={id}
          path={path}
          interactionWidth={14}
          markerEnd={
            lit
              ? "url(#graph-arrow-lit)"
              : isReturn
                ? "url(#graph-arrow-return-muted)"
                : "url(#graph-arrow)"
          }
          style={{
            stroke: lit || isReturn ? "var(--primary)" : "var(--muted-foreground)",
            strokeWidth: lit ? 2.5 : 1.5,
            strokeOpacity: dim
              ? 0.12
              : lit
                ? 1
                : chipped
                  ? 0.3
                  : isReturn
                    ? 0.55
                    : link.kind === "external"
                      ? 0.4
                      : 0.5,
            strokeDasharray: isReturn ? "6 5" : undefined,
          }}
          data-dimmed={dim ? "true" : undefined}
          data-edge-kind={link.kind}
          data-transition={link.id}
          data-focused={lit ? "true" : undefined}
        />
      </g>
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              "nodrag nopan pointer-events-auto absolute inline-flex max-w-[180px] items-center gap-1 truncate rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium leading-4",
              isReturn ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
              lit && "z-10 shadow-sm",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-edge-label={link.kind}
            data-transition={link.id}
            title={link.label}
            onMouseEnter={() => focus.setHovered([link.id])}
            onMouseLeave={() => focus.setHovered(null)}
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
      markerWidth="9"
      markerHeight="9"
      // Without this the arrowhead scales with the line's width, so a lit edge grows a head twice
      // the size of its neighbours'.
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} fillOpacity={opacity} />
    </marker>
  );
  return (
    <svg aria-hidden="true">
      <defs>
        {marker("graph-arrow", "var(--muted-foreground)", 0.5)}
        {marker("graph-arrow-lit", "var(--primary)")}
        {marker("graph-arrow-return-muted", "var(--primary)", 0.5)}
      </defs>
    </svg>
  );
}
