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
```

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

- A visual graph of flows between nodes
- Shows how nodes are connected to each other
- Marks conditional transitions (true/false)

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
moira-workflow -- create ./new-workflow.json --name "My Workflow"

# With description and version
moira-workflow -- create ./new-workflow.json --name "My Workflow" --description "Description" --version "1.0.0"

# From a template
moira-workflow -- create ./new-workflow.json --name "My Workflow" --template ./template.json
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
```

## Typical Usage Scenarios

### Quickly studying a new workflow

```bash
# 1. Look at the overall structure
moira-workflow ./workflows/production/flows/<flow>.json structure

# 2. Visualize the graph
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

# Look at the connection graph to understand the flow
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

The `--force` flag skips the version auto-increment. Use it when you need to save without changing the version (e.g. formatting).

Available for all modifying commands:

- `update`
- `add`
- `delete`
- `clone`
- `move`
- `set-variable`
- `delete-variable`

## Limitations

- The tool only works with valid JSON
- Backup files are not deleted automatically (clear the folder manually when needed)
- Complex transformations are not supported (use jq or direct editing for those)
- Colored output may render incorrectly in some terminals

## Integration with /update-workflow

The `/update-workflow` skill uses this tool automatically for:

1. Quickly understanding the structure via `structure`
2. Finding the relevant nodes via `search`
3. Editing via `update`
4. Validation via `validate`
