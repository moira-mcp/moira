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

A running command or development server does not itself block `file_create`, `file_replace`,
`file_patch` or `file_upload`. Supply expected complete text or a returned file reference for
replacement. If another writer changes the file, reread and reconcile before a new explicit edit.
Do not calculate a digest of a selected byte range as a whole-file precondition. Commit and
recovery use the guest's confined atomic transactions; recovery never overwrites a later edit.

### Large files and rejected file operations

Use `file_stat` for metadata and `file_read` with line windows or its returned cursor for text.
Continuation preserves complete UTF-8 characters; Cyrillic or emoji split across an internal
byte boundary is not a binary file. Use `file_download` for complete binary bytes. Name and MIME
are derived when omitted; no preliminary stat is required. Empty downloads are supported.
`file_preview` returns complete valid PNG/JPEG content, not SVG or an image prefix. Its structural
validation is not proof that a browser ran or that the screenshot is visually correct.
Optional `max_bytes` is the caller's selected bound, not a shared transfer quota.

Commands and files remain subject to storage, current owner authority, repository/path safety and
expected-content checks. Native descriptors stream to the owner without base64. The direct
`~/.local/bin/moira-workspace` CLI uses the same Unix owner without requiring a cloud connection;
fixed bootstrap updates the service in place without replacing the VM or its disks.

`communication_deliver` accepts a native file at a selected controller;
`communication_deliver_publication` sends an owned `file.reference_id`. The optional `channel`
selects a configured channel, never a recipient. Publication does not send a message, delivery
neither consumes nor renews it, and expiry requires a separate intentional publication.
File-capable extensions use their declared binary transport.

Keep the returned `operation`, including an attachment notification's workflow result.
`operation_get({ reference })` never uploads, renders or sends again. A closed uncertain owner
outcome projects as `unconfirmed` even if its private receipt is terminal; a confirmed refusal
remains completed with `outcome.ok:false`. One channel can remain uncertain after another succeeded.
Discovery returns references and safe metadata, not full outcomes; collect the selected original
explicitly. If the first reply was lost, use `operation_find` at the selected owner and choose a
candidate deliberately. Neither one candidate nor no candidate proves which effect occurred.
Never create a new delivery merely because collection is absent, unavailable or unconfirmed.

For `COMMUNICATION_OWNER_UNAVAILABLE`, restore the selected controller or guest route rather
than choosing a different owner. Ordinary text remains independent. A materialize archive's
HTTP 409 `COMMUNICATION_OUTCOME_UNCONFIRMED` is collected through the same grant URL; it cannot
resubmit or change owners. HTTP 422 reports an owner error and HTTP 503 an unavailable controller.
Do not complete a workflow step without its files. A fresh `current_step` presentation is an
explicit separate attempt; the `session materialize` text fallback requires no file owner.

## GitHub setup and remote readiness

Provider `available`, verified local Unix readiness and a live remote route are separate facts.
The guest CLI can work before first enrollment completes. Remote command/file tools require a
current enrolled connection; a saved `running` observation alone does not provide it.

For initial `unconfigured` or `enrollment_unavailable` remote state, first collect the original
operation and settle its scoped SSH custody. If `CODESPACE_LOCAL_SETUP_INCOMPLETE` remains on a
known GitHub environment, restore the selected controller and current GitHub access, then choose
**Resume setup** or use `workspace_lifecycle({ workspace, action: "resume_setup" })` with its
returned workspace reference. The controller uses the saved original root/repository, guest life,
installed release and assignment proof. It performs fixed configuration and enrollment without
provider start, payload installation, adoption or another VM. Missing proof or changed life,
generation or authority refuses continuation. Collection itself never enrolls or opens SSH.

An already enrolled guest's `connecting` or `unavailable` transport uses its existing reconnect
loop; do not use setup continuation to replace that authority. After a genuine cold life change,
retained renewal authority allows the Unix API to become ready before remote renewal. Network
and store failures retry the same durable renewal request; old-life credentials cannot open a
connection. Confirmed refusal requires authority repair and leaves locally authorized work
available. A guest that never enrolled cannot renew or regenerate its original proof after a
life change. Preserve its state and inspect the original with the assigned controller.

Later enrollment or renewal attaches to the same running Unix owner without replaying commands.
A cold restart can interrupt processes and does not promise uninterrupted command execution.

## Local codespaces

Use `command_run` or `command_run_native` with the returned workspace reference.
The adapter creates internal request identity; do not manufacture UUIDs or process IDs.
A live command may return before completion. Use its `operation` for `operation_get`, and its
`process` for `process_output` or explicit `process_stop`. Observation does not cancel work;
pending cancellation is not a confirmed physical stop. Deliberately identical commands are
distinct intentions. An uncontrolled first reply has no automatic deduplication guarantee.

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
uses its owner's grants, enabled permission and physical capacity rather than cloud operational controls.
For GitHub create/start/adopt, reconnect the assigned paired controller; remote guest access also
requires authenticated outbound registration. Configuration `ready` alone does not prove that.
A confirmed registration 401/403 requires current authority repair; temporary network loss can
reconnect the same valid identity without replaying the original operation.

`CODESPACE_AUTHORIZATION_REQUIRED` requires restoring actual account, device or
repository access in Settings. The host CLI supports `create OWNER/REPO --ref BRANCH`,
`start WORKSPACE_REF`, `resume-setup WORKSPACE_REF`, `stop WORKSPACE_REF`,
`remove WORKSPACE_REF --confirm`, `collect OPERATION_REF` and `operations CONTROLLER_REF`
through the running private controller. Raw host execution is unsupported. Privileged maintenance
and security requests retain their separate `collect ORIGINAL_REQUEST_ID` path; this is not
raw lifecycle submission. Fresh create requires cloud registration and initial Git authority.
Already admitted VMs remain subject to current local authority offline.

Use `workspace_targets` to obtain the selected controller and personal installation references.
`repository_admit` requires current applied existing-private consent and an App-accessible
repository owned by the connected personal account. It cannot broaden rights; a pending settings
revision must settle first. `repository_create` requires new-private consent. Organization
installations and public creation are unsupported.

Preserve the returned original operation. `operation_get` is read-only; after fixing permissions,
installation access or admission, `operation_resume` explicitly continues only the original
private-repository creation. It does not restart commands or create a replacement repository.
`setup_required` can retain a confirmed repository while admission remains incomplete.
Unknown creation checks the retained description marker; an unrelated same-name repository or
missing observation cannot settle it. Do not remove the marker while unresolved.
A rejected admission can leave the repository on GitHub: restore its grant in Settings or request
existing-private admission when the owner permits it. A rejection does not authorize another create.

Use **Settings → Development → Local computers** and the companion's `status` to distinguish pending
browser approval, revocation, an offline computer and disabled local work. An offline row is
not proof that the computer or its VM has physically stopped. Enable work on the computer with
`npm run local -- enable`; it remains permitted until explicit disable. Use `npm run local -- install` to stage the complete owner
release and register login startup, then `npm run local -- run` to start or connect to it.
The persistent host owner holds VM custody and the broker/tunnel; this client exits without
stopping them. Ordinary installation stages a release without replacing a running owner.
`npm run local -- service-status` reports its running release, readiness, cloud connection,
staged release and startup failure. A revoked device requires a new pairing and browser confirmation.
Open that computer's codespace card and use **Check state again** for a pending start, stop or
delete. It collects the original lifecycle receipt when its identity is known, otherwise it
performs a read-only refresh. It never resubmits start/stop/delete or creates a replacement VM.
Errors and loaders stay on the affected card.
**Delete** is available with confirmation during pending creation, cleanup or uncertain
local state when a current summary supplies a returned workspace reference. Unavailable identities
have no lifecycle controls. Deletion targets that same captured observation and completes only
after confirmed absence. Owner cleanup needs active pairing, local web control and a reachable
owner, but not agent delete permission or enabled work; it changes neither permission.
MCP deletion retains its agent grant and enabled-permission checks.

A refusal stays in the confirmation dialog and ends its spinner. **Cancel** remains available.
A background refresh does not replace the captured delete target. After inspecting a different
observation, make a new explicit confirmation; an automatic retry must not refresh preconditions.
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
use the returned target/workspace references unchanged. Lifecycle conflicts require a fresh
observation and explicit decision, not an automatic refreshed-precondition retry.
`operation_get` collects the retained original; `pending_operations` restores collection after
reload. A lost first reply instead offers `operation_find` on the selected controller, with
explicit candidate selection. `absent` or newer metadata does not re-enable an uncertain mutation.

Cloud registration is a route, not a machine observation. `workspace_observe` can report
`CODESPACE_PROVIDER_UNAVAILABLE` without inventing state or generation. `workspace_list` keeps
unavailable owned identities read-only alongside healthy peers, with safe error codes and separate
provider failures. All-provider failure is not an empty inventory. A pending unknown creation
remains collectable as its original operation, not a replacement VM. A nullable machine is not a
default profile or permission to start.

For Local `CODESPACE_LOCAL_SETUP_INCOMPLETE`, repair the reported prerequisite and choose **Resume setup**,
`workspace_lifecycle({ workspace, action: "resume_setup" })`, or host
`resume-setup WORKSPACE_REF`. This prepares the same known VM and preserves its files and original
create outcome. Ordinary Start and custody `recover` do not resume setup.
The optional `setup_failure` guides preserved-root inspection (`repository_unproven`),
Python3/libc/exclusive-publication prerequisites (`prerequisite_unavailable`), repository access/ref
repair (`repository_checkout_failed`) or fixed configuration diagnostics (`configuration_failed`).
Unknown creation or guest settlement still requires original collection, not adoption by name.
An owner-confirmed custody acknowledgement preserves incomplete setup; explicitly resume it afterward.

For `CODESPACE_LOCAL_PROTOCOL_ERROR`, coordinate matching server/companion builds and preserve
saved identity and journals. For `CODESPACE_LOCAL_RUNTIME_ERROR`, repair the actual runtime and
observe the same workspace again; the error does not imply shutdown.
`CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED` requires owner confirmation in Settings → Development →
Local computers with active web control, not a permanent agent-delete grant.

With locally approved `web-control`, request settings within the resource ceilings in the device editor.
Pending means the computer has not applied the request; rejected shows
the refusal and retains the last successfully acknowledged revision. A failed application can
disable work in the reported policy; that revision alone does not mean work remains enabled.
An offline computer exposes no current policy or grants. Saving is refused and the settings
draft remains in the editor; reconnect and refresh before explicitly saving. An already accepted
settings request retains its original identity for collection, which cannot repeat the effect.
An original historical success may have no typed current device projection; refresh current owner
settings separately rather than submitting the change again. Ordinary label/grant/Git-identity and
new-VM-default edits apply live when enablement and shared storage are unchanged. Existing admitted
VM profiles remain intact; changing enablement or shared storage uses the physical transition.
Git author changes update policy; repository-local Git config uses the value during workspace
preparation. Saving the setting does not force a rewrite in an already running checkout.

The daemon reports `connected`, `offline`, `faulted` or `disabled` in its structured stderr status.
Network/5xx failures make remote owner state unavailable without stopping admitted VM work.
New remote mutations are refused rather than queued. An addressed resource refusal returns a
bounded error for that request; a lost reply to an accepted effect requires original receipt collection.
Device-endpoint unauthorized responses or confirmed device identity/revocation failures retire
the remote route without turning local VM intent into stop. Local disable and
explicit physical stop remain independent controls. Current grants remain enforced.
Cached results can return without repeating effects; an offline row
cannot promise immediate delivery of a remote revocation.

Git and PR requests execute directly in the trusted owner's fixed broker. Original OAuth/refresh
credentials remain server-side; a broker child is limited to the approved repository/action.
`SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED`, `SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED` and
`SCOPED_CREDENTIAL_DISPOSAL_PENDING` require collection of the original `security_request_id`.
On the Local host use `moira-local status --json` and `moira-local collect ORIGINAL_ID`.
Pure collection cannot mint a token, replay Git or cancel a live stream; absence does not
authorize automatic reissuance. A refused issuer never enables a host-token fallback.

For an unknown PR create, retain its operation and collect with `operation_get` or guest
`moira-workspace get OPERATION_REF`. Use `pull_request_read` or `pr-find HEAD BASE` to inspect
that head/base before a deliberate new create. Do not call `pull_request_create` again to collect.
A pre-dispatch PR refusal can coexist with uncertain credential custody; follow the separate
privileged security collection without issuing another token.

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
enabled permission, repository authority and public-address/computer-network checks. A proxy refusal is not permission to broaden them
or use a host/GitHub token.
Local CONNECT timeouts guard establishment. After the fixed broker connection and verified
upstream connection are established, these guards no longer impose an idle deadline. Current
permission, revocation, socket closure and broker shutdown still end access.
Public destinations are independent of technology; network downloads have no cumulative traffic or
per-response byte, connection-count or established-transfer duration quota. Host, LAN and service destinations remain denied.

`doctor` requires enabled work permission and checks prerequisites, not live VM isolation.
Its bounded diagnostic window does not establish settlement of pending work. Current authority
is checked while SDK startup is pending; installation and registration have no general work deadline.
Device `active`/`enabled` and setup `ready` describe authorization and configuration, not a
successful guest connection. A working guest Unix API is ready before optional workspace-credential
acquisition and can remain ready while remote access is not. A held cloud reply does not hold local
work/lifecycle admission; current runtime, generation, grant and connection are revalidated before
applying it. Warm preparation uses configured or exact retained author data; public checkout does
not depend on optional Git author lookup. Initial private checkout still requires current authority.
Optional observed `remote.state` is `unconfigured`, `enrollment_unavailable`, `connecting`, `connected`,
`unavailable` or `refused`; missing observation is unknown. Enrollment unavailability needs current
registration to become available; an existing unavailable transport reconnects with the same
authority. Temporary network/store failure is not confirmed revocation. A confirmed refusal closes
that remote authority without stopping locally authorized work. Later enrollment updates the same
Unix owner without replaying accepted commands. Check the current diagnostic when guest calls time out.
After login or a cold owner restart, the installed service restores intended work for the same
known VM identities and disks when runtime, credentials and current work permission are available.
`run` starts or connects to that owner. Recovery reclaims a stale runner marker only when its runner
and guard are proven absent under the system lock. It preserves saved work and never replays
accepted commands or unknown operations. A host reboot can interrupt commands and requires fresh
kernel custody; it is not uninterrupted execution.
Live or unverifiable owners remain refused; do not clear their lock or receipt to bypass the check.
If the default macOS storage mount is absent after reboot, inspect `service-status` with the same
state. Startup attaches only its existing owned `storage.sparsebundle`, verifies the native mount binding
and repeats volume ownership and approved capacity admission without a fixed free-space reserve. A lost attach reply is resolved
by observing that binding. `LOCAL_STORAGE_NOT_MOUNTED` means storage remains unavailable: mount a
custom volume manually, or check that the saved default image is present and can be mounted.
`LOCAL_STORAGE_OWNER` requires resolving an unsafe image/mount or conflicting binding. Preserve
the image and state; startup never creates a replacement disk or resets data to bypass a refusal.
After repairing a startup prerequisite, repeating `run` while the failed service endpoint remains
reachable only prints its retained status; it does not retry initialization. If no owner is
running, `run` starts the selected owner instead. If the original maintenance receipt remains in
phase `selected` for this running release, repeat that original intent with
`maintenance --request-id ORIGINAL_ID --confirm`;
for an original pause, use `maintenance --resume --request-id ORIGINAL_ID --confirm` instead.
This restarts the failed owner without repeating its already confirmed physical stop or selection.
Keep collecting the same ID; only the successor's recovery result confirms completion.
Other unconfirmed maintenance phases still require the physical-settlement repair described below;
they do not qualify for this startup-only retry.
If there is no unresolved maintenance request, explicitly restart the active release with
`maintenance --pause --confirm`, retain its ID, collect until `paused`, then use
`maintenance --resume --request-id ORIGINAL_ID --confirm`. This pause needs no newly staged
release and declares physical interruption. Use `run` if needed to start the selected owner,
then check `service-status` and the original receipt. Keep the same `--state PATH` throughout;
do not edit locks or sockets, replace pairing, or replay interrupted commands.
If the companion reports `LOCAL_STORAGE_FULL` during shrink, the requested size cannot preserve
existing data or the native APFS minimum. Check the computer's shared backing-image capacity and
actual disk space separately from free space on the Mac; admission imposes no extra reserve.
To raise its approved maximum, pause the physical owner explicitly and retain the printed
maintenance request ID. Wait until collection reports `paused` before changing local approval:

```bash
npm run local -- maintenance --pause --confirm
npm run local -- collect ORIGINAL_MAINTENANCE_ID
npm run local -- web-control --confirm --storage-gib 50
npm run local -- maintenance --resume --request-id ORIGINAL_MAINTENANCE_ID --confirm
npm run local -- run
```

Use the same `--state PATH` on every command when configured. Collect the same maintenance ID
until its result is known; pause/resume declares physical interruption and restores saved intent,
not the interrupted commands. Closing a client or pressing Ctrl+C is not this pause.
Do not use `disable` just to revise
the maximum, since it disables and stops owned work. Omitted limits retain the existing
approval. Refresh **Local computers**, request Storage 50 in the computer's editor and wait for
the applied revision and actual capacity. Approval itself does not resize storage, enable work
or clear a pending request. A failed or interrupted resize keeps its existing recovery records;
do not reset state or recreate codespaces. Disabled work does not prevent management
from reporting the approval, but guest work still requires valid work permission. If the approval
reply is lost, reconnect with the same state so the same saved approval is reported again.
Direct local `login`, `setup`, `recover` and web-control approval require the physical runner gate.
With an installed owner, use the same explicit maintenance pause/resume boundary before those
commands; the paused service retains its management endpoint while releasing physical ownership.
Unsupported SDK
versions, Linux runtime ownership, unsafe mounts/settings or unknown identity refuse work;
do not reset the personal Docker profile, substitute an ordinary directory for bounded storage,
or relax network policy. For Docker sign-in use `npm run local -- login`. An unreadable SDK store
can be recovered explicitly with `login --new-store` only after local disable and owned shutdown;
existing stores are preserved.

For an owner update, stage the complete package with `install`, inspect `service-status`, then
request `maintenance --confirm`. Retain its printed request ID and use `collect ORIGINAL_ID`
after a lost reply. The owner settles exact physical custody before selecting the staged release;
the successor restores the same saved VM identities, disks and intended running state. Accepted
commands are not replayed, and commands interrupted by maintenance may have uncertain outcomes.
If settlement is unconfirmed, no replacement owner starts. Preserve the receipt and resolve the
physical refusal; do not issue another stop or replace the maintenance identity. After an explicit
`recover --confirm` of the disabled device, resubmit that same maintenance intent to check its fresh
settlement proof. Pure collection does not perform recovery. An incompatible client reports
`LOCAL_SERVICE_MAINTENANCE_REQUIRED` rather than replacing a live owner.

After an update, a strict heartbeat or `web-control.json` rejection can mean the server, companion
and owner guard use different control-contract editions, even with delegation disabled. Rebuilding
the CLI alone does not replace a running guard or installed executable release.
Fixed guest bootstrap refreshes the common workspace service in place. A receipt without
launch proof keeps that start unconfirmed.
Inspect the original operation; an unknown
command result alone does not require restarting the companion or stopping its VM.
For an incompatible control-contract edition, use the explicit maintenance interruption and confirm
settlement. Before the coordinated cutover, back up the server database, the complete private companion
state and SDK backing storage, including VM disks. Keep matching bundles, coordinate server/companion
editions, then start the selected owner with the same state and disks. A coordinated rollback must
preserve any writes made since the backup; do not restore an old database over new accepted work.
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
boundary while preserving jobs and unknown outcomes without replay. With a running owner, first
use the maintenance pause above, then resume that original maintenance ID and use `run` if needed.
Use the same `--state PATH`. Ordinary stop/start requires no separate counter-recovery step.
If the acknowledged unknown arose during initial preparation, recovery preserves its original
operation and leaves setup incomplete. Repair the reported prerequisite, then explicitly
`resume-setup WORKSPACE_REF` on the same known VM; do not treat acknowledgement as completed setup
or permission for ordinary start.
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
