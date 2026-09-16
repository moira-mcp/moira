/* eslint-disable no-console */
/**
 * Unified Workflow Graph Component
 *
 * Single source of truth for workflow visualization across the application.
 * Replaces both WorkflowCanvas and WorkflowViewerPlaceholder.
 *
 * The detailed layer of the process view: every node is the shared step card, grouped inside a
 * tinted block group in process order (ELK layered, top to bottom or left to right), forward
 * connections labelled, returns dashed in the primary colour and labelled on demand through the
 * same focus the lanes and canvas use.
 *
 * Features:
 * - Accepts raw WorkflowGraph data; node data (validation, catalog) still comes from the
 *   transformer, the step facts from the process-view model (`graphModel`)
 * - Mounts through the shared DiagramViewport (gesture pan, pinch zoom, zoom/fit cluster)
 * - Layout controls (Fit View, Vertical, Horizontal) driving the instance received on init
 * - Current node and error node highlighting for execution views
 * - Theme-aware styling (dark/light mode)
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  MiniMap,
  Node,
  Edge,
  ConnectionMode,
  ControlButton,
  SelectionMode,
  type ReactFlowInstance as XyflowInstance,
} from "@xyflow/react";
import { ZoomIn, ArrowUpDown, ArrowLeftRight } from "lucide-react";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { useOpeningPlacement } from "../diagram/placement";

import { graphModel, definitionBlocks } from "../run/graphModel";
import { GRAPH_MARGIN, layoutGraph } from "./graphLayout";
import {
  BlockGroupView,
  GraphDefs,
  GraphMeasuredHeights,
  GraphEdgeView,
  StepNodeView,
  type BlockGroupData,
  type BlockGroupNode,
  type GraphEdge,
  type StepNode,
  type StepNodeData,
} from "./graphNodes";
import { TransitionFocusProvider } from "../run/focus";
import { VariableProvider, type VariableDefinition } from "../diagram/VariableText";
import { outputTip } from "./graphNodes";
import type { PortInfo } from "../diagram/PortedCard";
import type { RunBlock } from "../run/model";
import { NodeDetailSheet } from "./NodeDetailSheet";

import { useTheme } from "../../hooks/useTheme";
import { useIsMobile } from "@/hooks/use-mobile";
import { WorkflowTransformer } from "../../utils/workflow-transformer";
import {
  WorkflowGraph as WorkflowGraphType,
  LayoutOptions,
  DEFAULT_LAYOUT_OPTIONS,
  WorkflowValidationStatus,
} from "../../types";
import { useTranslation } from "react-i18next";
import { useNodeTypes } from "../../hooks/useNodeTypes";

// Every authored type renders the same step node; the per-type registration keeps React Flow's
// `react-flow__node-<type>` class, which the node-type catalog and the graph specs rely on.
const nodeTypes = {
  start: StepNodeView,
  "agent-directive": StepNodeView,
  agentDirective: StepNodeView,
  condition: StepNodeView,
  "telegram-notification": StepNodeView,
  "user-notification": StepNodeView,
  telegram: StepNodeView,
  subgraph: StepNodeView,
  expression: StepNodeView,
  "read-note": StepNodeView,
  "write-note": StepNodeView,
  "upsert-note": StepNodeView,
  materialize: StepNodeView,
  teleport: StepNodeView,
  lock: StepNodeView,
  end: StepNodeView,
  // A type Moira knows and this bundle has no dedicated rendering for; drawn from the catalog.
  catalog: StepNodeView,
  fallback: StepNodeView,
  "block-group": BlockGroupView,
};

const edgeTypes = { graph: GraphEdgeView };

// Empty array constant to avoid creating new array on each render
const EMPTY_ERROR_NODE_IDS: string[] = [];
const noopEdgeClick = (): void => {};
/** A grouped graph opens at least this readable, on its first block. */
const GRAPH_OPENING_ZOOM = 0.7;
const GRAPH_OPENING_EDGE = 16;

/** ReactFlow instance interface for external control */
export interface ReactFlowInstance {
  fitView: (options?: { nodes?: { id: string }[]; padding?: number; duration?: number }) => void;
  getNodes: () => Node[];
  getEdges: () => Edge[];
}

export interface WorkflowGraphProps {
  /** Raw workflow data - will be transformed internally */
  workflow: WorkflowGraphType;
  /** Optional validation status */
  validation?: WorkflowValidationStatus;
  /** Current node ID for execution highlighting */
  currentNodeId?: string | null;
  /** The block the page has selected on the map: its frame is highlighted on the graph. */
  selectedBlockId?: string | null;
  /** Node IDs that have runtime errors (for error highlighting) */
  errorNodeIds?: string[];
  /**
   * The process blocks to group the nodes by (a run's blocks carry their status); derived from
   * the definition when absent.
   */
  blocks?: RunBlock[];
  /** Layout options */
  layoutOptions?: LayoutOptions;
  /** Node click handler */
  onNodeClick?: (event: React.MouseEvent, node: Node) => void;
  /** Handler for navigating to another workflow (subgraph) */
  onWorkflowNavigate?: (workflowId: string) => void;
  /** Additional CSS class */
  className?: string;
  /** Show layout control buttons */
  showControls?: boolean;
  /** Show minimap */
  showMinimap?: boolean;
  /** Show node detail sheet on click (default: true for standalone, false for execution views) */
  showNodeDetails?: boolean;
  /** Callback when a node is selected (for external sidebar) */
  onNodeSelect?: (
    node: Node | null,
    connections: {
      incoming: Array<{ id: string; label: string }>;
      outgoing: Array<{ id: string; label: string; connectionType: string }>;
    },
  ) => void;
  /** Callback when ReactFlow instance is initialized - used for external control like focusOnNode */
  onInit?: (instance: ReactFlowInstance) => void;
  /**
   * A node to bring into view (a step chosen in a list, the toolbar's current node); the token
   * makes the same node focusable twice. It takes over the opening placement while set.
   */
  focusRequest?: { nodeId: string; token: number } | null;
  /** Jump to a variable's definition when a reference token is clicked. */
  onVariableSelect?: (name: string) => void;
  /** The variable whose references are emphasised. */
  selectedVariable?: string | null;
}

/**
 * Usage:
 * ```tsx
 * // Basic usage with raw workflow data
 * <WorkflowGraph workflow={workflowData} />
 *
 * // With execution highlighting
 * <WorkflowGraph
 *   workflow={workflowData}
 *   currentNodeId={execution.currentNodeId}
 *   onNodeClick={handleNodeClick}
 * />
 *
 * // Minimal view without controls
 * <WorkflowGraph
 *   workflow={workflowData}
 *   showControls={false}
 *   showMinimap={false}
 * />
 * ```
 */
export const WorkflowGraph: React.FC<WorkflowGraphProps> = ({
  workflow,
  validation,
  currentNodeId,
  selectedBlockId = null,
  errorNodeIds = EMPTY_ERROR_NODE_IDS,
  blocks,
  layoutOptions = DEFAULT_LAYOUT_OPTIONS,
  onNodeClick,
  onWorkflowNavigate,
  className = "",
  showControls = true,
  showMinimap = true,
  showNodeDetails = true,
  onNodeSelect,
  onInit,
  focusRequest = null,
  onVariableSelect,
  selectedVariable = null,
}) => {
  // A connection chip names its other end the way the map does: the authored display name, else
  // the node id. The technical graph's `data.label` falls back to the node type ("Agent Task"),
  // which names nothing when three chips lead to three different agent nodes.
  const nodeName = useCallback(
    (nodeId: string): string =>
      workflow.nodes.find((n) => n.id === nodeId)?.metadata?.displayName || nodeId,
    [workflow.nodes],
  );
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const { actualTheme } = useTheme();
  // The React Flow instance arrives through the viewport's init callback; the layout effects and
  // the control panel drive fitView through this ref rather than a hook, so the graph does not
  // need a provider of its own around it.
  const instanceRef = useRef<XyflowInstance | null>(null);
  /** The last layout's block groups, read by the opening placement. */
  const groupsRef = useRef<{ id: string; x: number; y: number }[]>([]);
  /**
   * The opening placement, applied on top of the viewport's own fit once it reports ready and
   * again when what it follows changes: a requested node, else a run's current node, is brought
   * into view; a definition opens readable on its first block (the fit-view control gives the
   * overview back), as the canvas does. The key carries the node and a tag (the request token or
   * `current`) so a repeated request places again.
   */
  // The layout runs a second time with the heights the browser measured when a card is taller
  // than its estimate (a long summary, wrapped chips); the placement is applied again after it.
  const [measuredHeights, setMeasuredHeights] = useState<Map<string, number> | null>(null);
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  const laidHeightsRef = useRef<Map<string, number>>(new Map());
  // The room the current layout left before the first group; the opening view keeps a third of it.
  const marginRef = useRef<number>(GRAPH_MARGIN);
  const placementKey = `${layoutGeneration}|${
    focusRequest
      ? `node:${focusRequest.token}:${focusRequest.nodeId}`
      : currentNodeId
        ? `node:current:${currentNodeId}`
        : "first"
  }`;
  const placeViewport = useCallback((instance: XyflowInstance, generationKey: string) => {
    const key = generationKey.slice(generationKey.indexOf("|") + 1);
    // A frame later: a placement after a relayout must see the nodes' new positions.
    window.requestAnimationFrame(() => {
      if (key.startsWith("node:")) {
        const nodeId = key.slice(key.indexOf(":", 5) + 1);
        void instance.fitView({ nodes: [{ id: nodeId }], padding: 0.5, maxZoom: 1, duration: 0 });
        return;
      }
      const first = groupsRef.current[0];
      if (!first) return;
      const zoom = Math.max(GRAPH_OPENING_ZOOM, instance.getZoom());
      // The margin before the first group holds the return lanes; a third of it stays in view.
      void instance.setViewport({
        x: GRAPH_OPENING_EDGE - (first.x - marginRef.current / 3) * zoom,
        y: GRAPH_OPENING_EDGE - (first.y - marginRef.current / 3) * zoom,
        zoom,
      });
    });
  }, []);
  const { onInit: placementInit, onReady: placementReady } = useOpeningPlacement<
    Node,
    Edge,
    string
  >(placeViewport, placementKey);
  /** Brings a step into view: what an arrival chip does when the reader clicks the far end. */
  const focusStep = useCallback((id: string) => {
    void instanceRef.current?.fitView({ nodes: [{ id }], padding: 0.5, maxZoom: 1, duration: 400 });
  }, []);
  const handleMeasured = useCallback((heights: Map<string, number>) => {
    // Cards taller or shorter than laid out: lay out again with what the browser measured.
    let differs = false;
    for (const [id, height] of heights) {
      if (Math.abs(height - (laidHeightsRef.current.get(id) ?? 0)) > 2) differs = true;
    }
    if (differs) setMeasuredHeights(heights);
  }, []);
  const handleInit = useCallback(
    (instance: XyflowInstance) => {
      instanceRef.current = instance;
      placementInit(instance);
      onInit?.({
        fitView: instance.fitView,
        getNodes: instance.getNodes,
        getEdges: instance.getEdges,
      });
    },
    [onInit, placementInit],
  );

  // Use regular useState instead of useNodesState/useEdgesState for read-only view
  // This avoids zustand store subscriptions that cause continuous re-renders
  const [laidNodes, setLaidNodes] = useState<Node[]>([]);
  /** The direction of the last laid-out graph: a change refits to the whole graph. */
  const laidDirectionRef = useRef<string | null>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  // True until the first layout has produced nodes, so the viewport mounts once, with them, and
  // the instance a caller receives on init is the one that holds the graph.
  const [isLayouting, setIsLayouting] = useState(true);

  // What changes without a relayout — the current node, the selected block, the error nodes and
  // the navigation callback — is merged into the laid-out nodes here, so a page re-render or a
  // run advancing never lays the graph out again (and never refits it under the reader).
  const nodes = useMemo<Node[]>(() => {
    const errorNodeIdSet = new Set(errorNodeIds);
    return laidNodes.map((node) =>
      node.type === "block-group"
        ? {
            ...node,
            data: {
              ...node.data,
              selected: (node.data as BlockGroupData).blockId === selectedBlockId,
            },
          }
        : {
            ...node,
            data: {
              ...node.data,
              onWorkflowNavigate,
              current: node.id === currentNodeId,
              error: errorNodeIdSet.has(node.id),
            },
            selected: node.id === currentNodeId,
          },
    );
  }, [laidNodes, currentNodeId, selectedBlockId, errorNodeIds, onWorkflowNavigate]);
  const [currentLayoutOptions, setCurrentLayoutOptions] = useState(layoutOptions);

  // Node detail sheet state
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);
  const [selectedNodeData, setSelectedNodeData] = useState<Node | null>(null);

  // Performance optimization: delayed MiniMap render
  const [showMiniMapDelayed, setShowMiniMapDelayed] = useState(false);

  // Throttle ref for layout changes
  const layoutThrottleRef = useRef<NodeJS.Timeout | null>(null);
  const LAYOUT_THROTTLE_MS = 100;

  // Calculate incoming and outgoing nodes for the selected node
  const { incomingNodes, outgoingNodes } = useMemo(() => {
    if (!selectedNodeData || edges.length === 0) {
      return { incomingNodes: [], outgoingNodes: [] };
    }

    const nodeId = selectedNodeData.id;

    // Find edges where this node is the target (incoming)
    const incoming = edges
      .filter((e) => e.target === nodeId)
      .map((e) => {
        return { id: e.source, label: nodeName(e.source) };
      });

    // Find edges where this node is the source (outgoing)
    const outgoing = edges
      .filter((e) => e.source === nodeId)
      .map((e) => {
        const edgeData = e.data as { link?: { label: string } } | undefined;
        return {
          id: e.target,
          label: nodeName(e.target),
          connectionType: edgeData?.link?.label ?? "default",
        };
      });

    return { incomingNodes: incoming, outgoingNodes: outgoing };
  }, [selectedNodeData, edges, nodeName]);

  // Theme colors
  const backgroundColor = actualTheme === "dark" ? "#1a1a1a" : "#FAFBFC";
  const backgroundPatternColor = actualTheme === "dark" ? "#333333" : "#E5E7EB";

  // Delay MiniMap render for better initial load performance
  useEffect(() => {
    if (showMinimap && !showMiniMapDelayed) {
      // Use requestIdleCallback if available, fallback to setTimeout
      if ("requestIdleCallback" in window) {
        const idleId = window.requestIdleCallback(() => setShowMiniMapDelayed(true), {
          timeout: 500,
        });
        return () => window.cancelIdleCallback(idleId);
      } else {
        const timeoutId = setTimeout(() => setShowMiniMapDelayed(true), 200);
        return () => clearTimeout(timeoutId);
      }
    }
  }, [showMinimap, showMiniMapDelayed]);

  // What Moira knows about node types; a node whose type this bundle has no branch for is drawn
  // from this instead of being reported as unknown.
  const {
    catalog: nodeTypeCatalog,
    index: nodeTypeIndex,
    loading: nodeTypesLoading,
  } = useNodeTypes();

  // Per-node presentation data (validation, catalog styling); positions come from `layoutGraph`,
  // so the transformer's own layout pass is skipped.
  const visualizationData = useMemo(() => {
    if (!workflow || nodeTypesLoading) return null;
    return WorkflowTransformer.transformWorkflow(
      workflow,
      validation,
      { ...DEFAULT_LAYOUT_OPTIONS, algorithm: "manual" },
      nodeTypeIndex,
      nodeTypeCatalog?.extensionsAvailable ?? false,
    );
  }, [workflow, validation, nodeTypesLoading, nodeTypeIndex, nodeTypeCatalog?.extensionsAvailable]);

  // The process the graph is grouped by: the caller's blocks (a run's, with status) or the
  // definition's own derivation.
  const graphBlocks = useMemo(() => blocks ?? definitionBlocks(workflow), [blocks, workflow]);
  const model = useMemo(() => graphModel(workflow, graphBlocks), [workflow, graphBlocks]);

  /**
   * Lay the model out (asynchronously, through ELK) whenever it or the direction changes, then
   * build the React Flow nodes: one group per block, one step node per workflow node carrying
   * the transformer's data (validation, catalog) beside the process-view step.
   */
  useEffect(() => {
    if (!visualizationData) {
      setLaidNodes([]);
      setEdges([]);
      return;
    }
    let cancelled = false;
    const horizontal =
      currentLayoutOptions.direction === "LR" || currentLayoutOptions.direction === "RL";
    setIsLayouting(true);
    void layoutGraph(model, horizontal ? "RIGHT" : "DOWN", measuredHeights ?? undefined)
      .then((layout) => {
        if (cancelled) return;
        laidHeightsRef.current = new Map(layout.steps.map((step) => [step.id, step.height]));
        setLayoutGeneration((generation) => generation + 1);
        const transformed = new Map(visualizationData.nodes.map((n) => [n.id, n]));
        const blockById = new Map(graphBlocks.map((b) => [b.id, b]));
        const groupNodes: BlockGroupNode[] = layout.groups.map((group) => {
          const block = blockById.get(group.id)!;
          return {
            id: `block:${group.id}`,
            type: "block-group",
            position: { x: group.x, y: group.y },
            // The frame is not interactive and must not sit between the pointer and the edges.
            style: { width: group.width, height: group.height, pointerEvents: "none" },
            draggable: false,
            selectable: false,
            focusable: false,
            zIndex: -1,
            data: { blockId: block.id, index: block.index, name: block.name, status: block.status },
          };
        });
        const stepById = new Map(model.steps.map((s) => [s.id, s]));
        // One port per edge on each side of a card: an input port names where the edge comes
        // from and its transition, an output port names the output and its target; an edge from
        // a card to itself takes the bottom double port.
        const blockNameOf = new Map(graphBlocks.map((b) => [b.id, b.name]));
        const blockOfStep = new Map(
          graphBlocks.flatMap((b) => b.nodeIds.map((id) => [id, b.id] as const)),
        );
        const nameOfStep = (id: string) => {
          const step = stepById.get(id)?.step;
          return step?.progressLabel ?? step?.displayName ?? id;
        };
        const inputsOf = new Map<string, PortInfo[]>();
        const outputsOf = new Map<string, PortInfo[]>();
        const selfOf = new Map<string, PortInfo[]>();
        for (const link of model.links) {
          const source = stepById.get(link.source);
          const sourceBlock = blockOfStep.get(link.source);
          const targetBlock = blockOfStep.get(link.target);
          const crosses = sourceBlock !== targetBlock;
          const targetName = nameOfStep(link.target);
          const outKind: PortInfo["kind"] =
            link.kind === "return"
              ? "return"
              : link.label === "error" || link.label === "timeout"
                ? "error"
                : link.label === "success" || link.label === "default"
                  ? "default"
                  : crosses
                    ? "external"
                    : "forward";
          if (link.source === link.target) {
            selfOf.set(link.source, [
              ...(selfOf.get(link.source) ?? []),
              {
                id: link.id,
                label: link.label,
                kind: "return",
                tip: source ? outputTip(source, link.label, targetName) : link.label,
              },
            ]);
            continue;
          }
          outputsOf.set(link.source, [
            ...(outputsOf.get(link.source) ?? []),
            {
              id: link.id,
              label: link.label,
              detail: crosses
                ? `${blockNameOf.get(targetBlock ?? "") ?? ""} › ${targetName}`
                : targetName,
              kind: outKind,
              tip: source ? outputTip(source, link.label, targetName) : link.label,
            },
          ]);
          inputsOf.set(link.target, [
            ...(inputsOf.get(link.target) ?? []),
            {
              id: link.id,
              label: nameOfStep(link.source),
              detail: link.label,
              kind: link.kind === "return" ? "return" : crosses ? "external" : "forward",
              tip: `${nameOfStep(link.source)}${
                crosses && sourceBlock ? ` (${blockNameOf.get(sourceBlock) ?? ""})` : ""
              } → ${link.label}`,
            },
          ]);
        }
        const stepNodes: StepNode[] = layout.steps.map((laid) => {
          const source = transformed.get(laid.id);
          const graph = stepById.get(laid.id)!;
          const data: StepNodeData = {
            ...(source?.data as Record<string, unknown> | undefined),
            graph,
            current: false,
            error: false,
            // Steps run across the stacking direction inside a group (see graphLayout).
            horizontal: graphBlocks.length > 0 ? !horizontal : horizontal,
            inputs: inputsOf.get(laid.id) ?? [],
            outputs: outputsOf.get(laid.id) ?? [],
            selfLoops: selfOf.get(laid.id) ?? [],
            onFocusStep: focusStep,
          };
          return {
            id: laid.id,
            type: source?.type ?? "fallback",
            position: { x: laid.x, y: laid.y },
            // Sizes for the first fit only: the card's real height is measured, and a layout
            // pass with the measured heights follows when they differ from the estimates.
            initialWidth: laid.width,
            initialHeight: laid.height,
            parentId: laid.parentId ? `block:${laid.parentId}` : undefined,
            extent: laid.parentId ? ("parent" as const) : undefined,
            draggable: false,
            // Above the edges, which run above the group surfaces.
            zIndex: 2,
            data,
          };
        });
        const graphEdges: GraphEdge[] = model.links.map((link) => ({
          id: link.id,
          source: link.source,
          target: link.target,
          sourceHandle: `out:${link.id}`,
          targetHandle: `in:${link.id}`,
          type: "graph",
          selectable: false,
          focusable: false,
          // React Flow adds an edge's zIndex to its nodes' level: 0 keeps the edges at the cards'
          // level, where the edge layer paints first (below the cards) and above the groups.
          zIndex: 0,
          data: {
            link,
            route: layout.routes[link.id],
            chipped: Boolean(layout.routes[link.id]),
            horizontal: graphBlocks.length > 0 ? !horizontal : horizontal,
          },
        }));
        marginRef.current = layout.margin;
        groupsRef.current = layout.groups.map((g) => ({ id: g.id, x: g.x, y: g.y }));
        setLaidNodes([...groupNodes, ...stepNodes]);
        setEdges(graphEdges);
        const directionChanged =
          laidDirectionRef.current !== null &&
          laidDirectionRef.current !== currentLayoutOptions.direction;
        laidDirectionRef.current = currentLayoutOptions.direction;
        if (directionChanged) {
          // A layout the reader asked for (a direction change) refits to the whole graph.
          setTimeout(() => {
            instanceRef.current?.fitView({ padding: 0.1, duration: 200 });
          }, 50);
        }
      })
      .catch((layoutError: unknown) => {
        console.error("Layout calculation failed:", layoutError);
      })
      .finally(() => {
        if (!cancelled) setIsLayouting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    visualizationData,
    model,
    graphBlocks,
    currentLayoutOptions.direction,
    measuredHeights,
    focusStep,
  ]);

  /**
   * Handle node click - notify external sidebar via onNodeSelect, or open sheet as fallback
   */
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // A block group is a frame, not a node the pages inspect.
      if (node.type === "block-group") return;
      // Call external handler if provided
      onNodeClick?.(event, node);

      if (onNodeSelect) {
        // External sidebar mode — compute connections and notify parent
        const nodeId = node.id;

        const incoming = edges
          .filter((e) => e.target === nodeId)
          .map((e) => ({ id: e.source, label: nodeName(e.source) }));

        const outgoing = edges
          .filter((e) => e.source === nodeId)
          .map((e) => {
            const edgeData = e.data as { link?: { label: string } } | undefined;
            return {
              id: e.target,
              label: nodeName(e.target),
              connectionType: edgeData?.link?.label ?? "default",
            };
          });

        setSelectedNodeData(node);
        onNodeSelect(node, { incoming, outgoing });
      } else if (showNodeDetails) {
        // Legacy Sheet mode — open detail sheet
        setSelectedNodeData(node);
        setDetailSheetOpen(true);
      }
    },
    [onNodeClick, onNodeSelect, showNodeDetails, edges, nodeName],
  );

  /**
   * Fit view using ReactFlow API
   */
  const handleFitView = useCallback(() => {
    instanceRef.current?.fitView({ padding: 0.2, duration: 300 });
  }, []);

  /**
   * Change layout direction (throttled to prevent rapid re-layouts); the layout effect re-runs.
   */
  const changeLayout = useCallback((newLayoutOptions: LayoutOptions) => {
    if (layoutThrottleRef.current) return;
    layoutThrottleRef.current = setTimeout(() => {
      layoutThrottleRef.current = null;
    }, LAYOUT_THROTTLE_MS);
    setCurrentLayoutOptions(newLayoutOptions);
  }, []);

  if ((isLayouting && nodes.length === 0) || nodeTypesLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">{t("components.workflowGraph.loading")}</div>
      </div>
    );
  }

  return (
    <div className={`h-full relative ${className}`}>
      <TransitionFocusProvider pinnedBlock={null}>
        <VariableProvider
          value={{
            registry: (workflow.variableRegistry ?? {}) as Record<string, VariableDefinition>,
            onSelect: onVariableSelect,
            selected: selectedVariable,
          }}
        >
          <DiagramViewport
            kind="graph"
            controlsPosition="top-right"
            nodes={nodes}
            edges={edges}
            // Disable change handlers for read-only view - major performance win
            onNodesChange={undefined}
            onEdgesChange={undefined}
            onNodeClick={handleNodeClick}
            // Without a click handler React Flow marks an unselectable edge `inactive` and takes
            // its pointer events away, so it could never be hovered; the handler does nothing.
            onEdgeClick={noopEdgeClick}
            onInit={handleInit}
            onReady={placementReady}
            controlButtons={
              showControls ? (
                <div className="contents" data-testid="graph-layout-controls">
                  <ControlButton
                    onClick={handleFitView}
                    title={t("components.workflowGraph.controls.fitViewTitle")}
                    aria-label={t("components.workflowGraph.controls.fitView")}
                    data-testid="graph-fit-view"
                  >
                    <ZoomIn />
                  </ControlButton>
                  <ControlButton
                    onClick={() => changeLayout({ ...currentLayoutOptions, direction: "TB" })}
                    title={t("components.workflowGraph.controls.verticalTitle")}
                    aria-label={t("components.workflowGraph.controls.vertical")}
                    data-testid="graph-layout-vertical"
                  >
                    <ArrowUpDown />
                  </ControlButton>
                  <ControlButton
                    onClick={() => changeLayout({ ...currentLayoutOptions, direction: "LR" })}
                    title={t("components.workflowGraph.controls.horizontalTitle")}
                    aria-label={t("components.workflowGraph.controls.horizontal")}
                    data-testid="graph-layout-horizontal"
                  >
                    <ArrowLeftRight />
                  </ControlButton>
                </div>
              ) : undefined
            }
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionMode={ConnectionMode.Strict}
            selectionMode={SelectionMode.Partial}
            deleteKeyCode={null}
            multiSelectionKeyCode={null}
            colorMode={actualTheme}
            style={{ backgroundColor }}
          >
            <GraphDefs />
            <GraphMeasuredHeights onMeasured={handleMeasured} />
            <Background gap={20} size={1} color={backgroundPatternColor} />

            {/* MiniMap with delayed render for better initial load performance */}
            {showMinimap && showMiniMapDelayed && !mobile && (
              <MiniMap
                position="bottom-right"
                nodeColor={(node) => {
                  const nodeData = node.data as { color?: string };
                  return nodeData?.color || "#3B82F6";
                }}
                maskColor="rgba(255, 255, 255, 0.2)"
                nodeStrokeWidth={2}
                zoomable={true}
                pannable={true}
              />
            )}
          </DiagramViewport>
        </VariableProvider>
      </TransitionFocusProvider>

      {/* Legacy Node Detail Sheet — only when no external sidebar */}
      {showNodeDetails && !onNodeSelect && (
        <NodeDetailSheet
          open={detailSheetOpen}
          onOpenChange={setDetailSheetOpen}
          node={selectedNodeData}
          incomingNodes={incomingNodes}
          outgoingNodes={outgoingNodes}
        />
      )}
    </div>
  );
};

export default WorkflowGraph;
