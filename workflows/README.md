# Workflows

Workflow definitions for MCP Moira workflow engine.

## Directory Structure

```
workflows/
├── examples/
│   └── flows/     → Tracked examples, not loaded into the bundled catalog
├── production/
│   └── flows/     → Public catalog, one UUID-named JSON file per workflow
└── README.md      → This file
```

## Startup reconciliation

Only `workflows/production/flows/` is an OSS catalog source. `workflows/examples/flows/` contains
reviewed demonstrations that remain testable without being installed or advertised as production
workflows. Personal exports and local backups must stay outside the repository; they are not
examples and must never be added to either tracked directory. Private deployments supply their
additional catalog through `WORKFLOWS_DIRS`.

Startup reconciles definitions with the database and previous bundled baseline. It preserves local
intent and captures previous/current/incoming evidence for divergent changes. An unresolved workflow
conflict blocks initialization, including self-host: ordinary application services remain stopped
while the existing one-off reconciliation command supports recovery. Follow the
[bundled catalog reference](../docs/reference/bundled-catalog.md) for identity, atomic application,
conflict recovery, Playbooks and prompt reconciliation rather than bypassing startup guards.

## Documentation

- File authoring and validation: [Workflow CLI](../docs/reference/workflow-cli.md)
- User documentation source: [Workflow reference](../packages/docs/src/content/docs/docs/reference/workflows/index.mdx)
