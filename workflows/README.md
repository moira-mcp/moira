# Workflows

Workflow definitions for MCP Moira workflow engine.

## Directory Structure

```
workflows/
├── production/
│   └── flows/     → Public catalog, one UUID-named JSON file per workflow
└── README.md      → This file
```

## Startup reconciliation

During container startup, Moira reconciles the complete filesystem catalog with the database and
the previous bundled baseline before it mutates any workflow.

Only `workflows/production/flows/` is an OSS catalog source. Personal exports and local backups
must stay outside the repository; they are not examples and must never be added to a production
catalog directory. Private deployments supply their additional catalog through `WORKFLOWS_DIRS`.

An upstream-only change updates the managed workflow. A user-only change is preserved. A two-sided
change preserves the database workflow and records previous/current/incoming candidates for a
semantic merge through Workflow Management Flow. Self-host remains available for recovery; SaaS
preflight treats the same unresolved conflict as fatal. The conflict-free plan and baseline changes
are applied in one SQLite transaction.

## Documentation

- Technical reference and operator commands: [docs/WORKFLOWS.md](../docs/WORKFLOWS.md)
- User documentation source: [Workflow reference](../packages/docs/src/content/docs/docs/reference/workflows/index.mdx)
