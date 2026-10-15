---
title: Troubleshooting
description: Common issues and solutions for AI agents working with MCP Moira
sidebar:
  order: 4
---

This guide helps recover from common issues when working with MCP Moira workflows.

## Context Recovery After Session Archive

When a conversation is archived or compacted, the agent loses:

- Current execution ID (processId)
- Workflow step context
- Progress information

The workflow state persists on the MCP server - only the agent's memory is lost.

### Recovery Steps

1. **Find active executions:**

```json
session({ action: "executions" })
```

Returns list of executions with status, workflow ID, and notes:

```json
[
  {
    "executionId": "abc-123",
    "workflowId": "development-flow",
    "status": "waiting",
    "note": "Feature: auth system",
    "currentNodeId": "implement-step"
  }
]
```

2. **Get current step without advancing:**

```json
session({ action: "current_step", executionId: "abc-123" })
```

Returns the current directive and context:

```json
{
  "attemptId": "attempt-current",
  "directive": "Implement the feature...",
  "completionCondition": "Feature working and tested",
  "inputSchema": { ... }
}
```

3. **Continue workflow:**

```json
step({ processId: "abc-123", attemptId: "attempt-current", input: { ... } })
```

### Process ID Preservation

To help future recovery, save the process ID in your workspace:

```bash
# Create process-id.txt in feature directory
echo "abc-123" > ./feature-name/process-id.txt
```

Include in session archives:

- Feature name
- Process ID
- Current step description

## Navigation Tools Reference

### session - executions

Lists all active workflow executions for current user.

**Call:** `session({ action: "executions" })`

**Filters:**

- `status`: Array of statuses - `["waiting", "running", "completed", "failed"]`
- `workflowId`: Filter by specific workflow
- `search`: Search in execution notes

**Example with filters:**

```json
session({
  action: "executions",
  status: ["waiting", "running"],
  search: "auth"
})
```

### session - current_step

Retrieves current step directive without advancing the workflow.

**Call:** `session({ action: "current_step", executionId: "..." })`

**Parameters:**

- `executionId` (required): Execution ID to check

**Returns:**

- `attemptId`: Identity required to submit this exact current presentation
- `directive`: What to do
- `completionCondition`: Success criteria
- `inputSchema`: Response structure

### session - execution_context

Gets full execution state including context variables.

**Call:** `session({ action: "execution_context", executionId: "..." })`

**Parameters:**

- `executionId` (required): Execution ID to inspect

**Returns:**

- `executionId`: Execution UUID
- `workflowId`: Workflow being executed
- `status`: Execution status (running, waiting, completed, failed)
- `currentNodeId`: Current node ID
- `waitingForInputNodeId`: Node waiting for input (if any)
- `taskTitle`: Canonical task name, independent of the arbitrary note
- `taskIdentity`: Persisted `{ title, changedAt, changeId }` or `null`
- `revision`, `metadataRevisions.taskIdentity`: Step and independent task-name revision
- `note`: Arbitrary execution note
- `context.variables`: Context variables
- `context.nodeStates`: Node execution states
- `createdAt`, `updatedAt`, `completedAt`: Timestamps
- `error`: Error message (if failed)

## Common Issues

### "Process not found or expired"

**Cause:** Invalid or expired processId

**Solution:**

1. Use `session({ action: "executions" })` to find active executions
2. Use the correct executionId from the list
3. Process IDs are UUIDs like `abc123-def456-...`

### "Execution is not waiting for input"

**Cause:** Trying to advance a completed or failed execution

**Solution:**

1. Check execution status with `session({ action: "execution_context", executionId: "..." })`
2. Status must be `waiting` to accept input
3. If `completed` or `failed`, start a new execution

### Validation Errors on step()

**Cause:** Input doesn't match inputSchema

**Solution:**

1. Check `inputSchema` from current step
2. Verify field names match exactly (case sensitive)
3. Verify data types match (string vs number)
4. Include all required fields

### `ATTEMPT_PROCESSING`

**Cause:** Another caller still has a live claim on this exact step mutation.

**Solution:** Retry with the same Process ID, Step attempt ID, and input. Do not replace the attempt
or alter the input.

### `ATTEMPT_STALE`

**Cause:** The attempt no longer matches the current execution presentation and was rejected before
handler work.

**Solution:** Automatically call `session({ action: "current_step", executionId: "..." })`, then
retry the intended submission once with the returned Step attempt ID. Do not reuse the stale ID.

### `ATTEMPT_CONFLICT`

**Cause:** The attempt is already bound to a different input and the new submission was rejected
before handler work.

**Solution:** Automatically call `session({ action: "current_step", executionId: "..." })`, discard
the conflicting attempt, and continue from the returned directive and input schema. Do not replay
the rejected input against the current presentation.

### `ATTEMPT_INVALID_OR_EXPIRED` for a step

**Cause:** The step attempt is unavailable and was rejected before handler work. This recovery
applies only when the error explicitly directs the caller to `current_step`; an unavailable start
attempt has no current step to recover.

**Solution:** Automatically call `session({ action: "current_step", executionId: "..." })`, discard
the unavailable attempt, and continue from the returned directive and input schema.

### `ATTEMPT_OUTCOME_UNKNOWN`

**Cause:** Moira could not prove whether a claimed mutation and its possible external effect
completed.

**Solution:** Inspect the execution with `session({ action: "current_step", executionId: "..." })`
and the relevant external system. Do not automatically retry the mutation.

### `CURRENT_PRESENTATION_STALE`

**Cause:** The persisted live attempt belongs to a different node, or to a continuation surface the
current definition no longer has: something the paused node declares about what it does changed, or
a registry entry for a global variable it declares as an input did. It cannot be safely rebound to
the current execution. A change that does not reach that surface does not produce this state — a
version or tag bump, an edit to another node, or a cosmetic change to the paused node itself all
leave the run usable.

**Solution:** Do not retry the old attempt. Call
`session({ action: 'diagnose', executionId: '...' })`, which names which facts of the paused step
changed, whether its node still exists, and anything else standing between the run and its next
step. Then repair the run with
`session({ action: 'recover', executionId: '...', nodeId: '<node to resume from>', variableValues: { ... } })`,
which re-presents it at the node you name with the values that step needs and returns a fresh Step
attempt ID to continue from. Name a node a run can wait on — an agent-directive, teleport,
materialize, lock or subgraph node; any other node is refused, because resuming there would run the
workflow forward instead of repairing it. The run comes to rest on the node you name and never goes
past it, but a `lock` node creates its lock and sends its approval code when the run arrives there,
and a `subgraph` node enters its child — choose one of those as the target only when you want that.
Recovery is also refused unless the run really cannot continue, and refused for a run that is already
finished or cancelled, which stays that way; a refusal changes nothing.
For a materialize target, recovery keeps the execution paused there. Perform its generated
delivery to obtain the current guide files; a context patch alone does not refresh local files.

### A task-name write is stale

Read `execution_context` again and reconcile the actual task before retrying `update-task-title`
with its current step and identity revisions. A same-clock rename back to the original text still
invalidates the older identity revision. Do not bypass the guards or use a note as a title; see
[execution task naming](/docs/concepts/workflows/#execution-task-name).

### `STEP_BLOCKED` or `RECOVERY REQUIRED` for a missing expression variable

**Cause:** The current agent-directive node has an expression that needs saved execution state.
The named variable is absent, and Moira can establish that no answer field accepted by the input
schema and declared as a node output can provide it. An open input schema does not make undeclared
answer fields usable. A declared field is also unavailable when the input schema structurally
forbids it, such as with `maxProperties: 0`, a false property schema, or an `allOf` prohibition.
When the schema does not prove a prohibition, correct an invalid answer through the normal retry.
This can happen when the workflow definition changes while an execution is in progress. A recorded
error by itself is historical; the current missing value is what blocks continuation.

**Solution:** Call `session({ action: "diagnose", executionId: "..." })` and check for the blocking
`missing_expression_variables` cause. Call `session({ action: "recover", executionId: "...",
nodeId: "<current node>", variableValues: { ... } })` with the named values. Values for declared
variables must satisfy their registry schemas; `session({ action: "variables", executionId: "..." })`
shows those declarations. If recovery refuses a missing or invalid value, correct `variableValues`
and retry; a refusal does not change the execution. On success, use the new Step attempt ID to send
the ordinary answer to the same node. Do not retry an unchanged answer while the saved state is
missing. If the submitted answer fails an earlier expression for its own reason, correct that
answer first; `diagnose` may still name a later missing saved value that needs recovery. A node's
authored error route remains in force.

### Agent Forgets Workflow Context

**Cause:** Session was archived/compacted

**Solution:**

1. Check for process-id.txt in workspace
2. Use `session({ action: "current_step" })` to get context
3. Remind agent: "Continue workflow \{processId\}"

### Seeing `[[UNDEFINED_VARIABLE]]` in a directive at runtime

**Cause:** A referenced variable was unresolved when the directive was rendered. Three causes:

1. The variable is not declared in `variableRegistry`.
2. The variable is declared but has no `default` and was not yet written by an upstream node before the directive used it.
3. A bare `{{...}}` was placed into data the agent returned via `step()`, and that data was later interpolated into a directive (template-in-data). Returned data values are literal — they are not re-scanned as templates.

The engine logs a warning naming the residual placeholder and the `executionId`.

**Solution:**

1. Declare the variable in `variableRegistry` with a `default`.
2. Ensure an upstream node writes the variable (via `globalInputs`) before its first use.
3. Never echo `{{...}}` into data you return from `step()` — keep templates only in static node fields.

### Editing files while a command runs

A running command, including a background development server, does not itself block codespace
`write`, `upload` or `apply_patch`. Keep the expected file
existence, size and digest guards; if another writer changes that version, reread and reconcile
the edit before retrying. Pending file-operation journal entries do not serialize new work. Only
the guest's file commit and recovery are serialized, with the lock released when its owning
process dies. A failed edit does not require stopping the development server. If recovery conflicts
with a later edit, preserve the current files and retained recovery data rather than overwriting
the later edit or deleting its journal.

### Large files and rejected file operations

Use `stat` for metadata and `read` with `offset` and `length` for selected bytes.
Use the returned whole-file version for guarded edits; a digest of selected bytes is
not the version of the whole file. Reading at EOF returns an empty range; an offset
beyond EOF is refused. Choose the whole-file bound explicitly when downloading or
previewing an image. Downloads support empty files; image preview requires a valid,
nonempty PNG or JPEG.
Preview checks complete PNG/JPEG structure without fixed byte, edge or pixel-count ceilings.
Optional `max_bytes` is the caller's whole-image bound, not permission to return a prefix.
Container validation does not fully decode pixels.

The service does not impose fixed byte, concurrency or duration quotas on commands
and files. Physical storage, current owner permissions and leases, repository/path
safety, expected versions and caller-selected bounds still apply. Binary transfers
stream directly; increasing a bound does not bypass these checks.

For commands and file mutations, preserve the original
`ws1-<lowercase UUID>` request identity. The same identity with unchanged input
refers to the same work; changed input is refused. Plain legacy UUIDs are not
converted into new work. After a lost reply, inspect the original request and the
affected files before deliberately requesting another effect. An unknown outcome
does not prove that no effect happened.

Inside a prepared guest, use `~/.local/bin/moira-workspace --help` for the direct
Unix-socket CLI. It uses the same service as MCP and works without a cloud connection.
Fixed provider bootstrap installs or refreshes the service in place; it does not
replace the VM or move its disks. No separate file-client setup is required. The
service has its own Node runtime and does not depend on the project's Node version.

`communication` `deliver-file` requires a fresh `request_id` in `ws1-<lowercase UUID>`
form and exactly one source: `referenceId` containing the owned `file.reference_id`, or
the host's native descriptor in `file`. An optional `channelId` selects a configured channel.
Download publishes an immutable, repeatedly readable file until expiry; it does not send
a message. An expired publication needs a separate intentional publication, not replay of
an uncertain delivery. File-capable extensions use their declared streaming binary transport.

For `COMMUNICATION_OWNER_UNAVAILABLE`, restore the original paired controller or workspace
service. Select `device_id` when several paired controllers are eligible. A saved route or
receipt is not a live connection. Progress-image mint/read returns HTTP 503 for this condition;
ordinary text remains independent.

For a materialize archive, HTTP 409 with `COMMUNICATION_OUTCOME_UNCONFIRMED` means collect through
that same grant URL; it cannot resubmit or choose a different owner. HTTP 422 reports the original
owner error, and HTTP 503 reports an unavailable controller. Do not complete the workflow step
without its files. A fresh `current_step` presentation is a separate explicit attempt;
the 256 KiB `session materialize` text fallback requires no file owner.

For `COMMUNICATION_OUTCOME_UNCONFIRMED` or `WORKSPACE_OUTCOME_UNCONFIRMED`, retain the
original ID and returned owner identity. Call
`communication({ action: "operation", request_id, device_id })`, or use `codespace_id`
instead for a workspace owner. Collection never uploads, renders or sends again. One channel
stage can remain uncertain while another succeeded; a completed receipt may contain an
uncertain error. Neither absence nor uncertainty permits an automatic new delivery.

Correct invalid ranges or caller bounds, and reread a concurrently changed file
before reconciling an edit. Do not bypass path, link/type or expected-version checks.
For unavailable remote work, inspect resource readiness and the outbound service
connection; a healthy local CLI distinguishes service availability from cloud routing.

## Local codespaces

Use `ws1-<lowercase UUID>` for `codespace` exec and `codespace_process`
start. Recover a lost first reply with exec containing `codespace_id` and the
original `request_id`, or process get with the same identity. A live command may
return before completion. Lookup and bounded waiting do not repeat or cancel it;
explicit process stop requests cancellation. Pending cancellation or missing start
proof is not a confirmed terminal outcome.

The guest owns command receipts and retained stdout/stderr. Collection requires
the service and retained guest data; cloud storage does not provide a second copy.
A cloud disconnect does not cancel a guest command. VM shutdown, provider idle stop
or reboot can interrupt it. Missing or archived legacy receipts are not replayed.
Preserve existing UNKNOWN records for diagnosis rather than importing their IDs into
the new namespace. Explicit command deadlines and client wait bounds are separate.

Workspace routing for both GitHub Codespaces and Local requires a live, already prepared and
enrolled owner service. Start the resource and complete its provider preparation explicitly
before calling workspace tools. An unavailable owner returns `CODESPACE_PROVIDER_UNAVAILABLE`
before dispatch; routing does not implicitly start a VM or perform cloud bootstrap.
A disconnected computer requires restoring the companion connection.
`CODESPACE_PROVIDER_DISABLED` indicates disabled GitHub provider configuration. Local work
uses its owner's grants, finite lease and physical capacity rather than cloud operational controls.
For GitHub create/start/adopt, reconnect the assigned paired controller; a usable guest also
requires its authenticated outbound registration. Configuration `ready` alone does not prove that.
A confirmed registration 401/403 requires current authority repair; temporary network loss can
reconnect the same valid identity without replaying the original operation.

`CODESPACE_AUTHORIZATION_REQUIRED` requires restoring actual account, device or
repository access in Settings. The host CLI supports `create OWNER/REPO --ref BRANCH`,
`start SPACE_ID`, `stop SPACE_ID`, `remove SPACE_ID --confirm` and `collect REQUEST_ID`
through the running private controller; raw host execution is unsupported. Fresh create
requires live cloud route registration and initial Git authority. Already admitted VMs can
start, stop or be cleaned up offline under applicable current owner authority. Starting requires
the finite work lease; owner-confirmed cleanup does not renew it.

For `repository_add`, inspect applied consent in Settings, discover the device with `local_devices` and reuse the original
`request_id` with the same device/repository. Pending returns no usable local repository identity;
rejected or changed account/grants require owner action. The repository must be private, owned by
the connected personal GitHub account and exposed by the App installation. Another pending owner
revision must settle before admission. An admission refusal does not permit the agent to broaden
consent or the lease. An existing local grant is discovered, not added twice.

For `repository_create`, choose a personal `installation_id` from `local_devices`; organization
installations and public creation are unsupported. A discovery warning directs the owner to
GitHub connection/installation settings. Repeat the same device/request/name/installation payload.
`setup_required` preserves any confirmed repository ID while permissions/access are repaired;
it does not mean creation failed or authorize another create. `unknown` inspects the retained
description marker instead of repeating POST. Another same-name repository or no observed repository
cannot settle that ambiguity. Keep the marker while unresolved; other repository requests are
not blocked by a repository-count quota.
Only the actual installation grant and confirmed owner admission authorize codespace creation.
MCP calls the live owner and returns `repository_id` after admission; recovery preserves the original `request_id`.
The owner admission API retains `error.stage` and a reported `error.provider_status`; compact MCP
errors carry safe repair guidance and the original `request_id`. Follow that guidance and resume
the same complete creation request. If
`stage: "local_admission"` returns `rejected`, the repository can already exist. Restore its
original grant in Settings, or use `repository_add` with the retained `github_repository_id`
and a fresh `request_id` if existing-private consent permits it. An unchanged rejected admission
receipt stays rejected; it does not authorize another GitHub create.

`preview_image` reads the current repository path as a complete PNG/JPEG within the caller's
selected whole-file bound. SVG, animated PNG, malformed,
truncated or oversized framing is refused. Use `download` for other binary files. Browser installation
and actual browser compatibility remain guest-runtime questions; network availability and
successful image projection do not establish that a browser ran or that its screenshot is correct.
The ordinary call waits for complete bytes and returns native image content; an unconfirmed outcome
returns an error, never successful pending image content.

Use **Settings → Development → Local computers** and the companion's `status` to distinguish pending
browser approval, revocation, an offline computer and an expired local lease. An offline row is
not proof that the computer or its VM has physically stopped. Renew a lease on the computer with
`npm run local -- enable --hours 8`, then run the confirmed companion in the foreground with
`npm run local -- run`. A revoked device requires a new pairing and browser confirmation.
Open that computer's codespace card and use **Check state again** for a pending start, stop or
delete. It collects the original lifecycle receipt when its identity is known, otherwise it
performs a read-only refresh. It never resubmits start/stop/delete or creates a replacement VM.
Errors and loaders stay on the affected card.
**Delete** is available with confirmation even during pending creation, cleanup or uncertain
local state. It addresses only the same owned codespace and finishes after confirmed absence.

Owner cleanup requires the active paired computer, current local web-control approval and a
running, reachable companion. It does not require agent deletion permission, enabled work or
lease renewal, and changes none of those permissions. MCP deletion retains its agent grant and
work-lease checks. A deletion refusal remains visible inside the confirmation dialog and ends
the spinner; **Cancel** is available while a separate read refreshes the current generation.
An operation's 403 refusal does not sign out the owner; session expiry and account admission
errors retain their authentication handling. Do not clear journals, edit database state or create
a replacement to bypass an unresolved removal.

`observed_at` in a codespace summary is the last verified provider observation, nullable until
one succeeds. `updated_at` is bookkeeping time and does not prove runtime
freshness. `lifecycle_error` is a safe diagnostic code, not raw provider output. A failed scoped
observation preserves the verified state/time and does not prove absence. Healthy sibling VMs
still refresh and run. Physical startup alone does not mean guest preparation completed. A local
`created` VM remains actionable but needs independent native settlement before stop completion;
an SDK error does not itself complete a local stop. Before Local create/start/stop/delete,
choose a `request_id` in `ws1-<lowercase UUID>` form; start/stop/delete also require the observed
resource `generation`. A stale value returns `CODESPACE_GENERATION_CONFLICT`; refresh and inspect
the original outcome before a new explicit action. Collect through
`codespace({ action: "operation", device_id, request_id })`, even if create returned no
codespace ID. Owner receipts report `absent`, `accepted`, `completed` or `unconfirmed`.
Neither `absent` nor newer metadata permits automatic replay. Owner-backed `pending_request_ids`
restore collection after a reload without a cloud/browser dispatch queue.

Local cloud registration stores routing identity, not a current machine, state or lifecycle
generation. If the owner has no resource observation, get/list return
`CODESPACE_PROVIDER_UNAVAILABLE`; reconnect and inspect the same owner rather than treating the
registration as a ready VM. Pending originals without a resource observation return
`CODESPACE_LOCAL_CREATION_UNKNOWN` with `request_id`, `device_id` and `codespace_id`. Use those
identities to collect the owner receipt. A receipt can be completed while its contained error
still reports an uncertain native outcome; explicit repetition preserves that uncertainty and
does not create another VM. Do not substitute the stable guest route generation for the missing
owner lifecycle generation. A nullable `machine` in a successful summary, including confirmed
deletion, is not a default profile or permission to start.

| Diagnostic                                 | Owner action                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CODESPACE_LOCAL_CREATION_UNKNOWN`         | Check the same codespace again. Its physical outcome is unconfirmed; do not create a replacement.                                                                                                                  |
| `CODESPACE_LOCAL_SETUP_INCOMPLETE`         | Guest preparation did not complete. Delete the codespace and confirm removal before recreating it; start or `recover` cannot finish initial setup. The cause remains visible even after a confirmed physical stop. |
| `CODESPACE_LOCAL_PROTOCOL_ERROR`           | Coordinate matching server/companion builds and inspect saved-state compatibility. Preserve identity and journals.                                                                                                 |
| `CODESPACE_LOCAL_RUNTIME_ERROR`            | Inspect the local runtime's diagnostics, repair that runtime and check the same codespace again. Shutdown is not implied.                                                                                          |
| `CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED` | Confirm deletion of the same codespace in Settings → Development → Local computers with active local web control. Permanent agent deletion permission is not required for owner cleanup.                           |

After a confirmed refusal and repair, an explicit lifecycle action can create a fresh guarded
attempt. Owner confirmation can also replace a local delete intent that retained only state
checks, with no destructive dispatch. An accepted delete with an unknown outcome keeps its
original generation and identity. A repeated active request or an unknown outcome still uses its
retained intent;
it does not dispatch a duplicate effect. Read-only inspection can recover exact creation identity
from the owned durable manifest after a reply expires; an unavailable inventory is never absence.
With locally approved `web-control`, request a finite renewal in the device editor within its
ceiling, up to seven days. Pending means the computer has not applied the request; rejected shows
the refusal and retains the last successfully acknowledged revision. A failed application can
disable work in the reported policy; that revision alone does not mean work remains enabled.
An offline computer exposes no current policy or grants. Saving is refused and the settings
draft remains in the editor; reconnect and refresh before explicitly saving. An already accepted
settings request retains its original identity for collection, which cannot renew the lease.

The daemon reports `connected`, `offline`, `faulted` or `disabled` in its structured stderr status.
Network/5xx failures make remote owner state unavailable without stopping admitted VM work.
New remote mutations are refused rather than queued. An addressed resource refusal returns a
bounded error for that request; a lost reply to an accepted effect requires original receipt collection.
Device-endpoint unauthorized responses or confirmed device identity/revocation failures stop work;
local disable, lease expiry and explicit shutdown do so independently. Current grants and finite
deadlines remain unchanged. Cached results can return without repeating effects; an offline row
cannot promise immediate delivery of a remote revocation.

Git and PR requests execute directly in the trusted owner's fixed broker. Original OAuth/refresh
credentials remain server-side; a broker child is limited to the approved repository/action.
`SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED`, `SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED` and
`SCOPED_CREDENTIAL_DISPOSAL_PENDING` require collection of the original `security_request_id`.
On the Local host use `moira-local status --json` and `moira-local collect ORIGINAL_ID`.
Pure collection cannot mint a token, replay Git or cancel a live stream; absence does not
authorize automatic reissuance. A refused issuer never enables a host-token fallback.

For an unknown PR create, preserve its original PR `request_id` separately. Collect with
`pull_request_create` and only `codespace_id`/`request_id`, then find the same head/base before
considering another create. CLI collect-only is `moira-workspace pull-request-create --request-id ID`.
An error before vendor dispatch can mean the PR was not started while credential custody remains
uncertain; a post-dispatch unknown remains a PR error with both recovery identities.

Account block or resource retirement can retain a scoped-disposal error without provider stop
completion. Account deletion returns `ACCOUNT_CREDENTIAL_RETIREMENT_PENDING` or
`ACCOUNT_RESOURCE_RETIREMENT_PENDING` while the account stays blocked and cleanup keys remain.
Explicitly delete owned managed resources through their confirmed cleanup before requesting deletion of the
account; stopping a persistent VM does not remove its disk, and account deletion does not do so implicitly.
Revoking a Local device or resource binding also does not confirm deletion. Unretired historical
resources, including those without a binding or with an unknown native outcome, retain their ownership witness and keep account deletion
pending until the exact resource is confirmed retired.

A Git identity HTTP 401/403 can safely direct the owner to refresh repository access,
add this repository to the App installation, or reconnect the verified GitHub identity in Settings.
Other response text remains private; a refusal never permits using a host token or widening rights.
The proxy authenticates package requests with its installed per-space broker
permission; package clients need not send a proxy-auth header. The host still enforces the computer's
lease, repository authority and public-address/computer-network checks. A proxy refusal is not permission to broaden them
or use a host/GitHub token.
Local CONNECT timeouts guard establishment. After the fixed broker connection and verified
upstream connection are established, these guards no longer impose an idle deadline. Current
leases, revocation, socket closure and broker shutdown still end access.
Public destinations are independent of technology; network downloads have no cumulative traffic or
per-response byte, connection-count or established-transfer duration quota. Host, LAN and service destinations remain denied.

`doctor` requires an enabled, unexpired lease and checks prerequisites, not live VM isolation.
Its bounded diagnostic window does not establish settlement of pending work. Current authority
is checked while SDK startup is pending; installation and registration have no general work deadline.
Device `active`/`enabled` and setup `ready` describe authorization and configuration, not a
successful guest connection. Check the companion's current diagnostic when guest calls time out.
After a crash or reboot, `run` safely reclaims a stale runner marker when its runner and guard are
proven absent under the system lock. It preserves saved work and never replays unknown operations.
Live or unverifiable owners remain refused; do not clear their lock or receipt to bypass the check.
If the default macOS storage mount is absent after reboot, restart `run` with the same state.
Startup attaches only its existing owned `storage.sparsebundle`, verifies the native mount binding
and repeats volume ownership and approved capacity admission without a fixed free-space reserve. A lost attach reply is resolved
by observing that binding. `LOCAL_STORAGE_NOT_MOUNTED` means storage remains unavailable: mount a
custom volume manually, or check that the saved default image is present and can be mounted.
`LOCAL_STORAGE_OWNER` requires resolving an unsafe image/mount or conflicting binding. Preserve
the image and state; startup never creates a replacement disk or resets data to bypass a refusal.
If the companion reports `LOCAL_STORAGE_FULL` during shrink, the requested size cannot preserve
existing data or the native APFS minimum. Check the computer's shared backing-image capacity and
actual disk space separately from free space on the Mac; admission imposes no extra reserve.
To raise its approved maximum, stop
the foreground companion through Ctrl+C or ordinary owner-managed shutdown and repeat locally:

```bash
npm run local -- web-control --confirm --storage-gib 50
npm run local -- run
```

Use the same `--state PATH` on both commands when configured. Do not use `disable` just to revise
the maximum, since it changes work enablement and its lease. Omitted limits retain the existing
approval. Refresh **Local computers**, request Storage 50 in the computer's editor and wait for
the applied revision and actual capacity. Approval itself does not resize storage, renew the lease
or clear a pending request. A failed or interrupted resize keeps its existing recovery records;
do not reset state or recreate codespaces. An expired work lease does not prevent management
from reporting the approval, but guest work still requires valid work permission. If the approval
reply is lost, reconnect with the same state so the same saved approval is reported again.
Stop the foreground companion before commands that require its runner lock. Unsupported SDK
versions, Linux runtime ownership, unsafe mounts/settings or unknown identity refuse work;
do not reset the personal Docker profile, substitute an ordinary directory for bounded storage,
or relax network policy. For Docker sign-in use `npm run local -- login`. An unreadable SDK store
can be recovered explicitly with `login --new-store` only after local disable and owned shutdown;
existing stores are preserved.

After an update, a strict heartbeat or `web-control.json` rejection can mean the server, companion
and owner guard use different control-contract editions, even with delegation disabled. Rebuilding
the CLI alone does not replace a running guard or installed executable release.
Fixed guest bootstrap refreshes the common workspace service in place. A receipt without
launch proof keeps that start unconfirmed.
Inspect the original operation; an unknown
command result alone does not require restarting the companion or stopping its VM.
For an incompatible control-contract edition, arrange ordinary owner-managed shutdown and confirmed
settlement. With both sides stopped, back up the server database, the complete private companion
state and SDK backing storage, including VM disks. Keep matching bundles, coordinate server/companion
editions, then restart with the same state and disks. Rollback restores that complete paired backup
and matching bundles together.
Do not erase approval/journals, create replacement state or kill arbitrary guard processes. Management
can be interrupted; mixed-edition rolling upgrade is unsupported. Live append in a matched edition
does not make the upgrade itself uninterrupted.

Migration 0061 archives old cloud Local policy/control, relay, grants and operational rows;
archives do not authorize dispatch. The owner imports only verified existing native bindings
and retains unknown outcomes. An unsupported private owner format remains refused: preserve
the cold backup, identity, journals and disks instead of editing cloud policy or deleting state.
Rollback restores paired snapshots and matching bundles. Do not replace enrollment or reset the SDK.

An unknown command or file outcome belongs to its accepted operation; it does not itself require
stopping or recovering the entire VM. Inspect its result and the affected files before repeating
that effect or modifying those files. Independent work does not need to resolve that unknown
outcome. Do not automatically replay an unknown edit or clear its journal to admit new work.
For a runtime-owner refusal such as `LOCAL_GUEST_SETTLEMENT_UNKNOWN`, confirm physical stop before
`npm run local -- recover SPACE_ID --confirm`. This checks exact native identity and the network
boundary while preserving jobs and unknown outcomes without replay. Use the same `--state PATH`
and restart `run`. Ordinary stop/start requires no separate counter-recovery step.
`npm run local -- recover --confirm` is the separate
disabled-device orphan-shutdown acknowledgement. Neither deletes codespace data or authorizes
adoption by SDK name. If shutdown remains pending or identity is unknown, retain the records
and resolve that refusal before enabling more work. See [local setup](/docs/getting-started/self-hosting/#connect-local-codespaces).

## Recovery Scenarios

### Scenario: Resume After Interruption

```
User: Continue working on the auth feature

Agent:
1. session({ action: "executions", search: "auth" })
   → Found: executionId: "abc-123", status: "waiting"

2. session({ action: "current_step", executionId: "abc-123" })
   → attemptId: "attempt-current", directive: "Implement login endpoint"

3. [Does the work]

4. step({ processId: "abc-123", attemptId: "attempt-current", input: { result: "done" } })
```

### Scenario: Find Lost Process ID

```
User: What workflows am I running?

Agent:
1. session({ action: "executions" })
   → Lists all active executions with notes

2. session({ action: "execution_context", executionId: "abc-123" })
   → Shows full context including variables
```

### Scenario: Check Why Workflow Stuck

```
Agent:
1. session({ action: "execution_context", executionId: "abc-123" })
   → status: "waiting", currentNodeId: "validation-step"

2. session({ action: "current_step", executionId: "abc-123" })
   → Shows what the workflow is waiting for
```

## Related Documentation

- [MCP Agent Guide](/docs/docs/integration/agent-guide) - Tool usage basics
- [MCP Tools Reference](/docs/docs/reference/tools) - Full tool documentation
