# Execution, replay and recovery

This reference is for contributors changing persisted runs, step handling or readers of execution
state. The [HTTP reference](http-api.md) describes request fields; portable
[workflow help](../../packages/mcp-server/src/help/content/concepts/workflows.md) describes authoring.

## State and authority

The engine persists active runs as `running` and terminal runs as `completed`. Waiting, locks and
intentional stop are additional facts: a run waits when its current node is its input-wait node;
an active lock and the person-wait markers determine the management display status. `stopReason`
distinguishes deliberate stop from genuine completion. A journal entry does not itself terminate a
run. Refusals exclude explicitly classified degradation entries.

The execution owner supplies the user scope for loading its definition and handling its steps.
An administrator may inspect through designated surfaces or perform explicit operator actions;
that does not grant ordinary use of someone else's run. A parent link, execution policy or node
directive grants no authority. Keep same-owner checks in mutations, including recovery and stop.
See [authentication](authentication.md).

## Durable attempts

A presentation is a saved opportunity to perform one mutation, identified by an opaque attempt ID.
It binds the user, execution, step revision, current node, workflow and continuation surface. Keep
the returned ID when submitting or collecting that mutation; a fresh ID represents another attempt.

Starting uses preparation followed by execution of the prepared `startAttempt`. Preparation reserves
an execution ID and records the canonical request payload and graph identity. Execution rechecks
definition/read access and a selected same-owner running parent before creating and claiming the
reserved run. Do not implement a lost-response retry by preparing another start.

Mutable start preconditions are checked again at execute, including account, definition/Playbook
readability and communication/lock-delivery requirements. Failure before run creation stores a stable
`START_PRECONDITION_CHANGED` receipt without creating an execution; replay returns that receipt.
Fix the precondition and prepare a new start rather than expecting the refused attempt to change.

For `step`, the fingerprint includes the input and teleport target. JSON presence is significant:
omitted input and explicit null are not interchangeable fingerprint inputs. The executor may normalize
an omitted completion to null for an already-waiting materialize node after fingerprinting; the
original caller payload still identifies the attempt.

| Observed attempt state                       | Caller action                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `presented`                                  | Submit the intended input with this attempt ID                                                     |
| `executing` / `ATTEMPT_PROCESSING`           | Retain the same ID and input; collect/retry that attempt                                           |
| `completed`                                  | Identical input replays the stored response without executing handlers again                       |
| Different fingerprint / `ATTEMPT_CONFLICT`   | Do not alter input under the old ID; inspect current state                                         |
| Superseded or incompatible / `ATTEMPT_STALE` | Read the current presentation or diagnose the changed continuation                                 |
| `outcome_unknown`                            | Inspect effects and execution before deciding recovery or owner stop; no automatic mutation replay |

Completed same-input step replay is checked before rejecting a now-completed execution. The saved
receipt is the answer, even if the workflow has since advanced. Claims use an owner ID, lease and
monotonic fence; heartbeat renewal is not permission for a second caller to execute. Expired
executing claims are reconciled to unknown, not reclaimed as safe work. A caller losing ownership
cannot commit the result under the old fence.

The returned presentation appends the current common language instruction to ordinary steps,
current-step reads and replayed step/start receipts. This does not rewrite the stored response,
attempt identity, input fingerprint or execution state. All agent-authored free-form text follows
the user's requested or preferred language; schema keys, identifiers, enum values, code, commands
and exact quotations remain unchanged. The selected authored/model/agent/global reminder retains
its existing precedence, including intentional empty configured overrides.

Execution state, response receipt and next presented attempt commit together in an immediate SQL
transaction. Notification enqueueing and change-feed writes share the owning mutation transaction.
This protects persistence and replay; it does not roll back an external provider effect. A failure
after an effect but before a provable receipt is precisely why unknown outcomes exist.

Prepared starts expire after fifteen minutes. Completed start receipts and completed/superseded step
receipts have a retained tail: seven days, bounded to 1,000 start receipts per user and 1,000 step
receipts per execution. At most 100 live prepared starts per user are retained. Missing/expired
receipts are not proof that their effects never occurred. See
[attempt repository](../../packages/shared/src/database/repositories/execution-attempt-repository.ts)
and [mutation coordinator](../../packages/workflow-engine/src/services/execution-mutation-coordinator.ts).

## Running-execution compatibility

Runs load the current saved definition; their start-version stamp is not a frozen executable graph.
Continuation is guarded by the paused node's semantic surface, not the whole workflow version.
The surface includes all current-node fields except explicitly display-only fields, plus registry
descriptors named by that node's `globalInputs`. Hooks, timeout, materialize files, lock reason,
schema, expressions and connections therefore remain bound.

Workflow metadata, version/tags, system reminder, progress presentation and other nodes alone do not
invalidate that paused surface. Node presentation metadata, progress labels/content, connection
labels and `humanGate` are excluded from its digest. Deleting the current node always changes it.
The persisted fact map lets diagnosis name changed/added/removed facts without exposing old values.

After a compatible metadata/context change, `current_step` can rebind a revision-stale presentation
or install a missing one. It must not silently rebind a changed node, foreign workflow or unbound
old attempt. The latter requires diagnosis and a deliberate recovery decision. Catalog updates use
the same [continuation implementation](../../packages/workflow-engine/src/services/continuation-surface.ts)
when identifying affected paused runs; do not recreate its comparison in a loader.

## Diagnosis and recovery

`execution` with `action: "diagnose"` is read-only and separates blocking causes from explanatory facts. A recorded
past error is not a current block. An unresolved rendered reference shows a placeholder but does not
by itself prevent `step`; an absent/revision-stale presentation may only need ordinary refresh.
Missing persisted expression state that no accepted answer can supply is a blocking cause.

`execution` with `action: "recover"` accepts only a live, genuinely broken run. It validates supplied declared global
values, target existence, resumability and missing references/expression inputs. It refuses terminal
or healthy runs, executing/unknown attempts and concurrent execution changes. The target must be a
pause-capable agent directive, teleport, materialize, lock or subgraph; recovery is not an arbitrary
forward execution from a condition or expression.

The guarded write merges supplied values, installs a fresh current-definition-bound attempt and
places the run at the target. The run does not advance beyond that target. Its ordinary presentation
still executes: lock presentation can dispatch approval and subgraph presentation can enter a child.
Choose those effects explicitly. Re-presenting materialize issues delivery again; it does not
rewrite files already present on the caller's computer.

Do not use recovery to resurrect a completed/stopped execution, bypass a valid gate, or assert that
an unknown provider operation failed. Use its original operation receipt and the
[workspace recovery contract](workspaces.md) for owner-held effects. Implementation:
[diagnosis](../../packages/workflow-engine/src/services/continuation-diagnosis.ts),
[recovery](../../packages/workflow-engine/src/services/continuation-recovery.ts).

## Waiting and answering

`humanGate` says the agent is waiting for a person at a step; it does not change the directive,
schema or route. Its condition is evaluated on arrival. A refused answer continuing the same open
wait retains that decision; a real loop back records a new arrival. Editing the gate definition
reconciles the waiting decision without pretending the step was answered.

`execution` with `action: "await-user"` records the agent's current question separately from the route and step
generation. It binds to the current node, takes precedence over a gate's generic label, and clears
when the agent acts or leaves/finishes that node. A person's variable edit is not an agent answer.
Metadata polling does not make an execution active.

The first wait notification is queued with the persisted transition, deduplicated by the actual
wait. `notify: off` suppresses the gate's initial send; an authored notification may own it instead.
A configured `remindAfter` permits one reminder even with `notify: off`. The sender rechecks the
current wait and drops superseded work. Reconnects and rejected answers do not create another wait;
a new visit does. Delivery status is separate from graph progress and may report unavailable
channels or failed delivery. Run-page readers show the current wait's notification, excluding a
not-yet-due reminder. See [notification persistence](../../packages/shared/src/database/execution-notification.ts).

An authored notification runs before its cycle is saved. Its text and progress descriptor use the
live cycle's accepted values and folded visits, with a directly following pause projected in flight;
they must not reread stale persisted context instead. Independently mutable task identity is refreshed
from the owned stored run when preparing delivery, keeping the picture and caption consistent.
Delivered messages retain their historical title. The common
[notification frame](../../packages/workflow-engine/src/services/notification-frame.ts) owns this composition.

Trusted lock admission is separate: a notification-skip option does not waive required trusted
PIN delivery. A lock becomes usable only after delivery; generated PINs are not exposed in ordinary
MCP/workflow reads. HTTP owner-created locks return their creation PIN once. Lost-PIN recovery uses
the explicit owner/admin unlock surfaces, not redisclosure.

The HTTP run-page answer uses the ordinary engine under a durable internal attempt fence. It requires
the expected revision, a running unlocked run and its current input wait, with no agent operation
already executing or unknown. An accepted answer records an actor adjustment and supersedes the
agent's old presentation. A rejected answer can still append diagnostics and advance persisted
revision; a validation error is not a promise of no mutation.

## Metadata and deliberate stop

Step-generation revision and metadata guards answer different questions. Parent, reminders, context
and task identity have separate revision tokens. Metadata edits check the step generation they were
read against but do not consume an otherwise compatible presented step. Preserve null/absence and
idempotency contracts instead of replacing these guards with an unconditional whole-run save.

- A parent must be same-owner, running and acyclic. Linking does not copy variables or authority,
  wait for a child automatically, or complete the parent. Child completion gives continuation
  guidance; the caller reads the parent's current step. Retention preserves a completed parent
  while it has a running child.
- Reminders are requested follow-up actions. Add/update/cancel uses the reminder-set revision;
  an add's idempotency key distinguishes retry from another reminder. Active reminders appear on
  completion; cancellation is preserved as state rather than silently deleting the action.
- Runtime variable writes use declared schema and write policy. A per-path edit validates the
  resulting root value and preserves unrelated fields. Context, adjustment visit and derived activity
  commit together. Arbitrary `variables`/`nodeStates` replacement is not a supported HTTP edit.

### Execution task title

Task identity is explicit per-run metadata, separate from arbitrary notes and parent names. Without
it, readers resolve the run's authored `progress.title`, then its own workflow name. Missing template
values do not become a heading. Explicit rename normalizes and validates the title, checks both
execution and task-identity revisions, and changes identity/activity only when the normalized title
differs. It does not advance step generation. See
[task identity](../../packages/shared/src/types/execution-task-identity.ts).

Owner stop requires a nonnegative safe revision and a trimmed reason of 1–500 characters. The
transaction refuses stale, terminal or executing state; it fences presented/unknown attempts,
supersedes pending wait notifications and records completion time plus `stopReason`. An exact
same-reason retry against the original revision returns the committed result with `changed: false`.
Changed-only audit/metrics avoid turning that retry into a second stop. Stop is not proof that
external provider work has been undone.

## Visits and progress

The stateless engine returns raw chronological `EngineVisit` observations for each cycle. The
stateful executor numbers them and folds a resumed open wait into its existing visit. Teleport
closes the old wait with a teleport exit before recording the target. Accepted outside answers and
runtime variable edits create actor adjustments; they are not another working pass.

The saved route projects onto authored progress blocks. Block status comes from visits and actual
work: an unvisited block is never done merely because an earlier/later block was reached. A routing
pass can skip a block's work; repeated work is distinct from a first pass. A deliberately stopped
open wait remains the frontier, with timing frozen at stop. Pending/skipped blocks suppress outcome
text. Without route history, `routeRecorded` is false and only the current block can be active or
waiting; other blocks remain pending.

Durations are null when timestamps were not recorded, not zero. Timed passes exclude adjustments
and routing-only overhead except where routing itself is the block's work; an end visit does not add
a spurious working duration. Visit counts, iterations and timed passes are different measures.
Bound-list progress reads its declared items/counters, attributes a pass to the item current at its
entry, and preserves unknown counters/times. It does not know a particular plan or checklist.

Current-node content overrides replace only the fields supplied; omitted fields retain the block's
base content. Resolved plain text is bounded after interpolation: overflow is an explicit projection
error, not silent truncation. The [progress authoring contract](../../packages/mcp-server/src/help/content/concepts/workflows.md#static-execution-progress)
owns block/list fields and their validation rules.

A route cursor projects recorded state up to that visit, reconstructing values from changes/defaults
where recorded. It is not a complete historic database snapshot: the current agent question is
excluded, and current definition presentation still applies. Without authored `progress`, transports
return task metadata rather than invent a block graph. Version statistics use that owner's genuinely
completed, stamped runs of the requested start version; a run's own duration is excluded from its
typical comparison. See [projection](../../packages/workflow-engine/src/utils/execution-run-projection-core.ts).

## Overview and live reads

`lastActivityAt` measures work: visit entry/exit, completion and task-identity change. Note/reminder/
parent edits, journal entries, locks and the agent's question do not advance it. Unknown activity is
not invented; selection may use creation time as the fallback. `refusalCount` is a separate journal
projection.

Overview query membership, counts and pagination are decided before presentation. Only matching
owned runs and required owned ancestors are retained; a matching parent does not expose unrelated
descendants. A muted ancestor has `matches: false`. Missing/foreign parents end the owned path;
corrupt ancestry cycles are cut for display without rewriting stored links. Valid deep paths are
not truncated by an artificial display depth.

`subtreeActivityAt` uses matching visible work; `idleActivityAt` considers the entire owned subtree.
Displayed child counts and total direct owned child counts differ. Canonical task-title search is
resolved before membership/page selection. Relative filters share one request clock and return
their effective time interpretation. Snapshot/generation checks prevent mixing changing definitions,
template dependencies, list windows and notification marks. Narrowed progress/title reads exclude
unneeded context and journals and must never be saved as full runs.

An `ids` refresh is an owner-scoped, unfiltered flat read. It updates cards, but does not decide
whether a card belongs in the current filtered page. Re-fetch the page when membership may change.

The change feed commits with row writes; events contain execution ID/kind, not context or credentials.
Deletion events outlive their rows. SSE streams and polling expose only the admitted user's events.
Clients handle `ready`, `change`, `reset` and session-driven close, retaining the cursor across
reconnects. Expired cursors and cursors ahead of a restored database require reset.
The stream also resets when a valid cursor fills its catch-up bound, rather than silently skipping
that backlog. Polling captures its upper sequence before reading; a full catch-up page advances only through its returned last
event. Streams recheck sessions, heartbeat and limit concurrent admissions. A stream is an observer,
not ownership of the run or permission to repeat an operation. Wire details are in
[HTTP live reads](http-api.md#live-execution-reads).

## Delivery grants and owner effects

Materialize grants are repeatable within their current waiting-node/time/authority binding. The first
archive request pins the selected owner and original publication request before submission. Later
requests collect that same publication before any rendering or reselection; a lost response is not
permission to publish elsewhere. Definition changes do not rewrite the pinned immutable archive.
Fresh current-step presentation creates a separate grant; context changes alone do not rewrite
local files. Archive delivery is separate from the bounded context fallback and does not prove the
agent read the files.
The [materialize reference](../../packages/mcp-server/src/help/content/reference/materialize.md)
owns file/path, archive and context-fallback authoring details.

Progress-image download grants additionally bind workflow version, execution/context/task identity
revisions, options and the selected device. They reserve one download, release failed/closed
responses and become used on successful response finish. The owner retains the original immutable
publication independently of that one-time HTTP grant. Neither download nor collection sends another
notification. Workspace and communication effects retain their original operation identity and
uncertainty; [workspaces](workspaces.md) owns that transport/custody contract.
