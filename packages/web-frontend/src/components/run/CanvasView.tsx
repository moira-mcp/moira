/**
 * Canvas — the process as a graph, filling the whole viewport.
 *
 * Blocks are laid out in layers that follow process direction left to right. Adjacent forward
 * transitions are elbows with their label in the gap; transitions that skip ranks travel above the
 * graph; cycles return along dashed lanes below it; and exits into a hub block (one that many
 * blocks lead to, such as "Replan" or "Stopped") are thin muted edges bundled into one port near the
 * top of the hub's left edge; a chip inside the source names the hub (the transition label is its
 * tooltip) rather than a label on the line. Status is carried by colour, icon and a chip, so it is
 * readable without hover. The view opens centred on the block the run is at.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowUpRight, CornerDownRight, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { StatusChip, STATUS_STYLE } from "./status";
import { BLOCK_WIDTH, layoutBlocks, type BlockLayout, type LaidOutEdge } from "./layout";
import { GuidanceCallout } from "./Guidance";
import { useModeGuideKey } from "../flow/editing";
import { currentBlockId, type RunBlock, type RunTransition, type RunViewProps } from "./model";

type BlockNodeData = {
  block: RunBlock;
  selected: boolean;
  isHub: boolean;
  exits: Array<{ transition: RunTransition; targetName: string }>;
  onSelect: (id: string | null) => void;
};
type BlockNode = Node<BlockNodeData, "block">;
type RoutedEdge = Edge<{ laid: LaidOutEdge }, "routed">;

function BlockNodeView({ data }: NodeProps<BlockNode>): React.JSX.Element {
  const { t } = useTranslation();
  const { block, selected, isHub, exits, onSelect } = data;
  const style = STATUS_STYLE[block.status];
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
          "flex h-full flex-col gap-1.5 rounded-xl border-2 px-3.5 py-3 text-left shadow-sm transition",
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
          <StatusChip status={block.status} iterations={block.iterations} />
        </div>
        <p className="line-clamp-3 text-xs leading-[18px] text-foreground/80">
          {block.description}
        </p>
        <div className="mt-auto flex items-end justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {t("pages.runPage.stepCount", { count: block.nodeIds.length })}
          </span>
          {exits.length > 0 && (
            <span className="flex flex-wrap justify-end gap-1">
              {exits.map(({ transition, targetName }) => (
                <span
                  key={`${transition.to}-${transition.label}`}
                  className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground"
                  title={transition.label}
                  data-exit-chip={transition.to}
                >
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                  {targetName}
                </span>
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
  if (!data) return null;
  const { laid } = data;
  const cycle = laid.kind === "cycle";
  const skip = laid.kind === "skip";
  if (laid.kind === "hub") {
    // A bundle into a hub: muted, thinner, no label on the line; the source's exit chips name it.
    return (
      <BaseEdge
        id={id}
        path={laid.path}
        markerEnd="url(#run-arrow-hub)"
        style={{ stroke: "var(--muted-foreground)", strokeWidth: 1.5, opacity: 0.45 }}
        interactionWidth={0}
        data-edge-kind="hub"
      />
    );
  }
  const anchor =
    laid.labelAnchor === "above"
      ? `translate(-50%, -100%) translate(${laid.labelX}px, ${laid.labelY - 4}px)`
      : laid.labelAnchor === "below"
        ? `translate(-50%, 0) translate(${laid.labelX}px, ${laid.labelY}px)`
        : `translate(-50%, -50%) translate(${laid.labelX}px, ${laid.labelY}px)`;
  return (
    <>
      <BaseEdge
        id={id}
        path={laid.path}
        markerEnd={cycle ? "url(#run-arrow-cycle)" : "url(#run-arrow)"}
        style={{
          stroke: cycle ? "var(--primary)" : "var(--border)",
          strokeWidth: cycle ? 2 : 2.5,
          strokeDasharray: cycle ? "6 5" : skip ? "2 4" : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <span
          className={cn(
            "nodrag nopan absolute inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm",
            laid.kind === "forward" && "max-w-[136px] truncate",
            cycle
              ? "border-primary/40 bg-background text-primary"
              : "border-border bg-background text-muted-foreground",
          )}
          style={{ transform: anchor }}
          data-edge-kind={laid.kind}
          title={
            cycle
              ? `${laid.transition.cycle?.cause} — ${t("pages.runPage.lanes.endsWhen")} ${laid.transition.cycle?.exit}`
              : laid.transition.label
          }
        >
          {cycle && <RotateCcw className="size-3 shrink-0" aria-hidden="true" />}
          {skip && <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />}
          {laid.transition.label}
        </span>
      </EdgeLabelRenderer>
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
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const { setCenter } = useReactFlow();
  const layout = useBlockLayout(blocks, progress.process.hubs);
  const nameOf = useMemo(() => new Map(blocks.map((b) => [b.id, b.name])), [blocks]);

  // Open on "where is this run now" at a readable zoom rather than a shrunk overview: the block
  // that is active or waiting is centred; the fit-view control and the minimap give the overview.
  useEffect(() => {
    if (!layout) return;
    const focusId = currentBlockId(blocks) ?? blocks[0]?.id;
    const laid = layout.blocks.find((b) => b.id === focusId);
    if (!laid) return;
    void setCenter(laid.x + laid.width / 2, laid.y + laid.height / 2 + 40, {
      zoom: 0.85,
      duration: 0,
    });
  }, [layout, blocks, setCenter]);

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
            exits: laid.exits.map((transition) => ({
              transition,
              targetName: nameOf.get(transition.to) ?? transition.to,
            })),
            onSelect: onSelectBlock,
          },
        };
      }),
    [layout, blocks, selectedBlockId, onSelectBlock, nameOf],
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
      className="h-full w-full bg-muted/20"
      data-testid="canvas-view"
      data-canvas-size={`${Math.round(layout.width)}x${Math.round(layout.height)}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={actualTheme}
        minZoom={0.2}
        maxZoom={1.5}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
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
          </defs>
        </svg>
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
    </div>
  );
}

export function CanvasView(props: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  return (
    <ReactFlowProvider>
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
          <CanvasInner {...props} />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
