# Workflows

Workflow definitions for MCP Moira workflow engine.

## Directory Structure

```
workflows/
├── production/
│   └── flows/     → Public catalog, one UUID-named JSON file per workflow
└── README.md      → This file
```

## Migration

During Docker build, workflows migrate from filesystem to database.

Only `workflows/production/flows/` is an OSS catalog source. Personal exports and local backups
must stay outside the repository; they are not examples and must never be added to a production
catalog directory. Private deployments supply their additional catalog through `WORKFLOWS_DIRS`.

```bash
# Default: skip existing workflows
npm run workflow:migrate

# Force overwrite all workflows
npm run workflow:migrate -- --force
```

## Documentation

- Technical reference: [docs/WORKFLOWS.md](/docs/WORKFLOWS.md)
- User documentation: [{MOIRA_HOST}/docs/reference/workflows](https://{MOIRA_HOST}/docs/reference/workflows/)
