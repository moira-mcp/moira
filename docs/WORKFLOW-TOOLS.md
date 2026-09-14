# Workflow Management Tool

A universal tool for working with workflow files: editing, structure analysis, validation.

> **Note on paths.** Bundled workflows live under `workflows/production/flows/` as
> JSON files named by their workflow UUID (e.g.
> `workflows/production/flows/45da3ac8-1a7e-4963-a55c-59a4f33234bb.json`). The
> examples below use `./workflows/production/flows/<flow>.json` as a placeholder —
> substitute the real file path.

## Usage

```bash
moira-workflow <workflow-file> <command> [options]
moira-workflow --version
```

`--version` prints the package version and exact source path. Check it before editing when
several Moira checkouts exist; it exposes a stale global link without requiring a workflow file.

## Commands

### get - Get a node by ID

```bash
moira-workflow ./workflows/production/flows/<flow>.json get analyze-and-plan
```

Prints the full JSON of a specific node.

### update - Update a node

```bash
# Update the directive
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --directive "new text"

# Update a condition
moira-workflow ./workflows/production/flows/<flow>.json update check-plan-approval --condition "plan_approved == true"

# Update a message (for notifications)
moira-workflow ./workflows/production/flows/<flow>.json update notify-plan-ready --message "Plan is ready!"

# Move a node to a progress block (or clear with none); `set-block` does the same
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --progress-node-id implementation

# Override the block's label only while this node is current (or clear with none)
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --progress-active-label "Implement {{unit}}/{{total}}"

# Attach/clear the shared progress PNG on a notification node
moira-workflow ./workflows/production/flows/<flow>.json update notify-plan-ready --progress-node-id plan --attach-progress-image true

# Replace all connections
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --connections '{"success":"next-node","error":"error-handler"}'

# Add a single connection
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --add-connection error error-handler

# Remove a connection
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan -- --remove-connection error
```

**Note:** A double-dash `--` is required before `--remove-connection` due to npm argument parsing.

### clone - Clone a node

```bash
moira-workflow ./workflows/production/flows/<flow>.json clone source-node new-node-id
```

Creates a copy of a node with a new ID. Connections are not copied.

### export-node - Export a node to JSON

```bash
# To stdout
moira-workflow ./workflows/production/flows/<flow>.json export-node node-id

# To a file
moira-workflow ./workflows/production/flows/<flow>.json export-node node-id -o node.json
```

### move - Move a node

```bash
# Move after the specified node
moira-workflow ./workflows/production/flows/<flow>.json move node-to-move -- --after target-node

# Move to the end
moira-workflow ./workflows/production/flows/<flow>.json move node-to-move
```

**Note:** A double-dash `--` is required before `--after` due to npm argument parsing.

**IMPORTANT:**

- A backup is created automatically before changes, in `./workflow-backups/`
- Backup format: `<filename>.backup-<timestamp>.json`

`--attach-progress-image` accepts `true` or `false` and is rejected for every node type except
`user-notification` or deprecated `telegram-notification`. These update options persist the requested fields; they do not derive the
process or validate its meaning — run `derive` afterwards.

`--progress-active-label` is valid only for a node that pauses the run and belongs to a block. It
follows normal template validation and changes only the label rendered while that node is
current; the block's own label remains the top-level definition.

### search - Find nodes

```bash
moira-workflow ./workflows/production/flows/<flow>.json search "development-plan.md"
```

Finds all nodes containing the given text in any field. Also searches workflow variables (`variableRegistry`).

Shows:

- Matches in workflow variables
- The node ID and type
- The context where the text was found (first 70 characters)

### list - List nodes

```bash
# All nodes
moira-workflow ./workflows/production/flows/<flow>.json list

# Only a specific type
moira-workflow ./workflows/production/flows/<flow>.json list --type agent-directive
moira-workflow ./workflows/production/flows/<flow>.json list --type condition
```

### structure - Structure visualization

```bash
# Basic structure
moira-workflow ./workflows/production/flows/<flow>.json structure

# With a connection graph
moira-workflow ./workflows/production/flows/<flow>.json structure --graph

# Detailed information
moira-workflow ./workflows/production/flows/<flow>.json structure --detailed

# Filtered by type
moira-workflow ./workflows/production/flows/<flow>.json structure --type agent-directive
```

**What it shows:**

Basic structure:

- Metadata (id, name, version, description, author, tags)
- Node statistics by type
- A list of all nodes with their connections

With `--graph`:

- The same deterministic plain-text schema as `schema`, appended after the basic structure
- Every node and labelled connection, including condition branches and dangling targets
- Basic blocks, cycles, reachability classes, declared data flow, and a coverage footer

With `--detailed`:

- Directives of agent-directive nodes (first 150 characters)
- Conditions of condition nodes (first 80 characters)
- Messages of notification nodes (first line)
- Input schema properties

### validate - Validate a workflow

```bash
moira-workflow ./workflows/production/flows/<flow>.json validate
```

Checks:

- ✓ Presence of required fields (id, metadata, nodes)
- ✓ Uniqueness of node IDs
- ✓ Correctness of connections (all target nodes exist)
- ✓ Presence of start and end nodes
- ⚠ Unreachable nodes (orphan nodes)

Outputs:

- Errors (critical problems)
- Warnings (non-critical remarks)

The command exits with a non-zero status when errors exist, so scripts and agents can use it as a
real gate. Warnings alone do not make the command fail.

Bundled catalog files may also contain `previousSlugs`, which records prior identities for managed
rename reconciliation. The CLI validates that metadata through the catalog reader, removes catalog
metadata from the executable graph presented to `GraphValidator`, and still rejects malformed,
duplicate, or current-slug aliases. Runtime/upload graph validation remains strict.

### schema - Read-only control-flow schema

```bash
moira-workflow ./workflows/production/flows/<flow>.json schema
```

Prints one deterministic plain-text control-flow schema derived only from the workflow JSON. It
expands real node IDs, canonically ordered labelled connections, conditions, declared local/global
outputs, final outputs, subgraph mappings, automatic-node output variables, context references,
basic blocks, cyclic regions, and the complete progress definition with its ordered blocks, any
legacy display edges still stored on them, and node-to-block mappings. It distinguishes normal
start reachability, explicit teleport-only regions, and disconnected roots/components. Every
source node and connection is emitted exactly once; coverage footers make omissions visible. The command does not interpret
workflow-specific meaning, execute workflow content, or write the source file.

### derive - Read-only process projection

```bash
moira-workflow ./workflows/production/flows/<flow>.json derive
```

Prints the workflow's process view derived from its primary graph: every progress block in
process order with its description, outcome template and owned nodes, each transition to another
block with its label (`NEXT`), each return with its label, cause and exit condition (`RETURN`),
the authored edges behind every transition, hub blocks, and every block-contract diagnostic
(`unowned-node`, `unknown-block`, `empty-block`, `empty-description`, `unlabeled-edge`,
`unexplained-cycle`, `outcome-duplicate`, `outcome-unowned`, `unconnected-block`). A workflow without
`progress` prints
a single line saying it has no block view. The output is deterministic and the command does not
write the source file.

### set-label, clear-label, set-block, add-block, edit-block - Author the block contract

```bash
# Label a boundary edge (the edge leaves the node's block)
moira-workflow <flow>.json set-label check-plan-approved true "plan approved"

# Explain a return: a label plus the cause of the loop and the condition that ends it
moira-workflow <flow>.json set-label route-review-verdict false "review found defects" \
  --cause "The independent review reported blocking findings." \
  --exit "The review passes."

moira-workflow <flow>.json clear-label check-plan-approved true

# Own a node by a block (sets progressNodeId; the block must exist)
moira-workflow <flow>.json set-block route-plan-approval plan

# Add a block at the end, or right after another block; edit its description or outcome
moira-workflow <flow>.json add-block deliver "Deliver" "Hand the result over" --after execute \
  --outcome "{{progress_result_outcome}}" --next "Done"
moira-workflow <flow>.json edit-block deliver --summary "Present the result" --next none
```

These commands apply one mutation of the process block contract each, behind the normal backup and
content-version behaviour (`--no-version-bump`, an alias of `--force`, keeps the version). They
refuse an unknown node, connection key or block, an empty label or summary, a duplicate block id,
and a return with only one of `--cause`/`--exit`, leaving the file unchanged. After a successful
write the command re-derives the process and prints whether the block contract is satisfied or how
many diagnostics remain (`derive` lists them). `edit-block` accepts `none` for `--outcome` and
`--next` to remove the field. Annotate a flow iteratively: own every node, label every edge
`derive` reports as unlabelled, explain every return, then `validate`.

### set-progress - Set or remove static execution progress

```bash
# Prefer a file for a complete definition
moira-workflow ./workflows/production/flows/<flow>.json set-progress --file ./progress.json

# Remove the optional top-level definition
moira-workflow ./workflows/production/flows/<flow>.json set-progress none
```

The command accepts a JSON object with a `nodes` array, creates the normal backup, and uses normal
content-version behavior. Give every node its block with `set-block` (or `update
--progress-node-id`). After all staged mutations, run `validate` and `derive`: mutation commands
persist fields but do not compute block coverage, transition labels, or return causes; `derive`
reports the diagnostics.

### Variables - Working with workflow variables

```bash
# Analyze all variables with descriptions and usage
moira-workflow ./workflows/production/flows/<flow>.json variables

# List variables (short format)
moira-workflow ./workflows/production/flows/<flow>.json list-variables

# Get a variable
moira-workflow ./workflows/production/flows/<flow>.json get-variable test_directive

# Set a variable
moira-workflow ./workflows/production/flows/<flow>.json set-variable test_directive "Run all tests"

# Replace a variable's complete JSON Schema inline or from a file
moira-workflow ./workflows/production/flows/<flow>.json set-variable-schema result '{"type":"array","items":{"type":"string"}}'
moira-workflow ./workflows/production/flows/<flow>.json set-variable-schema result --file ./result-schema.json
```

The `variables` command shows:

- All variables with descriptions
- The variable's source (registry/initial/input/expression)
- The number of usages in the workflow
- Where it's used (templates, conditions, expressions)

`list-variables`/`get-variable`/`set-variable`/`delete-variable` operate on the
`variableRegistry` — the single source of truth for declared global variables.
`set-variable` creates a variable if it doesn't exist (the type is inferred from the
value, with a placeholder description) and preserves the existing `type`/`description`
on update. The commands delegate to the shared functions
`setWorkflowVariable`/`deleteWorkflowVariable`/`getWorkflowVariables`, keeping the CLI
and the `manage` MCP tool in parity.

```json
{
  "variableRegistry": {
    "test_directive": {
      "type": "string",
      "description": "Directive for the test step",
      "default": "Run all tests"
    }
  }
}
```

Registry entry format: `{ "type": "string|number|boolean|object|array", "description": "...", "default"?: <value> }`.

### Execution Query - Query execution variables

```bash
# All execution variables
npx tsx scripts/execution-query.ts <execution-id> variables

# Specific variables
npx tsx scripts/execution-query.ts <execution-id> variables task_name,status,result
```

Shows the current values of variables from the workflow execution context.

### diff - Compare two workflow files

```bash
moira-workflow ./workflows/production/flows/<flow-a>.json diff ./workflows/production/flows/<flow-b>.json
```

Shows:

- Metadata changes (name, version, description)
- Added nodes
- Removed nodes
- Changed nodes (with details of what changed)
- systemReminder changes

### create - Create a new workflow

```bash
# Create an empty workflow
moira-workflow create ./new-workflow.json --name "My Workflow"

# With description and version
moira-workflow create ./new-workflow.json --name "My Workflow" --description "Description" --version "1.0.0"

# From a template
moira-workflow create ./new-workflow.json --name "My Workflow" --template ./template.json
```

### copy - Copy a workflow

```bash
# Copy into a new file
moira-workflow ./source.json copy ./destination.json

# With a new name
moira-workflow ./source.json copy ./destination.json --name "New Name"
```

Creates a copy of the workflow with a new ID.

### delete-variable - Delete a variable

```bash
moira-workflow ./workflows/production/flows/<flow>.json delete-variable variable_name
```

Removes a declared global variable from the `variableRegistry`. Creates a backup before the change.

### Other commands

```bash
# Add nodes from a JSON file
moira-workflow ./workflows/production/flows/<flow>.json add new-nodes.json

# Delete a node
moira-workflow ./workflows/production/flows/<flow>.json delete node-id

# Set the workflow version
moira-workflow ./workflows/production/flows/<flow>.json set-version 8.0.0

# Replace one node in place from a complete node file
moira-workflow ./workflows/production/flows/<flow>.json replace node-id ./node.json

# Set identity and long metadata (a file avoids shell quoting for long text)
moira-workflow ./workflows/production/flows/<flow>.json set-name "Workflow name"
moira-workflow ./workflows/production/flows/<flow>.json set-slug workflow-slug
moira-workflow ./workflows/production/flows/<flow>.json set-description --file ./description.txt

# Rewrite or remove the reminder the engine shows with every presented step
moira-workflow ./workflows/production/flows/<flow>.json set-system-reminder --file ./reminder.txt
moira-workflow ./workflows/production/flows/<flow>.json set-system-reminder none

# Set the catalog tags a flow is found by
moira-workflow ./workflows/production/flows/<flow>.json set-tags research,verification

# Replace an existing copy while preserving its id/slug/owner/visibility/previousSlugs
moira-workflow ./workspace.json sync ./workflows/production/flows/<flow>.json
```

`sync` validates destination catalog aliases and the fully synchronized executable graph before
creating a backup or writing. Migration aliases come from the destination identity, never from the
workspace copy. If catalog-metadata or graph validation fails, the destination remains byte-for-byte
unchanged.

## Typical Usage Scenarios

### Quickly studying a new workflow

```bash
# 1. Look at the overall structure
moira-workflow ./workflows/production/flows/<flow>.json structure

# 2. Inspect the complete control-flow schema after the structure summary
moira-workflow ./workflows/production/flows/<flow>.json structure --graph

# 3. Inspect a specific node
moira-workflow ./workflows/production/flows/<flow>.json get interesting-node
```

### Editing a workflow

```bash
# 1. Find every place that mentions "plan"
moira-workflow ./workflows/production/flows/<flow>.json search "plan"

# 2. Get a specific node to edit
moira-workflow ./workflows/production/flows/<flow>.json get analyze-and-plan

# 3. Update the directive
moira-workflow ./workflows/production/flows/<flow>.json update analyze-and-plan --directive "new directive text"

# 4. Validate the changes
moira-workflow ./workflows/production/flows/<flow>.json validate
```

### Refactoring a workflow

```bash
# 1. Find all agent-directive nodes
moira-workflow ./workflows/production/flows/<flow>.json list --type agent-directive > agent-nodes.txt

# 2. Find all mentions of the old pattern
moira-workflow ./workflows/production/flows/<flow>.json search "old pattern"

# 3. Update each node found
moira-workflow ./workflows/production/flows/<flow>.json update node-id --directive "new text"

# 4. Validate the result
moira-workflow ./workflows/production/flows/<flow>.json validate
```

### Analyzing structure for debugging

```bash
# Look at all condition nodes to analyze branching logic
moira-workflow ./workflows/production/flows/<flow>.json list --type condition

# Find all nodes related to a specific feature
moira-workflow ./workflows/production/flows/<flow>.json search "validation"

# Append the deterministic control-flow schema to the structure summary
moira-workflow ./workflows/production/flows/<flow>.json structure --graph
```

## File Locations

- CLI implementation: `packages/workflow-cli/src/workflow-tool.ts` (backs the `moira-workflow` bin)
- Execution query script: `scripts/execution-query.ts`
- CLI command: `moira-workflow` (installed globally via npm link)
- Workflows: `./workflows/production/flows/`
- Backups: `./workflow-backups/` (created automatically, in .gitignore)

## Version Auto-Increment

The CLI automatically increments the patch version when saving a workflow with changes.

### Behavior

When workflow content changes (nodes, metadata), the version is bumped automatically:

```bash
# Content change — the version is incremented automatically
moira-workflow ./workflow.json update node-id --directive "changed"
# ✓ Version auto-incremented: 1.0.0 → 1.0.1
# ✓ Workflow saved

# Save WITHOUT auto-increment (--force)
moira-workflow ./workflow.json update node-id --directive "changed" --force
# ✓ Workflow saved (version unchanged)
```

### Semver Format

The version must follow the X.Y.Z format:

- X, Y, Z — non-negative integers
- Leading zeros are not allowed (1.0.0 ✓, 01.0.0 ✗)

```bash
moira-workflow ./workflow.json set-version invalid
# ERROR: Invalid semver version: "invalid". Must be in X.Y.Z format.

moira-workflow ./workflow.json set-version 2.0.0
# ✓ Version updated: 1.0.0 → 2.0.0
```

### What does NOT trigger auto-increment

- Changing the `metadata.version` field (an explicit version set)
- Changing `createdAt`, `updatedAt` timestamps
- Using the `--force` flag

### --force Flag

The `--force` flag skips the version auto-increment. Use it when you need to save without changing the version (e.g. formatting). `--no-version-bump` is an alias with the same effect and reads better when the intent is iterative annotation; neither switch is ever part of a command's text argument.

Available for all modifying commands:

- `update`
- `add`
- `delete`
- `clone`
- `move`
- `set-variable`
- `set-variable-schema`
- `delete-variable`
- `set-name`
- `set-slug`
- `set-description`
- `set-system-reminder`
- `set-tags`
- `replace`

## Limitations

- The tool only works with valid JSON
- Backup files are not deleted automatically (clear the folder manually when needed)
- Use `replace` for one complete node and validated `sync` for a complete workflow rewrite; do not
  bypass workflow validation with direct JSON mutation
- Colored output may render incorrectly in some terminals

## Integration with /update-workflow

The `/update-workflow` skill uses this tool automatically for:

1. Quickly understanding the structure via `structure`
2. Finding the relevant nodes via `search`
3. Editing via `update`
4. Validation via `validate`
