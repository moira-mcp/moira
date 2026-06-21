/**
 * Complete node type definitions for Graph Workflow Engine
 * All 6 node types with architectural improvements
 */

import { BaseNode } from "./base-types.js";
import { StructuredCondition } from "./structured-condition.js";
import { TelegramNodeConfig } from "./telegram-types.js";

/**
 * Variable definition with required description
 */
export interface VariableDefinition {
  description: string;
  value?: unknown;
}

/**
 * Structured initialData with variables containing descriptions
 */
export interface InitialData {
  variables?: Record<string, VariableDefinition>;
}

/**
 * Global variable registry entry — the single source of truth for a workflow-global
 * variable's schema. The entry IS a JSON Schema property: `type` and `description` are
 * required, and any JSON Schema keyword (enum, items, properties, pattern, format,
 * minimum/maximum, minLength/minItems, ...) may be added to constrain the variable's
 * value. The whole entry is carried into the schema the agent is validated against, so
 * constraints declared here are enforced on the agent's response.
 */
export interface RegistryVariable {
  /** JSON Schema primitive type of the variable's value. */
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  /** Required human-readable description (single source of truth). */
  description: string;
  /** Optional default value, applied at workflow start when present. */
  default?: unknown;
  /** Allowed values — the agent's response is validated against this set. */
  enum?: unknown[];
  /** Schema of array elements (when type is "array"). */
  items?: unknown;
  /** Schema of object members (when type is "object"). */
  properties?: Record<string, unknown>;
  /** Any other JSON Schema keyword (pattern, format, minLength, minimum, ...). */
  [keyword: string]: unknown;
}

/**
 * Global variable registry: declared once per workflow, keyed by variable name.
 * Bare-name references in directives/conditions/templates resolve against this map.
 */
export type VariableRegistry = Record<string, RegistryVariable>;

// 1. Start Node - Entry point (convention: id="start")
export interface StartNode extends BaseNode {
  type: "start";
  id: string; // Convention: should be "start" but not enforced by types
  initialData?: InitialData;
  connections: {
    default: string; // Required connection (not optional)
  };
}

// 2. End Node - Exit point (convention: id="end")
export interface EndNode extends BaseNode {
  type: "end";
  id: string; // Convention: should be "end" but not enforced by types
  finalOutput?: string[]; // Context keys to include in final result
  // Explicitly no connections property - terminal node
}

// 3. Agent Directive Node - Async agent tasks with safety features
export interface AgentDirectiveNode extends BaseNode {
  type: "agent-directive";
  directive: string;
  completionCondition: string;
  // JSON Schema object (standard format) describing the node's LOCAL outputs in `properties`.
  // The optional `globalInputs` array (string[]) lists, by name, the GLOBAL variables this node
  // writes — those names are declared once in the workflow variableRegistry (single source of
  // truth for their type/description). A result key listed in `globalInputs` is routed to the
  // global scope; a key described in `properties` is routed to the node-local scope; a key in
  // neither is rejected.
  inputSchema?: Record<string, unknown>;

  // Safety features from architect feedback
  maxRetries?: number; // Prevent infinite validation loops (default: 3)
  retryMessage?: string; // Custom message for retry attempts
  currentRetries?: number; // Internal counter (runtime state)

  connections: {
    success: string; // Next node on successful completion
    error?: string; // Next node on error (v1: structure ready, not used)
    timeout?: string; // Next node on timeout
    maxRetriesExceeded?: string; // Next node when retries exhausted
  };
}

// 4. Condition Node - Structured condition evaluation
export interface ConditionNode extends BaseNode {
  type: "condition";
  condition: StructuredCondition; // NEW: Structured instead of string eval
  connections: {
    true: string; // Next node when condition evaluates to true
    false: string; // Next node when condition evaluates to false
  };
}

// 5. Subgraph Node - Workflow composition and reuse
export interface SubgraphNode extends BaseNode {
  type: "subgraph";
  graphId: string; // Reference to another workflow graph
  inputMapping: Record<string, string>; // parentContext.key -> subgraphContext.key
  outputMapping: Record<string, string>; // subgraphContext.key -> parentContext.key
  connections: {
    success: string; // Next node when subgraph completes successfully
    error?: string; // Next node when subgraph fails
  };
}

// 6. Telegram Notification Node - Automated external notifications
export interface TelegramNotificationNode extends BaseNode, TelegramNodeConfig {
  type: "telegram-notification";
  connections: {
    default: string; // Next node after sending notification (required)
    error?: string; // Next node on telegram API failure (optional)
  };
}

// 7. Expression Node - Safe arithmetic operations on context variables
export interface ExpressionNode extends BaseNode {
  type: "expression";
  /**
   * Array of expressions to evaluate in order.
   * Each expression can be:
   * - Assignment: "a = b + 1"
   * - Simple arithmetic: "x + y * 2"
   *
   * Supports: +, -, *, /, parentheses, context variables (including nested: "step.index")
   * Variables are read from and written to execution context.
   */
  expressions: string[];
  connections: {
    default: string; // Next node after expressions evaluated
    error?: string; // Next node on evaluation error (optional)
  };
}

// 8. Read Note Node - AUTOMATIC node for reading notes into context
export interface ReadNoteNode extends BaseNode {
  type: "read-note";
  /**
   * Output variable name for storing results
   * The notes will be written to context.variables[outputVariable]
   */
  outputVariable: string;
  /**
   * Filter criteria - all support template expressions {{variable}}
   */
  filter?: {
    tag?: string; // Filter by tag
    keyPattern?: string; // Filter by key pattern (prefix match)
    keySearch?: string; // Search in key (contains)
  };
  /**
   * If true and exactly one note matches, store as object instead of array
   * Default: false (always array)
   */
  singleMode?: boolean;
  connections: {
    default: string; // Next node after reading notes
    error?: string; // Next node on error (optional)
  };
}

// 9. Write Note Node - AUTOMATIC node for writing notes from context
export interface WriteNoteNode extends BaseNode {
  type: "write-note";
  /**
   * Key for the note (supports template expressions)
   * In single mode: the key for the note
   * In batch mode: ignored (keys come from input array)
   */
  key?: string;
  /**
   * Source of data to write (supports template expressions)
   * In single mode: the value to write
   * In batch mode: context variable containing array of {key, value, tags?}
   */
  source: string;
  /**
   * Tags to apply (supports template expressions)
   * In single mode: tags for the note
   * In batch mode: default tags for all notes (can be overridden in array items)
   */
  tags?: string[];
  /**
   * If true, source is expected to be array of {key, value, tags?}
   * Each item creates/updates a separate note
   * Default: false (single mode)
   */
  batchMode?: boolean;
  connections: {
    default: string; // Next node after writing notes
    error?: string; // Next node on error (optional)
  };
}

// 10. Upsert Note Node - AUTOMATIC node for update-or-create operations
export interface UpsertNoteNode extends BaseNode {
  type: "upsert-note";
  /**
   * Search criteria to find existing note
   * If note found: update it
   * If not found: create new with keyTemplate
   */
  search?: {
    tag?: string; // Search by tag
    keyPattern?: string; // Search by key pattern (prefix match)
  };
  /**
   * Key template for creating new note (supports template expressions)
   * Used when no existing note is found
   */
  keyTemplate: string;
  /**
   * Value to write (supports template expressions)
   */
  value: string;
  /**
   * Tags to apply (supports template expressions)
   */
  tags?: string[];
  /**
   * Output variable name for storing result info
   * Stores: {key, version, created: boolean}
   */
  outputVariable?: string;
  connections: {
    default: string; // Next node after upsert
    error?: string; // Next node on error (optional)
  };
}

// 11. Lock Node - PIN-based execution gate that pauses workflow until unlocked
export interface LockNode extends BaseNode {
  type: "lock";
  /**
   * Reason for locking (supports template expressions {{variable}})
   */
  reason: string;
  connections: {
    unlocked: string; // Flow continues after unlock (PIN, Telegram approval, admin/owner unlock)
  };
}

// 12. Teleport Node - Jump target reachable only via explicit teleport
export interface TeleportNode extends BaseNode {
  type: "teleport";
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
  hint: string; // Human-readable description of when agent should use this teleport
  connections: {
    success: string; // Next node after teleport input is provided
    error?: string;
  };
}

// Union type for all node types
export type GraphNode =
  | StartNode
  | EndNode
  | AgentDirectiveNode
  | ConditionNode
  | SubgraphNode
  | TelegramNotificationNode
  | ExpressionNode
  | ReadNoteNode
  | WriteNoteNode
  | UpsertNoteNode
  | LockNode
  | TeleportNode;

// Type guards for node types
export function isStartNode(node: GraphNode): node is StartNode {
  return node.type === "start";
}

export function isEndNode(node: GraphNode): node is EndNode {
  return node.type === "end";
}

export function isAgentDirectiveNode(node: GraphNode): node is AgentDirectiveNode {
  return node.type === "agent-directive";
}

export function isConditionNode(node: GraphNode): node is ConditionNode {
  return node.type === "condition";
}

export function isSubgraphNode(node: GraphNode): node is SubgraphNode {
  return node.type === "subgraph";
}

export function isTelegramNotificationNode(node: GraphNode): node is TelegramNotificationNode {
  return node.type === "telegram-notification";
}

export function isExpressionNode(node: GraphNode): node is ExpressionNode {
  return node.type === "expression";
}

export function isReadNoteNode(node: GraphNode): node is ReadNoteNode {
  return node.type === "read-note";
}

export function isWriteNoteNode(node: GraphNode): node is WriteNoteNode {
  return node.type === "write-note";
}

export function isUpsertNoteNode(node: GraphNode): node is UpsertNoteNode {
  return node.type === "upsert-note";
}

export function isLockNode(node: GraphNode): node is LockNode {
  return node.type === "lock";
}

export function isTeleportNode(node: GraphNode): node is TeleportNode {
  return node.type === "teleport";
}

/**
 * Output-scope declaration of a node: which result keys go to the global scope (by name,
 * referencing the workflow variableRegistry) and which are node-local outputs (described in the
 * node's inputSchema.properties). Used by the engine to route a node result by declaration.
 */
export interface NodeOutputScope {
  /** Names of global variables this node writes (from inputSchema.globalInputs). */
  globalInputs: Set<string>;
  /** Names of the node's local outputs (from inputSchema.properties). */
  localOutputs: Set<string>;
}

/** Extract a node's declared output scope from its inputSchema (tolerant of missing/legacy shape). */
export function getNodeOutputScope(node: GraphNode): NodeOutputScope {
  const globalInputs = new Set<string>();
  const localOutputs = new Set<string>();
  const schema = (node as { inputSchema?: unknown }).inputSchema;
  if (schema && typeof schema === "object") {
    const s = schema as { globalInputs?: unknown; properties?: unknown };
    if (Array.isArray(s.globalInputs)) {
      for (const name of s.globalInputs) {
        if (typeof name === "string") globalInputs.add(name);
      }
    }
    if (s.properties && typeof s.properties === "object") {
      for (const name of Object.keys(s.properties as Record<string, unknown>)) {
        localOutputs.add(name);
      }
    }
  }
  return { globalInputs, localOutputs };
}

/**
 * Produce an effective copy of a node whose inputSchema has its `globalInputs` names inlined as
 * normal `properties` — each global's full registry entry (the JSON Schema property) is carried in
 * whole, with the non-standard `globalInputs` key removed. This is the schema the agent sees and is
 * validated against — the agent never sees the global/local distinction. Routing of the result still
 * uses the ORIGINAL node's declaration via getNodeOutputScope. Nodes without globalInputs are
 * returned unchanged.
 */
export function inlineGlobalInputs(
  node: GraphNode,
  registry: VariableRegistry | undefined,
): GraphNode {
  const schema = (node as { inputSchema?: unknown }).inputSchema;
  if (!schema || typeof schema !== "object") return node;
  const s = schema as { globalInputs?: unknown; properties?: unknown; type?: unknown };
  if (!Array.isArray(s.globalInputs) || s.globalInputs.length === 0) return node;

  const props: Record<string, unknown> = {
    ...((s.properties as Record<string, unknown>) || {}),
  };
  for (const name of s.globalInputs) {
    if (typeof name !== "string" || name in props) continue;
    const decl = registry?.[name];
    // The registry entry IS the JSON Schema property — carry the whole descriptor so every
    // constraint (enum, items, properties, pattern, format, minLength, minimum, ...) reaches the
    // schema the agent is validated against. Without this an enum/items/pattern-constrained global
    // (e.g. a yes/no gate or a typed array) would accept free text or unstructured data.
    props[name] = decl ? { ...decl } : {};
  }

  // The stored `required` already lists the global names that the agent must supply (the migration
  // preserves original required status); it is used as-is for the inlined schema. Globals that were
  // optional outputs stay optional.
  const { globalInputs: _omit, ...restSchema } = s as Record<string, unknown>;
  const effectiveSchema: Record<string, unknown> = {
    ...restSchema,
    properties: props,
  };
  if (effectiveSchema.type === undefined) effectiveSchema.type = "object";

  return {
    ...(node as unknown as Record<string, unknown>),
    inputSchema: effectiveSchema,
  } as unknown as GraphNode;
}

// Helper function for safe connection resolution
export function getNextNodeId(node: GraphNode, outputPath: string): string | null {
  const connections = node.connections as Record<string, string> | undefined;

  if (!connections) {
    return null;
  }

  return connections[outputPath] || null;
}

// Validation helpers
export function validateNodeConnections(node: GraphNode): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required connections based on node type
  switch (node.type) {
    case "start":
      if (!node.connections?.default) {
        errors.push('Start node must have "default" connection');
      }
      break;

    case "agent-directive":
      if (!node.connections?.success) {
        errors.push('Agent directive node must have "success" connection');
      }
      break;

    case "condition":
      if (!node.connections?.true || !node.connections?.false) {
        errors.push('Condition node must have both "true" and "false" connections');
      }
      break;

    case "subgraph":
      if (!node.connections?.success) {
        errors.push('Subgraph node must have "success" connection');
      }
      break;

    case "telegram-notification":
      if (!node.connections?.default) {
        errors.push('Telegram notification node must have "default" connection');
      }
      break;

    case "expression":
      if (!node.connections?.default) {
        errors.push('Expression node must have "default" connection');
      }
      if (!node.expressions || !Array.isArray(node.expressions) || node.expressions.length === 0) {
        errors.push("Expression node must have at least one expression");
      }
      break;

    case "read-note":
      if (!node.connections?.default) {
        errors.push('Read-note node must have "default" connection');
      }
      if (!(node as ReadNoteNode).outputVariable) {
        errors.push("Read-note node must have outputVariable");
      }
      break;

    case "write-note":
      if (!node.connections?.default) {
        errors.push('Write-note node must have "default" connection');
      }
      if (!(node as WriteNoteNode).source) {
        errors.push("Write-note node must have source");
      }
      {
        const writeNode = node as WriteNoteNode;
        if (!writeNode.batchMode && !writeNode.key) {
          errors.push("Write-note node in single mode must have key");
        }
      }
      break;

    case "upsert-note":
      if (!node.connections?.default) {
        errors.push('Upsert-note node must have "default" connection');
      }
      if (!(node as UpsertNoteNode).keyTemplate) {
        errors.push("Upsert-note node must have keyTemplate");
      }
      if (!(node as UpsertNoteNode).value) {
        errors.push("Upsert-note node must have value");
      }
      break;

    case "teleport":
      if (!node.connections?.success) {
        errors.push('Teleport node must have "success" connection');
      }
      if (!(node as TeleportNode).hint) {
        errors.push("Teleport node must have hint describing when to use it");
      }
      break;

    case "lock":
      if (!node.connections?.unlocked) {
        errors.push('Lock node must have "unlocked" connection');
      }
      if (!(node as LockNode).reason) {
        errors.push("Lock node must have reason");
      }
      break;

    case "end":
      // End nodes should not have connections
      if (node.connections && Object.keys(node.connections).length > 0) {
        errors.push("End node should not have connections");
      }
      break;

    default: {
      const _exhaustive: never = node;
      errors.push(`Unknown node type: ${(_exhaustive as GraphNode).type}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
