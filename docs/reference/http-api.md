# HTTP API

The web backend serves APIs under `/api` at the site root, independently of the web application's
configured UI prefix. This reference owns HTTP admission and wire behavior. It links to
[execution](execution.md), [authentication](authentication.md) and [workspaces](workspaces.md) for
domain contracts. MCP tool input schemas and descriptions are owned by the typed tool projection;
HTTP route names are not MCP tool names.

## Admission and responses

Ordinary protected routes use a Better Auth session and current account admission. A blocked account
is refused; a pending account can inspect only its own `/api/user/me` status. Token management uses
the mode-specific verified-account gate. A bearer upload/download grant authorizes only its own
public endpoint; it is not a browser session. Private controller/broker routes have separate actor
credentials and body admission. See [sessions](authentication.md#sessions-and-client-authentication).

Most JSON responses use `{ success, data, timestamp? }`. The ordinary error boundary returns
`{ success: false, error: { code, message, details, timestamp }, timestamp }`, with request ID in
details and `X-Error-Id`, `X-Error-Code`, `X-Error-Timestamp` headers. Operational errors preserve
their public message/context; programmer errors are sanitized, with a stack only in development.
Authentication, limiters, sharing, private owner routes, binary downloads, HTML and SSE have their
own response shapes. Do not parse every error as that envelope. Status alone does not establish
whether an operation already wrote state; read the route's refusal/receipt contract.

### Rate limiting

Mounted ordinary API traffic is limited to 100 requests/minute per client address; `/api/auth/*`
uses 1,000/minute. Standard rate-limit headers and 429 apply. Limiter bodies are direct errors such
as `{ "error": "Too many API requests, please try again later" }`. Artifact wrapper/frame views
also have a per-artifact 120/minute budget. Trusted-proxy client IP resolution, configured whitelist,
test/disabled mode and the explicit load-test secret affect admission. File/owner traffic has
separate verified budgets; these numbers do not define a whole-operation deadline.

The MCP process owns its served MCP limiter; the web backend's unused exported MCP limiter is not
that contract. See [rate-limit middleware](../../packages/web-backend/src/middleware/rate-limit-middleware.ts).

Ordinary JSON and URL-encoded bodies have a 10 MiB parser limit. Stored workflow JSON has a 5 MiB
UTF-8 limit and workflow multipart upload has a 10 MiB transport cap. Artifact create/update and
token uploads have owner-specific body admission described below. Guarded execution-context editing measures the
merged serialized context against 10 MiB; this is not a universal limit on every engine write or a
promise of one uniform 413 response. Native owner streams use separate framing/parsers.

### Conditional lists

`GET /api/notes`, `/api/playbooks`, `/api/node-types` and `/api/admin/users?projection=lookup`
support weak ETags. Authorization and current service reads, including their effects, occur before
a possible 304. The tag hashes the user scope and current returned data; query differences matter
through that representation. Responses use `Cache-Control: private, no-cache` and vary on Cookie
and Authorization. A 304 has no JSON body. Notes/node-types include a timestamp in a full response;
Playbooks and the user lookup do not. This is revalidation, not permission to reuse another user's
cached data or skip current source checks.

Request `Cache-Control: no-cache` forces a full 200 representation even when
`If-None-Match` matches. This request directive is distinct from the response's revalidation
policy; use it when the caller needs a complete representation rather than a 304.

## Public discovery and health

| Request                                           | Result                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api`                                        | Backend entry-point discovery                                                                                                                                           |
| `GET /api/features`                               | Deployment mode, resolved capabilities, runtime MCP URL and sanitized email-delivery availability; readable before login                                                |
| `GET /api/health`                                 | Database/validation health, reconciliation status and cached public workspace readiness; 503 for core failure, 200 for operable degraded reconciliation/workspace state |
| `GET /api/health/config`                          | Runtime backend environment/port and supported feature description                                                                                                      |
| `GET /api/health/status`                          | Detailed runtime/validation/reconciliation status                                                                                                                       |
| `POST /api/logs/client`, `/api/logs/client/batch` | Validated client log entry or batch; no authentication required, ordinary API limiting applies                                                                          |

Features are server authorization decisions as well as UI hints. An administrator role alone does
not enable disabled deployment capabilities. Source: [server mounts](../../packages/web-backend/src/server.ts),
[health](../../packages/web-backend/src/routes/health.ts),
[features](../../packages/web-backend/src/routes/features.ts).

## Workflow definitions and sharing

| Request                                                                             | Inputs and behavior                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/workflows`                                                                | `search`, exact comma-separated `slugs`, `visibility`, `access` (`mine`, `shared` or `catalog`), `validationStatus` (`valid`, `invalid` or `unknown`), `sort`, `sortOrder`, `limit`, `offset` |
| `GET /api/workflows/:id`                                                            | UUID or caller-owned slug; returns raw authored workflow, validation and `fileInfo` including revision                                                                                        |
| `GET /api/workflows/by-slug/:slug`, `/by-reference/:handle/:slug`, `/:handle/:slug` | Explicit identifier forms with normal read authority                                                                                                                                          |
| `GET /api/workflows/:id/raw`                                                        | Formatted JSON text plus parsed workflow/file metadata                                                                                                                                        |
| `POST /api/workflows`                                                               | `{ id?, slug?, workflow, overwrite?, visibility? }`; service validation is cached and can describe an invalid saved definition                                                                |
| `PUT /api/workflows/:id`                                                            | `{ workflow, expectedRevision }`; guarded complete replacement of an owned definition                                                                                                         |
| `POST /api/workflows/:id/validate`                                                  | Optional `workflowData` for a dry run; otherwise reads the saved definition                                                                                                                   |
| `POST /api/workflows/:id/copy`                                                      | Optional `newName`; creates a caller-owned private copy with generated identity                                                                                                               |
| `PATCH /api/workflows/:id/visibility`, `/:id/slug`                                  | `{ visibility }` (`"public"` or `"private"`) or `{ slug }`, owner mutation                                                                                                                    |
| `DELETE /api/workflows/:id`                                                         | Soft delete                                                                                                                                                                                   |
| `GET /api/workflows/:id/variables`                                                  | Registry descriptors filtered by `names`, `search`, `types`, `hasDefault`, `externallyWritable`                                                                                               |
| `GET /api/workflows/:id/process`                                                    | Derived process blocks/transitions/diagnostics; null process when no progress is authored                                                                                                     |
| `GET /api/workflows/:id/statistics?version=`                                        | Typical block durations from the caller's completed runs stamped with that start version; current definition version when omitted                                                             |

List predicates and totals are applied before pagination. Default page size is 20, maximum 100;
headers expose total, page-valid count, limit and offset. `validWorkflows`/`invalidWorkflows` describe
the returned page, while `totalWorkflows` describes matching definitions. Exact slug selection
normalizes/validates at most 50 supplied values; a supplied list with no valid slugs matches nothing.
Cached validation is not a fresh full validation pass. File size is stored JSON UTF-8 bytes.

Detail node pagination applies only when both `offset` and `limit` are provided; validation uses the
full graph. Fetch the complete baseline before editing. The transport does not coerce the string
query `includeValidation=false` to the boolean false checked by this route; do not rely on it to
disable validation. A loaded definition's `fileInfo.id` is its server identity, separate from an
optional authored graph ID.

Guarded PUT validates body shape, resolves the definition, checks owner access, validates the full
graph including author-resolvable Playbooks, and only then performs the revision-guarded write.
Invalid content is refused without saving; stale writes return 409 with `currentRevision` in error
details. The response carries the saved revision, validation and re-derived process. A public or
shared definition is readable/usable under its grant; that is not permission to replace it.

Visibility/delete/copy also have `/:handle/:slug/...` forms. Sharing uses the same two identifier
forms for `invites` and `access`: POST invites accepts optional `ttlMs`; GET invites accepts
`activeOnly` (default true), limit/offset; DELETE an invite revokes it; GET access lists grantees;
DELETE `access/:userId` revokes their grant. Only the owner manages sharing. An invite is time-bound
and single-use. Public `GET /api/invites/:token` returns limited validity/name/expiry information;
`POST /api/invites/:token/accept` requires admitted authentication and returns workflow ID,
owner handle and slug for navigation. Missing is 404, expired/used is 410, existing/self access is
refused by its domain error; sharing errors have `{ success:false, error:{code,message} }`.

Token-authorized file endpoints are `POST /api/public/workflows/upload/:token` (multipart field
`workflow`) and `GET /api/public/workflows/download/:token`. Upload accepts visibility and
`forceNew`; it validates before save and marks the token used after success. `adminOverride` is
server-role checked, not accepted as authority from a form field. Public slug collisions with another
owner are refused for ordinary uploads. A successful download consumes its token before sending the
JSON file. A failed/lost response is not permission to guess a new mutation identity.

Sources: [workflow routes](../../packages/web-backend/src/routes/workflows.ts),
[sharing](../../packages/web-backend/src/routes/workflow-sharing.ts),
[token routes](../../packages/web-backend/src/routes/workflow-tokens.ts).

### Workflow content history

History requires the workflow owner's editing authority. Reading or using a current public/shared
definition does not grant historical access. These operations use an explicit identity base:

- `/api/workflows/by-id/:id` accepts a UUID only, without slug fallback;
- `/api/workflows/by-reference/:handle/:slug` resolves the named owner's workflow;
- `/api/workflows/by-slug/:slug` resolves the current user's workflow.

Append one operation suffix to that base:

| Request suffix             | Inputs and `data` result                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /history`             | `{revisions}` newest first; each summary has `revision`, `size`, `preview`, `authorId`, `createdAt` |
| `GET /revisions/:revision` | `{revision,content,size,authorId,createdAt}`; content is the complete definition as JSON text       |
| `GET /compare?from=N&to=N` | `{from,to,parts}`; diff parts contain `value` and optional `added`/`removed` flags                  |
| `POST /rollback`           | Body `{revision,expectedRevision}`; result `{workflowId,revision,historyRevision,restoredFrom}`     |

The history number is a positive safe integer. It is distinct from authored `metadata.version`
and the nonnegative optimistic write revision in a current definition's `fileInfo.revision`.
Rollback's body `revision` selects a snapshot; `expectedRevision` must be that current write token.
The returned `revision` is the new write token, `historyRevision` is the appended snapshot number,
and `restoredFrom` is the selected history number. Separate writes remain separate snapshots even
when semantic versions repeat. A definition without recorded history acquires its actual baseline
before its next content write; earlier unrecorded saves are unavailable.

`size` is logical revision-content metadata, not the physical allocation of its compressed payload.
Conversion of existing history retains its recorded sizes. Identical definitions can share stored
content while keeping separate history numbers, authors and timestamps; reads return complete,
formatted JSON.

Malformed numbers/UUIDs are 400; absent snapshots or comparison pairs are 404, while comparing equal
content succeeds with unchanged diff parts. An unreadable current workflow is 404; a readable one
without editing authority is 403. A stale rollback is 409, with
`error.details.{code,workflowId,expectedRevision,currentRevision}` where code is
`WORKFLOW_REVISION_CONFLICT`. That refusal changes neither the definition nor its history.

Rollback validates and migrates the selected graph, preserves the existing ID, owner and current
sharing, and appends a new snapshot atomically with the guarded definition write. Soft deletion
retains history; permanent deletion removes it. `POST /api/admin/workflows/:id/restore` instead
undeletes a workflow under the administrative route's authority; it does not select historical
content. Restoration does not rewind existing executions: the normal
[continuation](execution.md#running-execution-compatibility) and
[diagnosis/recovery](execution.md#diagnosis-and-recovery) contracts apply.

The ordinary definition readers retain their existing routes, including workflows whose slugs are
`history`, `compare` or `revisions`; history suffixes belong to the explicit bases above.

## Execution reads and mutations

### Execution management fields

Management readers expose raw `status` where required for compatibility plus canonical
`displayStatus`, nullable `revision`, `stopReason` and discriminated `stopCapability`. An available
stop capability carries a revision; a refused one names not-owner, in-flight, terminal or unavailable.
It is advisory: the mutation repeats the guard. Never infer success from raw completed state alone;
intentional stop is separate from genuine completion and completed-with-refusals.

| Request                                            | Inputs and result                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/executions`                              | `status`, `workflowId`, `search`, `sort` (`createdAt` or `updatedAt`), `sortOrder`, limit/offset, `mine`; default 20/max 100, no default active-only filter |
| `GET /api/executions/:id`                          | Full context, errors, current/wait node, task identity, parent/reminders and their metadata revisions, active lock and current wait notification            |
| `GET /api/executions/:id/progress?at=`             | Trace projection or metadata-only result; optional nonnegative visit cursor                                                                                 |
| `POST /api/executions/:id/answer`                  | `{ input: object, expectedRevision: integer }`; ordinary engine answer to the current wait                                                                  |
| `POST /api/executions/:id/stop`                    | Exactly `{ expectedRevision, reason }`; owner-only guarded stop                                                                                             |
| `POST /api/executions/:id/parent`                  | `{ parentExecutionId, expectedRevision, expectedParentRevision }`; parent is a UUID or `"none"`                                                             |
| `GET /api/executions/:id/reminders`                | Optional `status` (`active` or `cancelled`), `search`; returns run and reminder-set revisions                                                               |
| `POST /api/executions/:id/reminders`               | `{ text, idempotencyKey?, expectedRevision, expectedRemindersRevision }`                                                                                    |
| `PATCH /api/executions/:id/reminders/:reminderId`  | New text plus both revisions                                                                                                                                |
| `DELETE /api/executions/:id/reminders/:reminderId` | Both revisions in the JSON body; records cancellation                                                                                                       |
| `GET /api/executions/:id/variables`                | Filters `names`, `search`, `types`, `editable`, `hasValue`, `writePhase` (`current` or `other`)                                                             |
| `PUT /api/executions/:id/variables/:name`          | `{ value, expectedRevision, expectedContextRevision }`; registry/write-policy governed                                                                      |
| `PUT /api/executions/:id/context`                  | `{ variablePath, value, expectedRevision, expectedContextRevision }`; path is an array of strings/numbers, validates and writes the resulting root value    |

The ordinary list permits administrators to inspect cross-owner summaries unless `mine=true`.
Overview is owner-only even for administrators. Detail/progress/lock inspection uses designated
view/use/administer authority; working-state variable/reminder APIs and stop require owner-use.
Arbitrary `variables` or `nodeStates` replacement through the context route is refused. Schema,
write-phase and metadata guards are not bypassed by a parent link or runtime policy.

Answer requires a running, unlocked execution waiting on its current node, the expected revision,
and no non-presented agent attempt. It may supersede the agent's presentation. A rejected answer may
append diagnostics and advance revision before returning 400. Accepted response includes execution
ID, revision/status/current/wait node and projected progress. Replay, actor adjustments and
[recovery](execution.md#diagnosis-and-recovery) belong to the execution contract.

### Execution task title

`PUT /api/executions/:id/task-title` accepts `{ taskTitle, expectedRevision,
expectedTaskIdentityRevision }`. The execution revision must be a nonnegative integer and identity
revision a SHA-256 token. Only the active owner may rename. Title normalization/limits apply;
same normalized title returns `changed:false`. Actual change advances task identity/activity without
consuming step generation. Detail exposes revisions for parent, context, reminders and task identity
separately; use the token for the field being changed.

### Live execution reads

`GET /api/executions/overview` accepts `status=active|waiting-user|waiting-agent|locked|completed|stopped|all`,
`refusals`, workflow/search, `period=7d|30d|all`, `idle=1h|1d|3d|7d|30d`,
`activeFrom`/`activeTo` (epoch ms or ISO), `sort=activity|idle|created`, limit (default 50/max 100)
and offset. Choose a relative period, idle filter or explicit activity range; incompatible selections
are 400. It returns root runs, total roots, paging, `evaluatedAt` and `effectiveTime`.

Rows distinguish matching ancestors, current step, exact recorded stages, a bounded active-list
window, visible vs total children and matching-subtree vs whole-subtree idle activity. Nullable
names/timestamps mean unknown, not zero or an invented ID label. See
[overview semantics](execution.md#overview-and-live-reads). `ids` (up to 100 comma-separated IDs)
instead returns flat owner-scoped refreshed rows, with no page-membership decision.

`GET /api/executions/overview/stream` is SSE. `Last-Event-ID` takes precedence over `after`.
Events are `ready`, `change` (executionId/kind with sequence ID), `reset` and session-driven `close`;
heartbeats are comments. Headers disable buffering/cache transformation. Each open/reconnect consumes
ordinary API admission; at most five concurrent streams per user are admitted, with current session
rechecks. Clients reload membership on reset or relevant changes rather than treating an event as
complete row data.

A valid cursor also receives `reset` instead of replay when its catch-up fills the 1,000-event
bound; this branch sends no `ready`. A smaller catch-up sends the missed changes followed by
`ready`. Reload the owner-scoped overview after reset. This differs from polling's bounded-page
continuation below; [the stream implementation](../../packages/web-backend/src/services/execution-change-stream.ts)
owns both behaviors.

`GET /api/executions/overview/changes?after=<seq>` is the polling fallback. Without a cursor it
returns no events and the starting `lastSeq`; otherwise `{reset:false,events,lastSeq}` or
`{reset:true,lastSeq}`. Expired/ahead-of-database cursors reset. Polling may return a bounded event
page and its last returned sequence; retain that cursor to collect the rest.

### Progress and delivery

Progress distinguishes `source:"trace"` from `source:"metadata"`. Trace contains authored/current
and start versions, execution revision, routeRecorded/cursor, actual block status/iterations/visits,
content, nullable measured timing, bound-list facts, variable history, diagnostics and wait actor.
No recorded route means no inferred completed prefix. Current agent questions are not historical
cursor facts. `statistics` is version-scoped typical timing, not proof of this run's completion.

`POST /api/executions/:id/progress-image-token` accepts optional `theme=light|dark`,
`viewportWidth` (integer 480–4096), `view=cards|process`, `hide`/`collapse` arrays of block/node IDs,
and a device UUID. Unknown block IDs are refused. Mint requires owner-use, authored progress and a
selected file owner; it returns a five-minute PNG URL with normalized options and version/revision
bindings. The public `GET /api/public/execution-progress-image/:token` consumes the grant only on a
successful response finish; failed/closed responses release its reservation. The owner publication
is a separate immutable original operation.

`GET /api/public/executions/materialize/:token` returns an authorized current-node tar stream.
Invalid/expired/lost authority is 401; unconfirmed original publication is 409 with request ID;
owner source refusal is 422; invalid archive preparation is 400. Reuse the grant to collect the
original publication rather than submit another action. The archive is not the bounded context
fallback; [materialize](../../packages/mcp-server/src/help/content/reference/materialize.md) owns
authoring/delivery rules and [workspaces](workspaces.md#recovery-and-collection) owns owner receipts.

Lock routes: `POST /:id/lock` accepts a nonempty reason on an owner's running unlocked run and returns
creation PIN once; `GET /:id/locks` never returns PIN; `POST /:id/locks/:lockId/validate-pin` accepts
`{pin}` and verifies lock/execution binding; `POST /:id/locks/:lockId/unlock` is the explicit owner
unlock without PIN. Their prefix is `/api/executions`. Administrator unlock is a separate route.

Source: [execution routes](../../packages/web-backend/src/routes/executions.ts),
[stream](../../packages/web-backend/src/services/execution-change-stream.ts).

## Settings, Notes, Playbooks and artifacts

| Surface                                                                             | Contract                                                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/settings`, `GET /api/settings/:category`                                  | Browser-safe values; admin-only keys excluded; stored secrets masked, secret defaults not revealed                      |
| `GET /api/settings/definitions?category=`                                           | User-visible merged definitions; installed extension declarations win over DB definitions                               |
| `PUT /api/settings`                                                                 | Object of key/value updates; always `{saved,refused}`; 207 if any key refused, 200 otherwise                            |
| `PUT /api/settings/:key`                                                            | `{value}` required; per-key role/type/schema checks, extension storage routing                                          |
| `DELETE /api/settings/:key`                                                         | Remove the user value and resolve its definition default                                                                |
| `GET /api/notifications/channels`                                                   | Safe channel metadata, enabled/configured/available state, capabilities and extension trust eligibility; no credentials |
| `POST /api/notifications/channels/:channelId/test`                                  | No request fields; predefined test through that user's channel, sanitized aggregate result                              |
| `GET /api/notes`                                                                    | `tag`, `keySearch`, limit/offset; current page, distinct total and allTags                                              |
| `GET /api/notes/stats`, `GET /api/notes/:key?version=`                              | Current quota usage or one owned note/version                                                                           |
| `GET /api/notes/:key/history`                                                       | Newest retained revisions with bounded previews                                                                         |
| `POST /api/notes`, `PUT /api/notes/:key`                                            | Create `{key,value,tags?}` or replace `{value,tags?}`; creation refuses an existing key, replacement requires one       |
| `DELETE /api/notes/:key`, `POST /api/notes/:key/restore`                            | Soft delete and restore                                                                                                 |
| `/api/playbooks/:name`                                                              | GET optional owner/revision; PUT `{content,title?,description?}`; DELETE removes owned playbook/history                 |
| Playbook `history`, `compare?from=&to=`, `restore`, `visibility`, `usage` subroutes | Shared revisions, POST restore with revision, PUT visibility; current own running-use count with completeness flag      |
| `GET /api/artifacts`, `/stats`, `/:uuid`                                            | Own metadata/usage; list default 50/max 100; public URL attached                                                        |
| `POST /api/artifacts`, `PUT /api/artifacts/:uuid`, `DELETE /api/artifacts/:uuid`    | Create `{name,content,executionId?}`, replace `{content,name?}`, soft delete                                            |
| `POST /api/public/artifacts/upload/:token`                                          | Multipart `file` or JSON `{name,content,executionId?}`; returns 201 UUID/URL/size/expiry                                |

Settings bulk updates are per-key, not atomic across the request; a refused key does not cancel
allowed keys. Nonempty saved Telegram token triggers best-effort webhook registration; registration
failure does not undo the setting. A refused token causes no webhook registration. Installed
declarations cannot be changed/deleted as DB definitions. Structural settings parse JSON text and
apply their declared schema; numeric built-ins enforce bounds at storage. Presence is decided before
conversion: stored empty values and JSON null are not missing. Built-in empty defaults may be absent;
installed declarations have their own explicit-default semantics. Public built-in MCP secret values
use the encrypted sentinel; browser and extension secret projections use their masks.

Note `value` is string content and must be present; an empty string is distinct from a missing note
or missing/pruned version.
Current-page previews and revision metadata do not transfer every stored content body. Service
quotas and key/tag validation apply; Notes operations write their audit actions. Playbook read denial
is indistinguishable from missing; only the owner writes/publishes it. Usage counts all current
owned running executions of each inspected referencing definition; `complete:false` means the
bounded definition inspection is a lower bound, not zero or the complete installation inventory.

Artifact size is decoded HTML UTF-8 bytes. `GET /api/artifacts/stats` includes the effective
`maxFileSizeBytes` alongside storage/count limits and usage. Per-user file-size overrides precede
`artifacts.max_file_size_mb`, then the 5 MiB default; storage/count overrides follow their own
global/default policies. Null overrides mean inherit; zero remains an explicit storage/count quota,
but is not a valid file size. Each returned `expiresAt` defines that artifact's expiration.

Session create/update authenticates before reading the body and rechecks current access afterwards.
Public token upload validates the token before reading, then revalidates it before creation.
For an effective file limit of `N` bytes, JSON admission is bounded by `6 × N + 65,536` bytes to
allow escaping and metadata; the service still checks the actual decoded content limit. Multipart
accepts one `file`, at most two text fields of 16 KiB each, three parts and field names up to 100 bytes.
The bundled multipart parser has a native 16 KiB header-block limit per part. Metadata fields
include optional `executionId`; the filename supplies the name. Over-budget content frames/files
return 413; malformed JSON, malformed multipart headers or invalid multipart metadata return 400.
Invalid tokens return 401 before content validation. See [operator framing](../operator/configuration.md#artifact-quotas-and-body-admission)
for the MCP and supplied ingress boundaries.

Basic HTML validation is not sanitization. Upload token is marked used after creation;
do not treat that sequential contract as an atomic exactly-once guarantee under concurrent uploads.
Public serving excludes expired/deleted/taken-down content. See [artifact security](../development/security.md).

Administrator `GET /api/admin/users/:id/artifact-quota` returns `overrides.{quotaMb,maxFiles,maxFileSizeMb}`,
`effective.{storageLimit,countLimit,maxFileSizeBytes}` and usage. PUT accepts these override fields
optionally: omission preserves a stored override and `null` resets it to inheritance. A non-null
`maxFileSizeMb` must be positive, represent a whole safe byte count and admit a safe JSON frame;
fractional MiB values are allowed when those conditions hold. PUT returns accepted override values,
effective `maxFileSizeBytes` and `updated:true`; changes are audited. The ordinary administrator
and deployment-capability guards apply.

Sources: [settings](../../packages/web-backend/src/routes/settings.ts),
[Notes](../../packages/web-backend/src/routes/notes.ts),
[Playbooks](../../packages/web-backend/src/routes/playbooks.ts),
[artifacts](../../packages/web-backend/src/routes/artifacts.ts).

## Accounts, consent and tokens

`GET /api/user/me` returns admission/role/verification/reset state and is the sole session-only
pending-account surface. `/api/user/profile` supports GET and PATCH name; `/handle` supports GET
and PATCH handle with normalized uniqueness policy. Ordinary change-password verifies the current
password and revokes other sessions/OAuth access tokens. Set-password adds a first credential to a
social account, refuses an existing credential and requires a fresh session. Forced change additionally
requires the reset flag and clears it; these are different operations.

`POST /api/user/resend-verification` requires real email delivery and an unverified account, with
per-user cooldown. Unavailable delivery is a refusal, not a claim that mail was sent.
`GET /api/user/sessions` and `/oauth-consents` support search/sort/paging; their array is `data` with
total/limit/offset alongside it. Unknown device/location values are null. DELETE a listed session
refuses the current session; DELETE a consent revokes the caller's consent. Consent check/save lives
at `GET /api/oauth/consent/check?client_id=` and `POST /api/oauth/consent` with client_id/scopes.

`/api/tokens` supports POST `{name,expiresIn?}`, GET metadata and DELETE `/:id`. Issuance returns the
plaintext token once; listing never returns it or its hash. Revocation is idempotent. These tokens
currently have full MCP access, not caller-defined scopes. Admission and expiry options belong to
[token authentication](authentication.md#sessions-and-client-authentication).

## Workspace management

Browser GitHub connection routes under `/api/integrations/github` are GET status, POST refresh,
GET start/reauthorize/callback, DELETE disconnect and DELETE external-revocation with explicit
`confirmed:true`. Start/callback are browser redirects carrying Settings outcomes, not ordinary JSON
errors. An installation callback without Moira state never exchanges its returned code; existing
credentials refresh installations instead. Disconnect/revocation can remain pending; do not erase
custody or claim provider access was revoked before collection confirms it.

Under `/api/integrations/github/codespaces`, GET `/targets` and POST `/targets/refresh` reuse the
typed `workspace_targets` schema with a required provider. They return readiness, connection,
repository/controller targets, `repositories_stale` and provider errors without awaiting resource
inventory. The POST explicitly refreshes grants.

GET on the base route and POST `/refresh` reuse the typed `workspace_list` schema with required
provider and selected view. They return resource observations, unavailable identities,
`resources_stale`, `has_diagnostics` and provider errors, independently of targets. Healthy empty
discovery differs from an unavailable provider/controller. GET `/billing` is separate; missing
billing is not zero cost.
POST `/operations/:purpose` supports the typed workspace create/lifecycle/delete/observe/adopt and
operation get/find purposes. Preserve opaque references and original-operation identity. Observation
is not captured mutation authority, and collection/discovery must not silently submit a new action.
See [management and discovery](workspaces.md#management-and-discovery).

Successful Local and GitHub lifecycle collection returns the same public workspace projection as
the immediate effect response, with its captured reference generation and observation time.
When that historical snapshot cannot be projected, the response retains the original `operation`
and `state:"completed"` with `outcome:{ok:true,result:null}` and a separate safe
`observation_error:{code}`. This confirms the effect, not current workspace state or authority;
collect the original rather than repeat the effect. Current account/controller authority is
rechecked before either projection or diagnostic is disclosed. A revocation refuses the response
without deleting the private original or converting it into an unknown outcome.

### Local device enrollment and controller API

`/api/integrations/local` owns browser devices/pairings, confirmation, revocation, settings and
original-operation collection. Settings require a confirmed cookie session, matching Origin and
JSON content type; bearer substitution is refused. Authentication occurs before incremental body
reading and is repeated afterwards. Generation/revision guards and device enabled state are separate
from permission for agent repository management.

The device list isolates a device-specific authority or response-schema failure as an unavailable
owner projection with a safe diagnostic code. It does not accept that device's policy or hide
healthy peers. Current account admission is checked for the complete response; an account-wide
refusal is not converted into a device diagnostic.

`/api/local-devices` owns native enrollment/status, device heartbeat, resource registration, workspace
bootstrap and repository-bound Git identity. Private `/api/codespaces/github/credentials` and
`/resources` use their scoped actor credentials, strict schemas and sanitized refusal projections;
they bypass ordinary body/error logging. User sessions are not those credentials. The sole detailed
owner for enrollment proof, identity binding, child/parent retirement, private endpoint tables,
immutable publications and [streaming transport](workspaces.md#streaming-transport) is the workspace
reference.

## Administration

All `/api/admin` routes require admitted authentication and persisted administrator role. Additional
server capability gates are selected case-insensitively with the router's path semantics:

| Surface                                                                              | Additional capability            |
| ------------------------------------------------------------------------------------ | -------------------------------- |
| Workflows, executions, artifacts, all-session logout, user artifact/quota operations | `multiUserAdmin`                 |
| `/stats`, ordinary `/analytics/*`                                                    | `adminAnalytics`                 |
| `/analytics/operational`                                                             | `adminOperations`                |
| `/monitoring-test/*`                                                                 | `operationsDevelopment`          |
| Account approval                                                                     | Explicit `accountApproval` check |

Deployment-neutral administrator settings/status/account operations remain distinct from these broad
cross-user surfaces. A neutral admin route does not imply that every broad surface is enabled.

| Route family                                                                     | Behavior                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/settings/definitions`                                                          | GET/POST, PUT/DELETE `/:key`, GET `/export`; required definition metadata, protected deletion and installed-declaration refusal |
| `/global-settings`                                                               | GET values/grouping, PUT/DELETE `/:key`, GET `/export`; reset stores null                                                       |
| Global setting `history`, `revision/:revision`, `compare`, `restore`             | Retained shared content revisions; null revision value differs from 404; restore appends                                        |
| Global `get-scope-value`, `set-scope-value`, `preview-prompt`                    | Raw scope vs effective model→agent→default resolution; only systemPrompt/systemReminder, typed request fields in route source   |
| `/communication/trusted-channels`                                                | Read declared/approved identity; PUT `/:channelId` boolean approved; approval alone is not configured eligibility               |
| `/system-status`, `/stats`                                                       | Neutral readiness/definition/database state vs capability-gated installation-wide workflow/execution aggregates                 |
| `/users`, `/users/:id`                                                           | Filtered users or detail; lookup projection is conditional/context-free, full page has activity enrichment                      |
| User `approve`, `block`, `unblock`, `temporary-password`, `force-password-reset` | Distinct admission/security mutations and guards                                                                                |
| User `sessions`, `oauth-tokens`, `security-activity`                             | Explicit administrator read/revoke surfaces; provider token selector is the consent's client ID                                 |
| `/tokens`                                                                        | Cross-user token metadata filters `userId,status,search,sort,sortOrder,limit,offset`; DELETE `/:id` idempotent revocation       |
| `/workflows`, `/workflows/deleted`                                               | SQL-filtered current/deleted inventory, counts before paging; restore and hard-delete subroutes                                 |
| `/executions`, `/executions/:id`, `/:id/context`, `/:id/locks`, lock unlock      | Administrative inspection and explicit audited unlock without PIN                                                               |
| `/audit-log`, `/audit/actions`, `/emails`                                        | Filtered audit with total, available action values, recent email-delivery records                                               |
| `/artifacts`, `/stats`, `/reported`, `/:uuid/takedown`                           | Cross-user metadata, abuse review and takedown; user-wide takedown and per-user quota routes                                    |
| `/codespaces`                                                                    | Readiness observation only; no mutation of owned resources                                                                      |
| `/database/backup`, `/database/vacuum`                                           | SQLite backup download and explicit vacuum, audited                                                                             |
| `/monitoring-test/*`                                                             | Controlled errors/delays/logs and simulated workflow/MCP activity; simulation is not a real workflow start                      |

Global setting values are strings or null according to their service contract. An existing empty
prompt override is intentional and wins resolution; null resets to parent/default. The scope-writing
endpoint does not create a missing agent/model row for an empty value, and reports `created:false`.
Raw `exists` and raw value are separate facts. Typed tool descriptions are static code-owned data;
prompt override administration does not edit them.

### Account deletion

Complete the [pre-deletion cleanup sequence](../operator/accounts.md#account-deletion) before
the first deletion request: deletion is not a resource-discovery preflight and can already remove
ordinary owner access when it returns a pending result.

Blocking revokes access before external credential disposal. It can return 503
`SCOPED_CREDENTIAL_DISPOSAL_PENDING` while the account is already blocked. Deletion likewise fences
the account first and preserves encrypted custody if retirement is incomplete. Pending credentials
or managed resources return 409 `ACCOUNT_CREDENTIAL_RETIREMENT_PENDING` or
`ACCOUNT_RESOURCE_RETIREMENT_PENDING`, with blocked true/deleted false. Deleting an account is not
silent deletion of owned workspace disks. Self-block/delete and ordinary temporary recovery of an
administrator are refused. [Account operations](../operator/accounts.md#account-deletion) owns recovery
actions; [authentication](authentication.md#email-verification-and-recovery) owns their credential rules.

### Analytics

`/api/admin/analytics` exposes overview, executions, users, registrations, attention, top-workflows,
audit-summary, workflow-quality/:workflowId, conversion-funnel, engagement and operational reads.
Common `range` values are `15m,30m,hour,day,today,week,month,year,all`; user-series scope uses half-open
UTC `[startAt,endAt)` with one `asOf`. `today` begins at UTC midnight. Omitted exclusions remove
administrators; explicit `excludeUserIds=` excludes nobody. Limit/offset and exclusion lists are
bounded and validated; per-endpoint defaults differ.

Scope metadata, full-period scalar totals and observed chart windows are separate. Series carry
granularity/limit/totalBuckets/limited/firstDate/lastDate and may cover only the newest observed
buckets without truncating totals. Registration cohorts, execution-created cohorts, accepted
audit/session activity and current running inventories answer different questions. A sign-up alone
or blocked sign-in does not establish observed activity. Completion without refusal, completion
with refusal and intentional stop are distinct; degradation is not refusal. All-period returning-user
comparison and unmeasurable first-run delay are null, not fabricated zeroes.

Operational metrics deliberately do not inherit user exclusions. They accept action/source/resource
filters and auto/daily/hourly granularity, expose unavailable metrics as null with available=false,
and distinguish current per-second rates from historical counts. Workflow-quality reports observed
audit step/failure activity rather than proof of every actual engine path. Source:
[analytics routes](../../packages/web-backend/src/routes/admin-analytics.ts),
[query contract](../../packages/shared/src/database/admin-analytics-query.ts),
[projections](../../packages/shared/src/database/repositories/admin-analytics-repository.ts).

## Public artifact pages and Telegram callback

Artifacts are served only on their own Host-derived origin. The wrapper at `/` maps to backend
`/static`; raw content is `/__frame/:uuid` and abuse submission is POST `/__report/:uuid`. No
path-based HTML alias replaces origin isolation. Non-iframe raw-content navigation redirects to the
wrapper; first-visit acknowledgment and wrapper language use origin-scoped cookies. Wrapper and
frame have separate CSPs and the frame sandbox permits scripts without same-origin/top-navigation/
forms/popups. HTTPS images and selected external resources remain allowed: this is not complete
network isolation. Report notifications are best effort and do not determine the report result.
An unavailable artifact has a neutral 404 page; it does not reveal its private state or promise a
fixed lifetime. Use the upload/list metadata's `expiresAt` for an owned artifact's actual expiration.
See [security](../development/security.md) and
[static route](../../packages/web-backend/src/routes/static-artifacts.ts).

`POST /api/telegram/webhook` accepts callback queries with compact `a:<exec8>:<node12>` approve data.
It finds the lock owner before comparing the stored webhook secret. A mismatch returns 403; absent
stored secret currently skips verification, so unconditional origin verification is not a guarantee.
Unknown/no-longer-active callbacks are acknowledged without another unlock. The mounted ordinary
API limiter applies; there is no separate documented 10/s callback limiter. Bot callback acknowledgment
failure does not undo an approval. Source:
[Telegram webhook](../../packages/web-backend/src/routes/telegram-webhook.ts).
