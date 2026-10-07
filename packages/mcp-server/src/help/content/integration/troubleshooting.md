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
`write`, `upload` or `apply_patch`. Cloud concurrency ceilings apply to cloud operations;
local operations do not consume them. Keep the expected file
existence, size and digest guards; if another writer changes that version, reread and reconcile
the edit before retrying. Another active file mutation can return `CODESPACE_OPERATION_BUSY`;
commands and reads do not impose that serialization. A failed edit does not require stopping the development server.

## Local codespaces

Internal companion messages have a separate bounded transfer budget; they do not consume the
native file-upload/download slots or their displayed usage. Native file limits still apply.

For `repository_add`, inspect applied consent with `local_devices` and reuse the original
`request_id` with the same device/repository. Pending returns no usable local repository identity;
rejected or changed account/grants require owner action. The repository must be private, owned by
the connected personal GitHub account and exposed by the App installation. Another pending owner
revision must settle before admission. An admission refusal does not permit the agent to broaden
consent or the lease. An existing local grant is discovered, not added twice.

For `repository_create`, choose a personal `installation_id` from `local_devices`; organization
installations and public creation are unsupported. `github_setup_required` directs the owner to
GitHub connection/installation settings. Repeat the same device/request/name/installation payload.
`setup_required` preserves any confirmed repository ID while permissions/access are repaired;
it does not mean creation failed or authorize another create. `unknown` inspects the retained
description marker instead of repeating POST. Another same-name repository or no observed repository
cannot settle that ambiguity. Keep the marker while unresolved; other repository requests are
not blocked by a repository-count quota.
Only `applied` after actual installation grant and companion ACK authorizes codespace creation.
Inspect `error.stage` for the failing setup step and `error.provider_status` for a reported GitHub
HTTP status; follow `instruction` and resume the same complete creation request. If
`stage: "local_admission"` returns `rejected`, the repository can already exist. Restore its
original grant in Settings, or use `repository_add` with the retained `github_repository_id`
and a fresh `request_id` if existing-private consent permits it. An unchanged rejected admission
receipt stays rejected; it does not authorize another GitHub create.

`preview_image` needs a complete bounded PNG/JPEG download. Resume a pending image with only
its `codespace_id` and `operation_id`, not another file dispatch. SVG, animated PNG, malformed,
truncated or oversized framing is refused. Use `download` for other binary files. Browser installation
and actual browser compatibility remain guest-runtime questions; network availability and
successful image projection do not establish that a browser ran or that its screenshot is correct.

Use **Settings → Development → Local computers** and the companion's `status` to distinguish pending
browser approval, revocation, an offline computer and an expired local lease. An offline row is
not proof that the computer or its VM has physically stopped. Renew a lease on the computer with
`npm run local -- enable --hours 8`, then run the confirmed companion in the foreground with
`npm run local -- run`. A revoked device requires a new pairing and browser confirmation.
Open that computer's codespace card and use **Check state again** for a pending start, stop or
delete. This retries the saved intent for its exact codespace ID; deletion keeps the current
generation check. It does not create a replacement VM. Pending creation or unavailable applied
access instead uses read-only refresh. Errors and loaders stay on the affected card.
**Delete** is available with confirmation even during pending creation, cleanup or uncertain
local state. It addresses only the same owned codespace and finishes after confirmed absence.
Do not clear journals, edit database state or create a replacement to bypass an unresolved removal.

`observed_at` in a codespace summary is the last verified provider observation, nullable until
one succeeds. `updated_at` may change because of a claim or retry and does not prove runtime
freshness. `lifecycle_error` is a safe diagnostic code, not raw provider output. A failed scoped
observation preserves the verified state/time and does not prove absence. Healthy sibling VMs
still refresh and run. Physical startup alone does not mean guest preparation completed. A local
`created` VM remains actionable but needs independent native settlement before stop completion;
an SDK error does not itself complete a local stop. Recovery uses the same
mutation receipt within its private-transfer TTL, even after the delivery deadline, without a
second start/stop/delete effect. If that receipt has expired, inspect the existing codespace and
its verified observation instead of repeating creation or editing the database state.

| Diagnostic                                 | Owner action                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CODESPACE_LOCAL_CREATION_UNKNOWN`         | Check the same codespace again. Its physical outcome is unconfirmed; do not create a replacement.                                                                                                                  |
| `CODESPACE_LOCAL_SETUP_INCOMPLETE`         | Guest preparation did not complete. Delete the codespace and confirm removal before recreating it; start or `recover` cannot finish initial setup. The cause remains visible even after a confirmed physical stop. |
| `CODESPACE_LOCAL_PROTOCOL_ERROR`           | Coordinate matching server/companion builds and inspect saved-state compatibility. Preserve identity and journals.                                                                                                 |
| `CODESPACE_LOCAL_RUNTIME_ERROR`            | Inspect the local runtime's diagnostics, repair that runtime and check the same codespace again. Shutdown is not implied.                                                                                          |
| `CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED` | Allow deletion for this repository in the computer's settings, wait for application, then confirm deletion of the same codespace.                                                                                  |

After a confirmed refusal and repair, an explicit lifecycle action can create a fresh guarded
attempt. A repeated active request or an unknown outcome still uses its retained intent;
it does not dispatch a duplicate effect. Read-only inspection can recover exact creation identity
from the owned durable manifest after a reply expires; an unavailable inventory is never absence.
With locally approved `web-control`, request a finite renewal in the device editor within its
ceiling, up to seven days. Pending means the computer has not applied the request; rejected shows
the refusal and retains the last successfully acknowledged revision. A failed application can
disable work in the reported policy; that revision alone does not mean work remains enabled.
An offline computer keeps requests pending. Inspect the effective policy and compare requested
and applied revisions before retrying work.

The daemon reports `connected`, `offline`, `faulted` or `disabled` in its structured stderr status.
Network/5xx failures mean `offline`; malformed control-plane protocol means `faulted`
and a 30-second confirmation retry. Those connection failures suspend new claims without stopping
admitted VM work. An addressed resource refusal returns a bounded error for that request. A refused
delivery claim ends only its request scope: background delivery confirms the same current
device/account/connection and generation, then continues independent claims without a daemon-wide
fault or retry delay. Failed confirmation follows the actual connection or device-authority failure.
Device-endpoint unauthorized responses or confirmed device identity/revocation failures stop work;
local disable, lease expiry and explicit shutdown do so independently. Current grants and finite
deadlines remain unchanged. Cached results can return without repeating effects; an offline row
cannot promise immediate delivery of a remote revocation.

The local guest proxy authenticates package requests with its installed per-space broker
permission; package clients need not send a proxy-auth header. The host still enforces the computer's
lease, repository authority and public-address/computer-network checks. A proxy refusal is not permission to broaden them
or use a host/GitHub token.
Busy connection capacity queues requests in FIFO order; disconnected consumers stop waiting.
Authority is checked again after the wait. Revocation and lease expiry still refuse access.
Public destinations are independent of technology; network downloads have no cumulative traffic or
per-response byte quota. Native MCP file-transfer limits still apply. Host, LAN and service destinations remain denied.

`doctor` requires an enabled, unexpired lease and checks prerequisites, not live VM isolation.
Stop the foreground companion before commands that require its runner lock. Unsupported SDK
versions, Linux runtime ownership, unsafe mounts/settings or unknown identity refuse work;
do not reset the personal Docker profile, substitute an ordinary directory for bounded storage,
or relax network policy. For Docker sign-in use `npm run local -- login`. An unreadable SDK store
can be recovered explicitly with `login --new-store` only after local disable and owned shutdown;
existing stores are preserved.

After an update, a strict heartbeat or `web-control.json` rejection can mean the server, companion
and owner guard use different control-contract editions, even with delegation disabled. Rebuilding
the CLI alone does not replace a running guard. Arrange ordinary owner-managed shutdown and confirmed
settlement. With both sides stopped, back up the server database, the complete private companion
state and SDK backing storage, including VM disks. Keep matching bundles, coordinate server/companion
editions, then restart with the same state and disks. Rollback restores that complete paired backup
and matching bundles together.
Do not erase approval/journals, create replacement state or kill arbitrary guard processes. Management
can be interrupted; mixed-edition rolling upgrade is unsupported. Live append in a matched edition
does not make the upgrade itself uninterrupted.

An unsupported saved control format also requires offline conversion, not only new executables.
Back up server database and local private state/disks, stop both sides, remove only obsolete quota,
repository-domain and delegation-profile fields from all policy/control/intent copies and retained
creation delegation, and validate against the matching strict schemas. Recompute the server's
canonical public-policy digest. Preserve grants, receipts, IDs, generations, markers, jobs,
credentials and disks. Restart matching bundles; rollback restores paired snapshots and bundles.
Do not replace enrollment, reset the SDK or discard journals to resolve a schema refusal.

`LOCAL_GUEST_SETTLEMENT_UNKNOWN` means the previous guest effect cannot be safely retried.
After confirmed physical stop, `npm run local -- recover SPACE_ID --confirm` acknowledges that
outcome without replaying prior jobs. For `LOCAL_GENERATION_CONFLICT` on an initialized, clean
stopped VM, the same command verifies its exact identity and boundary and records a generation
receipt; use the same `--state PATH`, then restart `run`. Ordinary confirmed clean stops retain this
receipt automatically. Retained jobs and unknown outcomes are preserved, never replayed.
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
