/**
 * Core workflow type definitions for the frontend
 */

export type ConditionOperator =
  "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists" | "and" | "or" | "not";

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

/** A connection label as authored: plain text, or text plus the return it explains. */
export type ConnectionLabel = string | { label: string; cycle?: { cause: string; exit: string } };

/** One process block as authored in `progress.nodes`. */
export interface WorkflowProgressNode {
  id: string;
  label: string;
  connections?: { default?: string };
  content?: { summary?: string; details?: string[]; outcome?: string; next?: string };
}

export interface WorkflowProgress {
  title?: string;
  goal?: string;
  facts?: Array<{ label: string; value: string; tone?: string }>;
  nodes: WorkflowProgressNode[];
}

export interface BaseNode {
  type: string;
  id: string;
  /** The process block this node belongs to (`progress.nodes[].id`). */
  progressNodeId?: string;
  /** Human labels for connections, keyed like `connections`. */
  connectionLabels?: Record<string, ConnectionLabel>;
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

/** One routing case: the first case whose `when` holds selects `output`, a connection key. */
export interface RoutingCase {
  when: StructuredCondition;
  output: string;
}

export interface AgentDirectiveNode extends BaseNode {
  type: "agent-directive";
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  /** Expressions evaluated after the answer is validated and before routing. */
  expressions?: string[];
  /** Routing on the node's own validated answer; `success` when no case holds. */
  cases?: RoutingCase[];
  connections: { success: string; error?: string; timeout?: string } & Record<string, string>;
}

export interface ConditionNode extends BaseNode {
  type: "condition";
  expressions?: string[];
  cases: RoutingCase[];
  connections: { default: string; error?: string } & Record<string, string>;
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

export interface UserNotificationNode extends BaseNode {
  type: "user-notification";
  message: string;
  format?: "plain" | "markdown" | "html";
  silent?: boolean;
  attachProgressImage?: boolean;
  attachment?: {
    kind: "image" | "document";
    data: string;
    encoding: "base64";
    filename: string;
    mimeType: string;
  };
  connections: { default: string; error?: string };
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

export interface MaterializeFile {
  path: string;
  from?: string;
  content?: "";
}

export interface MaterializeNode extends BaseNode {
  type: "materialize";
  basePath: string;
  files: MaterializeFile[];
  connections: {
    success: string;
    error?: string;
  };
}

export type WorkflowNode =
  | StartNode
  | AgentDirectiveNode
  | ConditionNode
  | ExpressionNode
  | SubgraphNode
  | UserNotificationNode
  | ReadNoteNode
  | WriteNoteNode
  | UpsertNoteNode
  | MaterializeNode
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
  /** Any other JSON Schema keyword (enum, items, properties, pattern…) the declaration carries. */
  [keyword: string]: unknown;
}

export interface WorkflowGraph {
  id: string;
  metadata: WorkflowMetadata;
  nodes: WorkflowNode[];
  variables?: Record<string, WorkflowVariable>;
  /** Declared global variables, keyed by name (single source of truth). */
  variableRegistry?: Record<string, RegistryVariable>;
  /** The process definition: blocks in process order with their descriptions. */
  progress?: WorkflowProgress;
  systemReminder?: string;
  runtimePolicy?: Record<string, unknown>;
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
