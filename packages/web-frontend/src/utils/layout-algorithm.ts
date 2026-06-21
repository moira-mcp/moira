/* eslint-disable no-console */
/**
 * Layout Algorithm Integration
 * Dagre-based automatic positioning for MCP workflow visualization
 *
 * Note: console.warn used for browser debugging of layout fallbacks
 */

import dagre from "dagre";
import { Node, Edge } from "@xyflow/react";
import {
  LayoutOptions,
  DEFAULT_LAYOUT_OPTIONS,
  DEFAULT_NODE_STYLES,
  MoiraReactFlowNode,
  MoiraReactFlowEdge,
} from "../types";

/**
 * Layout engine for automatic node positioning
 */
export class LayoutEngine {
  /**
   * Apply Dagre hierarchical layout to nodes and edges
   */
  static applyDagreLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    // Configure layout algorithm
    dagreGraph.setGraph({
      rankdir: options.direction,
      nodesep: options.nodeSpacing,
      ranksep: options.rankSpacing,
      marginx: options.padding.left,
      marginy: options.padding.top,
      align: "UL", // Upper Left alignment
    });

    // Add nodes with their actual dimensions
    nodes.forEach((node) => {
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];
      const width = node.measured?.width || styleConfig.minWidth;
      const height = node.measured?.height || styleConfig.minHeight;

      dagreGraph.setNode(node.id, {
        width,
        height,
      });
    });

    // Add edges to establish node relationships
    edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    // Run Dagre layout algorithm
    dagre.layout(dagreGraph);

    // Apply calculated positions to nodes
    const layoutedNodes = nodes.map((node) => {
      const nodeWithPosition = dagreGraph.node(node.id);
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];
      const width = node.measured?.width || styleConfig.minWidth;
      const height = node.measured?.height || styleConfig.minHeight;

      return {
        ...node,
        position: {
          x: nodeWithPosition.x - width / 2,
          y: nodeWithPosition.y - height / 2,
        },
      };
    });

    return {
      nodes: layoutedNodes,
      edges,
    };
  }

  /**
   * Apply manual grid layout (fallback for simple workflows)
   */
  static applyGridLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    const layoutedNodes = nodes.map((node, index) => {
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];
      const columns = 3; // 3 nodes per row

      const x =
        (index % columns) * (styleConfig.minWidth + options.nodeSpacing) + options.padding.left;
      const y =
        Math.floor(index / columns) * (styleConfig.minHeight + options.rankSpacing) +
        options.padding.top;

      return {
        ...node,
        position: { x, y },
      };
    });

    return {
      nodes: layoutedNodes,
      edges,
    };
  }

  /**
   * Apply force-directed layout (future enhancement)
   */
  static applyForceLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    // TODO: Implement force-directed layout algorithm
    // For now, fallback to grid layout
    console.warn("Force layout not implemented yet, using grid layout");
    return this.applyGridLayout(nodes, edges, options);
  }

  /**
   * Auto-select best layout algorithm based on workflow characteristics
   */
  static autoLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    const nodeCount = nodes.length;
    const edgeCount = edges.length;
    const complexity = edgeCount / nodeCount; // Edge-to-node ratio

    // Select algorithm based on workflow characteristics
    if (nodeCount <= 3) {
      // Simple workflows: grid layout
      return this.applyGridLayout(nodes, edges, options);
    } else if (complexity < 1.5) {
      // Linear workflows: Dagre hierarchical
      return this.applyDagreLayout(nodes, edges, { ...options, direction: "TB" });
    } else {
      // Complex workflows: Dagre with wider spacing
      return this.applyDagreLayout(nodes, edges, {
        ...options,
        nodeSpacing: options.nodeSpacing * 1.5,
        rankSpacing: options.rankSpacing * 1.2,
      });
    }
  }

  /**
   * Calculate optimal viewport settings for workflow
   */
  static calculateViewport(
    nodes: MoiraReactFlowNode[],
    containerWidth: number = 800,
    containerHeight: number = 600,
  ): {
    x: number;
    y: number;
    zoom: number;
  } {
    if (nodes.length === 0) {
      return { x: 0, y: 0, zoom: 1 };
    }

    // Calculate workflow bounds
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    nodes.forEach((node) => {
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];
      const width = node.measured?.width || styleConfig.minWidth;
      const height = node.measured?.height || styleConfig.minHeight;

      const nodeMinX = node.position.x;
      const nodeMaxX = node.position.x + width;
      const nodeMinY = node.position.y;
      const nodeMaxY = node.position.y + height;

      minX = Math.min(minX, nodeMinX);
      maxX = Math.max(maxX, nodeMaxX);
      minY = Math.min(minY, nodeMinY);
      maxY = Math.max(maxY, nodeMaxY);
    });

    // Add padding
    const padding = 50;
    const workflowWidth = maxX - minX + padding * 2;
    const workflowHeight = maxY - minY + padding * 2;

    // Calculate zoom to fit
    const zoomX = containerWidth / workflowWidth;
    const zoomY = containerHeight / workflowHeight;
    const zoom = Math.min(zoomX, zoomY, 1); // Don't zoom in beyond 1x

    // Calculate center position
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    return {
      x: containerWidth / 2 - centerX * zoom,
      y: containerHeight / 2 - centerY * zoom,
      zoom,
    };
  }

  /**
   * Validate layout options
   */
  static validateLayoutOptions(options: Partial<LayoutOptions>): LayoutOptions {
    return {
      algorithm: options.algorithm || DEFAULT_LAYOUT_OPTIONS.algorithm,
      direction: options.direction || DEFAULT_LAYOUT_OPTIONS.direction,
      nodeSpacing: Math.max(options.nodeSpacing || DEFAULT_LAYOUT_OPTIONS.nodeSpacing, 40),
      rankSpacing: Math.max(options.rankSpacing || DEFAULT_LAYOUT_OPTIONS.rankSpacing, 80),
      padding: {
        top: Math.max(options.padding?.top || DEFAULT_LAYOUT_OPTIONS.padding.top, 10),
        right: Math.max(options.padding?.right || DEFAULT_LAYOUT_OPTIONS.padding.right, 10),
        bottom: Math.max(options.padding?.bottom || DEFAULT_LAYOUT_OPTIONS.padding.bottom, 10),
        left: Math.max(options.padding?.left || DEFAULT_LAYOUT_OPTIONS.padding.left, 10),
      },
    };
  }

  /**
   * Get layout recommendations based on workflow characteristics
   */
  static getLayoutRecommendations(
    nodes: MoiraReactFlowNode[],
    _edges: MoiraReactFlowEdge[],
  ): {
    recommended: LayoutOptions;
    alternatives: LayoutOptions[];
    reasoning: string;
  } {
    const nodeCount = nodes.length;
    const hasConditions = nodes.some((node) => node.data.nodeType === "condition");

    let recommended: LayoutOptions;
    let reasoning: string;

    if (nodeCount <= 5 && !hasConditions) {
      // Simple linear workflow
      recommended = { ...DEFAULT_LAYOUT_OPTIONS, direction: "TB" };
      reasoning = "Simple linear workflow: top-to-bottom layout with standard spacing";
    } else if (hasConditions && nodeCount <= 10) {
      // Workflow with branching
      recommended = {
        ...DEFAULT_LAYOUT_OPTIONS,
        direction: "TB",
        nodeSpacing: 100,
        rankSpacing: 140,
      };
      reasoning = "Branching workflow: increased spacing for better branch visualization";
    } else if (nodeCount > 10) {
      // Complex workflow
      recommended = {
        ...DEFAULT_LAYOUT_OPTIONS,
        direction: "LR",
        nodeSpacing: 120,
        rankSpacing: 160,
      };
      reasoning = "Complex workflow: left-to-right layout with wide spacing for readability";
    } else {
      // Default case
      recommended = DEFAULT_LAYOUT_OPTIONS;
      reasoning = "Standard workflow: default hierarchical layout";
    }

    const alternatives: LayoutOptions[] = [
      { ...recommended, direction: "TB" as const },
      { ...recommended, direction: "LR" as const },
      { ...recommended, nodeSpacing: recommended.nodeSpacing * 0.8 }, // Compact
      { ...recommended, nodeSpacing: recommended.nodeSpacing * 1.2 }, // Spacious
    ].filter(
      (alt) =>
        alt.direction !== recommended.direction || alt.nodeSpacing !== recommended.nodeSpacing,
    );

    return {
      recommended,
      alternatives,
      reasoning,
    };
  }
}

/**
 * Layout presets for common workflow patterns
 * Updated for compact node visualization with increased spacing
 */
export const LAYOUT_PRESETS: Record<string, LayoutOptions> = {
  compact: {
    algorithm: "dagre",
    direction: "TB",
    nodeSpacing: 100,
    rankSpacing: 80,
    padding: { top: 20, right: 20, bottom: 20, left: 20 },
  },

  standard: DEFAULT_LAYOUT_OPTIONS,

  spacious: {
    algorithm: "dagre",
    direction: "TB",
    nodeSpacing: 200,
    rankSpacing: 140,
    padding: { top: 40, right: 40, bottom: 40, left: 40 },
  },

  horizontal: {
    algorithm: "dagre",
    direction: "LR",
    nodeSpacing: 150,
    rankSpacing: 120,
    padding: { top: 30, right: 30, bottom: 30, left: 30 },
  },

  presentation: {
    algorithm: "dagre",
    direction: "TB",
    nodeSpacing: 200,
    rankSpacing: 160,
    padding: { top: 60, right: 60, bottom: 60, left: 60 },
  },
};

/**
 * Layout utility functions
 */
export const LayoutUtils = {
  /**
   * Fit workflow to viewport
   */
  fitToViewport: (
    nodes: Node[],
    containerWidth: number,
    containerHeight: number,
    padding: number = 50,
  ) => {
    return LayoutEngine.calculateViewport(
      nodes as MoiraReactFlowNode[],
      containerWidth - padding * 2,
      containerHeight - padding * 2,
    );
  },

  /**
   * Center workflow in viewport
   */
  centerWorkflow: (nodes: Node[]) => {
    if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };

    const bounds = LayoutUtils.getWorkflowBounds(nodes);
    return {
      x: -bounds.centerX,
      y: -bounds.centerY,
      zoom: 1,
    };
  },

  /**
   * Get workflow bounding box
   */
  getWorkflowBounds: (nodes: Node[]) => {
    if (nodes.length === 0) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, centerX: 0, centerY: 0, width: 0, height: 0 };
    }

    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    nodes.forEach((node) => {
      // Approximate node dimensions
      const width = 150; // Default width
      const height = 100; // Default height

      const nodeMinX = node.position.x;
      const nodeMaxX = node.position.x + width;
      const nodeMinY = node.position.y;
      const nodeMaxY = node.position.y + height;

      minX = Math.min(minX, nodeMinX);
      maxX = Math.max(maxX, nodeMaxX);
      minY = Math.min(minY, nodeMinY);
      maxY = Math.max(maxY, nodeMaxY);
    });

    return {
      minX,
      maxX,
      minY,
      maxY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      width: maxX - minX,
      height: maxY - minY,
    };
  },

  /**
   * Create layout options from user preferences
   */
  createLayoutOptions: (preferences: {
    algorithm?: string;
    direction?: string;
    spacing?: "compact" | "standard" | "spacious";
    padding?: number;
  }): LayoutOptions => {
    let baseOptions = DEFAULT_LAYOUT_OPTIONS;

    // Apply spacing preset
    if (preferences.spacing && LAYOUT_PRESETS[preferences.spacing]) {
      baseOptions = LAYOUT_PRESETS[preferences.spacing];
    }

    return {
      algorithm: (preferences.algorithm as "dagre" | "force" | undefined) || baseOptions.algorithm,
      direction: (preferences.direction as "TB" | "LR" | undefined) || baseOptions.direction,
      nodeSpacing: baseOptions.nodeSpacing,
      rankSpacing: baseOptions.rankSpacing,
      padding: preferences.padding
        ? {
            top: preferences.padding,
            right: preferences.padding,
            bottom: preferences.padding,
            left: preferences.padding,
          }
        : baseOptions.padding,
    };
  },
};

/**
 * Layout animation utilities
 */
export const LayoutAnimation = {
  /**
   * Animate nodes to new positions
   */
  animateToPositions: (
    nodes: Node[],
    newPositions: Array<{ x: number; y: number }>,
    duration: number = 500,
    onUpdate?: (nodes: Node[]) => void,
  ): Promise<void> => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const startPositions = nodes.map((node) => ({ ...node.position }));

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Easing function (ease-out)
        const easeOut = 1 - Math.pow(1 - progress, 3);

        const updatedNodes = nodes.map((node, index) => {
          const start = startPositions[index];
          const target = newPositions[index];

          return {
            ...node,
            position: {
              x: start.x + (target.x - start.x) * easeOut,
              y: start.y + (target.y - start.y) * easeOut,
            },
          };
        });

        if (onUpdate) {
          onUpdate(updatedNodes);
        }

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          resolve();
        }
      };

      animate();
    });
  },

  /**
   * Animate layout change
   */
  animateLayoutChange: async (
    currentNodes: MoiraReactFlowNode[],
    newLayoutOptions: LayoutOptions,
    edges: MoiraReactFlowEdge[],
    onUpdate: (nodes: MoiraReactFlowNode[]) => void,
  ): Promise<void> => {
    // Calculate new layout
    const { nodes: newNodes } = LayoutEngine.applyDagreLayout(
      currentNodes,
      edges,
      newLayoutOptions,
    );

    // Extract new positions
    const newPositions = newNodes.map((node) => node.position);

    // Animate to new positions
    await LayoutAnimation.animateToPositions(
      currentNodes as Node[],
      newPositions,
      500,
      onUpdate as (nodes: Node[]) => void,
    );
  },
};

/**
 * Layout performance optimization
 */
export const LayoutOptimization = {
  /**
   * Check if layout recalculation is needed
   */
  needsRecalculation: (
    oldNodes: Node[],
    newNodes: Node[],
    oldEdges: Edge[],
    newEdges: Edge[],
  ): boolean => {
    // Check if node count changed
    if (oldNodes.length !== newNodes.length || oldEdges.length !== newEdges.length) {
      return true;
    }

    // Check if node IDs changed
    const oldNodeIds = new Set(oldNodes.map((n) => n.id));
    const newNodeIds = new Set(newNodes.map((n) => n.id));
    if (oldNodeIds.size !== newNodeIds.size) {
      return true;
    }

    for (const id of newNodeIds) {
      if (!oldNodeIds.has(id)) {
        return true;
      }
    }

    // Check if edge connections changed
    const oldEdgeKeys = new Set(oldEdges.map((e) => `${e.source}-${e.target}`));
    const newEdgeKeys = new Set(newEdges.map((e) => `${e.source}-${e.target}`));

    if (oldEdgeKeys.size !== newEdgeKeys.size) {
      return true;
    }

    for (const key of newEdgeKeys) {
      if (!oldEdgeKeys.has(key)) {
        return true;
      }
    }

    return false;
  },

  /**
   * Debounce layout calculations
   */
  createDebouncedLayout: (
    layoutFunction: (
      nodes: MoiraReactFlowNode[],
      edges: MoiraReactFlowEdge[],
    ) => { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] },
    delay: number = 300,
  ) => {
    let timeoutId: NodeJS.Timeout;

    return (
      nodes: MoiraReactFlowNode[],
      edges: MoiraReactFlowEdge[],
      callback: (result: { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] }) => void,
    ) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        const result = layoutFunction(nodes, edges);
        callback(result);
      }, delay);
    };
  },
};
