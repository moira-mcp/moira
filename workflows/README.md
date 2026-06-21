# Workflows

Workflow definitions for MCP Moira workflow engine.

## Directory Structure

```
workflows/
├── production/
│   ├── public/    → Available to all users
│   └── private/   → Internal workflows only
└── README.md      → This file
```

## Migration

During Docker build, workflows migrate from filesystem to database.

```bash
# Default: skip existing workflows
npm run workflow:migrate

# Force overwrite all workflows
npm run workflow:migrate -- --force
```

## Documentation

- Technical reference: [docs/WORKFLOWS.md](/docs/WORKFLOWS.md)
- User documentation: [{MOIRA_HOST}/docs/reference/workflows](https://{MOIRA_HOST}/docs/reference/workflows/)
