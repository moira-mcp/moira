/**
 * Type exports for web-backend
 *
 * Note: React Flow visualization types are handled by frontend.
 * Backend returns raw workflow data, frontend transforms for visualization.
 */

// Re-export workflow engine types (direct from src for tsx runtime)
export type {
  WorkflowGraph,
  GraphNode,
  StartNode,
  EndNode,
  AgentDirectiveNode,
  ConditionNode,
  SubgraphNode,
  StructuredCondition,
} from "@mcp-moira/workflow-engine";

export { GraphValidator } from "@mcp-moira/workflow-engine";
export {
  isStartNode,
  isEndNode,
  isAgentDirectiveNode,
  isConditionNode,
  isSubgraphNode,
} from "@mcp-moira/workflow-engine";

// Create WorkflowNode alias for compatibility
export type { GraphNode as WorkflowNode } from "@mcp-moira/workflow-engine";

// Export local API types
export * from "./api-types.js";
export * from "./express-types.js";
