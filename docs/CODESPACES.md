# Codespaces and Local Computers

This reference describes Moira's provider-neutral codespace control plane and
the GitHub Codespaces and Moira Local providers. A codespace is a persistent,
user-owned development environment addressed by an opaque codespace ID. It is
not a chat session: Moira does not receive or store a ChatGPT conversation ID,
and different authorized clients may reuse the same codespace.

A codespace is a personal instrument for executing a flow for an agent that has
no filesystem of its own. It is not shared and is not a collaboration container;
collaboration happens through version-control branches in the repository.

GitHub authorization belongs to the authenticated website. Agents do not
receive provider credentials, OAuth operations, SSH configuration or lifecycle
capabilities. Agents reach codespaces only through the authenticated MCP
`codespace` and `codespace_process` tools described below; the website owns the GitHub connection and
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
  provider contract. `github-codespaces` and `local-sandboxes` implement it.
- `packages/local/` owns the user-run companion, local policy, bounded storage,
  private SDK credentials, independently supervised runtime and outbound relay.
- `packages/shared/src/codespaces/local-device-service.ts` and
  `local-device-repository.ts` own pairing, device generations, public local grants
  and durable relay claims. The web backend's local provider adapts the common lifecycle and operations.
- `packages/web-backend/src/routes/local-devices.ts` and the Settings
  `LocalDeviceSettings` card own browser pairing confirmation, revocation and
  revision-fenced owner settings requests within a locally approved envelope.
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
  `packages/web-frontend/src/pages/settings/CodespaceManagement.tsx` own shared
  resource cards; `GitHubCodespaceManagement.tsx` owns their GitHub section. They provide
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
possession of an opaque ID does not grant access. Public projections omit provider
resource names and credentials. GitHub credentials remain in the server vault;
enrolled local private Git and write operations use that server-held OAuth
credential through a repository-scoped proxy. Local SDK credentials remain in the
computer's owned store, separate from its device credential.

## Moira Local companion

Local execution has four layers: the server control plane owns authenticated requests and
repository authorization; `LocalDaemon` owns connection confirmation and reconnect; `LocalVmRuntime`
owns exact VM lifecycle and its isolation boundary; the installed guest supervisor owns jobs,
sessions, output and version-checked file operations. The CLI delegates persistent `run` to the
daemon. The runtime factory currently selects only the supported SBX backend; no Lima backend
is implemented. Before each fixed guest attachment, that backend verifies configuration, exact
identity, mounts and network receipt once, then rechecks the current local grant and generation
after those asynchronous proofs and before dispatch.

Moira Local uses outbound authenticated HTTPS to a locally selected Moira application URL.
Server codespace work requires `CODESPACE_CODESPACES_ENABLED=true` and enabled instance controls;
GitHub App credentials and the GitHub connector are not required for public read-only local work.
Private Git, push and pull-request creation use the connected GitHub App user authorization.
Agent work cannot choose host commands, VM templates, updates or broader local grants.
Owner web settings require a separate explicit local approval and remain within its ceilings.
Each codespace has its own persistent mountless microVM. One repository may have multiple codespaces,
each with a separate VM and lifecycle. The computer's bounded backing image holds the local SDK
storage; its configured capacity is shared across these codespaces, not assigned to each one.
Local VMs and operations do not consume GitHub
Codespaces count or concurrency slots and are not subject to its machine ceiling or creation throttle.
CPU, RAM and disk allocations remain owner-controlled. Backend, frontend
and browser jobs in one codespace share that VM. The companion requires Node.js 24,
macOS on Apple silicon and Docker Sandboxes `sbx` 0.46.0. Linux execution is refused because
the required runtime ownership contract is not supported there; a container or host-shell fallback
is not used. Install the pinned SDK from the [official Docker release artifacts](https://github.com/docker/sandboxes/releases/tag/v0.46.0)
and retain its signed application bundle; see [Docker installation requirements](https://docs.docker.com/ai/sandboxes/install/).

Build from the repository root with the macOS command-line C compiler available;
`@mcp-moira/local` is private, not a published global npm package:

```bash
npm ci
npm run local:build
npm run local -- --help
npm run local -- init --sbx /absolute/path/to/Sbx.app/Contents/MacOS/sbx --label My-computer
npm run local -- login
npm run local -- setup
npm run local -- approve OWNER/REPO
npm run local -- enable --hours 8
npm run local -- doctor
```

`init` creates private state under `~/.moira-local` unless `--state PATH` is supplied, and starts
disabled. Use the same `--state` on every command when overriding it. The default bounded disk
image is stored in that state and mounted at a short device-owned `/private/tmp/ml-…` path, so
SDK Unix sockets fit the native path bound. `--storage-gib`, `--cpus` and `--memory-gib`
set local resource defaults at initialization. `--storage-root` accepts an existing empty,
private, separately mounted bounded filesystem, not an ordinary directory. Preserve the image and
ownership records; a missing mount is a refusal, not permission to create unbounded storage.

`setup` initializes only an empty dedicated SDK profile. `doctor` checks storage, supported SDK,
settings, global network policy and owned inventory under an enabled, unexpired lease. Its
`liveVmIsolationVerified: false` result is explicit: it does not execute a microVM isolation test.
The SDK profile has its own HOME, namespace and encrypted credential store; it does not select
the user's personal Docker profile or change personal Keychain default/search metadata.
The bundled native helper prepares and unlocks only the owned store without interactive password
prompts. `login --new-store` is an explicit recovery operation: it requires disabled work,
the runner lock and confirmed shutdown, creates a separate store, and preserves existing stores.
An unreadable store never causes automatic rotation or personal credential adoption.
The machine-only store uses an owner-readable generated password file and disables sleep/interval
auto-lock only for that owned SDK store. It trusts the host user account; it is not protection
against another process already acting as that same user. Personal Keychain lock policy is unchanged.

`approve OWNER/REPO` grants repository read access;
`--private`, `--push`, `--delete` and `--pull-requests` grant those capabilities explicitly.
An enrolled private/write repository uses the server's GitHub connection and
repository grant; the guest receives no OAuth token. Public read-only Git is direct
and needs no App grant. Relay jobs cannot expand local authority.
`enable --hours N` grants at most 168 hours (8 by default), not indefinite permission.

Open **Settings → Development → Local computers** (`/settings#integrations-local`, under the app's
configured prefix), choose **Connect a device**, and copy the enrollment command and token
separately. From this checkout, use `npm run local -- enroll` with the displayed `--server` and
`--pairing-id` arguments. Enter the token on stdin and end input; do not append it to the command
or put it in shell history. The trusted server URL must be HTTPS, without credentials, query or
fragment. Refresh the browser, review the pending computer's repositories, push/delete
rights, machine ceilings and lease, then confirm. Only then run:

```bash
npm run local -- run
```

Keep that foreground process running to serve the account; Ctrl+C settles owned work. Reconnection
uses durable request IDs, digests and claims, so a lost response does not authorize redispatch.
Transient network failures, including failed response reads, and server 5xx responses pause relay
contact without stopping already admitted work. An addressed resource refusal returns that request's
bounded error. A refused delivery claim aborts only its request scope; it does not close VM ownership
or advance its generation. Background delivery confirms the same current device/account/connection
and generation before continuing independent claims. Successful confirmation does not fault the
daemon or impose a global retry delay for that refusal. Malformed control-plane protocol sets
`faulted` and retries confirmation after 30 seconds; transport failures set `offline`. Those
connection failures suspend new claims until successful confirmation.
Only device-endpoint unauthorized responses or confirmed device identity/revocation failures
invalidate device authority and make the daemon stop work. Local disable, lease expiry and explicit
shutdown retain their independent stop boundaries. Existing work remains bounded by its current
local grant and finite lease without extension. Reconnection may return retained receipts, but
their effects are not redispatched.
The browser can revoke a specific device; revocation invalidates its generation and denies new
work. Local `disable` independently stops owned SDK/VM processes and preserves data, including when
credentials cannot be read. Neither closing an MCP client nor losing the relay deletes a codespace.

Broker shutdown fences new admission and waits for owned HTTP/CONNECT tasks, accepted socket
closure and connection-capacity reservation/release. A CONNECT reservation finishing after
shutdown is released without destination lookup or connection, so closed service ownership does
not leave an upstream connection running after shutdown.

Local diagnostics use `status`, `create OWNER/REPO --ref REF`, `start SPACE_ID`, `stop SPACE_ID`
and `exec SPACE_ID -- COMMAND ARG…`. Stop retains files; `remove SPACE_ID --confirm` deletes the
owned VM through that explicit local confirmation. Manager-backed CLI commands are one-shot:
their final cleanup stops owned VM processes on exit. Persistent server/MCP work uses the long-lived
paired `run`; stop it before another command needs the same runner lock. Browser revocation denies
new server work, but physical shutdown of an offline computer cannot be asserted by the browser;
local disable and the independent lease guard remain authoritative. An unknown guest outcome remains
fenced until physical stop is confirmed. `recover SPACE_ID --confirm` acknowledges either that
outcome or a clean, initialized stopped VM whose generation no longer matches the server binding.
It verifies the exact stopped VM, current grant and network boundary, then records a new generation
receipt without retrying prior jobs. Missing identity, incomplete initialization and other failures
remain refused. Device-level `recover --confirm` requires disabled work and
acknowledges an orphan shutdown after proving owned processes stopped; it preserves jobs and data.
After abrupt companion termination, do not manually unlink `runner.lock`. Disable local work,
then use `recover --confirm`; it reclaims the marker only when its owner is proven absent and
refuses a live or unknown owner. After a confirmed ordinary stop, including idle disconnection,
restart `run` under an enabled, unexpired local lease: a verified clean stop retains a generation
receipt for the same server binding. If an older stopped record has no receipt and restart reports
`LOCAL_GENERATION_CONFLICT`, stop the companion, use `recover SPACE_ID --confirm` with the same
state directory, then restart `run`. Recovery preserves retained jobs and their unknown outcomes;
it authorizes subsequent work, not replay. Do not clear journals or adopt a VM by name to bypass recovery.

Background reconciliation can inspect, cancel, finalize or read retained output and file outcomes
from an earlier lifecycle generation of the same local VM. It uses current relay authority and
requires unchanged ownership, provider identity and authorization; a future generation is refused.
An observed file outcome releases operation capacity only while the observed resource generation,
identity, connection and repository grant still match. Disabled instance controls do not block
this settlement, but still deny new work. Recovery does not redispatch an old execute or file edit,
and ordinary caller result reads retain their exact-generation fence.

### Owner web control and bundle updates

The server, companion and every running owner guard must use a coordinated control-contract
edition, including the shared scoped snapshot and typed management-result schemas in
`packages/shared/src/codespaces/local-protocol.ts`. Strict nested heartbeat fields and the local `web-control.json` schema are not compatible
with an older reader, even when delegation is disabled. Rebuilding the CLI does not replace an
already running guard. Mixed-edition rolling upgrades and uninterrupted management during an
upgrade are not supported.

Arrange a controlled owner-managed stop before changing editions: use the companion's ordinary
shutdown/settlement path and confirm that its owned work and guards have stopped. Then update the
server and local checkout only after taking a cold backup while both sides are stopped: retain
the server database, complete private companion state and SDK backing storage, including VM disks,
with their matching bundles. Run `npm ci` and `npm run local:build`, and
restart the companion through its ordinary owner-managed path. Preserve the same `--state`, disk
image, SDK profile, credential store and connection; do not initialize replacement state, erase
journals or terminate guards by arbitrary PID. A stopped VM retains its data, but active processes
can be interrupted and management may be unavailable during this coordinated update. This update
prerequisite is distinct from live repository append inside a coordinated running edition, which
preserves existing VMs and grants. A device without the control capability must use the rebuilt
companion before the website can apply owner settings.

The strict persisted control schemas require an offline format conversion when their fields change.
Back up the server database and the computer's complete private state and disk before conversion,
and keep the matching server and companion bundles for rollback. After confirmed shutdown, remove
only the unsupported quota and network-profile fields: repository `domains`; delegation
`maxRepositories` and `networkProfile`; `maxSandboxes`, `maxOperationMs`, `maxOutputBytes`,
`maxConcurrent`, `maxNetworkBytes` and `maxNetworkConnections` from saved settings and ceilings;
and the local policy's `limits` object. Apply the same conversion to nested settings, applied
delegation and retained control-intent policy copies, and to a retained repository-creation
request's serialized delegation. Recompute the server public-policy digest from its canonical JSON.
Validate the converted values against the matching strict schemas before restarting either side.
Preserve repository grants and receipts, account/device/VM IDs, generations, request fingerprints,
recovery markers, jobs, SDK credentials and disks. The new bundles do not automatically read an
unsupported saved shape. Rollback restores the corresponding database, local state and matching
bundles and SDK backing storage together; resetting the SDK, deleting journals or enrolling a replacement computer is not
the conversion procedure.

After pairing confirmation, grant web control once on the local machine:

```bash
npm run local -- web-control --confirm --max-lease-hours 168
npm run local -- run
```

Use the same `--state` argument when configured. Omitted ceiling options use the
current local policy. Choose larger approved bounds during this confirmation with
`--cpus`, `--memory-gib`, `--storage-gib` and `--docker-gib`. The approval pins the server,
user, device and connection; the command refuses an existing approval and does
not replace it. Web or agent requests cannot change this envelope.

The Local computers editor controls enablement, finite lease, defaults, storage,
repository grants and permissions and optional Git author identity.
Saving creates a requested revision. Applied means the companion confirmed that
revision; pending or rejected settings are distinct from the applied device policy.
Offline contact does not imply application. The companion continues management
polling while disabled or expired without dispatching work, so web renewal can
restore work within the approved ceiling. Offline revocation still cannot promise
instant physical shutdown.

Ordinary settings changes settle owned work before changing policy. A consent-only revision or
verified delegated repository append that preserves all other settings applies live without stopping
existing VMs or changing their grants, generation, runtime, Git identity or lease. A refusal before
that append preserves the effective policy; an uncertain transition retains its durable intent.
CPU, RAM and Docker disk
defaults apply to new VMs; existing VMs restart with their admitted machine and
repository identity. The storage setting bounds the computer's SDK backing filesystem, while
Docker disk capacity belongs to each admitted VM. The default owned APFS image can grow or shrink while stopped
after native bounds and free-space checks, preserving data. Storage must be integral
GiB, at least 8 GiB and at least Docker capacity plus 1 GiB; filesystem usable
capacity includes native overhead. Unknown physical changes retain their journal
and keep work fenced. Retrying the same settings may renew a finite lease; an
unrelated request cannot erase an uncertain resize.

### Delegated repository additions

After local web-control opt-in, the owner can enable agent repository management in the
Local computers editor. It is off by default and binds the connected, verified personal GitHub
account, separate permissions for existing and new private repositories and optional push.
There is no repository-count quota or technology-specific network profile.
Saving requests a revision; only the companion's
acknowledgement makes its delegation effective. The MCP caller cannot enable that consent, change
its account, supply rights, or extend the computer's lease. New-private consent authorizes the
separate `repository_create` action; it does not authorize adding unrelated existing repositories.

`codespace({ action: "local_devices" })` returns owned device IDs, labels, contact status and
enablement, plus eligible personal GitHub App installations with `installation_id` and owner.
A warning asks for missing GitHub setup while devices remain discoverable. Applied delegation
and detailed owner permissions are inspected in Settings, not returned in this compact discovery.
`repository_add` takes that `device_id`, the existing GitHub numeric `repository_id` and a caller-chosen
UUID `request_id`. It verifies the current GitHub App installation grant, repository ID, owner,
private visibility and required read/push rights. It adds only a private repository owned by the
connected personal account. Its receipt is `pending`, `applied` or `rejected`; `local_repository_id`
is null until the exact grant is acknowledged internally. MCP waits for that acknowledgement and
returns the usable ID as `repository_id`. Reuse the same request identity and payload after an
unconfirmed outcome. An existing local grant is reused through discovery rather than added again. Requests
racing unapplied owner settings are refused.

`repository_create` takes `device_id`, a stable UUID `request_id`, `repository_name` and the personal
`installation_id` from discovery. The name is 1–100 ASCII letters, digits, underscores, dots or
hyphens, excluding `.`/`..` and a `.git` suffix. The server creates only an empty private repository
in the connected user's personal account through fixed GitHub API endpoints; callers cannot select
another owner or visibility. Current applied new-private consent, device/account identity, finite
lease are checked before the durable submit fence permits an external create.

Resume using the same complete payload. `pending`, `unknown`, `setup_required` and `rejected` are
not local authority. A confirmed `github_repository_id` and `full_name` may remain available while
installation setup is incomplete internally; MCP returns `repository_id` only after applied companion ACK.
A selected installation receives only that confirmed new repository, then the refreshed actual App
grant is checked; a successful installation PUT alone does not grant access. Missing permissions
return Settings/install guidance and preserve the confirmed result for continuation.
In the owner admission API, `error.stage` names the failed setup step when present (`github_connection`, `device_delegation`,
`authority_validation`, `repository_lookup`, `repository_create`, `installation_access` or
`local_admission`); `error.provider_status` carries the GitHub HTTP status. Compact MCP errors carry
the safe cause and `request_id` for continuation. The returned
`instruction` describes the applicable repair. A returned rejected local admission preserves
the already-created repository identity. An unchanged rejected receipt remains rejected: restore
its original grant in Settings, or use `repository_add` with the retained GitHub ID and a fresh
`request_id` if existing-private consent permits it. Do not submit another repository creation.

A lost create response is inspected rather than blindly submitted again. Recovery requires the
exact saved owner, name, private visibility and server-generated marker in the repository description;
a same-name object or an absent inspection result does not authorize adoption or another create.
The description marker is visible private-repository metadata, not a credential, and is not exported
in MCP results. Preserve it while an unknown create is unresolved. Durable creation requests
and admission receipts retain provenance without limiting the number of repositories.

The broker permits public DNS destinations independently of the chosen language, package registry
or framework. Every resolution and connected peer must pass public-address and computer-network
checks; private, host, LAN and service destinations remain denied. Network downloads have no cumulative
traffic budget or per-download byte quota. Bounded socket capacity supplies backpressure and does
not grant host forwarding. Browser binaries and system libraries are installed through ordinary
guest commands with the required guest privileges; network access does not certify browser
compatibility or execution.

### Local Git and pull requests

Connect GitHub in **Settings → Development → GitHub** and grant the selected
repository. Private push needs Contents write; pull-request creation also needs
Pull requests write and the repository's `allowPullRequests` grant. Use **Update
GitHub permissions** when the token needs newly approved permissions; Refresh only
re-reads grants. Enrolled broker failures never select a host PAT fallback.

Guest Git identity is repository-local: use owner-configured name/email or the
verified GitHub login and numeric-account noreply address. Host Git configuration
and secrets are not forwarded. An existing empty remote can open an unborn
requested branch: the agent creates files, commits and pushes the first branch,
then pushes a feature branch. A nonempty remote with an absent ref is refused.
The MCP `pull_request_create`, `pull_request_get` and `pull_request_find` actions
use the owned codespace and approved repository. Only creation requires the
pull-request permission; reads and exact head/base lookup use read authority.
After an uncertain create, find by exact head/base before retrying; there is no
atomic exactly-once guarantee across Moira and GitHub.

### Local isolation boundary

The guest root and cloud requests are untrusted. Host mounts, shared skills, MCP gateway, host environment,
credentials and agent sockets are not forwarded. Fixed SDK API operations avoid CLI lifecycle hooks
that can attach host integrations. Fresh SDK identity and container mapping are checked against
kernel-held process ownership before effects; malformed or missing mandatory observations refuse work.
Unknown dispatch settlement requires stopping the exact owned VM, not treating a closed socket as
successful guest cancellation.

Outside the VM, the dedicated profile denies direct egress, including host, LAN, VPN, metadata and
other-sandbox destinations. Only the approved broker TCP path is allowed; UDP remains globally denied.
The broker admits public DNS destinations and verifies connected addresses.
SDK network-user prompts are disabled rather than allowed to expand access.
When internal socket capacity is busy, a bounded FIFO queue applies backpressure rather than an
authorization refusal. Closed consumers and broker shutdown cancel their wait; admission refreshes
the bound authority after waiting. Revoked grants and expired leases remain refusals.
The guest loopback proxy authenticates CONNECT and absolute-HTTP requests to the host broker with
its installed per-space broker credential, so clients such as npm need not send a proxy-auth header.
A client-supplied proxy credential cannot select another space. Repository Git authorization remains
separate. The host still checks the current lease, grant, destination and public network address;
this credential is neither a GitHub token nor a forwarded host credential.
The guest may contain public SDK credential placeholders: API sentinel values and the pinned SDK's
public GitHub sentinel are not forwarded user tokens. Their presence alone neither proves forwarding
nor authorizes access. The companion supplies no AI-provider keys or host credential values.

Controlled guest-root checks observe fake host file/environment/socket access and challenge delivery
to reachable loopback and the host's assigned LAN/VPN interfaces, with positive receivers. A proxy
handshake alone is not target delivery. These observations do not prove access denial along a remote
VPN route, to a metadata service or to a second VM when no controlled reachable target exists.
Those physical checks remain unexecuted on the validation host; configuration admission, vendor
contract and negative policy tests do not turn them into physical passes. Codespace content is
intentionally visible to Moira. Review returned code before running it on the host.

## Persistent lifecycle

The GitHub provider manages only personally billed Codespaces created through
Moira for a repository approved by a GitHub App installation visible to the
connected user. That repository may belong to the user's account or an
organization. Importing an existing Codespace and organization billing are
unsupported. Installing the App on an organization requires that organization's
approval; the connected user's personal GitHub account remains the payer.

Core exposes provider-neutral create, list, get, start, stop and delete
operations. A resource records tenant and connection ownership, authorization
generation, repository, the ref requested at creation, the ref the provider last
reported checked out, exact provider identity, selected machine, desired and
observed state, retention policy and lifecycle generation.

For GitHub Codespaces, the provider repository ID is the repository identity. Its
full name is display metadata: lifecycle reconciliation accepts a provider-side
rename, refreshes the stored name and still refuses a resource whose provider
repository ID changed. Local VMs retain the admitted repository full name as well
as its local UUID; editing a grant cannot reassign an existing VM to another repository.

The checked-out branch is working state, not identity. After creation, an exact
provider resource belongs to a record when its provider name, Moira marker, owner,
billable owner and repository ID match; the branch it is on is not compared. An
agent may therefore switch branches inside a codespace, or leave it on a detached
HEAD, and start, stop, delete, operations, re-authorization rebind and cleanup keep
addressing the same codespace. Every observation writes the provider's current ref
back to the record, or no ref when the provider reports none.

- Create reads GitHub's default Codespace attributes for the selected repository
  and ref before reserving capacity or sending a create request. If GitHub names
  an organization as `billable_owner`, Moira refuses with
  `CODESPACE_BILLING_UNSUPPORTED` and creates nothing. An inaccessible repository
  or a preflight whose payer cannot be verified is also refused before creation.
  Create then persists intent and a unique marker before provider contact. Moira
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
GitHub provider reports as failed completes as stopped with the observed state `failed`,
and a start of an available one only probes the connector. While the provider
reports the Codespace as
provisioning, starting or stopping, GitHub start/stop stays pending and issues
nothing. Local stop/delete can address the exact owned VM during preparation or an unknown
guest outcome; they drain accepted creation/work before claiming completion. Delete is issued directly, without a stop first, for persistent delete
and for legacy cleanup. When the provider refuses a mutation, the Codespace is
observed again: a record whose goal was reached anyway settles, and one the
provider is still moving stays pending instead of reporting the refusal.

The local provider reports `created` separately from provisioning. It is an actionable
observation, so a stop can address the exact existing VM without starting it. It does not
certify shutdown. A local created VM completes as stopped only when the independent native
owner has confirmed its exact SDK UUID/name, Docker Engine container and worker settlement
against the durable stop generation. A saved stopped phase without a current runtime
observation is unknown. Unknown observation preserves the last verified state/time and reports
a bounded local diagnostic; an explicit SDK error cannot itself complete a local stop.

Guest readiness is separate from physical runtime state. A physically running VM is available
only when its durable phase is `usable`, preparation has completed and no guest failure remains.
Preparing guests stay pending without adoption or a new work generation. A failed preparation,
including a retained stopped VM without completed first-use preparation, reports
`CODESPACE_LOCAL_SETUP_INCOMPLETE`. A confirmed physical stop can settle stop intent while keeping
that cause visible through both lifecycle settlement and read-only refresh. Start and guest work
remain refused; delete and confirm removal before recreating. Recovery of an initialized clean
stop never completes a failed initial preparation.

Local status inspection is scoped to the retained resource and its exact owned creation marker.
It can recover the owned durable manifest after the create reply expires, without adopting an
unrelated SDK VM. Only settled authenticated absence proves removal; failed or partial inventory
is not an empty successful list. The same current intent can inspect an owned incomplete setup at a newer
native generation without advancing its binding or authorizing guest work. Each failing resource retains its diagnostic and verified state,
while healthy peers refresh and run; the aggregate refresh reports stale data when any observation
could not be confirmed.

Resource summaries expose nullable `observed_at`, the time of a verified provider observation,
and nullable `lifecycle_error`, a known `CodespaceResourceErrorCode`. They never expose raw
provider diagnostics. Claims, retries and a later connector probe do not advance the observation
time; `updated_at` remains bookkeeping time. A refused observation retains the last verified
state and observation time until ordinary reconciliation succeeds.

Repeating an active pending lifecycle request does not advance its generation. After a confirmed
authenticated refusal, an explicit owner action can advance to a fresh guarded attempt after the
permission/runtime repair. Unknown outcomes continue inspection of the retained intent, not blind
redispatch. A
provider response lost during create, start, stop or delete is reconciled from
the exact stored identity and intent; broad discovery or deletion is not used.
The local relay retains authenticated create/start/stop/delete request and reply payloads until
their existing private-transfer expiry. A retry reads the same mutation receipt even after the
original delivery deadline, without dispatching the effect again. Snapshot and guest-operation
payloads retain their ordinary cleanup behavior.
Input and new dispatch require current resource authority. Already accepted output/ACK settlement
can complete an older exact claim after reconciliation advances the resource, without rewriting
the newer generation. Identical terminal ACK and terminal renewal are read-only receipts: they do
not extend expiry, revive dispatch or bypass current account/device/connection/repository/lease checks.
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
idle pausing. The Settings page edits them in the Automatic pause card of
**Development → GitHub Codespaces** (not in the generic settings editor), and the settings API and the
MCP `settings` tool read and write them:

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
the `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS` ceiling, which is why a higher value
is refused at startup; GitHub can still stop a codespace under a background command
that produces no terminal activity near the end of its permitted run.

Provider observation lists, in each tick, the codespaces of a bounded number of
users who have a persistent running or stopped codespace and whose last listing
is at least ten reconcile intervals old, least recently listed first, with one
listing per user. Before interpreting the result, Moira refreshes repository
grants. For each managed codespace, it records the checked-out ref and the
provider's `last_used_at`, which GitHub sets when the codespace was last started;
that timestamp is informational and plays no part in the idle decision. A list
omission or identity mismatch triggers an exact read by the stored provider name.
Only an exact 404 with current authorization and resource generation marks the
codespace deleted, cancels its active operations and releases its held capacity.
Failed reads, mismatched identities and changed grants or generations keep the
record for another observation. Unknown GitHub Codespaces are not imported.

A running codespace GitHub has shut down is recorded stopped, with its previous
operations cancelled; a stopped codespace started outside Moira is recorded
running with a new idle window. These transitions are audited as
`provider_observed_stopped` or `provider_observed_running`. A codespace observed
in a scheduled tick is judged for idleness in the next tick. Settings Refresh
and MCP `list` with `refresh: true` run the same bounded observation immediately.

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

The shared guest supervisor runs the command directly as the ordinary codespace user
inside the selected repository. It keeps its opaque marker, process-group facts
and bounded result outside the repository. The result preserves separate stdout
and stderr, terminal state and exit code.

The GitHub adapter mounts its provider-owned operation root from
`MOIRA_CODESPACES_ROOT`, whose default is `/workspaces`. That path is a Codespaces
runtime convention used by the remote supervisor, not a public alias for the
renamed Moira domain.

A dispatched command is durable and resumable as soon as the connector accepts it.
Web HTTP callers retain a short post-dispatch observation window and can receive a running
operation. Ordinary MCP command and file calls opt into waiting for the accepted operation's
terminal result, using its existing deadline and current authority. Waiting never dispatches
another command or file mutation. An unconfirmed outcome returns an error and its existing
operation ID rather than a running success. This does not extend an MCP client's transport timeout;
after interrupted delivery, inspect the accepted identity instead of submitting new work.

Background reconciliation selects the oldest attempted due operation across reservation expiry,
active work, cancellation and terminal cleanup. Each claim advances its attempt timestamp, so a
failed cleanup cannot repeatedly take precedence over other due work.

Before connector contact, SQLite reserves the authenticated tenant, codespace
and authorization generations, input bytes,
independent stdout/stderr bounds and deadline. SQLite stores only
operation metadata. It does not store argv, cwd, stdin, stdout, stderr, provider
tokens or SSH configuration. Cloud concurrency reservations count only cloud operations;
local operations use no owner-set concurrency quota and do not consume those cloud slots.

For GitHub, cancellation targets the recorded foreground process group and validates the
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

A command may also be started with `codespace_process({ action: "start", ... })`. It is the same operation, the
same single dispatch and the same resume path; only its ceiling and its deadline
differ. It is admitted against `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS` instead
of `CODESPACE_MAX_OPERATION_SECONDS`, its deadline is that lifetime so background
reconciliation observes it rather than cancelling it, and the dispatching call
returns as soon as the remote runner is proven alive, without the settle window a
bounded command uses. A caller that names no duration receives the one its mode
implies: 300 seconds for a bounded command, the whole ceiling for a background
one. The lifetime is granted when the command starts running, so a reservation
that never dispatches is reaped within fifteen minutes whatever it asked for. Its output is readable by range while it runs, and it is
stopped with `codespace_process({ action: "stop", codespace_id, process_id })`. A pending stop
does not certify cancellation. A command that outlives the
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
stream and 15 minutes for a bounded command; a background command is bounded by
GitHub's 240-minute idle stop, since it cannot outlive its codespace. A remote job request is bounded separately and never waits for a
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

Running commands or reads in the same codespace do not by themselves block write, upload or patch
admission. Those file mutations remain serialized against one another for their staged commits.
Cloud operations share per-user and instance concurrency ceilings; local operations do not
consume those slots. File existence,
size and digest preconditions are checked in the guest; another writer changing the expected
version causes refusal rather than an overwrite. Patch staging and atomic journal recovery remain
the mutation boundary.

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
before source I/O, independently for native file transfers and internal local-relay payloads.
Native purposes `codespace_input` and `codespace_download` retain their configured object ceilings;
companion purposes `local_relay_input` and `local_relay_output` do not consume those slots. Each
relay object ceiling is `(maxConcurrentOperations + maxActiveResources) × 2 directions × 32 parts`,
using the corresponding per-user or instance capacities. Existing
byte, in-flight-byte, single-file and expiry bounds apply to each class. Public transfer usage
reports native files only; internal relay objects have no public download capability.
For outbound download, the declared `maxBytes` capacity is reserved
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

The authenticated MCP catalog exposes ordinary development through `codespace`, whose required
`action` selects the operation: `list`, `repositories`, `setup_help`, `create`, `get`,
`start`, `stop`, `delete`, `exec`, `stat`, `search`, `read`, `write`, `apply_patch`,
`upload`, `download`, `local_devices`, `repository_add`, `repository_create`, `preview_image`, `pull_request_create`, `pull_request_get` and
`pull_request_find`. The public tools reference renders its schema from the typed
registry. `codespace_process` separately exposes background `start`, `get`, `read` and `stop`.
Changing the catalog changes `MCP_TOOLS_REVISION`, so a client holding an older catalog
receives the ordinary HTTP 426 reconnect contract.

Every action derives the user from the MCP request context. Lifecycle, execution, file and PR
actions address a persistent resource by `codespace_id`; local discovery and repository admission
use the owned device and applied delegation. The tool accepts no user, chat, OAuth, provider token,
SSH or internal capability field. Execution sessions are guest working contexts, not authorization
identities. The published schema is one flat root object carrying
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
declarations differ only in description, is published once. `list` returns compact owned
codespaces (`codespace_id`, repository, ref and state); `repositories` returns approved targets
with `repository_id`, name and visibility. Neither includes an operation journal, connection,
billing or limits envelope. `setup_help` owns actionable setup guidance.

The website management list's `limits` combines `CodespaceObservabilityService.limits()` from policy
and the database with an optional personal GitHub monthly billing read. Every non-null limit in it is a value Moira
enforces, taken from the one definition every enforcement site reads
(`effectiveCodespaceLimits` in
`resource-policy.ts`), beside the user's current use:

| Group             | Fields                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codespaces`      | `held` (codespaces the user holds, stopped ones and ones being created, identified or cleaned up included), `max_per_user`, `instance_held`, `max_instance`, `create_throttle_seconds`                                                                                                                                         |
| `machine_ceiling` | `cpu_cores`, `memory_bytes`, `storage_bytes`                                                                                                                                                                                                                                                                                   |
| `operations`      | `active` (the user's unfinished operations), `max_concurrent_per_user`, `max_input_bytes`, `max_stdout_bytes`, `max_stderr_bytes`, `max_retained_output_bytes`, `max_duration_seconds`, `max_background_seconds`                                                                                                               |
| `transfers`       | `used_bytes`, `objects`, `inflight_bytes` (bytes still reserved or claimed), `max_bytes_per_user`, `max_inflight_bytes_per_user`, `max_objects_per_user`, `max_file_bytes`, `ttl_seconds`                                                                                                                                      |
| `lifecycle`       | `retention_days`, `start_wait_seconds`, `idle` { `auto_stop_enabled`, `timeout_minutes` (the owner's settings), `provider_max_minutes` (GitHub's maximum idle timeout) }                                                                                                                                                       |
| `provider`        | `billing` is either `"unavailable"` or the connected personal account's current UTC-month Codespaces usage: payer, period, retrieval time, Free/Pro plan when known, compute core-hours, storage GB-month including prebuilds, included allowances when known, and net USD amounts. This is GitHub's usage, not a Moira limit. |

The `transfers` group counts native file transfers only, excluding internal companion relay
messages. Its published ceilings remain the native file policy, not the relay control budget.
For the local provider, codespace count ceilings, creation throttle, operation concurrency
ceiling and `machine_ceiling` are `null`: no cloud quota is imposed there. Counts report
the selected provider's resources and operations. Transport, native-transfer, output and
operation deadline bounds remain explicit; CPU/RAM/disk settings belong to the computer owner.

`instance_held` is the only instance-wide figure; no other user's codespaces or
identifiers appear. Billing requires the GitHub App user permission `Plan: read`.
If permission is absent, the API format is unsupported, or GitHub fails, billing
is `"unavailable"` while local limits and management remain usable. Successful
billing reads are cached briefly; an explicit refresh asks GitHub again.

For GitHub, every grant-dependent discovery or creation action — `list`, `repositories`, `setup_help` and
`create` — refreshes the stored installation and repository snapshot after a
bounded TTL before using it. `list` also accepts `refresh: true` to force that
attempt and reconcile managed Codespaces with GitHub. A provider failure returns
the previous snapshot with a warning from compact discovery and `repositories_stale: true` from
`setup_help`. Website lists retain separate repository/resource stale flags. A successful grant refresh updates
personal and organization installation selections and repositories without
reconnecting.

Snapshot replacement is one database transaction guarded by the credential generation
and the monotonic `grantsVersion`, so a slower process cannot overwrite a newer snapshot.
Deleted and rejected codespaces are finished and accept no operation, so they are
absent from that listing and from the website's, which reads the same service method.
The `get` action returns one owned summary; an unknown or foreign ID returns the
generic `CODESPACE_NOT_FOUND` result. Website summaries report `requested_ref`, the ref the
codespace was created on, and `current_ref`, the ref the provider last reported
checked out, which is `null` until Moira has observed one and while the codespace is
on a detached HEAD; `create` still takes the input `ref`. Summaries omit connection and authorization
generations, external owner/billing IDs, operation markers, provider resource names,
claims and capabilities. MCP `get` uses the same compact codespace projection as `list`, with a
safe `error` when a lifecycle cause exists; its `ref` is the observed ref or the requested fallback.

MCP create/start wait for usable guest readiness, stop for confirmed non-running state while
preserving files, and delete for confirmed absence. `delete` requires `confirm_delete: true`;
the adapter reads the current owned generation and applies the domain deletion guard internally.
Website deletion still requires its displayed `expected_generation`. Successful MCP lifecycle
responses are compact codespace records; an unconfirmed result carries a bounded error and the
existing codespace ID, without authorizing another creation.

Ordinary execution and file actions wait for a terminal result and return the action's useful
output, not a metadata envelope. Exec returns stdout, stderr and exit code. Failed, cancelled
and timed-out commands and rejected file edits are tool errors (`isError: true`) retaining useful
bounded output. `operation_id` appears when retained output is truncated or exceptional recovery
needs it. Calling the same action with only `codespace_id` and that ID observes the accepted
operation without dispatching another effect. Ordinary exec accepts neither `background` nor
`cancel`; use `codespace_process` for independently managed processes.

`codespace_process` start accepts the same command/session/stdin inputs and returns `process_id`
and state after admission, without waiting for completion. Get collects state and available output;
read returns a bounded UTF-8 stream range; stop cancels that exact process. Ranges use byte offsets:
a split multibyte character or invalid UTF-8 is shown with replacement
characters, matching ordinary retained command-output reads. Repository-file reads keep their
separate strict UTF-8 and binary-download contract. The process ID addresses the
existing command operation, not a new job queue. Unknown state, retained-output expiry and
interruption remain explicit; inspect the same ID instead of starting a duplicate process.

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
`timeout_seconds`, `session`, `session_start`, `session_end`, `env`, `script`, optional per-stream output limits and exactly one optional stdin
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

`preview_image` instead returns a complete repository-relative PNG/JPEG as standard MCP
`ImageContent`, with safe image format, dimensions and byte-size metadata. Pass `codespace_id`, `path` and optional
`max_bytes` (default and maximum 4 MiB). It uses the existing download operation and its authorization
and generation checks. Resume with only `codespace_id` and `operation_id`; the owned operation must
have download kind. The ordinary call waits for complete bytes; an unconfirmed result is an error
with its accepted operation ID, never a successful pending image. Successful projection
checks complete bytes, digest, container/header framing, dimensions up to 8192 per edge and 16 million
pixels; SVG, other formats, animated PNG, truncated and over-limit containers are refused. These
checks are not full pixel decoding. Binary data appears only in the native image block, never in
JSON text or a public URL. A captured screenshot is not evidence of visual correctness until inspected.

`setup_help` diagnoses the current configuration, connection, installation, repository
approval, instance-control and capacity condition after the same bounded grant refresh.
It returns `repositories_stale` with the provider-owned instruction and the applicable
Settings, installation, repository-creation and console links; the installation link is
present when its configured URL is valid. This surface remains available when operational
services cannot start. Repository guidance offers owner-delegated `repository_create` for a new
personal private repository on a local device, or manual provider creation followed by App approval.
An existing repository must be exposed by the App before delegated local admission.

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

The Settings page's **Development** category separates **GitHub Codespaces**, **GitHub**
and **Local computers**. The `#integrations-github` and `#integrations-local` links
select their corresponding subsections. GitHub Codespaces holds cloud codespace
management, Automatic pause and Your limits. Local computers lists each connected computer
with its own codespaces, creation form and collapsed owner settings. The common management
component filters local repositories and codespaces by the stable computer UUID, not its label:
computers with the same name and multiple VMs of one repository remain separate. The shared
backing disk capacity is shown for the computer; CPU and RAM describe each VM. Local
provider admission uses the selected device's current grants and lease. Public
read-only local work needs no GitHub OAuth connection; enrolled private checkout
and writes additionally require the connected GitHub account's App repository
grant through the fixed broker described in **Local Git and pull requests**.
One shared data source loads the connection
view and the codespace view (with repositories and `limits`) together, and any change
one card makes reloads what it can affect, so disconnecting never leaves codespaces of
a connection that no longer exists on screen. The section heading offers a help
popover and a **Setup guide** tour, and the connection card shows a stepper (connect
GitHub, install the Moira App, grant repositories) marking each step
done, current, not started or unavailable on this instance.

The GitHub Codespaces card shows the cloud provider's readiness;
it discloses that an authorized agent has the Codespace user's repository, network and configured-secret
access, and lets the user create a codespace for an approved personal or organization repository
and ref when GitHub bills the connected personal account. Each computer's codespace card describes
the computer-owned VM and approved rights. For GitHub, the create hint
states how many codespaces the user holds against the per-user ceiling and that
stopped codespaces count; local creation has no count ceiling. It lists the user's codespaces with repository, current
branch (the requested ref until a current one is observed), provider and machine
context and a plain-language state badge; a collapsed **Technical details** block
carries the requested and current ref, desired/observed state and generation, the
bookkeeping update and the codespace ID. Local cards separately show verified observation time
or that no verified observation exists. Safe lifecycle diagnostic codes have localized
explanations. Start and Stop are available for stopped and
running codespaces; Delete requires a confirmation that names the repository and
points to Stop for keeping data. Local Delete remains available with confirmation in
pending, cleanup, ambiguous and rejected states; an already-confirmed never-created refusal can
retire its card without a runtime effect. Start is withheld for incomplete guest preparation.
Local cards offer **Check state again**. For an existing
start/stop/delete intent with applied access, it retries that exact resource's existing endpoint;
delete uses the displayed current generation. A pending create or unavailable access instead
requests read-only refresh and never creates another VM. Action errors and loaders belong to
the affected codespace. Refreshing a computer section silently updates the shared data source
without making another computer's card busy. Entering Local computers and acknowledged policy
changes refresh its management data. The card keeps a saved repository list visible
with a stale warning when provider enumeration fails. Its Refresh button forces
grant and managed-resource observation. If GitHub cannot confirm current resource
state, the card shows a stale warning and retains the saved entries. It never
mentions chats or sessions.

The Automatic pause card edits the two idle settings (a switch and a choice of
timeouts within 5–240 minutes; a value set through the API or the MCP tool stays
selectable) and saves each change through the settings API. Its note and help say
that only agent activity through Moira counts, that direct use in a browser, an
editor or over SSH is not seen, and that GitHub itself stops a codespace after 240
minutes. A separate GitHub monthly usage card shows compute core-hours, storage
GB-month including prebuilds, included Free/Pro allowances when known, net billable
USD, the personal payer and retrieval time; it says unavailable when GitHub cannot
provide a trustworthy summary. The Your limits card shows GitHub's `limits`:
codespaces held, commands running and file-transfer bytes, plus the applicable finite ceilings.
The local API limits projection has no cloud count/concurrency ceiling; local VM resources
belong to the computer owner, and native-transfer and protocol bounds still apply.

The routes retain `/api/integrations/github/codespaces` behind
`requireAuth` and are a second presentation of the same services the MCP tools use,
with identical tenant, generation and confirmation authority. The list combines repositories
and codespaces from both providers and includes `providers` with their separate connection,
readiness and limits. A local `repository_id` is the qualified target returned by discovery;
callers do not manufacture it. Creation routes by that target, and later actions route by the
resource's persisted provider/device identity:

| Method   | Path                  | Behavior                                                                                                                                                                                                |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/`                   | Refreshes grants behind the TTL, then returns readiness, connection, approved repositories, `repositories_stale`, `resources_stale: false`, summaries still in use and `limits`                         |
| `POST`   | `/refresh`            | Forces grant refresh, managed-resource observation and billing read; returns the list with separate repository and resource stale flags                                                                 |
| `POST`   | `/`                   | Selects the provider from `repository_id`, verifies its grants and policy, then creates for `ref`; GitHub also verifies the personal billable owner; returns the sanitized (possibly pending) codespace |
| `GET`    | `/:codespaceId`       | One owned codespace plus its recent metadata-only operations                                                                                                                                            |
| `POST`   | `/:codespaceId/start` | Records desired running state; `data_preserved: true`                                                                                                                                                   |
| `POST`   | `/:codespaceId/stop`  | Records desired stopped state; `data_preserved: true`                                                                                                                                                   |
| `DELETE` | `/:codespaceId`       | Requires `confirm_delete: true` and the current `expected_generation`; `data_preserved: false`                                                                                                          |

Domain failures map to bounded codes: not found and malformed IDs return the generic
404, generation conflicts and not-running states 409, unsupported organization
billing 422, quota and busy 429, provider disabled or unavailable 503, and a
missing feature configuration 503 with the
same-origin Settings link. Responses never carry provider resource names, markers,
claims, capabilities or credentials.

Local lifecycle errors share the bounded guidance in
`packages/shared/src/codespaces/local-failure-guidance.ts`: `CODESPACE_LOCAL_CREATION_UNKNOWN`
(409) asks for exact inspection without replacement; `CODESPACE_LOCAL_SETUP_INCOMPLETE` (409)
asks for confirmed cleanup before recreation; `CODESPACE_LOCAL_PROTOCOL_ERROR` (409) asks for
matching bundles and saved-state checks; `CODESPACE_LOCAL_RUNTIME_ERROR` (503) asks for runtime
repair and exact inspection; `CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED` (403) asks for applied
repository delete permission before confirming the same deletion. Public troubleshooting owns
the [owner recovery steps](../packages/mcp-server/src/help/content/integration/troubleshooting.md#local-codespaces).

## Readiness, metrics and controls

Each provider's `CodespaceObservabilityService.readiness()` is its instance-level readiness
decision. Local services have no GitHub configuration requirement; device connection, current
locally approved repositories, online contact and finite lease are checked independently before work.
For GitHub, its states are `disabled` (configuration absent or
`CODESPACE_CODESPACES_ENABLED` false), `misconfigured` (invalid GitHub App or vault
configuration), `control_disabled` (a kill switch is on), `connector_unavailable`
(the credential connector does not answer its health probe) and `ready`. The view
also carries the configuration state, both controls, connector state, the
reconciliation backlog (resources and operations awaiting reconciliation, including
resources held by a claim or waiting out a retry backoff, plus the age of the oldest) and active resources/operations and live transfer bytes against
their limits. Readiness counts physical native and relay bytes together against the sum of their
independent byte ceilings; the user's transfer usage remains native-only.
It contains no user, codespace or operation identifier, and the
connector is never probed while the feature is disabled.

The complete view is served to authenticated website management and
`GET /api/admin/system-status` (`systemHealth.codespaces`); compact MCP discovery omits it.
The unauthenticated liveness surfaces
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

## GitHub trust and isolation

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

## GitHub runtime configuration

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
the App on their account. After an account-permission change, the connected user must
approve the updated permission on GitHub and obtain a new App user token through
**Update GitHub permissions** in Moira Settings:

| GitHub App permission                  | Level | Used for                                                               |
| -------------------------------------- | ----- | ---------------------------------------------------------------------- |
| Repository: Codespaces                 | write | create, list, inspect and delete the user's Codespaces                 |
| Repository: Codespaces lifecycle admin | write | start and stop a Codespace                                             |
| Repository: Codespaces metadata        | read  | list the machine types available for a repository                      |
| Repository: Contents                   | write | read refs and perform approved local Git pushes                        |
| Repository: Pull requests              | write | create approved local pull requests and read their metadata            |
| Repository: Metadata                   | read  | enumerate the installation's approved repositories                     |
| Account: Plan                          | read  | read the connected personal account's monthly Codespaces billing usage |

For local private repository creation, GitHub requires **Repository creation: write** or
**Administration: write**. Adding the confirmed repository to a selected installation requires
**GitHub App installation repository access: write**. These are the official
[personal repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)
and [installation-add](https://docs.github.com/en/rest/apps/installations#add-a-repository-to-an-app-installation)
permissions. Contents write remains required for approved push. The owner must approve requested
App permissions and refresh authorization through **Update GitHub permissions**; discovery or a
source test does not establish that the live App has them. OAuth remains in the server vault.

Enable "Request user authorization (OAuth) during installation" and expiring user
authorization tokens; the callback URL is the exact same-origin Moira path below.
Adding `Account: Plan` does not by itself require reinstalling the App. The
connection card's **Refresh** re-reads repository grants, while the Development environments
card's **Refresh** also re-reads billing; both use the existing token and cannot add
a permission to it. For organization repositories, an organization owner
must install or approve the App on that organization and grant the selected
repositories; Moira's connected user account is still the only supported payer.

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
| `CODESPACE_MAX_BACKGROUND_OPERATION_HOURS`     |       4 | Background-command duration; 1 to 4, higher is refused       |
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
cannot exceed 900 seconds, background-command duration cannot exceed 4 hours (GitHub's
240-minute idle stop) and persistent retention cannot exceed 30 days.

## Website authorization API

All routes are mounted under `/api/integrations` after `requireAuth`.

| Method   | Path                          | Behavior                                                                                                                          |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/github`                     | Refreshes an expired grant snapshot and returns the sanitized connection view with `repositoriesStale`                            |
| `POST`   | `/github/refresh`             | Forces grant enumeration and returns the current view; a provider failure retains the snapshot and sets `repositoriesStale: true` |
| `GET`    | `/github/start`               | Stores one-time browser state and redirects to GitHub; a refused start redirects to Settings with `?github=<outcome>`             |
| `GET`    | `/github/reauthorize`         | For a connected account, stores one-time browser state and redirects to GitHub for updated permissions without disconnecting      |
| `GET`    | `/github/callback`            | Consumes state, verifies GitHub identity/grants and redirects; a return from App installation (no state) re-reads grants          |
| `DELETE` | `/github`                     | Stops managed work, revokes the GitHub grant and disconnects                                                                      |
| `DELETE` | `/github/external-revocation` | Clears an eligible blocked state after external grant revocation                                                                  |

The external-revocation body must be `{ "confirmed": true }`, and the user
must first revoke the GitHub App grant in GitHub. Connect and permission update
store a SHA-256 digest of one-time state bound to the Moira user, web session,
provider and authorization intent. The state expires after ten minutes, is consumed
once and returns only a bounded outcome on the
same-origin Settings URL.

Connecting takes one pass through GitHub. **Connect GitHub** starts one
authorization; when the account has no App installation yet, the callback stores the
credential and sends the browser straight to the configured installation URL. After
the user installs or updates the App, GitHub returns the browser to the callback
with `installation_id`/`setup_action` and no Moira state. Nothing in that return is
trusted and its code is never exchanged: with a readable stored credential and a
`connected` or `installation_required` connection, Moira re-reads the installations
and repositories with that credential — whatever the snapshot's age, but never inside
the throttle that follows a failed refresh, because the return carries no one-time
state and could otherwise be replayed to drive provider calls — and redirects to
Settings with
`github=connected` or `github=installation_required`; otherwise it redirects to the
absolute `/api/integrations/github/start` URL on the configured origin. The
authorization does not force GitHub's account chooser, so switching GitHub accounts
is Disconnect followed by Connect.

A start the browser cannot proceed with redirects to Settings (`303`) with a
`github` outcome the page explains in a message: `already_connected`,
`revocation_pending`, `not_configured`, `credential_unreadable`,
`grant_revocation_required`, `previous_access_not_revoked` (an earlier credential
still awaits revocation), `session_required` or `authorization_failed`. The callback
itself always redirects (`303`), never answers with JSON: with `connected`,
`installation_required` or `authorization_failed`, and when not even the connection
status can be read, to the Settings path on this site under the web app prefix with
`authorization_failed`. Callback query strings are redacted from application logs
and omitted from nginx access logs.

The Settings integration renders sanitized connection and repository-grant
state. Its **Update GitHub permissions** button is available for a connected account;
it opens `/github/reauthorize`. The callback accepts the replacement only when
GitHub returns the same account and the stored connection and credential generation
still match the state that started the request. The new credential and grants replace
the old ones atomically; the previous credential is then revoked. A failed or
abandoned update leaves the working connection in place. This path does not stop
managed Codespaces. **Disconnect** does stop them before revoking the grant.
The **Refresh** button uses the forced endpoint, while ordinary page reads
honor the ten-minute snapshot TTL, except while the connection is
`installation_required`: then every read enumerates the grants afresh, so the
Settings page, the website codespace list and the MCP `list` action show a new
installation at once. In that state the card offers **Install GitHub App** (when the
installation URL is configured) and **Check installation**, which forces a grant
refresh, instead of Reconnect; Reconnect remains for `refresh_failed` and
`disconnected`. When connected, the card also offers the App installation link
to add an organization installation. A provider enumeration failure leaves the
saved list visible with an explicit stale warning. It never returns a provider
token, client secret, vault key, connection ID or revocation ID. There is no
agent-facing authorization, callback, device
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

A connected user's permission update commits the new
credential first — the generation advances and codespaces are rebound. The same
database transaction queues the previous token in an encrypted pending-revocation
record, so at every moment the old token is either stored or queued; only after the
commit is it revoked. A revocation GitHub refuses leaves the connection connected
and the superseded credential queued; the next successful grant refresh,
authorization or disconnect retries it. When an authorization fails after it reserved
the connection — the new credential is rejected, or the commit is rolled back — while
the previous credential is still the stored one, the connection returns to its
previous state and that credential keeps working; only a first authorization is
marked failed.
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
connection's `resourcesObservedAt`, which paces provider observation. Migration
`0043_codespace_reauthorization_intent.sql`
adds an authorization-state intent and the expected connection ID and credential
generation so a returning permission update can be checked against the connection
that initiated it. The resulting connection, resource, lifecycle-capability, policy-usage,
provider-mutation, provider-control, operation and private-transfer metadata tables
use the `codespace` vocabulary. Credential tables
contain versioned ciphertext; resource, operation and transfer tables contain
authority and accounting metadata but no command, path, query, patch, file content,
native source URL, result stream, provider token or SSH material.

Migration `0057_codespace_observation.sql` adds nullable resource `observedAt`. Existing rows
remain null until a verified observation; startup and retries do not invent physical freshness.
Install matching server and companion builds: local snapshots require the derived
`nativeStopConfirmed` observation field. Follow **Owner web control and bundle updates** for the
coordinated backup, offline strict-field normalization and paired rollback; this contract does
not automatically accept an earlier companion's snapshot.

Migration `0056_repository_creation_requests.sql` adds the tenant-owned durable private-repository
request journal. It stores request fingerprint, device/account/installation authority, name,
recovery marker, submitted/unknown/created/rejected state and admission reservation independently
of VM operations. Public creation results exclude the internal journal, marker and credentials.

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
