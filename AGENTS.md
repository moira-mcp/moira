# Working in Moira

Read [CONTRIBUTING.md](CONTRIBUTING.md) completely before implementation. It owns issue
availability, claims, branch and pull-request coordination, DCO and maintainer handoff.
`CLAUDE.md` imports this file; keep one agent contract.

Moira is a node-graph workflow engine exposed through the Model Context Protocol (MCP),
with a browser interface for authoring and observing workflows. The engine validates
answer structure and controls progression; agents and reviewers verify the underlying facts.
Start with [the documentation index](docs/README.md), then read the relevant source and
contract before changing behavior.

## Architecture and reuse

Use the current [architecture](docs/development/architecture.md) and
[project map](PROJECT-STRUCTURE.md). The engine owns authored types, graph semantics,
validation and execution. Shared foundation primitives must not import application
composition or engine runtime through a barrel. Persistence owns SQL transactions;
application services compose canonical engine operations. Browser authored types use
the type-only engine facade, while browser/API representations remain local.

Local and GitHub environments use the same workspace-service payload. Cloud routing,
controller lifecycle, guest commands and original-operation receipts have distinct
owners; preserve the [workspace contracts](docs/reference/workspaces.md). Copy returned
references unchanged. A lost reply requires collecting the original operation, not
inventing IDs, refreshing proof or replaying a mutation. Direct guest readiness is
independent of remote enrollment. Runtime fixtures do not prove native VM isolation.

Prefer an existing primitive and composition to a parallel implementation. For browser
work, follow [Web UI architecture](docs/development/web-ui.md) and
[UI patterns](docs/development/ui-patterns.md), including retained results, private
admission, drafts, accessibility and both languages.

## Build and verification

Node.js 24 and root npm entrypoints are the supported contributor path. Follow
[getting started](docs/development/getting-started.md) for setup and the distinction
between persistent self-host Compose and the disposable contributor Docker helper.
The application image is baked: restarting an old container does not load source edits.
Do not replace another user's running instance or assume a helper targets your MCP server.

Run tests through root npm scripts; do not invoke Jest or Playwright directly. Read
[the testing guide](tests/TESTING-GUIDE.md) and locate an existing suite through
[the coverage map](tests/COVERAGE-MAP.md). Preserve isolated databases and existing
authentication fixtures. Update the map when adding, removing or moving a suite.
Tests must distinguish required behavior from a realistic wrong result: no empty or
conditional assertions, mirrored production algorithms, or redundant checks across levels.

Before pushing, run `npm run verify`. Run `npm run verify:docker` for changes to
container-served behavior, published tools, startup, migrations or bundled catalogs.
The latter selects the CI environment explicitly; a local self-host API run is not
equivalent to SaaS assertions. Keep Linux-specific behavior and build inputs in view.
Use the root formatter/linter entrypoints and required hooks. Diagnose failures rather
than masking them with longer timeouts, swallowed errors or weaker expectations.

## Workflow authoring

Workflow Management Flow is the executable authoring path for complex workflow changes.
Repeated authoring lessons must reach its responsibilities, review gates or required
evidence; optional prose alone does not deliver them to an executing agent. Reuse engine
primitives when the flow needs reliable observations, and keep human reference aligned.

Use `moira-workflow` for workflow JSON changes; inspect its current help and the
[CLI guide](docs/reference/workflow-cli.md). Do not hand-edit definitions with text/JSON
rewrites. Change `metadata.version` with the CLI and validate the actual definition.
[Bundled catalog reconciliation](docs/reference/bundled-catalog.md) explains installation,
conflicts and recovery; do not bypass startup guards or treat a saved old handoff as a
new authoring request.

The maintainer's “standard flows” are `software-development-flow`, `todo-list`,
`robust-task` and `quick-task`, stored under `workflows/production/flows/` and identified
by slug. Research flows are separate. Robust Task executes bounded work with escalation
and replanning; it is not a research workflow.

## Documentation and repository hygiene

[Documentation ownership](docs/development/documentation.md) governs contributor,
operator, portable-help and website sources. A user-facing behavior change updates
its canonical public explanation and matching EN/RU delivery in the same change.
Do not copy tool schemas, routes, node inventories or effective prompts into another
manual. File defaults and intentional-empty database overrides are separate contracts.

Keep current instructions and product contracts in Git. Plans, backlogs, roadmaps,
implementation reports and historical research belong in the appropriate task tracker
or Git history. Preserve genuine unfinished obligations before removing their sole
record; private topology, policy and custody stay in the private tracker.
Put temporary agent material in `agent_temp_files_local/` using local VCS exclusion.
Protect unknown runtime state, databases, VM disks, grants, credentials and journals.

Work in an authorized feature branch, preserve unrelated changes and follow the
contribution contract for delivery. Breaking API changes do not justify destroying
persisted user state. Add compatibility behavior only for a demonstrated requirement.
Report observed checks and remaining limits accurately; never call a partial result complete.

## Working through MCP

Use the configured Moira server for ordinary workflows. Diagnose authentication failures
before changing endpoints. After a tool-catalog change, reconnect or initialize with a
valid credential to accept the new revision; an unaccepted revision receives HTTP 426.
OAuth refresh preserves the predecessor's accepted revision, while a new authorization
or API token needs initialization. See [authentication](docs/reference/authentication.md).
