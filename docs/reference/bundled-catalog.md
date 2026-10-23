# Bundled catalogs and prompt reconciliation

This reference explains checked-in definitions becoming managed installation state. For authoring
commands use the [workflow CLI](workflow-cli.md); for runtime continuation use
[execution](execution.md). User-facing workflow selection belongs to the website catalog and
current authorized MCP discovery, not a copied list here.

## Catalog ownership

Public bundled definitions live in `workflows/production/flows/`, with UUID-named JSON files.
Reviewed demonstrations in `workflows/examples/flows/` are testable examples and are not installed
as production catalog entries. Personal exports and backups stay outside these tracked directories.

A file carries catalog `owner`, `slug`, `visibility` and optional `previousSlugs`, alongside the
executable graph. Identity is `(owner, slug)`, not slug alone. The loader removes catalog metadata
from the graph body. The owner is an installation user identity; do not substitute a guessed
runtime handle or silently reassign a missing owner to a system account.

`getWorkflowsDirs()` resolves `WORKFLOWS_DIRS` (colon-separated), then `WORKFLOWS_DIR`, then
`./workflows/production`. Later directories override earlier entries only on the same owner/slug.
Private deployments add their catalog through this boundary; private definitions and operations
do not belong in the OSS catalog. Malformed metadata fails loudly, and ambiguous slug-only lookup
requires disambiguation.

## Workflow reconciliation

Startup runs `scripts/migrate-workflows-in-docker.ts`. The loader compares the previous managed
baseline, current database state and incoming catalog, including content, presence, soft deletion
and declared slug transitions. It validates the catalog before applying a selected workflow plan.

| Current situation                               | Result                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| Only upstream changed                           | Install the incoming state and advance its baseline              |
| Only local state changed                        | Preserve local intent without pretending it is incoming baseline |
| Upstream removed an unchanged managed workflow  | Soft-delete it and record a managed tombstone                    |
| Both sides changed, or divergent first adoption | Preserve the database and retain reconciliation evidence         |
| Incoming version is older                       | Skip the older entry                                             |
| Incoming content changes under the same version | Report a reconciliation error                                    |
| Owner is missing                                | Skip and report; do not transfer ownership                       |

Workflow rows, validation caches, baseline changes and conflict records are applied atomically
after rechecking the captured workflow and baseline inputs. Concurrent reconciliation/resolution
can invalidate an older plan before it writes. The source implementation is
`packages/shared/src/services/workflow-catalog-loader.ts` with the shared managed-resource
reconciler; do not recreate its classification algorithm in deployment scripts.

The migration script also asks the engine which paused runs a planned replacement would make
unusable, and warns about every paused run affected by removal. That warning is advisory rather
than a separate deployment refusal. A replaced definition may be recoverable through diagnosis
and recovery; removal leaves no definition to continue against. The installer records whether
this judgment ran, so absence of a warning alone does not prove compatibility was checked.

## Self-host conflict recovery

An unresolved workflow conflict blocks initialization. The self-host startup guard restores the
coherent database and prompt manifest, retains a local recovery bundle under
`data/.moira-reconciliation/`, and keeps application services stopped. Do not assume the ordinary
web UI remains available or bypass initialization sentinels.

Use the same installation's one-off Compose service while its ordinary writer is stopped:

```bash
docker compose run --rm moira npm run reconcile -- status
docker compose run --rm moira npm run reconcile -- diff --reference REFERENCE_FROM_STATUS
docker compose run --rm moira npm run reconcile -- get \
  --reference REFERENCE_FROM_STATUS --candidate previous
docker compose run --rm moira npm run reconcile -- get \
  --reference REFERENCE_FROM_STATUS --candidate current
docker compose run --rm moira npm run reconcile -- get \
  --reference REFERENCE_FROM_STATUS --candidate incoming
```

Read all three complete candidates. For a semantic merge, start from incoming and reapply only
still-valid local intent. Validate the merged state file with `reconcile validate --file FILE`.
Copy the exact reference and conflict revision printed by the current bundle:

```bash
docker compose run --rm moira npm run reconcile -- choose \
  --reference REFERENCE_FROM_STATUS --selection current --revision INSPECTED_REVISION \
  --rationale "Retain the reviewed local intent"
docker compose run --rm moira npm run reconcile -- apply
docker compose up -d
```

For a merged candidate use `--selection merged --file FILE`; `incoming` is also an explicit
selection. `choose` stores a revision-bound decision without changing the workflow database.
Complete `apply` validates the current catalog, live workflow and durable conflict evidence before
committing all decisions. Its audit records the selection and whether merged content was supplied.
The incoming source becomes the managed baseline, leaving a merged graph as an intentional local
delta.

`MANAGED_WORKFLOW_RECONCILIATION_STALE` means captured evidence changed. Do not reuse its choice or
edit the bundle to bypass it. Restart normal initialization to capture a fresh bundle, inspect
`status` and candidates again, and make a decision bound to the new revision. Slug transitions
retain the matched workflow identity and previous/current aliases so a concurrent edit cannot be
hidden by a rename. A committed bundle cannot accept new choices; repeated apply can finish its
local cleanup without rewriting the accepted database decision.

The migration command's `--force` discards local changes. It is a destructive maintenance action,
not the ordinary recovery procedure or an automatic answer to a conflict.

In SaaS mode an unresolved conflict is fatal as well. Deployment infrastructure owns preflight
against a copied database before swapping production; public self-host recovery commands do not
grant authority to run a private deployment.

## Bundled playbooks

Playbooks use `<catalog>/playbooks/<uuid>.json`, carrying owner, slug, name, description, visibility,
semantic version and content. They are installed before flows so bundled references can resolve.
Their reader and installer live in `packages/shared/src/services/playbook-catalog.ts`.

Three-way comparison preserves local text and applies upstream-only changes as a new playbook
revision. Older incoming versions are skipped; changed content without a version increase is a
conflict. A missing owner is reported and skipped. A playbook conflict keeps its stored text and
baseline and is reported on subsequent starts, but does not itself block initialization. This is
different from an executable workflow conflict.

A playbook removed from the catalog remains installed because workflows and copies may still
reference it. Bundled flow references must resolve to the shipped public system-owner playbooks;
use the current owner-qualified reference rather than a personal playbook with the same slug.

## Prompt files and database settings

`scripts/prompt-migration.ts` synchronizes the declared prompt, reminder, error-message and
validation-help files under `config/prompts/`. The manifest lives beside the selected SQLite
database as `prompt-manifest.json`. Agent/model override paths are discovered by that script;
static typed tool descriptions are outside this mechanism.

A missing database key is inserted from its processed file. When a database value has no manifest
entry, migration adopts its current hash as baseline and preserves the value on that first pass,
even if the file differs. A later unchanged database value can advance to the file. A manually
edited value is preserved and reported as a conflict. Removing a managed override deletes its
database row only when it still matches the recorded hash; a divergent override remains.

Null is treated as an empty string for hashing. Database writes use one transaction, but a
reported conflict is not a transaction exception: other nonconflicting database writes may commit.
The manifest is written only when there are no conflicts. `PROMPT_CONFLICT_FATAL=1` makes the
command fail on conflicts; otherwise startup reports them and retains their database values.
Preserve database and manifest together during recovery rather than deleting evidence to force a
file overwrite.

The sole English file default and the effective model/agent/database lookup are distinct owners;
see [documentation source ownership](../development/documentation.md#default-and-effective-instructions).
