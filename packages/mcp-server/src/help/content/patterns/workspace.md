---
title: Workspace Pattern
description: Organize workflow files in a dedicated workspace directory
---

## Purpose

Create a dedicated workspace directory for workflow execution. All working files (plans, results, reports, backups) are stored in one location, keeping the project clean.

## Structure

```
./moira-ws/{workspace-name}/
├── process-id.txt       # Workflow execution ID for recovery
├── development-plan.md  # Plans and specifications
├── step-1/              # Step-specific results
│   └── step-results.md
├── *.backup.json        # Backup files
└── ...                  # Other working files
```

## Workspace Location

All workspaces are created in `./moira-ws/` subdirectory of the **current project**:

```
./moira-ws/{workspace-name}/
```

:::caution
Do NOT create workspaces in project root (`./feature-name/`) or other locations. Always use
`./moira-ws/` for consistency.
:::

## Naming Convention

Format: `{short-name}-{YYYYMMDD}-{HHMM}`

- `short-name`: Brief task description (max 20 chars, kebab-case)
- Date and time of creation

Examples:

- `wmf-edit-20251211-2145`
- `auth-fix-20251212-0930`
- `api-refactor-20251215-1400`

## Implementation

### The workspace owner

An existing early responsibility resolves the canonical workspace path and returns it as the global
`workspace_path`. A node whose only job is choosing or creating a directory adds a turn without
adding judgment.

When stable files come from workflow registry defaults, place a `materialize` node immediately after
that owner. It creates the destination and extracts all declared files through one bounded archive,
without putting their bodies in the agent context:

```json
{
  "id": "materialize-workspace-bootstrap",
  "type": "materialize",
  "basePath": "{{workspace_path}}",
  "files": [
    { "path": "process-id.txt", "from": "workspace_process_id_file" },
    { "path": "workflow-reference.md", "from": "workflow_reference" },
    { "path": "plans/.keep", "content": "" }
  ],
  "connections": { "success": "create-plan" }
}
```

The referenced registry entries are the source of truth for stable workflow-authored content. The
substantive owner still writes dynamic task contracts, analyses, plans, and reports in the same turn
that determines their content. A returned path proves nothing by itself: the completion condition of
the first consumer must require any files it depends on to exist and be complete.

See [Materialize Files](/docs/reference/materialize/) for the complete declaration, archive, path,
security, and failure contract.

### Using the workspace path

Reference `{{workspace_path}}` in subsequent directives:

```json
{
  "directive": "Save development plan to {{workspace_path}}development-plan.md"
}
```

```json
{
  "directive": "Create step results in {{workspace_path}}step-{{current_step}}/step-results.md"
}
```

## What Goes in Workspace

**Include:**

- `process-id.txt` - Execution ID for workflow recovery
- Plans and specifications (`.md` files)
- Step results and reports
- Backup files before editing
- Temporary analysis outputs

**Exclude:**

- Project source code
- `node_modules` or dependencies
- Large binary files
- Sensitive credentials

## Git Configuration

Add `./moira-ws/` to `.gitignore`:

```gitignore
# Moira workflow workspaces
moira-ws/
```

Workspaces are temporary working directories and should not be committed.

## Recovery

When workflow is interrupted, agent can:

1. Read `process-id.txt` from workspace
2. Resume execution using saved process ID
3. Continue from last completed step

```json
{
  "directive": "Check for existing workspace in ./moira-ws/\nIf found, read process-id.txt and resume workflow"
}
```

## Workflow Management Flow Example

Workflow Management Flow resolves `workspace_path`, materializes the two stable files shared by both
branches, and then routes to create or edit work:

```text
get-action-type
  -> materialize-workspace-bootstrap
  -> route-action-type
       | create -> gather-workflow-requirements
       | edit   -> prepare-edit-workflow
```

The archive writes `process-id.txt` and `workflow-authoring-reference.md`. The create and edit owners
then write their branch-specific requirements and provenance; they do not duplicate the stable files.

## Converting a Manual Bootstrap

Move stable workflow-authored bodies to string registry defaults and deliver them through one
`materialize` node. Remove only the matching static write instructions from agent directives. Keep
dynamic files with the responsibility that judges their contents, and have its completion condition
verify the required files on disk.

## Related Patterns

- [Minimal Graph](/docs/patterns/minimal-graph/) - what earns a separate agent turn
- [Dynamic Files](/docs/patterns/dynamic-files/) - Use `{{workspace_path}}` in file paths
- [Materialize Files](/docs/reference/materialize/) - Deliver stable registry-backed workspace files
- [Step Verification](/docs/patterns/step-verification/) - Store verification results in workspace
