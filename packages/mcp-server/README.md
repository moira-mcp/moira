# @mcp-moira/mcp-server

Serves MCP over stateless `StreamableHTTPServerTransport` with per-request authenticated user and
agent/model context. Workflow execution and authorized workspace operations share the engine and
application services; stateless transport does not mean execution state is ephemeral.

## Run and connect

Use the root workspace's [contributor setup](../../docs/development/getting-started.md) and selected
environment. `npm run docker:restart` builds and runs the contributor container; `npm run docker:stop`
stops it. Its public MCP endpoint is `/mcp` on the configured installation origin.

Clients use OAuth discovery/consent or a supported persistent API token. Do not treat an
unauthenticated `tools/list` probe as usable discovery: initialize the authenticated client with the
current catalog revision contract. The [authentication reference](../../docs/reference/authentication.md)
owns account admission, metadata endpoints and token behavior. The
[MCP Clients page](../docs/src/content/docs/docs/integration/mcp-clients.mdx) composes portable guidance
with registry-generated client setup.

## Contract ownership

[`src/tools/tool-definitions.ts`](src/tools/tool-definitions.ts) owns the typed tool projection,
including input schemas, examples and static description variants. Runtime discovery and tool help
consume it; do not maintain a parallel Markdown tool/action list. Portable English help and its
website translation, canonical default instructions and effective database text have separate
owners described in [documentation development](../../docs/development/documentation.md).

Workspace commands return original operation/process references; file mutations return operation
references. Receipts and output remain in the common guest workspace service. MCP routes live
authorized calls, without an offline command queue. The direct guest `moira-workspace` CLI uses
the same service and semantic contracts. Copy returned references unchanged and collect originals
with `operation_get`, or discover candidates through `operation_find`, before considering another
mutation. `operation_resume` explicitly continues only an original private-repository creation;
a lost first reply is not an automatic deduplication guarantee. See
[workspaces](../../docs/reference/workspaces.md#recovery-and-collection) for custody and uncertainty.

Use [execution](../../docs/reference/execution.md) for start/step receipts and continuation and the
[testing guide](../../tests/TESTING-GUIDE.md) for focused MCP tests against an owned target.
