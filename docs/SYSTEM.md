# System Reference

## Core Architecture

### Graph Execution Engine

- **UniversalGraphExecutor** - Main workflow processor
- **Node Handlers** - Type-specific processors (start, end, agent-directive, condition, expression, subgraph, telegram-notification, teleport + automatic: read-note, write-note, upsert-note)
- **AgentMessageQueue** - Agent communication system
- **GraphTemplateProcessor** - `{{variable}}` interpolation
- **ContextManager** - Variable and state management

### Storage Layer

```typescript
interface IGraphStorage {
  saveExecution(execution: WorkflowExecution): Promise<void>;
  getExecution(executionId: string): Promise<WorkflowExecution | null>;
  saveWorkflow(graph: WorkflowGraph): Promise<void>;
  getWorkflow(workflowId: string): Promise<WorkflowGraph | null>;
}
```

**File Locations:**

- Executions: `.graph-storage/executions/<uuid>.json`
- Workflows: `workflows/production/flows/<uuid>.json` — one file per flow, named by its stable UUID. Each file carries top-level catalog metadata `owner` (the owning user id) and `visibility` (`public` | `private`) alongside the graph; catalog identity is `(owner, slug)` since a slug is unique only per owner. Read via `readWorkflowCatalog()` in `packages/shared/src/services/workflow-catalog.ts`.

### List Query Builder

Shared utility for paginated list endpoints: `packages/shared/src/database/list-query-builder.ts`

Repositories define a `ListQueryConfig` with sortable columns, default sort, and pagination limits. Then call `executeListQuery()` which handles COUNT + SELECT with ORDER BY, LIMIT, OFFSET.

```typescript
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

const CONFIG: ListQueryConfig<"createdAt" | "updatedAt"> = {
  table: myTable,
  sortableColumns: { createdAt: myTable.createdAt, updatedAt: myTable.updatedAt },
  defaultSort: { field: "createdAt", order: "desc" },
  defaultLimit: 20,
  maxLimit: 100,
};

// In repository method:
const conditions = [eq(myTable.userId, userId)];
const { rows, total } = await executeListQuery(db, CONFIG, filter, conditions);
```

Used by: `ExecutionRepository`, `AuditRepository`, `NoteRepository`, `ArtifactRepository`, `UserRepository`, `WorkflowRepository`.

### MCP HTTP Transport Integration

```typescript
// HTTP Server: StreamableHTTPServerTransport (Stateless Mode)
// Direct imports: import { listWorkflows } from './tools/list-workflows.js'
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined  // Stateless - no session storage
});

// MCP Tools (short names)
list(search?, visibility?, sort?, sortOrder?, limit?, offset?)  // Get workflows with filtering and pagination
start(workflowId: string, note?: string, parentExecutionId: string, skipTelegramCheck?: boolean)  // Initialize execution by UUID, slug, or handle/slug (e.g., "john/my-workflow"), optional note (max 500 chars), required parent link (use "none" for standalone), skip Telegram pre-flight check
step(processId: string, input?: any)                // Process next step with enhanced input parsing
manage(action: string, ...)                         // Workflow CRUD with action-based routing (create/edit/get/get-structure/get-node/search-nodes/validate/list-variables/get-variable/set-variable/delete-variable/diff)
session(action: string, executionId?: string)       // Get session information (user, executions, execution_context, current_step, update-note)
help(topic?: string | string[])                     // Get help documentation (single or multiple topics)
settings(action: string, ...)                       // User settings management (get/set/list)
token(action: string, ...)                          // Generate upload/download tokens for large workflows
notes(action: string, ...)                          // Persistent notes storage with versioning (list/get/save/delete/history/stats)
artifacts(action: string, ...)                      // Static HTML artifacts hosting (upload/update/delete/list/stats/token)
lock(action: string, executionId: string, ...)      // Execution lock management (status/list/unlock/lock)

// HTTP Endpoints
POST /mcp     // JSON-RPC 2.0 requests
GET  /health  // Server health status

// Version Check
// Server compares client's toolsVersion (stored at OAuth authorize) with current server version
// If mismatch: HTTP 426 Upgrade Required with hint "/mcp reconnect moira"
```

### Enhanced Input Parsing

step() supports multiple input formats:

```typescript
// Object input (standard)
{"processId": "abc-123", "input": {"name": "John", "age": 30}}

// Direct object without wrapper
{"processId": "abc-123", "input": {"name": "John", "age": 30}}

// Single quotes (user-friendly)
{"processId": "abc-123", "input": "{'name': 'John', 'age': 30}"}

// Unquoted keys (JavaScript style)
{"processId": "abc-123", "input": "{name: 'John', age: 30}"}

// Mixed quotes
{"processId": "abc-123", "input": "{name: \"John\", 'age': 30}"}

// Escaped JSON string
{"processId": "abc-123", "input": "\"{\\\"name\\\": \\\"John\\\"}\""}

// Legacy params.input structure (backward compatibility)
{"processId": "abc-123", "params": {"input": {"name": "John"}}}
```

### JSON Auto-Parsing for All MCP Tools

All MCP tool `inputSchema` fields with `z.object()`, `z.array()`, or `z.record()` types are wrapped with `z.preprocess()` to automatically parse stringified JSON before Zod validation. This handles the Claude Code serialization bug where JSON objects arrive as strings.

```typescript
// Implementation: packages/mcp-server/src/utils/flexible-json-parser.ts
// Applied in: packages/mcp-server/src/server.ts via wrapSchemaWithAutoparse()

// Example: manage tool receives workflow as string instead of object
manage({ action: "create", workflow: '{"metadata":{"name":"test"},"nodes":[]}' });
// → wrapSchemaWithAutoparse auto-parses the string into an object before validation

// Handles: standard JSON, escaped JSON, single-quote JSON, unquoted keys
// On parse failure: returns original value, Zod produces the validation error
// JSON Schema advertised to clients is unchanged (zodToJsonSchema unwraps ZodEffects)
```

### Magic Variables in Step Input

step() recognizes special variables in input that trigger side effects:

```typescript
// execution_note: Updates execution note (max 500 chars)
step({
  processId: "abc-123",
  input: {
    result: "task completed",
    execution_note: "Step 3: API integration done",
  },
});
// Note: execution_note is stripped from input passed to workflow
```

### Teleport (Jump to Different Workflow Branch)

step() accepts an optional `teleportTo` parameter to jump execution to a teleport node:

```typescript
// Jump to a teleport node (do NOT provide input when teleporting)
step({ processId: "abc-123", teleportTo: "replan-node" });
```

- Only `teleport`-type nodes can be targets
- Execution context (all variables) is preserved
- Teleport node presents its own directive on the next step
- Error: `ValidationError` if target doesn't exist or is not a teleport node
- When workflows contain teleport nodes, hints are appended to every step response

### Telegram Pre-flight Check

start() checks if the workflow contains telegram-notification nodes. If the user has not configured Telegram (missing bot_token or chat_id), returns a synthetic directive with setup instructions instead of starting the workflow.

```typescript
// Bypass the check to start without Telegram notifications
start({
  workflowId: "moira/software-development-flow",
  parentExecutionId: "none",
  skipTelegramCheck: true,
});
```

### Parent-Child Workflow Linking

start() supports parentExecutionId to link child workflows to parent:

```typescript
// Start child workflow with parent link
start({
  workflowId: "child-workflow-id",
  note: "Child execution",
  parentExecutionId: "parent-execution-uuid",
});
```

When child workflow completes, response includes continuation reminder:

```
Workflow completed successfully

---
**CONTINUATION REMINDER**: This was a child workflow. Parent execution awaits continuation.
Parent execution ID: <parent-uuid>
Use step(processId: "<parent-uuid>") to continue the parent workflow.
```

### Workflow Management

manage() with action-based routing:

```typescript
// Create workflow
manage({
  action: 'create',
  workflow: { metadata: {...}, nodes: [...], visibility: 'private' },
  overwrite: false
})

// Edit workflow
manage({
  action: 'edit',
  workflowId: 'workflow-id',
  changes: { metadata: {...}, addNodes: [...], removeNodes: [...], updateNodes: [...] }
})

// Get workflow details
manage({
  action: 'get',
  workflowId: 'workflow-id',
  includeNodes: true,
  includeValidation: true,
  offset: 0,
  limit: 10
})

// Get workflow structure (metadata + node graph, no full content)
manage({
  action: 'get-structure',
  workflowId: 'workflow-id'
})
// Returns: metadata, stats (totalNodes, byType), graph (nodeId, type, connections)

// Get specific node
manage({
  action: 'get-node',
  workflowId: 'workflow-id',
  nodeId: 'node-id'
})
// Returns: full node definition

// Search nodes by text
manage({
  action: 'search-nodes',
  workflowId: 'workflow-id',
  query: 'search text'
})
// Returns: nodes containing query in directive/completionCondition

// Validate workflow
manage({
  action: 'validate',
  workflowId: 'workflow-id'
})
// Returns: errors, warnings, isValid

// List workflow variables (declared globals from variableRegistry)
manage({
  action: 'list-variables',
  workflowId: 'workflow-id'
})
// Returns: variableCount, variables[{name, type, preview}]

// Get specific variable
manage({
  action: 'get-variable',
  workflowId: 'workflow-id',
  variableName: 'test_directive'
})
// Returns: variableName, value

// Set variable (creates or updates)
manage({
  action: 'set-variable',
  workflowId: 'workflow-id',
  variableName: 'test_directive',
  variableValue: 'Run npm test'
})
// Returns: variableName, oldValue, newValue

// Delete variable
manage({
  action: 'delete-variable',
  workflowId: 'workflow-id',
  variableName: 'unused_var'
})
// Returns: variableName, deletedValue

// Compare two workflows
manage({
  action: 'diff',
  workflowId: 'workflow-v1',
  compareWorkflowId: 'workflow-v2'
})
// Returns: metadataDiff, addedNodes[], removedNodes[], modifiedNodes[]
```

## Slug and Handle System

### Workflow Identification

Workflows use a dual-identifier system:

- **UUID (id)**: Internal identifier, auto-generated on workflow creation
- **Slug**: Human-readable identifier, unique per user (4-80 chars)

```typescript
// Slug format: alphanumeric + hyphens, must start/end with alphanumeric
validateSlug("my-workflow"); // { valid: true }
validateSlug("-invalid"); // { valid: false, error: "must start with alphanumeric" }

// Slug resolution
workflowService.getBySlug(slug, userId); // Returns workflow or throws WorkflowNotFoundError
workflowService.getByReference("user-handle/workflow-slug"); // Global reference format
```

### User Handle

Users have a globally unique handle (4-40 chars):

```typescript
// Handle format: alphanumeric + hyphens, must start/end with alphanumeric
validateHandle("john-doe"); // { valid: true }

// Auto-generation on registration
generateHandleFromEmail("john.doe@example.com"); // "john-doe" (with collision resolution)
```

### Domain Errors

```typescript
// packages/shared/src/errors/domain-errors.ts
abstract class DomainError extends Error {
  abstract code: string;
  abstract httpStatus: number;
}

class WorkflowNotFoundError extends DomainError {
  code = "WORKFLOW_NOT_FOUND";
  httpStatus = 404;
}

class SlugConflictError extends DomainError {
  code = "SLUG_CONFLICT";
  httpStatus = 409;
}

class InvalidSlugError extends DomainError {
  code = "INVALID_SLUG";
  httpStatus = 400;
}

class HandleConflictError extends DomainError {
  code = "HANDLE_CONFLICT";
  httpStatus = 409;
}

// Type guards
isDomainError(error); // Check if error is DomainError
isNotFoundError(error); // Check if error is 404
isConflictError(error); // Check if error is 409
```

### Validation Utilities

```typescript
// packages/shared/src/validation/slug-handle.ts
validateSlug(slug: string): ValidationResult;
validateHandle(handle: string): ValidationResult;
normalizeSlug(slug: string): string; // lowercase, trim
normalizeHandle(handle: string): string; // lowercase, trim
generateDefaultSlug(): string; // "workflow-{random8}"
generateHandleFromEmail(email: string): string;

// Constants
SLUG_MIN_LENGTH = 4;
SLUG_MAX_LENGTH = 80;
HANDLE_MIN_LENGTH = 4;
HANDLE_MAX_LENGTH = 40;
```

## Type Definitions (from packages/workflow-engine/src/interfaces/)

### Core Types

```typescript
interface WorkflowGraph {
  id?: string; // Server-assigned; absent in definition files, assigned on save
  metadata: { name: string; version: string; description: string };
  nodes: GraphNode[];
  variableRegistry?: VariableRegistry; // Global declared variables (single source of truth)
}

// Global variable registry — declared once per workflow, keyed by variable name.
type VariableRegistry = Record<string, RegistryVariable>;

interface RegistryVariable {
  type: "string" | "number" | "boolean" | "object" | "array" | "null"; // JSON Schema primitive
  description: string; // Required, single source of truth for the variable's description
  default?: unknown; // Optional default, seeded into globals at workflow start
}

// Variable resolution model (no flat fallback):
//  - Bare name `{{foo}}`         → resolves ONLY from a declared global (variableRegistry).
//                                  Globals live at the top level of context.variables: registry
//                                  defaults are seeded at start; a node writes to a global only by
//                                  declaring its name in inputSchema.globalInputs (see below). There
//                                  is no implicit name-match promotion.
//  - Dotted `{{node-id.name}}`   → resolves from the producing node's local scope
//                                  (context.variables[nodeId]); every node result is stored there.
//  - A bare name that is neither a declared global nor a system var resolves to undefined.
// Templates embedded in a registry variable's `default` value are processed recursively at runtime
// and validated under the same rules.
//
// Output-scope declaration and routing (agent-directive / teleport nodes):
//  - inputSchema.globalInputs?: string[] — names of registry globals this node writes. Names only;
//    type/description come from variableRegistry (single source of truth).
//  - inputSchema.properties — full JSON Schema of the node's LOCAL outputs (addressed node-id.name).
//  - Agent-facing transform: before the directive is returned, each globalInputs name is inlined
//    into properties (type/description from the registry) and the globalInputs key is removed, so the
//    agent receives one ordinary flat JSON Schema and submits one flat object. The same inlined
//    schema validates the response — the agent never sees the global/local distinction.
//  - Engine routes the result by the node's declaration: a globalInputs key → top-level (global)
//    scope; a properties key → node-local scope only; a key that is neither → rejected.
//  - A non-object result (e.g. inputSchema { type: "string" }) is stored verbatim in the node-local
//    scope under the node id and carries no global contract.
//  - The start node is the global-seeding entry point (seeds registry defaults + writes its data to
//    globals); expression-node assignments write to globals by bare name.

interface WorkflowExecution {
  executionId: string;
  workflowId: string;
  currentNodeId: string | null;
  globalContext: ExecutionContext;
  status: "running" | "completed";
  errors?: ExecutionError[]; // Persistent error log
  note?: string | null; // User-provided note for identification (max 500 chars)
  createdAt: number;
  updatedAt: number;
}

// "locked" is a DERIVED status — not stored in DB
// DB stores only "running" | "completed" in workflowExecution.state column
// "locked" is computed at query time: running + active lock in executionLock table → "locked"
// API responses use: ExecutionStatusResponse = "running" | "completed" | "locked"

interface ExecutionContext {
  variables: Record<string, unknown>;
  nodeStates: Record<string, unknown>;
  executionId: string;
  workflowId: string;
}

interface ExecutionError {
  timestamp: number; // Unix ms
  nodeId: string; // Node where error occurred
  errorType: "validation" | "handler" | "system";
  message: string;
  input?: unknown; // Sanitized input (optional)
}
```

### Node Types (from packages/workflow-engine/src/types/graph-nodes.ts)

```typescript
type GraphNode =
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
  | TeleportNode;

interface StartNode {
  type: "start";
  id: string;
  connections: { default: string };
  initialData?: Record<string, unknown>;
}

interface AgentDirectiveNode {
  type: "agent-directive";
  id: string;
  directive: string;
  completionCondition: string;
  // JSON Schema of the node's local outputs. May carry `globalInputs?: string[]` — names of the
  // registry globals this node writes (inlined into the agent-facing schema, routed to global scope).
  inputSchema?: JSONSchema;
  maxRetries?: number;
  connections: { success: string; error?: string; timeout?: string; maxRetriesExceeded?: string };
}

interface ConditionNode {
  type: "condition";
  id: string;
  condition: StructuredCondition;
  connections: { true: string; false: string };
}

interface TelegramNotificationNode {
  type: "telegram-notification";
  id: string;
  message: string;
  chatId?: string;
  parseMode?: "Markdown" | "HTML";
  replyMarkup?: InlineKeyboardMarkup;
  timeout?: number;
  connections: { default: string; error?: string };
}

interface ExpressionNode {
  type: "expression";
  id: string;
  expressions: string[]; // Array of expressions: "counter = counter + 1"
  connections: { default: string; error?: string };
}

interface EndNode {
  type: "end";
  id: string;
  finalOutput?: string[];
}
```

## Condition System (from packages/workflow-engine/src/types/structured-condition.ts)

### Operators

```typescript
type ConditionOperator =
  | "eq"
  | "neq" // Equality
  | "gt"
  | "gte"
  | "lt"
  | "lte" // Comparison
  | "contains" // String/array contains
  | "exists" // Value exists
  | "and"
  | "or"
  | "not"; // Logical
```

### Structure

```typescript
interface StructuredCondition {
  operator: ConditionOperator;
  left?: ConditionValue; // For binary operators
  right?: ConditionValue;
  conditions?: StructuredCondition[]; // For and/or
  condition?: StructuredCondition; // For not
  value?: ConditionValue; // For exists
}

type ConditionValue = string | number | boolean | null | { contextPath: string };
```

## Template Processing (from packages/workflow-engine/src/templates/)

### Variable Resolution (Actual Code Order)

```typescript
// In GraphTemplateProcessor.processVariableTemplates():
// 1. System variables first: executionId, workflowId
// 2. User variables: context.variables[varName]
```

### Serialization Rules (from safeSerialize method)

```typescript
// undefined/null → "null"
// string → value (no quotes)
// number/boolean → String(value)
// object/array → JSON.stringify with circular reference protection
```

### Template Syntax

- `{{variable}}` - Simple variable
- `{{nested.path}}` - Object property access
- `{{array[0]}}` - Array element access
- `{{array[0].field}}` - Array element with property access
- `{{data[1].items[0].value}}` - Nested array/object combinations
- `{{executionId}}` - System variable
- `{{workflowId}}` - System variable

## Validation (from packages/workflow-engine/src/validation/)

### Unified Validation Architecture

Two-tier validation system with unified error format:

**GraphValidator.validateUnified()** — comprehensive (AJV schema + structural), used by all server-side consumers (MCP tools, API routes, web-backend).

**validateWorkflowUnified()** (shared) — lightweight structural only (no AJV dependency), used by CLI tools.

```typescript
// Unified error format (packages/shared/src/types/validation-types.ts)
interface UnifiedValidationIssue {
  type: "schema" | "structure" | "node" | "connection";
  severity: "error" | "warning";
  nodeId?: string;
  field?: string;
  message: string;
}

interface UnifiedValidationResult {
  valid: boolean;
  issues: UnifiedValidationIssue[];
}
```

### Consumers

- `GraphValidator.validateUnified()` — primary API (returns `UnifiedValidationResult`)
- `GraphValidator.validateWorkflow()` — legacy API (delegates to `validateUnified()`, returns `GraphValidationResult`)
- `WorkflowValidationService` (web-backend) — wraps `validateUnified()`
- MCP `manage` tool "validate" action — uses `validateUnified()` directly
- MCP `manage` tool "create"/"edit" actions — use `validateWorkflow()` (legacy)

### Graph Validation Rules

- **Schema** — AJV JSON Schema validation (types, formats, required fields). Runs first; if fails, structural validation is skipped. Top-level `id` is not required (server-assigned on save; absent in definition files).
- **Required nodes** — Exactly one start node, at least one end node
- **Unique IDs** — All node IDs must be unique
- **Connection targets** — All references must exist
- **Node types** — 9 interactive types (start, end, agent-directive, condition, expression, subgraph, telegram-notification, teleport, lock) + 3 automatic types (read-note, write-note, upsert-note)
- **Unreachable nodes** — Warning for disconnected nodes
- **Node limits** — Max 200 nodes per workflow
- **Subgraph references** — Self-referencing circular dependencies rejected as error
- **Declared-variable references** — Blocking error. Every `{{variable}}` in an agent-directive/teleport `directive` or `completionCondition`, a telegram-notification `message`, and every `contextPath` root in a condition must be one of: a global declared in `variableRegistry`, a `node-id.name` local (root segment is a node id), or a system variable (`executionId`, `workflowId`, `userId`). An undeclared reference fails with: `references undeclared variable '<name>'. Declare it in the workflow variableRegistry or reference a node-local value as 'node-id.name'.`

### Node-Type Semantic Validation

Per-node-type checks that AJV schema cannot perform:

- **ConditionNode** — operator must be in allowed list (eq, neq, gt, gte, lt, lte, contains, exists, and, or, not). Binary operators require `left` + `right`. `exists` requires `value`. Logical operators require non-empty `conditions` array. `not` requires `condition` field. Connections restricted to `true`/`false` only (`additionalProperties: false`). Nested conditions validated recursively.
- **AgentDirectiveNode** — `inputSchema` (if present) must be compilable JSON Schema (validated via AJV compile).
- **Output-scope declaration (AgentDirectiveNode / TeleportNode)** — Blocking errors. Every name in `inputSchema.globalInputs` must exist in the workflow `variableRegistry` (`declares global write '<name>' which is not in the workflow variableRegistry`); a name must not be both a declared global write and a node-local output, i.e. a `globalInputs` name cannot also appear in `inputSchema.properties` (`local output '<name>' shadows the declared global write of the same name`). Non-string `globalInputs` entries are rejected.
- **ExpressionNode** — each expression checked for balanced parentheses and valid characters.

## Web UI Architecture

### Backend (Express - internal port 4201, accessed via nginx proxy)

```typescript
// Routes (from packages/web-backend/src/routes/)
GET    /api/workflows           // List workflows with filtering (search, visibility, sort, limit, offset)
GET    /api/workflows/:id       // Get specific workflow
GET    /api/workflows/:id/raw   // Get raw workflow JSON
POST   /api/workflows/:id/validate // Validate workflow
GET    /api/health              // Health check
GET    /api/status              // System status
```

### Frontend (React - static build served by nginx)

- **Dual-pane layout** - Explorer (30%) + Viewer (70%)
- **React Flow** - Custom node components for visualization
- **Ant Design 5.x** - UI framework
- **TypeScript** - Full type safety

## Error Handling (from packages/workflow-engine/src/types/)

### Error Classification and Logging

MCP tools and API handlers use `isOperationalError()` to select log level:

- **Operational errors** (isOperational=true) → `logger.warn()` — user mistakes, expected failures
  - ValidationError, NotFoundError, AuthenticationError, AuthorizationError, ConflictError, RateLimitError
- **Programmer errors** (isOperational=false) → `logger.error()` — bugs, infrastructure failures
  - InternalError, DatabaseError, ConfigurationError, ExternalServiceError

```typescript
const appError = normalizeError(error);
const logLevel = isOperationalError(appError) ? "warn" : "error";
logger[logLevel]("Failed to X", appError, {
  code: appError.code,
  isOperational: appError.isOperational,
});
```

### Completed Workflow Handling

`executeStep()` checks execution status before processing. When status is `completed`:

- Queries `findActiveChildExecutions(parentExecutionId)` for child workflows with status running/waiting
- Throws `ValidationError` (isOperational=true → WARN) with message:
  - "Workflow already completed. Active child workflow: {processId}"
  - "Workflow already completed. No active child workflows."

### Locked Execution Handling

`executeStep()` checks for active locks before processing. When execution has an active lock:

- Queries `lockService.findActiveLock(executionId)` to check for active locks
- Only blocks locks created by agents (source: "agent"); locks from workflow lock nodes pass through
- Throws `ValidationError` with message: "Execution is locked: {reason}. Unlock via lock tool with PIN."
- Agent must use the `lock` MCP tool with action `unlock` and correct PIN to proceed

### Node Results

```typescript
interface NodeExecutionResult {
  action: "pause" | "continue" | "complete" | "error";
  data?: Record<string, unknown>;
  outputPath?: string;
  error?: string;
}
```

### Validation Errors

```typescript
// Step execution input validation (packages/workflow-engine/src/types/)
interface ValidationError {
  field: string;
  expected: string;
  received: string;
  message: string;
}

// Workflow structural validation (packages/shared/src/types/validation-types.ts)
// See "Unified Validation Architecture" section above
```

## Handler Behavior (Code Facts)

### StartNodeHandler

- **Auto-execution** - immediately continues to next node
- **Data merge** - combines initialData + input into context

### AgentDirectiveHandler

- **Pause behavior** - pauses for user input when no input provided
- **Retry logic** - maxRetries (default: 3) with validation
- **Template processing** - processes directive and completionCondition

### ConditionHandler

- **Auto-execution** - immediately evaluates and continues
- **Output paths** - 'true' or 'false' based on condition result
- **Context access** - resolves contextPath references

### TelegramNotificationHandler

- **Auto-execution** - sends message and continues
- **Template processing** - processes message templates
- **Inline keyboard support** - passes `replyMarkup` (InlineKeyboardMarkup) to Telegram API as `reply_markup`
- **System footer** - appends process ID, resolved workflow name, and branding to each notification
- **Workflow name resolution** - resolves workflowId UUID to human-readable name via repository with fallback
- **Graceful degradation** - continues workflow on send failures
- **Actionable error messages** - pushes classified error guidance to messageQueue (invalid token, chat not found, rate limit, etc.)
- **Error classification** - uses `getActionableTelegramErrorMessage()` and `classifyTelegramError()` from `telegram-types.ts`

### Telegram Webhook (Callback Query Handling)

Public endpoint `POST /api/telegram/webhook` handles inline keyboard button presses:

- **Callback data parsing** - `parseApproveCallback()` extracts execution prefix (8 hex chars) and node prefix (1-12 alphanum chars)
- **Defense-in-depth** - Parser regex validation → repository LIKE sanitization → webhook secret header validation
- **Secret-before-mutation** - `findActiveLockByPrefix()` (read-only) → validate `X-Telegram-Bot-Api-Secret-Token` → then `unlockByApproval()`
- **Lock operations** - `unlockByApproval()` sets status "unlocked" with `method: "telegram_approval"` audit trail
- **Auto webhook registration** - All bot token save paths generate 32-byte secret + call `setWebhook(url, secret)`
- **Double-click safety** - Second press finds lock no longer active → `LockNotActiveError` → `{ok: true, error: "lock_not_active"}`

### ExpressionNodeHandler

- **Auto-execution** - evaluates expressions and continues
- **Sandboxed parser** - custom arithmetic parser, NOT JavaScript eval
- **Operations** - `+`, `-`, `*`, `/`, parentheses
- **Assignment** - `result = a + b`, context path access
- **Error handling** - division by zero and undefined variables route to `error` connection
- **Counter management** - expression nodes handle all loop counter increments; agent-directive nodes must not manage counters

### Bounded Loop Pattern

All workflow cycles require explicit bounds using expression + condition node pairs:

```
expression node: ["counter = counter + 1"]  →  condition node: counter < max_counter
                                                  true → continue loop
                                                  false → ask-user-limit-reached
```

**CRITICAL: When limit exceeded (false branch), the workflow MUST ask the user** what to do via an agent-directive node with options:

- `continue` — accept current result as-is despite unresolved issues
- `reset` — reset iteration counter to 0 and retry the fix loop
- `accept` — approve and proceed to next phase

The `reset` option routes to an expression node that resets the counter, then loops back to the fix step. The `continue`/`accept` options route to the next phase (the original escape target).

**Anti-pattern:** Routing the false branch directly to the next phase (silently skipping the fix loop) — this removes user control and hides unresolved issues.

- Counters use `expressions` array (not `expression` string)
- Condition nodes use `contextPath` (not `variablePath`)
- Each loop has its own independent counter variable
- See also: Escalation pattern in `packages/landing-page/src/content/docs/docs/patterns/escalation.mdx`
- Anti-pattern documentation: `packages/landing-page/src/content/docs/docs/patterns/anti-patterns.mdx`

### EndNodeHandler

- **Auto-execution** - collects final data and completes
- **Data collection** - finalOutput array or all context variables

## Security Middleware

### Rate Limiting

```typescript
// packages/web-backend/src/middleware/rate-limit.ts
import rateLimit from "express-rate-limit";

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per window
  message: { error: "Too many requests" },
});

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 MCP requests per minute
});
```

### Data Size Validation

```typescript
// Workflow size: max 5MB
// Execution context: max 10MB
// Returns 413 Payload Too Large on exceeded limits
```

### GeoIP Logging

```typescript
// packages/shared/src/logging/express-middleware.ts
import geoip from "geoip-lite";

const geo = geoip.lookup(clientIp);
logger.info("Request", {
  method: req.method,
  path: req.path,
  ip: clientIp,
  country: geo?.country || "Unknown",
  duration: Date.now() - startTime,
  status: res.statusCode,
});
```

## Metrics Infrastructure

### Prometheus Metrics Module

```typescript
// packages/shared/src/metrics/index.ts
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

// Singleton registry for all metrics
export const metricsRegistry = new Registry();

// Pre-configured HTTP metrics
export const httpRequestsTotal: Counter; // http_requests_total{method, route, status}
export const httpRequestDuration: Histogram; // http_request_duration_seconds{method, route}

// Factory functions for custom metrics
export function createCounter(name: string, help: string, labels?: string[]): Counter;
export function createGauge(name: string, help: string, labels?: string[]): Gauge;
export function createHistogram(
  name: string,
  help: string,
  labels?: string[],
  buckets?: number[],
): Histogram;
```

### Route Normalization

```typescript
// Prevents high-cardinality labels in metrics
export function normalizeRoute(path: string): string;

// Examples:
// /api/users/550e8400-e29b-41d4-a716-446655440000 → /api/users/:id
// /api/items/12345 → /api/items/:id
// /api/tokens/abc123_def456-ghi789_jkl012-mno345pqr → /api/tokens/:token
```

### Metrics Server

```typescript
// Internal metrics server on port 9090
export function startMetricsServer(port?: number): Promise<http.Server>;

// Endpoints:
// GET /metrics  - Prometheus format metrics
// GET /health   - Health check (used by Docker HEALTHCHECK)
```

### Docker Integration

```yaml
# config/Dockerfile
EXPOSE 80 9090
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:9090/health || exit 1

# config/docker-compose.production.yml
labels:
  - "prometheus.scrape=true"
  - "prometheus.port=9090"
  - "prometheus.path=/metrics"
networks:
  - traefik
  - monitoring
```

### Integration

```typescript
// packages/web-backend/src/server.ts
import { metricsMiddleware, startMetricsServer } from "@mcp-moira/shared";

// First middleware in chain
app.use(metricsMiddleware);

// Start internal metrics server
await startMetricsServer(9090);
```

### Business Metrics

```typescript
// packages/shared/src/metrics/index.ts

// Workflow metrics
export const workflowExecutionsTotal: Counter; // moira_workflow_executions_total{status, workflow_id}
export const workflowStepDurationSeconds: Histogram; // moira_workflow_step_duration_seconds{workflow_id, node_type}
export const activeExecutionsGauge: Gauge; // moira_active_executions

// MCP metrics
export const mcpToolCallsTotal: Counter; // moira_mcp_tool_calls_total{tool, status}

// Audit metrics
export const auditActionsTotal: Counter; // moira_audit_actions_total{action, resource}
```

Integration points:

- `UniversalGraphExecutor`: workflow execution start/complete/fail/cancel
- `GraphExecutionEngine`: step execution timing
- `ToolRegistry`: MCP tool call tracking
- `AuditLogger`: audit event counting

## Admin Features

### Admin API Routes

```typescript
// packages/web-backend/src/routes/admin.ts
GET    /api/admin/users                    // List all users
GET    /api/admin/users/:id                // Get user details
POST   /api/admin/users/:id/block          // Block user
POST   /api/admin/users/:id/unblock        // Unblock user
POST   /api/admin/users/:id/send-verification  // Send verification email
POST   /api/admin/users/:id/send-reset     // Send password reset email
DELETE /api/admin/users/:id/sessions       // Revoke all sessions
GET    /api/admin/emails                   // List sent emails
GET    /api/admin/executions               // List all executions
GET    /api/admin/executions/:id           // Get execution details
GET    /api/admin/stats                    // System statistics
```

### Admin Middleware

```typescript
// packages/web-backend/src/middleware/admin-middleware.ts
export const requireAdmin = async (req, res, next) => {
  const user = req.user;
  if (!user?.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};
```

## Email Service

### Email Provider Interface

```typescript
// packages/shared/src/email/email-service.ts
interface EmailProvider {
  send(options: EmailOptions): Promise<EmailResult>;
  getName(): string;
}

interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
```

### Email Logging

```typescript
// packages/shared/src/database/schema.ts
emailLog: {
  id: string;
  userId: string;
  type: 'verification' | 'password_reset' | 'notification';
  to: string;
  subject: string;
  messageId: string;
  status: 'sent' | 'failed';
  error?: string;
  createdAt: string;
}
```

### API Token Storage

```typescript
// packages/shared/src/database/schema.ts
apiToken: {
  id: string;
  name: string;
  tokenPrefix: string; // First 12 chars for display (e.g., "moira_a1b2c3")
  tokenHash: string; // SHA-256 hash (plaintext never stored)
  userId: string; // FK to user.id with CASCADE delete
  scopes: string | null; // JSON array, null = full access
  expiresAt: string | null; // ISO timestamp, null = never
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}
// Indexes: unique(tokenHash), idx(userId), idx(expiresAt)
// Token format: moira_ + 40 hex chars (160-bit entropy)
```

### User Token API Routes

```typescript
// packages/web-backend/src/routes/tokens.ts
POST   /api/tokens      // Create token (returns plaintext once, requireVerifiedAuth)
GET    /api/tokens       // List user's tokens (metadata only, no secrets)
DELETE /api/tokens/:id   // Revoke token (soft delete, idempotent)
// Auth: requireVerifiedAuth (email must be verified)
// Limit: 25 active tokens per user

// packages/web-backend/src/routes/admin-tokens.ts
GET    /api/admin/tokens      // List all tokens with user info (search, filter, paginate)
DELETE /api/admin/tokens/:id  // Admin revoke any token (soft delete, idempotent)
// Auth: requireAdmin
// Query: userId, status (active/expired/revoked), search, sort (createdAt/lastUsedAt/name), sortOrder, limit, offset
```

### Better Auth Email Callbacks

```typescript
// packages/shared/src/auth/better-auth-config.ts
emailAndPassword: {
  sendResetPassword: async ({ user, url }) => {
    await sendEmail(user.id, 'password_reset', {
      to: user.email,
      subject: 'Reset your password - MCP Moira',
      text: `Click to reset: ${url}`
    });
  }
},
emailVerification: {
  sendOnSignUp: true,
  sendVerificationEmail: async ({ user, url }) => {
    await sendEmail(user.id, 'verification', {
      to: user.email,
      subject: 'Verify your email - MCP Moira',
      text: `Click to verify: ${url}`
    });
  }
}
```

## Session Info Tool

### session

Action-based tool for session-related information.

```typescript
// Parameters
{
  action: 'user' | 'executions' | 'execution_context' | 'current_step' | 'update-note';
  executionId?: string;  // Required for execution_context, current_step, update-note
  note?: string;         // Required for update-note (max 500 chars)
}

// action: 'user' - Returns authenticated user information
{
  email: string;
  name: string | null;
}

// action: 'executions' - Returns user's active executions with filters
// Parameters: status?, workflowId?, search?, sort?, sortOrder?, limit?, offset?
{
  executions: [{
    executionId: string;
    workflowId: string;
    workflowSlug: string;         // Human-readable workflow identifier
    workflowOwnerHandle: string;  // Workflow owner's handle
    status: 'running' | 'completed' | 'locked';  // "locked" = running + active lock
    currentNodeId: string;
    note?: string | null;
    parentExecutionId?: string | null;
    createdAt: string;   // ISO 8601
    updatedAt: string;   // ISO 8601
    completedAt?: string; // ISO 8601
    errorCount?: number; // Number of errors in errors array
  }];
  total: number;
}

// action: 'execution_context' - Returns full execution state
{
  executionId: string;
  workflowId: string;
  workflowSlug: string;         // Human-readable workflow identifier
  workflowOwnerHandle: string;  // Workflow owner's handle
  status: 'running' | 'completed' | 'locked';  // "locked" = running + active lock
  currentNodeId: string | null;
  waitingForInputNodeId: string | null;
  errors?: ExecutionError[]; // Persistent error log
  note?: string | null;
  context: {
    variables: Record<string, unknown>;
    nodeStates: Record<string, unknown>;
  };
  createdAt: string;     // ISO 8601
  updatedAt: string;     // ISO 8601
  completedAt?: string;  // ISO 8601
  error?: string;
}

// action: 'current_step' - Returns current workflow step directive
string  // Formatted step directive

// action: 'update-note' - Updates execution note
{
  success: boolean;
  executionId: string;
  note: string;
}
```

## List Workflows Tool

### list

List workflows with filtering, sorting, and pagination.

```typescript
// Parameters
{
  search?: string;           // Search in name and description
  visibility?: 'public' | 'private' | 'all';  // Default: 'all'
  sort?: 'createdAt' | 'name';  // Default: 'createdAt'
  sortOrder?: 'asc' | 'desc';   // Default: 'desc'
  limit?: number;            // 1-100, default: 20
  offset?: number;           // Default: 0
}

// Response
{
  workflows: Array<{
    id: string;
    slug: string;              // Human-readable workflow identifier
    ownerHandle: string;       // Workflow owner's handle
    name: string;
    version: string;
    description: string;
    visibility: 'public' | 'private';
    createdAt: string;  // ISO 8601
  }>;
  total: number;
}
```
