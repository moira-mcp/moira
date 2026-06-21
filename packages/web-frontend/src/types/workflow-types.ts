/**
 * Core workflow type definitions for the frontend
 */

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "exists"
  | "and"
  | "or"
  | "not";

export type ConditionValue =
  | string
  | number
  | boolean
  | null
  | {
      contextPath: string;
    };

export interface StructuredCondition {
  operator: ConditionOperator;
  left?: ConditionValue;
  right?: ConditionValue;
  conditions?: StructuredCondition[];
  condition?: StructuredCondition;
  value?: ConditionValue;
}

export interface BaseNode {
  type: string;
  id: string;
  metadata?: {
    displayName?: string;
    description?: string;
    icon?: string;
    color?: string;
    tags?: string[];
    estimatedDuration?: number;
  };
  timeout?: number;
  connections?: Record<string, string>;
}

export interface StartNode extends BaseNode {
  type: "start";
  initialData?: Record<string, unknown>;
  connections: {
    default: string;
  };
}

export interface AgentDirectiveNode extends BaseNode {
  type: "agent-directive";
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  maxRetries?: number;
  retryMessage?: string;
  currentRetries?: number;
  connections: {
    success: string;
    error?: string;
    timeout?: string;
    maxRetriesExceeded?: string;
  };
}

export interface ConditionNode extends BaseNode {
  type: "condition";
  condition: StructuredCondition;
  connections: {
    true: string;
    false: string;
  };
}

export interface EndNode extends BaseNode {
  type: "end";
  finalOutput?: string[];
}

export interface ExpressionNode extends BaseNode {
  type: "expression";
  expressions: string[];
  connections: {
    default: string;
    error?: string;
  };
}

export interface SubgraphNode extends BaseNode {
  type: "subgraph";
  graphId: string;
  inputMapping?: Record<string, string>;
  outputMapping?: Record<string, string>;
  connections: {
    success: string;
    error?: string;
  };
}

// Note nodes - automatic nodes for persistent storage
export interface ReadNoteNode extends BaseNode {
  type: "read-note";
  outputVariable: string;
  filter?: {
    tag?: string;
    keyPattern?: string;
    keySearch?: string;
  };
  singleMode?: boolean;
  connections: {
    default: string;
    error?: string;
  };
}

export interface WriteNoteNode extends BaseNode {
  type: "write-note";
  key?: string;
  source: string;
  tags?: string[];
  batchMode?: boolean;
  connections: {
    default: string;
    error?: string;
  };
}

export interface UpsertNoteNode extends BaseNode {
  type: "upsert-note";
  search?: {
    tag?: string;
    keyPattern?: string;
  };
  keyTemplate: string;
  value: string;
  tags?: string[];
  outputVariable?: string;
  connections: {
    default: string;
    error?: string;
  };
}

export type WorkflowNode =
  | StartNode
  | AgentDirectiveNode
  | ConditionNode
  | ExpressionNode
  | SubgraphNode
  | ReadNoteNode
  | WriteNoteNode
  | UpsertNoteNode
  | EndNode;

export interface WorkflowMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  philosophy?: string;
}

export interface WorkflowVariable {
  name: string;
  description?: string;
  type?: string;
  default?: unknown;
  required?: boolean;
}

/** Declared global variable in the workflow's variableRegistry (single source of truth). */
export interface RegistryVariable {
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  description: string;
  default?: unknown;
}

export interface WorkflowGraph {
  id: string;
  metadata: WorkflowMetadata;
  nodes: WorkflowNode[];
  variables?: Record<string, WorkflowVariable>;
  /** Declared global variables, keyed by name (single source of truth). */
  variableRegistry?: Record<string, RegistryVariable>;
}

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
  // Issue #386: 2-status model - "running" (active) and "completed" (finished)
  status: "running" | "completed";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  errors?: ExecutionError[]; // Issue #386: Error history
}

// Issue #386: Execution error entry
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

export interface WorkflowFileInfo {
  id: string;
  slug: string;
  ownerHandle: string;
  ownerName: string;
  visibility: "public" | "private";
  accessType?: "owner" | "shared" | "public";
  filePath: string;
  metadata: WorkflowMetadata;
  validation: ValidationResult;
  lastModified: number;
  fileSize: number;
}

export interface AgentDirective {
  processId: string;
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  error?: string;
}
