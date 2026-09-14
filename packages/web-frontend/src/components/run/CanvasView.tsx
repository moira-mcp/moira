/**
 * Canvas — the process as a graph, filling the whole viewport.
 *
 * Blocks are laid out in layers that follow process direction left to right. Adjacent forward
 * transitions are elbows with their label in the gap; transitions that skip ranks travel above the
 * graph; cycles return along dashed lanes below it; and exits into a hub block (one that many
 * blocks lead to, such as "Replan" or "Stopped") are thin muted edges bundled into one port near the
 * top of the hub's left edge. Cycles, skips and hub bundles carry no label at rest: a chip inside
 * the source names each target, and hovering the chip (or the edge) lights that edge and shows its
 * label; selecting a block lights all of its connectors. Adjacent forward transitions keep their
 * label in the gap they own. Status is carried by colour, icon and a chip, so it is readable
 * without hover. The view opens fitted to the process but never below three quarters
 * size, so a dense flow opens readable and is panned; on a run it then centres on the block the
 * run is at. Gestures come from the shared `DiagramViewport`.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  Background,
  MiniMap,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { CornerDownRight, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { useOpeningPlacement } from "../diagram/placement";

/** Gutter kept between the viewport edge and the first block when a definition opens. */
const CANVAS_EDGE = 16;
/** Where the block row sits when a definition opens: this fraction of the viewport height from the top. */
const CANVAS_ROW_ANCHOR = 0.3;
import { PassCount, StatusChip, STATUS_STYLE } from "./status";
import {
  BLOCK_WIDTH,
  LABEL_MAX_WIDTH,
  layoutBlocks,
  type BlockLayout,
  type LaidOutEdge,
} from "./layout";
import { GuidanceCallout } from "./Guidance";
import { useIsMobile } from "@/hooks/use-mobile";
import { useModeGuideKey } from "../flow/editing";
import { currentBlockId, type RunBlock, type RunViewProps } from "./model";
import {
  PARALLEL_CHIP_MIN,
  canvasChipsOf,
  chipTitle,
  transitionKey,
  type TransitionChip,
} from "./chips";
import { TransitionChipView, TransitionFocusProvider, isLit, useTransitionFocus } from "./focus";

type BlockNodeData = {
  block: RunBlock;
  selected: boolean;
  isHub: boolean;
  chips: TransitionChip[];
  onSelect: (id: string | null) => void;
};
type BlockNode = Node<BlockNodeData, "block">;
type RoutedEdge = Edge<{ laid: LaidOutEdge }, "routed">;

function BlockNodeView({ data }: NodeProps<BlockNode>): React.JSX.Element {
  const { t } = useTranslation();
  const { block, selected, isHub, chips, onSelect } = data;
  const style = STATUS_STYLE[block.status];
  const endsWhen = t("pages.runPage.lanes.endsWhen");
  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <button
        type="button"
        onClick={() => onSelect(selected ? null : block.id)}
        aria-pressed={selected}
        aria-current={block.status === "active" || block.status === "waiting" ? "step" : undefined}
        style={{ width: BLOCK_WIDTH }}
        className={cn(
          "flex h-full flex-col gap-1.5 rounded-xl border-2 px-3.5 py-3 text-left transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          style.surface,
          isHub && "border-dashed",
          selected && "ring-2 ring-ring",
        )}
        data-block-id={block.id}
        data-status={block.status}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "text-sm font-semibold leading-5",
              block.status === "skipped" && "line-through decoration-muted-foreground/60",
            )}
          >
            <span className="mr-1.5 tabular-nums text-muted-foreground">{block.index + 1}.</span>
            {block.name}
          </span>
          <StatusChip status={block.status} />
        </div>
        <p className="line-clamp-3 text-xs leading-[18px] text-foreground/80">
          {block.description}
        </p>
        <div className="mt-auto flex items-end justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {t("pages.runPage.stepCount", { count: block.nodeIds.length })}
            {block.iterations > 1 && (
              <>
                {" · "}
                <PassCount iterations={block.iterations} />
              </>
            )}
          </span>
          {chips.length > 0 && (
            <span className="flex flex-wrap justify-end gap-1" data-testid="block-chips">
              {chips.map((chip) => (
                <TransitionChipView key={chip.key} chip={chip} title={chipTitle(chip, endsWhen)} />
              ))}
            </span>
          )}
        </div>
      </button>
    </>
  );
}

function RoutedEdgeView({ id, data }: EdgeProps<RoutedEdge>): React.JSX.Element | null {
  const { t } = useTranslation();
  const focus = useTransitionFocus();
  if (!data) return null;
  const { laid } = data;
  const key = transitionKey(laid.from, laid.transition);
  const lit = isLit(focus, key, laid.from);
  const cycle = laid.kind === "cycle";
  const skip = laid.kind === "skip";
  const hub = laid.kind === "hub";
  const forward = laid.kind === "forward";
  const hover = {
    onMouseEnter: () => focus.setHovered([key]),
    onMouseLeave: () => focus.setHovered(null),
  };
  const anchor =
    laid.labelAnchor === "above"
      ? `translate(-50%, -100%) translate(${laid.labelX}px, ${laid.labelY - 4}px)`
      : laid.labelAnchor === "below"
        ? `translate(-50%, 0) translate(${laid.labelX}px, ${laid.labelY}px)`
        : `translate(-50%, -50%) translate(${laid.labelX}px, ${laid.labelY}px)`;
  const title = cycle
    ? `${laid.transition.label} — ${laid.transition.cycle?.cause} — ${t("pages.runPage.lanes.endsWhen")} ${laid.transition.cycle?.exit}`
    : laid.transition.label;
  // Adjacent forward transitions own the gap between their blocks and keep their label there —
  // unless several share one gap, when a chip in the source names them and the lines are
  // labelled on demand; every other kind is muted at rest and labelled on demand.
  const bundled = forward && (laid.parallelCount ?? 1) >= PARALLEL_CHIP_MIN;
  const showLabel = (forward && !bundled) || lit;
  return (
    <>
      <g {...hover} style={{ cursor: "default" }}>
        <title>{title}</title>
        <BaseEdge
          id={id}
          path={laid.path}
          markerEnd={
            cycle
              ? lit
                ? "url(#run-arrow-cycle)"
                : "url(#run-arrow-cycle-muted)"
              : hub
                ? "url(#run-arrow-hub)"
                : "url(#run-arrow)"
          }
          interactionWidth={14}
          style={{
            stroke: cycle ? "var(--primary)" : hub ? "var(--muted-foreground)" : "var(--border)",
            strokeWidth: forward ? 2.5 : lit ? 2 : hub ? 1.25 : 1.5,
            strokeOpacity: forward ? 1 : lit ? 1 : hub ? 0.45 : 0.5,
            strokeDasharray: cycle ? "6 5" : skip ? "2 4" : undefined,
          }}
          data-edge-kind={laid.kind}
          data-transition={key}
          data-focused={lit ? "true" : undefined}
        />
      </g>
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className={cn(
              "nodrag nopan absolute inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
              forward && "truncate",
              lit && "z-10 shadow-sm",
              cycle
                ? "border-primary/40 bg-background text-primary"
                : "border-border bg-background text-muted-foreground",
            )}
            style={{ transform: anchor, maxWidth: forward ? LABEL_MAX_WIDTH : undefined }}
            data-edge-label={laid.kind}
            data-transition={key}
            title={title}
          >
            {cycle && <RotateCcw className="size-3 shrink-0" aria-hidden="true" />}
            {skip && <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />}
            {laid.transition.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { block: BlockNodeView };
const edgeTypes = { routed: RoutedEdgeView };

function useBlockLayout(blocks: RunBlock[], hubIds: string[]): BlockLayout | null {
  const [layout, setLayout] = useState<BlockLayout | null>(null);
  useEffect(() => {
    let cancelled = false;
    void layoutBlocks(blocks, hubIds).then((result) => {
      if (!cancelled) setLayout(result);
    });
    return () => {
      cancelled = true;
    };
  }, [blocks, hubIds]);
  return layout;
}

function CanvasInner({
  progress,
  blocks,
  selectedBlockId,
  onSelectBlock,
}: RunViewProps): React.JSX.Element {
  // A phone has no room for the minimap beside the blocks.
  const mobile = useIsMobile();
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const layout = useBlockLayout(blocks, progress.process.hubs);

  // The viewport opens fitted to the process, clamped to a readable zoom (a definition has no
  // "current" block). On a
  // run, once that fit is in place, the block that is active or waiting is centred at a readable
  // zoom; the fit-view control and the minimap give the overview back.
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
  const { onInit, onReady } = useOpeningPlacement(placeViewport, focusId);

  const nodes = useMemo<BlockNode[]>(
    () =>
      (layout?.blocks ?? []).map((laid) => {
        const block = blocks.find((b) => b.id === laid.id)!;
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
            isHub: layout!.hubIds.includes(block.id),
            chips: canvasChipsOf(block, layout!.hubIds, blocks),
            onSelect: onSelectBlock,
          },
        };
      }),
    [layout, blocks, selectedBlockId, onSelectBlock],
  );

  const edges = useMemo<RoutedEdge[]>(
    () =>
      (layout?.edges ?? []).map((laid) => ({
        id: laid.id,
        source: laid.from,
        target: laid.to,
        type: "routed",
        selectable: false,
        focusable: false,
        data: { laid },
        // Cycles are drawn above forward edges so a loop is never hidden behind one; hub bundles
        // sit beneath everything so they read as background wiring.
        zIndex: laid.kind === "cycle" ? 1 : laid.kind === "hub" ? -1 : 0,
      })),
    [layout],
  );

  if (!layout) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        role="status"
        data-testid="canvas-loading"
      >
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        {t("pages.runPage.canvas.loading")}
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="h-full w-full bg-muted/20"
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
      >
        <svg aria-hidden="true">
          <defs>
            <marker
              id="run-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)" />
            </marker>
            <marker
              id="run-arrow-hub"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
            </marker>
            <marker
              id="run-arrow-cycle"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
            </marker>
            <marker
              id="run-arrow-cycle-muted"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" fillOpacity={0.5} />
            </marker>
          </defs>
        </svg>
        <Background gap={24} size={1} />
        {!mobile && <MiniMap pannable zoomable className="!bg-card" />}
      </DiagramViewport>
    </div>
  );
}

export function CanvasView(props: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3">
        <GuidanceCallout
          title={t(`${guideKey}.canvas.title`)}
          testId="guidance-canvas"
          className="mb-3"
        >
          {t(`${guideKey}.canvas.body`)}
        </GuidanceCallout>
      </div>
      <div className="min-h-0 flex-1">
        <TransitionFocusProvider pinnedBlock={props.selectedBlockId}>
          <CanvasInner {...props} />
        </TransitionFocusProvider>
      </div>
    </div>
  );
}
