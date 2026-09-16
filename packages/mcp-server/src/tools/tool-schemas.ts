import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
      nodes: z
        .array(z.record(z.unknown()))
        .describe(
          "Array of workflow nodes. Decisions are `cases` on the deciding node (condition or agent-directive) with a default output; a separate condition or expression node serves shared or standalone decisions.",
        ),
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
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "edit only: the workflow revision the changes were prepared against (from get); the edit is refused when the stored revision differs",
    ),
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
      "diagnose",
      "recover",
      "cancel-execution",
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
  parentExecutionId: z
    .string()
    .optional()
    .describe('Parent execution UUID or "none" for set-parent'),
  expectedRevision: z.number().int().min(0).optional().describe("Expected workflow-step revision"),
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

const communicationFilename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "Filename must not contain paths or control characters",
  );
const communicationMimeType = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);

export const communicationSchema = z
  .object({
    action: z.enum(["send", "attachment-token"]),
    message: z.string().min(1).max(4096),
    format: z.enum(["plain", "markdown", "html"]).optional(),
    silent: z.boolean().optional(),
    kind: z.enum(["image", "document"]).optional(),
    filename: communicationFilename.optional(),
    mimeType: communicationMimeType.optional(),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(20 * 1024 * 1024)
      .optional(),
  })
  .strict();

const codespaceIdSchema = z.string().uuid().describe("Persistent codespace ID");
const codespacePathSchema = z.string().min(1).max(4096).describe("Repository-relative path");
const codespaceSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const codespaceMimeTypeSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i);
const codespaceFileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "Filename must not contain paths or control characters",
  );

export const codespaceExpectedSchema = z
  .object({
    exists: z.boolean().describe("Whether the target must already exist"),
    size_bytes: z.number().int().min(0).optional(),
    sha256: codespaceSha256Schema.optional(),
  })
  .strict();

export const codespaceNativeFileSchema = z
  .object({
    file_id: z
      .string()
      .max(512)
      .regex(/^(?:sediment:\/\/)?file_[A-Za-z0-9]+$/),
    download_url: z.string().url(),
    file_name: codespaceFileNameSchema.optional(),
    mime_type: codespaceMimeTypeSchema.optional(),
    size_bytes: z
      .number()
      .int()
      .min(0)
      .max(4 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .describe("Native ChatGPT file reference; pass the attachment reference without base64");

export const codespaceListSchema = z
  .object({
    refresh: z
      .boolean()
      .optional()
      .describe("Re-read the approved repositories from the provider before answering"),
  })
  .strict();

export const codespaceSetupHelpSchema = z
  .object({
    repository_id: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Repository provider ID to diagnose, when the task already names one"),
  })
  .strict();

export const codespaceCreateSchema = z
  .object({
    repository_id: z.string().min(1).max(255),
    ref: z.string().min(1).max(255),
  })
  .strict();

export const codespaceGetSchema = z.object({ codespace_id: codespaceIdSchema }).strict();
export const codespaceStartSchema = codespaceGetSchema;
export const codespaceStopSchema = codespaceGetSchema;

export const codespaceDeleteSchema = z
  .object({
    codespace_id: codespaceIdSchema,
    expected_generation: z.number().int().min(1),
    confirm_delete: z.literal(true).describe("Required explicit destructive confirmation"),
  })
  .strict();

const codespaceOperationResumeSchema = z
  .object({
    codespace_id: codespaceIdSchema,
    operation_id: z.string().uuid().describe("Pending operation ID returned by this tool"),
  })
  .strict();

const codespaceExecStartSchema = z
  .object({
    codespace_id: codespaceIdSchema,
    argv: z
      .array(
        z
          .string()
          .min(1)
          .max(16 * 1024),
      )
      .min(1)
      .max(128)
      .optional(),
    script: z
      .string()
      .min(1)
      .max(64 * 1024)
      .optional()
      .describe("Shell script run inside a session; what it leaves behind is carried forward"),
    session_end: z
      .boolean()
      .default(false)
      .describe("End the named session after this call, or alone with no command"),
    // Absent means the session's working directory, or the repository root without a session.
    cwd: z.string().max(4096).optional(),
    session: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
      .optional()
      .describe("Continue the working directory and variables of this named session"),
    session_start: z
      .boolean()
      .default(false)
      .describe("Open the named session instead of continuing it"),
    env: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(4096))
      .optional()
      .describe("Variables for this command, and for later commands in the same session"),
    // Absent means the mode's own default: an ordinary bounded duration, or the whole background
    // ceiling. The upper value is that ceiling; a bounded command is refused above its own, smaller
    // one with a message naming it.
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(24 * 60 * 60)
      .optional(),
    background: z
      .boolean()
      .default(false)
      .describe("Keep the command running past this request; collect it later by operation_id"),
    max_stdout_bytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024)
      .optional(),
    max_stderr_bytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024)
      .optional(),
  })
  .strict();

export const codespaceExecRequestSchema = z.union([
  codespaceExecStartSchema.extend({ stdin_text: z.string().optional() }),
  codespaceExecStartSchema.extend({ stdin_file: codespaceNativeFileSchema }),
  // Resuming a command also stops one: the same operation identity, asked to end instead of to
  // report. A background command is stopped this way.
  codespaceOperationResumeSchema.extend({ cancel: z.boolean().default(false) }),
]);

export const codespaceStatRequestSchema = z.union([
  z.object({ codespace_id: codespaceIdSchema, path: codespacePathSchema }).strict(),
  codespaceOperationResumeSchema,
]);

export const codespaceSearchRequestSchema = z.union([
  z
    .object({
      codespace_id: codespaceIdSchema,
      path: codespacePathSchema,
      query: z.string().min(1).max(4096),
      mode: z.enum(["literal", "regex"]).default("literal"),
      max_matches: z.number().int().min(1).max(1000).default(100),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024)
        .default(64 * 1024),
    })
    .strict(),
  codespaceOperationResumeSchema,
]);

const codespaceReadRangeSchema = z.object({
  offset: z.number().int().min(0).default(0),
  length: z
    .number()
    .int()
    .min(1)
    .max(4 * 1024 * 1024)
    .default(64 * 1024),
});

export const codespaceReadRequestSchema = z.union([
  codespaceReadRangeSchema
    .extend({ codespace_id: codespaceIdSchema, path: codespacePathSchema })
    .strict(),
  // Retained command output: the same range read addressed to a command instead of a file. It is
  // matched before the resume form, which carries no stream.
  codespaceReadRangeSchema
    .extend({
      codespace_id: codespaceIdSchema,
      operation_id: z.string().uuid().describe("Command operation whose retained output is read"),
      stream: z.enum(["stdout", "stderr"]),
    })
    .strict(),
  codespaceOperationResumeSchema,
]);

export const codespaceWriteRequestSchema = z.union([
  z
    .object({
      codespace_id: codespaceIdSchema,
      path: codespacePathSchema,
      text: z.string(),
      expected: codespaceExpectedSchema,
    })
    .strict(),
  codespaceOperationResumeSchema,
]);

export const codespaceApplyPatchRequestSchema = z.union([
  z
    .object({
      codespace_id: codespaceIdSchema,
      files: z
        .array(
          z
            .object({
              path: codespacePathSchema,
              expected: codespaceExpectedSchema,
              edits: z
                .array(
                  z
                    .object({
                      start: z.number().int().min(0),
                      end: z.number().int().min(0),
                      text: z.string(),
                    })
                    .strict(),
                )
                .min(1)
                .max(4096),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
  codespaceOperationResumeSchema,
]);

export const codespaceUploadRequestSchema = z.union([
  z
    .object({
      codespace_id: codespaceIdSchema,
      path: codespacePathSchema,
      file: codespaceNativeFileSchema,
      expected: codespaceExpectedSchema,
    })
    .strict(),
  codespaceOperationResumeSchema,
]);

const codespaceDownloadStartSchema = z
  .object({
    codespace_id: codespaceIdSchema,
    path: codespacePathSchema,
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    file_name: codespaceFileNameSchema,
    mime_type: codespaceMimeTypeSchema,
  })
  .strict();

export const codespaceDownloadRequestSchema = z.union([
  codespaceDownloadStartSchema,
  codespaceOperationResumeSchema.extend({
    file_name: codespaceFileNameSchema,
    mime_type: codespaceMimeTypeSchema,
  }),
]);

export const CODESPACE_ACTION_REQUEST_SCHEMAS = {
  list: codespaceListSchema,
  setup_help: codespaceSetupHelpSchema,
  create: codespaceCreateSchema,
  get: codespaceGetSchema,
  start: codespaceStartSchema,
  stop: codespaceStopSchema,
  delete: codespaceDeleteSchema,
  exec: codespaceExecRequestSchema,
  stat: codespaceStatRequestSchema,
  search: codespaceSearchRequestSchema,
  read: codespaceReadRequestSchema,
  write: codespaceWriteRequestSchema,
  apply_patch: codespaceApplyPatchRequestSchema,
  upload: codespaceUploadRequestSchema,
  download: codespaceDownloadRequestSchema,
} as const;

export const CODESPACE_ACTIONS = Object.keys(CODESPACE_ACTION_REQUEST_SCHEMAS) as [
  CodespaceAction,
  ...CodespaceAction[],
];

export type CodespaceAction = keyof typeof CODESPACE_ACTION_REQUEST_SCHEMAS;

/**
 * The published contract of the one `codespace` tool: `action` plus every field any action accepts,
 * each optional because no field belongs to every action. The object stays strict, so a field
 * belonging to no action at all is still refused here; a field belonging to another action is
 * refused at dispatch, where the action's own strict contract is applied.
 */
/**
 * Whether two field declarations accept exactly the same values, compared through their serialized
 * JSON Schema — the same projection a client reads, so a difference here is a difference the caller
 * can observe.
 */
function sameShape(left: z.ZodTypeAny, right: z.ZodTypeAny): boolean {
  // Compared on what constrains the values, not on prose: two actions may describe the same field
  // differently, and publishing those as alternatives shows the agent two identical-looking branches
  // it cannot act on. A real difference in what is accepted still separates them.
  const serialize = (field: z.ZodTypeAny) => {
    const schema = zodToJsonSchema(field, { $refStrategy: "none" }) as Record<string, unknown>;
    const withoutProse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(withoutProse);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== "description")
            .map(([key, nested]) => [key, withoutProse(nested)]),
        );
      }
      return value;
    };
    return JSON.stringify(withoutProse(schema));
  };
  return serialize(left) === serialize(right);
}

export const codespaceSchema = (() => {
  const declarations = new Map<string, z.ZodTypeAny[]>();
  const forms = Object.values(CODESPACE_ACTION_REQUEST_SCHEMAS).flatMap((request) =>
    request instanceof z.ZodUnion
      ? (request.options as z.AnyZodObject[])
      : [request as z.AnyZodObject],
  );
  for (const form of forms) {
    for (const [key, field] of Object.entries(form.shape as Record<string, z.ZodTypeAny>)) {
      // A default is dropped here and applied by the action's own contract at dispatch. Left in
      // place, the published object would fill every action's defaults into every request, and the
      // action's strict contract would then refuse fields the caller never sent. The description
      // is re-applied, because it was written after the default and is what the agent reads.
      const bare =
        field instanceof z.ZodDefault
          ? field.description === undefined
            ? field.removeDefault()
            : field.removeDefault().describe(field.description)
          : field;
      const known = declarations.get(key) ?? [];
      // Two actions may declare the same field name with different bounds — `search` and `download`
      // both take `max_bytes`, with different ceilings. Publishing only the first would narrow the
      // other action's parameter, so every distinct declaration is published and the action's own
      // contract narrows the request at dispatch.
      if (!known.some((candidate) => sameShape(candidate, bare))) known.push(bare);
      declarations.set(key, known);
    }
  }
  const shape: Record<string, z.ZodTypeAny> = {
    action: z.enum(CODESPACE_ACTIONS).describe("Codespace operation to perform"),
  };
  for (const [key, fields] of declarations) {
    const published =
      fields.length === 1 ? fields[0] : z.union(fields as [z.ZodTypeAny, z.ZodTypeAny]);
    shape[key] = published.isOptional() ? published : published.optional();
  }
  return z.object(shape).strict();
})();
