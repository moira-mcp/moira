/* eslint-disable no-console */
/**
 * Unified Workflow Graph Component
 *
 * Single source of truth for workflow visualization across the application.
 * Replaces both WorkflowCanvas and WorkflowViewerPlaceholder.
 *
 * Features:
 * - Accepts raw WorkflowGraph data and transforms it internally
 * - Layout controls (Fit View, Vertical, Horizontal) inside ReactFlowProvider
 * - Inner/outer component pattern for useReactFlow hooks access
 * - Current node highlighting for execution views
 * - Optional header with workflow metadata
 * - Theme-aware styling (dark/light mode)
 * - Compact node visualization with unified CompactNode component
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  Node,
  Edge,
  ConnectionMode,
  SelectionMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ZoomIn, ArrowUpDown, ArrowLeftRight } from "lucide-react";

// Compact node component for all node types
import CompactNode from "../nodes/CompactNode";
// Enhanced node detail sheet
import { NodeDetailSheet } from "./NodeDetailSheet";
// Note: SmartStepEdge (A* pathfinding) was removed due to severe performance issues
// with large graphs (142 nodes, 192 edges = 82% CPU usage during idle).
// Using default bezier edges instead - much faster, acceptable visual quality.

import { useTheme } from "../../hooks/useTheme";
import { LayoutEngine } from "../../utils/layout-algorithm";
import { WorkflowTransformer } from "../../utils/workflow-transformer";
import {
  WorkflowGraph as WorkflowGraphType,
  MoiraReactFlowNode,
  MoiraReactFlowEdge,
  LayoutOptions,
  DEFAULT_LAYOUT_OPTIONS,
  WorkflowValidationStatus,
} from "../../types";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

// All node types now use CompactNode for unified compact visualization
const nodeTypes = {
  start: CompactNode,
  "agent-directive": CompactNode,
  agentDirective: CompactNode,
  condition: CompactNode,
  "telegram-notification": CompactNode,
  telegram: CompactNode,
  subgraph: CompactNode,
  expression: CompactNode,
  "read-note": CompactNode,
  "write-note": CompactNode,
  "upsert-note": CompactNode,
  end: CompactNode,
  fallback: CompactNode,
};

// Edge types - using default edges (no custom types needed)
// SmartStepEdge was removed due to O(n²) performance on large graphs
const edgeTypes = {};

// Empty array constant to avoid creating new array on each render
const EMPTY_ERROR_NODE_IDS: string[] = [];

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
  /** Node IDs that have runtime errors (for error highlighting) */
  errorNodeIds?: string[];
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
}

/**
 * Inner component with access to ReactFlow hooks
 */
const WorkflowGraphInner: React.FC<WorkflowGraphProps> = ({
  workflow,
  validation,
  currentNodeId,
  errorNodeIds = EMPTY_ERROR_NODE_IDS,
  layoutOptions = DEFAULT_LAYOUT_OPTIONS,
  onNodeClick,
  onWorkflowNavigate,
  className = "",
  showControls = true,
  showMinimap = true,
  showNodeDetails = true,
  onNodeSelect,
  onInit,
}) => {
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const reactFlowInstance = useReactFlow();
  const { fitView: reactFlowFitView } = reactFlowInstance;

  // Call onInit callback when instance is available
  useEffect(() => {
    if (onInit && reactFlowInstance) {
      onInit({
        fitView: reactFlowInstance.fitView,
        getNodes: reactFlowInstance.getNodes,
        getEdges: reactFlowInstance.getEdges,
      });
    }
  }, [onInit, reactFlowInstance]);

  // Use regular useState instead of useNodesState/useEdgesState for read-only view
  // This avoids zustand store subscriptions that cause continuous re-renders
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [isLayouting, setIsLayouting] = useState(false);
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
    if (!selectedNodeData || edges.length === 0 || nodes.length === 0) {
      return { incomingNodes: [], outgoingNodes: [] };
    }

    const nodeId = selectedNodeData.id;
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    // Find edges where this node is the target (incoming)
    const incoming = edges
      .filter((e) => e.target === nodeId)
      .map((e) => {
        const sourceNode = nodeMap.get(e.source);
        return {
          id: e.source,
          label: (sourceNode?.data?.label as string) || e.source,
        };
      });

    // Find edges where this node is the source (outgoing)
    const outgoing = edges
      .filter((e) => e.source === nodeId)
      .map((e) => {
        const targetNode = nodeMap.get(e.target);
        const edgeData = e.data as { connectionType?: string } | undefined;
        return {
          id: e.target,
          label: (targetNode?.data?.label as string) || e.target,
          connectionType: edgeData?.connectionType || "default",
        };
      });

    return { incomingNodes: incoming, outgoingNodes: outgoing };
  }, [selectedNodeData, edges, nodes]);

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

  // Transform workflow to visualization data (memoized)
  const visualizationData = useMemo(() => {
    if (!workflow) return null;
    return WorkflowTransformer.transformWorkflow(workflow, validation);
  }, [workflow, validation]);

  /**
   * Apply layout when visualization data changes
   */
  useEffect(() => {
    if (!visualizationData) {
      setNodes([]);
      setEdges([]);
      return;
    }

    setIsLayouting(true);

    try {
      const layoutResult = LayoutEngine.applyDagreLayout(
        visualizationData.nodes as MoiraReactFlowNode[],
        visualizationData.edges as MoiraReactFlowEdge[],
        currentLayoutOptions,
      );

      // Process nodes - highlight current, mark errors, add callbacks, pass layout direction
      const errorNodeIdSet = new Set(errorNodeIds);
      const processedNodes = layoutResult.nodes.map((node) => ({
        ...node,
        draggable: true,
        data: {
          ...node.data,
          onWorkflowNavigate,
          isCurrent: node.id === currentNodeId,
          isError: errorNodeIdSet.has(node.id),
          layoutDirection: currentLayoutOptions.direction,
        },
        selected: node.id === currentNodeId,
      }));

      // Process edges - add sourceHandle and targetHandle based on connection type
      const processedEdges = layoutResult.edges.map((edge) => {
        const edgeData = edge.data as { connectionType?: string } | undefined;
        const connectionType = edgeData?.connectionType || "default";

        // Source handle: use connection type for condition nodes (true/false), otherwise "output"
        const sourceHandle =
          connectionType === "true" || connectionType === "false" ? connectionType : "output";

        return {
          ...edge,
          sourceHandle,
          targetHandle: "input",
        };
      });

      setNodes(processedNodes);
      setEdges(processedEdges as Edge[]);

      // Fit view after layout
      setTimeout(() => {
        reactFlowFitView({ padding: 0.2, duration: 200 });
      }, 50);
    } catch (layoutError) {
      console.error("Layout calculation failed:", layoutError);
      // Fallback without layout
      if (visualizationData) {
        const errorNodeIdSet = new Set(errorNodeIds);
        const fallbackNodes = visualizationData.nodes.map((node) => ({
          ...node,
          draggable: true,
          data: {
            ...node.data,
            onWorkflowNavigate,
            isCurrent: node.id === currentNodeId,
            isError: errorNodeIdSet.has(node.id),
          },
          selected: node.id === currentNodeId,
        }));
        setNodes(fallbackNodes as Node[]);
        setEdges(visualizationData.edges as Edge[]);
      }
    } finally {
      setIsLayouting(false);
    }
    // NOTE: reactFlowFitView intentionally excluded - it changes on every render
    // and would cause infinite loop. fitView is called via setTimeout anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualizationData, currentNodeId, errorNodeIds, currentLayoutOptions, onWorkflowNavigate]);

  /**
   * Handle node click - notify external sidebar via onNodeSelect, or open sheet as fallback
   */
  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      // Call external handler if provided
      onNodeClick?.(event, node);

      if (onNodeSelect) {
        // External sidebar mode — compute connections and notify parent
        const nodeId = node.id;
        const nodeMap = new Map(nodes.map((n) => [n.id, n]));

        const incoming = edges
          .filter((e) => e.target === nodeId)
          .map((e) => {
            const sourceNode = nodeMap.get(e.source);
            return { id: e.source, label: (sourceNode?.data?.label as string) || e.source };
          });

        const outgoing = edges
          .filter((e) => e.source === nodeId)
          .map((e) => {
            const targetNode = nodeMap.get(e.target);
            const edgeData = e.data as { connectionType?: string } | undefined;
            return {
              id: e.target,
              label: (targetNode?.data?.label as string) || e.target,
              connectionType: edgeData?.connectionType || "default",
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
    [onNodeClick, onNodeSelect, showNodeDetails, nodes, edges],
  );

  /**
   * Fit view using ReactFlow API
   */
  const handleFitView = useCallback(() => {
    reactFlowFitView({ padding: 0.2, duration: 300 });
  }, [reactFlowFitView]);

  /**
   * Change layout direction (throttled to prevent rapid re-layouts)
   */
  const changeLayout = useCallback(
    (newLayoutOptions: LayoutOptions) => {
      if (nodes.length === 0) return;

      // Throttle layout changes
      if (layoutThrottleRef.current) {
        return; // Skip if a layout change is pending
      }

      layoutThrottleRef.current = setTimeout(() => {
        layoutThrottleRef.current = null;
      }, LAYOUT_THROTTLE_MS);

      setIsLayouting(true);

      try {
        const layoutResult = LayoutEngine.applyDagreLayout(
          nodes as MoiraReactFlowNode[],
          edges as MoiraReactFlowEdge[],
          newLayoutOptions,
        );

        // Update nodes with new layout direction
        const updatedNodes = layoutResult.nodes.map((node) => ({
          ...node,
          data: {
            ...node.data,
            layoutDirection: newLayoutOptions.direction,
          },
        }));

        setNodes(updatedNodes);
        setEdges(layoutResult.edges as Edge[]);
        setCurrentLayoutOptions(newLayoutOptions);

        setTimeout(() => {
          reactFlowFitView({ padding: 0.2, duration: 300 });
        }, 50);
      } catch (layoutError) {
        console.error("Layout change failed:", layoutError);
      } finally {
        setIsLayouting(false);
      }
    },
    // NOTE: reactFlowFitView excluded - changes on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, edges],
  );

  if (isLayouting) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">{t("components.workflowGraph.loading")}</div>
      </div>
    );
  }

  return (
    <div className={`h-full relative ${className}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        // Disable change handlers for read-only view - major performance win
        onNodesChange={undefined}
        onEdgesChange={undefined}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Strict}
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        panOnDrag={true}
        zoomOnScroll={true}
        zoomOnPinch={true}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        minZoom={0.1}
        maxZoom={2}
        fitView={true}
        fitViewOptions={{ padding: 0.2 }}
        colorMode={actualTheme}
        style={{ backgroundColor }}
        // Performance optimizations for large graphs
        nodesDraggable={false}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        autoPanOnNodeDrag={false}
        autoPanOnConnect={false}
      >
        <Background gap={20} size={1} color={backgroundPatternColor} />

        <Controls position="top-right" showZoom={true} showFitView={true} showInteractive={false} />

        {/* MiniMap with delayed render for better initial load performance */}
        {showMinimap && showMiniMapDelayed && (
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

        {/* Layout Controls - inside ReactFlow/ReactFlowProvider for useReactFlow access */}
        {showControls && (
          <div className="absolute bottom-20 left-4 flex gap-2 bg-card/95 p-2 rounded-md border border-border shadow-sm z-10">
            <Button
              variant="outline"
              size="sm"
              onClick={handleFitView}
              title={t("components.workflowGraph.controls.fitViewTitle")}
              className="gap-1"
            >
              <ZoomIn className="w-3.5 h-3.5" />
              {t("components.workflowGraph.controls.fitView")}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => changeLayout({ ...currentLayoutOptions, direction: "TB" })}
              title={t("components.workflowGraph.controls.verticalTitle")}
              className="gap-1"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              {t("components.workflowGraph.controls.vertical")}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => changeLayout({ ...currentLayoutOptions, direction: "LR" })}
              title={t("components.workflowGraph.controls.horizontalTitle")}
              className="gap-1"
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              {t("components.workflowGraph.controls.horizontal")}
            </Button>
          </div>
        )}
      </ReactFlow>

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

/**
 * Outer component that provides ReactFlowProvider
 *
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
export const WorkflowGraph: React.FC<WorkflowGraphProps> = (props) => {
  return (
    <ReactFlowProvider>
      <WorkflowGraphInner {...props} />
    </ReactFlowProvider>
  );
};

export default WorkflowGraph;
