/** Authoring types share the engine's definition; API and view records remain browser-local. */
import type {
  WorkflowGraph as EngineWorkflowGraph,
  GraphNode,
  StartNode,
  EndNode,
  AgentDirectiveNode,
  ConditionNode,
  ExpressionNode,
  SubgraphNode,
  ReadNoteNode,
  WriteNoteNode,
  UpsertNoteNode,
  MaterializeNode,
} from "@mcp-moira/workflow-engine/types";

export type {
  ConditionOperator,
  ConditionValue,
  StructuredCondition,
  ConnectionLabel,
  BaseNode,
  RoutingCase,
  StartNode,
  AgentDirectiveNode,
  ConditionNode,
  EndNode,
  ExpressionNode,
  SubgraphNode,
  TelegramNotificationNode,
  UserNotificationNode,
  ReadNoteNode,
  WriteNoteNode,
  UpsertNoteNode,
  MaterializeFile,
  MaterializeNode,
  LockNode,
  TeleportNode,
  ExtensionNode,
  RegistryVariable,
  VariableRegistry,
  ProgressContentTemplate,
} from "@mcp-moira/workflow-engine/types";

export type WorkflowNode = GraphNode;
export type AuthoredWorkflowGraph = EngineWorkflowGraph;
/** A graph loaded by the API has the identity assigned on save. */
export type WorkflowGraph = EngineWorkflowGraph & { id: string };
export type WorkflowMetadata = EngineWorkflowGraph["metadata"];
export type WorkflowProgress = NonNullable<EngineWorkflowGraph["progress"]>;
export type WorkflowProgressNode = WorkflowProgress["nodes"][number];

export interface ExecutionContext {
  variables: Record<string, unknown>;
  nodeStates: Record<string, unknown>;
  executionId: string;
  workflowId: string;
}

export interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  currentNodeId: string | null;
  globalContext: ExecutionContext;
  // "running" includes active work and input waits; "completed" is terminal.
  status: "running" | "completed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  errors?: ExecutionError[]; // Error history
}

// Execution error entry in this browser record
export interface ExecutionError {
  timestamp: number;
  nodeId: string;
  errorType: "validation" | "handler" | "system";
  message: string;
  input?: unknown;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface ValidationWarning {
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
  suggestion?: string;
}

export function isStartNode(node: WorkflowNode): node is StartNode {
  return node.type === "start";
}

export function isEndNode(node: WorkflowNode): node is EndNode {
  return node.type === "end";
}

export function isAgentDirectiveNode(node: WorkflowNode): node is AgentDirectiveNode {
  return node.type === "agent-directive";
}

export function isConditionNode(node: WorkflowNode): node is ConditionNode {
  return node.type === "condition";
}

export function isExpressionNode(node: WorkflowNode): node is ExpressionNode {
  return node.type === "expression";
}

export function isSubgraphNode(node: WorkflowNode): node is SubgraphNode {
  return node.type === "subgraph";
}

export function isReadNoteNode(node: WorkflowNode): node is ReadNoteNode {
  return node.type === "read-note";
}

export function isWriteNoteNode(node: WorkflowNode): node is WriteNoteNode {
  return node.type === "write-note";
}

export function isUpsertNoteNode(node: WorkflowNode): node is UpsertNoteNode {
  return node.type === "upsert-note";
}

export function isMaterializeNode(node: WorkflowNode): node is MaterializeNode {
  return node.type === "materialize";
}

export interface WorkflowFileInfo {
  id: string;
  slug: string;
  ownerHandle: string;
  ownerName: string;
  visibility: "public" | "private";
  accessType?: "owner" | "shared" | "public";
  filePath: string;
  metadata: WorkflowMetadata;
  /** The cached result; `status` tells a flow never validated (`unknown`) from an invalid one. */
  validation: ValidationResult & { status?: "valid" | "invalid" | "unknown" };
  lastModified: number;
  /** Definition revision; every stored write of the graph advances it. Saves send it back as `expectedRevision`. */
  revision: number;
  fileSize: number;
}

export interface AgentDirective {
  processId: string;
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  error?: string;
}
