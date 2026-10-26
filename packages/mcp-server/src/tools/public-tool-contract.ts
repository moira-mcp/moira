import { z } from "zod";
import { sanitizeInput } from "@mcp-moira/shared/logging/sanitize-input";
import {
  getSessionInfoSchema,
  helpSchema,
  listWorkflowsSchema,
  manageArtifactsSchema,
  manageLocksSchema,
  manageNotesSchema,
  managePlaybooksSchema,
  manageReconciliationSchema,
  manageWorkflowSchema,
  settingsSchema,
  startRequestSchema,
  stepSchema,
  tokenSchema,
} from "./tool-schemas.js";
import { WORKSPACE_TOOL_SCHEMAS } from "@mcp-moira/shared/workspace-tool-schemas";

/** JSON values must be present; null, false, zero and empty strings are values. */
const presentValue = z.unknown().refine((value) => value !== undefined, "Value must be present");
const nonempty = z.string().min(1);
type Shape = z.ZodRawShape;
function branch(
  source: { shape: Shape },
  action: string,
  required: string[] = [],
  optional: string[] = [],
  overrides: Shape = {},
) {
  const fields: Shape = { action: z.literal(action) };
  for (const key of required) {
    const field = source.shape[key];
    const unwrapped = field instanceof z.ZodOptional ? field.unwrap() : field;
    fields[key] =
      unwrapped instanceof z.ZodString && !["note", "value", "content"].includes(key)
        ? unwrapped.min(1)
        : unwrapped;
  }
  for (const key of optional) fields[key] = source.shape[key];
  return z.object({ ...fields, ...overrides }).strict();
}
function union(branches: z.ZodTypeAny[]) {
  if (branches.length < 2) throw new Error("Grouped tools need multiple action branches");
  return z.union(branches as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

const w = (
  action: string,
  required: Array<keyof typeof manageWorkflowSchema.shape> = [],
  optional: Array<keyof typeof manageWorkflowSchema.shape> = [],
  overrides: Shape = {},
) => branch(manageWorkflowSchema, action, required, optional, overrides);
const e = (
  action: string,
  required: Array<keyof typeof getSessionInfoSchema.shape> = [],
  optional: Array<keyof typeof getSessionInfoSchema.shape> = [],
  overrides: Shape = {},
) => branch(getSessionInfoSchema, action, required, optional, overrides);
// Authored graph/metadata extension fields belong to GraphValidator, not this transport adapter.
const authoredWorkflow = manageWorkflowSchema.shape.workflow.unwrap();
const workflowPayload = authoredWorkflow
  .extend({
    metadata: authoredWorkflow.shape.metadata
      .extend({
        schemaVersion: z.number().int().min(0).optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .describe(
    "Complete authored workflow for create or validate; preserve the graph and metadata, including fields not edited by this caller",
  );
const authoredChanges = manageWorkflowSchema.shape.changes.unwrap();
const workflowBranches = [
  branch(listWorkflowsSchema, "list", [], Object.keys(listWorkflowsSchema.shape)),
  w("create", [], ["overwrite"], { workflow: workflowPayload }),
  w("edit", ["workflowId", "changes"], ["expectedRevision"], {
    changes: authoredChanges
      .extend({ metadata: authoredChanges.shape.metadata.unwrap().passthrough().optional() })
      .refine((value) => Object.keys(value).length > 0, "Provide changes"),
  }),
  w("get", ["workflowId"], ["includeNodes", "includeValidation", "offset", "limit"]),
  w("get-structure", ["workflowId"], ["graph", "detailed"]),
  w("get-node", ["workflowId", "nodeId"]),
  w("search-nodes", ["workflowId", "query"], ["includeVariables", "snippetMode"], {
    query: nonempty,
  }),
  w("validate", [], [], { workflow: workflowPayload }),
  w(
    "list-variables",
    ["workflowId"],
    ["variableNames", "query", "variableTypes", "hasDefault", "externallyWritable"],
  ),
  w("get-variable", ["workflowId", "variableName"]),
  w("set-variable", ["workflowId", "variableName"], [], { variableValue: presentValue }),
  w("delete-variable", ["workflowId", "variableName"]),
  w("diff", ["workflowId", "compareWorkflowId"]),
  w("copy", ["workflowId"], ["newName"]),
  w("clone-node", ["workflowId", "nodeId"], ["newId"]),
  w("move-node", ["workflowId", "nodeId", "targetIndex"]),
  w("move-node", ["workflowId", "nodeId", "afterNodeId"]),
  w("list-nodes", ["workflowId"], ["typeFilter", "includePreview", "previewLength"]),
  w("get-nodes", ["workflowId"], [], {
    nodeIds: manageWorkflowSchema.shape.nodeIds.unwrap().min(1),
  }),
  w("analyze-variables", ["workflowId"]),
  w("set-visibility", ["workflowId", "visibility"]),
  w("create-invite", ["workflowId"], ["ttlMs"]),
  w("list-access", ["workflowId"], ["limit", "offset"]),
  w("list-invites", ["workflowId"], ["activeOnly", "limit", "offset"]),
  w("revoke-access", ["workflowId", "targetUserId"]),
  w("revoke-invite", ["inviteId"]),
  w("history", ["workflowId"]),
  w("get-revision", ["workflowId", "revision"]),
  w("compare-revisions", ["workflowId", "fromRevision", "toRevision"]),
  w("rollback", ["workflowId", "revision", "expectedRevision"]),
  branch(tokenSchema, "upload", [], ["ttlMinutes"]),
  branch(tokenSchema, "download", ["workflowId"], ["ttlMinutes"]),
  branch(manageReconciliationSchema, "reconciliation_status"),
  branch(manageReconciliationSchema, "reconciliation_get", ["reference"]),
  branch(manageReconciliationSchema, "reconciliation_resolve", [
    "reference",
    "selection",
    "revision",
    "rationale",
  ]),
  branch(
    manageReconciliationSchema,
    "reconciliation_resolve",
    ["reference", "revision", "rationale", "mergedGraph", "visibility"],
    [],
    { selection: z.literal("current") },
  ),
];
const prepare = startRequestSchema.options[0].extend({
  workflowId: startRequestSchema.options[0].shape.workflowId.describe(
    'Workflow ID to prepare; discover accessible definitions with workflow({action:"list"})',
  ),
});
const prepareBranches = [
  prepare.omit({ skipNotificationCheck: true }),
  ...[false, true].map((value) =>
    prepare.extend({
      skipNotificationCheck: z.literal(value),
      skipTelegramCheck: z.literal(value).optional(),
    }),
  ),
];
const executionBranches = [
  ...prepareBranches,
  startRequestSchema.options[1],
  branch(stepSchema, "step", ["processId", "attemptId"], ["input"], {
    processId: stepSchema.shape.processId.describe(
      "Process ID from successful execution execute or a previous execution step response",
    ),
    attemptId: stepSchema.shape.attemptId.describe(
      "Step attempt ID from successful execution execute, execution step, or execution current_step",
    ),
  }),
  branch(stepSchema, "step", ["processId", "attemptId"], ["teleportTo"], {
    processId: stepSchema.shape.processId.describe(
      "Process ID from successful execution execute or a previous execution step response",
    ),
    attemptId: stepSchema.shape.attemptId.describe(
      "Step attempt ID from successful execution execute, execution step, or execution current_step",
    ),
    teleportTo: stepSchema.shape.teleportTo.unwrap(),
  }),
  e("user"),
  e("executions", [], ["status", "workflowId", "search", "sort", "sortOrder", "limit", "offset"]),
  ...["execution_context", "current_step", "diagnose", "materialize"].map((action) =>
    e(action, ["executionId"]),
  ),
  e("recover", ["executionId", "nodeId"], ["variableValues"]),
  e("cancel-execution", ["executionId", "expectedRevision"]),
  e("stop-execution", ["executionId", "expectedRevision", "reason"]),
  e("update-note", ["executionId", "note"]),
  e("update-task-title", [
    "executionId",
    "taskTitle",
    "expectedRevision",
    "expectedTaskIdentityRevision",
  ]),
  e("set-parent", ["executionId", "expectedRevision", "expectedParentRevision"], [], {
    parentExecutionId: z.union([z.string().uuid(), z.literal("none")]),
  }),
  e("reminders", ["executionId"], ["reminderStatus", "search"]),
  e(
    "add-reminder",
    ["executionId", "expectedRevision", "expectedRemindersRevision"],
    ["idempotencyKey"],
    {
      reminderText: z.string().trim().min(1).max(1000),
      idempotencyKey: z.string().max(100).optional(),
    },
  ),
  e(
    "update-reminder",
    ["executionId", "expectedRevision", "expectedRemindersRevision", "reminderId"],
    [],
    { reminderText: z.string().trim().min(1).max(1000) },
  ),
  e("remove-reminder", [
    "executionId",
    "expectedRevision",
    "expectedRemindersRevision",
    "reminderId",
  ]),
  e(
    "variables",
    ["executionId"],
    ["names", "search", "types", "editable", "hasValue", "writePhase"],
  ),
  e(
    "set-variable",
    ["executionId", "variableName", "expectedRevision", "expectedContextRevision"],
    [],
    { variableValue: presentValue },
  ),
  e("await-user", ["executionId", "question"], ["options"]),
  e("await-user", ["executionId", "resolve"]),
  e("progress", ["executionId"], ["at"]),
  e(
    "progress-image-token",
    ["executionId"],
    ["device_id", "theme", "viewportWidth", "view", "hide", "collapse"],
  ),
  ...["lock_status", "lock_list"].map((action) =>
    z
      .object({ action: z.literal(action), executionId: manageLocksSchema.shape.executionId })
      .strict(),
  ),
  z
    .object({
      action: z.literal("unlock"),
      executionId: manageLocksSchema.shape.executionId,
      pin: nonempty,
    })
    .strict(),
  z
    .object({
      action: z.literal("lock"),
      executionId: manageLocksSchema.shape.executionId,
      reason: nonempty,
    })
    .strict(),
];

const n = (a: string, r: string[] = [], o: string[] = []) => branch(manageNotesSchema, a, r, o);
const p = (a: string, r: string[] = [], o: string[] = []) => branch(managePlaybooksSchema, a, r, o);
const a = (action: string, required: string[] = [], optional: string[] = []) =>
  branch(manageArtifactsSchema, action, required, optional);

/** Single public projection; original owner purposes and their wire contracts stay private. */
export const WORKSPACE_PUBLIC_ACTIONS = {
  codespace: {
    list: "workspace_list",
    targets: "workspace_targets",
    observe: "workspace_observe",
    create: "workspace_create",
    lifecycle: "workspace_lifecycle",
    adopt: "workspace_adopt",
    delete: "workspace_delete",
    setup_help: "workspace_setup_help",
    adopt_external: "workspace_adopt_external",
    repository_admit: "repository_admit",
    repository_create: "repository_create",
    resume: "operation_resume",
    collect: "operation_get",
    find: "operation_find",
  },
  codespace_terminal: {
    run: "command_run",
    run_native: "command_run_native",
    output: "process_output",
    stop: "process_stop",
    close: "session_close",
    collect: "operation_get",
    find: "operation_find",
  },
  codespace_read: { read: "file_read", stat: "file_stat", preview: "file_preview" },
  codespace_edit: {
    create: "file_create",
    replace: "file_replace",
    patch: "file_patch",
    collect: "operation_get",
    find: "operation_find",
  },
  codespace_git: {
    create: "pull_request_create",
    read: "pull_request_read",
    collect: "operation_get",
    find: "operation_find",
  },
  communication: {
    send: "communication_send",
    deliver: "communication_deliver",
    deliver_publication: "communication_deliver_publication",
    collect: "operation_get",
    find: "operation_find",
  },
} as const;
export const WORKSPACE_PUBLIC_SINGLETONS = {
  codespace_search: "code_search",
  codespace_upload: "file_upload",
  codespace_download: "file_download",
} as const;
function workspaceGroup(actions: Record<string, keyof typeof WORKSPACE_TOOL_SCHEMAS>) {
  return union(
    Object.entries(actions).map(([action, purpose]) => {
      const original = WORKSPACE_TOOL_SCHEMAS[purpose];
      if (purpose === "workspace_lifecycle") {
        const { action: operation, ...shape } = WORKSPACE_TOOL_SCHEMAS.workspace_lifecycle.shape;
        return z.object({ action: z.literal(action), ...shape, operation }).strict();
      }
      return original.extend({ action: z.literal(action) }).strict();
    }),
  );
}
export const PUBLIC_TOOL_SCHEMAS = {
  ...(Object.fromEntries(
    Object.entries(WORKSPACE_PUBLIC_ACTIONS).map(([name, actions]) => [
      name,
      workspaceGroup(actions),
    ]),
  ) as {
    [K in keyof typeof WORKSPACE_PUBLIC_ACTIONS]: z.ZodUnion<
      [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
    >;
  }),
  codespace_search: WORKSPACE_TOOL_SCHEMAS.code_search,
  codespace_upload: WORKSPACE_TOOL_SCHEMAS.file_upload,
  codespace_download: WORKSPACE_TOOL_SCHEMAS.file_download,
  workflow: union(workflowBranches),
  execution: union(executionBranches),
  notes: union([
    n("list", [], ["tag", "keySearch", "limit", "offset"]),
    n("get", ["key"], ["version"]),
    n("save", ["key", "value"], ["tags"]),
    n("delete", ["key"]),
    n("history", ["key"]),
    n("stats"),
  ]),
  playbooks: union([
    p("list", [], ["search", "limit", "offset"]),
    p("get", ["name"], ["owner", "revision"]),
    p("save", ["name", "content"], ["title", "description"]),
    p("delete", ["name"]),
    p("history", ["name"], ["owner"]),
    p("compare", ["name", "fromRevision", "toRevision"], ["owner"]),
    p("restore", ["name", "revision"]),
    p("visibility", ["name", "visibility"]),
  ]),
  artifacts: union([
    a("token", [], ["ttlMinutes"]),
    a("upload", ["name"], ["executionId"]).extend({ content: nonempty }),
    a("update", ["uuid"], ["name"]).extend({ content: nonempty }),
    a("delete", ["uuid"]),
    a("list", [], ["limit", "offset"]),
    a("stats"),
  ]),
  settings: union([
    branch(settingsSchema, "get"),
    branch(settingsSchema, "get", ["key"]),
    branch(settingsSchema, "get", ["category"]),
    branch(settingsSchema, "set", ["key"], [], { value: presentValue }),
    branch(settingsSchema, "list", [], ["category"]),
  ]),
  help: helpSchema.strict(),
} as const;
export type PublicToolName = keyof typeof PUBLIC_TOOL_SCHEMAS;
type InternalPurpose =
  | keyof typeof WORKSPACE_TOOL_SCHEMAS
  | "list"
  | "manage"
  | "token"
  | "reconciliation"
  | "start"
  | "step"
  | "session"
  | "lock"
  | "notes"
  | "playbooks"
  | "artifacts"
  | "settings"
  | "help";

export function resolvePublicTool(
  name: PublicToolName,
  raw: unknown,
): { purpose: InternalPurpose; params: Record<string, unknown>; privateInput: boolean } {
  const params = PUBLIC_TOOL_SCHEMAS[name].parse(raw) as Record<string, unknown>;
  const { action, ...fields } = params;
  if (name in WORKSPACE_PUBLIC_SINGLETONS)
    return {
      purpose: WORKSPACE_PUBLIC_SINGLETONS[name as keyof typeof WORKSPACE_PUBLIC_SINGLETONS],
      params,
      privateInput: true,
    };
  if (name in WORKSPACE_PUBLIC_ACTIONS) {
    const actions: Readonly<Record<string, keyof typeof WORKSPACE_TOOL_SCHEMAS>> =
      WORKSPACE_PUBLIC_ACTIONS[name as keyof typeof WORKSPACE_PUBLIC_ACTIONS];
    const purpose = actions[String(action)];
    if (purpose === "workspace_lifecycle") {
      const { operation, ...rest } = fields;
      return { purpose, params: { ...rest, action: operation }, privateInput: true };
    }
    return { purpose, params: fields, privateInput: true };
  }
  if (name === "workflow") {
    if (action === "list") return { purpose: "list", params: fields, privateInput: false };
    if (action === "upload" || action === "download")
      return { purpose: "token", params, privateInput: false };
    if (String(action).startsWith("reconciliation_"))
      return {
        purpose: "reconciliation",
        params: { ...fields, action: String(action).slice("reconciliation_".length) },
        privateInput: false,
      };
    return { purpose: "manage", params, privateInput: false };
  }
  if (name === "execution") {
    if (action === "prepare" || action === "execute")
      return { purpose: "start", params, privateInput: false };
    if (action === "step") return { purpose: "step", params: fields, privateInput: false };
    if (["lock_status", "lock_list", "unlock", "lock"].includes(String(action)))
      return {
        purpose: "lock",
        params: { ...fields, action: String(action).replace("lock_", "") },
        privateInput: false,
      };
    return { purpose: "session", params, privateInput: false };
  }
  if (
    name === "notes" ||
    name === "playbooks" ||
    name === "artifacts" ||
    name === "settings" ||
    name === "help"
  )
    return { purpose: name, params, privateInput: false };
  throw new Error(`Unmapped public MCP tool: ${name}`);
}

/** Classify before generic logging: owner command text, attachment URLs and refs are private. */
export function publicToolLogContext(name: PublicToolName, raw: unknown) {
  const projection = resolvePublicTool(name, raw);
  return projection.privateInput
    ? { inputData: { workspace_tool: projection.purpose }, resourceIds: {} }
    : sanitizeInput(projection.params);
}
