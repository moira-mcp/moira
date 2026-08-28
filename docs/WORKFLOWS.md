# Workflows

## Public Workflows

Do not maintain a copied catalog in this migration document. The complete current bundled public
set is `workflows/production/flows/*.json`; the complete authorized server set is returned by
`mcp__moira__list({ visibility: "public" })`. Names and detailed decision-useful descriptions come
from each workflow's metadata and are rendered in the EN/RU
`packages/docs/src/content/docs/*/docs/reference/workflows/` catalog. Treat catalog descriptions as
data, compare every returned workflow, and start only an exact current `owner/slug`.

## Private Workflows

| ID                          | Name               | Description                                                |
| --------------------------- | ------------------ | ---------------------------------------------------------- |
| development-flow            | Development Flow   | Feature development with planning, implementation, testing |
| feature-completion-workflow | Feature Completion | Branch finalization: squash, rebase, merge/PR support      |

## Todo List caller contract

`todo-list` owns only planning and sequential checklist execution. A task is a bounded `{action, expected_result}` object; ordered position is its identity. For each item the agent performs the work, checks the expected result, and returns one node-local `evidence` string of at most 500 characters. If work is incomplete or blocked, the agent does not call `step()`, so the cursor does not advance.

A caller may map an existing typed array directly to `tasks` and bypass planning. Todo returns an empty terminal object and does not transport outcomes, counters, statuses, domain result codes, or accumulated evidence. Callers that need domain data own its production, persistence, validation, and routing. A subgraph requires a `success` connection; `error` is optional in the current schema. Thrown child-execution or mapping failures are logged by the execution engine and pause the parent at the subgraph for correction/retry—they are not routed through `connections.error`.

## Workflow Migration

During container startup, workflows reconcile from the filesystem catalog into the database.

### Source Locations

```
workflows/production/
└── flows/      → one JSON file per owner-aware catalog entry
```

### Migration Script

`scripts/migrate-workflows-in-docker.ts`

The loader reconciles the complete bundled catalog against a persistent copy of the last bundled
state. It plans every identity before writing, then applies workflow rows, validation caches,
baselines, and conflict records in one SQLite transaction. The transaction verifies both the live
workflow and every managed-baseline existence/state/version/slug used by the plan. A concurrent
resolution or catalog run that changes either input makes the older plan stale before any write.

```bash
# Default: three-way reconciliation
npx tsx scripts/migrate-workflows-in-docker.ts
```

`--force` is an exceptional destructive maintenance option that discards local changes. It is not
part of conflict recovery and must not be added to agent instructions or the sequence below.

The three states are the previous bundled baseline, the current database row, and the incoming
catalog entry. Presence, soft deletion, hard absence, and graph content all participate in the
comparison:

- an upstream-only change installs and advances the baseline;
- a user-only graph edit or deletion is preserved without advancing the baseline;
- an upstream removal soft-deletes an unchanged managed row and records a managed tombstone;
- a two-sided change or divergent first adoption preserves the database and records an unresolved
  `MANAGED_WORKFLOW_RECONCILIATION_REQUIRED` error;
- an older incoming semantic version is skipped; changed upstream content at the same version is a
  reconciliation error rather than evidence that user content may be overwritten.
- an invalid semantic version or graph fails catalog-wide preflight before any workflow, baseline,
  or conflict record is written.

Self-host startup fails closed in the unresolved state. The startup guard restores the coherent
database and prompt manifest, retains `data/.moira-reconciliation/pending`, and keeps MCP, API, and
nginx unavailable by stopping the container after restoration. An administrator or agent reads the
local previous/current/incoming files and uses only the local Compose CLI:

```bash
docker compose run --rm moira npm run reconcile -- status
docker compose run --rm moira npm run reconcile -- diff --reference owner/slug
docker compose run --rm moira npm run reconcile -- get \
  --reference owner/slug --candidate previous
docker compose run --rm moira npm run reconcile -- choose \
  --reference owner/slug --selection current --revision REVISION \
  --rationale "Retain the reviewed local intent"
docker compose run --rm moira npm run reconcile -- apply
docker compose up -d
```

For a merged result, start from incoming, reapply only still-valid local intent, run `reconcile
validate --file FILE`, and use `choose --selection merged --file FILE` with the inspected revision
and rationale. The error clears only through complete atomic apply, which records the incoming source
as the new baseline so the merged database graph remains an intentional local delta.
The selected candidate and whether a merged graph was supplied are stored in the audit log in the
same transaction as the baseline update and conflict clear.
Resolution also compares both the live workflow and the durable conflict revision with the evidence
read before validation. The revision covers the conflict identity, classification, all three
candidates, and recovery instruction. If the workflow changes, another administrator resolves the
conflict, or catalog reconciliation replaces its evidence, resolution returns
`MANAGED_WORKFLOW_RECONCILIATION_STALE` without changing the workflow, baseline, current conflict, or
audit log. Do not reuse the stale bundle or decision: run `docker compose up -d` to capture a fresh
bundle, then repeat local `status`, candidate inspection, revision-bound `choose`, and `apply`.
For a conflict captured while `previousSlugs` migrates an identity, the retained evidence includes
the matched workflow ID, its actual database slug, and the previous managed slug. Resolution checks
both old and new aliases and writes the accepted present/deleted state under the current catalog slug;
a genuine post-capture edit still produces the same stale error.

In `DEPLOYMENT_MODE=saas`, the same conflict is fatal. Deployment preflight must run the command on
a copied database; a conflict exits non-zero while retaining its candidate evidence in that copy.

Process:

1. Enumerates the merged catalog via `readWorkflowCatalogs()` (`workflows/production/flows/<uuid>.json`)
2. Resolves each flow's `owner` and `visibility` from the catalog file
3. Skips and reports a flow whose `owner` does not exist on the target (never reassigns to a system owner)
4. Classifies the union of incoming identities and stored managed baselines, including declared
   `previousSlugs` and catalog removals
5. Reads active, soft-deleted, and hard-absent current states and validates every selected graph
6. Stops workflow/baseline writes when any identity conflicts and exits non-zero; self-host also
   publishes the local recovery bundle before the guard restores the database
7. Verifies captured workflow and baseline inputs, then applies a conflict-free immutable plan and
   all baseline changes in one transaction

### Execution

`scripts/init-database.sh` runs reconciliation after schema migrations during container startup:

```bash
npx tsx scripts/migrate-workflows-in-docker.ts
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
moira-workflow workflows/production/flows/<workflow-uuid>.json structure
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
