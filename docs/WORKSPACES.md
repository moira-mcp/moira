# Workspaces and GitHub Connection

This reference describes Moira's provider-neutral workspace control plane and
the built-in GitHub Codespaces provider. A workspace is a persistent,
user-owned development environment addressed by an opaque workspace ID. It is
not a chat session: Moira does not receive or store a ChatGPT conversation ID,
and different authorized clients may reuse the same workspace.

GitHub authorization belongs to the authenticated website. Agents do not
receive provider credentials, OAuth operations, SSH configuration or lifecycle
capabilities. Agents reach workspaces only through the authenticated MCP
`workspace_*` tools described below; the website owns the GitHub connection and
offers the same basic workspace management (list, create, start, stop, confirmed
delete) over the same services. Administrators own the instance-wide kill switches.

## Component boundary

- `packages/shared/src/workspaces/connection-service.ts` and
  `connection-repository.ts` own tenant-bound GitHub authorization, repository
  grants, credential rotation, revocation and safe status projection.
- `packages/shared/src/workspaces/resource-service.ts` and
  `resource-repository.ts` own persistent workspace identity, policy,
  lifecycle generations, desired and observed state, quotas and reconciliation.
- `packages/shared/src/workspaces/operation-service.ts` and
  `operation-repository.ts` own one durable record per direct operation,
  concurrency reservations, cancellation and terminal cleanup.
- `packages/shared/src/workspaces/file-service.ts`, `transfer-service.ts` and
  `transfer-repository.ts` own provider-neutral file operations, native byte
  authority, quotas and private object lifecycle.
- `packages/shared/src/workspaces/provider-registry.ts` enforces the versioned
  provider contract. GitHub Codespaces is the only registered provider.
- `packages/shared/src/workspaces/credential-vault.ts` owns versioned
  AES-256-GCM credential envelopes bound to the Moira user, provider and opaque
  connection or revocation record.
- `packages/web-backend/src/services/github-workspace-client.ts` translates the
  GitHub App, repository and Codespaces lifecycle APIs.
- `packages/web-backend/src/services/github-codespaces-connector*.{ts,mjs}`
  implement the Unix-socket connector, bounded worker, official GitHub CLI/SSH
  transport and remote direct-operation supervisor.
- `packages/web-backend/src/services/workspace-native-reference-fetcher.ts` and
  `packages/mcp-server/src/workspace-transfer-route.ts` own trusted inbound
  download and private one-use outbound HTTP delivery.
- `packages/web-backend/src/routes/workspace-connections.ts` and
  `packages/web-frontend/src/pages/settings/GitHubWorkspaceSettings.tsx` own the
  authenticated website authorization boundary.
- `packages/shared/src/workspaces/views.ts` owns the sanitized workspace and
  operation summaries shared by the website and MCP, the readiness view, its public
  projection and the health-degradation rule; `observability.ts` computes the
  readiness decision, projects the Prometheus gauges and counts audit events with
  closed labels.
- `packages/web-backend/src/routes/workspace-management.ts` and
  `packages/web-frontend/src/pages/settings/GitHubWorkspaceManagement.tsx` own the
  authenticated website workspace management; `routes/admin-workspaces.ts` and
  `packages/web-frontend/src/pages/AdminWorkspaceControls.tsx` own the administrator
  readiness view and kill switches.
- `packages/mcp-server/src/tools/manage-workspaces.ts` is the agent-facing
  presentation adapter: it takes the tenant from the MCP request context, projects
  sanitized results and maps domain failures to bounded tool errors. Schemas,
  descriptions, examples and native-file metadata live in the typed registry
  (`tool-schemas.ts`, `tool-definitions.ts`). The adapter composes the exported
  `@mcp-moira/web-backend/services` getters and holds no lifecycle, quota,
  credential or byte authority of its own.

Every internal resource or operation lookup supplies the authenticated Moira
user ID and a workspace or operation ID. Ownership is resolved from SQLite;
possession of an opaque ID does not grant access. Provider resource names and
credentials remain server-side.

## Persistent lifecycle

The first provider manages only personal-billed Codespaces created through
Moira for a repository approved by the user's GitHub App installation. Importing
an existing Codespace and organization billing are unsupported.

Core exposes provider-neutral create, list, get, start, stop and delete
operations. A resource records tenant and connection ownership, authorization
generation, repository and ref, exact provider identity, selected machine,
desired and observed state, retention policy and lifecycle generation.

- Create persists intent and a unique marker before provider contact. Moira
  adopts only the exact returned Codespace after checking account ownership,
  personal billing, repository, ref, machine limits, creation time and connector
  reachability. An ambiguous provider response remains pending for exact
  reconciliation.
- Start records desired running state before provider contact. While that
  generation remains current, the official GitHub CLI may restore a Codespace
  that stopped outside Moira.
- Stop records desired stopped state, advances the generation, cancels or
  reconciles older operations and stops the exact Codespace. It preserves the
  workspace and repository data.
- Delete is a separate destructive operation. It requires the caller's current
  observed generation, persists delete intent before provider contact and
  becomes terminal only after the exact Codespace is confirmed absent.

Repeating a pending lifecycle request does not advance its generation. A
provider response lost during create, start, stop or delete is reconciled from
the exact stored identity and intent; broad discovery or deletion is not used.
Finishing a command, disconnecting an MCP client or ending a conversation never
deletes a persistent workspace.

Disconnect first cancels operations and stops persistent workspaces. It does
not silently delete their data. A later authorization can rebind a workspace
only when the same GitHub account, approved repository and exact provider
resource still match. Stored resource rows from the disposable contract retain
the explicit `legacy_disposable` policy and continue to follow exact cleanup.

Durable global and provider controls act as kill switches. A disabled control
rejects new creation, start and operation reservations, while already required
stop, cancellation and cleanup work remains eligible for reconciliation.

## Direct operations

The provider-neutral operation service executes one command in a running
workspace. A request contains an argv array, a workspace-relative working
directory, bounded stdin and a timeout. Arguments are data and are never
interpolated into a shell program. Stdin is either inline bytes or a tenant-bound
private transfer reference with an exact declared size and MIME type. A native
reference request reserves the authenticated running workspace and operation budget
before source fetch. The resulting private object is claimed before credential lookup,
consumed immediately after durable dispatch intent and materialized as exact binary
connector input without model-context base64. `WorkspaceOperationService.executeNativeReference()`
composes native reference validation/fetch/storage with that dispatch path; callers do
not handle the internal `workspace-file://` capability.

The remote supervisor runs the command directly as the ordinary Codespace user
inside the selected repository. It keeps its opaque marker, process-group facts
and bounded result outside the repository. The result preserves separate stdout
and stderr, terminal state and exit code.

Before connector contact, SQLite reserves the authenticated tenant, workspace
and authorization generations, daily usage, per-user and global concurrency,
input bytes, independent stdout/stderr bounds and deadline. SQLite stores only
operation metadata. It does not store argv, cwd, stdin, stdout, stderr, provider
tokens or SSH configuration.

Cancellation targets the recorded foreground process group and validates the
process start time before signalling. A lost worker, SSH connection or control
response is not treated as successful cancellation: the operation remains
`reconcile_pending` and occupies capacity until remote inspection proves a
terminal or absent state, or an explicit workspace stop/delete terminates the
provider environment. A reservation abandoned before dispatch expires without
connector contact; dispatch intent is durable before a remote command can start.

When background reconciliation observes a terminal command, it records only
bounded result metadata in SQLite and retains the remote stdout/stderr file for
the configured cleanup window. Caller reconciliation can read the same result
repeatedly during that window. Only after the window expires may background
cleanup finalize the remote operation directory; failed finalization remains a
durable, idempotently retried obligation.

The fixed connector ceilings are 4 MiB of raw input, 8 MiB for each output
stream and 15 minutes per command. Runtime policy may lower these ceilings but
cannot raise them. An argv contains 1–128 non-empty arguments; each argument is
at most 16 KiB, and the relative cwd is at most 4096 bytes.

## File operations and native transfer

The provider-neutral file service addresses the same persistent `workspace_id` as
command execution. It supports stat, bounded literal or regular-expression search,
byte-range read, atomic write, structured multi-file patch, native-reference upload
and private download. Each request reserves a durable operation kind, workspace and
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
not traverse links or special files. Regular expressions execute in a terminable worker;
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

Transfer bytes live under `<dirname(DB_PATH)>/workspace-transfers`, separate from
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
If an upload becomes invalid after ingestion because its workspace generation, operation
deadline, dispatch fence or credential lookup changed, the now-unreachable private object
is discarded immediately.

Outbound download uses the rate-limited
`/api/workspaces/transfers/:token` capability route. It sends an attachment with
`no-store`, `noindex`, `nosniff` and no-referrer controls and consumes the capability
after complete or interrupted delivery. The raw capability is redacted from application
logs, and both Nginx variants proxy this prefix to the MCP process unbuffered with
access and error logging disabled. `workspace_download` returns the capability to the
agent as an MCP `resource_link`; its structured result carries name, MIME type, size,
digest and expiry but not the URL.

## MCP tools

The authenticated MCP catalog exposes the workspace surface as separate tools:
`workspace_list`, `workspace_create`, `workspace_get`, `workspace_start`,
`workspace_stop`, `workspace_delete`, `workspace_exec`, `workspace_stat`,
`workspace_search`, `workspace_read`, `workspace_write`, `workspace_apply_patch`,
`workspace_upload` and `workspace_download`. The public tools reference renders their
schemas from the typed registry. Adding or changing any of them changes
`MCP_TOOLS_REVISION`, so a client holding an older catalog receives the ordinary
HTTP 426 reconnect contract.

Every tool derives the user from the MCP request context and addresses a persistent
resource by `workspace_id`; no tool accepts a user, chat, session, OAuth, provider
token, SSH or capability field, and strict schemas reject unknown fields before any
service call. Each execution and file tool publishes one flat root-object schema in
which only `workspace_id` is required (and `file_name`/`mime_type` for download); the
adapter then applies the strict request form, so exactly one stdin form, a
resume call carrying only `workspace_id` and `operation_id`, and a complete new
request are the only accepted shapes. `workspace_list` returns the sanitized connection readiness (with the
same-origin Settings URL), approved repository targets and the user's workspace
summaries; it is the discovery path for `repository_id` and reusable `workspace_id`.
`workspace_get` returns one owned summary; an unknown or foreign ID returns the
generic `WORKSPACE_NOT_FOUND` result. Summaries omit connection and authorization
generations, external owner/billing IDs, operation markers, provider resource names,
claims and capabilities.

`workspace_stop` returns `data_preserved: true`. `workspace_delete` requires
`confirm_delete: true` and the caller's current `expected_generation`, so a stale call
cannot remove a changed workspace, and returns `data_preserved: false`.

Execution and file tools return a sanitized operation envelope (`operation_id`,
`kind`, `state`, bounded byte counts, `exit_code`, deadline and result expiry) plus the
action result. Failed, cancelled and timed-out commands and rejected file edits are
returned as tool errors (`isError: true`) that keep the operation identity and any
bounded output. A pending or `reconcile_pending` envelope is not a success: calling
the same tool again with only `workspace_id` and `operation_id` reconciles that
operation without dispatching a second command, write, upload or download.

`workspace_exec` accepts argv as data, a repository-relative `cwd`,
`timeout_seconds`, optional per-stream output limits and exactly one optional stdin
form: `stdin_text` (UTF-8) or `stdin_file`, a native ChatGPT file reference. The
registry publishes `_meta["openai/fileParams"]` for `stdin_file` and for
`workspace_upload.file`; inside a reference only `file_id` and `download_url` are
required, while `file_name`, `mime_type` and `size_bytes` are optional. Native input
goes directly through the one-call native execution path and is never staged through
the public upload tool; neither the file ID nor the temporary URL is echoed back.

`workspace_read` returns UTF-8 text with offset, total size and SHA-256. A range that
is not valid UTF-8 returns `WORKSPACE_BINARY_READ_REQUIRES_DOWNLOAD` instead of
base64. `workspace_write` replaces a file atomically from UTF-8 text under an explicit
existence precondition with optional size/digest guards; `workspace_apply_patch` takes
ordered byte-offset edits with UTF-8 replacement text and returns old/new versions and
the content-free summary. `workspace_download` returns the private transfer as a
`resource_link` (see the previous section).

Known connection, workspace, state, policy and provider failures become bounded tool
errors with `code`, safe `message` and `retryable`; setup and authorization failures
add only the same-origin `settings_url`. Unexpected failures return the generic
`INTERNAL_ERROR` to the agent and are recorded server-side with the tool name and the
request context's opaque IDs, never with agent input. The MCP process logs only the
tool name and UUID-validated workspace/operation IDs for these tools; paths, queries,
patches, argv, text and native references do not enter request context.

## Website management

The Settings page renders a Cloud workspaces card under Integrations. It shows the
instance readiness, discloses that an authorized agent has the Codespace user's
repository, network and configured-secret access, lets the user create a workspace
for an approved repository and ref, and lists the user's workspaces with repository,
ref, provider and machine context, state, desired/observed state, generation and last
update. Start and Stop are available for stopped and running workspaces; Delete
requires a confirmation that names the repository and points to Stop for keeping data.
Actions are disabled while a workspace is in a pending, cleanup or ambiguous state.
The card never mentions chats or sessions.

The routes are mounted under `/api/integrations/github/workspaces` behind
`requireAuth` and are a second presentation of the same services the MCP tools use,
with identical tenant, generation and confirmation authority:

| Method   | Path                  | Behavior                                                                                       |
| -------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`    | `/`                   | Readiness, connection view, approved repositories and sanitized workspace summaries            |
| `POST`   | `/`                   | Create for `repository_id` and `ref`; returns the sanitized (possibly pending) workspace       |
| `GET`    | `/:workspaceId`       | One owned workspace plus its recent metadata-only operations                                   |
| `POST`   | `/:workspaceId/start` | Records desired running state; `data_preserved: true`                                          |
| `POST`   | `/:workspaceId/stop`  | Records desired stopped state; `data_preserved: true`                                          |
| `DELETE` | `/:workspaceId`       | Requires `confirm_delete: true` and the current `expected_generation`; `data_preserved: false` |

Domain failures map to bounded codes: not found and malformed IDs return the generic
404, generation conflicts and not-running states 409, quota and busy 429, provider
disabled or unavailable 503, and a missing feature configuration 503 with the
same-origin Settings link. Responses never carry provider resource names, markers,
claims, capabilities or credentials.

## Readiness, metrics and controls

`WorkspaceObservabilityService.readiness()` is the one instance-level readiness
decision. Its states are `disabled` (configuration absent or
`WORKSPACE_CODESPACES_ENABLED` false), `misconfigured` (invalid GitHub App or vault
configuration), `control_disabled` (a kill switch is on), `connector_unavailable`
(the credential connector does not answer its health probe) and `ready`. The view
also carries the configuration state, both controls, connector state, the
reconciliation backlog (resources and operations the loop would claim now, plus the
age of the oldest) and active resources/operations and live transfer bytes against
their limits. It contains no user, workspace or operation identifier, and the
connector is never probed while the feature is disabled.

The complete view is served to authenticated callers: the website management list,
`GET /api/admin/system-status` (`systemHealth.workspaces`) and the agent's
`workspace_list.instance` summary. The unauthenticated liveness surfaces
`GET /api/health` and MCP `GET /health` receive only the public projection
`{ state, provider, degraded }`, served from `snapshot()`: the last computed decision
while it is younger than twice `WORKSPACE_RECONCILE_INTERVAL_SECONDS`, otherwise one
recomputation shared by concurrent requests. The connector health probe is bounded to
two seconds; a slower probe yields `connector_unavailable` with reason
`health_probe_timeout`, so a stalled connector never holds a health request open.
`isWorkspaceReadinessDegraded` is the single rule:
`misconfigured` and `connector_unavailable` degrade the instance; `disabled` and
`control_disabled` are healthy.

Prometheus metrics on the internal metrics port use closed labels only:

| Metric                                                  | Labels                                | Meaning                                                    |
| ------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `moira_workspace_connection_events_total`               | `provider`, `action`                  | Connection start/complete/refresh_failed/disconnect events |
| `moira_workspace_lifecycle_events_total`                | `provider`, `action`, `state`         | Resource create/start/stop/delete/cleanup outcomes         |
| `moira_workspace_operation_events_total`                | `provider`, `kind`, `action`, `state` | Operation reserve/reconcile/terminal outcomes              |
| `moira_workspace_operation_duration_seconds`            | `kind`, `state`                       | Reservation-to-terminal duration histogram                 |
| `moira_workspace_rejections_total`                      | `code`                                | Refusals before provider contact by bounded error code     |
| `moira_workspace_reconciliation_due`                    | `kind`                                | Records waiting for reconciliation                         |
| `moira_workspace_reconciliation_oldest_due_age_seconds` | `kind`                                | Age of the oldest waiting record                           |
| `moira_workspace_active`                                | `kind`                                | Active resources and operations                            |
| `moira_workspace_transfer_live_bytes`                   | —                                     | Bytes reserved or held by private transfers                |
| `moira_workspace_connector_available`                   | `provider`                            | 1 when the connector answers its health probe              |
| `moira_workspace_ready`                                 | `provider`                            | 1 when the instance accepts new workspace work             |

Both the web backend and the MCP server process refresh their readiness decision and
gauges on `WORKSPACE_RECONCILE_INTERVAL_SECONDS`; every readiness computation also
refreshes them. Suggested alert conditions: `moira_workspace_ready`
equal to 0 while `WORKSPACE_CODESPACES_ENABLED=true`; `moira_workspace_connector_available`
equal to 0; `moira_workspace_reconciliation_oldest_due_age_seconds` above several
reconcile intervals; a rising rate of `moira_workspace_rejections_total` with
`code="WORKSPACE_POLICY_LIMIT"` or `"WORKSPACE_OPERATION_BUSY"` (quota saturation);
`moira_workspace_lifecycle_events_total{action="create_rejected"}` or
`moira_workspace_connection_events_total{action="refresh_failed"}` increasing; and an
unusual rate of `moira_workspace_operation_events_total{action="reserve"}`.

Kill switches are the durable `workspaceProviderControl` rows for the `global` scope
and the `provider:github-codespaces` scope. Administrators read and change them through
`GET /api/admin/workspaces` and `PUT /api/admin/workspaces/controls/:scope` (body
`{ "disabled": boolean, "reason"?: string }`) or the Workspaces tab of the admin
Settings page, which shows the readiness facts and asks for confirmation before
stopping work. Disabling refuses new create, start and operation reservations,
rejects unsubmitted creates and requests stop for persistent workspaces through
ordinary reconciliation; it never deletes data. Re-enabling clears the control. Every
change is audited as `WORKSPACE_CONTROL_UPDATE` with the scope, flag, reason and the
number of workspaces asked to stop.

## Trust and isolation

Direct execution is not an agent sandbox. An authorized agent has the same
repository, installed tools, network and configured Codespaces secrets available
to the Codespace user. Repository content can influence the agent, and commands
can read or transmit those values. A command may also create a detached daemon
or modify startup files beyond the foreground process group. Moira therefore does
not claim to protect workspace data from an agent the user authorized. Restricted
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
workspace policy:

```bash
docker compose --profile workspaces up -d
```

## Runtime configuration

Workspace GitHub configuration is distinct from `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`, which belong to Better Auth social login.

| Variable                                 | Contract                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `WORKSPACE_GITHUB_APP_CLIENT_ID`         | GitHub App client ID                                              |
| `WORKSPACE_GITHUB_APP_CLIENT_SECRET`     | Generated GitHub App client secret; server-only                   |
| `WORKSPACE_GITHUB_APP_CALLBACK_URL`      | Exact same-origin `/api/integrations/github/callback` URL         |
| `WORKSPACE_GITHUB_APP_INSTALL_URL`       | Exact `https://github.com/apps/<slug>/installations/new` URL      |
| `WORKSPACE_CREDENTIAL_VAULT_KEY`         | Dedicated random 32-byte key encoded as 64 hexadecimal characters |
| `WORKSPACE_CREDENTIAL_VAULT_KEY_VERSION` | Envelope key identifier; defaults to `v1`                         |

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
If all connection values are absent, the integration is disabled. A partial,
weak, cross-origin or malformed configuration produces a safe configuration
error without aborting unrelated authentication. The callback uses HTTPS for a
public host, contains no query or fragment and shares the configured Moira
origin. Runtime secrets are not baked into the image.

Workspace creation and direct operations require
`WORKSPACE_CODESPACES_ENABLED=true`. These policy defaults apply when a value is
not supplied:

| Variable                                       | Default | Meaning                                                      |
| ---------------------------------------------- | ------: | ------------------------------------------------------------ |
| `WORKSPACE_MAX_CPU_CORES`                      |       4 | Maximum selected Linux machine CPU cores                     |
| `WORKSPACE_MAX_MEMORY_GB`                      |       8 | Maximum selected machine memory                              |
| `WORKSPACE_MAX_STORAGE_GB`                     |      32 | Maximum selected machine storage                             |
| `WORKSPACE_MAX_ACTIVE_PER_USER`                |       1 | Active resource reservations per user                        |
| `WORKSPACE_MAX_ACTIVE_GLOBAL`                  |       4 | Active resource reservations across the instance             |
| `WORKSPACE_MAX_OPERATIONS_PER_DAY`             |     200 | Submitted lifecycle and direct operations per user/UTC day   |
| `WORKSPACE_CREATE_THROTTLE_SECONDS`            |      60 | Minimum interval between creation reservations               |
| `WORKSPACE_REMOTE_TTL_MINUTES`                 |     120 | Codespaces idle timeout requested at creation                |
| `WORKSPACE_PERSISTENT_RETENTION_DAYS`          |      30 | Codespaces stopped-workspace retention requested at creation |
| `WORKSPACE_CREATE_DEADLINE_MINUTES`            |      15 | Create reconciliation deadline                               |
| `WORKSPACE_CLEANUP_DEADLINE_MINUTES`           |      15 | Lifecycle cleanup deadline and terminal-result retention     |
| `WORKSPACE_CLAIM_LEASE_SECONDS`                |      30 | Cross-process reconciliation claim lease                     |
| `WORKSPACE_RECONCILE_INTERVAL_SECONDS`         |      30 | Background reconciliation interval                           |
| `WORKSPACE_MAX_CONCURRENT_OPERATIONS_PER_USER` |       2 | Direct operations per user                                   |
| `WORKSPACE_MAX_CONCURRENT_OPERATIONS_GLOBAL`   |      20 | Direct operations across the instance                        |
| `WORKSPACE_MAX_OPERATION_INPUT_KB`             |    1024 | Maximum direct-operation stdin                               |
| `WORKSPACE_MAX_OPERATION_STDOUT_KB`            |    1024 | Maximum stdout                                               |
| `WORKSPACE_MAX_OPERATION_STDERR_KB`            |     256 | Maximum stderr                                               |
| `WORKSPACE_MAX_OPERATION_SECONDS`              |     900 | Maximum direct-operation duration                            |
| `WORKSPACE_MAX_TRANSFER_FILE_MB`               |       4 | Maximum native or file payload; maximum 4 MiB                |
| `WORKSPACE_MAX_TRANSFER_TOTAL_MB_PER_USER`     |     100 | Live private-transfer bytes per user                         |
| `WORKSPACE_MAX_TRANSFER_TOTAL_MB_GLOBAL`       |    1024 | Live private-transfer bytes across the instance              |
| `WORKSPACE_MAX_TRANSFER_OBJECTS_PER_USER`      |      10 | Live private-transfer objects per user                       |
| `WORKSPACE_MAX_TRANSFER_OBJECTS_GLOBAL`        |    1000 | Live private-transfer objects across the instance            |
| `WORKSPACE_MAX_TRANSFER_INFLIGHT_MB_PER_USER`  |      40 | Reserved/claimed transfer bytes per user                     |
| `WORKSPACE_MAX_TRANSFER_INFLIGHT_MB_GLOBAL`    |     256 | Reserved/claimed transfer bytes across the instance          |
| `WORKSPACE_TRANSFER_TTL_MINUTES`               |      10 | Private capability and object lifetime; maximum 60 minutes   |

The global active-resource limit cannot be lower than the per-user limit; the same
rule applies to operation concurrency and the global/per-user byte and in-flight
transfer pairs. Transfer byte and in-flight aggregates cannot be lower than the
single-file ceiling.
Configured operation input cannot
exceed 4096 KiB, either output stream cannot exceed 8192 KiB, command duration
cannot exceed 900 seconds and persistent retention cannot exceed 30 days.

## Website authorization API

All routes are mounted under `/api/integrations` after `requireAuth`.

| Method   | Path                          | Behavior                                                                                                                               |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/github`                     | Returns the current user's sanitized connection view                                                                                   |
| `GET`    | `/github/start`               | Stores one-time browser state and redirects to GitHub                                                                                  |
| `GET`    | `/github/callback`            | Consumes state, verifies GitHub identity/grants and redirects; a GitHub return from App installation (no state) restarts authorization |
| `DELETE` | `/github`                     | Stops managed work, revokes the GitHub grant and disconnects                                                                           |
| `DELETE` | `/github/external-revocation` | Clears an eligible blocked state after external grant revocation                                                                       |

The external-revocation body must be `{ "confirmed": true }`, and the user
must first revoke the GitHub App grant in GitHub. Start stores a SHA-256 digest
of one-time state bound to the Moira user, web session and provider. It expires
after ten minutes, is consumed once and returns only a bounded outcome on the
same-origin Settings URL. After the user installs the App, GitHub redirects to the
callback with `installation_id`/`setup_action` and no Moira state; that return is not
trusted and is answered with a redirect to `/github/start`, so the completed
authorization re-reads the installations and the connection becomes `connected`. Callback query strings are redacted from application
logs and omitted from nginx access logs.

The Settings integration renders sanitized connection and repository-grant
state. It never returns a provider token, client secret, vault key, connection
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

If a refresh may have issued a successor that Moira could neither retain nor
revoke, Settings requires revocation of the entire GitHub App grant followed by
explicit external-revocation confirmation. Restoring the matching vault key and
version makes the credential readable again and restores ordinary reconnect or
disconnect. Pending revocation remains durable and retryable until GitHub
accepts it.

## Persistence and audit

Migrations `0025_workspace_connections.sql`, `0026_workspace_resources.sql`,
`0027_persistent_workspace_operations.sql` and `0028_workspace_transfers.sql` own
the connection, resource, lifecycle-capability, policy-usage, provider-mutation,
provider-control, operation and private-transfer metadata tables. Credential tables
contain versioned ciphertext; resource, operation and transfer tables contain
authority and accounting metadata but no command, path, query, patch, file content,
native source URL, result stream, provider token or SSH material.

Audit actions cover connection start/completion/refresh failure/disconnect;
resource create/pending/rejection/cleanup/start/stop/delete; typed exec/file
operation reservation/reconciliation/terminal outcomes; and administrator control
updates. Metadata is limited to opaque
resource relationships, provider, state/outcome, selected machine facts, byte
counts, exit code and, for a creation rejected by the connector probe, a bounded
`reason` naming the connector's own failure (never remote output or a credential).
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
exit and ends with `workspace-connector-isolation-ok`.

`tests/COVERAGE-MAP.md` maps the focused connection, resource, operation,
migration, connector, egress, packaged-isolation, MCP tool, website management,
readiness/metrics and kill-switch suites, including the ChatGPT-compatible client
scenario over real services, the HTTP contracts against the local container
(`npm run test:mcp-tools`, `npm run test:api`) and the Settings browser scenarios
(`npm run test:e2e`). Live GitHub App user
credentials, an actual personal Codespace and ChatGPT are separate external
compatibility gates; deterministic tests do not establish them.
