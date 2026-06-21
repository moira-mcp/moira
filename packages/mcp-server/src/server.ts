#!/usr/bin/env node

/**
 * MCP Server for Moira Workflow Engine
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { z } from "zod";
import {
  requestLogger,
  geoipLogger,
  requestContextMiddleware,
  createLogger,
  Service,
  Component,
  setGlobalService,
  getDatabase,
  closeDatabase,
  user,
  oauthAccessToken,
  apiToken,
  getBaseUrl,
  getContactEmail,
  getLogLevelEnv,
  getMcpPort,
  metricsMiddleware,
  setLogLevel,
  getMcpServerVersion,
  updateContext,
  sanitizeInput,
  getMcpTextService,
  isPersistentToken,
  hashToken,
  validateTokenRecord,
  type McpPromptContext,
} from "@mcp-moira/shared";

// Get monorepo version from root package.json (#196)
export const MCP_SERVER_VERSION: string = getMcpServerVersion() || "0.0.0";

// Set global service for this process (MUST be first thing after imports)
setGlobalService(Service.MCP_SERVER);
import { eq } from "drizzle-orm";
import { runWithMCPContext } from "./core/request-context.js";
import { auth } from "./auth.js";
import { mcpLimiter } from "./middleware/rate-limit-middleware.js";

// Direct tool imports (no spawn)
import { listWorkflows, listWorkflowsSchema } from "./tools/list-workflows.js";
import { startWorkflow } from "./tools/start-workflow.js";
import { executeStep } from "./tools/execute-step.js";
import { manageWorkflow, manageWorkflowSchema } from "./tools/manage-workflow.js";
import { getHelp } from "./tools/get-help.js";
import { manageSettings } from "./tools/manage-settings.js";
import { createWorkflowToken } from "./tools/create-workflow-token.js";
import { getSessionInfo } from "./tools/get-session-info.js";
import { manageNotes, manageNotesSchema } from "./tools/manage-notes.js";
import { manageArtifacts, manageArtifactsSchema } from "./tools/manage-artifacts.js";
import { manageLocks, manageLocksSchema } from "./tools/manage-locks.js";
import { wrapSchemaWithAutoparse } from "./utils/flexible-json-parser.js";

// Centralized messages
import {
  LABELS,
  formatUploadToken,
  formatDownloadToken,
  loadToolDescriptions,
} from "./messages/index.js";

import type { McpToolName } from "@mcp-moira/shared";

// Error sanitization (#276)
import { sanitizeMcpError } from "./utils/error-sanitizer.js";

// Initialize logger
const logger = createLogger({ component: "MCPServer" });

// Set log level from environment variable
const logLevel = getLogLevelEnv();
if (logLevel) {
  setLogLevel(logLevel);
}

// ARCHITECTURAL DECISION (Step 6 research, issues #201, #230):
// MCP SDK supports `instructions` field in ServerOptions.
// Previously Claude Code ignored it, so we used workaround with help tool description.
// Now testing if Claude Code supports it properly (for ToolSearch compatibility).
// System prompt is passed via `instructions` field in McpServer serverInfo.
//
// DYNAMIC DESCRIPTIONS (Issue #378):
// Tool descriptions are loaded from DB on each request to support dynamic updates.
// Admin can edit descriptions via AdminSettings UI without server restart.
//
// AGENT/MODEL PROMPT OVERRIDES (Issue #398):
// Tool descriptions support 3-level override hierarchy: model -> agent -> default.
// Agent is extracted from OAuth application name, model from X-Model-Name header.

// Import prompt context extraction utilities
import { extractPromptContext } from "./utils/prompt-context.js";

/**
 * Create a new MCP server instance with tools registered using provided descriptions
 * Called for each request to get fresh descriptions from DB
 *
 * @param context - Optional agent/model context for hierarchical override resolution
 */
async function createMcpServerWithTools(context?: McpPromptContext): Promise<McpServer> {
  // Load fresh tool descriptions from DB with override resolution
  const toolDescriptions = await loadToolDescriptions(context);

  // Load system prompt for MCP instructions field
  const mcpTextService = getMcpTextService();
  const systemPrompt = context
    ? await mcpTextService.getSystemPromptWithOverride(context)
    : await mcpTextService.getSystemPrompt();

  const mcpServer = new McpServer(
    {
      name: "mcp-moira",
      version: MCP_SERVER_VERSION,
      title: "MCP Moira Workflow Engine",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: systemPrompt || undefined,
    },
  );

  // Register all tools with current descriptions
  await registerAllTools(mcpServer, toolDescriptions);

  return mcpServer;
}

// Function to register all MCP tools with provided descriptions
function registerAllTools(
  mcpServer: McpServer,
  toolDescriptions: Record<McpToolName, string>,
): void {
  // List workflows tool (direct import - no spawn)
  mcpServer.registerTool(
    "list",
    {
      description: toolDescriptions.list,
      inputSchema: wrapSchemaWithAutoparse(listWorkflowsSchema.shape),
    },
    async (params) => {
      try {
        const result = await listWorkflows({
          search: params.search,
          visibility: params.visibility,
          sort: params.sort,
          sortOrder: params.sortOrder,
          limit: params.limit,
          offset: params.offset,
        });
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Start workflow tool (direct function call)
  mcpServer.registerTool(
    "start",
    {
      description: toolDescriptions.start,
      inputSchema: wrapSchemaWithAutoparse({
        workflowId: z
          .string()
          .describe("Workflow ID to start (use list() to see available workflows)"),
        note: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Short note to identify this execution (max 500 chars). Use task name, project, or conversation context.",
          ),
        parentExecutionId: z
          .string()
          .describe(
            'Required. Use "none" for standalone workflows, or provide parent execution UUID to link child workflows. Child completion will remind to continue parent.',
          ),
        skipTelegramCheck: z
          .boolean()
          .optional()
          .describe(
            "Skip Telegram configuration pre-flight check. Use when you want to start a workflow without Telegram notifications.",
          ),
      }),
    },
    async ({ workflowId, note, parentExecutionId, skipTelegramCheck }) => {
      try {
        const result = await startWorkflow({
          workflowId,
          note,
          parentExecutionId,
          skipTelegramCheck,
        });
        const resultText = result.success ? result.data : `Error: ${result.error}`;
        return { content: [{ type: "text" as const, text: resultText || LABELS.no_result }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Execute step tool (enhanced with simplified schema)
  mcpServer.registerTool(
    "step",
    {
      description: toolDescriptions.step,
      inputSchema: wrapSchemaWithAutoparse({
        processId: z.string().describe("Process ID from start() or previous step() response"),
        input: z
          .union([
            z.string(),
            z.record(z.any()),
            z.array(z.unknown()),
            z.number(),
            z.boolean(),
            z.null(),
          ])
          .optional()
          .describe(
            "Input data matching the step's inputSchema. Structure depends on current step requirements.",
          ),
        teleportTo: z
          .string()
          .optional()
          .describe(
            "Optional teleport node ID to jump execution to. Only teleport-type nodes can be targets. When provided, execution jumps to the teleport node instead of following normal flow. Do NOT provide input when teleporting.",
          ),
      }),
    },
    async ({ processId, input, teleportTo }) => {
      try {
        const result = await executeStep({ processId, input, teleportTo });

        if (result.success) {
          return { content: [{ type: "text" as const, text: result.data || LABELS.no_result }] };
        } else {
          return {
            content: [{ type: "text" as const, text: result.error || LABELS.no_result }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Test tool - simple text response
  // mcpServer.registerTool("test_simple_text", {
  //   description: "Test tool that returns simple text without JSON",
  //   inputSchema: {
  //     message: z.string().optional().describe('Optional test message')
  //   }
  // }, async ({ message }) => {
  //   const testText = message || "Hello from simple text tool!";
  //   logger.info('test_simple_text called', { message, testText });

  //   // Return properly structured response
  //   const result = `Simple text response: ${testText}`;
  //   logger.info('test_simple_text returning', { result });
  //   return { content: [{ type: 'text' as const, text: result }] };
  // });

  // Get process state tool (direct function call)
  // mcpServer.registerTool("get_process_state", {
  //   description: "Get current state of a workflow process",
  //   inputSchema: {
  //     processId: z.string().describe('ID of the process to check')
  //   }
  // }, async ({ processId }) => {
  //   try {
  //     const result = await getProcessState({ processId });
  //     const resultText = result.success ? JSON.stringify(result.data, null, 2) : `Error: ${result.error}`;
  //     return {
  //       content: [
  //         { type: 'text' as const, text: resultText },
  //       ]
  //     };
  //   } catch (error) {
  //     return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
  //   }
  // });

  // Manage workflow tool (direct function call) - consolidated create/edit/get + structure/node/search/validate/variables/diff/copy/clone/move
  mcpServer.registerTool(
    "manage",
    {
      description: toolDescriptions.manage,
      inputSchema: wrapSchemaWithAutoparse({
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
            // Sharing actions (Issue #433)
            "create-invite",
            "list-access",
            "list-invites",
            "revoke-access",
            "revoke-invite",
          ])
          .describe("Action to perform on workflow"),
        workflowId: z
          .string()
          .optional()
          .describe("Target workflow ID (required for most actions except create)"),
        workflow: z
          .object({
            id: z.string().optional().describe("Workflow ID (auto-generated if not provided)"),
            metadata: z.object({
              name: z.string().describe("Human-readable workflow name"),
              version: z.string().describe("Semantic version (e.g., '1.0.0')"),
              description: z.string().describe("Brief workflow description"),
            }),
            nodes: z.array(z.record(z.unknown())).describe("Array of workflow nodes"),
            variableRegistry: z
              .record(z.unknown())
              .optional()
              .describe(
                "Declared global variables (JSON-Schema-shaped: name -> {type, description, default?}). Required for any variable referenced by bare name in directives/conditions/templates.",
              ),
            visibility: z
              .enum(["public", "private"])
              .optional()
              .describe("Workflow visibility (default: private)"),
            systemReminder: z
              .string()
              .optional()
              .describe("System reminder shown to agent on each step"),
          })
          .optional()
          .describe("Full workflow object for create action"),
        overwrite: z
          .boolean()
          .optional()
          .describe("Overwrite existing workflow with same ID (default: false)"),
        changes: z
          .object({
            metadata: z
              .object({
                name: z.string().optional(),
                version: z.string().optional(),
                description: z.string().optional(),
              })
              .optional()
              .describe("Metadata fields to update"),
            variableRegistry: z
              .record(z.unknown())
              .optional()
              .describe("Replace the workflow's declared global variable registry"),
            addNodes: z.array(z.record(z.unknown())).optional().describe("New nodes to add"),
            removeNodes: z.array(z.string()).optional().describe("Node IDs to remove"),
            updateNodes: z
              .array(
                z.object({
                  nodeId: z.string().describe("ID of node to update"),
                  changes: z.any().describe("Fields to update on the node"),
                }),
              )
              .optional()
              .describe("Nodes to update with specific changes"),
            removeConnections: z
              .array(
                z.object({
                  nodeId: z.string().describe("ID of node with connection to remove"),
                  connectionKey: z
                    .string()
                    .describe("Connection key to remove (e.g., 'default', 'true', 'false')"),
                }),
              )
              .optional()
              .describe("Connections to remove from nodes"),
            systemReminder: z.string().optional().describe("New system reminder text"),
          })
          .optional()
          .describe("Changes to apply for edit action"),
        includeNodes: z
          .boolean()
          .optional()
          .describe("Include full node definitions in get response"),
        includeValidation: z
          .boolean()
          .optional()
          .describe("Include validation results in response"),
        offset: z.number().optional().describe("Pagination offset for node listing"),
        limit: z.number().optional().describe("Maximum nodes to return"),
        nodeId: z
          .string()
          .optional()
          .describe("Specific node ID for get-node and clone-node actions"),
        query: z.string().optional().describe("Search query for search-nodes action"),
        variableName: z
          .string()
          .optional()
          .describe("Variable name for get/set/delete-variable actions"),
        variableValue: z.any().optional().describe("Variable value for set-variable action"),
        compareWorkflowId: z.string().optional().describe("Second workflow ID for diff action"),
        newName: z.string().optional().describe("New name for copied workflow (copy action)"),
        newId: z.string().optional().describe("New ID for cloned node (clone-node action)"),
        targetIndex: z.number().optional().describe("Target position for node (move-node action)"),
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
      }),
    },
    async (params) => {
      try {
        const result = await manageWorkflow(params as z.infer<typeof manageWorkflowSchema>);
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Get workflow documentation tool (direct function call)
  mcpServer.registerTool(
    "help",
    {
      description: toolDescriptions.help,
      inputSchema: wrapSchemaWithAutoparse({
        topic: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "Documentation topic(s) to retrieve. Available: concepts, nodes, templates, validation, best-practices",
          ),
      }),
    },
    async ({ topic }) => {
      try {
        const result = await getHelp({ topic });
        const resultText = result.success
          ? (result.data ?? "")
          : `Error: ${result.error || "Unknown error"}`;
        return {
          content: [{ type: "text" as const, text: resultText as string }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // User Settings Management Tool

  mcpServer.registerTool(
    "settings",
    {
      description: toolDescriptions.settings,
      inputSchema: wrapSchemaWithAutoparse({
        action: z
          .enum(["get", "set", "list"])
          .describe("Action: get (single setting), set (update value), list (all settings)"),
        category: z.string().optional().describe("Filter settings by category"),
        key: z
          .string()
          .optional()
          .describe("Setting key for get/set actions (e.g., 'notifications.telegram')"),
        value: z.any().optional().describe("New value for set action"),
      }),
    },
    async ({ action, category, key, value }) => {
      try {
        const result = await manageSettings({ action, category, key, value });
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // === Execution Context Inspection Tools ===

  // mcpServer.registerTool("update_execution_context", {
  //   description: "Update execution context variables (only for waiting executions)",
  //   inputSchema: {
  //     executionId: z.string().describe('Execution ID to update'),
  //     variables: z.record(z.unknown()).optional().describe('Context variables to update'),
  //     nodeStates: z.record(z.unknown()).optional().describe('Node states to update')
  //   }
  // }, async ({ executionId, variables, nodeStates }) => {
  //   try {
  //     const result = await updateExecutionContext({ executionId, variables, nodeStates });
  //     if (!result.success) {
  //       return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }] };
  //     }
  //
  //     return { content: [{ type: 'text' as const, text: `Execution context updated successfully for '${executionId}'.` }] };
  //   } catch (error) {
  //     return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
  //   }
  // });

  // === Large Workflow File Handling Tool ===

  mcpServer.registerTool(
    "token",
    {
      description: toolDescriptions.token,
      inputSchema: wrapSchemaWithAutoparse({
        action: z
          .enum(["upload", "download"])
          .describe("Token type: upload (for creating workflows), download (for retrieving)"),
        workflowId: z.string().optional().describe("Workflow ID (required for download action)"),
        ttlMinutes: z
          .number()
          .optional()
          .default(60)
          .describe("Token expiration time in minutes (default: 60)"),
      }),
    },
    async ({ action, workflowId, ttlMinutes }) => {
      try {
        const result = await createWorkflowToken({ action, workflowId, ttlMinutes });
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
        }

        const data = result.data!;
        const response =
          action === "upload"
            ? formatUploadToken(data as Parameters<typeof formatUploadToken>[0])
            : formatDownloadToken(data as Parameters<typeof formatDownloadToken>[0]);
        return { content: [{ type: "text" as const, text: response }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Consolidated session info tool
  mcpServer.registerTool(
    "session",
    {
      description: toolDescriptions.session,
      inputSchema: wrapSchemaWithAutoparse({
        action: z
          .enum(["user", "executions", "execution_context", "current_step", "update-note"])
          .describe(
            "Action: user (current user), executions (list), execution_context (full context), current_step (resume info), update-note (change note)",
          ),
        executionId: z
          .string()
          .optional()
          .describe("Execution ID for execution_context, current_step, or update-note actions"),
        // Parameters for executions action
        // Issue #386: 2-status model ("running", "completed"). Old values accepted for backward compat.
        status: z
          .array(z.enum(["running", "waiting", "completed", "failed", "locked"]))
          .optional()
          .describe("Filter executions by status (array of statuses)"),
        workflowId: z.string().optional().describe("Filter executions by workflow ID"),
        search: z.string().optional().describe("Search in execution notes"),
        sort: z
          .enum(["createdAt", "updatedAt"])
          .optional()
          .describe("Sort field for executions list"),
        sortOrder: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort order (ascending or descending)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum executions to return (1-100)"),
        offset: z.number().min(0).optional().describe("Pagination offset"),
        // Parameters for update-note action
        note: z
          .string()
          .max(500)
          .optional()
          .describe("New note text for update-note action (max 500 chars)"),
      }),
    },
    async ({
      action,
      executionId,
      status,
      workflowId,
      search,
      sort,
      sortOrder,
      limit,
      offset,
      note,
    }) => {
      try {
        const result = await getSessionInfo({
          action,
          executionId,
          status,
          workflowId,
          search,
          sort,
          sortOrder,
          limit,
          offset,
          note,
        });
        if (!result.success) {
          return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
        }

        const resultText =
          typeof result.data === "string" ? result.data : JSON.stringify(result.data, null, 2);

        return { content: [{ type: "text" as const, text: resultText }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Notes management tool
  mcpServer.registerTool(
    "notes",
    {
      description: toolDescriptions.notes,
      inputSchema: wrapSchemaWithAutoparse({
        action: z
          .enum(["list", "get", "save", "delete", "history", "stats"])
          .describe("Action to perform on notes"),
        tag: z.string().optional().describe("Filter notes by tag (for list action)"),
        keySearch: z.string().optional().describe("Search notes by key pattern (for list action)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum notes to return (1-100, default 50)"),
        offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
        key: z
          .string()
          .optional()
          .describe("Note key (required for get, save, delete, history actions)"),
        version: z
          .number()
          .optional()
          .describe("Specific version number to retrieve (for get action)"),
        value: z.string().optional().describe("Note content (required for save action)"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for the note (for save action, max 10 tags)"),
      }),
    },
    async (params) => {
      try {
        const result = await manageNotes(params as z.infer<typeof manageNotesSchema>);
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Artifacts management tool
  mcpServer.registerTool(
    "artifacts",
    {
      description: toolDescriptions.artifacts,
      inputSchema: wrapSchemaWithAutoparse({
        action: z
          .enum(["upload", "update", "delete", "list", "stats", "token"])
          .describe("Action to perform on artifacts"),
        name: z.string().optional().describe("Artifact name (required for upload action)"),
        content: z
          .string()
          .optional()
          .describe("HTML content (required for upload and update actions)"),
        executionId: z
          .string()
          .optional()
          .describe("Link artifact to workflow execution (optional for upload)"),
        uuid: z
          .string()
          .optional()
          .describe("Artifact UUID (required for update and delete actions)"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum artifacts to return (1-100, default 50)"),
        offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
        ttlMinutes: z
          .number()
          .min(1)
          .max(1440)
          .optional()
          .describe("Token expiration in minutes (1-1440, default 60)"),
      }),
    },
    async (params) => {
      try {
        const result = await manageArtifacts(params as z.infer<typeof manageArtifactsSchema>);
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );

  // Lock management tool
  mcpServer.registerTool(
    "lock",
    {
      description: toolDescriptions.lock,
      inputSchema: wrapSchemaWithAutoparse({
        action: z.enum(["status", "list", "unlock", "lock"]).describe("Action to perform on locks"),
        executionId: z.string().describe("Execution ID (required for all actions)"),
        pin: z.string().optional().describe("PIN code to unlock (required for unlock action)"),
        reason: z
          .string()
          .optional()
          .describe("Reason for locking the execution (required for lock action)"),
      }),
    },
    async (params) => {
      try {
        const result = await manageLocks(params as z.infer<typeof manageLocksSchema>);
        const resultText = result.success
          ? JSON.stringify(result.data, null, 2)
          : `Error: ${result.error}`;
        return {
          content: [{ type: "text" as const, text: resultText }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${sanitizeMcpError(error)}`,
            },
          ],
        };
      }
    },
  );
} // End of registerAllTools function

// Tools will be registered per session in HTTP mode

// Stateless mode - no session storage needed

// Express app setup
const app = express();

// Prometheus metrics middleware FIRST
app.use(metricsMiddleware());

// Request context middleware - creates AsyncLocalStorage context for each request
// Must be early to capture requestId for all logs and enable inputData in error logs
app.use(requestContextMiddleware());

// Centralized HTTP logging via morgan with standardized component
const httpLogger = createLogger({ component: Component.HTTP });
app.use(requestLogger({ logger: httpLogger }));

// GeoIP logging for request origins
app.use(geoipLogger({ logger: httpLogger }));

app.use(express.json({ limit: "10mb" }));
app.use(
  cors({
    origin: true, // Allow all origins for development
    credentials: true,
    exposedHeaders: ["Mcp-Session-Id"],
  }),
);

// From the spec (Transports 2.2.3):
// The server MUST [...] return HTTP 405 Method Not Allowed,
// indicating that the server does not offer an SSE stream at this endpoint.
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).send();
});

// MCP HTTP endpoints - Authenticated mode with rate limiting
app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
  try {
    // Log MCP request with tool context (for debugging)
    const mcpMethod = req.body?.method;
    const mcpParams = req.body?.params;

    // Extract tool info for logging (context update happens inside runWithMCPContext)
    const toolName = mcpMethod === "tools/call" && mcpParams?.name ? mcpParams.name : undefined;
    const toolArgs = toolName ? mcpParams.arguments || {} : undefined;

    logger.info("MCP request received", {
      method: mcpMethod,
      ...(toolName && { tool: toolName }),
      hasAuthHeader: !!req.headers.authorization,
    });

    // Extract Bearer token for auth routing
    const bearerToken = req.headers.authorization?.replace("Bearer ", "");

    // --- Persistent API token authentication (moira_ prefix) ---
    // Persistent tokens skip OAuth and version check entirely
    if (bearerToken && isPersistentToken(bearerToken)) {
      const db = getDatabase();
      const tokenHash = hashToken(bearerToken);

      // Look up token by hash
      const [tokenRecord] = await db
        .select({
          id: apiToken.id,
          userId: apiToken.userId,
          expiresAt: apiToken.expiresAt,
          revokedAt: apiToken.revokedAt,
        })
        .from(apiToken)
        .where(eq(apiToken.tokenHash, tokenHash))
        .limit(1);

      if (!tokenRecord) {
        logger.info("Persistent token not found", { method: mcpMethod });
        return res.status(401).json({
          error: "invalid_token",
          error_description: "Invalid API token.",
        });
      }

      // Validate token not expired/revoked
      const validationError = validateTokenRecord(tokenRecord);
      if (validationError) {
        logger.info("Persistent token rejected", {
          reason: validationError,
          tokenId: tokenRecord.id,
        });
        return res.status(401).json({
          error: "invalid_token",
          error_description:
            validationError === "token_revoked"
              ? "API token has been revoked."
              : "API token has expired.",
        });
      }

      // Check if user is blocked
      const [userData] = await db
        .select({ blocked: user.blocked, blockedReason: user.blockedReason, email: user.email })
        .from(user)
        .where(eq(user.id, tokenRecord.userId))
        .limit(1);

      if (!userData) {
        return res.status(401).json({
          error: "invalid_token",
          error_description: "Token owner not found.",
        });
      }

      if (userData.blocked) {
        logger.warn("Blocked user attempted MCP access via persistent token", {
          userId: tokenRecord.userId,
        });
        const reason = userData.blockedReason ? `: ${userData.blockedReason}` : "";
        return res.status(403).json({
          error: "access_denied",
          error_description: `Account is blocked${reason}`,
          hint: `Contact support at ${getContactEmail()} if you believe this is an error.`,
        });
      }

      // Update lastUsedAt fire-and-forget
      db.update(apiToken)
        .set({ lastUsedAt: new Date().toISOString() })
        .where(eq(apiToken.id, tokenRecord.id))
        .then(() => {})
        .catch(() => {});

      // Build user context and proceed (skip version check for persistent tokens)
      const promptContext = await extractPromptContext(req);
      const userContext = {
        userId: tokenRecord.userId,
        email: userData.email,
        agent: promptContext.agent,
        model: promptContext.model,
      };

      logger.info("Authenticated MCP request via persistent token", {
        method: mcpMethod,
        requestId: req.body?.id,
        userId: userContext.userId.substring(0, 8) + "...",
        tokenId: tokenRecord.id.substring(0, 8) + "...",
        ...(promptContext.agent && { agent: promptContext.agent }),
        ...(promptContext.model && { model: promptContext.model }),
      });

      const mcpServer = await createMcpServerWithTools(promptContext);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);

      await runWithMCPContext(userContext, async () => {
        if (toolName && toolArgs) {
          const { inputData, resourceIds } = sanitizeInput(toolArgs);
          updateContext({ operation: `mcp:${toolName}`, inputData, resourceIds });
        }
        await transport.handleRequest(req, res, req.body);
      });

      res.on("finish", () => {
        transport.close?.();
      });
      return;
    }

    // --- OAuth authentication (existing flow) ---

    // Validate MCP session via Better Auth MCP plugin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = await (auth.api as any).getMcpSession({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      headers: req.headers as any,
    });

    // Return HTTP 401 if no valid session (includes initialize requests)
    if (!session) {
      const baseUrl = getBaseUrl();
      const wwwAuthHeader = `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

      logger.info("MCP request without valid session - returning 401", {
        method: req.body?.method,
        hasAuthHeader: !!req.headers.authorization,
      });

      return res.status(401).header("WWW-Authenticate", wwwAuthHeader).json({
        error: "invalid_token",
        error_description: "Authorization required. Please authenticate via OAuth.",
        hint: "Re-authorize MCP server in client settings. Token may have expired.",
      });
    }

    // Extract user context from Better Auth session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (session as any).userId || "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const email = (session as any).email || "";

    // Check if user is blocked - SECURITY: blocked users cannot access MCP
    if (userId) {
      const db = getDatabase();
      const [userData] = await db
        .select({ blocked: user.blocked, blockedReason: user.blockedReason })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);

      if (userData?.blocked) {
        logger.warn("Blocked user attempted MCP access", { userId, email });
        const reason = userData.blockedReason ? `: ${userData.blockedReason}` : "";
        return res.status(403).json({
          error: "access_denied",
          error_description: `Account is blocked${reason}`,
          hint: `Contact support at ${getContactEmail()} if you believe this is an error.`,
        });
      }
    }

    // Check MCP tools version - detect outdated clients (#196)
    // Better Auth getMcpSession doesn't return custom fields like toolsVersion,
    // so we query the token directly from the database
    let tokenToolsVersion: string | null = null;
    if (bearerToken) {
      const database = getDatabase();
      const [tokenData] = await database
        .select({ toolsVersion: oauthAccessToken.toolsVersion })
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.accessToken, bearerToken))
        .limit(1);
      tokenToolsVersion = tokenData?.toolsVersion || null;
    }

    // null means token was created before version tracking - treat as outdated
    if (tokenToolsVersion !== MCP_SERVER_VERSION) {
      logger.info("Outdated MCP client detected", {
        userId: userId.substring(0, 8) + "...",
        tokenVersion: tokenToolsVersion || "unknown",
        serverVersion: MCP_SERVER_VERSION,
      });
      return res.status(426).json({
        error: "upgrade_required",
        error_description: `MCP server updated to v${MCP_SERVER_VERSION}. Your client has cached tools from v${tokenToolsVersion || "unknown"}.`,
        hint: "Run '/mcp reconnect moira' in Claude Code to refresh tools.",
        serverVersion: MCP_SERVER_VERSION,
        clientVersion: tokenToolsVersion || "unknown",
      });
    }

    // Extract agent/model context for hierarchical prompt override resolution (#398)
    const promptContext = await extractPromptContext(req);

    // Include prompt context in user context for AsyncLocalStorage propagation
    // This allows workflow-engine to access agent/model for systemReminder resolution
    const userContext = {
      userId,
      email,
      agent: promptContext.agent,
      model: promptContext.model,
    };

    logger.info("Authenticated MCP request", {
      method: req.body?.method,
      requestId: req.body?.id,
      userId: userContext.userId.substring(0, 8) + "...",
      ...(promptContext.agent && { agent: promptContext.agent }),
      ...(promptContext.model && { model: promptContext.model }),
    });

    // Create new MCP server with fresh tool descriptions for each request
    // This ensures admin changes to tool descriptions take effect on reconnect
    // Pass prompt context for hierarchical override resolution
    const mcpServer = await createMcpServerWithTools(promptContext);

    // Create new transport for each request (stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    // Connect server to transport
    await mcpServer.connect(transport);

    // Handle MCP request with both user context and logging context
    await runWithMCPContext(userContext, async () => {
      // Update context with tool info INSIDE runWithMCPContext
      // This ensures inputData is available for error logging
      if (toolName && toolArgs) {
        const { inputData, resourceIds } = sanitizeInput(toolArgs);
        updateContext({
          operation: `mcp:${toolName}`,
          inputData,
          resourceIds,
        });
      }
      await transport.handleRequest(req, res, req.body);
    });

    // Cleanup transport after request
    res.on("finish", () => {
      transport.close?.();
    });
  } catch (error) {
    logger.error("MCP request failed", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal MCP server error",
        },
        id: req.body?.id || null,
      });
    }
  }
});

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    mode: "stateless",
    version: MCP_SERVER_VERSION,
  });
});

// Start HTTP server
async function main() {
  try {
    // Config is validated automatically on first access (lazy initialization)
    const port = getMcpPort();

    // Verify tool descriptions can be loaded from DB at startup
    const descriptions = await loadToolDescriptions();
    const toolCount = Object.keys(descriptions).filter(
      (k) => descriptions[k as McpToolName],
    ).length;
    logger.info("Tool descriptions loaded from database", { toolCount });

    logger.info("Starting MCP Moira HTTP server...", { port });
    const httpServer = app.listen(port, () => {
      logger.info("MCP Moira HTTP server started successfully", {
        port,
        endpoint: `http://localhost:${port}/mcp`,
      });
    });

    // Graceful shutdown of HTTP server (stateless mode)
    process.on("SIGINT", () => {
      logger.info("Received SIGINT, shutting down HTTP server");
      httpServer.close(() => {
        try {
          closeDatabase();
          logger.info("Database closed successfully");
        } catch (dbError) {
          logger.error("Error closing database", {
            error: dbError instanceof Error ? dbError.message : "Unknown error",
          });
        }
        process.exit(0);
      });
    });

    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM, shutting down HTTP server");
      httpServer.close(() => {
        try {
          closeDatabase();
          logger.info("Database closed successfully");
        } catch (dbError) {
          logger.error("Error closing database", {
            error: dbError instanceof Error ? dbError.message : "Unknown error",
          });
        }
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error("Fatal MCP server error", error);
    throw error;
  }
}

main().catch((error) => {
  logger.error("Fatal error", error);
  process.exit(1);
});
