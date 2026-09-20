# System Reference

## Core Architecture

### Graph Execution Engine

- **UniversalGraphExecutor** - Main workflow processor
- **Node Handlers** - Type-specific processors for the `GraphNode` union, including pausing,
  branching, automatic, notification, locking, and materialization nodes
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

### Shared Revision Store

Versioned content belongs to one store rather than to each entity that keeps a history. Notes, global
settings and any future versioned entity write their content as revisions of `entityRevision`
(`packages/shared/src/database/repositories/revision-repository.ts`).

```typescript
append({ entityType, entityId, content, authorId?, maxRevisions? }): Promise<Revision>;
latest(target): Promise<Revision | null>;
get(target, revision): Promise<Revision | null>;
list(target, { previewChars? }): Promise<RevisionSummary[]>;   // newest first, preview not content
compare(target, from, to): Promise<{ from; to; parts } | null>; // line-level, null if one is gone
deleteHistory(target): Promise<void>;
totalSize(target): Promise<number>;
```

Consumers today: notes, global settings and playbooks.

Rules a consumer has to know:

- **Revisions are appended, never rewritten.** `append` derives the number from the highest stored
  one, so a pruned tail never causes a reused number. Putting a past value back in force is a new
  revision carrying the old content, not a rewind.
- **Retention belongs to the consumer.** `maxRevisions` drops the oldest revisions beyond the limit;
  omitting it keeps every revision. A note keeps the limit configured for notes, an administrative
  setting keeps a shorter tail.
- **Absent content is not empty content.** `content` may be null, which records an entity that had
  no content at all — a global setting with no value falls back to its default while an empty one
  does not.
- **The owner deletes its own history.** `entityRevision` deliberately carries no foreign key to the
  owning row, because one store serves entities in different tables. Nothing cascades: whoever hard
  deletes an entity calls `deleteHistory` for it in the same operation.
- **Reading a revision distinguishes two absences.** `get` and `compare` return null when the
  revision is unknown or already pruned; a revision that exists with null content is a different
  answer.

### Replay-safe execution mutations

`start({ action: "prepare" })` resolves authorization, workflow version and digest, parent reference,
note, and the requested notification-skip policy into a server-issued Start attempt without creating
an execution. Prepared attempts expire after 15 minutes and are bounded per user. Executing the
attempt revalidates mutable workflow, parent, account, lock-delivery, and communication preconditions,
then reserves its Process ID before graph work and atomically persists the execution with the exact
response receipt. Replays of the same attempt return that receipt; separately prepared attempts
intentionally create separate executions.

Every paused agent-facing presentation has a server-issued `attemptId` bound to its user,
execution revision, node, workflow, and the run's continuation surface (described below). `step()`
requires that identity in addition to the Process ID. The repository claims the attempt before any handler or graph effect in
an immediate transaction, records a fingerprint of `input` plus `teleportTo`, and fences the owner
with a monotonically increasing token. The worker opens one lease handle with an immediate
compare-and-set renewal; a five-second heartbeat then renews the 30-second lease.

Materialize and progress-image grants bind context-derived content to an independent context
revision as well as their execution/node or workflow-step constraints. Metadata changes therefore
do not masquerade as step transitions, while a URL cannot render different context after issuance.

The execution revision is the workflow-step generation. It advances only when an original `step`
persists workflow state; receipt replay and session mutations such as note, parent, reminder, or
runtime-variable changes do not advance it or invalidate the presented attempt. Those mutations
guard the field or stored snapshot they actually change with independent opaque parent, context,
and reminder revisions returned by the corresponding read and mutation surfaces.

A person may answer the waiting step from the run page (`POST /api/executions/:id/answer`). That
runs the step without an attempt: the execution's compare-and-set save guards it, the accepted
values are recorded as an adjustment visit with the acting user, and the presented attempt the
agent was holding is marked `superseded` and linked to the presentation created for the new node.
A superseded attempt is stale on `step` (never replayed), is not the current attempt, and is
evicted with old receipts; the answer is refused while an attempt is executing or outcome-unknown.

For a paused execution with no persisted Step attempt, `current_step` atomically installs one without
executing the node. A presented attempt whose node and continuation
bindings still match can be rebound from an obsolete revision and returned as the authoritative
current attempt. Executing, `outcome_unknown`, node-stale, and continuation-stale attempts are not
rebound. `current_step` reports such a live presentation as `CURRENT_PRESENTATION_STALE` and never
recommends its unusable attempt ID; the error names `diagnose`, which reports which facts of the
paused step changed.

`diagnose` answers, for one owned execution, whether the run can still continue and every reason it
cannot: the execution is not running or has no current node; the workflow definition is gone or no
longer readable; the paused node no longer exists; the attempt is foreign, carries no continuation
binding, or is not in the presented state; the execution moved on past its presented attempt; the
continuation surface changed, naming the facts that changed, disappeared or appeared; the presented
step interpolates references the context cannot resolve; the execution recorded an error. The
references are read off everything the paused node presents through, which differs by type — an
`agent-directive` presents its directive and completion condition, a `materialize` node its base
path and file paths, a `lock` node its reason — so a target is not accepted on the strength of
fields it does not have.

Each cause carries `blocks`, and `continuable` is true when none of them does. A blocking cause
means the run cannot reach its next `step()` without repair, and is what makes it eligible for
recovery. A non-blocking cause explains what the caller is seeing while the run remains usable,
either directly or after an ordinary `current_step` refresh: a missing presentation, a
revision-stale presentation, an attempt another caller is executing, an unresolved reference in the
presented text, and a recorded error. Errors in particular are append-only and are written by the
engine's own retry path when an agent answers with the wrong shape, so treating one as blocking
would mark every run that ever had a rejected answer permanently unrepairable. Naming the changed facts is possible because the attempt
stores the fact map its digest is computed from — one digest per bound fact — so a mismatch can be
attributed rather than only detected; an attempt written before that map existed reports the
mismatch as unattributable instead of inventing an attribution. The action is read-only, audited
like `current_step`, and is allowed on a healthy run, which reports itself continuable with no
causes.

`recover` returns a run that cannot continue to a step it can resume from. The node the caller names
must be one a run can wait on — `agent-directive`, `teleport`, `materialize`, `lock` or `subgraph`;
any other node is refused, because resuming "at" a node that never holds a presentation would mean
running the workflow forward from there and calling it a repair. It moves the execution to
that node, merges the supplied variable values into the context, and installs a fresh attempt bound
to the current definition — so the caller's next call is an ordinary `step()`. The run then comes to
rest on the named node and never advances past it. That is not the same as nothing running: the
target node's own presentation path executes, which is inert for an `agent-directive`, a `teleport`
and a `materialize` node but not for the other two — resuming at a `lock` node creates the lock and
dispatches its approval code, and resuming at a `subgraph` node with no active child enters one.
Both are what those nodes do when a run arrives at them, and choosing either as a recovery target is
choosing that effect.

The gate asks two separate questions. A run the engine no longer considers live is refused before
anything else is read: a completed run is history and a cancelled run is the owner's instruction to
stop — cancellation is stored as completion, so the two are one state — and returning either to
`running` at an operator-named node would be resurrection rather than repair. The refusal names the
run's status, and `diagnose` still explains why such a run cannot continue, because refusing the
mutation must not cost the explanation. Status is never read as evidence that a run is or is not
broken; that judgement stays where it was.

Among live runs, a run is eligible only when `diagnose` reports at least one blocking cause, so the
gate and the explanation are the same judgement. A healthy run is refused, as is a run whose only
causes are non-blocking; every refusal leaves the execution, its attempt and its revision untouched
and names the calls that follow. The move and the retirement of the attempt the run was holding commit in one
transaction, guarded on the execution's revision and its expected prior state, and refuse outright
while an attempt is being executed or its outcome is unknown. The fresh attempt is installed by that
same transaction rather than by the presentation that follows, so a failure while rendering leaves
the run at its target holding an attempt whose response is still null, and the run never waits on a
node with no attempt — a state no call could leave, since presenting the
current step refuses an execution whose waiting and current nodes disagree and stepping needs an
attempt id. Both outcomes are audited as `EXECUTION_RECOVER`: a successful recovery with the target node and
the variable names written, a refusal with the reason and the node that was asked for.

A paused step attempt is bound to its execution revision, its node, its workflow and a digest of the
run's **continuation surface**: everything the paused node declares, minus the inherited fields that
describe how it is displayed rather than what it does — `metadata` (display name, description, icon,
colour, tags, estimated duration), `progressNodeId`, `progressActiveLabel`, `progressActiveContent`
and `connectionLabels` — together with the `variableRegistry` entries for the global names that node
declares as inputs, which the engine inlines into the schema the agent is validated against.

The surface is defined by exclusion because any node type can be the one a run is paused on:
`agent-directive`, `teleport`, `materialize`, `lock` and `subgraph` pause deliberately, an extension
node pauses on itself when its call fails, and a node error pauses on that node whatever its type.
So a `materialize` node's `basePath` and `files`, a `lock` node's `reason`, a `subgraph` node's
`graphId` and mappings, and an extension node's `config` are all bound — for those nodes they are
the directive.

The workflow version and a digest of the whole definition are recorded on the attempt for diagnosis
but do not bind a step: a definition change invalidates a paused run only when it reaches that
surface. A redeploy that changes workflow `metadata` (version, tags, name, description), the
`systemReminder`, the progress projection, or any node the run is not paused on leaves the run
continuable, as does a purely cosmetic edit to the paused node itself. An attempt carrying no
continuation binding never matches. Start attempts are bound to the whole definition instead,
because a start is about to execute all of it.

For an executing prepared Start, that handle opens immediately after the atomic claim and before
lifecycle metrics, audit, execution reads, or graph work. The same handle remains active through
attempt finalization and is passed into the executor rather than replaced by a second timer.
Immediately before graph traversal, the executor renews and verifies the current owner and fence;
failure prevents that worker from entering any node handler or provider effect.

Execution state, the completed replay receipt, and the next presented attempt are committed in one
transaction. Replaying the same attempt with the same fingerprint returns the exact stored response;
a different fingerprint, user, execution state, or stale presentation is rejected. Concurrent
duplicates wait up to ten seconds for the first owner's receipt and otherwise return
`ATTEMPT_PROCESSING`. If ownership or durable outcome cannot be proven, the attempt becomes
`outcome_unknown` and is never automatically executed again. `ATTEMPT_STALE` is rejected before
handler work and directs the caller to refresh `current_step` automatically; it does not require a
human recovery decision. `ATTEMPT_CONFLICT` also rejects before handler work because the attempt is
already bound to different input. The caller refreshes `current_step`, discards the conflicting
presentation, and follows the returned directive and schema rather than replaying the rejected
input. A step-level `ATTEMPT_INVALID_OR_EXPIRED` that explicitly directs the caller to
`current_step` uses the same recovery; an unavailable start attempt does not. Outcome-unknown
inspection never authorizes an automatic mutation retry.

Startup and recurring maintenance fence expired executing attempts every ten seconds. Completed
receipts remain available for seven days, with at most 1,000 retained per execution, and cleanup runs
every ten minutes. Attempt audit and Prometheus records contain bounded classification metadata, not
workflow input or response content.

Recurring reconciliation returns separate bounded Start and Step counts. Maintenance maps them to
the corresponding `operation` label, so an expired Start lease is never reported as a Step outcome.

An indeterminate start stays attached to its reserved Process ID and appears through session
inspection instead of becoming an orphan. Only its owner can cancel it, and cancellation requires
the current execution revision so a stale recovery action cannot remove newer work.

### Bundled Workflow Reconciliation

Bundled workflows use three exact states: the last accepted upstream baseline, the current instance
state, and the incoming catalog state. Semantic versions control ordering but never establish
identity or ancestry. Canonical state digests cover lifecycle, visibility, and graph content using
the same normalization as reconciliation equality.

Unresolved two-sided changes persist all candidates and a revision. A resolution advances the
baseline to the accepted incoming state and records the selected result, exact digests, bounded
rationale, and residual representation delta; the delta informs later semantic review and is not an
automatic merge authorization. Ordinary resolution requires the exact revision inspected by the
decision maker. Staged reconciliation serializes only revision-bound decisions and
merged states from an isolated snapshot. Application recomputes the complete conflict set against a
distinct fresh database and applies one transaction only when source identity, catalog digest,
conflict-set digest, and every revision still match. The staged artifact never transports or
replaces the database snapshot.

Self-host recovery persists a separate `data/.moira-reconciliation/pending` directory before the
startup guard restores the coherent database. Initialization then stops the container successfully,
preventing both service exposure and an automatic restart loop; the bounded Compose restart policy
still retries unexpected nonzero container crashes. Candidate files and the manifest are immutable.
The guard renders reconciliation instructions only when its current child initialization created
the attempt-scoped reconciliation marker after publishing the bundle; entrypoint/guard startup clears
that marker, and direct migration invocations never create it, so a hard failure cannot inherit
classification from an older pending bundle.
CLI `choose` atomically accumulates revision-bound decisions only in `decisions.json`; it never mutates
SQLite. CLI `apply` requires a decision for the complete conflict set, recomputes the actual bundled
catalog against the restored database and applies one transaction. After commit it atomically
retires the pending directory and cleans it best-effort. A retirement/cleanup warning describes a
committed database with pending or retired local cleanup; it never claims rollback. Before retirement
the CLI persists `applied.json` with the committed artifact digest, so a repeated apply performs only
idempotent cleanup and never replays the semantic decision. A plain subsequent
`docker compose up -d` starts the stopped container and may also finish that cleanup. No HTTP, MCP,
UI, or token transport participates in this image-upgrade recovery path.

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
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless - no session storage
});

// HTTP endpoints
// POST /mcp — JSON-RPC 2.0 requests
// GET /health — server health status

// Catalog revision gate (after credential validity and account admission)
// Matching OAuth/API-token toolsVersion → ordinary request proceeds
// Missing/stale toolsVersion + ordinary request → HTTP 426 Upgrade Required
// Missing/stale toolsVersion + valid singleton initialize → exact credential is stamped before
// the successful initialize result is emitted
// OAuth refresh → successor token row inherits the predecessor's exact toolsVersion
```

`tool-schemas.ts` owns side-effect-free canonical Zod schemas. `tool-definitions.ts` is the pure
catalog that associates each public name with its static default and agent/model description
variants, schema, response policy, validated examples, localized factual metadata, reference model,
and deterministic revision. `tool-bindings.ts` separately binds every catalog identity to its lazy
runtime handler. `register-tools.ts` combines them through the reconciliation-aware SDK wrapper and
publishes `tools/list` from the same typed projection. Every published tool schema is a root object,
which keeps the complete catalog discoverable in MCP clients that do not support a root
`anyOf`/`oneOf`. A handler may apply a narrower action-specific schema after SDK validation; `start`
uses a flat public object schema and then validates the exact `prepare` or `execute` branch with its
strict discriminated request schema, and the `codespace` tool publishes one flat object carrying
`action` plus every action's fields (only `action` required), then applies that action's own strict
request contract at dispatch, so a mixed stdin form, a partial resume call or a field belonging to
another action is rejected there as `CODESPACE_REQUEST_INVALID`. A default declared by an action is
applied by that contract and is deliberately absent from the published object, which would otherwise
inject every action's defaults into every request. Where two actions declare the same field name with
different bounds — `search` and `download` both take `max_bytes` — the published object carries both
forms under that one key, so neither action's parameter is narrowed by the projection; the action's
own contract decides which form the request had to match. Validation failures at either boundary are returned as MCP
errors. Server bootstrap does not repeat names, schemas, actions, or descriptions. Tool descriptions
are not stored or overridden in `globalSetting`; database-backed system prompts remain a separate MCP
`instructions` channel.

The same structured reference model renders `help({ topic: "tools" })` and the English and Russian
public reference pages directly. `MCP_TOOLS_REVISION` is computed once from stable client-visible
contract facts in the MCP package. New OAuth authorizations and persistent API tokens begin without
an accepted catalog revision. OAuth refresh rotates the access-token row and makes its successor
inherit the predecessor's exact current, stale, or null revision before the token response is
exposed. After authentication and account admission, the MCP server permits a missing/stale
credential to run one SDK-valid singleton `initialize` request and conditionally stamps only that
credential immediately before forwarding its successful result.
Errors, notifications, malformed requests, batches, revoked/expired credentials, and denied accounts
cannot stamp acceptance. Ordinary missing/stale requests receive HTTP 426; matching credentials
proceed without token rotation. Package version remains diagnostic release identity and is not the
catalog invalidation input. The public docs package consumes the pure MCP contract through its
`tool-contract` export during Astro build; no generated revision or tool-reference copy must be
refreshed. See the [public MCP tools reference](../packages/docs/src/content/docs/docs/reference/tools.mdx)
for the direct catalog and action-specific behavior.

Non-`tools` runtime help topics are owned by the MCP package under
`packages/mcp-server/src/help/content/`. Runtime discovers topic IDs and metadata from the English
semantic Markdown and reads the same sources that the English and Russian public MDX shells import
through the `help-content` package export. Quick start and MCP clients compose authored before/after
sections with client setup; agent instructions compose its authored section with the existing system
prompt. The no-argument topic catalog adds the special `tools` entry from MCP-owned contract metadata,
and that topic renders directly from the typed tool contract rather than a Markdown copy.
Presentation-only Astro components remain in the shells, and runtime never parses or removes MDX/JSX.

The `communication` MCP tool uses the same authenticated request context as every other tool. Text
delivery calls the process-wide `UserCommunicationService` directly. Attachment minting stores only
a SHA-256 digest of a five-minute grant with its owner, portable message metadata, exact media
policy, correlation ID, purpose, audience, expiry, and claim state. The raw grant is returned once.

`POST /api/communication/attachments` runs in the MCP process before the JSON body parser. It first
authenticates an OAuth or persistent MCP Bearer credential through the shared principal resolver,
then atomically claims a pending grant for that user. Required length and MIME headers, process-local
per-user buffer admission, exact byte count, and PNG/JPEG signatures are checked before the common
delivery service is invoked. Pre-provider failures release the claim; any provider attempt completes
it terminally. Accepted bytes exist only in the bounded request buffer and are released on every exit.
The nginx `location = /api/communication/attachments` routes raw bodies to this MCP handler with
request buffering disabled rather than through the web backend's broad `/api/` proxy.

Every tool is registered through one wrapper. A failure that escapes the tool is recorded with the
tool name, classified as the project classifies failures at a boundary, and only then converted into
the sanitized agent-facing message, so a suppressed message is never the only trace of a failure.
The `reconciliation` tool answers its own failures and records them the same way.

The `codespace` tool follows the same registry path. `manage-codespaces.ts` is a presentation
adapter over the exported `@mcp-moira/web-backend/services` composition (never the web server or
routes): the tenant comes from the request context, results are projected field by field, known
domain failures become bounded tool errors, and unexpected failures are logged with the tool name
and opaque IDs only. Both native file references are declared on that one tool through registry
`_meta["openai/fileParams"]`,
which participates in `MCP_TOOLS_REVISION`. The MCP process and the tools share one
`CodespaceTransferService` from that composition; `GET /api/codespaces/transfers/:token` delivers a
published download once, and both nginx variants proxy `location ^~ /api/codespaces/transfers/` to
the MCP process unbuffered with access and error logging disabled because the path carries the
capability. Request-context logging for this tool records only the requested action and UUID-validated
codespace/operation IDs; an absent or malformed action reads as `unknown`, because the record is
written before the action is validated. The shared `CodespaceObservabilityService` computes one readiness
decision for the website, administration, backend health, MCP health and the `codespace` tool's
`list` action;
the unauthenticated `/api/health` and MCP `/health` surfaces carry only its public projection
(`state`, `provider`, `degraded`) from a cached snapshot with a two-second bound on the connector
probe, and both processes refresh their codespace gauges on the reconciliation interval. See `docs/CODESPACES.md` for the contract.

Each communication adapter also supplies provider-safe presentation metadata through the same
registry: title, origin, exact setting keys, optional enable key/help link, extension identity and
trusted-delivery declaration. `GET /api/notifications/channels` evaluates those adapters with only
the authenticated user's repository-backed configuration and projects sanitized
`ready|disabled|incomplete|unavailable` state. `POST
/api/notifications/channels/:channelId/test` accepts no body and invokes the registry-selected
adapter through `UserCommunicationService.testChannel()`, retaining shared limits and result
normalization without ordinary fan-out. Administrator trust approval is read-only in this user
projection and remains writable only through the admin boundary.

`renderPortableHelpTokens()` in `packages/shared/src/utils/portable-help.ts` is the shared resolver
for configured MCP, Moira and static-artifact URLs and MCP client deeplinks. The MCP runtime applies
it to complete Markdown, and the Astro remark adapter applies the same function to Markdown values
and links. `packages/mcp-server/src/help/client-presentation.ts` derives localized setup from the
canonical shared client registry and its configuration, token and deeplink generators; runtime
Markdown and `ClientSetupTabs.astro` consume that projection directly. The Docker runtime carries the
MCP-owned help corpus and the existing checked-in default system prompt; public MDX is compiled only
into the static documentation site.

### Enhanced Input Parsing

step() supports multiple input formats:

```typescript
// Object input (standard)
{"processId": "abc-123", "attemptId": "attempt-current", "input": {"name": "John", "age": 30}}

// Direct object without wrapper
{"processId": "abc-123", "attemptId": "attempt-current", "input": {"name": "John", "age": 30}}

// Single quotes (user-friendly)
{"processId": "abc-123", "attemptId": "attempt-current", "input": "{'name': 'John', 'age': 30}"}

// Unquoted keys (JavaScript style)
{"processId": "abc-123", "attemptId": "attempt-current", "input": "{name: 'John', age: 30}"}

// Mixed quotes
{"processId": "abc-123", "attemptId": "attempt-current", "input": "{name: \"John\", 'age': 30}"}

// Escaped JSON string
{"processId": "abc-123", "attemptId": "attempt-current", "input": "\"{\\\"name\\\": \\\"John\\\"}\""}

// Legacy params.input structure (backward compatibility)
{"processId": "abc-123", "attemptId": "attempt-current", "params": {"input": {"name": "John"}}}
```

### JSON Auto-Parsing for All MCP Tools

All MCP tool `inputSchema` fields with `z.object()`, `z.array()`, or `z.record()` types are wrapped with `z.preprocess()` to automatically parse stringified JSON before Zod validation. This handles the Claude Code serialization bug where JSON objects arrive as strings.

```typescript
// Implementation: packages/mcp-server/src/utils/flexible-json-parser.ts
// Applied in: packages/mcp-server/src/tools/register-tools.ts via wrapSchemaWithAutoparse()

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
  attemptId: "attempt-current",
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
step({ processId: "abc-123", attemptId: "attempt-current", teleportTo: "replan-node" });
```

- Only `teleport`-type nodes can be targets
- Execution context (all variables) is preserved
- Teleport node presents its own directive on the next step
- Error: `ValidationError` if target doesn't exist or is not a teleport node
- When workflows contain teleport nodes, hints are appended to every step response

### Notification and Lock Pre-flight Checks

`start({ action: "execute" })` re-resolves a prepared workflow without creating an execution unless its mutable preconditions pass:

- A workflow with `user-notification` nodes returns channel-neutral Settings guidance when the current user has no configured communication adapter.
- A workflow with legacy `telegram-notification` nodes checks only the built-in Telegram adapter and returns Telegram setup guidance when it is unavailable.
- A workflow with a `lock` node always requires a valid-shaped bot token and chat ID for the current user. Missing or malformed configuration completes the Start attempt with a stable `START_PRECONDITION_CHANGED` receipt and no execution record.

```typescript
// Bypass only optional ordinary-notification preflight
start({
  action: "prepare",
  workflowId: "moira/software-development-flow",
  parentExecutionId: "none",
  skipNotificationCheck: true,
});
start({ action: "execute", startAttemptId: "<Start attempt ID from prepare>" });
```

`skipTelegramCheck` is a deprecated alias for `skipNotificationCheck`; conflicting values are rejected. Neither field bypasses the lock check. Ordinary channel discovery uses the shared bounded configuration probe, which normalizes provider failure or timeout as unavailable without exposing diagnostics. Lock preflight checks configuration shape, not Telegram network reachability. `LockHandler` repeats the authoritative check and performs trusted delivery when execution reaches the lock node, so a later send failure still creates no usable active lock.

### Parent-Child Workflow Linking

Start preparation supports `parentExecutionId` to link child workflows to a parent:

```typescript
// Start child workflow with parent link
const preparedChild = start({
  action: "prepare",
  workflowId: "child-workflow-id",
  note: "Child execution",
  parentExecutionId: "parent-execution-uuid",
});
start({ action: "execute", startAttemptId: preparedChild.startAttemptId });
```

The parent must be a running execution owned by the authenticated user. A running execution can
attach, replace, or detach (`parentExecutionId: "none"`) its parent with
`session({ action: "set-parent", executionId, parentExecutionId, expectedRevision,
expectedParentRevision })`. Read both revisions from `execution_context`; a successful mutation
returns the next `parentRevision`. The guarded operation rejects a stale step generation or parent
snapshot, cross-owner links, completed new parents, and ancestry cycles; repeating the current value
is an idempotent no-op. Parent linkage carries continuation only, not variables or authority.

When child workflow completes, response includes continuation reminder:

```
Workflow completed successfully

---
**CONTINUATION REMINDER**: This was a child workflow. Parent execution awaits continuation.
Parent execution ID: <parent-uuid>
Read session({ action: "current_step", executionId: "<parent-uuid>" }) and continue with the returned step attempt.
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
// Returns complete metadata, variableRegistry, runtimePolicy, progress,
// systemReminder, structure, optional nodes, and optional validation.
// includeNodes and includeValidation remove only their named fields.

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

// List compact node summaries
manage({ action: 'list-nodes', workflowId: 'workflow-id', includePreview: true })

// Get a selected node batch
manage({ action: 'get-nodes', workflowId: 'workflow-id', nodeIds: ['start', 'end'] })

// Analyze definition-wide variable sources and usage
manage({ action: 'analyze-variables', workflowId: 'workflow-id' })

// Change an owned workflow's visibility (leaves the stored graph and its revision alone)
manage({ action: 'set-visibility', workflowId: 'workflow-id', visibility: 'private' })

// Edit against the revision read by get: refused when the stored revision differs
manage({ action: 'edit', workflowId: 'workflow-id', expectedRevision: 3, changes: {...} })

// Validate workflow
manage({
  action: 'validate',
  workflow: { metadata: {...}, nodes: [...] }
})
// Returns: valid, errorCount, warningCount, errors, warnings

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
// Returns: identical, summary, and optional details for metadata, nodes, and reminder changes
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
  // "degradation" records a step that ran without behaviour text it names; it is not a failure
  errorType: "validation" | "handler" | "system" | "degradation";
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
  | UserNotificationNode
  | TelegramNotificationNode
  | ExpressionNode
  | ReadNoteNode
  | WriteNoteNode
  | UpsertNoteNode
  | LockNode
  | TeleportNode
  | MaterializeNode;

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
  // Run after the answer is validated and before the cases; assignments write declared globals
  // and are published only when the node succeeds.
  expressions?: string[];
  // Routing on the node's own validated answer; `success` is taken when no case holds.
  cases?: RoutingCase[];
  // `success` is the default output; `error`/`timeout` are reserved control outputs; every other
  // key is an authored output named by a case.
  connections: { success: string; error?: string; timeout?: string } & Record<string, string>;
}

interface RoutingCase {
  when: StructuredCondition;
  // Names a key of the node's `connections`, other than its default or a control output.
  output: string;
}

interface ConditionNode {
  type: "condition";
  id: string;
  // Evaluated before the cases; see AgentDirectiveNode.expressions.
  expressions?: string[];
  // At least one case; the first whose `when` holds selects its output.
  cases: RoutingCase[];
  // `default` is taken when no case holds; `error` when an expression fails.
  connections: { default: string; error?: string } & Record<string, string>;
}

interface UserNotificationNode {
  type: "user-notification";
  id: string;
  message: string;
  format?: "plain" | "markdown" | "html";
  silent?: boolean;
  attachProgressImage?: boolean;
  attachment?: {
    kind: "image" | "document";
    data: string;
    encoding: "base64";
    filename: string;
    mimeType: string;
  };
  connections: { default: string; error?: string };
}

/** @deprecated Use UserNotificationNode. */
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
- **Node types** — exactly the `GraphNode` union: start, end, agent-directive, condition,
  expression, subgraph, user-notification, deprecated telegram-notification, teleport, lock, materialize, read-note, write-note,
  and upsert-note
- **Unreachable nodes** — Warning for disconnected nodes
- **Node limits** — Max 200 nodes per workflow
- **Subgraph references** — Self-referencing circular dependencies rejected as error
- **Declared-variable references** — Blocking error. Every `{{variable}}` in an agent-directive/teleport `directive` or `completionCondition`, a user-notification/telegram-notification `message`, user-notification `attachment.data`, and every `contextPath` root in a condition must be one of: a global declared in `variableRegistry`, a `node-id.name` local (root segment is a node id), or a system variable (`executionId`, `workflowId`, `userId`). An undeclared reference fails with: `references undeclared variable '<name>'. Declare it in the workflow variableRegistry or reference a node-local value as 'node-id.name'.`

### Node-Type Semantic Validation

Per-node-type checks that AJV schema cannot perform:

- **Routing cases (ConditionNode / AgentDirectiveNode)** — each case's `when` is validated as a structured condition: the operator must be in the allowed list (eq, neq, gt, gte, lt, lte, contains, exists, and, or, not), binary operators require `left` + `right`, `exists` requires `value`, logical operators require a non-empty `conditions` array, `not` requires a `condition` field, and nested conditions are validated recursively. A case whose `output` is not a key of the node's `connections` is a blocking error (`unknown-case-output`), as is a case naming a reserved control output (`error`, `timeout`). A case that selects the node's own default output (`default` on a condition node, `success` on an agent-directive node) is a warning: such a case is redundant. An authored output that no case names is the warning `unreachable-output` — the definition stays valid, since a connection is often added before the case that selects it; the default output and the control outputs need no case. That a condition node has at least one case and a `connections.default` is enforced earlier, by the AJV schema.
- **Expressions on routing nodes (ConditionNode / AgentDirectiveNode)** — the `expressions` array gets the same parse and declared-assignment checks as the standalone expression node.
- **AgentDirectiveNode** — `inputSchema` (if present) must be compilable JSON Schema (validated via AJV compile).
- **Output-scope declaration (AgentDirectiveNode / TeleportNode)** — Blocking errors. Every name in `inputSchema.globalInputs` must exist in the workflow `variableRegistry` (`declares global write '<name>' which is not in the workflow variableRegistry`); a name must not be both a declared global write and a node-local output, i.e. a `globalInputs` name cannot also appear in `inputSchema.properties` (`local output '<name>' shadows the declared global write of the same name`). Non-string `globalInputs` entries are rejected.
- **ExpressionNode** — each expression is parsed before execution; targets must be safe bare names, and member reads support own-property paths plus bounded fixed or variable array indexes.

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

- Queries `lockService.getActiveLock(executionId)`.
- Allows execution only when the current graph node is a `lock` node, because `LockHandler` owns that node's validation and Telegram-approval resume path.
- Blocks every other current node with `ValidationError` containing the lock reason and the exact MCP unlock call shape.
- The caller must resolve the lock through `lock({ action: "unlock", executionId, pin })`, owner/admin unlock, or Telegram approval before another node can advance.

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
- **Template processing** - processes directive and completionCondition
- **Validation failure** - logs the rejection, returns sanitized schema feedback without the
  rejected payload, and pauses again at the same node
- **Routing on the answer** - after validation, the node's `expressions` run, then its `cases` are
  evaluated against the context with the answer merged (readable by bare name and under the node's
  own id); the first holding case selects its output, otherwise `success`
- **Expression failure** - routes to `connections.error` when the node declares one, otherwise
  fails the node; nothing the expressions assigned is published

### ConditionHandler

- **Auto-execution** - immediately routes and continues
- **Output paths** - `expressions` first, then `cases` in authored order; the first case whose
  condition holds selects its output, otherwise `default`
- **Context access** - resolves contextPath references; assignments made by the expressions are
  published as declared globals when the node succeeds

### TelegramNotificationHandler

- **Auto-execution** - sends message and continues
- **Template processing** - processes message templates
- **Inline keyboard support** - passes `replyMarkup` (InlineKeyboardMarkup) to Telegram API as `reply_markup`
- **System footer** - appends process ID, resolved workflow name, and branding to each notification; when the workflow has a process view, also the progress lines of the run projected as of the node (`withInFlightPause`): `⏳ agent on the step: <block>` or `🙋 waiting for you: <block>` when the node's successor pauses the run, then `📝 done/total: current item` for the bound list nearest the run
- **Workflow name resolution** - resolves workflowId UUID to human-readable name via repository with fallback
- **Graceful degradation** - continues workflow on send failures
- **Actionable error messages** - pushes classified error guidance to messageQueue (invalid token, chat not found, rate limit, etc.)
- **Error classification** - uses `getActionableTelegramErrorMessage()` and `classifyTelegramError()` from `telegram-types.ts`

### UserNotificationHandler

- **Auto-execution** - renders the portable message and invokes the shared user communication service
- **System footer** - appends the short process ID, the resolved workflow name, and branding; when
  the workflow has a process view, also the progress lines of the run projected as of the node
  (`withInFlightPause`, the same copy the attached image renders): `⏳ agent on the step: <block>` or
  `🙋 waiting for you: <block>` when the node's single forward connection leads to a node the run
  pauses on (`lock` → a person; `agent-directive`, `teleport`, `materialize`, `subgraph` → the agent), then one
  `📝 done/total: current item` line for the bound list nearest the run (the active block's, else
  the most recently passed bound block's); no count for an unbound run
- **Channel selection** - fans out only to enabled configured adapters for the execution user
- **Results** - stores sanitized full, partial, no-channel, or total-failure outcomes under the node ID
- **Routing** - total attempted failure uses `connections.error` when present; other outcomes continue through `default`
- **Authority** - accepts no provider, recipient, destination, or credential selection

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
- **Operations** - `+`, `-`, `*`, `/`, parentheses, string/boolean literals
- **Assignment** - safe bare targets such as `result = a + b`
- **Member reads** - own-property paths and bounded fixed or variable array indexes such as `tasks[current_index].action`
- **Registry validation** - assignments must name declared globals and satisfy their JSON Schemas before publication
- **Error handling** - invalid arithmetic, paths, indexes, targets, or values route to `error` without partial writes
- **Counter management** - expression nodes handle all loop counter increments; agent-directive nodes must not manage counters

### Bounded Loop Pattern

All workflow cycles require explicit bounds using expression + condition node pairs:

```
expression node: ["counter = counter + 1"]  →  condition node
                                                  case counter < max_counter → "continue" → loop
                                                  default → ask-user-limit-reached
```

**CRITICAL: When the limit is exceeded (the default output), the workflow MUST ask the user** what to do via an agent-directive node with options:

- `continue` — accept current result as-is despite unresolved issues
- `reset` — reset iteration counter to 0 and retry the fix loop
- `accept` — approve and proceed to next phase

The `reset` option routes to an expression node that resets the counter, then loops back to the fix step. The `continue`/`accept` options route to the next phase (the original escape target).

**Anti-pattern:** Routing the default output directly to the next phase (silently skipping the fix loop) — this removes user control and hides unresolved issues.

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

// Cloud codespaces (closed labels only; never user/codespace/operation IDs)
export const codespaceConnectionEventsTotal: Counter; // moira_codespace_connection_events_total{provider, action}
export const codespaceLifecycleEventsTotal: Counter; // moira_codespace_lifecycle_events_total{provider, action, state}
export const codespaceOperationEventsTotal: Counter; // moira_codespace_operation_events_total{provider, kind, action, state}
export const codespaceOperationDurationSeconds: Histogram; // moira_codespace_operation_duration_seconds{kind, state}
export const codespaceRejectionsTotal: Counter; // moira_codespace_rejections_total{code}
export const codespaceReconciliationDueGauge: Gauge; // moira_codespace_reconciliation_due{kind}
export const codespaceReconciliationOldestDueAgeSeconds: Gauge; // moira_codespace_reconciliation_oldest_due_age_seconds{kind}
export const codespaceActiveGauge: Gauge; // moira_codespace_active{kind}
export const codespaceTransferLiveBytesGauge: Gauge; // moira_codespace_transfer_live_bytes
export const codespaceConnectorAvailableGauge: Gauge; // moira_codespace_connector_available{provider}
export const codespaceReadyGauge: Gauge; // moira_codespace_ready{provider}
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
GET    /api/admin/system-status            // Neutral health/reconciliation status
GET    /api/admin/stats                    // Installation-wide statistics (adminAnalytics)
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
  status: 'sent' | 'failed' | 'logged';
  error?: string;
  createdAt: string;
}
```

`logged` is the explicit test-recipient/test-provider outcome. It records an attempt but never means
that a message left the process.

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
  toolsVersion: string | null; // Catalog revision accepted by successful MCP initialize
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
// Auth: requireVerifiedAuth. SaaS requires verified email; self-host disables that gate but still
// requires an approved, unblocked account.
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
    assertRealEmailDelivery();
    await sendEmail(user.id, 'password_reset', {
      to: user.email,
      subject: 'Reset your password - MCP Moira',
      text: `Click to reset: ${url}`
    });
  }
},
emailVerification: {
  sendOnSignUp: getFeatureResolver().isEnabled('verificationEmailOnSignup'),
  sendVerificationEmail: async ({ user, url }) => {
    assertRealEmailDelivery();
    await sendEmail(user.id, 'verification', {
      to: user.email,
      subject: 'Verify your email - MCP Moira',
      text: `Click to verify: ${url}`
    });
  }
}
```

Self-host does not send verification on sign-up and can run with delivery unavailable. SaaS enables
sign-up verification and startup requires a real SMTP or Brevo provider. Both callback types refuse
before link/token side effects when delivery is not `real`; the explicit test sink is not accepted
as delivery.

## Session Info Tool

### session

Action-based tool for session-related information.

```typescript
// Parameters
{
  action: 'user' | 'executions' | 'execution_context' | 'current_step' | 'diagnose' | 'recover'
        | 'update-note';
  executionId?: string;  // Required for execution_context, current_step, diagnose, recover, update-note
  nodeId?: string;       // Required for recover: the node the run must resume from
  variableValues?: Record<string, unknown>; // recover: values written into the execution context
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
    errorCount?: number; // Refusals in the errors array; degradation entries are not counted
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

// action: 'current_step' - Returns the authoritative current presentation
string  // Formatted directive including Process ID and Step attempt ID

// action: 'diagnose' - Reports whether a paused run can still continue, and why not
{
  executionId: string;
  workflowId: string;
  continuable: boolean;        // false when any cause blocks
  currentNodeId: string | null;
  currentNodeExists: boolean;  // whether that node is still in the definition
  attempt: {                   // null when the run has no presented attempt
    attemptId: string;
    state: string;
    boundNodeId: string | null;
    boundExecutionRevision: number | null;
    boundToCurrentDefinition: boolean;
  } | null;
  executionRevision: number;
  causes: ContinuationCause[]; // each names one reason and whether it blocks
}

// action: 'recover' - Re-presents a run that cannot continue, at a node it can resume from
{
  executionId: string;
  nodeId: string;
  presentation: string;       // the rendered directive, carrying the fresh Step attempt ID
  appliedVariables: string[]; // names written into the context by this recovery
}

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
  offset: number;          // Effective offset used by this request
  limit: number;           // Effective limit used by this request
  returnedCount: number;
  hasMore: boolean;
  nextOffset: number | null; // Pass as offset for the next page; null on the last page
}
```
