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
  getSmoothStepPath,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FileText, FunctionSquare, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PortedCard, type FactChip, type PortInfo } from "../diagram/PortedCard";
import { ConditionText, ExpressionText, TemplateText } from "../diagram/VariableText";
import { STATUS_STYLE } from "../run/status";
import { isFlashed, isLit, useTransitionFocus } from "../run/focus";
import { DiagramEdge, DiagramMarkers, type DiagramEdgeKind } from "../diagram/DiagramEdge";
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
  /** Travel along a link: bring the step at its far end into view and flash the edge. */
  onGoTo?: (stepId: string, linkId: string) => void;
  /** The reader just arrived at this step from the map or the finder. */
  arrived?: boolean;
  /** The run has been through this step. */
  visited?: boolean;
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
  onGoTo?: (stepId: string, linkId: string) => void;
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
  const { graph, current, error, inputs, outputs, selfLoops, arrived, visited, onGoTo } = data;
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
      width={GRAPH_CARD_WIDTH}
      tone={error ? "error" : current ? "active" : visited ? "done" : "neutral"}
      current={current}
      selected={selected}
      error={error}
      near={near}
      arrived={Boolean(arrived)}
      visited={Boolean(visited)}
      litIds={focus.hovered}
      onHover={(ids) => focus.setHovered(ids)}
      onPortClick={onGoTo ? (port) => port.peer && onGoTo(port.peer, port.id) : undefined}
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

const LINK_KIND: Record<GraphLink["kind"], DiagramEdgeKind> = {
  forward: "forward",
  return: "return",
  external: "external",
};

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
  const { link, route, horizontal, onGoTo } = data;
  const lit = isLit(focus, link.id, link.source);
  let path: string;
  if (link.source === link.target) {
    // A self-loop: out of the bottom double port's left dot, a short dip, back into its right dot.
    const dip = Math.max(sourceY, targetY) + 26;
    path = roundedPath([
      [sourceX, sourceY],
      [sourceX, dip],
      [targetX, dip],
      [targetX, targetY],
    ]);
  } else if (route) {
    path = roundedPath(routedPoints(route, horizontal, sourceX, sourceY, targetX, targetY));
  } else {
    [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      borderRadius: 12,
    });
  }
  return (
    <DiagramEdge
      id={id}
      path={path}
      kind={link.source === link.target ? "self" : LINK_KIND[link.kind]}
      lit={lit}
      // While something is hovered, everything else recedes, so one path can be followed across
      // the whole graph instead of being read out of a bundle of equally dark lines.
      dim={focus.hovered !== null && !lit}
      flash={isFlashed(focus, link.id)}
      title={link.label}
      transitionKey={link.id}
      onHover={(over) => focus.setHovered(over ? [link.id] : null)}
      onClick={onGoTo ? () => onGoTo(link.target, link.id) : undefined}
    />
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
    // A hidden document (another window in front, a background tab) measures cards at wrong or
    // zero sizes; laying out from those wrecks the graph when the reader comes back.
    if (document.visibilityState !== "visible") return;
    if (signature.split("\u0001").some((part) => Number(part.split("\u0000")[1]) < 24)) return;
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

/** The diagrams' arrowheads, mounted once inside the viewport. */
export function GraphDefs(): React.JSX.Element {
  return <DiagramMarkers />;
}
