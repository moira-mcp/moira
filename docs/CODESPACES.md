# Codespaces and GitHub Connection

This reference describes Moira's provider-neutral codespace control plane and
the built-in GitHub Codespaces provider. A codespace is a persistent,
user-owned development environment addressed by an opaque codespace ID. It is
not a chat session: Moira does not receive or store a ChatGPT conversation ID,
and different authorized clients may reuse the same codespace.

A codespace is a personal instrument for executing a flow for an agent that has
no filesystem of its own. It is not shared and is not a collaboration container;
collaboration happens through version-control branches in the repository.

GitHub authorization belongs to the authenticated website. Agents do not
receive provider credentials, OAuth operations, SSH configuration or lifecycle
capabilities. Agents reach codespaces only through the authenticated MCP
`codespace` tool described below; the website owns the GitHub connection and
offers the same basic codespace management (list, create, start, stop, confirmed
delete) over the same services. Administrators own the instance-wide kill switches.

## Component boundary

- `packages/shared/src/codespaces/connection-service.ts` and
  `connection-repository.ts` own tenant-bound GitHub authorization, repository
  grants, credential rotation, revocation and safe status projection.
- `packages/shared/src/codespaces/resource-service.ts` and
  `resource-repository.ts` own persistent codespace identity, policy,
  lifecycle generations, desired and observed state, quotas and reconciliation.
- `packages/shared/src/codespaces/operation-service.ts` and
  `operation-repository.ts` own one durable record per direct operation,
  concurrency reservations, cancellation and terminal cleanup.
- `packages/shared/src/codespaces/file-service.ts`, `transfer-service.ts` and
  `transfer-repository.ts` own provider-neutral file operations, native byte
  authority, quotas and private object lifecycle.
- `packages/shared/src/codespaces/provider-registry.ts` enforces the versioned
  provider contract. GitHub Codespaces is the only registered provider.
- `packages/shared/src/codespaces/credential-vault.ts` owns versioned
  AES-256-GCM credential envelopes bound to the Moira user, provider and opaque
  connection or revocation record.
- `packages/web-backend/src/services/github-codespace-client.ts` translates the
  GitHub App, repository and Codespaces lifecycle APIs.
- `packages/web-backend/src/services/github-codespaces-connector*.{ts,mjs}`
  implement the Unix-socket connector, bounded worker, official GitHub CLI/SSH
  transport and remote direct-operation supervisor.
- `packages/web-backend/src/services/codespace-native-reference-fetcher.ts` and
  `packages/mcp-server/src/codespace-transfer-route.ts` own trusted inbound
  download and private one-use outbound HTTP delivery.
- `packages/web-backend/src/routes/codespace-connections.ts` and
  `packages/web-frontend/src/pages/settings/GitHubCodespaceSettings.tsx` own the
  authenticated website authorization boundary.
- `packages/shared/src/codespaces/views.ts` owns the sanitized codespace and
  operation summaries shared by the website and MCP, the readiness view, its public
  projection and the health-degradation rule; `observability.ts` computes the
  readiness decision, projects the Prometheus gauges and counts audit events with
  closed labels.
- `packages/web-backend/src/routes/codespace-management.ts` and
  `packages/web-frontend/src/pages/settings/GitHubCodespaceManagement.tsx` own the
  authenticated website codespace management; `routes/admin-codespaces.ts` and
  `packages/web-frontend/src/pages/AdminCodespaceControls.tsx` own the administrator
  readiness view and kill switches.
- `packages/mcp-server/src/tools/manage-codespaces.ts` is the agent-facing
  presentation adapter: it takes the tenant from the MCP request context, projects
  sanitized results and maps domain failures to bounded tool errors. Schemas,
  descriptions, examples and native-file metadata live in the typed registry
  (`tool-schemas.ts`, `tool-definitions.ts`). The adapter composes the exported
  `@mcp-moira/web-backend/services` getters and holds no lifecycle, quota,
  credential or byte authority of its own.

Every internal resource or operation lookup supplies the authenticated Moira
user ID and a codespace or operation ID. Ownership is resolved from SQLite;
possession of an opaque ID does not grant access. Provider resource names and
credentials remain server-side.

## Persistent lifecycle

The first provider manages only personal-billed Codespaces created through
Moira for a repository approved by the user's GitHub App installation. Importing
an existing Codespace and organization billing are unsupported.

Core exposes provider-neutral create, list, get, start, stop and delete
operations. A resource records tenant and connection ownership, authorization
generation, repository, the ref requested at creation, the ref the provider last
reported checked out, exact provider identity, selected machine, desired and
observed state, retention policy and lifecycle generation.

The provider repository ID is the repository identity. Its full name is display
metadata: lifecycle reconciliation accepts a provider-side rename, refreshes the
stored name and still refuses a resource whose provider repository ID changed.

The checked-out branch is working state, not identity. After creation, an exact
provider resource belongs to a record when its provider name, Moira marker, owner,
billable owner and repository ID match; the branch it is on is not compared. An
agent may therefore switch branches inside a codespace, or leave it on a detached
HEAD, and start, stop, delete, operations, re-authorization rebind and cleanup keep
addressing the same codespace. Every observation writes the provider's current ref
back to the record, or no ref when the provider reports none.

- Create persists intent and a unique marker before provider contact. Moira
  adopts only the exact returned Codespace after checking account ownership,
  personal billing, repository, requested ref, machine limits, creation time and
  connector reachability. Adoption is the only point where the ref is compared: it
  is compared as a branch name (`refs/heads/x` matches `x`), and a Codespace that
  does not report a ref yet is adopted on the remaining identity. An ambiguous
  provider response remains pending for exact reconciliation. The Codespace is
  always created with GitHub's maximum idle timeout of 240 minutes, whatever the
  owner's settings: GitHub's own timer does not see a silent background command,
  so the owner's shorter timeout is enforced by Moira alone (see "Idle
  auto-pause").
- Start records desired running state before provider contact. While that
  generation remains current, the official GitHub CLI may restore a Codespace
  that stopped outside Moira. Starting a codespace whose provider resource Moira
  has not identified yet returns the retryable `CODESPACE_CREATE_PENDING`; one
  left ambiguous returns `CODESPACE_NOT_RUNNING`, whose detail says it could not
  be identified uniquely.
- An operation addressed to a codespace that is not running starts it and then
  runs, so work does not fail because the codespace idled out between two calls.
  The wait for that start is bounded by `CODESPACE_START_WAIT_SECONDS`; exceeding
  it is `CODESPACE_START_TIMEOUT`, which names the wait and asks the caller to
  retry once the codespace has finished starting. A codespace that cannot start —
  deleted, rejected or being deleted — is refused by that condition without the
  provider being asked to start it, and a start never bypasses a concurrency,
  kind or generation check: the reservation that follows is the same one as
  before. Explicitly starting a codespace remains available and unchanged.
- Stop records desired stopped state, advances the generation, cancels or
  reconciles older operations and stops the exact Codespace. It preserves the
  codespace and repository data.
- Delete is a separate destructive operation. It requires the caller's current
  observed generation, persists delete intent before provider contact and
  becomes terminal only after the exact Codespace is confirmed absent.

Lifecycle work observes the exact Codespace before it acts. A Codespace already
in the desired state completes without a provider mutation: a stop of a Codespace
the provider already shut down makes no stop call, a stop of a Codespace the
provider reports as failed completes as stopped with the observed state `failed`,
and a start of an available one only probes the connector. While the provider
reports the Codespace as
provisioning, starting or stopping, a start or stop stays pending and issues
nothing. Delete is issued directly, without a stop first, for persistent delete
and for legacy cleanup. When the provider refuses a mutation, the Codespace is
observed again: a record whose goal was reached anyway settles, and one the
provider is still moving stays pending instead of reporting the refusal.

Repeating a pending lifecycle request does not advance its generation. A
provider response lost during create, start, stop or delete is reconciled from
the exact stored identity and intent; broad discovery or deletion is not used.
Finishing a command, disconnecting an MCP client or ending a conversation never
deletes a persistent codespace.

The background reconciler takes one re-authorization rebind attempt per tick and
then a bounded batch of due records. A record whose pass does not converge it waits
before its next attempt: `CODESPACE_RECONCILE_INTERVAL_SECONDS` after the first
such pass, doubling with each consecutive one and capped at 30 minutes, and never
later than the create deadline of a codespace still being created or identified, so
a tick never takes the same record twice. A new user
request for the codespace and a pass that settles it reset that wait. Records a
rebind pass could not re-verify move to the back of the rebind order, so one
codespace that cannot be rebound does not hold back other users' codespaces.

Disconnect first cancels operations and stops persistent codespaces. It does
not silently delete their data. A later authorization rebinds a codespace
automatically when the same GitHub account, approved repository and exact provider
resource still match, whichever branch the codespace has checked out, or when that
exact resource is gone, so a later stop or delete settles it as absent; a different
account or a disconnected connection keeps it fenced. Stored resource rows from the
disposable contract retain the explicit `legacy_disposable` policy and continue to
follow exact cleanup.

A provider that refuses a create, start, stop or delete is reported by what it
refused rather than as an internal failure. A refused stored grant is
`CODESPACE_AUTHORIZATION_REQUIRED`; a repository the provider no longer exposes,
or a request it rejects as malformed, conflicting with the current state or
unprocessable (HTTP 400, 409, 422), is the non-retryable
`CODESPACE_RESOURCE_INVALID`; any other provider status is the retryable
`CODESPACE_PROVIDER_UNAVAILABLE`. Each carries the provider's own reason when it
is safe to repeat: the refused response body is reduced to one line and capped,
and a message containing anything credential-shaped — a token, a labelled
secret, a JWT or any URL — is dropped whole, leaving the HTTP status as the only
detail.

The lifecycle service derives a stable idempotency key from the resource,
generation, refused action, outcome and bounded provider detail. The audit sink
inserts that key under a unique database index, so the same refusal produces one
audit row across restarts and concurrent reconcilers. A changed refusal detail has
a different key and is recorded separately; an internal failure is not recorded as
the provider's answer.

Durable global and provider controls act as kill switches. A disabled control
rejects new creation, start and operation reservations, while already required
stop, cancellation and cleanup work remains eligible for reconciliation.

### Idle auto-pause

Two built-in, non-administrative user settings in category `codespaces` control
idle pausing. The Settings page shows them in its general settings editor, and the
settings API and the MCP `settings` tool read and write them:

| Setting                           | Type    | Default | Meaning                                                 |
| --------------------------------- | ------- | ------: | ------------------------------------------------------- |
| `codespaces.auto_stop_enabled`    | boolean |  `true` | Moira stops the owner's idle codespaces                 |
| `codespaces.idle_timeout_minutes` | number  |      30 | Idle time before a stop; 5 to 240, the range GitHub has |

A write outside 5–240 is refused on every settings write path; a stored value
outside that range is read as the default. The `codespaces` setting namespace is
reserved, so no extension can declare a key in it.

Each scheduled reconciler tick first observes the provider, then stops idle
codespaces, then reconciles. Idleness counts only agent work through Moira. A
persistent codespace is idle when it is usable and meant to run, its owner has
auto-pause on, none of its operations is reserved, running or awaiting
cancellation or reconciliation (a background command counts as running), and the
latest of these is older than the owner's timeout: its creation, Moira's own
activity (adoption, a completed start, an operation reservation) and the last
change of any of its operations. Commands, file operations and transfers all run
as operations. For each idle codespace, up to a bounded batch per tick, Moira
requests a stop exactly as a user stop does, with the outcome
`idle_stop_requested`; the stop converges through ordinary lifecycle and preserves
data, and the next operation starts the codespace again. The request re-checks the
whole idle condition in the same database statement, so an operation reserved
after the scan wins and nothing is stopped under it.

Moira does not see direct use of a codespace in a browser, an editor or over SSH,
so a codespace a person works in directly is paused once no agent has used it for
the owner's timeout; owners who work in their codespaces directly turn auto-pause
off. Independently of Moira, GitHub stops a codespace after at most 240 minutes
without user or terminal activity, with auto-pause on or off. That limit equals
the default `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS`, so GitHub can still stop a
codespace under a background command that produces no terminal activity near the
end of its permitted run, and under any such command allowed to run longer by a
raised setting.

Provider observation lists, in each tick, the codespaces of a bounded number of
users who have a running codespace and whose last listing is at least ten
reconcile intervals old, least recently listed first, with one listing per user.
For each running codespace in the listing, Moira records the checked-out ref and
the provider's `last_used_at`, which GitHub sets when the codespace was last
started; it is stored for information and plays no part in the idle decision, and
a listing that omits it keeps the previous value. A codespace the provider already
shut down — by its own idle timeout or by a stop outside Moira — is recorded as
stopped without any provider call: its generation advances, operations of the
previous generation are cancelled, the stop is audited with the outcome
`provider_observed_stopped`, and the next use starts it again. A codespace
observed in a tick is judged for idleness in the next tick.

## Direct operations

The provider-neutral operation service executes one command in a running
codespace. A request contains an argv array, a codespace-relative working
directory, bounded stdin and a timeout. Arguments are data and are never
interpolated into a shell program. Stdin is either inline bytes or a tenant-bound
private transfer reference with an exact declared size and MIME type. A native
reference request reserves the authenticated running codespace and an operation slot
before source fetch. The resulting private object is claimed before credential lookup,
consumed immediately after durable dispatch intent and materialized as exact binary
connector input without model-context base64. `CodespaceOperationService.executeNativeReference()`
composes native reference validation/fetch/storage with that dispatch path; callers do
not handle the internal `codespace-file://` capability.

The remote supervisor runs the command directly as the ordinary Codespace user
inside the selected repository. It keeps its opaque marker, process-group facts
and bounded result outside the repository. The result preserves separate stdout
and stderr, terminal state and exit code.

The GitHub adapter mounts its provider-owned operation root from
`MOIRA_CODESPACES_ROOT`, whose default is `/workspaces`. That path is a Codespaces
runtime convention used by the remote supervisor, not a public alias for the
renamed Moira domain.

A dispatched command is durable and resumable as soon as the connector accepts it,
and the dispatch call then waits briefly for the outcome: a command that finishes
inside that bounded window returns its terminal result from the same call, and one
that does not returns the running envelope whose operation ID resumes it. The wait
only inspects, so a command still reaches the connector exactly once however its
result is collected, and it does not change the operation deadline or any bound.
File operations share this dispatch and behave the same way.

Before connector contact, SQLite reserves the authenticated tenant, codespace
and authorization generations, per-user and global concurrency, input bytes,
independent stdout/stderr bounds and deadline. SQLite stores only
operation metadata. It does not store argv, cwd, stdin, stdout, stderr, provider
tokens or SSH configuration.

Cancellation targets the recorded foreground process group and validates the
process start time before signalling. A lost worker, SSH connection or control
response is not treated as successful cancellation: the operation remains
`reconcile_pending` and occupies capacity until remote inspection proves a
terminal or absent state, or an explicit codespace stop/delete terminates the
provider environment. A reservation abandoned before dispatch expires without
connector contact; dispatch intent is durable before a remote command can start.

A command's complete standard output and standard error are written into its own
remote operation directory as it runs. The per-stream response limits bound only
what an answer carries; they neither stop the command nor replace its standard
error. One bound does stop a command: `CODESPACE_MAX_RETAINED_OUTPUT_MB` is the
disk a single command's retained output may occupy in the codespace, and passing
it kills the foreground process group and is reported as reaching that ceiling
rather than as the command's own failure.

When background reconciliation observes a terminal command, it records only
bounded result metadata in SQLite and retains the remote stdout/stderr file for
the configured cleanup window, or for as long as the command itself was allowed
to run when that is longer. A result therefore stays collectible for at least the
command's own permitted duration, which is what makes an unattended background
command safe to collect late. Caller reconciliation can read the same result
repeatedly during that window. Only after the window expires may background
cleanup finalize the remote operation directory; failed finalization remains a
durable, idempotently retried obligation.

A terminal result reports the complete size of each stream next to its bounded
payload, so a caller knows what the answer omitted. Any range of a retained
stream is read with the `read` action by naming the command's `operation_id` and
`stream` instead of a path. That read is a bounded control request rather than a
new operation: it creates no operation record, is fenced by the same ownership,
resource-generation and authorization rules as every other call against that
operation, requires the named codespace to own that command, and returns
`CODESPACE_RESULT_EXPIRED` once cleanup has removed the streams with the result.
A read that starts at or past the end of a stream returns no bytes and the
stream's current size, which is how a caller finds where a stream ends.

A command may also be started in the background. It is the same operation, the
same single dispatch and the same resume path; only its ceiling and its deadline
differ. It is admitted against `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS` instead
of `CODESPACE_MAX_OPERATION_SECONDS`, its deadline is that lifetime so background
reconciliation observes it rather than cancelling it, and the dispatching call
returns as soon as the remote runner is proven alive, without the settle window a
bounded command uses. A caller that names no duration receives the one its mode
implies: 300 seconds for a bounded command, the whole ceiling for a background
one. The lifetime is granted when the command starts running, so a reservation
that never dispatches is reaped within fifteen minutes whatever it asked for. Its output is readable by range while it runs, and it is
stopped by resuming it with a cancellation request. A command that outlives the
codespace's idle lifetime stops with the codespace, so the two values belong
together.

A codespace restart takes every process with it and leaves the operation files
behind. The codespace records the life of the environment each command is
dispatched in, and an inspection that finds no result, no live process and a
different life reports the operation as interrupted; the operation becomes
terminal with `codespace_restarted` recorded as why it ended, which is distinct
both from a cancellation the caller asked for and from a command that failed on
its own. The caller sees that distinction: the operation carries
`interrupted_by_restart` and the answer is `CODESPACE_OPERATION_INTERRUPTED`
rather than the generic command failure. A file operation is not reported this way: it is replayed from its
journal instead, which is what keeps an interrupted write recoverable.

The fixed connector ceilings are 4 MiB of raw input, 8 MiB for each output
stream and 15 minutes for a bounded command; a background command's own timer may
run up to a day. A remote job request is bounded separately and never waits for a
command to end. Runtime policy may lower these ceilings but
cannot raise them. An argv contains 1–128 non-empty arguments; each argument is
at most 16 KiB, and the relative cwd is at most 4096 bytes.

## File operations and native transfer

The provider-neutral file service addresses the same persistent `codespace_id` as
command execution. It supports stat, bounded literal or regular-expression search,
byte-range read, atomic write, structured multi-file patch, native-reference upload
and private download. Each request reserves a durable operation kind, codespace and
authorization generation, deadline and byte budget before credential or connector
contact. SQLite stores no path, query, patch or file content.

Paths are repository-relative data. Empty components, `.`/`..`, absolute and drive
paths, NUL bytes and overlong values are rejected. The Codespaces supervisor snapshots
the verified repository identity, opens each directory component without following
links and keeps the opened parent across staging and replacement. Final files must be
single-link regular files. Symlinks, hard links, directories in file position, FIFOs,
sockets and devices are rejected.

Read returns an explicit byte offset, total size, content digest and a bounded byte
range. Search is bounded by scanned/result bytes, match count and remote time and does
not traverse links or special files. It also skips the repository's own `.git`
directory wherever it meets one and refuses a search rooted at or inside it; those
files stay readable, writable and inspectable by exact path. Skipping is not
truncation: `truncated` still reports only that a bound stopped the walk.
Regular expressions execute in a terminable worker;
a match that reaches the search deadline returns a truncated result instead of blocking
the supervisor event loop. The result-byte ceiling covers the complete serialized search
envelope, including its action, match separators and `truncated` state. A typed file
failure carries no file payload and therefore remains recordable even when the caller's
success-payload budget is smaller than a JSON error envelope.

Write requires an expected existence state and may require the previous size and
SHA-256 digest. Patch supplies ordered byte edits for each file. A successful patch
returns old/new versions and a content-free summary containing complete file, edit and
inserted/deleted-byte totals. Ordered per-file summary entries fit a connector-selected
4 KiB serialized budget and set `truncated` when the complete totals describe more files
than can be listed. The remote supervisor applies the supplied internal budget only
within its separate protocol safety range.

All patch targets are staged before mutation; a repository-relative transaction journal,
backups and ordered file/directory sync produce one original or one replacement set after
interruption. Exact-marker ownership is published atomically from a complete process
identity, so overlapping execute and reconciliation calls do not run the same mutation
twice. Each journal entry also binds the opened parent device and inode. Commit and
recovery re-resolve that repository-relative parent and fail before mutation if the
namespace now points at another directory. The connector validates the complete remote
result as untrusted input, including exact result variants, operation/action agreement,
relative paths, byte ranges, versions, search coordinates and bounds, unique patch paths,
summary totals and agreement between inner and outer success or failure state.

Inbound native references contain a `sediment://file_...` identifier, HTTPS download
URL, safe file name, supported MIME type and declared size. Only the reviewed OpenAI
storage host families are accepted. Every redirect repeats issuer, DNS and connected-
peer validation; IP literals and any mixed or non-public resolution are rejected.
Declared, HTTP and observed sizes plus MIME must agree. Text is admitted as valid UTF-8;
JSON must parse; PDF, ZIP, gzip, tar, PNG, JPEG, GIF and WebP declarations must match
their format signatures. `application/octet-stream` remains intentionally opaque. The
absolute transfer expiry also bounds a response that continues to produce data.

Transfer bytes live under `<dirname(DB_PATH)>/codespace-transfers`, separate from
public artifacts. SQLite stores only a digest of the capability, tenant, purpose,
size/MIME/digest metadata, expiry, claim state and the creating process identity.
Per-user and instance-wide object, aggregate-byte and in-flight-byte reservations occur
before source I/O. For outbound download, the declared `maxBytes` capacity is reserved
before credential or connector contact and atomically reduced to the observed file size
when the object is published. Published directory entries are synced before their SQLite
state becomes ready. Expired physical objects remain quota-bound until cleanup removes
their bytes and metadata together. Startup and periodic cleanup preserve reservations
owned by either live Moira process, verify each ready/claimed object's type, link count,
size and digest, and remove dead, expired, consumed, partial, missing or invalid objects.
If an upload becomes invalid after ingestion because its codespace generation, operation
deadline, dispatch fence or credential lookup changed, the now-unreachable private object
is discarded immediately.

Outbound download uses the rate-limited
`/api/codespaces/transfers/:token` capability route. It sends an attachment with
`no-store`, `noindex`, `nosniff` and no-referrer controls and consumes the capability
after complete or interrupted delivery. The raw capability is redacted from application
logs, and both Nginx variants proxy this prefix to the MCP process unbuffered with
access and error logging disabled. The `download` action returns the capability to the
agent as an MCP `resource_link`; its structured result carries name, MIME type, size,
digest and expiry but not the URL.

## MCP tools

The authenticated MCP catalog exposes the whole codespace surface as one tool,
`codespace`, whose required `action` selects the operation: `list`, `setup_help`, `create`, `get`,
`start`, `stop`, `delete`, `exec`, `stat`, `search`, `read`, `write`, `apply_patch`,
`upload` and `download`. The public tools reference renders its schema from the typed
registry. Changing it changes `MCP_TOOLS_REVISION`, so a client holding an older catalog
receives the ordinary HTTP 426 reconnect contract.

Every action derives the user from the MCP request context and addresses a persistent
resource by `codespace_id`; the tool accepts no user, chat, session, OAuth, provider
token, SSH or capability field. The published schema is one flat root object carrying
`action` plus the union of every action's fields, of which only `action` is required —
the projection this repository uses wherever a client may not read a root `anyOf`. It
stays strict, so a field no action declares is refused there; the adapter then applies
the requested action's own strict contract, so a field belonging to a different action,
a mixed stdin form or a partial resume call is refused as `CODESPACE_REQUEST_INVALID`
rather than by the published schema. A default an action declares is applied by that
contract and is deliberately absent from the published object, which would otherwise
inject every action's defaults into every request; the field keeps its description. A field two
actions declare differently — `max_bytes`, which `search` bounds at 1 MiB and `download` at 4 MiB —
is published as both forms under one key, so the projection narrows neither. `operation_id`, whose
declarations differ only in description, is published once. The `list` action returns the sanitized connection readiness (with the
same-origin Settings URL), approved repository targets, the user's codespace
summaries and the user's `limits`; it is the discovery path for `repository_id` and
reusable `codespace_id`.

`limits` is the view `CodespaceObservabilityService.limits()` builds from policy and
the database alone, without a provider call, and the website management list returns
the same view. Every limit in it is the value Moira enforces, taken from the one
definition every enforcement site reads (`effectiveCodespaceLimits` in
`resource-policy.ts`), beside the user's current use:

| Group             | Fields                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codespaces`      | `held` (codespaces the user holds, stopped ones and ones being created, identified or cleaned up included), `max_per_user`, `instance_held`, `max_instance`, `create_throttle_seconds`                           |
| `machine_ceiling` | `cpu_cores`, `memory_bytes`, `storage_bytes`                                                                                                                                                                     |
| `operations`      | `active` (the user's unfinished operations), `max_concurrent_per_user`, `max_input_bytes`, `max_stdout_bytes`, `max_stderr_bytes`, `max_retained_output_bytes`, `max_duration_seconds`, `max_background_seconds` |
| `transfers`       | `used_bytes`, `objects`, `inflight_bytes` (bytes still reserved or claimed), `max_bytes_per_user`, `max_inflight_bytes_per_user`, `max_objects_per_user`, `max_file_bytes`, `ttl_seconds`                        |
| `lifecycle`       | `retention_days`, `start_wait_seconds`, `idle` { `auto_stop_enabled`, `timeout_minutes` (the owner's settings), `provider_max_minutes` (GitHub's maximum idle timeout) }                                         |
| `provider`        | `billing: "unavailable"`: GitHub does not expose the account's Codespaces quota or billing to Moira                                                                                                              |

`instance_held` is the only instance-wide figure; no other user's codespaces or
identifiers appear.
Every grant-dependent discovery or creation action — `list`, `setup_help` and
`create` — refreshes the stored installation and repository snapshot after a
bounded TTL before using it. `list` also accepts `refresh: true` to force that
attempt. A provider failure returns the previous snapshot with
`repositories_stale: true` from `list` and `setup_help`, while a successful refresh
updates both installation selection and repositories without reconnecting.
Snapshot replacement is one database transaction guarded by the credential generation
and the monotonic `grantsVersion`, so a slower process cannot overwrite a newer snapshot.
Deleted and rejected codespaces are finished and accept no operation, so they are
absent from that listing and from the website's, which reads the same service method.
The `get` action returns one owned summary; an unknown or foreign ID returns the
generic `CODESPACE_NOT_FOUND` result. A summary reports `requested_ref`, the ref the
codespace was created on, and `current_ref`, the ref the provider last reported
checked out, which is `null` until Moira has observed one and while the codespace is
on a detached HEAD; `create` still takes the input `ref`. Summaries omit connection and authorization
generations, external owner/billing IDs, operation markers, provider resource names,
claims and capabilities.

The `stop` action returns `data_preserved: true`. `delete` requires
`confirm_delete: true` and the caller's current `expected_generation`, so a stale call
cannot remove a changed codespace, and returns `data_preserved: false`.

The execution and file actions return a sanitized operation envelope (`operation_id`,
`kind`, `state`, bounded byte counts, `exit_code`, deadline and result expiry) plus the
action result. Failed, cancelled and timed-out commands and rejected file edits are
returned as tool errors (`isError: true`) that keep the operation identity and any
bounded output. A pending or `reconcile_pending` envelope is not a success: calling
the same action again with only `codespace_id` and `operation_id` reconciles that
operation without dispatching a second command, write, upload or download. The
same resume call with `cancel: true` stops a command instead of reporting it.

Consecutive commands share a working context through a named session. A caller
opens one with `session` and `session_start: true` and continues it by naming
`session` alone. The session remembers the `cwd` a call names and the variables a
call passes in `env`, and applies both to every command that continues it; a
command without a session is unaffected.

Inside a session a caller may send `script` instead of `argv`. The script is run
by the codespace's own shell and sourced, so its directory changes and exports
take effect, and the session then keeps the directory it ended in together with
the variables it added, changed or removed. A removal is remembered as a removal,
so a later command does not see a variable the script took away. Only the
difference from the environment the script started in is kept, never the whole
inherited environment, which is what keeps the codespace's own environment out of
the stored file; the few variables a shell maintains for itself are excluded. An
argv command is never run through a shell, and a call carries exactly one kind of
work: `argv`, a `script` inside a session, or ending a session with neither.

`session_end: true` ends the named session, alone or alongside a command. Ending
frees the session's slot and removes its stored context. A codespace holds at most
sixteen sessions of its current life, and opening one past that is refused with
that ceiling named; a session left by an earlier life holds no slot and is removed
by the call that ends it.

A script is at most 64 KiB of text, and the stored context is bounded by 64
variables and 64 KiB, enforced where it is written. A call whose declared context would cross that is refused as a bounded
policy outcome naming the stored-context ceiling, and the previous context
survives. A script whose end state fits is stored whether the script succeeded or failed;
one whose end state would not fit, or a script that ended its own shell with
`exit` or was stopped before it finished, carries nothing and the result says
`session_capture_dropped` rather than leaving a session that later commands
cannot use. A capture obeys every rule the stored context is read back under, so a
variable whose name or value the context cannot hold drops the capture instead of
wedging the session.

A session belongs to the codespace life it was opened in. The remote side stores it
beside the operation directories in the codespace's own state root, together with
the identity of the running environment, which on Linux is the kernel boot identity
and the first process's start time; an explicit override is honoured only where
those sources do not exist. A command naming a session from an earlier life,
or one that was never opened, is refused with `CODESPACE_SESSION_UNAVAILABLE` and
does not run. The stored context never returns to the caller. A session name is
validated data, never a path: the remote side builds the path from a name it has
accepted, and a session's stored working directory is resolved by the same rule that
refuses any escape from the repository.

The `exec` action accepts argv as data, an optional repository-relative `cwd`,
`timeout_seconds`, `background`, `session`, `session_start`, `session_end`, `env`, `script`, optional per-stream output limits and exactly one optional stdin
form: `stdin_text` (UTF-8) or `stdin_file`, a native ChatGPT file reference. The
registry publishes `_meta["openai/fileParams"]` on the tool for both `stdin_file` and
`file`; inside a reference only `file_id` and `download_url` are
required, while `file_name`, `mime_type` and `size_bytes` are optional. Native input
goes directly through the one-call native execution path and is never staged through
the `upload` action; neither the file ID nor the temporary URL is echoed back.

The `read` action returns UTF-8 text with offset, total size and, for a repository
file, SHA-256; `length` defaults to 64 KiB, and `search` defaults to 100 matches within 64 KiB of
result bytes, so a call that names only the codespace, path and query is complete.
A range that is not valid UTF-8 returns `CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD`
instead of base64. The `write` action replaces a file atomically from UTF-8 text under an explicit
existence precondition with optional size/digest guards; `apply_patch` takes
ordered byte-offset edits with UTF-8 replacement text and returns old/new versions and
the content-free summary. The `download` action returns the private transfer as a
`resource_link` (see the previous section).

`setup_help` diagnoses the current configuration, connection, installation, repository
approval, instance-control and capacity condition after the same bounded grant refresh.
It returns `repositories_stale` with the provider-owned instruction and the applicable
Settings, installation, repository-creation and console links; the installation link is
present when its configured URL is valid. This surface remains available when operational
services cannot start. Moira cannot create a repository, so repository guidance tells the
user to create it at the provider and then add it to the provider installation.

Known connection, codespace, state, policy and provider failures become bounded tool
errors with `code`, safe `message` and `retryable`; actionable setup, authorization and
capacity refusals carry the same provider link set as `setup_help`, plus the
same-origin `settings_url` where applicable. A refusal that knows a bounded fact the caller
may act on adds it to that message: a creation refused by `CODESPACE_POLICY_LIMIT` names
whether the per-user ceiling on held codespaces (stopped ones count, so the message
suggests deleting one no longer needed), the instance-wide ceiling or the creation
throttle stopped it, and that ceiling's configured value. The addition never names a
user, codespace or repository, so a caller refused by instance capacity learns only that
the instance is full. The website management API adds the same sentence to its own
message for the same refusals. Input that matches no strict request form
returns `CODESPACE_REQUEST_INVALID` whose message names the offending field paths
and the generic schema issue (for example `expected: Required`), never the
submitted values. Unexpected failures return the generic
`INTERNAL_ERROR` to the agent and are recorded server-side with the tool name and the
request context's opaque IDs, never with agent input. The MCP process logs only the
tool name and UUID-validated codespace/operation IDs for these tools; paths, queries,
patches, argv, text and native references do not enter request context.

## Website management

The Settings page renders a Cloud codespaces card under Integrations. It shows the
instance readiness, discloses that an authorized agent has the Codespace user's
repository, network and configured-secret access, lets the user create a codespace
for an approved repository and ref, and lists the user's codespaces with repository,
current branch (the requested ref until a current one is observed), provider and
machine context, state, desired/observed state, generation and last update. Start and Stop are available for stopped and running codespaces; Delete
requires a confirmation that names the repository and points to Stop for keeping data.
Actions are disabled while a codespace is in a pending, cleanup or ambiguous state.
The card keeps a saved repository list visible with a stale warning when provider
enumeration fails. It never mentions chats or sessions.

The routes are mounted under `/api/integrations/github/codespaces` behind
`requireAuth` and are a second presentation of the same services the MCP tools use,
with identical tenant, generation and confirmation authority:

| Method   | Path                  | Behavior                                                                                                                                              |
| -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/`                   | Refreshes grants behind the TTL, then returns readiness, connection, approved repositories, `repositories_stale`, summaries still in use and `limits` |
| `POST`   | `/`                   | Refreshes grants before authorization and creation for `repository_id` and `ref`; returns the sanitized (possibly pending) codespace                  |
| `GET`    | `/:codespaceId`       | One owned codespace plus its recent metadata-only operations                                                                                          |
| `POST`   | `/:codespaceId/start` | Records desired running state; `data_preserved: true`                                                                                                 |
| `POST`   | `/:codespaceId/stop`  | Records desired stopped state; `data_preserved: true`                                                                                                 |
| `DELETE` | `/:codespaceId`       | Requires `confirm_delete: true` and the current `expected_generation`; `data_preserved: false`                                                        |

Domain failures map to bounded codes: not found and malformed IDs return the generic
404, generation conflicts and not-running states 409, quota and busy 429, provider
disabled or unavailable 503, and a missing feature configuration 503 with the
same-origin Settings link. Responses never carry provider resource names, markers,
claims, capabilities or credentials.

## Readiness, metrics and controls

`CodespaceObservabilityService.readiness()` is the one instance-level readiness
decision. Its states are `disabled` (configuration absent or
`CODESPACE_CODESPACES_ENABLED` false), `misconfigured` (invalid GitHub App or vault
configuration), `control_disabled` (a kill switch is on), `connector_unavailable`
(the credential connector does not answer its health probe) and `ready`. The view
also carries the configuration state, both controls, connector state, the
reconciliation backlog (resources and operations awaiting reconciliation, including
resources held by a claim or waiting out a retry backoff, plus the age of the oldest) and active resources/operations and live transfer bytes against
their limits. It contains no user, codespace or operation identifier, and the
connector is never probed while the feature is disabled.

The complete view is served to authenticated callers: the website management list,
`GET /api/admin/system-status` (`systemHealth.codespaces`) and the agent's
`instance` summary the `list` action returns. The unauthenticated liveness surfaces
`GET /api/health` and MCP `GET /health` receive only the public projection
`{ state, provider, degraded }`, served from `snapshot()`: the last computed decision
while it is younger than twice `CODESPACE_RECONCILE_INTERVAL_SECONDS`, otherwise one
recomputation shared by concurrent requests. The connector health probe is bounded to
two seconds; a slower probe yields `connector_unavailable` with reason
`health_probe_timeout`, so a stalled connector never holds a health request open.
`isCodespaceReadinessDegraded` is the single rule:
`misconfigured` and `connector_unavailable` degrade the instance; `disabled` and
`control_disabled` are healthy.

Prometheus metrics on the internal metrics port use closed labels only:

| Metric                                                  | Labels                                | Meaning                                                    |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `moira_codespace_connection_events_total`               | `provider`, `action`                  | Connection start/complete/refresh_failed/disconnect events |
| `moira_codespace_lifecycle_events_total`                | `provider`, `action`, `state`         | Resource create/start/stop/delete/cleanup outcomes         |
| `moira_codespace_operation_events_total`                | `provider`, `kind`, `action`, `state` | Operation reserve/reconcile/terminal outcomes              |
| `moira_codespace_operation_duration_seconds`            | `kind`, `state`                       | Reservation-to-terminal duration histogram                 |
| `moira_codespace_rejections_total`                      | `code`                                | Refusals before provider contact by bounded error code     |
| `moira_codespace_reconciliation_due`                    | `kind`                                | Records waiting for reconciliation                         |
| `moira_codespace_reconciliation_oldest_due_age_seconds` | `kind`                                | Age of the oldest waiting record                           |
| `moira_codespace_active`                                | `kind`                                | Active resources and operations                            |
| `moira_codespace_transfer_live_bytes`                   | —                                     | Bytes reserved or held by private transfers                |
| `moira_codespace_connector_available`                   | `provider`                            | 1 when the connector answers its health probe              |
| `moira_codespace_ready`                                 | `provider`                            | 1 when the instance accepts new codespace work             |

Both the web backend and the MCP server process refresh their readiness decision and
gauges on `CODESPACE_RECONCILE_INTERVAL_SECONDS`; every readiness computation also
refreshes them. Suggested alert conditions: `moira_codespace_ready`
equal to 0 while `CODESPACE_CODESPACES_ENABLED=true`; `moira_codespace_connector_available`
equal to 0; `moira_codespace_reconciliation_oldest_due_age_seconds` above several
reconcile intervals; a rising rate of `moira_codespace_rejections_total` with
`code="CODESPACE_POLICY_LIMIT"` or `"CODESPACE_OPERATION_BUSY"` (quota saturation);
`moira_codespace_lifecycle_events_total{action="create_rejected"}` or
`moira_codespace_connection_events_total{action="refresh_failed"}` increasing; and an
unusual rate of `moira_codespace_operation_events_total{action="reserve"}`.

Kill switches are the durable `codespaceProviderControl` rows for the `global` scope
and the `provider:github-codespaces` scope. Administrators read and change them through
`GET /api/admin/codespaces` and `PUT /api/admin/codespaces/controls/:scope` (body
`{ "disabled": boolean, "reason"?: string }`) or the Codespaces tab of the admin
Settings page, which shows the readiness facts and asks for confirmation before
stopping work. Disabling refuses new create, start and operation reservations,
rejects unsubmitted creates and requests stop for persistent codespaces through
ordinary reconciliation; it never deletes data. Re-enabling clears the control. Every
change is audited as `CODESPACE_CONTROL_UPDATE` with the scope, flag, reason and the
number of codespaces asked to stop.

## Trust and isolation

Direct execution is not an agent sandbox. An authorized agent has the same
repository, installed tools, network and configured Codespaces secrets available
to the Codespace user. Repository content can influence the agent, and commands
can read or transmit those values. A command may also create a detached daemon
or modify startup files beyond the foreground process group. Moira therefore does
not claim to protect codespace data from an agent the user authorized. Restricted
execution is outside this contract.

The connector boundary protects the multi-tenant Moira server:

- the credential-bearing connector is non-root, read-only, capability-limited
  runs under an init process that reaps finished gh/ssh helpers, and is bounded to
  1 CPU, 640 MiB memory and 384 tasks (each job's worker is further limited to 256
  processes and threads);
- it mounts only private Unix-socket volumes and a bounded tmpfs, with no Moira
  database, data directory, vault key, Docker socket or other-tenant volume;
- `network_mode: none` removes its direct network path;
- a separate credential-free CONNECT proxy accepts only reviewed
  GitHub/Codespaces HTTPS hosts, rejects IP-literal and non-public resolution,
  and verifies the connected peer; the proxy is bounded to 0.25 CPU, 128 MiB
  memory and 128 tasks.

The optional Compose profile is disabled by default. Start the connector pair
with the same application image only after configuring the GitHub App, vault and
codespace policy:

```bash
docker compose --profile codespaces up -d
```

## Runtime configuration

Codespace GitHub configuration is distinct from `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`, which belong to Better Auth social login.

| Variable                                 | Contract                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `CODESPACE_GITHUB_APP_CLIENT_ID`         | GitHub App client ID                                              |
| `CODESPACE_GITHUB_APP_CLIENT_SECRET`     | Generated GitHub App client secret; server-only                   |
| `CODESPACE_GITHUB_APP_CALLBACK_URL`      | Exact same-origin `/api/integrations/github/callback` URL         |
| `CODESPACE_GITHUB_APP_INSTALL_URL`       | Exact `https://github.com/apps/<slug>/installations/new` URL      |
| `CODESPACE_CREDENTIAL_VAULT_KEY`         | Dedicated random 32-byte key encoded as 64 hexadecimal characters |
| `CODESPACE_CREDENTIAL_VAULT_KEY_VERSION` | Envelope key identifier; defaults to `v1`                         |

The GitHub App must request these permissions; the user grants them when installing
the App on their account, and a later permission change must be accepted by the user
on GitHub before the connection works again:

| GitHub App permission                  | Level | Used for                                               |
| -------------------------------------- | ----- | ------------------------------------------------------ |
| Repository: Codespaces                 | write | create, list, inspect and delete the user's Codespaces |
| Repository: Codespaces lifecycle admin | write | start and stop a Codespace                             |
| Repository: Codespaces metadata        | read  | list the machine types available for a repository      |
| Repository: Contents                   | read  | resolve the requested ref                              |
| Repository: Metadata                   | read  | enumerate the installation's approved repositories     |

Enable "Request user authorization (OAuth) during installation" and expiring user
authorization tokens; the callback URL is the exact same-origin Moira path below.
No Setup URL is needed: with user authorization during installation enabled, GitHub
returns the browser to the callback URL after an installation, and Moira recognizes
that return. "Redirect on update" is optional; without it, a user who changes the
installation's repositories on GitHub applies the change with **Check installation**
or **Refresh** in Settings.
If all connection values are absent, the integration is disabled. A partial,
weak, cross-origin or malformed configuration produces a safe configuration
error without aborting unrelated authentication. The callback uses HTTPS for a
public host, contains no query or fragment and shares the configured Moira
origin. Runtime secrets are not baked into the image.

Codespace creation and direct operations require
`CODESPACE_CODESPACES_ENABLED=true`. These policy defaults apply when a value is
not supplied:

| Variable                                       | Default | Meaning                                                      |
| ---------------------------------------------- | ------: | ------------------------------------------------------------ |
| `CODESPACE_MAX_CPU_CORES`                      |       4 | Maximum selected Linux machine CPU cores                     |
| `CODESPACE_MAX_MEMORY_GB`                      |       8 | Maximum selected machine memory                              |
| `CODESPACE_MAX_STORAGE_GB`                     |      32 | Maximum selected machine storage                             |
| `CODESPACE_MAX_ACTIVE_PER_USER`                |       4 | Codespaces a user may hold, stopped ones included            |
| `CODESPACE_MAX_ACTIVE_GLOBAL`                  |      16 | Codespaces held across the instance, stopped ones included   |
| `CODESPACE_CREATE_THROTTLE_SECONDS`            |      60 | Minimum interval between creation reservations               |
| `CODESPACE_REMOTE_TTL_MINUTES`                 |     120 | Creation expiry; only legacy disposable rows use it          |
| `CODESPACE_PERSISTENT_RETENTION_DAYS`          |      30 | Codespaces stopped-codespace retention requested at creation |
| `CODESPACE_CREATE_DEADLINE_MINUTES`            |      15 | Create reconciliation deadline                               |
| `CODESPACE_CLEANUP_DEADLINE_MINUTES`           |      15 | Lifecycle cleanup deadline and terminal-result retention     |
| `CODESPACE_CLAIM_LEASE_SECONDS`                |      30 | Cross-process reconciliation claim lease                     |
| `CODESPACE_RECONCILE_INTERVAL_SECONDS`         |      30 | Background reconciliation interval                           |
| `CODESPACE_START_WAIT_SECONDS`                 |     180 | Wait for a codespace an operation started; 5 to 900          |
| `CODESPACE_MAX_CONCURRENT_OPERATIONS_PER_USER` |       8 | Direct operations per user                                   |
| `CODESPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL`   |      32 | Direct operations across the instance                        |
| `CODESPACE_MAX_OPERATION_INPUT_KB`             |    1024 | Maximum direct-operation stdin                               |
| `CODESPACE_MAX_OPERATION_STDOUT_KB`            |    1024 | Stdout carried by one answer                                 |
| `CODESPACE_MAX_OPERATION_STDERR_KB`            |     256 | Stderr carried by one answer                                 |
| `CODESPACE_MAX_RETAINED_OUTPUT_MB`             |      64 | Retained output per stream before a command is stopped       |
| `CODESPACE_MAX_OPERATION_SECONDS`              |     900 | Maximum bounded-command duration                             |
| `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS`     |       4 | Maximum background-command duration                          |
| `CODESPACE_MAX_TRANSFER_FILE_MB`               |       4 | Maximum native or file payload; maximum 4 MiB                |
| `CODESPACE_MAX_TRANSFER_TOTAL_MB_PER_USER`     |     100 | Live private-transfer bytes per user                         |
| `CODESPACE_MAX_TRANSFER_TOTAL_MB_GLOBAL`       |    1024 | Live private-transfer bytes across the instance              |
| `CODESPACE_MAX_TRANSFER_OBJECTS_PER_USER`      |      10 | Live private-transfer objects per user                       |
| `CODESPACE_MAX_TRANSFER_OBJECTS_GLOBAL`        |    1000 | Live private-transfer objects across the instance            |
| `CODESPACE_MAX_TRANSFER_INFLIGHT_MB_PER_USER`  |      40 | Reserved/claimed transfer bytes per user                     |
| `CODESPACE_MAX_TRANSFER_INFLIGHT_MB_GLOBAL`    |     256 | Reserved/claimed transfer bytes across the instance          |
| `CODESPACE_TRANSFER_TTL_MINUTES`               |      10 | Private capability and object lifetime; maximum 60 minutes   |

The global active-resource limit cannot be lower than the per-user limit; the same
rule applies to operation concurrency and the global/per-user byte and in-flight
transfer pairs. Transfer byte and in-flight aggregates cannot be lower than the
single-file ceiling.
Configured operation input cannot
exceed 4096 KiB, either output stream cannot exceed 8192 KiB, command duration
cannot exceed 900 seconds and persistent retention cannot exceed 30 days.

## Website authorization API

All routes are mounted under `/api/integrations` after `requireAuth`.

| Method   | Path                          | Behavior                                                                                                                          |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/github`                     | Refreshes an expired grant snapshot and returns the sanitized connection view with `repositoriesStale`                            |
| `POST`   | `/github/refresh`             | Forces grant enumeration and returns the current view; a provider failure retains the snapshot and sets `repositoriesStale: true` |
| `GET`    | `/github/start`               | Stores one-time browser state and redirects to GitHub; a refused start redirects to Settings with `?github=<outcome>`             |
| `GET`    | `/github/callback`            | Consumes state, verifies GitHub identity/grants and redirects; a return from App installation (no state) re-reads grants          |
| `DELETE` | `/github`                     | Stops managed work, revokes the GitHub grant and disconnects                                                                      |
| `DELETE` | `/github/external-revocation` | Clears an eligible blocked state after external grant revocation                                                                  |

The external-revocation body must be `{ "confirmed": true }`, and the user
must first revoke the GitHub App grant in GitHub. Start stores a SHA-256 digest
of one-time state bound to the Moira user, web session and provider. It expires
after ten minutes, is consumed once and returns only a bounded outcome on the
same-origin Settings URL.

Connecting takes one pass through GitHub. **Connect GitHub** starts one
authorization; when the account has no App installation yet, the callback stores the
credential and sends the browser straight to the configured installation URL. After
the user installs or updates the App, GitHub returns the browser to the callback
with `installation_id`/`setup_action` and no Moira state. Nothing in that return is
trusted and its code is never exchanged: with a readable stored credential and a
`connected` or `installation_required` connection, Moira re-reads the installations
and repositories with that credential and redirects to Settings with
`github=connected` or `github=installation_required`; otherwise it redirects to the
absolute `/api/integrations/github/start` URL on the configured origin. The
authorization does not force GitHub's account chooser, so switching GitHub accounts
is Disconnect followed by Connect.

A start the browser cannot proceed with redirects to Settings (`303`) with a
`github` outcome the page explains in a message: `already_connected`,
`revocation_pending`, `not_configured`, `credential_unreadable`,
`grant_revocation_required`, `previous_access_not_revoked` (an earlier credential
still awaits revocation), `session_required` or `authorization_failed`. The callback
itself redirects with `connected`, `installation_required` or
`authorization_failed`. Callback query strings are redacted from application logs
and omitted from nginx access logs.

The Settings integration renders sanitized connection and repository-grant
state. Its Refresh button uses the forced endpoint, while ordinary page reads
honor the ten-minute snapshot TTL, except while the connection is
`installation_required`: then every read enumerates the grants afresh, so the
Settings page, the website codespace list and the MCP `list` action show a new
installation at once. In that state the card offers **Install GitHub App** (when the
installation URL is configured) and **Check installation**, which forces a grant
refresh, instead of Reconnect; Reconnect remains for `refresh_failed` and
`disconnected`. A provider enumeration failure leaves the saved list
visible with an explicit stale warning. It never returns a provider token, client secret, vault key, connection
ID or revocation ID. There is no agent-facing authorization, callback, device
flow or polling method.

## Credential lifecycle

The service accepts expiring GitHub App user credentials with a `ghu_` access
token and rotating `ghr_` refresh token. A classic `gho_` OAuth token is
rejected. Numeric GitHub identifiers are stored as validated decimal strings.

Refresh claims a durable lease and commits the encrypted successor with a
generation compare-and-swap. Concurrent processes wait for that successor.
Before replacement, the previous credential is copied into an encrypted
pending-revocation record and revoked exactly. Provider ambiguity, expiry,
unreadable ciphertext or an abandoned lease prevents use of the predecessor.

A new authorization for a user who already has a credential commits the new
credential first — the generation advances and codespaces are rebound. The same
database transaction queues the previous token in an encrypted pending-revocation
record, so at every moment the old token is either stored or queued; only after the
commit is it revoked. A revocation GitHub refuses leaves the connection connected
and the superseded credential queued; the next successful grant refresh,
authorization or disconnect retries it.
While such a revocation is still queued, a later explicit Connect is refused with
the `previous_access_not_revoked` outcome.

If a refresh may have issued a successor that Moira could neither retain nor
revoke, Settings requires revocation of the entire GitHub App grant followed by
explicit external-revocation confirmation. Restoring the matching vault key and
version makes the credential readable again and restores ordinary reconnect or
disconnect. Pending revocation remains durable and retryable until GitHub
accepts it.

## Persistence and audit

Historical migrations `0027_workspace_connections.sql`, `0028_workspace_resources.sql`,
`0029_persistent_workspace_operations.sql`, `0030_workspace_transfers.sql` and
`0031_workspace_daily_budget_removal.sql` create the original tables without being
rewritten. Migration `0037_codespace_rename.sql` renames those tables and indexes,
preserves their rows and foreign keys, adds `grantsRefreshedAt` and the monotonic
`grantsVersion` to connection snapshots, adds the nullable audit `dedupeKey`, and
converts persisted codespace outcomes, transfer purposes and audit identifiers.
Migration `0039_codespace_observed_ref.sql` adds the resource's nullable
`observedRef`, the ref last observed checked out, and its `reconcileFailures`
counter, which drives the reconciliation retry backoff. Migration
`0040_codespace_activity.sql` adds the resource's `lastActivityAt` (Moira's last work
in the codespace) and `providerLastUsedAt` (the provider's last start time, stored for information), and the
connection's `resourcesObservedAt`, which paces provider observation. The resulting connection, resource, lifecycle-capability, policy-usage,
provider-mutation, provider-control, operation and private-transfer metadata tables
use the `codespace` vocabulary. Credential tables
contain versioned ciphertext; resource, operation and transfer tables contain
authority and accounting metadata but no command, path, query, patch, file content,
native source URL, result stream, provider token or SSH material.

Credential envelope version 1 keeps its original authenticated-context label so
pre-rename ciphertext remains decryptable. New writes use envelope version 2 and
the codespace label. On startup, the transfer service also moves the former
`workspace-transfers` data root to `codespace-transfers` (or merges non-conflicting
objects when both exist), so stored private transfers are not orphaned by the rename.

Audit actions cover connection start/completion/refresh failure/disconnect;
resource create/pending/rejection/cleanup/start/stop/delete; typed exec/file
operation reservation/reconciliation/terminal outcomes; and administrator control
updates. Metadata is limited to opaque
resource relationships, provider, state/outcome, selected machine facts, byte
counts, exit code and, for a refusal, a bounded `reason`. A creation rejected by the connector probe
records the connector's own failure; a creation the provider rejected, and a start, stop or delete the
provider refused, record the redacted provider reason described under "Persistent lifecycle". A
refused lifecycle operation is audited under the operation it refused, with the refusing HTTP status
as its outcome, including a refusal reached through background reconciliation, where no caller is
waiting to see it. A failure that is not the provider's answer is not audited as one.
The connector sidecar keeps the underlying `gh`/`ssh` diagnostics in its own
container log with the credential redacted; the application never receives them. Repository content, source, argv, cwd, stdin, stdout,
stderr, OAuth code/state, session token and provider credentials are excluded.

## Verification

Use the root project commands; do not call Jest directly:

```bash
npm run test:unit
npm run test:integration
docker compose config --quiet --no-env-resolution --no-path-resolution --no-interpolate
npm run test:docker-connector-isolation
```

The last command builds the runtime image target on the local Docker daemon and
proves, from inside a connector container, that another tenant's volume, the Docker
socket, the Moira application endpoint, the host bridge and cloud metadata are
unreachable through the actual filesystem and network policy while the reviewed
GitHub egress path stays usable; it removes its containers, network and volumes on
exit and ends with `codespace-connector-isolation-ok`.

`tests/COVERAGE-MAP.md` maps the focused connection, resource, operation,
migration, connector, egress, packaged-isolation, MCP tool, website management,
readiness/metrics and kill-switch suites, including the ChatGPT-compatible client
scenario over real services, the HTTP contracts against the local container
(`npm run test:mcp-tools`, `npm run test:api`) and the Settings browser scenarios
(`npm run test:e2e`). Live GitHub App user
credentials, an actual personal Codespace and ChatGPT are separate external
compatibility gates; deterministic tests do not establish them.
