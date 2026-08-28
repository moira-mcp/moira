/**
 * Graph Validator for WorkflowGraph schemas
 *
 * Single source of truth for all workflow validation.
 * Produces UnifiedValidationResult (new) and GraphValidationResult (legacy).
 */

import * as AjvModule from "ajv";
import * as addFormatsModule from "ajv-formats";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { validateNodeConnections } from "../types/graph-nodes.js";
import type {
  GraphNode,
  ConditionNode,
  AgentDirectiveNode,
  ExpressionNode,
  TeleportNode,
  MaterializeNode,
} from "../types/graph-nodes.js";
import type { ConditionOperator, StructuredCondition } from "../types/structured-condition.js";
// Import directly to avoid auth side effects from shared index
import { createLogger } from "@mcp-moira/shared/logging/logger";
import { ConfigurationError } from "@mcp-moira/shared/errors";
import type { UnifiedValidationResult, UnifiedValidationIssue } from "./validation-types.js";
import { parseExpressionAst } from "../expression/expression-parser.js";
import { registerWorkflowSchemaKeywords } from "../utils/schema-validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validation result interface
export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationError[];
  warnings: GraphValidationWarning[];
}

// Detailed validation error
export interface GraphValidationError {
  type: "schema" | "structure" | "connections" | "references";
  path?: string;
  nodeId?: string;
  message: string;
  details?: Record<string, unknown>;
}

// Non-critical validation warning
export interface GraphValidationWarning {
  type: "best-practices" | "performance" | "maintainability";
  nodeId?: string;
  message: string;
}

// File loading result with validation status
export interface WorkflowLoadResult {
  workflow?: WorkflowGraph;
  validation: GraphValidationResult;
  filePath?: string;
  parseError?: string;
}

function exceedsValidationComplexity(input: unknown): boolean {
  const MAX_VALIDATION_DEPTH = 64;
  const MAX_VALIDATION_ENTRIES = 100_000;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_VALIDATION_DEPTH) return true;
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    const keys = Object.keys(current.value);
    entries += keys.length;
    if (entries > MAX_VALIDATION_ENTRIES) return true;
    const record = current.value as Record<string, unknown>;
    for (const key of keys) {
      stack.push({ value: record[key], depth: current.depth + 1 });
    }
  }

  return false;
}

export class GraphValidator {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ajv: any;
  private schema: object;
  private logger = createLogger({ component: "GraphValidator" });

  /**
   * Resolve schema path for both source and compiled contexts
   */
  private resolveSchemaPath(customSchemaPath?: string): string {
    if (customSchemaPath) {
      return customSchemaPath;
    }

    // Try multiple possible schema locations
    const possiblePaths = [
      // Source context: packages/workflow-engine/src/validation/
      path.join(__dirname, "../schemas/workflow-graph-schema.json"),
      // Compiled context: packages/workflow-engine/dist/validation/
      path.join(__dirname, "../schemas/workflow-graph-schema.json"),
      // Alternative: relative to dist root
      path.join(__dirname, "../../src/schemas/workflow-graph-schema.json"),
      // Alternative: package root
      path.join(__dirname, "../../../src/schemas/workflow-graph-schema.json"),
    ];

    for (const schemaPath of possiblePaths) {
      try {
        if (fs.existsSync(schemaPath)) {
          return schemaPath;
        }
      } catch {
        // Continue trying other paths
      }
    }

    throw new ConfigurationError(
      `Cannot find workflow-graph-schema.json in any of the expected locations: ${possiblePaths.join(", ")}`,
    );
  }

  constructor(schemaPath?: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.ajv = new (AjvModule as any).default({
      allErrors: true,
      verbose: true,
      strict: false, // Allow additional properties in some cases
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (addFormatsModule as any).default(this.ajv);

    // Load schema - handle both source and compiled contexts
    const defaultSchemaPath = this.resolveSchemaPath(schemaPath);
    const actualSchemaPath = defaultSchemaPath;

    try {
      this.schema = JSON.parse(fs.readFileSync(actualSchemaPath, "utf-8"));
      this.logger.info("Graph validator initialized", { schemaPath: actualSchemaPath });
    } catch (error) {
      // No logging here - boundary handles it
      throw new ConfigurationError(
        `Failed to load workflow schema: ${error instanceof Error ? error.message : String(error)}`,
        { schemaPath: actualSchemaPath },
      );
    }
  }

  /**
   * Filter AJV oneOf errors to show only relevant errors for actual node type
   * This makes validation errors much more readable by:
   * 1. Detecting the actual node type from the data
   * 2. Filtering out errors from non-matching oneOf branches
   * 3. Grouping errors by node for clarity
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private filterOneOfErrors(ajvErrors: any[], graph: unknown): GraphValidationError[] {
    const errors: GraphValidationError[] = [];
    const workflow = graph as { nodes?: Array<{ id?: string; type?: string }> };

    // Group errors by node index
    const errorsByNode = new Map<
      number,
      {
        nodeType: string | undefined;
        nodeId: string | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        errors: any[];
      }
    >();

    for (const error of ajvErrors) {
      // Extract node index from instancePath (e.g., "/nodes/1/type")
      const nodeMatch = error.instancePath?.match(/^\/nodes\/(\d+)(?:\/|$)/);
      if (nodeMatch) {
        const nodeIndex = parseInt(nodeMatch[1], 10);
        const node = workflow.nodes?.[nodeIndex];

        if (!errorsByNode.has(nodeIndex)) {
          errorsByNode.set(nodeIndex, {
            nodeType: node?.type,
            nodeId: node?.id,
            errors: [],
          });
        }
        errorsByNode.get(nodeIndex)!.errors.push(error);
      } else {
        // Non-node errors (metadata, id, etc.) - add directly
        let message = `${error.instancePath}: ${error.message}`;
        // Improve additionalProperties error message
        if (error.keyword === "additionalProperties" && error.params?.additionalProperty) {
          message = `Unknown field '${error.params.additionalProperty}' at root level`;
        }
        errors.push({
          type: "schema",
          path: error.instancePath || error.schemaPath,
          message,
          details: {
            keyword: error.keyword,
            params: error.params,
          },
        });
      }
    }

    // Process node errors - filter by actual node type
    for (const [nodeIndex, nodeData] of errorsByNode) {
      const { nodeType, nodeId } = nodeData;

      if (!nodeType) {
        // No type specified - show generic error
        errors.push({
          type: "schema",
          nodeId: nodeId || "unknown",
          message: `Node is missing required 'type' field`,
        });
        continue;
      }

      // Map node type to schema definition name
      const schemaDefMap: Record<GraphNode["type"], string> = {
        start: "startNode",
        end: "endNode",
        "agent-directive": "agentDirectiveNode",
        condition: "conditionNode",
        subgraph: "subgraphNode",
        "telegram-notification": "telegramNotificationNode",
        expression: "expressionNode",
        "read-note": "readNoteNode",
        "write-note": "writeNoteNode",
        "upsert-note": "upsertNoteNode",
        lock: "lockNode",
        teleport: "teleportNode",
        materialize: "materializeNode",
      };

      const expectedDef = schemaDefMap[nodeType as GraphNode["type"]];
      if (!expectedDef) {
        errors.push({
          type: "schema",
          nodeId: nodeId || "unknown",
          message: `Unknown node type: '${nodeType}'. Valid types: ${Object.keys(schemaDefMap).join(", ")}`,
        });
        continue;
      }

      // AJV may inline local $refs, so errors from oneOf branches no longer reliably carry the
      // definition name in schemaPath. Validate the observed node against its exact discriminator
      // branch instead of guessing which flattened errors belong to it.
      const node = workflow.nodes?.[nodeIndex];
      const validateNode = this.ajv.compile({
        $ref: `#/$defs/${expectedDef}`,
        $defs: (this.schema as { $defs: Record<string, unknown> }).$defs,
      });
      validateNode(node);
      const relevantErrors = validateNode.errors ?? [];

      // Create readable error messages for this node
      if (relevantErrors.length > 0) {
        // Group similar errors
        const uniqueMessages = new Set<string>();

        for (const error of relevantErrors) {
          // Create readable message
          let message = "";
          const fieldPath = error.instancePath?.replace(/\/nodes\/\d+/, "").replace(/^\//, "");

          if (error.keyword === "required") {
            message = `Missing required field: '${error.params.missingProperty}'`;
          } else if (error.keyword === "minLength" && fieldPath) {
            message = `Field '${fieldPath}' cannot be empty`;
          } else if (fieldPath) {
            message = `Field '${fieldPath}': ${error.message}`;
          } else {
            message = error.message || "Validation error";
          }

          uniqueMessages.add(message);
        }

        // Add consolidated error for this node
        errors.push({
          type: "schema",
          nodeId: nodeId || "unknown",
          message: `[${nodeType}] ${Array.from(uniqueMessages).join("; ")}`,
          details: {
            nodeType,
            fieldCount: uniqueMessages.size,
          },
        });
      }
    }

    return errors;
  }

  /**
   * Validate a workflow graph object — unified format (new API)
   * Returns UnifiedValidationResult with typed issues and severity.
   */
  async validateUnified(graph: unknown): Promise<UnifiedValidationResult> {
    const issues: UnifiedValidationIssue[] = [];

    try {
      if (exceedsValidationComplexity(graph)) {
        return {
          valid: false,
          issues: [
            {
              type: "schema",
              severity: "error",
              message: "Workflow exceeds validation depth or entry limits",
            },
          ],
        };
      }

      // 1. JSON Schema validation
      const validate = this.ajv.compile(this.schema);
      const valid = validate(graph);

      if (!valid && validate.errors) {
        const schemaErrors = this.filterOneOfErrors(validate.errors, graph);
        for (const err of schemaErrors) {
          issues.push({
            type: "schema",
            severity: "error",
            nodeId: err.nodeId,
            field: err.path,
            message: err.message,
          });
        }
      }

      // If basic schema validation fails, don't proceed with structural validation
      if (issues.length > 0) {
        return { valid: false, issues };
      }

      // 2. Structural validation (type-safe because schema passed)
      const workflow = graph as WorkflowGraph;
      const structuralIssues = this.validateStructureUnified(workflow);
      issues.push(...structuralIssues);

      return {
        valid: issues.every((i) => i.severity !== "error"),
        issues,
      };
    } catch (error) {
      issues.push({
        type: "schema",
        severity: "error",
        message: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
      });

      return { valid: false, issues };
    }
  }

  /**
   * Validate a workflow graph object — legacy format (backward compatible)
   */
  async validateWorkflow(graph: unknown): Promise<GraphValidationResult> {
    const unified = await this.validateUnified(graph);
    return this.unifiedToLegacy(unified);
  }

  /**
   * Convert unified result to legacy GraphValidationResult
   */
  private unifiedToLegacy(result: UnifiedValidationResult): GraphValidationResult {
    const errors: GraphValidationError[] = [];
    const warnings: GraphValidationWarning[] = [];

    for (const issue of result.issues) {
      if (issue.severity === "error") {
        errors.push({
          type:
            issue.type === "connection"
              ? "connections"
              : issue.type === "node"
                ? "structure"
                : issue.type,
          nodeId: issue.nodeId,
          path: issue.field,
          message: issue.message,
        });
      } else {
        warnings.push({
          type:
            issue.type === "node"
              ? "best-practices"
              : issue.type === "structure"
                ? "maintainability"
                : "best-practices",
          nodeId: issue.nodeId,
          message: issue.message,
        });
      }
    }

    return { valid: result.valid, errors, warnings };
  }

  /**
   * Load and validate workflow from file
   */
  async validateWorkflowFromFile(filePath: string): Promise<WorkflowLoadResult> {
    try {
      // Check file exists
      if (!fs.existsSync(filePath)) {
        return {
          validation: {
            valid: false,
            errors: [
              {
                type: "schema",
                message: `Workflow file not found: ${filePath}`,
              },
            ],
            warnings: [],
          },
          filePath,
        };
      }

      // Read and parse JSON
      const data = await fs.promises.readFile(filePath, "utf-8");
      let workflow: unknown;

      try {
        workflow = JSON.parse(data);
      } catch (parseError) {
        return {
          validation: {
            valid: false,
            errors: [
              {
                type: "schema",
                message: `Invalid JSON in workflow file: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              },
            ],
            warnings: [],
          },
          filePath,
          parseError: parseError instanceof Error ? parseError.message : String(parseError),
        };
      }

      // Validate workflow
      const validation = await this.validateWorkflow(workflow);

      return {
        workflow: validation.valid ? (workflow as WorkflowGraph) : undefined,
        validation,
        filePath,
      };
    } catch (error) {
      return {
        validation: {
          valid: false,
          errors: [
            {
              type: "schema",
              message: `Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          warnings: [],
        },
        filePath,
      };
    }
  }

  /**
   * Validate workflow structure and relationships — unified format
   */
  private validateStructureUnified(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    // Metadata validation
    if (!workflow.metadata?.name) {
      issues.push({
        type: "structure",
        severity: "error",
        field: "metadata.name",
        message: "Missing workflow name in metadata",
      });
    }
    if (!workflow.metadata?.version) {
      issues.push({
        type: "structure",
        severity: "error",
        field: "metadata.version",
        message: "Missing workflow version in metadata",
      });
    }

    // Check MAX_NODES limit
    const MAX_NODES = 300;
    if (workflow.nodes.length > MAX_NODES) {
      issues.push({
        type: "structure",
        severity: "error",
        message: `Workflow exceeds maximum node count (${MAX_NODES}). Current: ${workflow.nodes.length} nodes`,
      });
    }

    // Check for required node types
    const startNodes = workflow.nodes.filter((node) => node.type === "start");
    const hasEnd = workflow.nodes.some((node) => node.type === "end");

    if (startNodes.length === 0) {
      issues.push({
        type: "structure",
        severity: "error",
        message: "Workflow must have at least one start node",
      });
    } else if (startNodes.length > 1) {
      issues.push({
        type: "structure",
        severity: "error",
        message: `Workflow must have exactly one start node, found ${startNodes.length}: ${startNodes.map((n) => n.id).join(", ")}`,
      });
    }

    if (!hasEnd) {
      issues.push({
        type: "structure",
        severity: "error",
        message: "Workflow must have at least one end node",
      });
    }

    // Validate node IDs are unique
    const nodeIds = new Set<string>();
    const duplicateIds: string[] = [];

    for (const node of workflow.nodes) {
      if (nodeIds.has(node.id)) {
        duplicateIds.push(node.id);
      } else {
        nodeIds.add(node.id);
      }
    }

    if (duplicateIds.length > 0) {
      issues.push({
        type: "structure",
        severity: "error",
        message: `Duplicate node IDs found: ${duplicateIds.join(", ")}`,
      });
    }

    // Validate node connections
    for (const node of workflow.nodes) {
      // Validate node-specific connections
      const connectionResult = validateNodeConnections(node);
      if (!connectionResult.valid) {
        for (const error of connectionResult.errors) {
          issues.push({
            type: "connection",
            severity: "error",
            nodeId: node.id,
            field: "connections",
            message: error,
          });
        }
      }

      // Validate connection references exist
      if (node.connections) {
        for (const [outputPath, targetNodeId] of Object.entries(node.connections)) {
          if (!nodeIds.has(targetNodeId)) {
            issues.push({
              type: "connection",
              severity: "error",
              nodeId: node.id,
              field: `connections.${outputPath}`,
              message: `Connection '${outputPath}' references non-existent node '${targetNodeId}'`,
            });
          }
        }
      }
    }

    // Per-node-type validation
    for (const node of workflow.nodes) {
      issues.push(...this.validateNodeType(node, workflow));
    }

    // Template syntax validation
    issues.push(...this.validateTemplates(workflow));

    // Static user-facing progress graph and primary-node mappings.
    issues.push(...this.validateProgress(workflow));

    // Check for unreachable nodes (exclude teleport nodes — they are jump targets)
    const reachableNodes = this.findReachableNodes(workflow);
    const unreachableNodes = workflow.nodes
      .filter((node) => !reachableNodes.has(node.id) && node.type !== "teleport")
      .map((node) => node.id);

    if (unreachableNodes.length > 0) {
      issues.push({
        type: "structure",
        severity: "warning",
        message: `Unreachable nodes found: ${unreachableNodes.join(", ")}`,
      });
    }

    // Performance warnings
    const agentDirectiveCount = workflow.nodes.filter((n) => n.type === "agent-directive").length;
    if (agentDirectiveCount > 20) {
      issues.push({
        type: "structure",
        severity: "warning",
        message: `High number of agent-directive nodes (${agentDirectiveCount}). Consider using subgraphs for better organization.`,
      });
    }

    // Validate subgraph nodes
    const subgraphIssues = this.validateSubgraphReferencesUnified(workflow);
    issues.push(...subgraphIssues);

    // Validate each variableRegistry entry is a well-formed JSON Schema
    issues.push(...this.validateRegistryEntries(workflow));

    return issues;
  }

  private validateProgress(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    const progress = workflow.progress;
    const mappedNodes = workflow.nodes.filter((node) => node.progressNodeId);
    if (!progress) {
      for (const node of workflow.nodes) {
        if (node.type === "telegram-notification" && node.attachProgressImage) {
          issues.push({
            type: "structure",
            severity: "error",
            nodeId: node.id,
            field: "attachProgressImage",
            message: `Telegram node '${node.id}' cannot attach progress without a progress graph.`,
          });
        }
      }
      for (const node of mappedNodes) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressNodeId",
          message: `Node '${node.id}' declares progressNodeId but the workflow has no progress graph.`,
        });
      }
      return issues;
    }

    const ids = new Set<string>();
    for (const [index, node] of progress.nodes.entries()) {
      if (ids.has(node.id)) {
        issues.push({
          type: "structure",
          severity: "error",
          field: `progress.nodes[${index}].id`,
          message: `Duplicate progress node id '${node.id}'.`,
        });
      }
      ids.add(node.id);
    }
    for (const [index, node] of progress.nodes.entries()) {
      const target = node.connections?.default;
      if (target && !ids.has(target)) {
        issues.push({
          type: "connection",
          severity: "error",
          field: `progress.nodes[${index}].connections.default`,
          message: `Progress connection references non-existent progress node '${target}'.`,
        });
      }
    }

    const visibleWaitingTypes = new Set([
      "agent-directive",
      "teleport",
      "lock",
      "materialize",
      "subgraph",
    ]);
    for (const node of workflow.nodes) {
      if (node.progressNodeId && !ids.has(node.progressNodeId)) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressNodeId",
          message: `Node '${node.id}' references unknown progress node '${node.progressNodeId}'.`,
        });
      }
      if (visibleWaitingTypes.has(node.type) && !node.progressNodeId) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressNodeId",
          message: `User-visible waiting node '${node.id}' must declare progressNodeId.`,
        });
      }
      if (node.progressActiveLabel && !visibleWaitingTypes.has(node.type)) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressActiveLabel",
          message: `Node '${node.id}' cannot declare progressActiveLabel because it is not a user-visible waiting node.`,
        });
      } else if (node.progressActiveLabel && !node.progressNodeId) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressActiveLabel",
          message: `Node '${node.id}' must declare progressNodeId when progressActiveLabel is set.`,
        });
      }
      if (node.progressActiveContent && !visibleWaitingTypes.has(node.type)) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressActiveContent",
          message: `Node '${node.id}' cannot declare progressActiveContent because it is not a user-visible waiting node.`,
        });
      } else if (node.progressActiveContent && !node.progressNodeId) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressActiveContent",
          message: `Node '${node.id}' must declare progressNodeId when progressActiveContent is set.`,
        });
      }
      if (
        node.type === "telegram-notification" &&
        node.attachProgressImage &&
        !node.progressNodeId
      ) {
        issues.push({
          type: "structure",
          severity: "error",
          nodeId: node.id,
          field: "progressNodeId",
          message: `Telegram node '${node.id}' must declare progressNodeId when attachProgressImage is enabled.`,
        });
      }
    }

    return issues;
  }

  /**
   * Validate that every variableRegistry entry is a compilable JSON Schema.
   * A registry entry IS a JSON Schema property (type + description required, any keyword allowed),
   * so a malformed entry (bad items/pattern/etc.) is a blocking error. type is required by the
   * graph schema; a non-empty description is enforced here with a friendly message.
   */
  private validateRegistryEntries(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    const registry = workflow.variableRegistry;
    if (!registry || typeof registry !== "object") return issues;

    for (const [name, entry] of Object.entries(registry)) {
      if (!entry || typeof entry !== "object") {
        issues.push({
          type: "structure",
          severity: "error",
          field: `variableRegistry.${name}`,
          message: `Registry variable '${name}' must be a JSON Schema object with type and description.`,
        });
        continue;
      }
      const decl = entry as Record<string, unknown>;
      if (typeof decl.description !== "string" || decl.description.trim() === "") {
        issues.push({
          type: "structure",
          severity: "error",
          field: `variableRegistry.${name}`,
          message: `Registry variable '${name}' is missing a non-empty description.`,
        });
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const testAjv = new (AjvModule as any).default({ allErrors: true });
        registerWorkflowSchemaKeywords(testAjv);
        testAjv.compile(decl);
        if (Object.prototype.hasOwnProperty.call(decl, "default")) {
          const validateDefault = testAjv.compile(decl);
          if (!validateDefault(decl.default)) {
            issues.push({
              type: "structure",
              severity: "error",
              field: `variableRegistry.${name}.default`,
              message: `Registry variable '${name}' has a default that does not satisfy its schema.`,
            });
          }
        }
      } catch (error) {
        issues.push({
          type: "structure",
          severity: "error",
          field: `variableRegistry.${name}`,
          message: `Registry variable '${name}' is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    for (const node of workflow.nodes) {
      if (node.type !== "start" || !node.initialData?.variables) continue;
      for (const [name, definition] of Object.entries(node.initialData.variables)) {
        const schema = registry[name];
        if (!schema) continue;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const testAjv = new (AjvModule as any).default({ allErrors: true });
          const validate = testAjv.compile(schema);
          if (!validate(definition.value ?? null)) {
            issues.push({
              type: "structure",
              severity: "error",
              nodeId: node.id,
              field: `initialData.variables.${name}.value`,
              message: `Start variable '${name}' does not satisfy its declared registry schema.`,
            });
          }
        } catch {
          // The registry schema compilation issue is already reported above.
        }
      }
    }

    for (const [name, rule] of Object.entries(
      workflow.runtimePolicy?.externalVariableWrites ?? {},
    )) {
      if (!registry[name]) {
        issues.push({
          type: "structure",
          severity: "error",
          field: `runtimePolicy.externalVariableWrites.${name}`,
          message: `External-write policy references undeclared variable '${name}'.`,
        });
      }
      for (const nodeId of rule.allowedNodeIds ?? []) {
        const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.type !== "agent-directive") {
          issues.push({
            type: "structure",
            severity: "error",
            field: `runtimePolicy.externalVariableWrites.${name}.allowedNodeIds`,
            message: `External-write node '${nodeId}' must be an agent-directive node.`,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate node-type-specific rules beyond connection and schema validation.
   * Catches semantic issues that AJV and connection checks miss.
   */
  private validateNodeType(node: GraphNode, graph: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    switch (node.type) {
      case "condition":
        issues.push(...this.validateConditionNode(node));
        break;
      case "agent-directive":
        issues.push(...this.validateAgentDirectiveNode(node));
        issues.push(
          ...this.validateOutputScopeDeclaration(
            node.id,
            node.inputSchema as Record<string, unknown> | undefined,
            graph,
          ),
        );
        break;
      case "expression":
        issues.push(...this.validateExpressionNode(node));
        break;
      // These node types have no semantic validation beyond schema + connections
      case "start":
      case "end":
      case "subgraph":
      case "telegram-notification":
      case "read-note":
      case "write-note":
      case "upsert-note":
      case "lock":
        break;
      case "materialize":
        issues.push(...this.validateMaterializeNode(node, graph));
        break;
      case "teleport":
        issues.push(...this.validateTeleportNode(node, graph));
        issues.push(
          ...this.validateOutputScopeDeclaration(
            node.id,
            node.inputSchema as Record<string, unknown> | undefined,
            graph,
          ),
        );
        break;
      default: {
        const _exhaustive: never = node;
        issues.push({
          type: "node",
          severity: "error",
          message: `Unknown node type: ${(_exhaustive as GraphNode).type}`,
          nodeId: (_exhaustive as GraphNode).id,
        });
      }
    }

    return issues;
  }

  /**
   * Validate condition node operator and required fields per operator type.
   */
  private validateConditionNode(node: ConditionNode): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    if (!node.condition || typeof node.condition !== "object") {
      return issues; // AJV already catches missing condition
    }

    issues.push(...this.validateConditionStructure(node.condition, node.id, "condition"));

    return issues;
  }

  /**
   * Recursively validate a StructuredCondition and its nested conditions.
   */
  private validateConditionStructure(
    condition: StructuredCondition,
    nodeId: string,
    fieldPath: string,
  ): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    const VALID_OPERATORS: ConditionOperator[] = [
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "exists",
      "and",
      "or",
      "not",
    ];

    if (!condition.operator) {
      issues.push({
        type: "node",
        severity: "error",
        nodeId,
        field: `${fieldPath}.operator`,
        message: `Node ${nodeId}: condition missing operator`,
      });
      return issues;
    }

    if (!VALID_OPERATORS.includes(condition.operator as ConditionOperator)) {
      issues.push({
        type: "node",
        severity: "error",
        nodeId,
        field: `${fieldPath}.operator`,
        message: `Node ${nodeId}: invalid condition operator "${condition.operator}". Valid: ${VALID_OPERATORS.join(", ")}`,
      });
      return issues;
    }

    // Check required fields per operator type
    const binaryOps: ConditionOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"];
    const logicalOps: ConditionOperator[] = ["and", "or"];

    if (binaryOps.includes(condition.operator)) {
      if (condition.left === undefined) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: `${fieldPath}.left`,
          message: `Node ${nodeId}: operator "${condition.operator}" requires "left" operand`,
        });
      }
      if (condition.right === undefined) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: `${fieldPath}.right`,
          message: `Node ${nodeId}: operator "${condition.operator}" requires "right" operand`,
        });
      }
    } else if (condition.operator === "exists") {
      if (condition.value === undefined) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: `${fieldPath}.value`,
          message: `Node ${nodeId}: operator "exists" requires "value" field`,
        });
      }
    } else if (logicalOps.includes(condition.operator)) {
      if (
        !condition.conditions ||
        !Array.isArray(condition.conditions) ||
        condition.conditions.length === 0
      ) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: `${fieldPath}.conditions`,
          message: `Node ${nodeId}: operator "${condition.operator}" requires non-empty "conditions" array`,
        });
      } else {
        // Recursively validate nested conditions
        for (let i = 0; i < condition.conditions.length; i++) {
          issues.push(
            ...this.validateConditionStructure(
              condition.conditions[i],
              nodeId,
              `${fieldPath}.conditions[${i}]`,
            ),
          );
        }
      }
    } else if (condition.operator === "not") {
      if (!condition.condition || typeof condition.condition !== "object") {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: `${fieldPath}.condition`,
          message: `Node ${nodeId}: operator "not" requires "condition" field`,
        });
      } else {
        // Recursively validate nested condition
        issues.push(
          ...this.validateConditionStructure(condition.condition, nodeId, `${fieldPath}.condition`),
        );
      }
    }

    return issues;
  }

  /**
   * Validate agent-directive node inputSchema is valid JSON Schema if present.
   */
  private validateAgentDirectiveNode(node: AgentDirectiveNode): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    if (node.inputSchema && typeof node.inputSchema === "object") {
      // `globalInputs` is a Moira extension (names of global variables the node writes), not a
      // JSON Schema keyword — strip it before compiling the rest as JSON Schema.
      const { globalInputs: _gi, ...jsonSchema } = node.inputSchema as Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const testAjv = new (AjvModule as any).default({ allErrors: true });
        registerWorkflowSchemaKeywords(testAjv);
        testAjv.compile(jsonSchema);
      } catch (error) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: "inputSchema",
          message: `Node ${node.id}: invalid JSON Schema in inputSchema: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return issues;
  }

  private validateMaterializeNode(
    node: MaterializeNode,
    workflow: WorkflowGraph,
  ): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    const rawPaths = new Set<string>();
    const registry = workflow.variableRegistry ?? {};
    if (!Array.isArray(node.files)) return issues;

    for (const [index, file] of node.files.entries()) {
      const field = `files[${index}]`;
      if (!file || typeof file.path !== "string") continue;
      const normalized = file.path.replaceAll("\\", "/");
      const segments = normalized.split("/");
      if (
        file.path.startsWith("/") ||
        file.path.startsWith("\\") ||
        file.path.includes("\0") ||
        segments.some((segment) => segment === ".." || segment === "." || segment === "")
      ) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: `${field}.path`,
          message: `Node ${node.id}: materialize path '${file.path}' must be a safe relative path`,
        });
      }
      if (rawPaths.has(normalized)) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: `${field}.path`,
          message: `Node ${node.id}: duplicate materialize path '${file.path}'`,
        });
      }
      rawPaths.add(normalized);

      const hasFrom = typeof file.from === "string" && file.from.length > 0;
      const hasContent = Object.prototype.hasOwnProperty.call(file, "content");
      if (hasFrom === hasContent || (hasContent && file.content !== "")) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field,
          message: `Node ${node.id}: ${field} must declare exactly one of from or empty content`,
        });
      } else if (hasFrom) {
        const declaration = registry[file.from!];
        if (!declaration) {
          issues.push({
            type: "node",
            severity: "error",
            nodeId: node.id,
            field: `${field}.from`,
            message: `Node ${node.id}: materialize source '${file.from}' is not declared in variableRegistry`,
          });
        } else if (declaration.type !== "string" || typeof declaration.default !== "string") {
          issues.push({
            type: "node",
            severity: "error",
            nodeId: node.id,
            field: `${field}.from`,
            message: `Node ${node.id}: materialize source '${file.from}' must declare type string with a string default in variableRegistry`,
          });
        }
      }
    }

    return issues;
  }

  /**
   * Validate a node's output-scope declaration (agent-directive / teleport).
   *
   * A node's inputSchema may declare `globalInputs` (names of the workflow-global variables it
   * writes) separately from `properties` (its node-local outputs). Two rules are enforced:
   *  - every declared global write must reference a variable that exists in the variableRegistry
   *    (blocking error otherwise — there is no implicit registration);
   *  - a local output (a `properties` key) must not collide with a declared global name (the same
   *    name cannot be both a global write and a node-local output — it makes routing ambiguous).
   */
  private validateOutputScopeDeclaration(
    nodeId: string,
    inputSchema: Record<string, unknown> | undefined,
    workflow: WorkflowGraph,
  ): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    if (!inputSchema || typeof inputSchema !== "object") return issues;

    const globalInputs = inputSchema.globalInputs;
    if (!Array.isArray(globalInputs) || globalInputs.length === 0) return issues;

    const registry =
      workflow.variableRegistry && typeof workflow.variableRegistry === "object"
        ? (workflow.variableRegistry as Record<string, unknown>)
        : {};
    const localOutputs =
      inputSchema.properties && typeof inputSchema.properties === "object"
        ? (inputSchema.properties as Record<string, unknown>)
        : {};

    for (const name of globalInputs) {
      if (typeof name !== "string") {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: "inputSchema.globalInputs",
          message: `Node ${nodeId}: globalInputs must be variable names (strings); found ${typeof name}.`,
        });
        continue;
      }

      // A declared global write must reference a variable that exists in the registry.
      if (!(name in registry)) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: "inputSchema.globalInputs",
          message: `Node ${nodeId}: declares global write '${name}' which is not in the workflow variableRegistry. Declare '${name}' in variableRegistry or make it a node-local output under inputSchema.properties.`,
        });
      }

      // A local output cannot share a name with a declared global write (ambiguous routing).
      if (name in localOutputs) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: "inputSchema.properties",
          message: `Node ${nodeId}: local output '${name}' shadows the declared global write of the same name. A name is either a global write (globalInputs) or a node-local output (properties), not both.`,
        });
      }
    }

    return issues;
  }

  /**
   * Validate expression node expression syntax.
   * Checks for basic validity: non-empty strings, balanced parentheses,
   * valid characters (alphanumeric, operators, dots, brackets, spaces).
   */
  private validateExpressionNode(node: ExpressionNode): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    if (!node.expressions || !Array.isArray(node.expressions)) {
      return issues; // AJV already catches missing/empty expressions
    }

    for (let i = 0; i < node.expressions.length; i++) {
      const expr = node.expressions[i];
      if (typeof expr !== "string" || expr.trim().length === 0) {
        continue; // AJV catches empty strings
      }

      // Check balanced parentheses
      let depth = 0;
      for (const ch of expr) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: `expressions[${i}]`,
          message: `Node ${node.id}: expression "${expr}" has unbalanced parentheses`,
        });
      }

      // Check for valid expression characters
      // Allow: alphanumeric, spaces, operators (+,-,*,/), dots, brackets, underscores, equals, quotes, comparison
      const validPattern = /^[\w\s+\-*/().=<>!&|,"'[\]{}:]+$/;
      if (!validPattern.test(expr)) {
        issues.push({
          type: "node",
          severity: "warning",
          nodeId: node.id,
          field: `expressions[${i}]`,
          message: `Node ${node.id}: expression "${expr}" contains unusual characters`,
        });
      }

      try {
        parseExpressionAst(expr);
      } catch (error) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: `expressions[${i}]`,
          message: `Node ${node.id}: invalid expression syntax: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return issues;
  }

  /**
   * Validate teleport node: must not have incoming connections from other nodes.
   * Teleport nodes are jump targets only, not reachable via normal flow.
   */
  private validateTeleportNode(node: TeleportNode, graph: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    // Check that no other node connects TO this teleport node
    for (const otherNode of graph.nodes) {
      if (otherNode.id === node.id) continue;
      const connections = otherNode.connections as Record<string, string>;
      if (!connections) continue;
      for (const [path, targetId] of Object.entries(connections)) {
        if (targetId === node.id) {
          issues.push({
            type: "node",
            severity: "error",
            nodeId: node.id,
            field: "connections",
            message: `Teleport node "${node.id}" must not have incoming connections, but "${otherNode.id}" connects to it via "${path}"`,
          });
        }
      }
    }

    return issues;
  }

  /**
   * @deprecated Use validateStructureUnified instead
   */
  private validateStructure(workflow: WorkflowGraph): {
    errors: GraphValidationError[];
    warnings: GraphValidationWarning[];
  } {
    const issues = this.validateStructureUnified(workflow);
    const errors: GraphValidationError[] = [];
    const warnings: GraphValidationWarning[] = [];

    for (const issue of issues) {
      if (issue.severity === "error") {
        errors.push({
          type:
            issue.type === "connection"
              ? "connections"
              : issue.type === "node"
                ? "structure"
                : issue.type,
          nodeId: issue.nodeId,
          path: issue.field,
          message: issue.message,
        });
      } else {
        warnings.push({
          type:
            issue.type === "node"
              ? "best-practices"
              : issue.type === "structure"
                ? "maintainability"
                : "best-practices",
          nodeId: issue.nodeId,
          message: issue.message,
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Find all nodes reachable from start nodes
   */
  private findReachableNodes(workflow: WorkflowGraph): Set<string> {
    const reachable = new Set<string>();
    const visited = new Set<string>();

    // Entry points: the start node, plus every teleport. A teleport has no ordinary incoming
    // connections by design — an agent enters it with step({ teleportTo }) — so whatever it leads
    // to is reachable at runtime and must not be reported as orphaned.
    const entryNodes = workflow.nodes.filter(
      (node) => node.type === "start" || node.type === "teleport",
    );

    // DFS from each entry node
    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      reachable.add(nodeId);

      const node = workflow.nodes.find((n) => n.id === nodeId);
      if (node?.connections) {
        for (const targetId of Object.values(node.connections)) {
          visit(targetId);
        }
      }
    };

    for (const entryNode of entryNodes) {
      visit(entryNode.id);
    }

    return reachable;
  }

  /**
   * Validate subgraph node references and configurations — unified format
   */
  private validateSubgraphReferencesUnified(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    const subgraphNodes = workflow.nodes.filter((node) => node.type === "subgraph");

    for (const node of subgraphNodes) {
      const subgraphNode = node as {
        graphId?: string;
        inputMapping?: Record<string, unknown>;
        outputMapping?: Record<string, unknown>;
        connections?: Record<string, string>;
      };

      // Validate graphId is not empty
      if (!subgraphNode.graphId || typeof subgraphNode.graphId !== "string") {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: "graphId",
          message: "Subgraph node must have a valid graphId",
        });
        continue;
      }

      // Validate inputMapping
      if (!subgraphNode.inputMapping || typeof subgraphNode.inputMapping !== "object") {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: "inputMapping",
          message: "Subgraph node must have an inputMapping object",
        });
      } else {
        for (const [parentPath, childKey] of Object.entries(subgraphNode.inputMapping)) {
          if (!parentPath || typeof parentPath !== "string") {
            issues.push({
              type: "node",
              severity: "error",
              nodeId: node.id,
              field: "inputMapping",
              message: `Invalid input mapping source path: "${parentPath}"`,
            });
          }
          if (!childKey || typeof childKey !== "string") {
            issues.push({
              type: "node",
              severity: "error",
              nodeId: node.id,
              field: "inputMapping",
              message: `Invalid input mapping target key: "${childKey}"`,
            });
          }
        }
      }

      // Validate outputMapping
      if (!subgraphNode.outputMapping || typeof subgraphNode.outputMapping !== "object") {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: "outputMapping",
          message: "Subgraph node must have an outputMapping object",
        });
      } else {
        for (const [childPath, parentKey] of Object.entries(subgraphNode.outputMapping)) {
          if (!childPath || typeof childPath !== "string") {
            issues.push({
              type: "node",
              severity: "error",
              nodeId: node.id,
              field: "outputMapping",
              message: `Invalid output mapping source path: "${childPath}"`,
            });
          }
          if (!parentKey || typeof parentKey !== "string") {
            issues.push({
              type: "node",
              severity: "error",
              nodeId: node.id,
              field: "outputMapping",
              message: `Invalid output mapping target key: "${parentKey}"`,
            });
          }
        }
      }

      // Self-reference error — guaranteed infinite recursion
      if (subgraphNode.graphId === workflow.id) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId: node.id,
          field: "graphId",
          message: `Subgraph node references itself (${workflow.id}). This causes infinite recursion.`,
        });
      }

      // Validate required connections
      if (!subgraphNode.connections || typeof subgraphNode.connections !== "object") {
        issues.push({
          type: "connection",
          severity: "error",
          nodeId: node.id,
          field: "connections",
          message: "Subgraph node must have connections object",
        });
      } else if (!subgraphNode.connections.success) {
        issues.push({
          type: "connection",
          severity: "error",
          nodeId: node.id,
          field: "connections.success",
          message: "Subgraph node must have a success connection",
        });
      }

      // Performance warnings
      const inputMappingCount = Object.keys(subgraphNode.inputMapping || {}).length;
      const outputMappingCount = Object.keys(subgraphNode.outputMapping || {}).length;

      if (inputMappingCount > 50) {
        issues.push({
          type: "node",
          severity: "warning",
          nodeId: node.id,
          field: "inputMapping",
          message: `Large input mapping (${inputMappingCount} variables). Consider reducing complexity.`,
        });
      }

      if (outputMappingCount > 50) {
        issues.push({
          type: "node",
          severity: "warning",
          nodeId: node.id,
          field: "outputMapping",
          message: `Large output mapping (${outputMappingCount} variables). Consider reducing complexity.`,
        });
      }
    }

    // Circular reference detection
    if (subgraphNodes.length > 0) {
      const circularWarning = this.detectPotentialCircularReferences(workflow, subgraphNodes);
      if (circularWarning) {
        issues.push({
          type: "node",
          severity: "warning",
          message: circularWarning.message,
        });
      }
    }

    return issues;
  }

  /**
   * @deprecated Use validateSubgraphReferencesUnified instead
   */
  private validateSubgraphReferences(workflow: WorkflowGraph): {
    errors: GraphValidationError[];
    warnings: GraphValidationWarning[];
  } {
    const issues = this.validateSubgraphReferencesUnified(workflow);
    const errors: GraphValidationError[] = [];
    const warnings: GraphValidationWarning[] = [];

    for (const issue of issues) {
      if (issue.severity === "error") {
        errors.push({
          type: issue.type === "connection" ? "references" : "structure",
          nodeId: issue.nodeId,
          message: issue.message,
        });
      } else {
        warnings.push({
          type: "best-practices",
          nodeId: issue.nodeId,
          message: issue.message,
        });
      }
    }

    return { errors, warnings };
  }

  /**
   * Detect potential circular reference chains in subgraph nodes
   */
  private detectPotentialCircularReferences(
    workflow: WorkflowGraph,
    subgraphNodes: Array<{ graphId: string }>,
  ): GraphValidationWarning | null {
    const referencedWorkflows = subgraphNodes.map((node) => node.graphId);
    const uniqueReferences = new Set(referencedWorkflows);

    // If a workflow references itself multiple times, warn about potential complexity
    if (referencedWorkflows.length !== uniqueReferences.size) {
      return {
        type: "best-practices",
        message: `Workflow contains multiple references to the same subgraph. This may indicate circular dependencies or excessive complexity.`,
      };
    }

    // If too many subgraph nodes, warn about potential performance issues
    if (subgraphNodes.length > 10) {
      return {
        type: "performance",
        message: `Workflow contains ${subgraphNodes.length} subgraph nodes. Consider consolidating for better performance.`,
      };
    }

    return null;
  }

  /**
   * Validate template syntax in workflow fields.
   * Checks for unclosed brackets and undefined variable references.
   * This is design-time validation — runtime template processing is in GraphTemplateProcessor.
   */
  private validateTemplates(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    // Extract defined variables from start node initialData
    const definedVariables = this.extractDefinedVariables(workflow);

    // Check template fields in each node
    for (const node of workflow.nodes) {
      if (node.type === "agent-directive") {
        const agentNode = node as AgentDirectiveNode;

        // Check directive field
        if (agentNode.directive) {
          issues.push(
            ...this.validateTemplateField(
              agentNode.directive,
              node.id,
              "directive",
              definedVariables,
            ),
          );
        }

        // Check completionCondition field
        if (agentNode.completionCondition) {
          issues.push(
            ...this.validateTemplateField(
              agentNode.completionCondition,
              node.id,
              "completionCondition",
              definedVariables,
            ),
          );
        }
      }

      // Teleport directives are semantically directives — validate their templates too.
      if (node.type === "teleport") {
        const teleportNode = node as { directive?: string; completionCondition?: string };

        if (teleportNode.directive) {
          issues.push(
            ...this.validateTemplateField(
              teleportNode.directive,
              node.id,
              "directive",
              definedVariables,
            ),
          );
        }

        if (teleportNode.completionCondition) {
          issues.push(
            ...this.validateTemplateField(
              teleportNode.completionCondition,
              node.id,
              "completionCondition",
              definedVariables,
            ),
          );
        }
      }

      if (node.type === "telegram-notification") {
        const telegramNode = node as { message?: string };

        // Check message field
        if (telegramNode.message) {
          issues.push(
            ...this.validateTemplateField(
              telegramNode.message,
              node.id,
              "message",
              definedVariables,
            ),
          );
        }
      }

      if (node.type === "materialize") {
        if (typeof node.basePath === "string") {
          issues.push(
            ...this.validateTemplateField(node.basePath, node.id, "basePath", definedVariables),
          );
        }
        if (Array.isArray(node.files)) {
          for (let index = 0; index < node.files.length; index++) {
            if (typeof node.files[index]?.path === "string") {
              issues.push(
                ...this.validateTemplateField(
                  node.files[index].path,
                  node.id,
                  `files[${index}].path`,
                  definedVariables,
                ),
              );
            }
          }
        }
      }

      // Check condition contextPath references against declared variables.
      if (node.type === "condition") {
        const conditionNode = node as ConditionNode;
        if (conditionNode.condition) {
          issues.push(
            ...this.validateConditionReferences(conditionNode.condition, node.id, definedVariables),
          );
        }
      }

      if (node.progressActiveLabel) {
        issues.push(
          ...this.validateTemplateField(
            node.progressActiveLabel,
            node.id,
            "progressActiveLabel",
            definedVariables,
          ),
        );
      }
      if (node.progressActiveContent) {
        const content = node.progressActiveContent;
        for (const [field, value] of Object.entries(content)) {
          const values = Array.isArray(value) ? value : [value];
          for (const [index, template] of values.entries()) {
            issues.push(
              ...this.validateTemplateField(
                template,
                node.id,
                Array.isArray(value)
                  ? `progressActiveContent.${field}[${index}]`
                  : `progressActiveContent.${field}`,
                definedVariables,
              ),
            );
          }
        }
      }
    }

    // Templates embedded in registry variable default values are processed recursively at
    // runtime, so their {{...}} references must resolve under the same rules. A variable's
    // own name is allowed as a self-reference root (the value is read by its own name).
    if (workflow.variableRegistry && typeof workflow.variableRegistry === "object") {
      for (const [varName, decl] of Object.entries(workflow.variableRegistry)) {
        if (decl && typeof (decl as { default?: unknown }).default === "string") {
          issues.push(
            ...this.validateTemplateField(
              (decl as { default: string }).default,
              `variableRegistry.${varName}`,
              "default",
              definedVariables,
              { undefinedVarsOnly: true },
            ),
          );
        }
      }
    }

    if (workflow.progress) {
      if (workflow.progress.title) {
        issues.push(
          ...this.validateTemplateField(
            workflow.progress.title,
            "progress",
            "title",
            definedVariables,
          ),
        );
      }
      if (workflow.progress.goal) {
        issues.push(
          ...this.validateTemplateField(
            workflow.progress.goal,
            "progress",
            "goal",
            definedVariables,
          ),
        );
      }
      for (const [index, fact] of (workflow.progress.facts ?? []).entries()) {
        issues.push(
          ...this.validateTemplateField(
            fact.label,
            "progress",
            `facts[${index}].label`,
            definedVariables,
          ),
          ...this.validateTemplateField(
            fact.value,
            "progress",
            `facts[${index}].value`,
            definedVariables,
          ),
        );
      }
      for (const [index, progressNode] of workflow.progress.nodes.entries()) {
        issues.push(
          ...this.validateTemplateField(
            progressNode.label,
            `progress.${progressNode.id}`,
            `nodes[${index}].label`,
            definedVariables,
          ),
        );
        if (progressNode.content) {
          for (const [field, value] of Object.entries(progressNode.content)) {
            const values = Array.isArray(value) ? value : [value];
            for (const [valueIndex, template] of values.entries()) {
              issues.push(
                ...this.validateTemplateField(
                  template,
                  `progress.${progressNode.id}`,
                  Array.isArray(value)
                    ? `nodes[${index}].content.${field}[${valueIndex}]`
                    : `nodes[${index}].content.${field}`,
                  definedVariables,
                ),
              );
            }
          }
        }
      }
    }

    // §10 Fix A — warn on declared-but-never-defined registry variables.
    issues.push(...this.validateNeverDefinedVars(workflow));

    return issues;
  }

  /**
   * Walk a StructuredCondition tree and validate that every contextPath reference's
   * root segment is a declared global or a known node id. Unknown roots are errors.
   */
  private validateConditionReferences(
    condition: StructuredCondition,
    nodeId: string,
    definedVariables: Set<string>,
  ): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    const systemVars = new Set(["executionId", "workflowId", "userId"]);

    const checkOperand = (operand: unknown): void => {
      if (
        operand &&
        typeof operand === "object" &&
        "contextPath" in operand &&
        typeof (operand as { contextPath: unknown }).contextPath === "string"
      ) {
        const path = (operand as { contextPath: string }).contextPath;
        const rootVar = path.split(".")[0].split("[")[0];
        if (!rootVar || systemVars.has(rootVar) || definedVariables.has(rootVar)) {
          return;
        }
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: "condition.contextPath",
          message: `Node ${nodeId}: condition references undeclared variable '${rootVar}'. Declare it in the workflow variableRegistry or reference a node-local value as 'node-id.name'.`,
        });
      }
    };

    const walk = (cond: StructuredCondition): void => {
      if (!cond || typeof cond !== "object") return;
      checkOperand(cond.left);
      checkOperand(cond.right);
      checkOperand(cond.value);
      if (Array.isArray(cond.conditions)) {
        for (const nested of cond.conditions) walk(nested);
      }
      if (cond.condition) walk(cond.condition);
    };

    walk(condition);
    return issues;
  }

  /**
   * Extract the set of names a template/condition may reference by their root segment:
   *  - declared global variables (the variableRegistry — the single source of truth), and
   *  - every node id (so `node-id.name` node-local references are recognized — the root
   *    segment of such a reference is the node id).
   */
  private extractDefinedVariables(workflow: WorkflowGraph): Set<string> {
    const definedVars = new Set<string>();

    // Global variables: declared in the registry (single source of truth).
    if (workflow.variableRegistry && typeof workflow.variableRegistry === "object") {
      for (const varName of Object.keys(workflow.variableRegistry)) {
        definedVars.add(varName);
      }
    }

    // Node ids: a `node-id.name` reference resolves to that node's local scope, so the
    // root segment (the node id) is a valid reference root.
    for (const node of workflow.nodes) {
      definedVars.add(node.id);
    }

    return definedVars;
  }

  /**
   * §10 Fix A — registry variables that can NEVER hold a value at runtime:
   * declared in the variableRegistry WITHOUT a `default`, AND not seeded by the start
   * node's initialData, AND not written by any node's inputSchema.globalInputs. Such a
   * variable always renders as the undefined placeholder. Conservative (no reachability
   * ordering — only flags vars with NO writer at all), so it yields no false positives.
   */
  private findNeverDefinedRegistryVars(workflow: WorkflowGraph): Set<string> {
    const never = new Set<string>();
    const registry = workflow.variableRegistry;
    if (!registry || typeof registry !== "object") return never;

    const seededOrWritten = new Set<string>();
    for (const node of workflow.nodes) {
      // agent-directive / teleport write globals via inputSchema.globalInputs
      const gi = (node as { inputSchema?: { globalInputs?: unknown } }).inputSchema?.globalInputs;
      if (Array.isArray(gi)) for (const name of gi) seededOrWritten.add(String(name));
      // expression nodes write the assignment LHS (e.g. "counter = counter + 1")
      const exprs = (node as { expressions?: unknown }).expressions;
      if (Array.isArray(exprs)) {
        for (const expr of exprs) {
          if (typeof expr !== "string") continue;
          const eq = expr.indexOf("=");
          if (eq <= 0) continue;
          const lhsRoot = expr.slice(0, eq).trim().split(/[.[]/)[0].trim();
          if (lhsRoot) seededOrWritten.add(lhsRoot);
        }
      }
      // start node seeds its initialData
      if (node.type === "start") {
        const vars = node.initialData?.variables;
        if (vars) for (const k of Object.keys(vars)) seededOrWritten.add(k);
      }
    }

    for (const [name, decl] of Object.entries(registry as Record<string, unknown>)) {
      const hasDefault =
        decl && typeof decl === "object" && (decl as { default?: unknown }).default !== undefined;
      if (!hasDefault && !seededOrWritten.has(name)) never.add(name);
    }
    return never;
  }

  /** Collect the root segment of every {{var}} / block-helper reference in a template field. */
  private collectReferencedRoots(content: string): Set<string> {
    const roots = new Set<string>();
    const variablePattern = /\{\{([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}\}/g;
    const blockHelperPattern =
      /\{\{#(?:if|unless|each|eq|neq)\s+([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
    const skip = new Set(["else", "this", "executionId", "workflowId", "userId"]);
    const add = (full: string): void => {
      const root = full.split(".")[0];
      if (!skip.has(root)) roots.add(root);
    };
    let m: RegExpExecArray | null;
    while ((m = variablePattern.exec(content)) !== null) add(m[1]);
    while ((m = blockHelperPattern.exec(content)) !== null) add(m[1]);
    return roots;
  }

  /**
   * §10 Fix A — emit a warning for any template field that references a never-defined
   * registry variable (declared without default, never written). Separate from the
   * undefined-variable ERROR path; warnings do not fail validation.
   */
  private validateNeverDefinedVars(workflow: WorkflowGraph): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];
    const neverDefined = this.findNeverDefinedRegistryVars(workflow);
    if (neverDefined.size === 0) return issues;

    for (const node of workflow.nodes) {
      const n = node as { directive?: string; completionCondition?: string; message?: string };
      const fields: Array<[string, string]> = [];
      if (n.directive) fields.push(["directive", n.directive]);
      if (n.completionCondition) fields.push(["completionCondition", n.completionCondition]);
      if (n.message) fields.push(["message", n.message]);
      for (const [field, content] of fields) {
        for (const root of this.collectReferencedRoots(content)) {
          if (neverDefined.has(root)) {
            issues.push({
              type: "node",
              severity: "warning",
              nodeId: node.id,
              field,
              message: `Node ${node.id}: ${field} references '${root}', declared in variableRegistry without a default and never written by any node (globalInputs) — it will render as [[UNDEFINED_VARIABLE]] at runtime. Add a default to the variable, or ensure an upstream node writes it.`,
            });
          }
        }
      }
    }
    return issues;
  }

  /**
   * Validate a single template field for syntax errors and undefined variables.
   * Returns validation issues.
   */
  private validateTemplateField(
    content: string,
    nodeId: string,
    fieldName: string,
    definedVariables: Set<string>,
    options?: { undefinedVarsOnly?: boolean },
  ): UnifiedValidationIssue[] {
    const issues: UnifiedValidationIssue[] = [];

    // Bracket-balance checks apply to template fields (directives/conditions/messages).
    // They are skipped for free-form data like registry default values, which legitimately
    // contain JSON braces (e.g. {"type":"string"}) that are not template handlebars.
    if (!options?.undefinedVarsOnly) {
      // Check for unclosed opening brackets {{
      const unclosedOpening = this.findUnclosedOpeningBrackets(content);
      if (unclosedOpening.length > 0) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: fieldName,
          message: `Node ${nodeId}: unclosed template bracket '{{' at position ${unclosedOpening[0]}`,
        });
      }

      // Check for unclosed closing brackets }}
      const unclosedClosing = this.findUnclosedClosingBrackets(content);
      if (unclosedClosing.length > 0) {
        issues.push({
          type: "node",
          severity: "error",
          nodeId,
          field: fieldName,
          message: `Node ${nodeId}: unexpected closing bracket '}}' at position ${unclosedClosing[0]}`,
        });
      }

      if (unclosedOpening.length > 0 || unclosedClosing.length > 0) {
        // Skip undefined-variable detection when brackets are unbalanced.
        return issues;
      }
    }

    const undefinedVars = this.findUndefinedVariables(content, definedVariables);
    for (const varName of undefinedVars) {
      issues.push({
        type: "node",
        severity: "error",
        nodeId,
        field: fieldName,
        message: `Node ${nodeId}: ${fieldName} references undeclared variable '${varName}'. Declare it in the workflow variableRegistry or reference a node-local value as 'node-id.name'.`,
      });
    }

    return issues;
  }

  /**
   * Find positions of unclosed opening brackets '{{'.
   * Uses depth tracking to correctly handle nested brackets.
   * Returns array with position of first unclosed bracket if any exist.
   */
  private findUnclosedOpeningBrackets(content: string): number[] {
    const openingPositions: number[] = [];
    let depth = 0;
    let i = 0;

    while (i < content.length - 1) {
      if (content[i] === "{" && content[i + 1] === "{") {
        openingPositions.push(i);
        depth++;
        i += 2;
      } else if (content[i] === "}" && content[i + 1] === "}") {
        if (depth > 0) {
          openingPositions.pop(); // matched
          depth--;
        }
        i += 2;
      } else {
        i++;
      }
    }

    // Return remaining unmatched positions
    return openingPositions;
  }

  /**
   * Find positions of unclosed closing brackets '}}'.
   * Returns array of positions where '}}' has no matching '{{'.
   */
  private findUnclosedClosingBrackets(content: string): number[] {
    const unclosed: number[] = [];
    let depth = 0;
    let i = 0;

    while (i < content.length - 1) {
      if (content[i] === "{" && content[i + 1] === "{") {
        depth++;
        i += 2;
      } else if (content[i] === "}" && content[i + 1] === "}") {
        if (depth === 0) {
          unclosed.push(i);
        } else {
          depth--;
        }
        i += 2;
      } else {
        i++;
      }
    }

    return unclosed;
  }

  /**
   * Find template variables that are not defined in initialData.
   * Returns set of undefined variable names.
   *
   * Checks two reference forms:
   * 1. Simple substitutions: {{varName}} and {{varName.path}}.
   * 2. Block-helper arguments: the variable used by {{#if VAR}}, {{#unless VAR}},
   *    {{#each VAR}}, {{#eq VAR '...'}}, {{#neq VAR '...'}}. These were previously
   *    skipped wholesale (anything starting with '#'), which let undeclared variables
   *    inside block helpers pass validation and render as the undefined placeholder
   *    at runtime.
   *
   * Control flow keywords ({{else}}, {{this}}) are excluded.
   * System variables (executionId, workflowId, userId) are excluded.
   * Variables set by previous nodes are not validated (would need runtime context).
   */
  private findUndefinedVariables(content: string, definedVariables: Set<string>): Set<string> {
    const undefinedVars = new Set<string>();

    // Pattern matches {{varName}} and {{varName.path.to.field}}
    // First segment supports kebab-case for node IDs
    const variablePattern = /\{\{([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}\}/g;

    // Pattern matches the variable argument of an opening block helper:
    // {{#if VAR}}, {{#unless VAR}}, {{#each VAR}}, {{#eq VAR '...'}}, {{#neq VAR '...'}}.
    // Mirrors the helper syntax accepted by GraphTemplateProcessor so the validator
    // catches the same references the runtime would try to resolve.
    const blockHelperPattern =
      /\{\{#(?:if|unless|each|eq|neq)\s+([a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;

    // Control flow and special keywords to skip
    const skipKeywords = new Set([
      "else",
      "this",
      "executionId",
      "workflowId",
      "userId", // System variables (injected into globalContext by the executor)
    ]);

    const collect = (fullPath: string): void => {
      const rootVar = fullPath.split(".")[0];

      // Skip control flow keywords and system variables
      if (skipKeywords.has(rootVar)) {
        return;
      }

      // Check if root variable is defined
      if (!definedVariables.has(rootVar)) {
        undefinedVars.add(rootVar);
      }
    };

    let match;
    while ((match = variablePattern.exec(content)) !== null) {
      collect(match[1]);
    }
    while ((match = blockHelperPattern.exec(content)) !== null) {
      collect(match[1]);
    }

    return undefinedVars;
  }

  /**
   * Format validation errors for human readability
   */
  formatValidationErrors(result: GraphValidationResult): string {
    if (result.valid) {
      return "Workflow is valid";
    }

    const lines: string[] = ["Workflow validation failed:"];

    // Format errors
    for (const error of result.errors) {
      const prefix = error.nodeId ? `[${error.nodeId}] ` : "";
      lines.push(`  ❌ ${prefix}${error.message}`);
    }

    // Format warnings
    for (const warning of result.warnings) {
      const prefix = warning.nodeId ? `[${warning.nodeId}] ` : "";
      lines.push(`  ⚠️  ${prefix}${warning.message}`);
    }

    return lines.join("\n");
  }
}
