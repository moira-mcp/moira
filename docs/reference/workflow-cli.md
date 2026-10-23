# Workflow CLI

`moira-workflow` reads and edits workflow JSON files. Its command implementation is
[`packages/workflow-cli`](../../packages/workflow-cli/); it uses the engine's authoring,
migration and validation rules. The command does not start or update a running Moira execution.

## Run the intended checkout

After installing repository dependencies, run the existing executable from the repository root:

```sh
node packages/workflow-cli/bin/moira-workflow.js --version
node packages/workflow-cli/bin/moira-workflow.js flow.json schema
```

To expose this checkout as a global command, use its existing link script:

```sh
npm run link --workspace=@mcp-moira/workflow-cli
moira-workflow --version
moira-workflow --help
```

`--version` prints the package version and exact implementation path. Check the path when several
checkouts exist. The linked command preserves the caller's working directory and uses the Node
executable that started it; no fixed Node patch path is required.

The examples below use `flow.json` as a placeholder. Bundled catalog definitions are under
`workflows/production/flows/`, named by workflow UUID. Select the actual file before editing.

## Choose a command

| Responsibility                            | Commands                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Inspect the definition                    | `get`, `list`, `search`, `structure`, `schema`, `variables`                                              |
| Check the definition and its process view | `validate`, `derive`, `migrate`                                                                          |
| Edit nodes and connections                | `update`, `add`, `replace`, `clone`, `rename`, `delete`, `move`                                          |
| Edit declared globals                     | `list-variables`, `get-variable`, `set-variable`, `set-variable-schema`, `delete-variable`               |
| Edit process annotations                  | `set-progress`, `set-block`, `set-label`, `clear-label`, `add-block`, `edit-block`                       |
| Edit metadata                             | `set-name`, `set-owner`, `set-slug`, `set-description`, `set-system-reminder`, `set-tags`, `set-version` |
| Work with files                           | `create`, `copy`, `sync`, `export-node`, `diff`                                                          |

Use `--help` for exact arguments and supported options. It is the command reference for the
installed implementation; this guide explains the working and persistence contracts.

## Inspect, edit and validate

Read the complete definition before changing its contract. `schema` gives a deterministic
control-flow projection, including connections, routing cases, declared data flow, cycles,
teleport-only regions and disconnected nodes. `derive` shows the process blocks, transitions,
returns and annotation diagnostics. Neither command executes the workflow or writes its source.

```sh
moira-workflow flow.json schema
moira-workflow flow.json update review --directive-file ./review-directive.md
moira-workflow flow.json validate
moira-workflow flow.json derive
```

`validate` exits nonzero for errors; warnings alone do not fail it. It checks executable graph
rules and catalog metadata, including `previousSlugs`. An authored definition may omit the
server-assigned workflow ID. Node IDs and connections still have to satisfy the engine contract.
`validate` and `sync` locate the extension registry snapshot beside `DB_PATH` through Moira's
configuration loader. Run them with the intended installation environment; outside tests, its
required host, authentication and encryption settings must be valid even when the definition has
no custom nodes. The loader reads `.env.local` for `NODE_ENV=development` and `.env` otherwise,
from `ENV_FILE_FOLDER` or the caller's directory. See
[installation configuration](../operator/configuration.md) before selecting an environment.
Do not copy production credentials into an editing fixture.

Without a usable snapshot, a custom type can be unresolved, rather than proven invalid or available.

`derive` prints process diagnostics; inspect them rather than treating successful printing as
proof that the process contract is complete. Process edits may be staged while diagnostics remain.
Finish the complete change with `validate`, `derive` and semantic review of the resulting graph.

### Structural edits

Use `rename` to rewrite recognized references, including connections, template paths, routing and
human-gate conditions, expressions, progress lists, subgraph mappings and external-write policy.
Plain prose mentioning an ID is not rewritten automatically.

`delete` requires a decision for every incoming edge. Retarget a primary output; only a non-primary
output can be dropped. The start node cannot be deleted. Remaining references to a deleted node's
outputs are reported by validation.

```sh
moira-workflow flow.json rename review independent-review
moira-workflow flow.json delete obsolete-check --retarget prepare.success=review --drop prepare.skip
```

`clone` copies the complete node, including its outgoing connections, under a new node ID.
Review or retarget those connections before using the copy. `replace` requires a complete node
with the same ID and keeps its array position. Inspect the resulting definition after either edit.

### Variables and process content

Declared globals belong to `variableRegistry`. `set-variable` writes a string default, preserving
an existing declaration's schema and description; an explicit empty argument is a value, while an
omitted value is refused. Use `set-variable-schema` for a complete JSON Schema declaration, including
typed defaults and constraints.

```sh
moira-workflow flow.json set-variable review_prompt "Inspect every requirement" --no-version-bump
moira-workflow flow.json set-variable-schema attempts '{"type":"integer","description":"Review attempts","minimum":0,"default":0}'
moira-workflow flow.json set-variable-schema result --file ./result-schema.json
moira-workflow flow.json set-progress --file ./progress.json
```

Process commands set block ownership, boundary labels, explained returns and optional list bindings.
Node update options also support active progress overrides, human gates and notification settings.
These commands retain their type-specific restrictions. `none` clears the fields that explicitly
support it; it is not a general JSON-null syntax. See the command help and
[workflow semantics](../development/architecture.md#context-templates-and-validation) for the relevant contract.

## Backups and versions

Backups live in `workflow-backups/` under the **caller's working directory**. They contain the exact
pre-write bytes. Their names include the source basename and timestamp, with a collision suffix when
needed; exclusive creation prevents an existing backup from being overwritten. Choose a suitable
ignored working directory for agent-owned editing work.

A refused mutation may create a backup without changing the source. New destinations have no prior
file to back up. An already-current `migrate` makes no write; `sync` validates before backup or write.
Backups preserve prior content; they do not make the subsequent source write transactional or guard
against another writer. Coordinate ownership of the file before editing or restoring it.

An ordinary normalized content change increments a valid semantic version's patch component.
Automatic versioning follows the shared normalization rules, so identity-only changes need not bump
the version. `--force` and its alias `--no-version-bump` suppress the automatic bump; neither is part
of a saved text value. `set-version` accepts an explicit `X.Y.Z`. Migration preserves the content
version, and `sync` uses the source version rather than incrementing the destination automatically.

## Compare and synchronize files

`diff` compares all root, metadata and node fields, including progress, registry declarations,
expressions, extension payloads and field presence. It reports added, removed and modified nodes by
ID and significant node-array order. Object member order alone is not a change.

```sh
moira-workflow flow.json diff ./candidate.json
moira-workflow ./candidate.json sync ./existing-destination.json
```

Use `copy` for a new workflow identity. Use `sync` to replace an existing destination while retaining
its `id`, `slug`, `owner`, `visibility` and `previousSlugs`, including their absence; destination author/tags supply defaults
when the source values are missing or null. Catalog metadata and the synchronized executable graph are
validated before writing. Invalid input leaves the destination byte-for-byte unchanged. The source
copy's migration aliases never replace the destination's aliases.

## Stored execution inspection

Workflow-file editing and execution-context inspection have different owners. Ordinary agents use
Moira's authenticated execution tools. The separate operator utility
[`scripts/execution-query.ts`](../../scripts/execution-query.ts) reads stored execution variables
from the configured database and explicitly loads the local `.env.local`; it does not query a remote
Moira session. Inspect its configuration before using it against an installation.
