/**
 * Workflow data transformation utilities
 * Converts MCP workflow format to React Flow visualization format
 */

// Dagre layout algorithm integration
import dagre from "dagre";
import {
  WorkflowGraph,
  WorkflowNode,
  StartNode,
  EndNode,
  StructuredCondition,
  isStartNode,
  isAgentDirectiveNode,
  isConditionNode,
  isEndNode,
  isExpressionNode,
  isSubgraphNode,
  isReadNoteNode,
  isWriteNoteNode,
  isUpsertNoteNode,
  ReadNoteNode,
  WriteNoteNode,
  UpsertNoteNode,
} from "../types";

import {
  WorkflowVisualizationData,
  MoiraReactFlowNode,
  MoiraReactFlowEdge,
  MoiraNodeDataUnion,
  StartNodeData,
  AgentDirectiveNodeData,
  ConditionNodeData,
  EndNodeData,
  ExpressionNodeData,
  SubgraphNodeData,
  ReadNoteNodeData,
  WriteNoteNodeData,
  UpsertNoteNodeData,
  FallbackNodeData,
  LayoutOptions,
  DEFAULT_LAYOUT_OPTIONS,
  DEFAULT_NODE_STYLES,
  DEFAULT_EDGE_STYLES,
  WorkflowValidationStatus,
} from "../types";

/**
 * Main transformer class for MCP workflow to React Flow conversion
 */
export class WorkflowTransformer {
  /**
   * Transform complete workflow to React Flow visualization data
   */
  static transformWorkflow(
    workflow: WorkflowGraph,
    validation?: WorkflowValidationStatus,
    layoutOptions: LayoutOptions = DEFAULT_LAYOUT_OPTIONS,
  ): WorkflowVisualizationData {
    // Transform nodes to React Flow format
    const nodes = this.transformNodes(workflow.nodes, validation);

    // Transform connections to React Flow edges
    const edges = this.transformEdges(workflow.nodes);

    // Apply layout algorithm
    const layoutedData = this.applyLayout(nodes, edges, layoutOptions);

    return {
      nodes: layoutedData.nodes,
      edges: layoutedData.edges,
      metadata: {
        workflowId: workflow.id,
        workflowName: workflow.metadata.name,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        validationStatus: validation?.isValid ? "valid" : validation ? "invalid" : "warning",
        lastModified: Date.now(),
      },
    };
  }

  /**
   * Transform MCP nodes to React Flow nodes
   */
  private static transformNodes(
    mcpNodes: WorkflowNode[],
    validation?: WorkflowValidationStatus,
  ): MoiraReactFlowNode[] {
    return mcpNodes.map((node) => {
      const nodeValidation = validation?.nodeValidation[node.id];
      const validationStatus = nodeValidation?.isValid
        ? "valid"
        : nodeValidation
          ? "invalid"
          : "warning";

      const transformedData = this.transformNodeData(node, validationStatus, nodeValidation);
      // Use nodeType from transformed data - it may be "fallback" for unknown types
      return {
        id: node.id,
        type: transformedData.nodeType,
        position: { x: 0, y: 0 }, // Will be calculated by layout
        data: transformedData,
        draggable: false, // Read-only visualization
        selectable: true,
        deletable: false,
      };
    });
  }

  /**
   * Transform individual node data based on node type
   */
  private static transformNodeData(
    node: WorkflowNode,
    validationStatus: "valid" | "invalid" | "warning",
    nodeValidation?: { errors: string[]; warnings: string[] },
  ): MoiraNodeDataUnion {
    const baseData = {
      nodeId: node.id,
      validationStatus,
      validationErrors: nodeValidation?.errors || [],
      validationWarnings: nodeValidation?.warnings || [],
      originalNode: node,
    };

    if (isStartNode(node)) {
      return {
        ...baseData,
        nodeType: "start",
        label: node.metadata?.displayName || "Start",
        description: node.metadata?.description || "Workflow entry point",
        initialData: node.initialData,
        defaultConnection: node.connections.default,
        color: DEFAULT_NODE_STYLES.start.colors.primary,
        icon: DEFAULT_NODE_STYLES.start.icon,
      } as StartNodeData;
    }

    if (isAgentDirectiveNode(node)) {
      return {
        ...baseData,
        nodeType: "agent-directive",
        label: node.metadata?.displayName || "Agent Task",
        description: this.truncateText(node.directive, 100),
        directive: node.directive,
        completionCondition: node.completionCondition,
        inputSchema: node.inputSchema,
        maxRetries: node.maxRetries,
        retryMessage: node.retryMessage,
        connections: node.connections,
        color: DEFAULT_NODE_STYLES["agent-directive"].colors.primary,
        icon: DEFAULT_NODE_STYLES["agent-directive"].icon,
      } as AgentDirectiveNodeData;
    }

    if (isConditionNode(node)) {
      return {
        ...baseData,
        nodeType: "condition",
        label: node.metadata?.displayName || "Decision",
        description: this.generateConditionSummary(node.condition),
        condition: node.condition,
        conditionSummary: this.generateConditionSummary(node.condition),
        trueConnection: node.connections.true,
        falseConnection: node.connections.false,
        color: DEFAULT_NODE_STYLES.condition.colors.primary,
        icon: DEFAULT_NODE_STYLES.condition.icon,
      } as ConditionNodeData;
    }

    if (isEndNode(node)) {
      return {
        ...baseData,
        nodeType: "end",
        label: node.metadata?.displayName || "End",
        description: node.metadata?.description || "Workflow completion",
        finalOutput: node.finalOutput,
        outputDescription: node.finalOutput?.join(", ") || "No output specified",
        color: DEFAULT_NODE_STYLES.end.colors.primary,
        icon: DEFAULT_NODE_STYLES.end.icon,
      } as EndNodeData;
    }

    if (isExpressionNode(node)) {
      return {
        ...baseData,
        nodeType: "expression",
        label: node.metadata?.displayName || "Expression",
        description: node.expressions?.join("; ").substring(0, 80) || "Expression evaluation",
        expressions: node.expressions || [],
        defaultConnection: node.connections?.default || "",
        errorConnection: node.connections?.error,
        color: DEFAULT_NODE_STYLES.expression?.colors?.primary || "#9333ea",
        icon: DEFAULT_NODE_STYLES.expression?.icon || "code",
      } as ExpressionNodeData;
    }

    if (isSubgraphNode(node)) {
      return {
        ...baseData,
        nodeType: "subgraph",
        label: node.metadata?.displayName || "Subgraph",
        description: node.metadata?.description || `Subgraph: ${node.graphId}`,
        graphId: node.graphId,
        inputMapping: node.inputMapping,
        outputMapping: node.outputMapping,
        connections: node.connections,
        color: DEFAULT_NODE_STYLES.subgraph?.colors?.primary || "#EC4899",
        icon: DEFAULT_NODE_STYLES.subgraph?.icon || "fork",
      } as SubgraphNodeData;
    }

    if (isReadNoteNode(node)) {
      const readNode = node as ReadNoteNode;
      return {
        ...baseData,
        nodeType: "read-note",
        label: node.metadata?.displayName || "Read Note",
        description: this.generateReadNoteDescription(readNode),
        outputVariable: readNode.outputVariable,
        filter: readNode.filter,
        singleMode: readNode.singleMode,
        defaultConnection: readNode.connections.default,
        errorConnection: readNode.connections.error,
        color: DEFAULT_NODE_STYLES["read-note"].colors.primary,
        icon: DEFAULT_NODE_STYLES["read-note"].icon,
      } as ReadNoteNodeData;
    }

    if (isWriteNoteNode(node)) {
      const writeNode = node as WriteNoteNode;
      return {
        ...baseData,
        nodeType: "write-note",
        label: node.metadata?.displayName || "Write Note",
        description: this.generateWriteNoteDescription(writeNode),
        key: writeNode.key,
        source: writeNode.source,
        tags: writeNode.tags,
        batchMode: writeNode.batchMode,
        defaultConnection: writeNode.connections.default,
        errorConnection: writeNode.connections.error,
        color: DEFAULT_NODE_STYLES["write-note"].colors.primary,
        icon: DEFAULT_NODE_STYLES["write-note"].icon,
      } as WriteNoteNodeData;
    }

    if (isUpsertNoteNode(node)) {
      const upsertNode = node as UpsertNoteNode;
      return {
        ...baseData,
        nodeType: "upsert-note",
        label: node.metadata?.displayName || "Upsert Note",
        description: this.generateUpsertNoteDescription(upsertNode),
        search: upsertNode.search,
        keyTemplate: upsertNode.keyTemplate,
        value: upsertNode.value,
        tags: upsertNode.tags,
        outputVariable: upsertNode.outputVariable,
        defaultConnection: upsertNode.connections.default,
        errorConnection: upsertNode.connections.error,
        color: DEFAULT_NODE_STYLES["upsert-note"].colors.primary,
        icon: DEFAULT_NODE_STYLES["upsert-note"].icon,
      } as UpsertNoteNodeData;
    }

    // Handle telegram-notification nodes (not in WorkflowNode union, runtime-only check)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((node as any).type === "telegram-notification") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const telegramNode = node as any;
      return {
        nodeId: telegramNode.id,
        nodeType: "telegram-notification",
        label: "Telegram Notification",
        description: telegramNode.message?.substring(0, 80) + "..." || "Telegram notification",
        validationStatus: "valid" as const,
        validationErrors: [],
        validationWarnings: [],
        originalNode: node,
        message: telegramNode.message,
        chatId: telegramNode.chatId,
        parseMode: telegramNode.parseMode,
      };
    }

    // Exhaustive check: TypeScript verifies all WorkflowNode types are handled above.
    // If a new type is added to WorkflowNode without a handler, this line will produce a compile error.
    const _exhaustive: never = node;
    // Runtime fallback for untyped data (e.g. telegram-notification) - graceful degradation instead of crash
    const unknownNode = _exhaustive as unknown as WorkflowNode;
    // eslint-disable-next-line no-console
    console.warn(
      `[WorkflowTransformer] Unknown node type "${unknownNode.type}" for node "${unknownNode.id}". Rendering as fallback.`,
    );

    return {
      ...baseData,
      nodeType: "fallback",
      label: unknownNode.metadata?.displayName || unknownNode.type.toUpperCase(),
      description: `Unknown node type: ${unknownNode.type}`,
      validationStatus: "warning" as const,
      originalType: unknownNode.type,
      connections: unknownNode.connections,
      color: DEFAULT_NODE_STYLES.fallback.colors.primary,
      icon: DEFAULT_NODE_STYLES.fallback.icon,
    } as FallbackNodeData;
  }

  /**
   * Transform node connections to React Flow edges
   */
  private static transformEdges(mcpNodes: WorkflowNode[]): MoiraReactFlowEdge[] {
    const edges: MoiraReactFlowEdge[] = [];

    mcpNodes.forEach((node) => {
      if (!node.connections) return;

      Object.entries(node.connections).forEach(([connectionType, targetNodeId]) => {
        const edgeId = `${node.id}-${connectionType}-${targetNodeId}`;
        const edgeStyle = DEFAULT_EDGE_STYLES[connectionType] || DEFAULT_EDGE_STYLES.default;

        // Ensure edgeStyle is defined (TypeScript strict mode safety)
        if (!edgeStyle) {
          throw new Error(`No edge style defined for connection type: ${connectionType}`);
        }

        edges.push({
          id: edgeId,
          source: node.id,
          target: targetNodeId,
          type: "smart", // Use SmartStepEdge for A* pathfinding (edges avoid nodes)
          style: {
            stroke: edgeStyle.color,
            strokeWidth: edgeStyle.width,
            strokeDasharray:
              edgeStyle.style === "dashed"
                ? "5,5"
                : edgeStyle.style === "dotted"
                  ? "2,2"
                  : undefined,
          },
          markerEnd: {
            type: "arrowclosed" as const,
            color: edgeStyle.color,
          },
          animated: edgeStyle.animated || false,
          data: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            connectionType: connectionType as any,
            color: edgeStyle.color,
            style: edgeStyle.style,
          },
        });
      });
    });

    return edges;
  }

  /**
   * Apply layout algorithm to position nodes and edges
   */
  private static applyLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    if (options.algorithm === "dagre") {
      return this.applyDagreLayout(nodes, edges, options);
    }

    // For now, only Dagre is implemented
    return { nodes, edges };
  }

  /**
   * Apply Dagre hierarchical layout
   */
  private static applyDagreLayout(
    nodes: MoiraReactFlowNode[],
    edges: MoiraReactFlowEdge[],
    options: LayoutOptions,
  ): { nodes: MoiraReactFlowNode[]; edges: MoiraReactFlowEdge[] } {
    const dagreGraph = new dagre.graphlib.Graph();
    dagreGraph.setDefaultEdgeLabel(() => ({}));

    // Configure layout direction and spacing based on options
    dagreGraph.setGraph({
      rankdir: options.direction, // TB (top-bottom) or LR (left-right)
      nodesep: options.nodeSpacing,
      ranksep: options.rankSpacing,
      marginx: options.padding.left,
      marginy: options.padding.top,
    });

    // Add nodes with dimensions
    nodes.forEach((node) => {
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];
      dagreGraph.setNode(node.id, {
        width: styleConfig.minWidth,
        height: styleConfig.minHeight,
      });
    });

    // Add edges
    edges.forEach((edge) => {
      dagreGraph.setEdge(edge.source, edge.target);
    });

    // Run layout algorithm
    dagre.layout(dagreGraph);

    // Apply calculated positions - source/target positions depend on layout direction
    const isHorizontal = options.direction === "LR";
    const layoutedNodes = nodes.map((node) => {
      const nodeWithPosition = dagreGraph.node(node.id);
      const styleConfig = DEFAULT_NODE_STYLES[node.data.nodeType];

      return {
        ...node,
        position: {
          x: nodeWithPosition.x - styleConfig.minWidth / 2,
          y: nodeWithPosition.y - styleConfig.minHeight / 2,
        },
        // For LR: source=right, target=left
        // For TB: source=bottom, target=top
        sourcePosition: (isHorizontal ? "right" : "bottom") as "right" | "bottom",
        targetPosition: (isHorizontal ? "left" : "top") as "left" | "top",
      };
    });

    return {
      nodes: layoutedNodes,
      edges,
    };
  }

  /**
   * Generate human-readable condition summary
   */
  private static generateConditionSummary(condition: StructuredCondition): string {
    const { operator, left, right, conditions, condition: nestedCondition, value } = condition;

    switch (operator) {
      case "eq":
        return `${this.valueToString(left)} equals ${this.valueToString(right)}`;
      case "neq":
        return `${this.valueToString(left)} not equals ${this.valueToString(right)}`;
      case "gt":
        return `${this.valueToString(left)} > ${this.valueToString(right)}`;
      case "gte":
        return `${this.valueToString(left)} >= ${this.valueToString(right)}`;
      case "lt":
        return `${this.valueToString(left)} < ${this.valueToString(right)}`;
      case "lte":
        return `${this.valueToString(left)} <= ${this.valueToString(right)}`;
      case "contains":
        return `${this.valueToString(left)} contains ${this.valueToString(right)}`;
      case "exists":
        return `${this.valueToString(value)} exists`;
      case "and":
        return (
          conditions?.map((c) => this.generateConditionSummary(c)).join(" AND ") || "AND condition"
        );
      case "or":
        return (
          conditions?.map((c) => this.generateConditionSummary(c)).join(" OR ") || "OR condition"
        );
      case "not":
        return `NOT (${nestedCondition ? this.generateConditionSummary(nestedCondition) : "condition"})`;
      default:
        return `${operator} condition`;
    }
  }

  /**
   * Convert condition value to readable string
   */
  private static valueToString(value: unknown): string {
    if (value && typeof value === "object" && "contextPath" in value) {
      return `{${value.contextPath}}`;
    }
    return String(value);
  }

  /**
   * Get display label for edge connection type
   * Labels removed per user feedback - direction is clear from arrows
   */
  private static getEdgeLabel(_connectionType: string): string {
    // No labels - arrows show direction, colors show type
    return "";
  }

  /**
   * Truncate text for display purposes
   */
  private static truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
   * Generate description for read-note node
   */
  private static generateReadNoteDescription(node: ReadNoteNode): string {
    const parts: string[] = [];
    if (node.filter?.tag) parts.push(`tag: ${node.filter.tag}`);
    if (node.filter?.keyPattern) parts.push(`pattern: ${node.filter.keyPattern}`);
    if (node.filter?.keySearch) parts.push(`search: ${node.filter.keySearch}`);
    if (node.singleMode) parts.push("single");
    const filterDesc = parts.length > 0 ? parts.join(", ") : "all notes";
    return `Read ${filterDesc} → ${node.outputVariable}`;
  }

  /**
   * Generate description for write-note node
   */
  private static generateWriteNoteDescription(node: WriteNoteNode): string {
    const keyDesc = node.key ? `key: ${node.key}` : "dynamic key";
    const tagsDesc = node.tags?.length ? ` [${node.tags.join(", ")}]` : "";
    const batchDesc = node.batchMode ? " (batch)" : "";
    return `${node.source} → ${keyDesc}${tagsDesc}${batchDesc}`;
  }

  /**
   * Generate description for upsert-note node
   */
  private static generateUpsertNoteDescription(node: UpsertNoteNode): string {
    const searchDesc = node.search
      ? `find by ${node.search.tag || node.search.keyPattern || "criteria"}`
      : "create new";
    return `${searchDesc} → ${node.keyTemplate}`;
  }

  /**
   * Validate workflow structure for React Flow compatibility
   */
  static validateForVisualization(workflow: WorkflowGraph): {
    isCompatible: boolean;
    issues: string[];
    warnings: string[];
  } {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check for required start node
    const startNodes = workflow.nodes.filter(isStartNode);
    if (startNodes.length === 0) {
      issues.push("Workflow must have exactly one start node");
    } else if (startNodes.length > 1) {
      warnings.push("Multiple start nodes found, only first will be used");
    }

    // Check for end nodes
    const endNodes = workflow.nodes.filter(isEndNode);
    if (endNodes.length === 0) {
      warnings.push("No end node found - workflow may run indefinitely");
    }

    // Validate node connections
    workflow.nodes.forEach((node) => {
      if (!node.connections && !isEndNode(node)) {
        issues.push(`Node ${node.id} has no connections`);
      }

      if (node.connections) {
        Object.values(node.connections).forEach((targetId) => {
          const targetExists = workflow.nodes.some((n) => n.id === targetId);
          if (!targetExists) {
            issues.push(`Node ${node.id} references non-existent target: ${targetId}`);
          }
        });
      }
    });

    // Check for cycles (basic check)
    if (this.hasCycles(workflow.nodes)) {
      warnings.push("Potential cycles detected in workflow graph");
    }

    return {
      isCompatible: issues.length === 0,
      issues,
      warnings,
    };
  }

  /**
   * Basic cycle detection
   */
  private static hasCycles(nodes: WorkflowNode[]): boolean {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return true; // Cycle detected
      if (visited.has(nodeId)) return false;

      visiting.add(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (node?.connections) {
        for (const targetId of Object.values(node.connections)) {
          if (visit(targetId)) return true;
        }
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      return false;
    };

    // Check from all nodes (in case of disconnected components)
    for (const node of nodes) {
      if (!visited.has(node.id)) {
        if (visit(node.id)) return true;
      }
    }

    return false;
  }

  /**
   * Extract workflow statistics
   */
  static extractWorkflowStats(workflow: WorkflowGraph): {
    nodeTypes: Record<string, number>;
    totalConnections: number;
    maxDepth: number;
    complexity: "simple" | "moderate" | "complex";
  } {
    const nodeTypes: Record<string, number> = {};
    let totalConnections = 0;

    workflow.nodes.forEach((node) => {
      nodeTypes[node.type] = (nodeTypes[node.type] || 0) + 1;
      totalConnections += Object.keys(node.connections || {}).length;
    });

    const nodeCount = workflow.nodes.length;
    const complexity = nodeCount <= 5 ? "simple" : nodeCount <= 15 ? "moderate" : "complex";

    return {
      nodeTypes,
      totalConnections,
      maxDepth: this.calculateMaxDepth(workflow.nodes),
      complexity,
    };
  }

  /**
   * Calculate maximum depth of workflow
   */
  private static calculateMaxDepth(nodes: WorkflowNode[]): number {
    const startNode = nodes.find(isStartNode);
    if (!startNode) return 0;

    const visited = new Set<string>();

    const calculateDepth = (nodeId: string): number => {
      if (visited.has(nodeId)) return 0; // Prevent infinite recursion
      visited.add(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (!node?.connections) return 1;

      const depths = Object.values(node.connections).map((targetId) => calculateDepth(targetId));

      return 1 + Math.max(...depths, 0);
    };

    return calculateDepth(startNode.id);
  }

  /**
   * Create default validation status for workflows without validation
   */
  static createDefaultValidation(workflow: WorkflowGraph): WorkflowValidationStatus {
    const nodeValidation: Record<
      string,
      { isValid: boolean; errors: string[]; warnings: string[] }
    > = {};

    workflow.nodes.forEach((node) => {
      nodeValidation[node.id] = {
        isValid: true,
        errors: [],
        warnings: [],
      };
    });

    return {
      isValid: true,
      nodeValidation,
      globalErrors: [],
      globalWarnings: [],
    };
  }
}

/**
 * Utility functions for workflow manipulation
 */
export class WorkflowUtils {
  /**
   * Find workflow entry point (start node)
   */
  static findStartNode(workflow: WorkflowGraph): StartNode | null {
    const startNodes = workflow.nodes.filter(isStartNode) as StartNode[];
    const firstNode = startNodes[0];
    return firstNode ?? null;
  }

  /**
   * Find workflow exit points (end nodes)
   */
  static findEndNodes(workflow: WorkflowGraph): EndNode[] {
    return workflow.nodes.filter(isEndNode) as EndNode[];
  }

  /**
   * Get all nodes connected to a specific node
   */
  static getConnectedNodes(
    workflow: WorkflowGraph,
    nodeId: string,
  ): {
    incoming: WorkflowNode[];
    outgoing: WorkflowNode[];
  } {
    const node = workflow.nodes.find((n) => n.id === nodeId);

    const outgoing = node?.connections
      ? (Object.values(node.connections)
          .map((targetId) => workflow.nodes.find((n) => n.id === targetId))
          .filter(Boolean) as WorkflowNode[])
      : [];

    const incoming = workflow.nodes.filter(
      (n) => n.connections && Object.values(n.connections).includes(nodeId),
    );

    return { incoming, outgoing };
  }

  /**
   * Generate workflow summary for display
   */
  static generateWorkflowSummary(workflow: WorkflowGraph): {
    title: string;
    description: string;
    stats: string;
    tags: string[];
  } {
    const stats = WorkflowTransformer.extractWorkflowStats(workflow);

    return {
      title: workflow.metadata.name,
      description: workflow.metadata.description,
      stats: `${workflow.nodes.length} nodes, ${stats.totalConnections} connections, ${stats.complexity} complexity`,
      tags: workflow.metadata.tags || [],
    };
  }
}
