# Workflows

## Public Workflows

| ID                             | Name                      | Description                                                            |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| software-development-flow      | Software Development      | Complete feature development cycle with planning and validation        |
| software-development-flow-lite | Software Development Lite | Lightweight development process for small features (1-5 steps)         |
| quick-task ⭐                  | Quick Task (Recommended)  | Fast task execution for 2-10 step tasks. Use for most tasks            |
| robust-task                    | Robust Task               | Reliable execution of complex critical tasks with retry and escalation |
| user-onboarding                | User Onboarding           | Interactive onboarding for new Moira users                             |
| content-creation               | Content Creation          | Text content creation: articles, posts, documentation                  |
| verified-research              | Verified Research         | Research with verified and reproducible sources                        |
| iterative-research             | Iterative Research        | Iterative research with critique/improve cycle                         |
| prd-creation                   | PRD Creation              | Product Requirements Document with completeness guarantees             |
| ux-design                      | UX Design                 | UX/UI design with WCAG AA accessibility verification                   |
| test-generation                | Test Generation           | Automated test code generation (unit, integration, e2e)                |
| test-planning                  | Test Planning             | Test plan creation with P0-P3 prioritization                           |
| data-analysis                  | Data Analysis             | Data analysis from problem definition to conclusions                   |
| marketing-campaign             | Marketing Campaign        | Marketing materials with differentiation focus                         |
| workflow-management-flow       | Workflow Management       | Workflow creation, editing, and deployment                             |
| bug-hunting-workflow           | Bug Hunting               | Systematic bug investigation                                           |
| smart-purchase-assistant       | Smart Purchase            | Purchase decision assistance                                           |
| telegram-setup                 | Telegram Setup            | Guided Telegram bot configuration for workflow notifications           |
| todo-list                      | Todo List                 | Autonomous agent task list for subtask management (no human gates)     |

## Private Workflows

| ID                          | Name               | Description                                                |
| --------------------------- | ------------------ | ---------------------------------------------------------- |
| development-flow            | Development Flow   | Feature development with planning, implementation, testing |
| feature-completion-workflow | Feature Completion | Branch finalization: squash, rebase, merge/PR support      |

## Workflow Migration

During Docker build, workflows migrate from filesystem to database.

### Source Locations

```
workflows/production/
├── public/     → PUBLIC workflows (accessible to all users)
└── private/    → PRIVATE workflows (internal use only)
```

### Migration Script

`scripts/migrate-workflows-in-docker.ts`

**Idempotent behavior**: Existing workflows are skipped by default. Use `--force` to overwrite.

```bash
# Default: skip existing, compare versions
npx tsx scripts/migrate-workflows-in-docker.ts

# Force overwrite all workflows
npx tsx scripts/migrate-workflows-in-docker.ts --force
```

**Version comparison**:

- `local < server`: Skip with warning (server has newer version)
- `local = server` with content changes: FATAL error, exits with code 1 (use --force to override)
- `local > server`: Migrate (local is newer)

Process:

1. Enumerates the catalog via `readWorkflowCatalog()` (`workflows/production/flows/<uuid>.json`)
2. Resolves each flow's `owner` and `visibility` from the catalog file
3. Skips and reports a flow whose `owner` does not exist on the target (never reassigns to a system owner)
4. Checks if the flow exists for that owner via `WorkflowRepository.resolveSlug(slug, owner)`
5. Compares versions using semver comparison
6. Skips existing flows if local version ≤ server version (unless `--force`)
7. Saves new/updated flows via `WorkflowMutationService.save({ userId: owner, slug, visibility })`
8. Exits with error on content mismatch at same version

### Execution

Migration runs during Docker container startup:

```bash
moira-workflow:migrate
```

## Adding New Workflow

### 1. Create Workflow JSON

Place in `workflows/production/flows/` (file name = the flow's UUID). Include the catalog metadata
`owner` (owning user id, e.g. `system-moira` for public showcase flows, `system-admin` for private) and
`visibility`:

```json
{
  "id": "my-workflow",
  "slug": "my-workflow",
  "owner": "system-moira",
  "visibility": "public",
  "metadata": {
    "name": "My Workflow",
    "version": "1.0.0",
    "description": "Description"
  },
  "nodes": [
    { "id": "start", "type": "start", "connections": { "default": "first-step" } },
    {
      "id": "first-step",
      "type": "agent-directive",
      "directive": "...",
      "connections": { "success": "end" }
    },
    { "id": "end", "type": "end" }
  ]
}
```

### 2. Validate

```bash
moira-workflow workflows/production/public/my-workflow.json structure
```

### 3. Rebuild Docker

```bash
npm run docker:restart
```

Workflow migrates automatically during container startup.

### 4. Verify

```bash
mcp__moira__list()
# or
curl http://localhost:3032/api/workflows
```
