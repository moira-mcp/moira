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
capabilities. Agents reach codespaces through the authenticated MCP
`codespace` and `codespace_process` tools and the direct workspace CLI described below; the website owns the GitHub connection and
offers the same basic codespace management (list, create, start, stop, confirmed
delete) over the same services. Administrators own the instance-wide kill switches.

## Component boundary

Shared connection/resource services own tenant authorization, grants, lifecycle, billing,
desired/observed state and reconciliation. `packages/workspace-service/` owns commands,
sessions, input, output and guarded files inside each workspace. Its terminal CLI and
remote clients reach the same private Unix HTTP service and durable local journal.

The backend workspace router authenticates scoped agent credentials and forwards raw
HTTP streams over outbound HTTPS Upgrade connections. Its rendezvous state is in memory:
there is no cloud command queue or result store. `WorkspaceAuthRepository` stores only
credential digests bound to user, resource, authorization/resource generations and measured
guest life. Fixed provider bootstrap installs the common payload without giving the guest
GitHub or device credentials.

GitHub's connector performs fixed bootstrap/readiness and provider lifecycle work.
The Local companion owns exact VM lifecycle, approved policy, storage, SDK credentials
and inline lifecycle relay; ordinary commands/files bypass that relay.
`CodespaceTransferService` separately owns private attachment publication and one-use
download links. It does not own workspace input or file recovery.

Website/MCP adapters share sanitized resource/readiness projections. MCP adapts lifecycle
services and the workspace client; the typed registry owns its public schema.
Every cloud lookup supplies the authenticated user and resource identity. An opaque ID
grants no access. GitHub credentials remain in the vault, enrolled Local private Git uses
the repository-scoped broker, and SDK credentials remain in the computer's owned store.
See [System reference](SYSTEM.md#local-codespace-composition-and-ownership) and
[API](API.md#workspace-streaming-transport).

## Moira Local companion

Local execution has four layers: the server control plane owns authenticated requests and
repository authorization; `LocalDaemon` owns connection confirmation and reconnect; `LocalVmRuntime`
owns exact VM lifecycle and its isolation boundary; the installed workspace service owns commands,
sessions, output and guarded file operations. The CLI delegates persistent `run` to the
daemon. The runtime factory currently selects only the supported SBX backend; no Lima backend
is implemented. Before each fixed guest attachment, that backend verifies configuration, exact
identity, mounts and network receipt once, then rechecks the current local grant and runtime state
after those asynchronous proofs and before dispatch.

Moira Local uses outbound authenticated HTTPS to a locally selected Moira application URL.
Local work requires enabled instance/provider controls and the computer owner's current grant
and lease. `CODESPACE_CODESPACES_ENABLED` gates GitHub only; GitHub App credentials and the
GitHub connector are not required for public read-only Local work.
Private Git, push and pull-request creation use the connected GitHub App user authorization.
Agent work cannot choose host commands, VM templates, updates or broader local grants.
Owner web settings require a separate explicit local approval and remain within its ceilings.
Each codespace has its own persistent mountless microVM. One repository may have multiple codespaces,
each with a separate VM and lifecycle. The computer's bounded backing image holds the local SDK
storage; its configured capacity is shared across these codespaces, not assigned to each one.
Local VMs do not consume GitHub
Codespaces count slots and are not subject to its machine ceiling or creation throttle.
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
ownership records. On macOS, manager startup restores an unmounted default image from the same
state directory under the runner gate. It verifies the native image/mount binding, then repeats
the volume's device ownership, capacity and free-space checks before work. A lost attach reply
is resolved from the observed binding rather than another attach. Custom storage mounts require
manual mounting; a missing image or unsafe binding remains a refusal. Startup never creates a
replacement image, resets storage or substitutes an unbounded directory.

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

New Local lifecycle relay envelopes expire at most 870000 ms after the server's issuance time, leaving
30 seconds inside the companion's strict 900000 ms future-window ceiling. Shorter requested
windows, the resource's creation deadline and the ordinary work lease still cap expiry.
Retained requests keep their original deadline, digest and payload bytes on replay.
Fresh creation supports a clock difference of up to five seconds in either direction with prompt
delivery and sufficient unexpired request, delivery-claim and work-lease authority. Delivery claims
remain limited to 30 seconds and are checked on receipt and renewal; the issuance reserve does not
grant a 30-second clock tolerance or acceptance after expiry. Malformed, expired and excessive-window
requests remain refused before durable effects. Keep the server and computer clocks synchronized.
The issuance rule uses the existing envelope and control schemas: deploying the server issuer
does not require rebuilding a compatible companion or converting saved state. It applies to new
requests, without rewriting retained or rejected identities.

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

Local diagnostics use `status`, `stop SPACE_ID`, `remove SPACE_ID --confirm` and
`recover SPACE_ID --confirm` for owned lifecycle/recovery. Manual host create/start
and raw execution are refused; use the paired server lifecycle and the guest
`moira-workspace` CLI for commands/files. Persistent paired `run` owns the VM lifetime.
Closing it settles owned processes while preserving disks and receipts.

After abrupt termination or reboot, restart `run` with the same state. The runner
gate permits stale-marker reclamation only after proving the former runner and guard
absent. Unverifiable ownership remains refused; do not unlink locks, clear journals
or adopt a VM by name. Explicit disabled-device recovery proves physical settlement
without enabling work or replaying unknown commands.

Lifecycle relay carries inline authenticated create/start/stop/delete/snapshot metadata
and retained replies. It does not carry commands, file bodies or transfer parts.
Request/claim identity fences lifecycle effects; ordinary and late acknowledgement
use the active RPC journal's serialization boundary. Archived operation requests and
receipts remain untouched and non-runnable.

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

Persisted policy/control shapes must match their installed reader. An unsupported
shape is a refusal, not permission to clear journals or adopt replacement state.
Coordinate a reviewed conversion separately while stopped, preserving grants, credentials,
VM/profile/disk identity and all unknown receipts. Rollback must retain the matching
bundle and coherent state rather than resetting the SDK.

After pairing confirmation, approve web control on the local machine:

```bash
npm run local -- web-control --confirm --max-lease-hours 168
npm run local -- run
```

Use the same `--state` argument when configured. On first approval, omitted resource
ceilings use the current local policy and the lease ceiling defaults to seven days.
Repeat `web-control --confirm` to revise an existing approval; omitted options then retain
the previously approved ceilings, including the lease ceiling. The exact server, user,
device and connection must match. Applied and rejected revisions, delegation, repository
receipts and pending recovery records are preserved. Web or agent settings requests cannot
change these locally approved maxima. Applied resources must still fit them; a pending
request is retained and its ordinary application can reject values outside a revised maximum.

For example, to approve a shared storage maximum of 50 GiB, stop the foreground companion
through Ctrl+C or its ordinary owner-managed shutdown, then run:

```bash
npm run local -- web-control --confirm --storage-gib 50
npm run local -- run
```

Repeat the same `--state PATH` on both commands when configured. Stopping the companion
releases its state lock; do not use `disable` to change only a maximum, because that also
changes work enablement and its lease. Refresh Local computers after the companion reports
the approval, then request Storage 50 in that computer's existing settings editor. Raising
the maximum alone neither resizes storage nor renews work permission. Physical resizing
happens only when the companion applies that settings revision through its existing
stopped-runtime path. Read the applied policy rather than treating a pending request as success.
Management reports remain available after a work lease expires without authorizing guest work.
A lost approval-report reply is resolved by reporting the same saved approval again; do not
erase local approval or recovery records or enroll a replacement computer.

The Local computers editor controls enablement, finite lease, defaults, storage,
repository grants and permissions and optional Git author identity.
Saving creates a requested revision. Applied means the companion confirmed that
revision; pending or rejected settings are distinct from the applied device policy.
Offline contact does not imply application. The companion continues management
polling while disabled or expired without dispatching work, so web renewal can
restore work within the approved ceiling. Offline revocation still cannot promise
instant physical shutdown.

An admitted owner can confirm deletion of one owned local codespace in Settings while the
paired computer remains active and local web control is approved. This cleanup does not require
enabled agent work, an unexpired work lease or the repository's agent `allowDelete` permission.
It authorizes only observation and deletion of that exact codespace at its current generation;
it does not extend the lease, change grants or permit creation, start or guest commands. The
companion must be running and reachable to complete the removal.

Ordinary settings changes settle owned work before changing policy. A consent-only revision or
verified delegated repository append that preserves all other settings applies live without stopping
existing VMs or changing their grants, generation, runtime, Git identity or lease. A refusal before
that append preserves the effective policy; an uncertain transition retains its durable intent.
CPU, RAM and Docker disk
defaults apply to new VMs; existing VMs restart with their admitted machine and
repository identity. The storage setting bounds the computer's SDK backing filesystem, while
Docker disk capacity belongs to each admitted VM. The default owned APFS image can grow or shrink while stopped
after native bounds and free-space checks, preserving data. Storage and Docker byte
values must be positive safe integers, storage must exceed Docker capacity, and native
sector alignment and usable filesystem capacity remain authoritative. Unknown physical changes retain their journal
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
A closed ordinary-operation socket does not prove cancellation or require stopping the VM.
Inspect the accepted marker; exact native ownership and current grants still govern new work.
Lifecycle shutdown remains responsible for proving that the exact owned VM has stopped.

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
The fixed tunnel's five-second framing guard ends when its broker connection is established.
The broker's 15-second CONNECT guard ends after the connected peer passes address verification.
These guards do not impose an idle deadline on an established tunnel. Current leases, revocation,
socket closure and broker shutdown still govern its lifetime.
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
  created with the owner's selected native idle timeout, or GitHub's maximum of
  240 minutes when auto-pause is off (see "Idle auto-pause").
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
  provider being asked to start it. Start never bypasses current resource,
  account, provider-control or owner-grant authorization. Explicitly starting a codespace remains available and unchanged.
- Stop records desired stopped state, advances the generation and stops the exact
  provider environment, preserving repository data. Router authority changes close
  affected observer streams; they do not fabricate command cancellation or authorize
  replay. The workspace remains the owner of its retained outcomes.
- Delete is a separate destructive operation. It requires the caller's current
  observed generation, checks local deletion permission before recording a new intent, persists
  delete intent before provider contact and
  becomes terminal only after the exact Codespace is confirmed absent.

For local browser deletion, the owner confirmation and its device/resource binding are recorded
atomically as `owner-delete` in the existing provider mutation journal. Relay derives cleanup
authority from that intent, not from a caller-supplied flag. MCP deletion retains the agent's
repository permission and work-lease requirements; a preflight refusal records no new delete intent.

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
is not an empty successful list. Read-only inspection uses stable owned identity and current native
state without synchronizing lifecycle counters or authorizing guest work. Each failing resource retains its diagnostic and verified state,
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
An owner confirmation can replace an old refused local delete intent, or one with only snapshot
requests, with a fresh guarded owner intent. A retained destructive delete request with an unknown
outcome keeps its existing generation and identity; a snapshot receipt alone is not evidence that
deletion was dispatched.
The local relay retains authenticated inline create/start/stop/delete requests and replies
under their lifecycle receipt retention. A retry reads the same mutation receipt even after the
original delivery deadline, without dispatching the effect again. Snapshot requests retain their lifecycle cleanup behavior.
Input and new dispatch require current resource authority. Already accepted output/ACK settlement
can complete an older exact claim after reconciliation advances the resource, without rewriting
the newer generation. Identical terminal ACK and terminal renewal are read-only receipts: they do
not extend expiry or revive dispatch. Ordinary work retains current
account/device/connection/repository/lease checks. Owner cleanup instead requires the current
admitted account, active device, exact connection/resource binding and web-control approval,
without extending repository grants or the work lease.
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

Disconnect fences workspace routing and stops persistent codespaces. It does
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
rejects new creation, start and workspace routing, while required lifecycle stop and
cleanup remain eligible for reconciliation.

### Idle auto-pause

`codespaces.auto_stop_enabled` (default true) and `codespaces.idle_timeout_minutes`
(default 30, allowed 5–240) select GitHub's native idle timeout for **new** Codespaces
created through Moira. Settings/API/MCP share these values; invalid stored values use
the default, and extensions cannot declare keys in this namespace.

When enabled, creation requests the selected timeout. When disabled, it requests
GitHub's maximum of 240 minutes, not indefinite running. Existing Codespaces keep
their provider parameters. GitHub detects editor, browser and terminal input/output
activity; a silent command can be stopped. Moira does not infer idleness from cloud
command rows or impose another command idle timer. Local VMs follow their owner's policy.

Provider observation refreshes managed state/ref under exact identity and authorization.
Failed observations retain the last verified state; unknown resources are not imported.
Refresh requests fresh observation. A provider stop does not authorize command replay:
collect the original workspace request and retain uncertainty without outcome proof.

## Direct operations

One workspace service owns commands, sessions and retained output in both providers.
The installed `moira-workspace` terminal CLI calls its private Unix HTTP socket.
MCP reaches the same owner through the cloud router; ordinary work uses neither
GitHub SSH dispatch nor Local lifecycle relay.

Choose a fresh `request_id` in `ws1-<lowercase UUID>` form before mutation.
The owner durably binds it to immutable input before effects; changed input is refused.
Historical bare UUIDs remain archival and are never translated, imported or dispatched.
After reply loss inspect the original identity without resubmitting the command.
Observer/service reconnect never authorizes launch replay.

Exec accepts argv, or a script in a named session. Sessions preserve working directory
and exported variables; opening/ending is explicit. Session context publication serializes
within that session, while distinct sessions/stateless commands remain independent.
`stdin_text` is inline text; `stdin_file` streams native attachment input before launch.

Admission may return `starting`. Inspection distinguishes actual running, terminal
receipts, proved `not_started` and `unknown`. Missing witnesses cannot manufacture
terminal success/failure/cancellation. Addressed cancellation requires actual execution
evidence to settle. Observer disconnect does not cancel detached work. Output stays in
the workspace and is read by stream/offset/length from the original request.

Only explicit `timeout_seconds` imposes an execution deadline. Observation windows
and transport authentication checks do not stop commands. Moira imposes no aggregate
command/session/stdin/output or implicit runtime ceiling. Caller output windows bound
one response, not retained output. Actual disk/process failures, scoped authority and
provider lifecycle still apply: GitHub may stop silent work; Local requires an enabled,
unexpired owner lease.

The adapter opens outbound authenticated CONTROL carrying bounded call identities and
per-call DATA carrying raw HTTP. Native backpressure bounds stream buffers. Offline
work is not durably queued in the cloud. Before-dispatch loss is a known refusal;
after-dispatch loss can be unknown. Reconnection collects existing work, never replays it.

## File operations and native transfer

Stat/search/read/write/patch share that confined owner. Repository binding, safe paths,
no-follow descriptors, link/inode identity and current preconditions remain enforced.
File sizes/range positions must be safely representable. Workspace files and native
binary streams have no artificial Moira size ceiling.

Stat returns metadata/version. Read streams selected bytes with offset and total size;
complete binary reads use no whole-file transport buffer. Search accepts caller-selected
`max_matches`/`max_bytes` response windows rather than an execution quota.

Write/upload and patches require namespaced identity and explicit `expected`.
Writes stage bytes before guarded publication. Mutation journals retain original
target/backup inode ownership across interruption. Recovery never overwrites a
same-content foreign inode or replays a file effect; conflict preserves the uncertain
transaction. Collect the original request after reply loss. Matching write replay
validates unchanged path/precondition/bytes.

Native upload streams the authorized attachment directly to the workspace, without
cloud transfer checkpoints or file capabilities. Download performs one complete read,
then separately publishes an owned private attachment as `reference_id` and an MCP
resource link. Optional `max_bytes` refuses an oversized complete file before publication,
never publishes a truncated prefix. An agent can create a file with the direct CLI
and call MCP download without a separate stat.

Published attachments have finite retention and one-use browser download semantics,
independent of guest target commit/workspace receipts. Explicit
`communication({ action: "deliver-file", referenceId, message, channelId? })` sends a
retained owned attachment; download alone sends no notification. Checked sources
stream to capable adapters; extension adapters refuse streams rather than buffering
the whole file. Safe UTF-8 basenames including quotes are accepted; controls,
separators and dot-only names are refused.

## MCP tools

`codespace` exposes lifecycle, Git/pull requests, command collection and guarded files.
`codespace_process` starts/inspects/reads/cancels background commands; its process
identity is the namespaced workspace request identity. Mutations require that identity;
reads/lifecycle calls keep their own contracts.

The typed registry owns fields, defaults, native metadata and examples; use the
[public tool reference](../packages/docs/src/content/docs/docs/reference/tools.mdx).
`files_setup`, `transfer_status` and scoped file-capability CLI are not actions.
The installed `moira-workspace` CLI uses the same local owner independently of cloud
connectivity for exec/status/cancel/output/stat/read/download/write/upload/search/patch.
Known auth/provider/pre-dispatch failures remain bounded refusals. Unknown dispatched
outcomes require collection of the original identity, not a fresh ID to bypass uncertainty.

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
start/stop intent with applied access, it retries that exact resource's existing endpoint.
A local delete intent opens the destructive confirmation again and uses the displayed current
generation only after the owner confirms. A pending create or unavailable work access instead
requests read-only refresh and never creates another VM. Action errors and loaders belong to
the affected codespace. A refused deletion shows its error in the dialog and ends the action's
spinner immediately; Cancel remains available while a separate read obtains the current generation
for another confirmation. Domain refusals do not sign out the owner.
Refreshing a computer section silently updates the shared data source
without making another computer's card busy. Entering Local computers and acknowledged policy
changes refresh its management data. The card keeps a saved repository list visible
with a stale warning when provider enumeration fails. Its Refresh button forces
grant and managed-resource observation. If GitHub cannot confirm current resource
state, the card shows a stale warning and retains the saved entries. It never
mentions chats or sessions.

The Automatic pause card selects GitHub's native timeout for new Codespaces only,
including its 240-minute maximum when off. It explains editor/browser/terminal activity
and the risk to silent commands. Existing resources keep their provider parameters;
Local follows the computer owner's policy.

The separate GitHub monthly usage card shows compute/storage use, available plan
allowances, net billable cost, payer and retrieval time, or unavailable. Your limits
shows held GitHub resources and applicable owner-selected machine/lifecycle/billing
controls. It contains no cloud command/output/file-transfer counters. Local resources
follow their signed computer policy rather than GitHub count or machine budgets.

The routes retain `/api/integrations/github/codespaces` behind
`requireAuth` and are a second presentation of the same services the MCP tools use,
with the same tenant and current-authority guards; lifecycle deletion additionally checks its
current generation. Explicit browser confirmation additionally authorizes
exact local owner cleanup; MCP confirmation does not grant that authority. The list combines repositories
and codespaces from both providers and includes `providers` with their separate connection,
readiness and limits. A local `repository_id` is the qualified target returned by discovery;
callers do not manufacture it. Creation routes by that target, and later actions route by the
resource's persisted provider/device identity:

| Method   | Path                  | Behavior                                                                                                                                                                                                |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/`                   | Refreshes grants behind the TTL, then returns readiness, connection, approved repositories, `repositories_stale`, `resources_stale: false`, summaries still in use and `limits`                         |
| `POST`   | `/refresh`            | Forces grant refresh, managed-resource observation and billing read; returns the list with separate repository and resource stale flags                                                                 |
| `POST`   | `/`                   | Selects the provider from `repository_id`, verifies its grants and policy, then creates for `ref`; GitHub also verifies the personal billable owner; returns the sanitized (possibly pending) codespace |
| `GET`    | `/:codespaceId`       | One owned sanitized codespace                                                                                                                                                                           |
| `POST`   | `/:codespaceId/start` | Records desired running state; `data_preserved: true`                                                                                                                                                   |
| `POST`   | `/:codespaceId/stop`  | Records desired stopped state; `data_preserved: true`                                                                                                                                                   |
| `DELETE` | `/:codespaceId`       | Requires `confirm_delete: true` and the current `expected_generation`; `data_preserved: false`                                                                                                          |

Domain failures map to bounded codes: not found and malformed IDs return the generic
404, generation conflicts and not-running states 409, unsupported organization
billing 422, resource policy refusal 429, provider disabled or unavailable 503, and a
missing feature configuration 503 with the
same-origin Settings link. Responses never carry provider resource names, markers,
claims, capabilities or credentials.

Local lifecycle errors use bounded diagnostic codes from
`packages/shared/src/codespaces/local-failure-guidance.ts`: `CODESPACE_LOCAL_CREATION_UNKNOWN`
(409) asks for exact inspection without replacement; `CODESPACE_LOCAL_SETUP_INCOMPLETE` (409)
asks for confirmed cleanup before recreation; `CODESPACE_LOCAL_PROTOCOL_ERROR` (409) asks for
matching bundles and saved-state checks; `CODESPACE_LOCAL_RUNTIME_ERROR` (503) asks for runtime
repair and exact inspection; `CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED` (403) means agent deletion
is not approved. The owner can instead confirm deletion of the same codespace in Settings with
active local web control, without granting permanent agent deletion permission. Public troubleshooting owns
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
resource reconciliation backlog, oldest due age and active resource count against
its applicable lifecycle limit. It does not infer workspace activity or count command
queues, retained output or transfer bytes.
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

| Metric                                                  | Labels                        | Meaning                                                    |
| ------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `moira_codespace_connection_events_total`               | `provider`, `action`          | Connection start/complete/refresh_failed/disconnect events |
| `moira_codespace_lifecycle_events_total`                | `provider`, `action`, `state` | Resource create/start/stop/delete/cleanup outcomes         |
| `moira_codespace_rejections_total`                      | `code`                        | Refusals before provider contact by bounded error code     |
| `moira_codespace_reconciliation_due`                    | `kind`                        | Records waiting for reconciliation                         |
| `moira_codespace_reconciliation_oldest_due_age_seconds` | `kind`                        | Age of the oldest waiting record                           |
| `moira_codespace_active`                                | `kind`                        | Active resources                                           |
| `moira_codespace_connector_available`                   | `provider`                    | 1 when the connector answers its health probe              |
| `moira_codespace_ready`                                 | `provider`                    | 1 when the instance accepts new codespace work             |

Both the web backend and the MCP server process refresh their readiness decision and
gauges on `CODESPACE_RECONCILE_INTERVAL_SECONDS`; every readiness computation also
refreshes them. Suggested alert conditions: `moira_codespace_ready`
equal to 0 while `CODESPACE_CODESPACES_ENABLED=true`; `moira_codespace_connector_available`
equal to 0; `moira_codespace_reconciliation_oldest_due_age_seconds` above several
reconcile intervals; a rising rate of `moira_codespace_rejections_total` with
`code="CODESPACE_POLICY_LIMIT"` (resource policy refusal);
`moira_codespace_lifecycle_events_total{action="create_rejected"}` or
`moira_codespace_connection_events_total{action="refresh_failed"}` increasing.

Kill switches are the durable `codespaceProviderControl` rows for the `global` scope
and the `provider:github-codespaces` scope. Administrators read and change them through
`GET /api/admin/codespaces` and `PUT /api/admin/codespaces/controls/:scope` (body
`{ "disabled": boolean, "reason"?: string }`) or the Codespaces tab of the admin
Settings page, which shows the readiness facts and asks for confirmation before
stopping work. Disabling refuses new create, start and workspace routing,
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
  1 CPU, 640 MiB memory and 384 tasks (each lifecycle/bootstrap worker is further limited to 256
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

GitHub creation and workspace routing require `CODESPACE_CODESPACES_ENABLED=true`.
Local availability is independently authorized by its owner policy/device/grants.
The remaining environment defaults control provider lifecycle, billing and attachment
retention, not command or file execution:

| Variable                               | Default | Meaning                                           |
| -------------------------------------- | ------: | ------------------------------------------------- |
| `CODESPACE_MAX_CPU_CORES`              |       4 | GitHub selected machine CPU budget                |
| `CODESPACE_MAX_MEMORY_GB`              |       8 | GitHub selected machine memory budget             |
| `CODESPACE_MAX_STORAGE_GB`             |      32 | GitHub selected machine storage budget            |
| `CODESPACE_MAX_ACTIVE_PER_USER`        |       4 | Held GitHub resources, including stopped          |
| `CODESPACE_MAX_ACTIVE_GLOBAL`          |      16 | Held GitHub resources across the instance         |
| `CODESPACE_CREATE_THROTTLE_SECONDS`    |      60 | GitHub creation reservation interval              |
| `CODESPACE_PERSISTENT_RETENTION_DAYS`  |      30 | Provider stopped-resource retention, at most 30   |
| `CODESPACE_CREATE_DEADLINE_MINUTES`    |      15 | Creation reconciliation deadline                  |
| `CODESPACE_CLEANUP_DEADLINE_MINUTES`   |      15 | Lifecycle cleanup deadline                        |
| `CODESPACE_CLAIM_LEASE_SECONDS`        |      30 | Resource reconciliation ownership                 |
| `CODESPACE_RECONCILE_INTERVAL_SECONDS` |      30 | Lifecycle reconciliation cadence                  |
| `CODESPACE_START_WAIT_SECONDS`         |     180 | Provider start observation window                 |
| `CODESPACE_TRANSFER_TTL_MINUTES`       |      10 | Separately published private attachment retention |

Values must be positive safely representable integers in their units; the global held
resource budget cannot be below the per-user budget. The provider retention bound
remains explicit. Removed operation/input/output/binary aggregate settings are not
workspace execution controls. Actual storage, scoped authority and native provider
constraints remain applicable.

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

SQLite retains connection/resource identity, grants, lifecycle intents, provider controls,
credential envelopes and attachment metadata. `workspaceAgentCredential` stores scoped
credential digests and measured-life/generation bindings; clear credentials are delivered
only by fixed bootstrap. Command/input/output/file journals live in the workspace.

Historical SQL operation and transfer rows and companion receipts remain archival.
They are not attached to execution, counted as active command work, imported into the
new namespace or replayed. Resource observation timestamps advance only after verified
provider observation. Credential vault envelopes retain their authenticated ownership.

Cloud audit emits connection, resource lifecycle and administrator-control events.
MCP call audit records the tool boundary; it is not a cloud execution journal. Metadata
is sanitized and excludes command/file content, argv, cwd, stdin/stdout/stderr, provider
credentials, capabilities and SSH material. Provider refusals retain only safe bounded
classification/reasons; unexpected failures are not represented as provider answers.

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

`tests/COVERAGE-MAP.md` maps the focused connection, resource, workspace-service/router,
migration, connector, egress, packaged-isolation, MCP tool, website management,
readiness/metrics and kill-switch suites, including the ChatGPT-compatible client
scenario over real services, the HTTP contracts against the local container
(`npm run test:mcp-tools`, `npm run test:api`) and the Settings browser scenarios
(`npm run test:e2e`). Live GitHub App user
credentials, an actual personal Codespace and ChatGPT are separate external
compatibility gates; deterministic tests do not establish them.
