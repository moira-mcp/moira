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
```

## Commands

```bash
# Inspection
moira-workflow flow.json get <node-id>
moira-workflow flow.json list [--type <type>]
moira-workflow flow.json structure [--graph] [--detailed]
moira-workflow flow.json search <text>
moira-workflow flow.json validate

# Variables
moira-workflow flow.json list-variables
moira-workflow flow.json get-variable <name>
moira-workflow flow.json set-variable <name> <value>
moira-workflow flow.json delete-variable <name>
moira-workflow flow.json variables [--usage]

# Editing
moira-workflow flow.json update <node-id> --directive "text"
moira-workflow flow.json update <node-id> --completion-condition "text"
moira-workflow flow.json clone <node-id> <new-id>
moira-workflow flow.json delete <node-id>
moira-workflow flow.json move <node-id> --after <target-id>
moira-workflow flow.json add <nodes.json>

# Versioning
moira-workflow flow.json set-version <version>

# File operations
moira-workflow flow.json export-node <node-id> <output.json>
moira-workflow flow.json diff <other-file.json>
moira-workflow flow.json copy <dest.json> [--name "New Name"]
moira-workflow create <file.json> --name "Name"
```

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

# Show structure with the flow graph
moira-workflow dev-flow.json structure --graph --detailed

# Update a directive from a file
moira-workflow dev-flow.json update analyze-step --directive-file ./new-directive.md

# Clone a node
moira-workflow dev-flow.json clone step-1 step-1-copy
```

## Backups

Every change creates a backup in `workflow-backups/` before writing.

## Versioning

Content changes automatically increment the patch version (X.Y.Z).
Use `--force` to skip the version check.
