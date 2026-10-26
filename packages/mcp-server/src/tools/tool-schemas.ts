import { z } from "zod";
import { AWAITING_USER_LIMITS } from "@mcp-moira/workflow-engine/awaiting-user";
import { EXECUTION_TASK_TITLE_LIMIT } from "@mcp-moira/shared/execution-task-identity";
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
  "history",
  "get-revision",
  "compare-revisions",
  "rollback",
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
      nodes: z
        .array(z.record(z.unknown()))
        .describe(
          "Array of workflow nodes. Decisions are `cases` on the deciding node (condition or agent-directive) with a default output; a separate condition or expression node serves shared or standalone decisions.",
        ),
      variableRegistry: z
        .record(z.unknown())
        .optional()
        .describe(
          "Declared global variables (JSON-Schema-shaped: name -> {type, description, default?}). Required for any variable referenced by bare name in directives, routing cases, expressions, progress list bindings and templates.",
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
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "edit or rollback: the current definition revision from get; required for rollback; a stale value refuses the write",
    ),
  revision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Immutable content-history revision for get-revision or rollback; distinct from metadata.version and expectedRevision",
    ),
  fromRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Older content-history revision for compare-revisions"),
  toRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Newer content-history revision for compare-revisions"),
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
  device_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Selected paired controller for progress-image-token; omit only when exactly one live controller is eligible",
    ),
  action: z
    .enum([
      "user",
      "executions",
      "execution_context",
      "current_step",
      "diagnose",
      "recover",
      "cancel-execution",
      "stop-execution",
      "update-note",
      "update-task-title",
      "set-parent",
      "add-reminder",
      "reminders",
      "update-reminder",
      "remove-reminder",
      "variables",
      "set-variable",
      "await-user",
      "progress",
      "progress-image-token",
      "materialize",
    ])
    .describe("Action to perform"),
  executionId: z
    .string()
    .optional()
    .describe(
      "Execution ID for execution_context, current_step, diagnose, recover, update-note, or materialize actions",
    ),
  nodeId: z.string().optional().describe("Node the run must resume from (required for recover)"),
  variableValues: z
    .record(z.unknown())
    .optional()
    .describe("Variable values written into the execution context while recovering (recover only)"),
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
  taskTitle: z
    .string()
    .max(EXECUTION_TASK_TITLE_LIMIT)
    .optional()
    .describe("Concise actual task name for update-task-title; independent of note and flow name"),
  expectedTaskIdentityRevision: z
    .string()
    .length(64)
    .optional()
    .describe("Task identity revision from execution_context or the Progress API"),
  parentExecutionId: z
    .string()
    .optional()
    .describe('Parent execution UUID or "none" for set-parent'),
  expectedRevision: z.number().int().min(0).optional().describe("Expected workflow-step revision"),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Required explanation for stop-execution (1–500 characters)"),
  expectedParentRevision: z
    .string()
    .length(64)
    .optional()
    .describe("Parent target revision returned by execution_context or set-parent"),
  expectedRemindersRevision: z
    .string()
    .length(64)
    .optional()
    .describe("Reminder collection revision returned by reminders or a reminder mutation"),
  expectedContextRevision: z
    .string()
    .length(64)
    .optional()
    .describe("Context target revision returned by variables, execution_context, or set-variable"),
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
  question: z
    .string()
    .trim()
    .min(1)
    .max(AWAITING_USER_LIMITS.question)
    .optional()
    .describe("await-user: what you need from the person, in a sentence or two"),
  options: z
    .array(z.string().trim().min(1).max(AWAITING_USER_LIMITS.option))
    .min(1)
    .max(AWAITING_USER_LIMITS.options)
    .optional()
    .describe("await-user: the choices, when the question is a choice"),
  resolve: z
    .literal(true)
    .optional()
    .describe("await-user: clear your open question instead of raising one"),
  theme: z.enum(["light", "dark"]).optional(),
  viewportWidth: z.number().int().min(480).max(4096).optional(),
  view: z
    .enum(["cards", "process"])
    .optional()
    .describe(
      "progress-image-token: cards (default) draws every block as a content card; process draws the aggregated block view with labelled transitions and loops",
    ),
  hide: z
    .array(z.string().min(1).max(200))
    .max(100)
    .optional()
    .describe(
      "progress-image-token: block ids or authored node ids (resolved to their block) left out of the image; their transitions collapse",
    ),
  collapse: z
    .array(z.string().min(1).max(200))
    .max(100)
    .optional()
    .describe("progress-image-token: block ids or authored node ids drawn as a label-only chip"),
  at: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Route cursor for progress: project the run as of this visit sequence number (the route is cut there, variables carry the values written up to it)",
    ),
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

export const managePlaybooksSchema = z.object({
  action: z
    .enum(["list", "get", "save", "delete", "history", "compare", "restore", "visibility"])
    .describe("Action to perform on playbooks"),
  name: z
    .string()
    .optional()
    .describe("Playbook machine name (required for every action except list)"),
  owner: z
    .string()
    .optional()
    .describe("Owner handle or id when reading someone else's public playbook; defaults to you"),
  search: z.string().optional().describe("Search playbooks by name or description (for list)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum playbooks to return (1-100, default 50)"),
  offset: z.number().min(0).optional().describe("Pagination offset (default 0)"),
  content: z.string().optional().describe("Playbook text (required for save)"),
  title: z.string().optional().describe("Human-readable name (for save)"),
  description: z.string().optional().describe("What this playbook is for (for save)"),
  revision: z
    .number()
    .optional()
    .describe("Revision number to read or restore (for get and restore)"),
  fromRevision: z.number().optional().describe("Older revision to compare (for compare)"),
  toRevision: z.number().optional().describe("Newer revision to compare (for compare)"),
  visibility: z
    .enum(["private", "public"])
    .optional()
    .describe("Who may read the playbook (for visibility)"),
});

export const manageArtifactsSchema = z.object({
  action: z
    .enum(["token", "upload", "update", "delete", "list", "stats"])
    .describe("Prefer token then HTTP file upload for creation; upload is the no-HTTP fallback"),
  name: z.string().optional().describe("Artifact name (required for upload action)"),
  content: z
    .string()
    .optional()
    .describe("Inline HTML for update or no-HTTP upload fallback; prefer token plus a local file"),
  executionId: z
    .string()
    .optional()
    .describe("Link inline upload to an execution; for HTTP upload send executionId in the body"),
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

const startPrepareShape = {
  workflowId: z
    .string()
    .describe("Workflow ID to prepare (required for prepare; use list() for available workflows)"),
  note: z.string().max(500).optional().describe("Optional prepare execution note (max 500 chars)"),
  parentExecutionId: z
    .string()
    .describe('Required for prepare. Use "none" for standalone, or a parent process UUID.'),
  skipNotificationCheck: z
    .boolean()
    .optional()
    .describe(
      "Prepare only. Skip optional ordinary channel checks; lock PIN delivery remains mandatory",
    ),
  skipTelegramCheck: z
    .boolean()
    .optional()
    .describe("Prepare only. Deprecated alias for skipNotificationCheck"),
};

const startExecuteShape = {
  startAttemptId: z
    .string()
    .uuid()
    .describe("Required for execute. Start attempt ID returned by prepare"),
};

export const startSchema = z
  .object({
    action: z
      .enum(["prepare", "execute"])
      .describe("Start phase: prepare reserves an attempt; execute consumes that attempt"),
    workflowId: startPrepareShape.workflowId.optional(),
    note: startPrepareShape.note,
    parentExecutionId: startPrepareShape.parentExecutionId.optional(),
    skipNotificationCheck: startPrepareShape.skipNotificationCheck,
    skipTelegramCheck: startPrepareShape.skipTelegramCheck,
    startAttemptId: startExecuteShape.startAttemptId.optional(),
  })
  .strict();

export const startRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("prepare"),
      ...startPrepareShape,
    })
    .strict(),
  z
    .object({
      action: z.literal("execute"),
      ...startExecuteShape,
    })
    .strict(),
]);

export const stepSchema = z.object({
  processId: z.string().describe("Process ID from start() or previous step() response"),
  attemptId: z
    .string()
    .describe("Step attempt ID from the current start(), step(), or session current_step response"),
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
