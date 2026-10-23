# @mcp-moira/workflow-engine

Owns the authored graph model, validation and migrations, node handlers, execution, and pure
authoring/process projections. Production composition uses the shared SQLite repositories;
`InMemoryRepository` supports isolated execution and tests.

Use the declared [package exports](package.json) rather than implementation aliases. Browser
consumers use `/authoring` and `/process`, with canonical model imports kept type-only. Runtime
composition and the distinction between closed shared foundation modules and application services
are documented in [architecture](../../docs/development/architecture.md).

`GraphExecutionEngine` runs a cycle; `UniversalGraphExecutor` coordinates persisted state and
durable attempts. Integrate through the existing composition instead of copying a constructor
recipe that omits handlers, semantic dependencies or replay ownership. See
[execution, replay and recovery](../../docs/reference/execution.md).

Author-facing node/schema/template syntax belongs to the
[portable help sources](../mcp-server/src/help/content/). Use the
[workflow CLI](../../docs/reference/workflow-cli.md) for file edits and the
[testing guide](../../tests/TESTING-GUIDE.md) for engine and authored-flow verification.
