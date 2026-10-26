# Architecture and source ownership

Moira runs authored workflow graphs through the same engine from MCP and the web backend.
The browser edits that authored model and derives display models from it. Start with
[getting started](getting-started.md) for local commands and the
[testing guide](../../tests/TESTING-GUIDE.md) for verification.

## Packages and composition

| Owner                                                                       | Responsibility                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workflow-engine`                                                  | Authored graph contracts, migrations, graph validation, authoring operations, execution and process/run projections                    |
| `packages/shared`                                                           | Foundation primitives plus explicitly separate application services, SQL repositories and catalog orchestration                        |
| `packages/mcp-server`                                                       | MCP transport, authenticated request context, typed tool registration and portable help delivery                                       |
| `packages/web-backend`                                                      | HTTP admission, route presentation and application composition over the shared services and engine                                     |
| `packages/web-frontend`                                                     | Editor/run-page views, browser state and API view models                                                                               |
| `packages/workflow-cli`                                                     | The maintained `moira-workflow` command, using engine authoring, migration and validation                                              |
| `packages/docs`                                                             | Website presentation of portable content and typed tool contracts                                                                      |
| `packages/workspace-service`, `packages/local`, `packages/extension-runner` | Workspace execution, computer-owned lifecycle operations and trusted extension execution; see [workspaces](../reference/workspaces.md) |

The package dependency graph is mutually dependent at application composition points. It is not a
layered package DAG. The narrower foundation module graph must remain closed: importing a logger,
error, configuration getter, canonical serializer, metadata revision, crypto or HTTP framing
primitive must not pull application services, database composition or the engine back into it.

Engine runtime imports name the actual narrow shared owner, such as
`@mcp-moira/shared/logging/logger`, `/errors`, `/canonical-json`, `/metadata-revision`,
`/settings-encryption` or `/http/owner-stream-frame`. A root shared import used only as a type is
erased; it is not evidence of a runtime dependency. Do not route a primitive through an application
barrel to make it reachable.

SQL repositories and `@mcp-moira/shared/services` are application modules, even when imported by a
narrow subpath. The service factories retain their existing singletons and original implementations.
Catalog loading uses the engine's pure migration entry; gate decisions use its pure human-gate
entry; live graph validation uses its validation entry. Composition supplies required semantic
operations where the dependency boundary requires injection. It does not substitute an optional
validator, copy an algorithm or defer a synchronous SQL operation into an asynchronous callback.
Keep writes, revision guards, change events and notification enqueueing in their owning synchronous
transactions.

The package export maps are the import contract. Implementation entry points include
[service factories](../../packages/shared/src/services/index.ts),
[catalog loading](../../packages/shared/src/services/workflow-catalog-loader.ts),
[definition upgrades](../../packages/shared/src/services/workflow-definition-upgrade.ts) and
[workflow mutation](../../packages/shared/src/services/workflow-mutation-service.ts).

## One authored model

`WorkflowGraph`, `GraphNode` and `ProgressContentTemplate` belong to the engine. Frontend and backend
type facades reuse them with type-only exports. An authored graph may not yet have an ID; a loaded
workflow's server identity is a separate required fact. API wrappers and rendered editor/run models
remain transport or UI types; they do not redefine the authored node union.

Preserve the complete authored object through load, edit, undo and save, including fields the current
panel does not display. Keep absence distinct from an explicit empty value. In particular, progress
content is an object with summary/details/outcome/next, materialize entries use `files[].path`, and
schema integers remain integers. Extensions contribute schemas through the live node-type catalog;
the browser does not load extension frontend code.

Use [`@mcp-moira/workflow-engine/authoring`](../../packages/workflow-engine/src/authoring/index.ts)
for graph edits and `/process` for pure process derivation. These browser-safe entry points use
engine types and pure dependencies. Importing the engine root as a browser runtime dependency can
bring Node, persistence or rendering code into the bundle. Full graph validation stays on the
server/CLI; a pure authoring operation is not a validation or authorization boundary.

Definition shape uses `metadata.schemaVersion`, separately from the content version in
`metadata.version`. Entry points share the engine's pure, idempotent migration; stored definitions,
catalog baselines and recorded conflicts are upgraded through their existing startup owner.
See [schema migration](../../packages/mcp-server/src/help/content/reference/validation.md#schema-version-and-migration)
and the CLI `migrate` command rather than maintaining another shape converter.

## Execution pipeline

[`GraphExecutionEngine`](../../packages/workflow-engine/src/core/graph-execution-engine.ts) runs one
cycle from a node until pause or completion. It selects a built-in handler or a live extension
handler, passes input once, merges declared results and follows the returned connection. It emits
chronological per-cycle visits, including the actual exit key. It does not persist the complete run.

[`UniversalGraphExecutor`](../../packages/workflow-engine/src/core/universal-graph-executor.ts)
loads the saved graph and run, coordinates durable attempt ownership, invokes that cycle, folds
visits and commits the resulting execution with its response receipt and next presentation.
Operational handler failures are recorded and pause for repair/retry; programmer errors propagate
to the outer boundary. A node's explicit error output applies where its handler implements it,
not as a universal exception-catching connection.

The [execution contract](../reference/execution.md) owns replay, unknown outcomes, continuation,
waiting, stop and projections. The [HTTP reference](../reference/http-api.md) owns wire fields and
route admission. MCP tool schemas and descriptions belong to the typed tool contract, rather than a
second handwritten action catalog. Portable [node](../../packages/mcp-server/src/help/content/concepts/nodes.md)
and [template](../../packages/mcp-server/src/help/content/concepts/templates.md) references own
author-facing syntax.

## Context, templates and validation

The workflow's `variableRegistry` declares global values with JSON Schema descriptors. Descriptors
require a type and meaningful description; defaults seed the run. An agent node declares global
writes in `inputSchema.globalInputs` and local outputs in `inputSchema.properties`. The engine
inlines global descriptors for response validation, but routes the accepted answer by the original
scope declaration. A local output is read as `node-id.field`; matching a global's name alone does
not promote a local field into that global. Undeclared answer keys are refused. Other automatic
handlers keep their results under their node IDs; expression assignments write declared globals.

Template resolution distinguishes declared globals, known node scopes, system values and explicit
Note/Playbook references. Runtime data is not trusted as an authored template fragment. Registry
defaults designated as template fragments can expand; data values must not inject template syntax.
`directive` and `completionCondition` are rendered, while `inputSchema` is a schema, not templated
prose. Missing values produce the engine's visible undefined placeholder, not evidence that work
can be skipped. Do not replace the shared resolver with a direct `context.variables[name]` lookup.

Expressions and structured conditions have dedicated parsers; they do not execute arbitrary
JavaScript. Expression writes are checked against the registry and published only on success.
Ordered cases select the first matching authored output; reserved control outputs are not cases.
Use the existing validation and authoring owners when adding a field or node behavior:

- [GraphValidator](../../packages/workflow-engine/src/validation/graph-validator.ts) combines graph
  structure, schemas, references, node semantics and process diagnostics into located issues.
- [SchemaValidator](../../packages/workflow-engine/src/utils/schema-validator.ts) validates responses;
  shape validation does not prove the truth of an agent's evidence.
- [VariableResolver](../../packages/workflow-engine/src/templates/variable-resolver.ts) and the
  [template processor](../../packages/workflow-engine/src/templates/graph-template-core.ts) define
  scope, serialization and fragment trust.

## Persistence and revisions

Production state is SQLite through the shared connection and repositories.
`DatabaseRepository` is the engine-facing adapter; `InMemoryRepository` is an isolated execution/test
implementation. Production workflow and execution state does not live in a graph-storage directory.
Repository reads still require the appropriate user/resource authorization at their caller or
domain service; possession of a storage adapter is not authority.

There are distinct revisions: a workflow's authored `metadata.version` is its semantic version;
saved definitions have optimistic write revisions and separately numbered immutable content
snapshots. Executions have step-generation revisions and separately guarded metadata. Workflows,
Notes, Playbooks and global settings use append-only content revisions. Do not interchange these tokens. The
[shared revision repository](../../packages/shared/src/database/repositories/revision-repository.ts)
stores an opaque entity kind/ID, revision content and retention chosen by its entity owner. History
lists transfer bounded previews, comparison distinguishes a missing revision from equal content,
and restoring appends a revision. Null content is distinct from an absent or pruned revision.

Workflow history stores complete, independently gzip-compressed JSON payloads. Object keys use
locale-independent ordinal ordering; array order remains significant. Equal canonical content
shares one payload within the same workflow, while every save retains its own revision number,
author and timestamp. Reads and comparisons return formatted JSON. Lists read a bounded stored
preview without decompressing every payload. Deleting or pruning a revision removes its payload
only after the last reference is gone; Notes, Playbooks and settings retain their text storage.
The schema initializer atomically converts existing workflow history to this representation,
preserving revision metadata. Conversion is idempotent; malformed content fails rather than
discarding the original history.

Workflow snapshots and graph writes share the owning synchronous transaction. Ordinary guarded
mutations also keep the optimistic check and gate recomputation in that transaction. Catalog
reconciliation and stored definition upgrades use the same history writer. A definition without history gains its actual
preceding baseline at its next content write. Historical content requires editing authority;
publication of the current definition does not publish its private past. Rollback validates the
selected content and appends a guarded save while preserving current identity and sharing.
Soft deletion retains history; permanent workflow/account deletion removes owned history.
See [HTTP history operations](../reference/http-api.md#workflow-content-history) and the
[author guide](../../packages/mcp-server/src/help/content/guides/editing-workflows.md#definition-versions-and-saved-history).

List selection, predicates, count and pagination belong in the shared query/repository layer;
enrich the selected page rather than filtering it afterwards. Overview reads use a consistent
snapshot and dependency-aware projections; a narrowed read is never a complete execution that may
be saved back. See [execution reads](../reference/execution.md#overview-and-live-reads).

Authored `connections` route the engine. Progress blocks own authored nodes through `progressNodeId`;
their displayed transitions are derived from those real edges and labels. Block order, a rendered
`connections.default` or a list binding is presentation, not an alternative executable route.
Keep task identity, progress presentation and arbitrary run notes separate.

Bundled definitions are installed through catalog/reconciliation services. Managed identity,
previous/current/incoming content and explicit conflict decisions determine whether an update is
safe. A definition edit also has to respect
[running-execution compatibility](../reference/execution.md#running-execution-compatibility).
Use the [bundled catalog reference](../reference/bundled-catalog.md) for installation/reconciliation
actions and [workflow CLI](../reference/workflow-cli.md) for local authored files.

## Transport and presentation boundaries

MCP and HTTP are separate process entry points sharing domain services and persisted state. MCP
request context carries authenticated user and detected agent/model for effective text resolution;
tool registration applies the common input preprocessing instead of each handler parsing its own
stringified objects. The file default prompt, portable help and typed tool projection each have one
source owner; [documentation development](documentation.md) explains their delivery paths.

Workspace source bytes and long-running owner operations use their dedicated authenticated
transport, not ordinary JSON/body logging. Shared framing/body primitives own their wire mechanics;
Local bootstrap remains Local-owned and the guest builder assembles the common distribution.
Executable asset names and installed/sealed identities are runtime contracts.

Resource authorization, admission and credential handling are detailed in
[authentication](../reference/authentication.md) and [security](security.md). Errors cross the
transport boundary with sanitized context; operational diagnostics and audit/metrics belong to
[observability](observability.md), rather than copied logger APIs here.
