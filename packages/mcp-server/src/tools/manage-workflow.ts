/**
 * Manage Workflow MCP Tool
 * Consolidated tool for workflow management with action-based routing
 * Replaces: create_workflow, edit_workflow, get_workflow_details
 *
 * Architecture: "Throw Early, Catch Late, Log Once at Boundary"
 * - This is the MCP BOUNDARY - single place for logging MCP tool errors
 *
 * Actions:
 * - create: Create a new workflow
 * - edit: Edit an existing workflow
 * - get: Get full workflow with optional pagination
 * - get-structure: Get metadata and graph connections without full node content (for large workflows)
 * - get-node: Get a specific node by ID
 * - search-nodes: Search nodes by text in directive/completionCondition
 * - validate: Validate workflow structure without saving
 * - list-variables: List declared global variables (variableRegistry; legacy start initialData as fallback)
 * - get-variable: Get a specific declared global variable
 * - set-variable: Set a declared global variable (writes to variableRegistry; legacy initialData fallback)
 * - delete-variable: Delete a declared global variable
 * - diff: Compare two workflows and show differences
 */

import { z } from "zod";
import { MCPEngine } from "../core/mcp-engine.js";
import { WorkflowGraph, GraphValidator } from "@mcp-moira/workflow-engine";
import { randomUUID } from "crypto";
import { ToolResult } from "./interfaces/tool-interface.js";
import { getUserContext } from "../core/request-context.js";
import {
  getWorkflowService,
  getWorkflowSharingService,
  getWorkflowStructure,
  getNode as getNodeFromWorkflow,
  searchNodes as searchNodesInWorkflow,
  getWorkflowVariables,
  getWorkflowVariable,
  setWorkflowVariable,
  deleteWorkflowVariable,
  // New shared functions for CLI/MCP parity
  listNodesCompact,
  analyzeVariableUsage,
  searchWorkflow,
  buildFlowGraph,
  createLogger,
  isOperationalError,
  normalizeError,
} from "@mcp-moira/shared";
import { ERRORS, SUCCESS, formatDomainError } from "../messages/index.js";

const logger = createLogger({ component: "ManageWorkflow" });

const ManageWorkflowParamsSchema = z.object({
  action: z
    .enum([
      "create",
      "edit",
      "get",
      "get-structure",
      "get-node",
      "search-nodes",
      "validate",
      "get-variable",
      "set-variable",
      "list-variables",
      "delete-variable",
      "diff",
      "copy",
      "clone-node",
      "move-node",
      // New actions for CLI/MCP parity
      "list-nodes",
      "get-nodes",
      "analyze-variables",
      "set-visibility",
      // Sharing actions (Issue #433)
      "create-invite",
      "list-access",
      "list-invites",
      "revoke-access",
      "revoke-invite",
    ])
    .describe("Action to perform"),
  workflowId: z.string().optional().describe("Workflow ID (required for most actions)"),
  workflow: z.any().optional().describe("Workflow object (required for create and validate)"),
  overwrite: z.boolean().optional().describe("Overwrite existing workflow (create only)"),
  changes: z.any().optional().describe("Changes to apply (edit only)"),
  includeNodes: z.boolean().optional().describe("Include nodes in response (get only)"),
  includeValidation: z.boolean().optional().describe("Include validation info (get only)"),
  offset: z.number().optional().describe("Pagination offset (get only)"),
  limit: z.number().optional().describe("Pagination limit (get only)"),
  nodeId: z.string().optional().describe("Node ID (required for get-node, clone-node)"),
  query: z.string().optional().describe("Search query (required for search-nodes, supports regex)"),
  // Variable management parameters
  variableName: z
    .string()
    .optional()
    .describe("Variable name (required for get-variable, set-variable, delete-variable)"),
  variableValue: z.any().optional().describe("Variable value (required for set-variable)"),
  // Diff parameters
  compareWorkflowId: z
    .string()
    .optional()
    .describe("Workflow ID to compare against (required for diff)"),
  // Copy parameters
  newName: z.string().optional().describe("New name for copied workflow (copy only)"),
  newId: z.string().optional().describe("New ID for cloned node (clone-node only)"),
  // Move parameters
  targetIndex: z.number().optional().describe("Target position for node (move-node only)"),
  afterNodeId: z
    .string()
    .optional()
    .describe("Place node after this node ID (move-node only, alternative to targetIndex)"),
  // List-nodes parameters
  typeFilter: z.string().optional().describe("Filter nodes by type (list-nodes only)"),
  includePreview: z.boolean().optional().describe("Include directive preview (list-nodes only)"),
  previewLength: z
    .number()
    .optional()
    .describe("Length of directive preview (list-nodes only, default 100)"),
  // Get-nodes parameters
  nodeIds: z
    .array(z.string())
    .optional()
    .describe("Array of node IDs to retrieve (get-nodes only)"),
  // Search-nodes enhancements
  includeVariables: z
    .boolean()
    .optional()
    .describe("Include variables in search (search-nodes only)"),
  snippetMode: z
    .boolean()
    .optional()
    .describe("Return only snippets, not full nodes (search-nodes only)"),
  // Get-structure enhancements
  graph: z.boolean().optional().describe("Return ASCII flow graph (get-structure only)"),
  detailed: z
    .boolean()
    .optional()
    .describe("Include directive preview in structure (get-structure only)"),
  // Set-visibility parameters
  visibility: z
    .enum(["public", "private"])
    .optional()
    .describe("New visibility setting (set-visibility only)"),
  // Sharing parameters (Issue #433)
  inviteId: z.string().optional().describe("Invite ID (required for revoke-invite)"),
  targetUserId: z
    .string()
    .optional()
    .describe("User ID to revoke access from (revoke-access only)"),
  ttlMs: z
    .number()
    .optional()
    .describe("Invite expiration time in milliseconds (create-invite only, default 7 days)"),
  activeOnly: z
    .boolean()
    .optional()
    .describe("Filter to active (unused) invites only (list-invites only, default true)"),
});

type ManageWorkflowParams = z.infer<typeof ManageWorkflowParamsSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkflowData = any;

/**
 * Helper function to resolve a workflow identifier (UUID, slug, or handle/slug)
 * Returns the resolved workflow info or throws an error
 */
async function resolveWorkflowIdentifier(
  repository: ReturnType<typeof MCPEngine.getInstance>["repository"],
  identifier: string,
  userId: string,
): Promise<{ workflow: WorkflowGraph; workflowId: string; slug: string }> {
  const resolved = await repository.resolveWorkflow(identifier, userId);
  if (!resolved) {
    throw new Error(ERRORS.workflow_not_found(identifier));
  }
  return resolved;
}

export async function manageWorkflow(
  params: ManageWorkflowParams,
): Promise<ToolResult<WorkflowData>> {
  try {
    const { action } = params;
    const { userId } = getUserContext();
    const repository = MCPEngine.getInstance().repository;

    switch (action) {
      case "create": {
        const { workflow, overwrite = false } = params;

        if (!workflow) {
          return { success: false, error: ERRORS.workflow_object_required };
        }

        if (!workflow.id) {
          workflow.id = `workflow-${randomUUID().slice(0, 8)}`;
        }

        if (!workflow.metadata) {
          return { success: false, error: ERRORS.workflow_metadata_required };
        }

        const visibility = workflow.visibility || "private";
        const { visibility: _removed, ...workflowGraph } = workflow;

        const existingWorkflow = await repository.getWorkflowGraph(workflowGraph.id!, userId);
        if (existingWorkflow && !overwrite) {
          return {
            success: false,
            error: ERRORS.workflow_already_exists(workflowGraph.id!),
          };
        }

        const validator = new GraphValidator();
        const validationResult = await validator.validateWorkflow(workflowGraph as WorkflowGraph);

        if (!validationResult.valid) {
          const errors = validationResult.errors.map((e) => e.message).join("; ");
          return {
            success: false,
            error: ERRORS.workflow_validation_failed(errors),
          };
        }

        // Save workflow via service (handles audit automatically)
        const workflowService = getWorkflowService();
        const saveResult = await workflowService.save({
          graph: workflowGraph as WorkflowGraph,
          userId,
          visibility,
          isUpdate: overwrite && !!existingWorkflow,
        });

        const response = {
          success: true,
          workflowId: saveResult.id,
          slug: saveResult.slug,
          message: overwrite
            ? SUCCESS.workflow_updated(saveResult.id)
            : SUCCESS.workflow_created(saveResult.id),
          metadata: {
            name: workflow.metadata.name,
            version: workflow.metadata.version,
            description: workflow.metadata.description,
            nodeCount: workflow.nodes.length,
          },
          systemReminder: workflowGraph.systemReminder || null,
          validation: {
            valid: validationResult.valid,
            warnings:
              validationResult.warnings.length > 0
                ? validationResult.warnings.map((w) => w.message)
                : undefined,
          },
        };

        return { success: true, data: response };
      }

      case "edit": {
        const { workflowId, changes } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("edit") };
        }

        if (!changes || Object.keys(changes).length === 0) {
          return { success: false, error: ERRORS.changes_required };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const existingWorkflow = resolved.workflow;

        const modifiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(existingWorkflow));

        if (changes.metadata) {
          modifiedWorkflow.metadata = {
            ...modifiedWorkflow.metadata,
            ...changes.metadata,
          };
        }

        // Support for systemReminder field
        if ("systemReminder" in changes) {
          modifiedWorkflow.systemReminder = changes.systemReminder || undefined;
        }

        // Replace the declared global variable registry
        if ("variableRegistry" in changes) {
          modifiedWorkflow.variableRegistry = changes.variableRegistry || undefined;
        }

        if (changes.removeNodes && changes.removeNodes.length > 0) {
          const nodeIdsToRemove = new Set(changes.removeNodes);
          modifiedWorkflow.nodes = modifiedWorkflow.nodes.filter(
            (node) => !nodeIdsToRemove.has(node.id),
          );
        }

        if (changes.updateNodes && changes.updateNodes.length > 0) {
          for (const update of changes.updateNodes) {
            const nodeIndex = modifiedWorkflow.nodes.findIndex((n) => n.id === update.nodeId);
            if (nodeIndex === -1) {
              return { success: false, error: ERRORS.node_not_found(update.nodeId) };
            }

            const existingNode = modifiedWorkflow.nodes[nodeIndex];

            modifiedWorkflow.nodes[nodeIndex] = {
              type: existingNode.type,
              id: existingNode.id,
              connections: existingNode.connections,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ...(update.changes as any),
            };
          }
        }

        if (changes.addNodes && changes.addNodes.length > 0) {
          const existingIds = new Set(modifiedWorkflow.nodes.map((n) => n.id));
          for (const newNode of changes.addNodes) {
            if (existingIds.has(newNode.id)) {
              return { success: false, error: ERRORS.node_id_exists(newNode.id) };
            }
            existingIds.add(newNode.id);
          }

          modifiedWorkflow.nodes.push(...changes.addNodes);
        }

        // Handle removeConnections - remove specific connections from nodes
        if (changes.removeConnections && changes.removeConnections.length > 0) {
          for (const removal of changes.removeConnections) {
            const nodeIndex = modifiedWorkflow.nodes.findIndex((n) => n.id === removal.nodeId);
            if (nodeIndex === -1) {
              return { success: false, error: ERRORS.node_not_found(removal.nodeId) };
            }

            const node = modifiedWorkflow.nodes[nodeIndex];
            if (node.connections && typeof node.connections === "object") {
              const connections = node.connections as Record<string, string>;
              if (removal.connectionKey in connections) {
                delete connections[removal.connectionKey];
              }
            }
          }
        }

        const validator = new GraphValidator();
        const validationResult = await validator.validateWorkflow(modifiedWorkflow);

        if (!validationResult.valid) {
          const errors = validationResult.errors.map((e) => e.message).join("; ");
          return {
            success: false,
            error: ERRORS.modified_workflow_validation_failed(errors),
          };
        }

        // Save workflow via service (handles audit automatically)
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: modifiedWorkflow,
          userId,
          isUpdate: true,
        });

        const response = {
          success: true,
          workflowId: modifiedWorkflow.id,
          message: SUCCESS.workflow_updated(workflowId),
          changes: {
            metadataUpdated: !!changes.metadata,
            systemReminderUpdated: "systemReminder" in changes,
            nodesAdded: changes.addNodes?.length || 0,
            nodesRemoved: changes.removeNodes?.length || 0,
            nodesUpdated: changes.updateNodes?.length || 0,
            connectionsRemoved: changes.removeConnections?.length || 0,
          },
          metadata: {
            name: modifiedWorkflow.metadata.name,
            version: modifiedWorkflow.metadata.version,
            description: modifiedWorkflow.metadata.description,
            nodeCount: modifiedWorkflow.nodes.length,
          },
          systemReminder: modifiedWorkflow.systemReminder || null,
          validation: {
            valid: validationResult.valid,
            warnings:
              validationResult.warnings.length > 0
                ? validationResult.warnings.map((w) => w.message)
                : undefined,
          },
        };

        return { success: true, data: response };
      }

      case "get": {
        const { workflowId, includeNodes = true, includeValidation = true, offset, limit } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("get") };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);

        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const workflow = workflowInfo.workflow;

        let validationInfo = undefined;
        if (includeValidation) {
          const validator = new GraphValidator();
          const validationResult = await validator.validateWorkflow(workflow);
          validationInfo = {
            valid: validationResult.valid,
            errors: validationResult.errors,
            warnings: validationResult.warnings,
            errorCount: validationResult.errors.length,
            warningCount: validationResult.warnings.length,
          };
        }

        const nodeTypes = workflow.nodes.reduce(
          (acc: Record<string, number>, node: { type: string }) => {
            acc[node.type] = (acc[node.type] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );

        const nodeConnections = workflow.nodes.reduce(
          (acc: number, node: { connections?: Record<string, string> }) => {
            if ("connections" in node && node.connections) {
              const connections = typeof node.connections === "object" ? node.connections : {};
              acc += Object.keys(connections).length;
            }
            return acc;
          },
          0,
        );

        const totalNodes = workflow.nodes.length;
        const hasPagination = offset !== undefined && limit !== undefined;
        const paginatedNodes = hasPagination
          ? workflow.nodes.slice(offset, offset! + limit!)
          : workflow.nodes;
        const hasMore = hasPagination ? offset! + limit! < totalNodes : false;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: any = {
          success: true,
          workflowId: workflow.id,
          visibility: workflowInfo.visibility,
          metadata: {
            name: workflow.metadata.name,
            version: workflow.metadata.version,
            description: workflow.metadata.description,
          },
          systemReminder: workflow.systemReminder || null,
          structure: {
            nodeCount: workflow.nodes.length,
            connectionCount: nodeConnections,
            nodeTypes,
            hasStartNode: workflow.nodes.some((n: { type: string }) => n.type === "start"),
            hasEndNode: workflow.nodes.some((n: { type: string }) => n.type === "end"),
            agentDirectiveCount: nodeTypes["agent-directive"] || 0,
            conditionCount: nodeTypes["condition"] || 0,
            telegramCount: nodeTypes["telegram-notification"] || 0,
          },
        };

        response.totalNodes = totalNodes;
        if (hasPagination) {
          response.hasMore = hasMore;
          response.offset = offset;
          response.limit = limit;
          response.returnedNodes = paginatedNodes.length;
        }

        if (includeNodes) {
          response.nodes = paginatedNodes;
        }

        if (includeValidation && validationInfo) {
          response.validation = validationInfo;
        }

        response.storagePath = workflowInfo.storagePath;

        return { success: true, data: response };
      }

      case "get-structure": {
        // Get workflow structure without full node content (for large workflows)
        // Enhanced: supports graph (ASCII visualization) and detailed (directive preview)
        const { workflowId, graph: showGraph, detailed } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("get-structure") };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);

        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const structure = getWorkflowStructure(workflowInfo.workflow);

        // Build response with optional enhancements
        const response: Record<string, unknown> = {
          success: true,
          workflowId: structure.id,
          visibility: workflowInfo.visibility,
          metadata: structure.metadata,
          stats: structure.stats,
          graph: structure.graph,
          systemReminder: workflowInfo.workflow.systemReminder || null,
        };

        // Add ASCII flow graph visualization if requested
        if (showGraph) {
          const flowGraph = buildFlowGraph(workflowInfo.workflow);
          response.flowVisualization = flowGraph;
        }

        // Add directive preview for each node if detailed requested
        if (detailed) {
          const nodesWithPreview = listNodesCompact(workflowInfo.workflow, {
            includePreview: true,
            previewLength: 100,
          });
          response.nodesPreview = nodesWithPreview;
        }

        return {
          success: true,
          data: response,
        };
      }

      case "get-node": {
        // Get a specific node by ID
        const { workflowId, nodeId } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("get-node") };
        }

        if (!nodeId) {
          return { success: false, error: "Node ID is required for get-node action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);

        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const node = getNodeFromWorkflow(workflowInfo.workflow, nodeId);

        if (!node) {
          return { success: false, error: ERRORS.node_not_found(nodeId) };
        }

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            node,
          },
        };
      }

      case "search-nodes": {
        // Search nodes by text in directive/completionCondition
        // Enhanced: supports includeVariables and snippetMode via shared searchWorkflow()
        const { workflowId, query, includeVariables, snippetMode } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("search-nodes") };
        }

        if (!query) {
          return { success: false, error: "Search query is required for search-nodes action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);

        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        // Use enhanced shared function if includeVariables or snippetMode requested
        if (includeVariables || snippetMode) {
          const results = searchWorkflow(workflowInfo.workflow, query, {
            includeVariables,
            snippetMode,
          });

          return {
            success: true,
            data: {
              success: true,
              workflowId,
              query,
              options: { includeVariables, snippetMode },
              resultCount: results.length,
              results,
            },
          };
        }

        // Default behavior: use existing searchNodes function
        const results = searchNodesInWorkflow(workflowInfo.workflow, query);

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            query,
            resultCount: results.length,
            results: results.map((r) => ({
              nodeId: r.node.id,
              type: r.node.type,
              matchedIn: r.matchedIn,
              snippet: r.snippet,
              node: r.node,
            })),
          },
        };
      }

      case "validate": {
        // Validate workflow using unified validator (single source of truth)
        const { workflow } = params;

        if (!workflow) {
          return { success: false, error: ERRORS.workflow_object_required };
        }

        const validator = new GraphValidator();
        const result = await validator.validateUnified(workflow as WorkflowGraph);

        const errors = result.issues
          .filter((i) => i.severity === "error")
          .map((i) => ({ type: i.type, message: i.message, nodeId: i.nodeId, field: i.field }));

        const warnings = result.issues
          .filter((i) => i.severity === "warning")
          .map((i) => ({ type: i.type, message: i.message, nodeId: i.nodeId, field: i.field }));

        return {
          success: true,
          data: {
            success: true,
            workflowId: workflow.id,
            valid: result.valid,
            errorCount: errors.length,
            warningCount: warnings.length,
            errors,
            warnings,
          },
        };
      }

      case "list-variables": {
        const { workflowId } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("list-variables"),
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const variables = getWorkflowVariables(workflowInfo.workflow);
        const variableNames = Object.keys(variables);

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            variableCount: variableNames.length,
            variables: variableNames.map((name) => {
              const varInfo = variables[name];
              const value = varInfo.value;
              return {
                name,
                description: varInfo.description,
                type: typeof value,
                preview:
                  typeof value === "string" && value.length > 100
                    ? value.substring(0, 100) + "..."
                    : value,
              };
            }),
          },
        };
      }

      case "get-variable": {
        const { workflowId, variableName } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("get-variable") };
        }

        if (!variableName) {
          return { success: false, error: "Variable name is required for get-variable action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const variableInfo = getWorkflowVariable(workflowInfo.workflow, variableName);

        if (variableInfo === undefined) {
          return { success: false, error: `Variable '${variableName}' not found in workflow` };
        }

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            variableName,
            value: variableInfo.value,
            description: variableInfo.description,
          },
        };
      }

      case "set-variable": {
        const { workflowId, variableName, variableValue } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("set-variable") };
        }

        if (!variableName) {
          return { success: false, error: "Variable name is required for set-variable action" };
        }

        if (variableValue === undefined) {
          return { success: false, error: "Variable value is required for set-variable action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const oldValue = getWorkflowVariable(workflowInfo.workflow, variableName);
        const modifiedWorkflow = setWorkflowVariable(
          workflowInfo.workflow,
          variableName,
          variableValue,
        );

        // Save the modified workflow
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: modifiedWorkflow,
          userId,
          isUpdate: true,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            variableName,
            oldValue: oldValue ?? null,
            newValue: variableValue,
            message:
              oldValue !== undefined
                ? `Variable '${variableName}' updated`
                : `Variable '${variableName}' created`,
          },
        };
      }

      case "delete-variable": {
        const { workflowId, variableName } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("delete-variable"),
          };
        }

        if (!variableName) {
          return { success: false, error: "Variable name is required for delete-variable action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const oldValue = getWorkflowVariable(workflowInfo.workflow, variableName);
        if (oldValue === undefined) {
          return { success: false, error: `Variable '${variableName}' not found in workflow` };
        }

        const modifiedWorkflow = deleteWorkflowVariable(workflowInfo.workflow, variableName);

        // Save the modified workflow
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: modifiedWorkflow,
          userId,
          isUpdate: true,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            variableName,
            deletedValue: oldValue,
            message: `Variable '${variableName}' deleted`,
          },
        };
      }

      case "diff": {
        const { workflowId, compareWorkflowId } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("diff") };
        }

        if (!compareWorkflowId) {
          return { success: false, error: "compareWorkflowId is required for diff action" };
        }

        // Resolve both workflow identifiers (UUID, slug, or handle/slug)
        const resolved1 = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflow1Info = await repository.getWorkflow(resolved1.workflowId, userId);
        if (!workflow1Info) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const resolved2 = await resolveWorkflowIdentifier(repository, compareWorkflowId, userId);
        const workflow2Info = await repository.getWorkflow(resolved2.workflowId, userId);
        if (!workflow2Info) {
          return { success: false, error: ERRORS.workflow_not_found(compareWorkflowId) };
        }

        const workflow1 = workflow1Info.workflow;
        const workflow2 = workflow2Info.workflow;

        // Compare metadata
        const metadataDiff: Record<string, { old: unknown; new: unknown }> = {};
        for (const key of ["name", "version", "description"] as const) {
          if (workflow1.metadata[key] !== workflow2.metadata[key]) {
            metadataDiff[key] = { old: workflow1.metadata[key], new: workflow2.metadata[key] };
          }
        }

        // Compare nodes
        const nodes1Map = new Map(workflow1.nodes.map((n) => [n.id, n]));
        const nodes2Map = new Map(workflow2.nodes.map((n) => [n.id, n]));

        const addedNodes: string[] = [];
        const removedNodes: string[] = [];
        const modifiedNodes: Array<{ id: string; changes: string[] }> = [];

        // Find added nodes (in workflow2 but not in workflow1)
        for (const [id] of nodes2Map) {
          if (!nodes1Map.has(id)) {
            addedNodes.push(id);
          }
        }

        // Find removed nodes (in workflow1 but not in workflow2)
        for (const [id] of nodes1Map) {
          if (!nodes2Map.has(id)) {
            removedNodes.push(id);
          }
        }

        // Find modified nodes
        for (const [id, node1] of nodes1Map) {
          const node2 = nodes2Map.get(id);
          if (node2) {
            const changes: string[] = [];
            const node1Str = JSON.stringify(node1);
            const node2Str = JSON.stringify(node2);

            if (node1Str !== node2Str) {
              // Compare specific fields
              if (node1.type !== node2.type) changes.push("type");
              if (JSON.stringify(node1.connections) !== JSON.stringify(node2.connections))
                changes.push("connections");
              if (
                "directive" in node1 &&
                "directive" in node2 &&
                node1.directive !== node2.directive
              )
                changes.push("directive");
              if (
                "completionCondition" in node1 &&
                "completionCondition" in node2 &&
                node1.completionCondition !== node2.completionCondition
              )
                changes.push("completionCondition");
              if (
                "inputSchema" in node1 &&
                "inputSchema" in node2 &&
                JSON.stringify(node1.inputSchema) !== JSON.stringify(node2.inputSchema)
              )
                changes.push("inputSchema");
              if (
                "condition" in node1 &&
                "condition" in node2 &&
                JSON.stringify(node1.condition) !== JSON.stringify(node2.condition)
              )
                changes.push("condition");
              if ("message" in node1 && "message" in node2 && node1.message !== node2.message)
                changes.push("message");
              if (
                "initialData" in node1 &&
                "initialData" in node2 &&
                JSON.stringify(node1.initialData) !== JSON.stringify(node2.initialData)
              )
                changes.push("initialData");

              if (changes.length > 0) {
                modifiedNodes.push({ id, changes });
              }
            }
          }
        }

        // Compare systemReminder
        const systemReminderChanged = workflow1.systemReminder !== workflow2.systemReminder;

        const hasDifferences =
          Object.keys(metadataDiff).length > 0 ||
          addedNodes.length > 0 ||
          removedNodes.length > 0 ||
          modifiedNodes.length > 0 ||
          systemReminderChanged;

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            compareWorkflowId,
            identical: !hasDifferences,
            summary: {
              metadataChanges: Object.keys(metadataDiff).length,
              nodesAdded: addedNodes.length,
              nodesRemoved: removedNodes.length,
              nodesModified: modifiedNodes.length,
              systemReminderChanged,
            },
            details: hasDifferences
              ? {
                  metadata: Object.keys(metadataDiff).length > 0 ? metadataDiff : undefined,
                  addedNodes: addedNodes.length > 0 ? addedNodes : undefined,
                  removedNodes: removedNodes.length > 0 ? removedNodes : undefined,
                  modifiedNodes: modifiedNodes.length > 0 ? modifiedNodes : undefined,
                  systemReminder: systemReminderChanged
                    ? {
                        old: workflow1.systemReminder,
                        new: workflow2.systemReminder,
                      }
                    : undefined,
                }
              : undefined,
          },
        };
      }

      case "copy": {
        // Copy workflow as a template (creates private copy)
        const { workflowId, newName } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("copy") };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const sourceWorkflow = workflowInfo.workflow;

        // Create deep copy with new ID
        const newWorkflowId = `workflow-${randomUUID().slice(0, 8)}`;
        const copiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(sourceWorkflow));
        copiedWorkflow.id = newWorkflowId;
        copiedWorkflow.metadata = {
          ...copiedWorkflow.metadata,
          name: newName || `${sourceWorkflow.metadata.name} (copy)`,
        };

        // Save as private workflow owned by current user
        const workflowService = getWorkflowService();
        const copyResult = await workflowService.save({
          graph: copiedWorkflow,
          userId,
          visibility: "private",
          isUpdate: false,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId: copyResult.id,
            slug: copyResult.slug,
            sourceWorkflowId: workflowId,
            message: SUCCESS.workflow_created(copyResult.id),
            metadata: {
              name: copiedWorkflow.metadata.name,
              version: copiedWorkflow.metadata.version,
              description: copiedWorkflow.metadata.description,
              nodeCount: copiedWorkflow.nodes.length,
            },
            visibility: "private",
          },
        };
      }

      case "clone-node": {
        // Clone a node within a workflow with new ID
        const { workflowId, nodeId, newId } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("clone-node") };
        }

        if (!nodeId) {
          return { success: false, error: "Node ID is required for clone-node action" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const workflow = workflowInfo.workflow;
        const sourceNode = workflow.nodes.find((n) => n.id === nodeId);

        if (!sourceNode) {
          return { success: false, error: ERRORS.node_not_found(nodeId) };
        }

        // Create new ID for cloned node
        const clonedNodeId = newId || `${nodeId}-clone-${randomUUID().slice(0, 4)}`;

        // Check if new ID already exists
        if (workflow.nodes.some((n) => n.id === clonedNodeId)) {
          return { success: false, error: ERRORS.node_id_exists(clonedNodeId) };
        }

        // Deep clone the node with new ID
        const clonedNode = JSON.parse(JSON.stringify(sourceNode));
        clonedNode.id = clonedNodeId;

        // Insert cloned node after source node
        const sourceIndex = workflow.nodes.findIndex((n) => n.id === nodeId);
        const modifiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(workflow));
        modifiedWorkflow.nodes.splice(sourceIndex + 1, 0, clonedNode);

        // Validate modified workflow
        const validator = new GraphValidator();
        const validationResult = await validator.validateWorkflow(modifiedWorkflow);

        if (!validationResult.valid) {
          const errors = validationResult.errors.map((e) => e.message).join("; ");
          return {
            success: false,
            error: ERRORS.modified_workflow_validation_failed(errors),
          };
        }

        // Save workflow
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: modifiedWorkflow,
          userId,
          isUpdate: true,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            sourceNodeId: nodeId,
            clonedNodeId,
            message: `Node '${nodeId}' cloned as '${clonedNodeId}'`,
            clonedNode,
          },
        };
      }

      case "move-node": {
        // Reorder nodes in workflow
        // Enhanced: supports afterNodeId as alternative to targetIndex
        const { workflowId, nodeId, targetIndex, afterNodeId } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("move-node") };
        }

        if (!nodeId) {
          return { success: false, error: "Node ID is required for move-node action" };
        }

        // Either targetIndex or afterNodeId is required
        if (targetIndex === undefined && !afterNodeId) {
          return {
            success: false,
            error: "Either targetIndex or afterNodeId is required for move-node action",
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const workflow = workflowInfo.workflow;
        const currentIndex = workflow.nodes.findIndex((n) => n.id === nodeId);

        if (currentIndex === -1) {
          return { success: false, error: ERRORS.node_not_found(nodeId) };
        }

        // Resolve target index from afterNodeId if provided
        let resolvedTargetIndex: number;
        if (afterNodeId) {
          const afterIndex = workflow.nodes.findIndex((n) => n.id === afterNodeId);
          if (afterIndex === -1) {
            return { success: false, error: `Target node '${afterNodeId}' not found` };
          }
          // Place after the specified node
          resolvedTargetIndex = afterIndex + 1;
        } else {
          resolvedTargetIndex = targetIndex!;
        }

        if (resolvedTargetIndex < 0) {
          return { success: false, error: "Target index must be >= 0" };
        }

        // Clamp targetIndex to valid range
        const clampedTarget = Math.min(resolvedTargetIndex, workflow.nodes.length - 1);

        if (currentIndex === clampedTarget) {
          return {
            success: true,
            data: {
              success: true,
              workflowId,
              nodeId,
              message: "Node already at target position",
              fromIndex: currentIndex,
              toIndex: clampedTarget,
            },
          };
        }

        // Remove node from current position and insert at target
        const modifiedWorkflow: WorkflowGraph = JSON.parse(JSON.stringify(workflow));
        const [movedNode] = modifiedWorkflow.nodes.splice(currentIndex, 1);
        modifiedWorkflow.nodes.splice(clampedTarget, 0, movedNode);

        // Validate modified workflow
        const validator = new GraphValidator();
        const validationResult = await validator.validateWorkflow(modifiedWorkflow);

        if (!validationResult.valid) {
          const errors = validationResult.errors.map((e) => e.message).join("; ");
          return {
            success: false,
            error: ERRORS.modified_workflow_validation_failed(errors),
          };
        }

        // Save workflow
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: modifiedWorkflow,
          userId,
          isUpdate: true,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            nodeId,
            message: `Node '${nodeId}' moved from index ${currentIndex} to ${clampedTarget}`,
            fromIndex: currentIndex,
            toIndex: clampedTarget,
          },
        };
      }

      case "list-nodes": {
        // Compact node listing using shared function
        const { workflowId, typeFilter, includePreview, previewLength } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("list-nodes") };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const nodes = listNodesCompact(workflowInfo.workflow, {
          typeFilter,
          includePreview: includePreview ?? true,
          previewLength: previewLength ?? 100,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            options: { typeFilter, includePreview, previewLength },
            nodeCount: nodes.length,
            nodes,
          },
        };
      }

      case "get-nodes": {
        // Batch retrieve nodes by ID array
        const { workflowId, nodeIds } = params;

        if (!workflowId) {
          return { success: false, error: ERRORS.workflow_id_required_for_action("get-nodes") };
        }

        if (!nodeIds || nodeIds.length === 0) {
          return { success: false, error: "nodeIds array is required and must not be empty" };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const workflow = workflowInfo.workflow;
        const foundNodes: Array<{ id: string; node: unknown }> = [];
        const notFound: string[] = [];

        for (const id of nodeIds) {
          const node = workflow.nodes.find((n) => n.id === id);
          if (node) {
            foundNodes.push({ id, node });
          } else {
            notFound.push(id);
          }
        }

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            requestedCount: nodeIds.length,
            foundCount: foundNodes.length,
            nodes: foundNodes,
            notFound: notFound.length > 0 ? notFound : undefined,
          },
        };
      }

      case "analyze-variables": {
        // Variable usage analysis using shared function
        const { workflowId } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("analyze-variables"),
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        const analysis = analyzeVariableUsage(workflowInfo.workflow);
        const variableCount = Object.keys(analysis).length;

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            variableCount,
            analysis,
          },
        };
      }

      case "set-visibility": {
        // Change workflow visibility (public/private)
        const { workflowId, visibility } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("set-visibility"),
          };
        }

        if (!visibility) {
          return {
            success: false,
            error: "visibility parameter is required (must be 'public' or 'private')",
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);
        const workflowInfo = await repository.getWorkflow(resolved.workflowId, userId);
        if (!workflowInfo) {
          return { success: false, error: ERRORS.workflow_not_found(workflowId) };
        }

        // Update visibility via service
        const workflowService = getWorkflowService();
        await workflowService.save({
          graph: workflowInfo.workflow,
          userId,
          visibility,
          isUpdate: true,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId,
            previousVisibility: workflowInfo.visibility,
            newVisibility: visibility,
            message: `Workflow visibility changed from '${workflowInfo.visibility}' to '${visibility}'`,
          },
        };
      }

      // ===== Sharing Actions (Issue #433) =====

      case "create-invite": {
        // Create an invite link for sharing workflow
        const { workflowId, ttlMs } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("create-invite"),
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);

        const sharingService = getWorkflowSharingService();
        const result = await sharingService.createInvite({
          workflowId: resolved.workflowId,
          userId,
          ttlMs,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId: resolved.workflowId,
            invite: {
              id: result.invite.id,
              token: result.invite.token,
              expiresAt: result.invite.expiresAt,
              remainingMs: result.invite.remainingMs,
            },
            inviteUrl: result.inviteUrl,
            message: `Invite link created. Share this URL: ${result.inviteUrl}`,
          },
        };
      }

      case "list-access": {
        // List users with shared access to workflow
        const { workflowId, limit, offset } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("list-access"),
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);

        const sharingService = getWorkflowSharingService();
        const result = await sharingService.listAccess({
          workflowId: resolved.workflowId,
          userId,
          limit,
          offset,
        });

        const hasMore =
          offset !== undefined && limit !== undefined
            ? offset + limit < result.total
            : result.accesses.length < result.total;

        return {
          success: true,
          data: {
            success: true,
            workflowId: resolved.workflowId,
            totalCount: result.total,
            returnedCount: result.accesses.length,
            hasMore,
            users: result.accesses.map((access) => ({
              userId: access.userId,
              handle: access.userHandle,
              name: access.userName,
              grantedAt: access.grantedAt,
              grantedBy: access.grantedBy,
              grantedByHandle: access.grantedByHandle,
            })),
          },
        };
      }

      case "list-invites": {
        // List invite links for workflow
        const { workflowId, activeOnly, limit, offset } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("list-invites"),
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);

        const sharingService = getWorkflowSharingService();
        const result = await sharingService.listInvites({
          workflowId: resolved.workflowId,
          userId,
          activeOnly: activeOnly ?? true,
          limit,
          offset,
        });

        const invitesHasMore =
          offset !== undefined && limit !== undefined
            ? offset + limit < result.total
            : result.invites.length < result.total;

        return {
          success: true,
          data: {
            success: true,
            workflowId: resolved.workflowId,
            activeOnly: activeOnly ?? true,
            totalCount: result.total,
            returnedCount: result.invites.length,
            hasMore: invitesHasMore,
            invites: result.invites.map((invite) => ({
              id: invite.id,
              token: invite.token,
              createdAt: invite.createdAt,
              expiresAt: invite.expiresAt,
              remainingMs: invite.remainingMs,
              usedAt: invite.usedAt,
              usedBy: invite.usedBy,
              usedByHandle: invite.usedByHandle,
            })),
          },
        };
      }

      case "revoke-access": {
        // Revoke a user's shared access to workflow
        const { workflowId, targetUserId } = params;

        if (!workflowId) {
          return {
            success: false,
            error: ERRORS.workflow_id_required_for_action("revoke-access"),
          };
        }

        if (!targetUserId) {
          return {
            success: false,
            error: "targetUserId is required for revoke-access action",
          };
        }

        // Resolve workflow identifier (UUID, slug, or handle/slug)
        const resolved = await resolveWorkflowIdentifier(repository, workflowId, userId);

        const sharingService = getWorkflowSharingService();
        await sharingService.revokeAccess({
          workflowId: resolved.workflowId,
          targetUserId,
          userId,
        });

        return {
          success: true,
          data: {
            success: true,
            workflowId: resolved.workflowId,
            targetUserId,
            message: `Access revoked for user '${targetUserId}'`,
          },
        };
      }

      case "revoke-invite": {
        // Revoke an invite link
        const { inviteId } = params;

        if (!inviteId) {
          return {
            success: false,
            error: "inviteId is required for revoke-invite action",
          };
        }

        const sharingService = getWorkflowSharingService();
        await sharingService.revokeInvite({
          inviteId,
          userId,
        });

        return {
          success: true,
          data: {
            success: true,
            inviteId,
            message: `Invite '${inviteId}' revoked`,
          },
        };
      }

      default:
        return {
          success: false,
          error: ERRORS.unknown_action(action),
        };
    }
  } catch (error) {
    // Normalize to AppError for consistent handling
    const appError = normalizeError(error);

    // LOG ONCE at boundary - use appropriate level based on error type
    // Operational errors (user errors) = WARN, Programmer errors = ERROR
    const logLevel = isOperationalError(appError) ? "warn" : "error";
    logger[logLevel]("Failed to manage workflow", appError, {
      action: params.action,
      workflowId: params.workflowId,
      code: appError.code,
      isOperational: appError.isOperational,
    });

    // Use domain error formatting which handles slug/handle errors with proper codes
    return {
      success: false,
      error: formatDomainError(error),
    };
  }
}

export const manageWorkflowSchema = ManageWorkflowParamsSchema;
