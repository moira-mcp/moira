---
title: Workspace Pattern
description: Organize workflow files in a dedicated workspace directory
---

## Purpose

Create a dedicated workspace directory for workflow execution. All working files (plans, results, reports, backups) are stored in one location, keeping the project clean.

## Structure

```
./agent_temp_files_local/moira-ws/{workspace-name}/
├── process-id.txt       # Workflow execution ID for recovery
├── development-plan.md  # Plans and specifications
├── step-1/              # Step-specific results
│   └── step-results.md
├── *.backup.json        # Backup files
└── ...                  # Other working files
```

## Workspace Location

Use the current project's designated ignored working directory. For example:

```
./agent_temp_files_local/moira-ws/{workspace-name}/
```

:::caution
Follow project and caller ownership rules. Do not create an arbitrary directory in the project root or reuse another execution's workspace.
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

An existing early responsibility resolves the canonical workspace path. If later nodes need a shared
`workspace_path`, declare its string registry entry and promote the owner's answer with `globalInputs`. A node whose only job is choosing or creating a directory adds a turn without
adding judgment.

When stable files come from workflow registry defaults, place a `materialize` node immediately after
that owner. It supplies delivery instructions for one immutable owner archive. The agent executes the supported extraction command or the declared context fallback; returning from the node does not prove files were created.

This generic declaration fragment is independent of the bundled Workflow Management Flow. It
assumes string registry entries `workspace_process_id_file` and `workflow_reference` with stable
default bodies, an established `workspace_path`, and a `create-plan` successor:

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

Reference `{{workspace_path}}` in subsequent directives. If a path uses `current_step`, declare and initialize that number for its actual consumer.

```json
{
  "directive": "Save development plan to {{workspace_path}}/development-plan.md"
}
```

```json
{
  "directive": "Create step results in {{workspace_path}}/step-{{current_step}}/step-results.md"
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

Keep the designated workspace ignored. Use a local Git exclude unless project policy authorizes a tracked ignore change. For the example location:

```text
# Moira workflow workspaces
agent_temp_files_local/
```

Workspaces are temporary working directories and should not be committed.

## Recovery

When workflow is interrupted, agent can:

1. Read the owned workspace handoff and `process-id.txt`.
2. Confirm that execution belongs to this task and has not been cancelled or replaced.
3. Inspect its current status and step with `execution`; continue from the engine's current state under the caller's recovery authority.

```json
{
  "directive": "Inspect the task-owned workspace handoff and execution status. Resume only the matching active execution when authorized; a found process ID alone is not permission to resume."
}
```

## Workflow Management Flow Example

Workflow Management Flow resolves `workspace_path`, materializes the process ID, thematic references
and starting templates shared by both branches, and then routes to create or edit work:

```text
get-action-type
  -> materialize-workspace-bootstrap
  -> route-action-type
       | create -> gather-workflow-requirements
       | edit   -> prepare-edit-workflow
```

The archive writes `process-id.txt`, thematic Markdown files under `reference/`, and starting JSON
workflows under `reference/templates/`. String defaults named `workflow_reference_*` and
`workflow_template_*` supply those bodies. Each consumer reads the files its directive names; the
create and edit owners then write their branch-specific requirements and provenance without
duplicating stable references. The [Materialize Files example](/docs/reference/materialize/#apply-it-in-workflow-management-flow)
shows the actual bootstrap paths and registry sources.

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
