# Moira Workflow CLI

CLI for managing Moira workflows: editing, validation, analysis.

## Installation

```bash
cd packages/workflow-cli
npm link
```

## Usage

```bash
moira-workflow <workflow-file> <command> [options]
moira-workflow --version
```

`--version` prints both the package version and the exact CLI source path. Check it when
multiple Moira checkouts exist: the path makes a stale global link immediately visible.

## Commands

```bash
# Inspection
moira-workflow flow.json get <node-id>
moira-workflow flow.json list [--type <type>]
moira-workflow flow.json structure [--graph] [--detailed]
moira-workflow flow.json schema
moira-workflow flow.json search <text>
moira-workflow flow.json validate

# Variables
moira-workflow flow.json list-variables
moira-workflow flow.json get-variable <name>
moira-workflow flow.json set-variable <name> <value>
moira-workflow flow.json set-variable-schema <name> '<json-schema>'
moira-workflow flow.json set-variable-schema <name> --file <schema.json>
moira-workflow flow.json delete-variable <name>
moira-workflow flow.json variables [--usage]

# Editing
moira-workflow flow.json update <node-id> --directive "text"
moira-workflow flow.json update <node-id> --completion-condition "text"
moira-workflow flow.json clone <node-id> <new-id>
moira-workflow flow.json delete <node-id>
moira-workflow flow.json move <node-id> --after <target-id>
moira-workflow flow.json add <nodes.json>
moira-workflow flow.json replace <node-id> <node.json>
moira-workflow flow.json set-name "Workflow name"
moira-workflow flow.json set-slug workflow-slug
moira-workflow flow.json set-description "Short description"
moira-workflow flow.json set-description --file <description.txt>

# Versioning
moira-workflow flow.json set-version <version>

# File operations
moira-workflow flow.json export-node <node-id> <output.json>
moira-workflow flow.json diff <other-file.json>
moira-workflow flow.json copy <dest.json> [--name "New Name"]
moira-workflow flow.json sync <existing-dest.json>
moira-workflow create <file.json> --name "Name"
```

`sync` preserves the destination workflow identity (`id`, `slug`, `owner`, and
`visibility`) plus its catalog migration aliases in `previousSlugs`. Catalog aliases are
validated by the catalog reader and excluded from the executable graph passed to the engine
validator. The CLI validates the fully synchronized executable workflow before restoring the
destination aliases, creating a backup, or writing. Metadata or graph errors leave the destination
byte-for-byte unchanged.

## update Options

```bash
--directive "text"              # Update directive
--directive-file <path>         # Directive from file
--completion-condition "text"   # Update completionCondition
--input-schema '{"type":"..."}'  # Update inputSchema
--condition "expr"              # Update condition
--message "text"                # Update message
--connections '{"key":"target"}' # Update connections
--add-connection <key> <target> # Add connection
--remove-connection <key>       # Remove connection
```

## Examples

```bash
# Find nodes containing text
moira-workflow dev-flow.json search "validation"

# Show structure followed by the deterministic control-flow schema
moira-workflow dev-flow.json structure --graph --detailed

# Print the complete deterministic control-flow schema for agent inspection
moira-workflow dev-flow.json schema

# Update a directive from a file
moira-workflow dev-flow.json update analyze-step --directive-file ./new-directive.md

# Clone a node
moira-workflow dev-flow.json clone step-1 step-1-copy

# Confirm which checkout supplies a globally linked CLI
moira-workflow --version
```

## Backups

Every change creates a backup in `workflow-backups/` before writing.

## Versioning

Content changes automatically increment the patch version (X.Y.Z).
Use `--force` to skip the version check.
