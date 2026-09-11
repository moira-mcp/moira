/**
 * Canvas variant — the process as a graph.
 *
 * Blocks are laid out in layers that follow process direction left to right. Adjacent forward
 * transitions are elbows with their label in the gap; transitions that skip ranks travel above the
 * graph; cycles return along dashed lanes below it; and exits into a hub block (one that many
 * blocks lead to, such as "Replan" or "Stopped") are shown as chips inside the block instead of as
 * edges, the way process diagrams use off-page connectors. Status is carried by colour, icon and a
 * chip, so it is readable without hover. The view opens centred on the block the run is at.
 */

import React, { useEffect, useMemo } from "react";
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
import { ArrowUpRight, CornerDownRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { StatusChip, STATUS_STYLE } from "../shared/status";
import { BLOCK_WIDTH, layoutBlocks, type LaidOutEdge } from "../shared/blockLayout";
import { type VariantProps } from "../shared/BlockCards";
import { EditableText, TransitionEditor } from "../shared/EditControls";
import { GuidanceCallout } from "../shared/Guidance";
import { useEditing } from "../editing";
import { runStateOf, type BlockRunState, type ProcessBlock, type Transition } from "../model";

type BlockNodeData = {
  index: number;
  block: ProcessBlock;
  state: BlockRunState;
  selected: boolean;
  isHub: boolean;
  exits: Array<{ transition: Transition; targetName: string }>;
  onSelect: (id: string | null) => void;
};
type BlockNode = Node<BlockNodeData, "block">;
type RoutedEdge = Edge<{ laid: LaidOutEdge }, "routed">;

function BlockNodeView({ data }: NodeProps<BlockNode>): React.JSX.Element {
  const { block, state, index, selected, isHub, exits, onSelect } = data;
  const style = STATUS_STYLE[state.status];
  const editing = useEditing();
  // While authoring, the block holds inputs, so it is a region rather than a button.
  const Outer: "button" | "div" = editing.enabled ? "div" : "button";
  return (
    <>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <Handle type="source" position={Position.Right} className="!opacity-0" />
      <Outer
        {...(editing.enabled ? { role: "group" } : { type: "button" as const })}
        onClick={() => !editing.enabled && onSelect(selected ? null : block.id)}
        aria-pressed={selected}
        aria-current={state.status === "active" ? "step" : undefined}
        style={{ width: BLOCK_WIDTH }}
        className={cn(
          "flex h-full flex-col gap-1.5 rounded-xl border-2 px-3.5 py-3 text-left shadow-sm transition",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          style.surface,
          isHub && "border-dashed",
          selected && "ring-2 ring-ring",
        )}
        data-block-id={block.id}
        data-status={state.status}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-semibold leading-5">
            <span className="mr-1.5 tabular-nums text-muted-foreground">{index + 1}.</span>
            <EditableText
              value={block.name}
              onChange={(v) => editing.setBlock(block.id, { label: v })}
              inputClassName="h-7 text-sm"
              testId={`canvas-edit-name-${block.id}`}
            />
          </span>
          <StatusChip state={state} />
        </div>
        <p
          className={cn(
            "text-xs leading-[18px] text-foreground/80",
            !editing.enabled && "line-clamp-3",
          )}
        >
          <EditableText
            value={block.description}
            onChange={(v) => editing.setBlock(block.id, { summary: v })}
            multiline
            inputClassName="min-h-[56px] text-xs"
            testId={`canvas-edit-description-${block.id}`}
          />
        </p>
        {state.note && <p className="text-[11px] text-muted-foreground">{state.note}</p>}
        <div className="mt-auto flex items-end justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {block.nodeIds.length} {block.nodeIds.length === 1 ? "node" : "nodes"}
          </span>
          {exits.length > 0 && (
            <span className="flex flex-wrap justify-end gap-1">
              {exits.map(({ transition, targetName }) => (
                <span
                  key={`${transition.to}-${transition.label}`}
                  className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border bg-background px-1.5 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground"
                  title={transition.label}
                >
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                  {targetName}
                </span>
              ))}
            </span>
          )}
        </div>
      </Outer>
    </>
  );
}

function RoutedEdgeView({ id, data }: EdgeProps<RoutedEdge>): React.JSX.Element | null {
  if (!data) return null;
  const { laid } = data;
  const cycle = laid.kind === "cycle";
  const skip = laid.kind === "skip";
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
        markerEnd={cycle ? "url(#pv-arrow-cycle)" : "url(#pv-arrow)"}
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
              ? `${laid.transition.cycle?.cause} — ends when: ${laid.transition.cycle?.exit}`
              : laid.transition.label
          }
        >
          {cycle && <RotateCcw className="size-3 shrink-0" aria-hidden="true" />}
          {skip && <CornerDownRight className="size-3 shrink-0" aria-hidden="true" />}
          {laid.transition.label}
          <TransitionEditor transition={laid.transition} className="ml-0.5 size-4" />
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { block: BlockNodeView };
const edgeTypes = { routed: RoutedEdgeView };

function CanvasInner({
  projection,
  selectedBlockId,
  onSelectBlock,
}: VariantProps): React.JSX.Element {
  const { actualTheme } = useTheme();
  const { setCenter } = useReactFlow();
  const editing = useEditing();
  const layout = useMemo(
    () => layoutBlocks(projection, { extraHeight: editing.enabled ? 64 : 0 }),
    [projection, editing.enabled],
  );
  const nameOf = useMemo(() => new Map(projection.blocks.map((b) => [b.id, b.name])), [projection]);

  // Open on "where is this run now" at a readable zoom rather than a shrunk overview: the block
  // that is active or waiting is centred; the fit-view control and the minimap give the overview.
  useEffect(() => {
    const focusId =
      projection.blocks.find((b) => {
        const s = runStateOf(projection, b.id).status;
        return s === "active" || s === "waiting";
      })?.id ?? projection.blocks[0]?.id;
    const laid = layout.blocks.find((b) => b.id === focusId);
    if (!laid) return;
    void setCenter(laid.x + laid.width / 2, laid.y + laid.height / 2 + 40, {
      zoom: 0.85,
      duration: 0,
    });
  }, [layout, projection, setCenter]);

  const nodes = useMemo<BlockNode[]>(
    () =>
      layout.blocks.map((laid, index) => {
        const block = projection.blocks[index];
        return {
          id: laid.id,
          type: "block",
          position: { x: laid.x, y: laid.y },
          width: laid.width,
          height: laid.height,
          draggable: false,
          selectable: false,
          data: {
            index,
            block,
            state: runStateOf(projection, block.id),
            selected: selectedBlockId === block.id,
            isHub: layout.hubIds.includes(block.id),
            exits: laid.exits.map((transition) => ({
              transition,
              targetName: nameOf.get(transition.to) ?? transition.to,
            })),
            onSelect: onSelectBlock,
          },
        };
      }),
    [layout, projection, selectedBlockId, onSelectBlock, nameOf],
  );

  const edges = useMemo<RoutedEdge[]>(
    () =>
      layout.edges.map((laid) => ({
        id: laid.id,
        source: laid.from,
        target: laid.to,
        type: "routed",
        selectable: false,
        focusable: false,
        data: { laid },
        // Cycles are drawn above forward edges so a loop is never hidden behind one.
        zIndex: laid.kind === "cycle" ? 1 : 0,
      })),
    [layout],
  );

  return (
    <div
      className="h-[560px] overflow-hidden rounded-xl border bg-muted/20"
      data-canvas-size={`${Math.round(layout.width)}x${Math.round(layout.height)}`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={actualTheme}
        minZoom={0.25}
        maxZoom={1.5}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <svg aria-hidden="true">
          <defs>
            <marker
              id="pv-arrow"
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
              id="pv-arrow-cycle"
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

export function CanvasView(props: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ReactFlowProvider>
      <GuidanceCallout
        title={t("pages.processViewPrototype.modeGuide.canvas.title")}
        testId="guidance-canvas"
        className="mb-3"
      >
        {t("pages.processViewPrototype.modeGuide.canvas.body")}
      </GuidanceCallout>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
