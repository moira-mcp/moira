import { z } from "zod";
import { progressAuthoringSchema } from "../schemas/progress-authoring.js";

export const listWorkflowsSchema = z.object({
  search: z.string().optional().describe("Search in workflow name and description"),
  visibility: z
    .enum(["public", "private", "all"])
    .optional()
    .describe("Filter by visibility (default: all accessible)"),
  sort: z.enum(["createdAt", "name"]).optional().describe("Sort field (default: createdAt)"),
  sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of results (default: 20, max: 100)"),
  offset: z.number().min(0).optional().describe("Offset for pagination (default: 0)"),
});

export const MANAGE_WORKFLOW_ACTIONS = [
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
  "list-nodes",
  "get-nodes",
  "analyze-variables",
  "set-visibility",
  "create-invite",
  "list-access",
  "list-invites",
  "revoke-access",
  "revoke-invite",
] as const;

export const manageWorkflowSchema = z.object({
  action: z.enum(MANAGE_WORKFLOW_ACTIONS).describe("Action to perform on workflow"),
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
        author: z.string().optional().describe("Workflow author"),
        tags: z.array(z.string()).optional().describe("Workflow tags"),
      }),
      nodes: z.array(z.record(z.unknown())).describe("Array of workflow nodes"),
      variableRegistry: z
        .record(z.unknown())
        .optional()
        .describe(
          "Declared global variables (JSON-Schema-shaped: name -> {type, description, default?}). Required for any variable referenced by bare name in directives/conditions/templates.",
        ),
      runtimePolicy: z
        .object({
          externalVariableWrites: z
            .record(z.object({ allowedNodeIds: z.array(z.string()).optional() }))
            .optional(),
        })
        .optional(),
      progress: progressAuthoringSchema.optional(),
      visibility: z
        .enum(["public", "private"])
        .optional()
        .describe("Workflow visibility (default: private)"),
      systemReminder: z.string().optional().describe("System reminder shown to agent on each step"),
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
          author: z.string().optional(),
          tags: z.array(z.string()).optional(),
        })
        .optional()
        .describe("Metadata fields to update"),
      variableRegistry: z
        .record(z.unknown())
        .optional()
        .describe("Replace the workflow's declared global variable registry"),
      runtimePolicy: z
        .object({
          externalVariableWrites: z
            .record(z.object({ allowedNodeIds: z.array(z.string()).optional() }))
            .optional(),
        })
        .optional(),
      progress: progressAuthoringSchema.optional(),
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
  includeNodes: z.boolean().optional().describe("Include full node definitions in get response"),
  includeValidation: z.boolean().optional().describe("Include validation results in response"),
  offset: z.number().optional().describe("Pagination offset for node listing"),
  limit: z.number().optional().describe("Maximum nodes to return"),
  nodeId: z.string().optional().describe("Specific node ID for get-node and clone-node actions"),
  query: z.string().optional().describe("Search query for search-nodes action"),
  variableName: z.string().optional().describe("Variable name for get/set/delete-variable actions"),
  variableValue: z.any().optional().describe("Variable value for set-variable action"),
  variableNames: z.array(z.string()).optional(),
  variableTypes: z.array(z.string()).optional(),
  hasDefault: z.boolean().optional(),
  externallyWritable: z.boolean().optional(),
  compareWorkflowId: z.string().optional().describe("Second workflow ID for diff action"),
  newName: z.string().optional().describe("New name for copied workflow (copy action)"),
  newId: z.string().optional().describe("New ID for cloned node (clone-node action)"),
  targetIndex: z.number().optional().describe("Target position for node (move-node action)"),
  afterNodeId: z
    .string()
    .optional()
    .describe("Place node after this node ID (move-node only, alternative to targetIndex)"),
  typeFilter: z.string().optional().describe("Filter nodes by type (list-nodes only)"),
  includePreview: z.boolean().optional().describe("Include directive preview (list-nodes only)"),
  previewLength: z
    .number()
    .optional()
    .describe("Length of directive preview (list-nodes only, default 100)"),
  nodeIds: z
    .array(z.string())
    .optional()
    .describe("Array of node IDs to retrieve (get-nodes only)"),
  includeVariables: z
    .boolean()
    .optional()
    .describe("Include variables in search (search-nodes only)"),
  snippetMode: z
    .boolean()
    .optional()
    .describe("Return only snippets, not full nodes (search-nodes only)"),
  graph: z.boolean().optional().describe("Return ASCII flow graph (get-structure only)"),
  detailed: z
    .boolean()
    .optional()
    .describe("Include directive preview in structure (get-structure only)"),
  visibility: z
    .enum(["public", "private"])
    .optional()
    .describe("New visibility setting (set-visibility only)"),
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

export const manageWorkflowHandlerSchema = manageWorkflowSchema.extend({
  workflow: z.any().optional().describe("Workflow object (required for create and validate)"),
  changes: z.any().optional().describe("Changes to apply (edit only)"),
});

export const getSessionInfoHandlerSchema = z.object({
  action: z
    .enum([
      "user",
      "executions",
      "execution_context",
      "current_step",
      "update-note",
      "set-parent",
      "add-reminder",
      "reminders",
      "update-reminder",
      "remove-reminder",
      "variables",
      "set-variable",
      "progress",
      "progress-image-token",
    ])
    .describe("Action to perform"),
  executionId: z
    .string()
    .optional()
    .describe("Execution ID for execution_context, current_step, or update-note actions"),
  // Parameters for executions action
  // Issue #386: 2-status model - "running" (active) and "completed" (finished)
  // Old values "waiting" and "failed" accepted for backward compatibility (mapped to new values)
  status: z
    .array(z.enum(["running", "waiting", "completed", "failed", "locked"]))
    .optional()
    .describe("Filter executions by status (array of statuses)"),
  workflowId: z.string().optional().describe("Filter by workflow ID"),
  search: z.string().optional().describe("Search in execution notes"),
  sort: z.enum(["createdAt", "updatedAt"]).optional().describe("Sort field for executions list"),
  sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort order (ascending or descending)"),
  limit: z.number().min(1).max(100).optional().describe("Maximum executions to return (1-100)"),
  offset: z.number().min(0).optional().describe("Pagination offset"),
  // Parameters for update-note action
  note: z
    .string()
    .max(500)
    .optional()
    .describe("New note text for update-note action (max 500 chars)"),
  parentExecutionId: z
    .string()
    .optional()
    .describe('Parent execution UUID or "none" for set-parent'),
  expectedRevision: z.number().int().min(0).optional().describe("Expected execution revision"),
  reminderId: z.string().optional().describe("Reminder ID"),
  reminderText: z.string().optional().describe("Reminder text"),
  idempotencyKey: z.string().optional().describe("Idempotency key for add-reminder"),
  reminderStatus: z.enum(["active", "cancelled"]).optional().describe("Reminder status filter"),
  names: z.array(z.string()).optional(),
  types: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  hasValue: z.boolean().optional(),
  writePhase: z.enum(["current", "other"]).optional(),
  variableName: z.string().optional(),
  variableValue: z.unknown().optional(),
  theme: z.enum(["light", "dark"]).optional(),
  viewportWidth: z.number().int().min(480).max(4096).optional(),
  // Parameters for execution_context action
  variables: z
    .array(z.string())
    .optional()
    .describe(
      "Filter context.variables to only include these variable names (execution_context action)",
    ),
});

export const getSessionInfoSchema = getSessionInfoHandlerSchema.omit({ variables: true });

export const manageNotesSchema = z.object({
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
  key: z.string().optional().describe("Note key (required for get, save, delete, history actions)"),
  version: z.number().optional().describe("Specific version number to retrieve (for get action)"),
  value: z.string().optional().describe("Note content (required for save action)"),
  tags: z.array(z.string()).optional().describe("Tags for the note (for save action, max 10 tags)"),
});

export const manageArtifactsSchema = z.object({
  action: z
    .enum(["upload", "update", "delete", "list", "stats", "token"])
    .describe("Action to perform on artifacts"),
  name: z.string().optional().describe("Artifact name (required for upload action)"),
  content: z.string().optional().describe("HTML content (required for upload and update actions)"),
  executionId: z
    .string()
    .optional()
    .describe("Link artifact to workflow execution (optional for upload)"),
  uuid: z.string().optional().describe("Artifact UUID (required for update and delete actions)"),
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
});

export const manageLocksSchema = z.object({
  action: z.enum(["status", "list", "unlock", "lock"]).describe("Action to perform on locks"),
  executionId: z.string().describe("Execution ID (required for all actions)"),
  pin: z.string().optional().describe("PIN code to unlock (required for unlock action)"),
  reason: z
    .string()
    .optional()
    .describe("Reason for locking the execution (required for lock action)"),
});

export const manageReconciliationSchema = z.object({
  action: z.enum(["status", "get", "resolve"]),
  reference: z.string().optional(),
  selection: z.enum(["current", "incoming", "previous"]).optional(),
  revision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  rationale: z.string().trim().min(1).max(2000).optional(),
  mergedGraph: z.record(z.unknown()).optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

export const startSchema = z.object({
  workflowId: z.string().describe("Workflow ID to start (use list() to see available workflows)"),
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
      "Skip the optional Telegram notification pre-flight check. Lock nodes still require trusted Telegram PIN delivery.",
    ),
});

export const stepSchema = z.object({
  processId: z.string().describe("Process ID from start() or previous step() response"),
  input: z
    .union([z.string(), z.record(z.any()), z.array(z.unknown()), z.number(), z.boolean(), z.null()])
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
});

export const helpSchema = z.object({
  topic: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe(
      "Documentation topic(s) to retrieve. Call without a topic to discover the current topics and accepted aliases.",
    ),
});

export const settingsSchema = z.object({
  action: z
    .enum(["get", "set", "list"])
    .describe(
      "Action: get (one key, one category, or all values), set (update one value), list (definitions by category or all)",
    ),
  category: z
    .string()
    .min(1, "Setting category cannot be empty")
    .regex(/\S/, "Setting category cannot be blank")
    .optional()
    .describe("Category filter for get and list; do not combine with key for get"),
  key: z
    .string()
    .min(1, "Setting key cannot be empty")
    .regex(/\S/, "Setting key cannot be blank")
    .optional()
    .describe("Exact setting key for get or set (e.g., 'telegram.bot_token')"),
  value: z.any().optional().describe("New value for set action"),
});

export const tokenSchema = z.object({
  action: z
    .enum(["upload", "download"])
    .describe("Token type: upload (for creating workflows), download (for retrieving)"),
  workflowId: z.string().optional().describe("Workflow ID (required for download action)"),
  ttlMinutes: z
    .number()
    .optional()
    .default(60)
    .describe("Token expiration time in minutes (default: 60)"),
});
