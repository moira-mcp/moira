/**
 * The map's diagram — the process as a graph, filling the space the map view gives it.
 *
 * Blocks are laid out in layers that follow process direction left to right. Adjacent forward
 * transitions are elbows with their label in the gap; transitions that skip ranks travel above the
 * graph; cycles return along dashed lanes below it; and exits into a hub block (one that many
 * blocks lead to, such as "Replan" or "Stopped") are thin muted edges bundled into one port near the
 * top of the hub's left edge. Cycles, skips and hub bundles carry no label at rest: a chip inside
 * the source names each target, and hovering the chip (or the edge) lights that edge and shows its
 * label; selecting a block lights all of its connectors. Adjacent forward transitions keep their
 * label in the gap they own. Status is carried by colour, icon and a chip, so it is readable
 * without hover. A card also carries the run facts of its block: how many times it ran (`×n`), the
 * time its passes took (with the open pass's own time while it is running) and, when the block is
 * bound to a list, how much of that list is done. The view opens fitted to the process but never
 * below three quarters size, so a dense flow opens readable and is panned; on a run it then centres
 * on the block the run is at. Gestures come from the shared `DiagramViewport`. `MapView` puts this
 * diagram beside the contents sidebar; nothing else renders it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Background,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Clock, ListChecks, Loader2, Repeat } from "lucide-react";
import { PortedCard, type CardTone, type FactChip, type PortInfo } from "../diagram/PortedCard";
import { DiagramEdge, DiagramMarkers, type DiagramEdgeKind } from "../diagram/DiagramEdge";
import { INTERACTIVE } from "../diagram/interactive";
import { ListMarker } from "../diagram/ListMarker";
import { NodeTypeTag } from "./nodeTypeStyle";
import { roundedPath } from "../workflow/graphNodes";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { diagramInteractionProps } from "../diagram/interaction";
import { useOpeningPlacement } from "../diagram/placement";
import { useLayoutPreset } from "../diagram/layoutPreset";
import { DiagramToolbar } from "../diagram/DiagramToolbar";
import { NodeFinder } from "./NodeFinder";

/** Gutter kept between the viewport edge and the first block when a definition opens. */
const CANVAS_EDGE = 16;
/** Where the block row sits when a definition opens: this fraction of the viewport height from the top. */
const CANVAS_ROW_ANCHOR = 0.3;
import { PassCount, StatusChip } from "./status";
import { BLOCK_WIDTH, layoutBlocks, type BlockLayout, type LaidOutEdge } from "./layout";
import { formatDuration } from "./duration";
import { currentBlockId, stepsOf, type RunBlock, type RunViewProps, type StepInfo } from "./model";
import { transitionKey } from "./chips";
import { TransitionFocusProvider, isFlashed, isLit, useTransitionFocus } from "./focus";

type BlockNodeData = {
  block: RunBlock;
  selected: boolean;
  isHub: boolean;
  inputs: PortInfo[];
  outputs: PortInfo[];
  selfLoops: PortInfo[];
  /** Who the run waits for, so a waiting card is worded for the agent or for a person. */
  waitingFor: "agent" | "user" | null;
  onSelect: (id: string | null) => void;
  /** The blocks are stacked top to bottom (the vertical preset); the ports stay left and right. */
  vertical: boolean;
  /** The block's steps, for the steps tooltip. */
  steps: StepInfo[];
  /** Open a step on the technical graph. */
  onFocusNode?: (nodeId: string) => void;
  /** Travel along a transition: bring the block at its far end into view and flash the edge. */
  onGoTo: (blockId: string, transitionKey: string) => void;
  /** The reader just arrived at this block along a transition. */
  arrived: boolean;
  /** A list item on the card was clicked: open the block's list in the panel at that item. */
  onSelectListItem?: (blockId: string, index: number) => void;
};
type BlockNode = Node<BlockNodeData, "block">;
type RoutedEdge = Edge<
  {
    laid: LaidOutEdge;
    vertical: boolean;
    onGoTo: (blockId: string, transitionKey: string) => void;
    /** The column the edge's vertical takes beside its source and beside its target (0 = innermost). */
    outRank: number;
    inRank: number;
  },
  "routed"
>;

/** The fact chips of a block: its steps, its passes, its time and the list it works through. */
/** The steps of a block as rows in a tooltip: type, name, id; each row opens the step on the graph. */
function StepTipList({
  steps,
  currentNodeId,
  onFocusNode,
}: {
  steps: StepInfo[];
  currentNodeId: string | null;
  onFocusNode?: (nodeId: string) => void;
}): React.JSX.Element {
  return (
    <ol className="max-h-[320px] space-y-0.5 overflow-y-auto" data-step-tip-list="">
      {steps.map((step, index) => {
        const title = step.progressLabel ?? step.displayName ?? step.id;
        const Row: "button" | "div" = onFocusNode ? "button" : "div";
        return (
          <li key={step.id}>
            <Row
              {...(onFocusNode
                ? { type: "button" as const, onClick: () => onFocusNode(step.id) }
                : {})}
              className={cn(
                "grid w-full grid-cols-[1.25rem_auto_minmax(0,1fr)] items-center gap-x-2 rounded-md border border-transparent px-1.5 py-1 text-left font-sans",
                onFocusNode ? INTERACTIVE.clickable : INTERACTIVE.static,
                step.id === currentNodeId && "bg-primary/10",
              )}
              data-step-row={step.id}
            >
              <span className="text-right text-[10px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <NodeTypeTag type={step.type} fixed />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{title}</span>
                {title !== step.id && (
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {step.id}
                  </span>
                )}
              </span>
            </Row>
          </li>
        );
      })}
    </ol>
  );
}

function blockFacts(
  block: RunBlock,
  t: TFunction,
  steps: StepInfo[],
  onFocusNode?: (nodeId: string) => void,
): FactChip[] {
  const facts: FactChip[] = [];
  facts.push({
    key: "steps",
    label: t("pages.runPage.stepCount", { count: block.nodeIds.length }),
    tip:
      steps.length > 0 ? (
        <StepTipList steps={steps} currentNodeId={block.currentNodeId} onFocusNode={onFocusNode} />
      ) : (
        block.nodeIds.join("\n")
      ),
  });
  if (block.iterations > 1) {
    facts.push({
      key: "passes",
      icon: <Repeat className="size-3" aria-hidden="true" />,
      label: "×",
      count: block.iterations,
      tip: block.timing.passes
        .map(
          (pass, index) =>
            `${index + 1}: ${pass.durationMs === null ? "—" : formatDuration(pass.durationMs, t)}${pass.open ? " · " + t("pages.runPage.map.current") : ""}`,
        )
        .join("\n"),
    });
  }
  const { timing, list } = block;
  if (timing.totalMs !== null || timing.currentMs !== null) {
    facts.push({
      key: "timing",
      icon: <Clock className="size-3" aria-hidden="true" />,
      label:
        timing.currentMs !== null
          ? formatDuration(timing.currentMs, t)
          : formatDuration(timing.totalMs ?? 0, t),
      tip: `${t("pages.runPage.map.total")}: ${timing.totalMs === null ? "—" : formatDuration(timing.totalMs, t)}${
        timing.currentMs !== null
          ? `\n${t("pages.runPage.map.current")}: ${formatDuration(timing.currentMs, t)}`
          : ""
      }`,
    });
  }
  if (list && (list.done !== null || list.total !== null)) {
    facts.push({
      key: "list",
      icon: <ListChecks className="size-3" aria-hidden="true" />,
      label: `${list.done ?? "?"}/${list.total ?? "?"}`,
      tip: list.items
        ? list.items
            .map(
              (item) =>
                `${item.done ? "✓" : item.current ? "▶" : "·"} ${item.title}${item.durationMs !== null ? ` — ${formatDuration(item.durationMs, t)}` : ""}`,
            )
            .join("\n")
        : (list.currentTitle ?? t("pages.runPage.map.listProgress")),
    });
  }
  return facts;
}

export const BLOCK_TONE: Record<RunBlock["status"], CardTone> = {
  pending: "neutral",
  active: "active",
  waiting: "waiting",
  done: "done",
  repeated: "done",
  skipped: "neutral",
};

function BlockNodeView({ data }: NodeProps<BlockNode>): React.JSX.Element {
  const { t } = useTranslation();
  const focus = useTransitionFocus();
  const {
    block,
    selected,
    isHub,
    inputs,
    outputs,
    selfLoops,
    waitingFor,
    onSelect,
    steps,
    onFocusNode,
    onGoTo,
    arrived,
    onSelectListItem,
  } = data;
  const keys = [...inputs, ...outputs, ...selfLoops].map((port) => port.id);
  const near = focus.hovered !== null && keys.some((key) => focus.hovered!.has(key));
  const litIds = focus.hovered ?? (focus.pinnedBlock === block.id ? new Set(keys) : null);
  return (
    <PortedCard
      badge={<StatusChip status={block.status} waitingFor={waitingFor} />}
      titleExtra={block.iterations > 1 ? <PassCount iterations={block.iterations} /> : undefined}
      title={block.name}
      index={block.index + 1}
      tone={BLOCK_TONE[block.status]}
      description={block.description}
      descriptionTip={block.description}
      facts={blockFacts(block, t, steps, onFocusNode)}
      arrived={arrived}
      onPortClick={(port) => port.peer && onGoTo(port.peer, port.id)}
      inputs={inputs}
      outputs={outputs}
      selfLoops={selfLoops}
      width={BLOCK_WIDTH}
      current={block.status === "active" || block.status === "waiting"}
      selected={selected}
      near={near}
      litIds={litIds}
      onHover={(ids) => focus.setHovered(ids)}
      allLinkIds={keys}
      onClick={() => onSelect(selected ? null : block.id)}
      dataAttributes={{
        "data-block-id": block.id,
        "data-status": block.status,
        "data-hub": isHub ? "true" : undefined,
      }}
    >
      {block.list && block.list.items && block.list.items.length > 0 && (
        // The list at a glance: every item on its own line, the current one marked; the chip's
        // tooltip keeps the durations.
        <ol className="mt-2 space-y-0.5 text-[11px] leading-4" data-block-list-items="">
          {block.list.items.slice(0, 5).map((item) => (
            <li
              key={item.index}
              className={cn(
                "flex items-center gap-1.5 truncate",
                item.done && "text-muted-foreground line-through decoration-muted-foreground/50",
                item.current && "font-medium text-primary",
              )}
            >
              <ListMarker done={item.done} current={item.current} variant="glyph" />
              {onSelectListItem ? (
                <button
                  type="button"
                  className={cn("truncate text-left", INTERACTIVE.clickable, "hover:underline")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectListItem(block.id, item.index);
                  }}
                  data-list-item={item.index}
                >
                  {item.title}
                </button>
              ) : (
                <span className="truncate">{item.title}</span>
              )}
            </li>
          ))}
          {block.list.items.length > 5 && (
            <li className="text-muted-foreground">… {block.list.items.length - 5}</li>
          )}
        </ol>
      )}
    </PortedCard>
  );
}

/** The points of a laid path (`M x y L x y …`), so a lane can be read back from it. */
function pathPoints(path: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const match of path.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
    points.push([Number(match[1]), Number(match[2])]);
  }
  return points;
}

/** How far an edge runs out of its port before it turns. */
const PORT_STUB = 20;
const SELF_LOOP_DIP = 26;

/**
 * The edge from its source port to its target port: a forward elbow keeps its vertical in the
 * gap the layout chose; a skip, a hub bundle or a return keeps the lane the layout gave it and
 * reaches it from the ports through short stubs; a transition back to the block itself dips
 * under its bottom double port.
 */
/** Distance between the verticals of two edges leaving or entering neighbouring ports. */
const PORT_COLUMN_STEP = 10;

interface PortSlots {
  outRank: number;
  inRank: number;
}

function portedPath(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  vertical = false,
  slots: PortSlots = { outRank: 0, inRank: 0 },
): { path: string; labelX: number; labelY: number } {
  if (vertical && laid.from !== laid.to) {
    const routed = stackedPoints(laid, sx, sy, tx, ty, slots);
    return { path: roundedPath(routed.points), labelX: routed.labelX, labelY: routed.labelY };
  }
  const routed = portedPoints(laid, sx, sy, tx, ty, slots);
  return { path: roundedPath(routed.points), labelX: routed.labelX, labelY: routed.labelY };
}

/**
 * The stacked layout (blocks top to bottom, lanes in the gaps between columns) is the row layout
 * transposed, so its laid path leaves the source's bottom edge and reaches the target's top edge.
 * The ports stay on the sides: the edge leaves the right port, runs a stub out (one column per
 * port rank), drops into the laid path, and at the far end comes down beside the target's left
 * edge and enters its left port.
 */
function stackedPoints(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  slots: PortSlots,
): { points: Array<[number, number]>; labelX: number; labelY: number } {
  const logical = pathPoints(laid.path).map(([x, y]) => [y, x] as [number, number]);
  const outX = sx + PORT_STUB + slots.outRank * PORT_COLUMN_STEP;
  const inX = tx - PORT_STUB - slots.inRank * PORT_COLUMN_STEP;
  // The laid path's first and last points sit on the source's bottom and the target's top edge;
  // the points after and before them are straight below and above, in the row gaps.
  const inner = logical.slice(1, -1);
  if (inner.length === 0) {
    const midY = (sy + ty) / 2;
    const points: Array<[number, number]> = [
      [sx, sy],
      [outX, sy],
      [outX, midY],
      [inX, midY],
      [inX, ty],
      [tx, ty],
    ];
    return { points, labelX: (outX + inX) / 2, labelY: midY };
  }
  const first = inner[0];
  const last = inner[inner.length - 1];
  const points: Array<[number, number]> = [
    [sx, sy],
    [outX, sy],
    [outX, first[1]],
    ...inner.slice(1, -1),
    [inX, last[1]],
    [inX, ty],
    [tx, ty],
  ];
  // The label sits on the longest run of the path.
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const length =
      Math.abs(points[i + 1][0] - points[i][0]) + Math.abs(points[i + 1][1] - points[i][1]);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  return {
    points,
    labelX: (points[best][0] + points[best + 1][0]) / 2,
    labelY: (points[best][1] + points[best + 1][1]) / 2,
  };
}

function portedPoints(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  slots: PortSlots,
): { points: Array<[number, number]>; labelX: number; labelY: number } {
  const points = pathPoints(laid.path);
  if (laid.from === laid.to) {
    const dip = Math.max(sy, ty) + SELF_LOOP_DIP;
    return {
      points: [
        [sx, sy],
        [sx, dip],
        [tx, dip],
        [tx, ty],
      ],
      labelX: (sx + tx) / 2,
      labelY: dip + 10,
    };
  }
  if (laid.kind === "forward") {
    const midX = points.length >= 3 ? points[1][0] : (sx + tx) / 2;
    const pts: Array<[number, number]> =
      Math.abs(sy - ty) < 1
        ? [
            [sx, sy],
            [tx, ty],
          ]
        : [
            [sx, sy],
            [midX, sy],
            [midX, ty],
            [tx, ty],
          ];
    return { points: pts, labelX: midX, labelY: Math.min(sy, ty) - 4 };
  }
  const ys = points.map((p) => p[1]);
  const laneY = laid.laneY ?? (laid.kind === "cycle" ? Math.max(...ys) : Math.min(...ys));
  // Every edge at a card runs its vertical in a column of its own beside the card (`portRanks`),
  // so two edges never share a line.
  const out = sx + PORT_STUB + slots.outRank * PORT_COLUMN_STEP;
  const into = tx - PORT_STUB - slots.inRank * PORT_COLUMN_STEP;
  return {
    points: [
      [sx, sy],
      [out, sy],
      [out, laneY],
      [into, laneY],
      [into, ty],
      [tx, ty],
    ],
    labelX: (out + into) / 2,
    labelY: laneY,
  };
}

const EDGE_KIND: Record<LaidOutEdge["kind"], DiagramEdgeKind> = {
  forward: "forward",
  skip: "skip",
  hub: "hub",
  cycle: "return",
};

function RoutedEdgeView({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: EdgeProps<RoutedEdge>): React.JSX.Element | null {
  const { t } = useTranslation();
  const focus = useTransitionFocus();
  if (!data) return null;
  const { laid, vertical, outRank, inRank, onGoTo } = data;
  const key = transitionKey(laid.from, laid.transition);
  const lit = isLit(focus, key, laid.from);
  const cycle = laid.kind === "cycle";
  const ported = portedPath(laid, sourceX, sourceY, targetX, targetY, vertical, {
    outRank,
    inRank,
  });
  const title = cycle
    ? `${laid.transition.label} — ${laid.transition.cycle?.cause} — ${t("pages.runPage.map.endsWhen")} ${laid.transition.cycle?.exit}`
    : laid.transition.label;
  return (
    <DiagramEdge
      id={id}
      path={ported.path}
      kind={laid.from === laid.to ? "self" : EDGE_KIND[laid.kind]}
      lit={lit}
      dim={focus.hovered !== null && !lit}
      flash={isFlashed(focus, key)}
      title={title}
      transitionKey={key}
      onHover={(over) => focus.setHovered(over ? [key] : null)}
      onClick={() => onGoTo(laid.to, key)}
    />
  );
}

/**
 * Column ranks of the lane edges at every card, per side. For one card and one side, the edges
 * split into those whose lane lies above the card and those whose lane lies below; each group
 * takes its own range of columns (the above group innermost), and within a group the ports are
 * ordered so the port furthest from the lane is outermost.
 */
function portRanks(
  edges: readonly LaidOutEdge[],
  ports: ReadonlyMap<string, { outputs: string[]; inputs: string[] }>,
  blockY: ReadonlyMap<string, number>,
): { out: Map<string, number>; in: Map<string, number> } {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  type Item = { id: string; index: number; above: boolean };
  const bySource = new Map<string, Item[]>();
  const byTarget = new Map<string, Item[]>();
  for (const laid of edges) {
    if (laid.kind === "forward" || laid.from === laid.to || laid.laneY === undefined) continue;
    const key = transitionKey(laid.from, laid.transition);
    const outIndex = ports.get(laid.from)?.outputs.indexOf(key) ?? -1;
    const inIndex = ports.get(laid.to)?.inputs.indexOf(key) ?? -1;
    bySource.set(laid.from, [
      ...(bySource.get(laid.from) ?? []),
      { id: laid.id, index: outIndex, above: laid.laneY < (blockY.get(laid.from) ?? 0) },
    ]);
    byTarget.set(laid.to, [
      ...(byTarget.get(laid.to) ?? []),
      { id: laid.id, index: inIndex, above: laid.laneY < (blockY.get(laid.to) ?? 0) },
    ]);
  }
  const assign = (groups: Map<string, Item[]>, into: Map<string, number>) => {
    for (const items of groups.values()) {
      // Above the card: the lowest port travels furthest, so it goes outermost — descending
      // index. Below: the highest port travels furthest — ascending index.
      const above = items.filter((i) => i.above).sort((a, b) => b.index - a.index);
      const below = items.filter((i) => !i.above).sort((a, b) => a.index - b.index);
      above.forEach((item, rank) => into.set(item.id, rank));
      below.forEach((item, rank) => into.set(item.id, above.length + rank));
    }
  };
  assign(bySource, out);
  assign(byTarget, inn);
  return { out, in: inn };
}

/** What the map view puts into the diagram's toolbar around the shared controls. */
export interface CanvasToolbarSlots {
  toolbarLeading?: React.ReactNode;
  toolbarTitle?: React.ReactNode;
  toolbarTrailing?: React.ReactNode;
}

const nodeTypes = { block: BlockNodeView };
const edgeTypes = { routed: RoutedEdgeView };

function useBlockLayout(
  blocks: RunBlock[],
  hubIds: string[],
  preset: "default" | "compact" | "flow" | "vertical",
): BlockLayout | null {
  const [layout, setLayout] = useState<BlockLayout | null>(null);
  // The layout depends only on the process shape; a projection refresh or a selection change
  // gives new block objects with the same shape and must not lay out again (nor blank the map).
  const signature = useMemo(
    () =>
      JSON.stringify([
        preset,
        hubIds,
        blocks.map((b) => [
          b.id,
          b.index,
          b.name,
          b.description,
          b.transitions.map((t) => [t.to, t.label, Boolean(t.cycle)]),
        ]),
      ]),
    [blocks, hubIds, preset],
  );
  const laidRef = useRef<string | null>(null);
  useEffect(() => {
    if (laidRef.current === signature) return;
    let cancelled = false;
    void layoutBlocks(blocks, hubIds, { preset }).then((result) => {
      if (cancelled) return;
      laidRef.current = signature;
      setLayout(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature stands for the inputs
  }, [signature]);
  return layout;
}

function CanvasInner({
  progress,
  blocks,
  workflow,
  selectedBlockId,
  onSelectBlock,
  onFocusNode,
  onSelectListItem,
  toolbarLeading,
  toolbarTitle,
  toolbarTrailing,
}: RunViewProps & CanvasToolbarSlots): React.JSX.Element {
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const [preset] = useLayoutPreset();
  const layout = useBlockLayout(blocks, progress.process.hubs, preset);

  // The viewport opens fitted to the process, clamped to a readable zoom (a definition has no
  // "current" block). On a
  // run, once that fit is in place, the block that is active or waiting is centred at a readable
  // zoom; the fit-view control gives the overview back and the map's contents sidebar is the
  // navigation, so no minimap covers the blocks.
  const focusId = currentBlockId(blocks);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const placeViewport = useCallback(
    (rf: ReactFlowInstance<BlockNode, RoutedEdge>, blockId: string | null) => {
      if (!layout) return;
      if (!blockId) {
        // A definition: keep the fitted zoom but start at the first block with the block row in
        // the upper third, so a process wider than the viewport is read from its beginning; the
        // skip and hub channels above are reached by panning up, the returns below by panning down.
        const zoom = rf.getZoom();
        const first = layout.blocks.find((b) => b.id === blocks[0]?.id) ?? layout.blocks[0];
        if (!first) return;
        const height = wrapperRef.current?.clientHeight ?? 0;
        void rf.setViewport({
          x: CANVAS_EDGE - first.x * zoom,
          y: Math.round(height * CANVAS_ROW_ANCHOR) - first.y * zoom,
          zoom,
        });
        return;
      }
      const laid = layout.blocks.find((b) => b.id === blockId);
      if (!laid) return;
      void rf.setCenter(laid.x + laid.width / 2, laid.y + laid.height / 2 + 40, {
        zoom: 0.85,
        duration: 0,
      });
    },
    [layout, blocks],
  );
  // The opening placement (centre on the current block) runs once per laid-out process, not on
  // every projection refresh: re-placing on each render is what made the map jump to the active
  // block whenever another one was selected.
  const placementKey = layout ? `${focusId ?? "first"}:${layout.width}x${layout.height}` : null;
  const { onInit: placementInit, onReady } = useOpeningPlacement(
    placeViewport,
    placementKey as unknown as string | null,
  );
  const rfRef = useRef<ReactFlowInstance<BlockNode, RoutedEdge> | null>(null);
  // Travelling along a transition (a port or an edge clicked): the far block comes into view,
  // the edge flashes and the block pulses on arrival, so the jump answers "where did that land".
  const focus = useTransitionFocus();
  const [arrival, setArrival] = useState<{ blockId: string; token: number } | null>(null);
  useEffect(() => {
    if (!arrival) return;
    const timer = setTimeout(() => setArrival(null), 1800);
    return () => clearTimeout(timer);
  }, [arrival]);
  const goTo = useCallback(
    (blockId: string, key: string) => {
      void rfRef.current?.fitView({
        nodes: [{ id: blockId }],
        padding: 0.35,
        maxZoom: 1,
        duration: 450,
      });
      focus.flash([key]);
      setArrival((previous) => ({ blockId, token: (previous?.token ?? 0) + 1 }));
    },
    [focus],
  );
  const onInit = useCallback(
    (rf: ReactFlowInstance<BlockNode, RoutedEdge>) => {
      rfRef.current = rf;
      placementInit(rf);
    },
    [placementInit],
  );
  const allSteps = useMemo(
    () =>
      stepsOf(
        workflow,
        blocks.flatMap((b) => b.nodeIds),
      ),
    [workflow, blocks],
  );
  // The fit-to-view control: the whole process at a readable zoom when it fits, otherwise the
  // readable floor anchored at the first block, the same overview the definition opens with.
  const fitOverview = useCallback(
    (rf: ReactFlowInstance<BlockNode, RoutedEdge>) => {
      if (!layout) return;
      void rf.fitView(diagramInteractionProps("canvas").fitViewOptions).then(() => {
        const width = wrapperRef.current?.clientWidth ?? 0;
        if (layout.width * rf.getZoom() + 2 * CANVAS_EDGE > width) placeViewport(rf, null);
      });
    },
    [layout, placeViewport],
  );

  const nodes = useMemo<BlockNode[]>(() => {
    if (!layout) return [];
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const nameOf = (id: string) => {
      const b = byId.get(id);
      return b ? `${b.index + 1}. ${b.name}` : id;
    };
    const cycleTip = (transition: RunBlock["transitions"][number]) =>
      transition.cycle
        ? `\n${transition.cycle.cause}\n${t("pages.runPage.map.endsWhen")} ${transition.cycle.exit}`
        : "";
    return layout.blocks.map((laid) => {
      const block = byId.get(laid.id)!;
      const inputs: PortInfo[] = [];
      for (const other of blocks) {
        if (other.id === block.id) continue;
        for (const transition of other.transitions) {
          if (transition.to !== block.id) continue;
          inputs.push({
            id: transitionKey(other.id, transition),
            label: nameOf(other.id),
            detail: transition.label,
            kind: transition.cycle ? "return" : "forward",
            tip: `${nameOf(other.id)} → ${transition.label}${cycleTip(transition)}`,
            peer: other.id,
          });
        }
      }
      const outputs: PortInfo[] = [];
      const selfLoops: PortInfo[] = [];
      for (const transition of block.transitions) {
        const port: PortInfo = {
          id: transitionKey(block.id, transition),
          label: transition.label,
          detail: transition.to === block.id ? null : nameOf(transition.to),
          kind: transition.cycle
            ? "return"
            : layout.hubIds.includes(transition.to)
              ? "external"
              : "forward",
          tip: `${transition.label} → ${nameOf(transition.to)}${cycleTip(transition)}`,
          peer: transition.to,
        };
        (transition.to === block.id ? selfLoops : outputs).push(port);
      }
      return {
        id: laid.id,
        type: "block",
        position: { x: laid.x, y: laid.y },
        width: laid.width,
        height: laid.height,
        draggable: false,
        selectable: false,
        data: {
          block,
          selected: selectedBlockId === block.id,
          isHub: layout.hubIds.includes(block.id),
          inputs,
          outputs,
          selfLoops,
          waitingFor: progress.waitingFor,
          onSelect: onSelectBlock,
          vertical: Boolean(layout.transposed),
          steps: stepsOf(workflow, block.nodeIds),
          onFocusNode,
          onGoTo: goTo,
          arrived: arrival?.blockId === block.id,
          onSelectListItem,
        },
      };
    });
  }, [
    layout,
    blocks,
    selectedBlockId,
    onSelectBlock,
    progress.waitingFor,
    t,
    workflow,
    onFocusNode,
    goTo,
    arrival,
    onSelectListItem,
  ]);

  const edges = useMemo<RoutedEdge[]>(() => {
    if (!layout) return [];
    const ports = new Map(
      nodes.map((n) => [
        n.id,
        { outputs: n.data.outputs.map((p) => p.id), inputs: n.data.inputs.map((p) => p.id) },
      ]),
    );
    const blockY = new Map(layout.blocks.map((b) => [b.id, b.y]));
    // The column each lane edge's vertical takes beside a card. Edges reaching the card from a
    // lane above and from a lane below get disjoint column ranges; inside a range the port whose
    // horizontal is furthest from the lane takes the outermost column, so no vertical crosses
    // another port's horizontal on that side.
    const ranks = portRanks(layout.edges, ports, blockY);
    return layout.edges.map((laid) => {
      const key = transitionKey(laid.from, laid.transition);
      return {
        id: laid.id,
        source: laid.from,
        target: laid.to,
        sourceHandle: `out:${key}`,
        targetHandle: `in:${key}`,
        type: "routed",
        selectable: false,
        focusable: false,
        data: {
          laid,
          vertical: Boolean(layout.transposed),
          outRank: ranks.out.get(laid.id) ?? 0,
          inRank: ranks.in.get(laid.id) ?? 0,
          onGoTo: goTo,
        },
        // Cycles are drawn above forward edges so a loop is never hidden behind one; hub bundles
        // sit beneath everything so they read as background wiring.
        zIndex: laid.kind === "cycle" ? 1 : laid.kind === "hub" ? -1 : 0,
      };
    });
  }, [layout, nodes, goTo]);

  if (!layout) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        role="status"
        data-testid="canvas-loading"
      >
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        {t("pages.runPage.map.loading")}
      </div>
    );
  }

  // The box clips its own content: a block laid out beyond the fitted viewport must not reach
  // out of the diagram and stay hit-testable over the contents sidebar beside it.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <DiagramToolbar
        leading={toolbarLeading}
        title={toolbarTitle}
        trailing={toolbarTrailing}
        finder={<NodeFinder blocks={blocks} steps={allSteps} onPick={onSelectBlock} />}
        onZoomIn={() => void rfRef.current?.zoomIn({ duration: 200 })}
        onZoomOut={() => void rfRef.current?.zoomOut({ duration: 200 })}
        onFit={() => rfRef.current && fitOverview(rfRef.current)}
        testId="map-toolbar"
      />
      <div
        ref={wrapperRef}
        className="min-h-0 flex-1 overflow-hidden bg-muted/20"
        data-testid="canvas-view"
        data-canvas-size={`${Math.round(layout.width)}x${Math.round(layout.height)}`}
      >
        <DiagramViewport<BlockNode, RoutedEdge>
          kind="canvas"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={actualTheme}
          onInit={onInit}
          onReady={onReady}
          onFit={fitOverview}
          showControls={false}
        >
          <DiagramMarkers />
          <Background gap={24} size={1} />
        </DiagramViewport>
      </div>
    </div>
  );
}

/** The diagram alone, with its transition focus: the map view supplies the frame around it. */
export function CanvasDiagram(props: RunViewProps & CanvasToolbarSlots): React.JSX.Element {
  return (
    <TransitionFocusProvider pinnedBlock={props.selectedBlockId}>
      <CanvasInner {...props} />
    </TransitionFocusProvider>
  );
}
