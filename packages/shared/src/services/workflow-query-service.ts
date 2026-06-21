/**
 * Workflow Query Service - Pure functions for workflow analysis
 * No database dependency - works directly with WorkflowGraph objects
 * Used by both MCP tools and CLI script
 *
 * NOTE: For comprehensive validation (JSON Schema + structural), use GraphValidator
 * from @mcp-moira/workflow-engine. This module provides lightweight structural
 * validation suitable for CLI and contexts without AJV dependency.
 */

import type { WorkflowGraph, GraphNode } from "@mcp-moira/workflow-engine";
import type { UnifiedValidationIssue, UnifiedValidationResult } from "../types/validation-types.js";

// ============================================================================
// Types
// ============================================================================

export interface WorkflowStructure {
  /** Server-assigned id; absent for unsaved definition files. */
  id?: string;
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    tags?: string[];
  };
  stats: {
    totalNodes: number;
    byType: Record<string, number>;
  };
  graph: GraphConnection[];
}

export interface GraphConnection {
  nodeId: string;
  type: string;
  connections: Record<string, string>;
}

export interface NodeSearchResult {
  node: GraphNode;
  matchedIn: ("directive" | "completionCondition" | "message" | "id")[];
  snippet?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: WorkflowValidationIssue[];
  warnings: ValidationWarning[];
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  nodeId?: string;
}

// ============================================================================
// Structure Analysis
// ============================================================================

/**
 * Get workflow structure (metadata + graph) without full node content
 * Useful for large workflows to avoid truncation
 */
export function getWorkflowStructure(workflow: WorkflowGraph): WorkflowStructure {
  const stats = calculateStats(workflow);
  const graph = buildGraph(workflow);

  return {
    id: workflow.id,
    metadata: {
      name: workflow.metadata.name,
      version: workflow.metadata.version,
      description: workflow.metadata.description,
      author: workflow.metadata.author,
      tags: workflow.metadata.tags,
    },
    stats,
    graph,
  };
}

function calculateStats(workflow: WorkflowGraph): {
  totalNodes: number;
  byType: Record<string, number>;
} {
  const byType: Record<string, number> = {};

  for (const node of workflow.nodes) {
    byType[node.type] = (byType[node.type] || 0) + 1;
  }

  return {
    totalNodes: workflow.nodes.length,
    byType,
  };
}

function buildGraph(workflow: WorkflowGraph): GraphConnection[] {
  return workflow.nodes.map((node) => ({
    nodeId: node.id,
    type: node.type,
    connections: node.connections || {},
  }));
}

// ============================================================================
// Node Operations
// ============================================================================

/**
 * Get a specific node by ID
 */
export function getNode(workflow: WorkflowGraph, nodeId: string): GraphNode | null {
  return workflow.nodes.find((n) => n.id === nodeId) || null;
}

/**
 * Search nodes by text query
 * Supports regex patterns (if query contains |, *, +, etc.)
 */
export function searchNodes(workflow: WorkflowGraph, query: string): NodeSearchResult[] {
  const results: NodeSearchResult[] = [];

  // Detect if query should be treated as regex
  const isRegex = /[|*+?[\](){}^$\\]/.test(query);
  let matcher: RegExp | null = null;

  if (isRegex) {
    try {
      matcher = new RegExp(query, "i");
    } catch {
      // Invalid regex, fall back to includes
      matcher = null;
    }
  }

  const matchText = (text: string | undefined): boolean => {
    if (!text) return false;
    if (matcher) {
      return matcher.test(text);
    }
    return text.toLowerCase().includes(query.toLowerCase());
  };

  for (const node of workflow.nodes) {
    const matchedIn: ("directive" | "completionCondition" | "message" | "id")[] = [];
    let snippet: string | undefined;

    // Check ID
    if (matchText(node.id)) {
      matchedIn.push("id");
    }

    // Check directive
    if ("directive" in node && matchText(node.directive as string)) {
      matchedIn.push("directive");
      snippet = extractSnippet(node.directive as string, query);
    }

    // Check completionCondition
    if ("completionCondition" in node && matchText(node.completionCondition as string)) {
      matchedIn.push("completionCondition");
      if (!snippet) {
        snippet = extractSnippet(node.completionCondition as string, query);
      }
    }

    // Check message (for notification nodes)
    if ("message" in node && matchText(node.message as string)) {
      matchedIn.push("message");
      if (!snippet) {
        snippet = extractSnippet(node.message as string, query);
      }
    }

    if (matchedIn.length > 0) {
      results.push({ node, matchedIn, snippet });
    }
  }

  return results;
}

function extractSnippet(text: string, query: string): string {
  const lines = text.split("\n");
  const lowerQuery = query.toLowerCase();

  // Find the first line containing the query
  const matchingLine = lines.find((line) => line.toLowerCase().includes(lowerQuery));
  if (matchingLine) {
    const trimmed = matchingLine.trim();
    return trimmed.length > 100 ? trimmed.substring(0, 100) + "..." : trimmed;
  }

  // Fallback to first line
  const firstLine = lines[0]?.trim() || "";
  return firstLine.length > 100 ? firstLine.substring(0, 100) + "..." : firstLine;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate workflow structure — lightweight unified format (no AJV dependency).
 *
 * This is an intentional lightweight subset of GraphValidator.validateUnified().
 * It performs structural validation only (IDs, connections, reachability) without
 * JSON Schema validation. Used by CLI tools and contexts where workflow-engine
 * is not available.
 *
 * For comprehensive validation (JSON Schema + structural), use GraphValidator.validateUnified().
 * Node-type-specific validators (Step 4) should ONLY be added to GraphValidator.
 */
export function validateWorkflowUnified(workflow: WorkflowGraph): UnifiedValidationResult {
  const issues: UnifiedValidationIssue[] = [];

  // Basic structure validation.
  // Note: top-level `id` is server-assigned and absent in definition files,
  // so it is intentionally NOT required here (consistent with the AJV schema).

  if (!workflow.metadata) {
    issues.push({
      type: "structure",
      severity: "error",
      field: "metadata",
      message: "Missing workflow metadata",
    });
  } else {
    if (!workflow.metadata.name) {
      issues.push({
        type: "structure",
        severity: "error",
        field: "metadata.name",
        message: "Missing workflow name in metadata",
      });
    }
    if (!workflow.metadata.version) {
      issues.push({
        type: "structure",
        severity: "error",
        field: "metadata.version",
        message: "Missing workflow version in metadata",
      });
    }
  }

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    issues.push({
      type: "structure",
      severity: "error",
      field: "nodes",
      message: "Missing or invalid nodes array",
    });
    return { valid: false, issues };
  }

  const nodes: GraphNode[] = workflow.nodes;
  const nodeIds = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];

    if (!node.id) {
      issues.push({
        type: "node",
        severity: "error",
        field: "id",
        message: `Node at index ${i} missing id`,
      });
    } else if (nodeIds.has(node.id)) {
      issues.push({
        type: "node",
        severity: "error",
        field: "id",
        nodeId: node.id,
        message: `Duplicate node id: ${node.id}`,
      });
    } else {
      nodeIds.add(node.id);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(node as any).type) {
      issues.push({
        type: "node",
        severity: "error",
        field: "type",
        nodeId: node.id,
        message: `Node ${node.id || `at index ${i}`} missing type`,
      });
    }
  }

  // Connection validation
  for (const node of nodes) {
    if (node.connections) {
      for (const [key, target] of Object.entries(node.connections)) {
        if (!nodeIds.has(target)) {
          issues.push({
            type: "connection",
            severity: "error",
            nodeId: node.id,
            field: `connections.${key}`,
            message: `Node ${node.id}: connection "${key}" points to non-existent node "${target}"`,
          });
        }
      }
    }
  }

  // Start/end node validation
  const startNodes = nodes.filter((n) => n.type === "start");
  const endNodes = nodes.filter((n) => n.type === "end");

  if (startNodes.length === 0) {
    issues.push({ type: "structure", severity: "error", message: "Missing start node" });
  }
  if (startNodes.length > 1) {
    issues.push({
      type: "structure",
      severity: "warning",
      message: `Multiple start nodes found: ${startNodes.length}`,
    });
  }
  if (endNodes.length === 0) {
    issues.push({ type: "structure", severity: "warning", message: "No end node found" });
  }
  if (endNodes.length > 1) {
    issues.push({
      type: "structure",
      severity: "warning",
      message: `Multiple end nodes found: ${endNodes.length}`,
    });
  }

  // Reachability analysis
  const reachable = new Set<string>();
  const toVisit = ["start"];

  while (toVisit.length > 0) {
    const current = toVisit.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const node = nodes.find((n) => n.id === current);
    if (node?.connections) {
      for (const target of Object.values(node.connections)) {
        if (!reachable.has(target)) {
          toVisit.push(target);
        }
      }
    }
  }

  for (const node of nodes) {
    if (!reachable.has(node.id) && node.type !== "start") {
      issues.push({
        type: "structure",
        severity: "warning",
        nodeId: node.id,
        message: `Unreachable node: ${node.id}`,
      });
    }
  }

  // InputSchema validation
  for (const node of nodes) {
    if ("inputSchema" in node && node.inputSchema) {
      const schema = node.inputSchema as Record<string, unknown>;
      if (schema.type !== "object") {
        issues.push({
          type: "node",
          severity: "warning",
          nodeId: node.id,
          field: "inputSchema.type",
          message: `Node ${node.id}: inputSchema type should be "object"`,
        });
      }
    }
  }

  return {
    valid: issues.every((i) => i.severity !== "error"),
    issues,
  };
}

/**
 * Validate workflow structure — legacy format
 * Returns errors (must fix) and warnings (should review)
 *
 * @deprecated Use validateWorkflowUnified for new code
 */
export function validateWorkflow(workflow: WorkflowGraph): ValidationResult {
  const unified = validateWorkflowUnified(workflow);

  const errors: WorkflowValidationIssue[] = [];
  const warnings: ValidationWarning[] = [];

  // Legacy code-based mapping
  const errorCodeMap: Record<string, string> = {
    "Missing workflow id": "MISSING_ID",
    "Missing workflow metadata": "MISSING_METADATA",
    "Missing workflow name in metadata": "MISSING_NAME",
    "Missing workflow version in metadata": "MISSING_VERSION",
    "Missing or invalid nodes array": "MISSING_NODES",
    "Missing start node": "MISSING_START",
  };

  for (const issue of unified.issues) {
    if (issue.severity === "error") {
      let code = errorCodeMap[issue.message] || "VALIDATION_ERROR";
      if (issue.message.startsWith("Node at index") && issue.message.includes("missing id")) {
        code = "MISSING_NODE_ID";
      } else if (issue.message.startsWith("Duplicate node id")) {
        code = "DUPLICATE_NODE_ID";
      } else if (issue.message.includes("missing type")) {
        code = "MISSING_NODE_TYPE";
      } else if (issue.type === "connection") {
        code = "INVALID_CONNECTION";
      }
      errors.push({ code, message: issue.message, nodeId: issue.nodeId });
    } else {
      let code = "WARNING";
      if (issue.message.startsWith("Multiple start")) code = "MULTIPLE_STARTS";
      else if (issue.message === "No end node found") code = "MISSING_END";
      else if (issue.message.startsWith("Multiple end")) code = "MULTIPLE_ENDS";
      else if (issue.message.startsWith("Unreachable node")) code = "UNREACHABLE_NODE";
      else if (issue.message.includes("inputSchema type")) code = "INVALID_SCHEMA_TYPE";
      warnings.push({ code, message: issue.message, nodeId: issue.nodeId });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================================================
// Utility Functions (for CLI output)
// ============================================================================

/**
 * Variable with description and value
 */
export interface VariableInfo {
  description: string;
  value: unknown;
  /** JSON-Schema primitive type when the variable comes from the registry. */
  type?: string;
}

/**
 * Get a workflow's declared global variables.
 *
 * The variableRegistry is the single source of truth for declared globals; each entry maps
 * to {description, value: default, type}. A workflow with no registry has no declared globals.
 */
export function getWorkflowVariables(workflow: WorkflowGraph): Record<string, VariableInfo> {
  const result: Record<string, VariableInfo> = {};
  if (workflow.variableRegistry && typeof workflow.variableRegistry === "object") {
    for (const [name, decl] of Object.entries(workflow.variableRegistry)) {
      result[name] = {
        description: decl.description,
        value: "default" in decl ? decl.default : null,
        type: decl.type,
      };
    }
  }
  return result;
}

/**
 * Get workflow variable values only (for backward compatibility)
 */
export function getWorkflowVariableValues(workflow: WorkflowGraph): Record<string, unknown> {
  const variables = getWorkflowVariables(workflow);
  const values: Record<string, unknown> = {};

  for (const [name, info] of Object.entries(variables)) {
    values[name] = info.value ?? null;
  }

  return values;
}

/**
 * Get a specific workflow variable from start node (returns full info)
 */
export function getWorkflowVariable(
  workflow: WorkflowGraph,
  name: string,
): VariableInfo | undefined {
  const variables = getWorkflowVariables(workflow);
  return variables[name];
}

/** Infer a JSON-Schema primitive type name from a value (for registry declarations). */
function inferRegistryType(
  value: unknown,
): "string" | "number" | "boolean" | "object" | "array" | "null" {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "object";
}

/**
 * Set a declared global variable in the workflow's variableRegistry (the single source of
 * truth). The value becomes the variable's default; the existing entry's full schema (type,
 * description and any JSON Schema keyword — enum, items, properties, pattern, ...) is preserved,
 * so setting a value never strips a declared constraint. For a new variable the type is inferred
 * from the value. A registry is created when the workflow does not yet have one. Returns a new
 * workflow object (immutable).
 */
export function setWorkflowVariable(
  workflow: WorkflowGraph,
  name: string,
  value: unknown,
  description?: string,
): WorkflowGraph {
  const newWorkflow = JSON.parse(JSON.stringify(workflow)) as WorkflowGraph;

  if (!newWorkflow.variableRegistry || typeof newWorkflow.variableRegistry !== "object") {
    newWorkflow.variableRegistry = {};
  }

  const existing = newWorkflow.variableRegistry[name];
  newWorkflow.variableRegistry[name] = {
    // Spread the existing entry first so enum/items/properties/pattern/etc. survive a set-variable.
    ...existing,
    type: existing?.type ?? inferRegistryType(value),
    description: description ?? existing?.description ?? "No description",
    default: value,
  };

  return newWorkflow;
}

/**
 * Delete a declared global variable from the workflow's variableRegistry (the single source
 * of truth). Returns a new workflow object (immutable).
 */
export function deleteWorkflowVariable(workflow: WorkflowGraph, name: string): WorkflowGraph {
  const newWorkflow = JSON.parse(JSON.stringify(workflow)) as WorkflowGraph;

  if (newWorkflow.variableRegistry && typeof newWorkflow.variableRegistry === "object") {
    delete newWorkflow.variableRegistry[name];
  }

  return newWorkflow;
}

// ============================================================================
// Compact Node Listing (for large workflows)
// ============================================================================

export interface CompactNode {
  id: string;
  type: string;
  connections: string[];
  directivePreview?: string;
}

export interface ListNodesOptions {
  typeFilter?: string;
  previewLength?: number;
  includePreview?: boolean;
}

/**
 * Get compact node list for large workflows
 * Returns only essential fields: id, type, connections, optional preview
 */
export function listNodesCompact(
  workflow: WorkflowGraph,
  options: ListNodesOptions = {},
): CompactNode[] {
  const { typeFilter, previewLength = 100, includePreview = true } = options;

  let nodes = workflow.nodes;
  if (typeFilter) {
    nodes = nodes.filter((n) => n.type === typeFilter);
  }

  return nodes.map((node) => {
    const result: CompactNode = {
      id: node.id,
      type: node.type,
      connections: node.connections ? Object.values(node.connections) : [],
    };

    if (includePreview && "directive" in node && node.directive) {
      const directive = node.directive as string;
      result.directivePreview =
        directive.length > previewLength
          ? directive.substring(0, previewLength) + "..."
          : directive;
    }

    return result;
  });
}

// ============================================================================
// Variable Usage Analysis
// ============================================================================

export interface VariableSource {
  type: "registry" | "initialData" | "inputSchema" | "expression";
  nodeId: string;
  description?: string;
}

export interface VariableUsage {
  nodeId: string;
  field: "directive" | "completionCondition" | "message" | "condition";
  context: string;
}

export interface VariableAnalysis {
  [variableName: string]: {
    sources: VariableSource[];
    usages: VariableUsage[];
  };
}

/**
 * Analyze variable usage across workflow
 * Detects sources (where variables are defined) and usages (where they're used)
 */
export function analyzeVariableUsage(workflow: WorkflowGraph): VariableAnalysis {
  const analysis: VariableAnalysis = {};

  const addSource = (name: string, source: VariableSource): void => {
    if (!analysis[name]) {
      analysis[name] = { sources: [], usages: [] };
    }
    analysis[name].sources.push(source);
  };

  const addUsage = (name: string, usage: VariableUsage): void => {
    if (!analysis[name]) {
      analysis[name] = { sources: [], usages: [] };
    }
    // Avoid duplicates
    const exists = analysis[name].usages.some(
      (u) => u.nodeId === usage.nodeId && u.field === usage.field,
    );
    if (!exists) {
      analysis[name].usages.push(usage);
    }
  };

  // Extract template variables: {{varName}}, {{#if varName}}, {{varName.field}}
  const extractFromTemplate = (
    text: unknown,
    nodeId: string,
    field: "directive" | "completionCondition" | "message",
  ): void => {
    if (!text || typeof text !== "string") return;

    const templateRegex =
      /\{\{(?:#(?:if|unless|each)\s+)?([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[\d+\])*)\}\}/g;
    let match;
    while ((match = templateRegex.exec(text)) !== null) {
      const fullPath = match[1];
      const varName = fullPath.split(/[.[\]]/)[0];
      // Extract context around the match
      const start = Math.max(0, match.index - 25);
      const end = Math.min(text.length, match.index + match[0].length + 25);
      const context = text.substring(start, end);
      addUsage(varName, { nodeId, field, context });
    }
  };

  // Extract from condition expressions
  const extractFromCondition = (condition: unknown, nodeId: string): void => {
    if (!condition) return;

    // Handle object format: { operator: "lt", left: { contextPath: "var" }, right: 0 }
    if (typeof condition === "object") {
      const condObj = condition as Record<string, unknown>;
      if (condObj.left && typeof condObj.left === "object") {
        const left = condObj.left as Record<string, unknown>;
        if (left.contextPath && typeof left.contextPath === "string") {
          const varName = left.contextPath.split(".")[0];
          addUsage(varName, { nodeId, field: "condition", context: JSON.stringify(condition) });
        }
      }
      if (condObj.right && typeof condObj.right === "object") {
        const right = condObj.right as Record<string, unknown>;
        if (right.contextPath && typeof right.contextPath === "string") {
          const varName = right.contextPath.split(".")[0];
          addUsage(varName, { nodeId, field: "condition", context: JSON.stringify(condition) });
        }
      }
      return;
    }

    // Handle string format
    if (typeof condition !== "string") return;

    const conditionRegex =
      /([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*(?:===|!==|==|!=|<|>|<=|>=)/g;
    let match;
    while ((match = conditionRegex.exec(condition)) !== null) {
      const varName = match[1].split(".")[0];
      addUsage(varName, { nodeId, field: "condition", context: condition });
    }
  };

  // Sources: declared global variables in the registry (single source of truth).
  if (workflow.variableRegistry && typeof workflow.variableRegistry === "object") {
    const startNodeId = workflow.nodes.find((n) => n.type === "start")?.id ?? "start";
    for (const [varName, decl] of Object.entries(workflow.variableRegistry)) {
      addSource(varName, {
        type: "registry",
        nodeId: startNodeId,
        description: decl.description,
      });
    }
  }

  // Process all nodes
  for (const node of workflow.nodes) {
    const nodeAny = node as GraphNode & Record<string, unknown>;

    // Sources: initialData.variables in start node (legacy/transitional)
    if (node.type === "start" && nodeAny.initialData) {
      const initialData = nodeAny.initialData as {
        variables?: Record<string, { description?: string; value?: unknown }>;
      };
      if (initialData.variables) {
        for (const [varName, varDef] of Object.entries(initialData.variables)) {
          addSource(varName, {
            type: "initialData",
            nodeId: node.id,
            description: varDef.description,
          });
        }
      }
    }

    // Sources: inputSchema properties
    if ("inputSchema" in nodeAny && nodeAny.inputSchema) {
      const schema = nodeAny.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      if (schema.properties) {
        for (const [propName, propDef] of Object.entries(schema.properties)) {
          addSource(propName, {
            type: "inputSchema",
            nodeId: node.id,
            description: propDef.description,
          });
        }
      }
    }

    // Sources: expression node outputs
    if (node.type === "expression" && nodeAny.outputVariable) {
      addSource(nodeAny.outputVariable as string, {
        type: "expression",
        nodeId: node.id,
      });
    }

    // Usages: expression node value (variables used in expressions)
    if (node.type === "expression" && nodeAny.value && typeof nodeAny.value === "string") {
      const JS_KEYWORDS = new Set([
        "if",
        "else",
        "true",
        "false",
        "null",
        "undefined",
        "return",
        "var",
        "let",
        "const",
        "function",
        "new",
        "this",
        "typeof",
        "instanceof",
      ]);
      const exprVars = (nodeAny.value as string).match(/([a-zA-Z_][a-zA-Z0-9_]*)/g) || [];
      exprVars
        .filter((v) => !JS_KEYWORDS.has(v) && v !== nodeAny.outputVariable)
        .forEach((varName) => {
          addUsage(varName, {
            nodeId: node.id,
            field: "directive", // Use directive as the field for expression usages
            context: nodeAny.value as string,
          });
        });
    }

    // Usages: templates
    extractFromTemplate(nodeAny.directive, node.id, "directive");
    extractFromTemplate(nodeAny.completionCondition, node.id, "completionCondition");
    extractFromTemplate(nodeAny.message, node.id, "message");

    // Usages: conditions
    extractFromCondition(nodeAny.condition, node.id);
  }

  return analysis;
}

// ============================================================================
// Unified Search
// ============================================================================

export interface SearchResult {
  type: "node" | "variable";
  nodeId?: string;
  nodeType?: string;
  variableName?: string;
  matchedIn: string[];
  snippet?: string;
}

export interface SearchOptions {
  snippetMode?: boolean;
  includeVariables?: boolean;
}

/**
 * Search workflow nodes and optionally variables
 * Supports regex patterns (detected automatically)
 */
export function searchWorkflow(
  workflow: WorkflowGraph,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const { snippetMode = false, includeVariables = false } = options;
  const results: SearchResult[] = [];

  // Detect if query should be treated as regex
  const isRegex = /[|*+?[\](){}^$\\]/.test(query);
  let matcher: RegExp | null = null;

  if (isRegex) {
    try {
      matcher = new RegExp(query, "i");
    } catch {
      matcher = null;
    }
  }

  const matchText = (text: string | undefined): boolean => {
    if (!text) return false;
    if (matcher) {
      return matcher.test(text);
    }
    return text.toLowerCase().includes(query.toLowerCase());
  };

  const extractSnippet = (text: string, maxLength = 100): string => {
    const lowerQuery = query.toLowerCase();
    const index = text.toLowerCase().indexOf(lowerQuery);
    if (index === -1) {
      return text.length > maxLength ? text.substring(0, maxLength) + "..." : text;
    }
    const start = Math.max(0, index - 25);
    const end = Math.min(text.length, index + query.length + 25);
    let snippet = text.substring(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    return snippet;
  };

  // Search in nodes
  for (const node of workflow.nodes) {
    const matchedIn: string[] = [];
    let snippet: string | undefined;

    // Check ID
    if (matchText(node.id)) {
      matchedIn.push("id");
    }

    // Check directive
    if ("directive" in node && matchText(node.directive as string)) {
      matchedIn.push("directive");
      if (!snippet) {
        snippet = extractSnippet(node.directive as string);
      }
    }

    // Check completionCondition
    if ("completionCondition" in node && matchText(node.completionCondition as string)) {
      matchedIn.push("completionCondition");
      if (!snippet) {
        snippet = extractSnippet(node.completionCondition as string);
      }
    }

    // Check message
    if ("message" in node && matchText(node.message as string)) {
      matchedIn.push("message");
      if (!snippet) {
        snippet = extractSnippet(node.message as string);
      }
    }

    if (matchedIn.length > 0) {
      const result: SearchResult = {
        type: "node",
        nodeId: node.id,
        nodeType: node.type,
        matchedIn,
      };
      if (snippetMode && snippet) {
        result.snippet = snippet;
      }
      results.push(result);
    }
  }

  // Search in variables
  if (includeVariables) {
    const variables = getWorkflowVariables(workflow);
    for (const [varName, varInfo] of Object.entries(variables)) {
      const matchedIn: string[] = [];
      let snippet: string | undefined;

      // Check variable name
      if (matchText(varName)) {
        matchedIn.push("name");
      }

      // Check variable value
      const valueStr =
        typeof varInfo.value === "string" ? varInfo.value : JSON.stringify(varInfo.value);
      if (matchText(valueStr)) {
        matchedIn.push("value");
        snippet = extractSnippet(valueStr);
      }

      // Check description
      if (matchText(varInfo.description)) {
        matchedIn.push("description");
        if (!snippet) {
          snippet = extractSnippet(varInfo.description);
        }
      }

      if (matchedIn.length > 0) {
        const result: SearchResult = {
          type: "variable",
          variableName: varName,
          matchedIn,
        };
        if (snippetMode && snippet) {
          result.snippet = snippet;
        }
        results.push(result);
      }
    }
  }

  return results;
}

// ============================================================================
// Flow Graph Visualization
// ============================================================================

/**
 * Build flow graph starting from start node (for visualization)
 */
export function buildFlowGraph(workflow: WorkflowGraph): string[] {
  const output: string[] = [];
  const visited = new Set<string>();

  function traverse(nodeId: string, indent: number, isLast: boolean): void {
    if (visited.has(nodeId)) {
      const prefix = "  ".repeat(indent);
      output.push(`${prefix}(see ${nodeId} above)`);
      return;
    }

    visited.add(nodeId);

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      const prefix = "  ".repeat(indent);
      output.push(`${prefix}ERROR: Node not found: ${nodeId}`);
      return;
    }

    const prefix = "  ".repeat(indent);
    const connector = indent === 0 ? "" : isLast ? "└─ " : "├─ ";
    output.push(`${prefix}${connector}[${node.type}] ${node.id}`);

    if (node.connections) {
      const connections = Object.entries(node.connections);
      connections.forEach(([key, target], index) => {
        const isLastConnection = index === connections.length - 1;
        if (key !== "default") {
          const branchPrefix = "  ".repeat(indent + 1);
          output.push(`${branchPrefix}[${key}]:`);
        }
        traverse(target, indent + 1, isLastConnection);
      });
    }
  }

  const startNode = workflow.nodes.find((n) => n.type === "start");
  if (startNode) {
    traverse(startNode.id, 0, true);
  } else {
    output.push("ERROR: Start node not found");
  }

  return output;
}
