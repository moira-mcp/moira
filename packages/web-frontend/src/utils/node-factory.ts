/**
 * Node Factory and Registration System
 * Creates and manages React Flow node types for MCP workflow visualization
 */

import React from "react";
import { Node, NodeTypes } from "@xyflow/react";
import {
  WorkflowNode,
  StartNode as StartNodeType,
  AgentDirectiveNode as AgentDirectiveNodeType,
  ConditionNode as ConditionNodeType,
  EndNode as EndNodeType,
  SubgraphNode as SubgraphNodeType,
  ReadNoteNode as ReadNoteNodeType,
  WriteNoteNode as WriteNoteNodeType,
  UpsertNoteNode as UpsertNoteNodeType,
  isStartNode,
  isAgentDirectiveNode,
  isConditionNode,
  isEndNode,
  isExpressionNode,
  isSubgraphNode,
  isReadNoteNode,
  isWriteNoteNode,
  isUpsertNoteNode,
  ExpressionNode as ExpressionNodeType,
  StructuredCondition,
} from "../types";
import {
  MoiraReactFlowNode,
  StartNodeData,
  AgentDirectiveNodeData,
  ConditionNodeData,
  TelegramNodeData,
  SubgraphNodeData,
  ReadNoteNodeData,
  WriteNoteNodeData,
  UpsertNoteNodeData,
  EndNodeData,
  ExpressionNodeData,
  DEFAULT_NODE_STYLES,
  WorkflowValidationStatus,
} from "../types";

// Import unified compact node component
import CompactNode from "../components/nodes/CompactNode";

/**
 * Node type registration for React Flow
 * All node types use CompactNode for unified compact visualization
 * Defined outside component to prevent re-renders
 */
export const nodeTypes: NodeTypes = {
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
};

/**
 * Factory class for creating React Flow nodes from MCP workflow data
 */
export class NodeFactory {
  /**
   * Create React Flow node from MCP workflow node
   */
  static createReactFlowNode(
    mcpNode: WorkflowNode,
    validationStatus?: WorkflowValidationStatus,
  ): MoiraReactFlowNode {
    const nodeValidation = validationStatus?.nodeValidation[mcpNode.id];
    const validationState = nodeValidation?.isValid
      ? "valid"
      : nodeValidation
        ? "invalid"
        : "warning";

    const baseNodeData = {
      nodeId: mcpNode.id,
      validationStatus: validationState,
      validationErrors: nodeValidation?.errors || [],
      validationWarnings: nodeValidation?.warnings || [],
      originalNode: mcpNode,
    };

    if (isStartNode(mcpNode)) {
      return this.createStartNode(mcpNode, baseNodeData);
    }

    if (isAgentDirectiveNode(mcpNode)) {
      return this.createAgentDirectiveNode(mcpNode, baseNodeData);
    }

    if (isConditionNode(mcpNode)) {
      return this.createConditionNode(mcpNode, baseNodeData);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((mcpNode as any).type === "telegram-notification") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return this.createTelegramNode(mcpNode as any, baseNodeData);
    }

    if (isExpressionNode(mcpNode)) {
      return this.createExpressionNode(mcpNode, baseNodeData);
    }

    if (isSubgraphNode(mcpNode)) {
      return this.createSubgraphNode(mcpNode, baseNodeData);
    }

    if (isReadNoteNode(mcpNode)) {
      return this.createReadNoteNode(mcpNode, baseNodeData);
    }

    if (isWriteNoteNode(mcpNode)) {
      return this.createWriteNoteNode(mcpNode, baseNodeData);
    }

    if (isUpsertNoteNode(mcpNode)) {
      return this.createUpsertNoteNode(mcpNode, baseNodeData);
    }

    if (isEndNode(mcpNode)) {
      return this.createEndNode(mcpNode, baseNodeData);
    }

    // Exhaustive check: all WorkflowNode types must be handled above
    const _exhaustive: never = mcpNode;
    throw new Error(`Unsupported node type: ${(_exhaustive as WorkflowNode).type}`);
  }

  /**
   * Create Start Node
   */
  private static createStartNode(
    mcpNode: StartNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: StartNodeData = {
      ...baseData,
      nodeType: "start",
      label: mcpNode.metadata?.displayName || "Start",
      description: mcpNode.metadata?.description || "Workflow entry point",
      initialData: mcpNode.initialData,
      defaultConnection: mcpNode.connections.default,
      color: DEFAULT_NODE_STYLES.start.colors.primary,
      icon: DEFAULT_NODE_STYLES.start.icon,
    };

    return {
      id: mcpNode.id,
      type: "start",
      position: { x: 0, y: 0 }, // Will be positioned by layout algorithm
      data: nodeData,
      draggable: true, // Allow user to drag nodes
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Agent Directive Node
   */
  private static createAgentDirectiveNode(
    mcpNode: AgentDirectiveNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: AgentDirectiveNodeData = {
      ...baseData,
      nodeType: "agent-directive",
      label: mcpNode.metadata?.displayName || "Agent Task",
      description: this.truncateText(mcpNode.directive, 100),
      directive: mcpNode.directive,
      completionCondition: mcpNode.completionCondition,
      inputSchema: mcpNode.inputSchema,
      maxRetries: mcpNode.maxRetries,
      retryMessage: mcpNode.retryMessage,
      connections: mcpNode.connections,
      color: DEFAULT_NODE_STYLES["agent-directive"].colors.primary,
      icon: DEFAULT_NODE_STYLES["agent-directive"].icon,
    };

    return {
      id: mcpNode.id,
      type: "agent-directive",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Condition Node
   */
  private static createConditionNode(
    mcpNode: ConditionNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const conditionSummary = this.generateConditionSummary(mcpNode.condition);

    const nodeData: ConditionNodeData = {
      ...baseData,
      nodeType: "condition",
      label: mcpNode.metadata?.displayName || "Decision",
      description: conditionSummary,
      condition: mcpNode.condition,
      conditionSummary,
      trueConnection: mcpNode.connections.true,
      falseConnection: mcpNode.connections.false,
      color: DEFAULT_NODE_STYLES.condition.colors.primary,
      icon: DEFAULT_NODE_STYLES.condition.icon,
    };

    return {
      id: mcpNode.id,
      type: "condition",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Telegram Node
   */
  private static createTelegramNode(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mcpNode: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: TelegramNodeData = {
      ...baseData,
      nodeType: "telegram-notification",
      label: "Telegram Notification",
      description: this.truncateText(mcpNode.message, 80),
      message: mcpNode.message,
      chatId: mcpNode.chatId,
      parseMode: mcpNode.parseMode,
      color: DEFAULT_NODE_STYLES["telegram-notification"].colors.primary,
      icon: DEFAULT_NODE_STYLES["telegram-notification"].icon,
    };

    return {
      id: mcpNode.id,
      type: "telegram-notification",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Expression Node
   */
  private static createExpressionNode(
    mcpNode: ExpressionNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: ExpressionNodeData = {
      ...baseData,
      nodeType: "expression",
      label: mcpNode.metadata?.displayName || "Expression",
      description: mcpNode.metadata?.description || "Evaluate expressions",
      expressions: mcpNode.expressions,
      defaultConnection: mcpNode.connections.default,
      errorConnection: mcpNode.connections.error,
      color: DEFAULT_NODE_STYLES.expression.colors.primary,
      icon: DEFAULT_NODE_STYLES.expression.icon,
    };

    return {
      id: mcpNode.id,
      type: "expression",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create End Node
   */
  private static createEndNode(
    mcpNode: EndNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: EndNodeData = {
      ...baseData,
      nodeType: "end",
      label: mcpNode.metadata?.displayName || "End",
      description: mcpNode.metadata?.description || "Workflow completion",
      finalOutput: mcpNode.finalOutput,
      outputDescription: mcpNode.finalOutput?.join(", ") || "No output specified",
      color: DEFAULT_NODE_STYLES.end.colors.primary,
      icon: DEFAULT_NODE_STYLES.end.icon,
    };

    return {
      id: mcpNode.id,
      type: "end",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Subgraph Node
   */
  private static createSubgraphNode(
    mcpNode: SubgraphNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: SubgraphNodeData = {
      ...baseData,
      nodeType: "subgraph",
      label: mcpNode.metadata?.displayName || "Subgraph",
      description: mcpNode.metadata?.description || "Execute subgraph workflow",
      graphId: mcpNode.graphId,
      inputMapping: mcpNode.inputMapping,
      outputMapping: mcpNode.outputMapping,
      connections: mcpNode.connections,
      color: DEFAULT_NODE_STYLES.subgraph.colors.primary,
      icon: DEFAULT_NODE_STYLES.subgraph.icon,
    };

    return {
      id: mcpNode.id,
      type: "subgraph",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Read Note Node
   */
  private static createReadNoteNode(
    mcpNode: ReadNoteNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: ReadNoteNodeData = {
      ...baseData,
      nodeType: "read-note",
      label: mcpNode.metadata?.displayName || "Read Note",
      description: mcpNode.metadata?.description || `Read → ${mcpNode.outputVariable}`,
      outputVariable: mcpNode.outputVariable,
      filter: mcpNode.filter,
      singleMode: mcpNode.singleMode,
      defaultConnection: mcpNode.connections.default,
      errorConnection: mcpNode.connections.error,
      color: DEFAULT_NODE_STYLES["read-note"].colors.primary,
      icon: DEFAULT_NODE_STYLES["read-note"].icon,
    };

    return {
      id: mcpNode.id,
      type: "read-note",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Write Note Node
   */
  private static createWriteNoteNode(
    mcpNode: WriteNoteNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: WriteNoteNodeData = {
      ...baseData,
      nodeType: "write-note",
      label: mcpNode.metadata?.displayName || "Write Note",
      description: mcpNode.metadata?.description || `Write from ${mcpNode.source}`,
      key: mcpNode.key,
      source: mcpNode.source,
      tags: mcpNode.tags,
      batchMode: mcpNode.batchMode,
      defaultConnection: mcpNode.connections.default,
      errorConnection: mcpNode.connections.error,
      color: DEFAULT_NODE_STYLES["write-note"].colors.primary,
      icon: DEFAULT_NODE_STYLES["write-note"].icon,
    };

    return {
      id: mcpNode.id,
      type: "write-note",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Create Upsert Note Node
   */
  private static createUpsertNoteNode(
    mcpNode: UpsertNoteNodeType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    baseData: any,
  ): MoiraReactFlowNode {
    const nodeData: UpsertNoteNodeData = {
      ...baseData,
      nodeType: "upsert-note",
      label: mcpNode.metadata?.displayName || "Upsert Note",
      description: mcpNode.metadata?.description || `Upsert ${mcpNode.keyTemplate}`,
      search: mcpNode.search,
      keyTemplate: mcpNode.keyTemplate,
      value: mcpNode.value,
      tags: mcpNode.tags,
      outputVariable: mcpNode.outputVariable,
      defaultConnection: mcpNode.connections.default,
      errorConnection: mcpNode.connections.error,
      color: DEFAULT_NODE_STYLES["upsert-note"].colors.primary,
      icon: DEFAULT_NODE_STYLES["upsert-note"].icon,
    };

    return {
      id: mcpNode.id,
      type: "upsert-note",
      position: { x: 0, y: 0 },
      data: nodeData,
      draggable: true,
      selectable: true,
      deletable: false,
    };
  }

  /**
   * Generate human-readable condition summary
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static generateConditionSummary(condition: any): string {
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
          conditions
            ?.map((c: StructuredCondition) => this.generateConditionSummary(c))
            .join(" AND ") || "AND condition"
        );
      case "or":
        return (
          conditions
            ?.map((c: StructuredCondition) => this.generateConditionSummary(c))
            .join(" OR ") || "OR condition"
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static valueToString(value: any): string {
    if (value && typeof value === "object" && "contextPath" in value) {
      return `{${value.contextPath}}`;
    }
    return String(value);
  }

  /**
   * Truncate text for display purposes
   */
  private static truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
  }

  /**
   * Batch create nodes from workflow
   */
  static createNodesFromWorkflow(
    workflow: { nodes: WorkflowNode[] },
    validationStatus?: WorkflowValidationStatus,
  ): MoiraReactFlowNode[] {
    return workflow.nodes.map((node) => this.createReactFlowNode(node, validationStatus));
  }

  /**
   * Create demo nodes for testing and development
   */
  static createDemoNodes(): MoiraReactFlowNode[] {
    const demoWorkflow = {
      nodes: [
        {
          type: "start",
          id: "start",
          initialData: { userId: "demo-user", environment: "development" },
          connections: { default: "process-data" },
        },
        {
          type: "agent-directive",
          id: "process-data",
          directive: "Process the user data and validate all required fields",
          completionCondition: "Data processing completed successfully",
          inputSchema: {
            type: "object",
            properties: {
              result: { type: "string", description: "Processing result" },
              score: { type: "number", description: "Quality score" },
            },
            required: ["result", "score"],
          },
          connections: { success: "check-quality" },
        },
        {
          type: "condition",
          id: "check-quality",
          condition: {
            operator: "gte",
            left: { contextPath: "score" },
            right: 8,
          },
          connections: { true: "high-quality", false: "low-quality" },
        },
        {
          type: "end",
          id: "high-quality",
          finalOutput: ["result", "score"],
        },
        {
          type: "end",
          id: "low-quality",
          finalOutput: ["result"],
        },
      ] as WorkflowNode[],
    };

    const demoValidation: WorkflowValidationStatus = {
      isValid: true,
      nodeValidation: {
        start: { isValid: true, errors: [], warnings: [] },
        "process-data": { isValid: true, errors: [], warnings: [] },
        "check-quality": { isValid: true, errors: [], warnings: [] },
        "high-quality": { isValid: true, errors: [], warnings: [] },
        "low-quality": { isValid: true, errors: [], warnings: [] },
      },
      globalErrors: [],
      globalWarnings: [],
    };

    return this.createNodesFromWorkflow(demoWorkflow, demoValidation);
  }
}

/**
 * Node configuration and customization
 */
export const NodeConfiguration = {
  /**
   * Get default node dimensions
   */
  getNodeDimensions: (nodeType: string) => {
    const config = DEFAULT_NODE_STYLES[nodeType as keyof typeof DEFAULT_NODE_STYLES];
    return config
      ? {
          width: config.minWidth,
          height: config.minHeight,
        }
      : {
          width: 150,
          height: 100,
        };
  },

  /**
   * Get node style configuration
   */
  getNodeStyle: (nodeType: string, validationStatus: "valid" | "invalid" | "warning" = "valid") => {
    const config = DEFAULT_NODE_STYLES[nodeType as keyof typeof DEFAULT_NODE_STYLES];
    if (!config) return {};

    let borderColor = config.colors.border;

    // Override border color based on validation status
    if (validationStatus === "invalid") {
      borderColor = "#DC2626"; // Red
    } else if (validationStatus === "warning") {
      borderColor = "#D97706"; // Orange
    }

    return {
      backgroundColor: config.colors.background,
      borderColor,
      color: config.colors.text,
    };
  },

  /**
   * Create node style classes
   */
  getNodeClasses: (
    nodeType: string,
    validationStatus: "valid" | "invalid" | "warning" = "valid",
    selected: boolean = false,
  ): string => {
    const classes = ["mcp-node", `${nodeType}-node`, validationStatus];

    if (selected) {
      classes.push("selected");
    }

    return classes.join(" ");
  },
};

/**
 * Node interaction utilities
 */
export const NodeInteraction = {
  /**
   * Handle node selection
   */
  onNodeClick: (node: Node, event: React.MouseEvent) => {
    // Prevent event bubbling
    event.stopPropagation();

    // Custom selection logic can be added here
    return {
      nodeId: node.id,
      nodeType: node.type,
      nodeData: node.data,
    };
  },

  /**
   * Handle node hover
   */
  onNodeMouseEnter: (node: Node) => {
    // Custom hover logic can be added here
    return {
      nodeId: node.id,
      action: "hover-start",
    };
  },

  /**
   * Handle node hover end
   */
  onNodeMouseLeave: (node: Node) => {
    // Custom hover end logic can be added here
    return {
      nodeId: node.id,
      action: "hover-end",
    };
  },

  /**
   * Handle double click for node details
   */
  onNodeDoubleClick: (node: Node, event: React.MouseEvent) => {
    // Prevent event bubbling
    event.stopPropagation();

    // Open details modal/panel logic can be added here
    return {
      nodeId: node.id,
      action: "show-details",
      nodeData: node.data,
    };
  },
};

/**
 * Node validation utilities
 */
export const NodeValidation = {
  /**
   * Validate node for React Flow compatibility
   */
  validateNode: (node: WorkflowNode | undefined | null): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];

    // Basic validation
    if (!node || !node.id) {
      errors.push("Node must have an ID");
    }

    if (!node.type) {
      errors.push("Node must have a type");
    }

    // Type-specific validation
    switch (node.type) {
      case "start":
        if (isStartNode(node)) {
          if (!node.connections?.default) {
            errors.push("Start node must have default connection");
          }
        }
        break;

      case "agent-directive":
        if (isAgentDirectiveNode(node)) {
          if (!node.directive) {
            errors.push("Agent directive node must have directive");
          }
          if (!node.completionCondition) {
            errors.push("Agent directive node must have completion condition");
          }
          if (!node.connections?.success) {
            errors.push("Agent directive node must have success connection");
          }
        }
        break;

      case "condition":
        if (isConditionNode(node)) {
          if (!node.condition) {
            errors.push("Condition node must have condition");
          }
          if (!node.connections?.true || !node.connections?.false) {
            errors.push("Condition node must have both true and false connections");
          }
        }
        break;

      case "end":
        if (isEndNode(node)) {
          if (node.connections && Object.keys(node.connections).length > 0) {
            errors.push("End node should not have connections");
          }
        }
        break;

      case "subgraph":
        if (isSubgraphNode(node)) {
          if (!node.connections?.success) {
            errors.push("Subgraph node must have success connection");
          }
        }
        break;

      case "expression":
        if (isExpressionNode(node)) {
          if (!node.expressions || node.expressions.length === 0) {
            errors.push("Expression node must have at least one expression");
          }
          if (!node.connections?.default) {
            errors.push("Expression node must have default connection");
          }
        }
        break;

      case "read-note":
        if (isReadNoteNode(node)) {
          if (!node.connections?.default) {
            errors.push("Read-note node must have default connection");
          }
        }
        break;

      case "write-note":
        if (isWriteNoteNode(node)) {
          if (!node.connections?.default) {
            errors.push("Write-note node must have default connection");
          }
        }
        break;

      case "upsert-note":
        if (isUpsertNoteNode(node)) {
          if (!node.connections?.default) {
            errors.push("Upsert-note node must have default connection");
          }
        }
        break;

      default: {
        const _exhaustive: never = node;
        errors.push(`Unknown node type: ${(_exhaustive as WorkflowNode).type}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  },

  /**
   * Validate all nodes in workflow
   */
  validateWorkflowNodes: (
    nodes: WorkflowNode[],
  ): {
    isValid: boolean;
    nodeValidation: Record<string, { isValid: boolean; errors: string[] }>;
    globalErrors: string[];
  } => {
    const nodeValidation: Record<string, { isValid: boolean; errors: string[] }> = {};
    const globalErrors: string[] = [];
    let allValid = true;

    // Validate individual nodes
    for (const node of nodes) {
      if (!node?.id) continue;
      const validation = { isValid: true, errors: [] };
      nodeValidation[node!.id] = validation;

      if (!validation.isValid) {
        allValid = false;
      }
    }

    // Global validations
    const startNodes = nodes.filter(isStartNode);
    if (startNodes.length === 0) {
      globalErrors.push("Workflow must have at least one start node");
      allValid = false;
    } else if (startNodes.length > 1) {
      globalErrors.push("Workflow should have only one start node");
    }

    const endNodes = nodes.filter(isEndNode);
    if (endNodes.length === 0) {
      globalErrors.push("Workflow should have at least one end node");
    }

    // Check for orphaned nodes
    const connectedNodeIds = new Set<string>();
    nodes.forEach((node) => {
      if (node.connections) {
        Object.values(node.connections).forEach((targetId) => {
          connectedNodeIds.add(targetId);
        });
      }
    });

    nodes.forEach((node) => {
      if (node.type !== "start" && !connectedNodeIds.has(node.id)) {
        globalErrors.push(`Node ${node.id} appears to be orphaned (no incoming connections)`);
      }
    });

    return {
      isValid: allValid && globalErrors.length === 0,
      nodeValidation,
      globalErrors,
    };
  },
};

/**
 * Export compact node component
 */
export { CompactNode };

/**
 * Default export for easy importing
 */
export default {
  nodeTypes,
  NodeFactory,
  NodeConfiguration,
  NodeInteraction,
  NodeValidation,
};
