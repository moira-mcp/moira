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
delete and GitHub adoption) over the same services. Cloud checks current account, repository and
assigned-device authority. Physical lifecycle and its original-operation journal belong to the
paired controller; existing Local work follows its owner grants and finite lease.

## Component boundary

Shared connection/resource services own tenant authorization, repository grants, billing reads
and minimal resource routing identity. The paired controller owns GitHub and Local lifecycle,
original receipts and live observations; Local policy and repository admission also remain there.
`packages/workspace-service/` owns commands,
sessions, input, output and guarded files inside each workspace. Its terminal CLI and
remote clients reach the same private Unix HTTP service and durable local journal.

The backend workspace router authenticates scoped agent credentials and forwards raw
HTTP streams over outbound HTTPS Upgrade connections. Its rendezvous state is in memory:
there is no cloud command queue or result store. `WorkspaceAuthRepository` stores only
credential digests bound to user, resource, authorization/resource generations and measured
guest life. Fixed provider bootstrap installs the common payload without giving project
commands the original GitHub OAuth, refresh or device credentials.

The backend is the sole live connection registry. MCP and other server processes observe
workspace/controller presence asynchronously through its protected Unix socket. The backend
rechecks current authority and the exact endpoint identity and both generations without
dispatching an owner call. Publication, communication, scoped credentials and GitHub readiness
use this observation; an unreachable backend or mismatched binding is unavailable. Owner
dispatch independently rechecks current authority.

The paired controller uses fixed authorized GitHub REST actions and its packaged provisioner
to install and start the common service. The cloud does not run SSH, bootstrap workers or a
lifecycle reconciler.
The Local companion owns exact VM lifecycle, approved policy, storage, SDK credentials
and the private controller journal; ordinary commands/files use the workspace service.
The workspace or paired controller owns immutable attachment publication and communication receipts. `owner-file://workspace/...` references retain their original guest; `owner-file://controller/...` references retain their original controller. Cloud publication routes authenticate current owner authority and forward the private immutable source. The owner must be reachable; expiry and revocation remain effective. Ordinary owner links are repeatable while authorized, unlike the separately single-use progress-image grant.

Website/MCP adapters share sanitized resource/readiness projections. MCP adapts lifecycle
services and the workspace client; the typed registry owns its public schema.
Every cloud lookup supplies the authenticated user and resource identity. An opaque ID
grants no access. Original GitHub OAuth and refresh credentials remain in the vault.
The trusted Local host or GitHub guest broker receives a derived credential scoped to
one approved repository and action; SDK credentials remain in the computer's owned store.
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
Local work requires the computer owner's current grant and lease. Remote work also checks the
current account, device and resource binding. No cloud control replaces physical owner rights. `CODESPACE_CODESPACES_ENABLED` gates GitHub only; GitHub App credentials and the
GitHub provisioner are not required for public read-only Local work.
Private Git, push and pull-request creation use the connected GitHub App user authorization.
Agent work cannot choose arbitrary host execution, VM templates, updates or broader local grants.
Owner web settings require a separate explicit local approval and remain within its ceilings.
Each codespace has its own persistent mountless microVM. One repository may have multiple codespaces,
each with a separate VM and lifecycle. The computer's bounded backing image holds the local SDK
storage; its configured capacity is shared across these codespaces, not assigned to each one.
Local VMs do not consume GitHub
Codespaces count slots and are not subject to its machine ceiling or creation throttle.
CPU, RAM and disk allocations remain owner-controlled. Backend, frontend
and browser jobs in one codespace share that VM. The physical Local VM capability requires Node.js 24,
macOS on Apple silicon and Docker Sandboxes `sbx` 0.46.0. Linux Local VM execution is refused because
the required runtime ownership contract is not supported there; a container or host-shell fallback
is not used. Install the pinned SDK from the [official Docker release artifacts](https://github.com/docker/sandboxes/releases/tag/v0.46.0)
and retain its signed application bundle; see [Docker installation requirements](https://docs.docker.com/ai/sandboxes/install/).

Pairing and running a neutral controller do not require Local SDK initialization or storage.
It can serve GitHub provisioning and communication without fabricated Local VM grants.
The following initialization sequence enables the separate physical Local capability.
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
repository grant; the guest receives no original OAuth token. Public read-only Git is direct
and needs no App grant. Controller operations cannot expand local authority.
`enable --hours N` grants at most 168 hours (8 by default), not indefinite permission.

Open **Settings → Development → Local computers** (`/settings#integrations-local`, under the app's
configured prefix), choose **Connect a computer**, and copy the enrollment command and token
separately. From this checkout, use `npm run local -- enroll` with the displayed `--server` and
`--pairing-id` arguments. Enter the token on stdin and end input; do not append it to the command
or put it in shell history. The trusted server URL must be HTTPS, without credentials, query or
fragment. Refresh the browser, verify the pending computer's identity, then confirm. Its
current rights are read from the reachable owner after connection. Only then run:

```bash
npm run local -- run
```

Keep that foreground process running to serve the account; Ctrl+C settles owned work. Reconnection
uses the owner's durable original request journal, so a lost response does not authorize redispatch.

Before Local create/start/stop/delete, the caller chooses a `request_id` in
`ws1-<lowercase UUID>` form. Start/stop/delete also send the generation observed for that
resource. This lifecycle generation is distinct from its stable Git routing generation.
Collect the original receipt through `codespace({ action: "operation", device_id,
request_id })`, including when create returned no codespace ID. The owner reports `absent`,
`accepted`, `completed` or `unconfirmed`; collection never repeats the effect. Neither
`absent` nor a newer resource snapshot authorizes automatic replay. A new explicit action
uses a new identity after the original outcome and current state have been inspected.

Network failures and server 5xx responses make remote owner state unavailable without
stopping already admitted work. Offline settings and lifecycle mutations are refused;
there is no cloud or browser dispatch queue. A failed response to an accepted operation
requires collection of its original identity after connection returns.
Only device-endpoint unauthorized responses or confirmed device identity/revocation failures
invalidate device authority and make the daemon stop work. Local disable, lease expiry and explicit
shutdown retain their independent stop boundaries. Existing work remains bounded by its current
local grant and finite lease without extension. Reconnection may return retained receipts, but
their effects are not redispatched.
The browser can revoke a specific device; revocation invalidates its generation and denies new
work. Local `disable` independently stops owned SDK/VM processes and preserves data, including when
credentials cannot be read. Neither closing an MCP client nor losing the connection deletes a codespace.

Broker shutdown fences new admission and waits for owned HTTP/CONNECT tasks, accepted socket
closure and connection-capacity reservation/release. A CONNECT reservation finishing after
shutdown is released without destination lookup or connection, so closed service ownership does
not leave an upstream connection running after shutdown.

The host CLI supports `create OWNER/REPO --ref BRANCH`, `start SPACE_ID`, `stop SPACE_ID`,
`remove SPACE_ID --confirm` and `collect REQUEST_ID` through the running private controller.
Choose `--request-id` before mutation; the CLI prints the identity before observing its outcome.
Fresh create requires live cloud route registration and initial Git authority. Already admitted
VMs can start, stop or be cleaned up offline under applicable current owner authority.
Starting requires the finite work lease; owner-confirmed cleanup does not renew it.
Raw host execution is unsupported; commands/files use the guest `moira-workspace` CLI.
`status` and `recover SPACE_ID --confirm` retain their custody/recovery roles. Paired `run` owns the VM lifetime.
Closing it settles owned processes while preserving disks and receipts.

After abrupt termination or reboot, restart `run` with the same state. The runner
gate permits stale-marker reclamation only after proving the former runner and guard
absent. Unverifiable ownership remains refused; do not unlink locks, clear journals
or adopt a VM by name. Explicit disabled-device recovery proves physical settlement
without enabling work or replaying unknown commands.

The cloud routes authenticated controller metadata to the live owner. Lifecycle/settings
effects and original receipts belong to the controller journal, not a cloud claim/ACK queue.
Archived operation requests and receipts remain untouched and non-runnable.

### Owner web control and bundle updates

The server, companion and every running owner guard must use a coordinated control-contract
edition, including the shared scoped snapshot and typed management-result schemas in
`packages/shared/src/codespaces/local-controller-protocol.ts`. Enrollment/heartbeat carry
registration identity rather than policy; live controller snapshots carry current owner state.
The controller and local `web-control.json` schemas are not compatible
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
Migration 0061 archives old cloud Local policy/control/relay/grant and operational records;
the archived rows are not dispatchable authority. The owner imports only verified existing
native bindings, preserving VM/profile/disk identity and unknown receipts. Do not reconstruct
cloud policy or clear unknown state to bypass a refusal. Rollback must retain matching bundles
and coherent state rather than resetting the SDK.

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
Offline contact does not imply application: saving is refused and the editor retains its draft.
Reconnect and refresh before explicitly saving. The live controller can receive management
changes while work is disabled or expired, without authorizing guest work. Offline revocation cannot promise
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
and keep work fenced. Collecting the original settings receipt cannot renew a lease or
repeat a resize; an unrelated request cannot erase an uncertain resize.

### Delegated repository additions

After local web-control opt-in, the owner can enable agent repository management in the
Local computers editor. It is off by default and binds the connected, verified personal GitHub
account, separate permissions for existing and new private repositories and optional push.
There is no repository-count quota or technology-specific network profile.
Saving requests a revision; only confirmed owner application makes its delegation effective.
The MCP caller cannot enable that consent, change
its account, supply rights, or extend the computer's lease. New-private consent authorizes the
separate `repository_create` action; it does not authorize adding unrelated existing repositories.

`codespace({ action: "local_devices" })` returns owned device IDs, labels, contact status and
`owner_available`, plus eligible personal GitHub App installations with `installation_id` and owner.
A warning asks for missing GitHub setup while devices remain discoverable. Applied delegation
and detailed owner permissions are inspected in Settings, not returned in this compact discovery.
`repository_add` takes that `device_id`, the existing GitHub numeric `repository_id` and a caller-chosen
UUID `request_id`. It verifies the current GitHub App installation grant, repository ID, owner,
private visibility and required read/push rights. It adds only a private repository owned by the
connected personal account. Its receipt is `pending`, `applied` or `rejected`; `local_repository_id`
is null until the exact grant is confirmed by the owner. MCP calls live owner admission and
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
installation setup is incomplete internally; MCP returns `repository_id` only after confirmed owner admission.
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

Ordinary `git fetch` and `git push` use the installed private broker. The Local host
and GitHub guest use the same fixed HTTPS Git and pull-request implementation;
cloud Moira authorizes scoped credential issuance and retains verified author metadata,
without forwarding Git packfiles or executing pull-request requests. The broker holds
the child token in memory, checks finite authority and disposes it after the upstream
transport physically closes. Its same-UID trust boundary is not an OS sandbox against
authorized project commands. Explicitly approved public read-only Local fetch can use
anonymous access; failed scoped issuance never enables that branch.

Guest Git identity is repository-local: use owner-configured name/email or the
verified GitHub login and numeric-account noreply address. Host Git configuration
and secrets are not forwarded. An existing empty remote can open an unborn
requested branch: the agent creates files, commits and pushes the first branch,
then pushes a feature branch. A nonempty remote with an absent ref is refused.
The MCP `pull_request_create`, `pull_request_get` and `pull_request_find` actions
use the owned codespace and approved repository. Only creation requires the
pull-request permission; reads and exact head/base lookup use read authority.
Choose a fresh `ws1-<lowercase UUID>` `request_id` before PR creation. After an uncertain
create, call `pull_request_create` with only `codespace_id` and that original
`request_id` to collect its receipt, then find by exact head/base before considering
another create. Collection never creates a PR. Unknown creation is an error and retains
both its original PR identity and any `security_request_id`; the security identity
addresses credential issuance/disposal, separately from the PR effect. PR reads require
no mutation identity. There is no atomic exactly-once guarantee across the owner and GitHub.

The installed CLI uses the same owner:

```bash
moira-workspace pull-request-create --request-id ws1-00000000-0000-4000-8000-000000000001 pr.json
moira-workspace pull-request-create --request-id ws1-00000000-0000-4000-8000-000000000001
moira-workspace pull-request-get 7
moira-workspace pull-request-find feature/change main
```

`pr.json` supplies `head`, `base`, `title`, and optional `body`/`draft`. The second
command only collects the first create. CLI errors preserve the owner result;
credential custody/disposal uncertainty is never reported as confirmed refusal.

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

The GitHub provider manages personally billed Codespaces for a repository approved by a
GitHub App installation visible to the connected user. Explicit adoption can prepare an existing
Codespace without replacing its public identity or disk. That repository may belong to the
user's account or an organization; organization billing is unsupported. Installing the App on an organization requires that organization's
approval; the connected user's personal GitHub account remains the payer.

Core exposes provider-neutral create, list, get, start, stop and delete operations.
Local cloud storage separates immutable `localResourceIdentity` from the approved
`codespaceLocalResourceBinding`. Together they retain public resource and repository identity,
the original creation marker/ref, connection and authorization generation, exact device/profile
binding and revocation. The stable route generation authenticates the guest; it is not the
controller's current lifecycle comparison generation. Current grants, machine, desired/observed
state, lifecycle generation and pending request IDs come from the live owner, without writing an
operational snapshot back to SQL. `current_ref` remains null when the checked-out ref is not observed.
Registration alone proves neither a machine nor a running or stopped VM.

Local lifecycle/get/list return the common sanitized summary directly. The public `machine` field
is nullable, including confirmed retirement. If the owner has no resource
observation or desired state, the call returns `CODESPACE_PROVIDER_UNAVAILABLE`; when its live
journal retains pending originals instead, it returns `CODESPACE_LOCAL_CREATION_UNKNOWN` with
the original request, device and resource IDs for collection. Neither case fabricates a lifecycle
generation from the stable route generation. A completed receipt can still contain a retained
uncertain error: initial submission and explicit repetition preserve that uncertainty, rather
than reporting authorization failure or confirmed rejection. Collection does not create another VM.

GitHub route metadata binds the user, current authorization epoch, numeric repository identity,
exact provider name when known, assigned device/generation/connection and a billable/unknown
retirement witness. It is not a cloud lifecycle journal or desired-state cache. The controller
retains the create marker, requested ref, native provisioning custody, measured guest root/life,
lifecycle generation and pending original request IDs.

Create requires a caller-selected ws1 request ID and an explicit live paired controller, or the
sole eligible one. The controller admits the original operation before invoking fixed provider
actions. Cloud rechecks account, App grant, numeric repository, personal payer and assignment at
those boundaries; parent authorization never leaves cloud. The controller receives narrowly scoped
provisioning authority, installs the packaged service, measures repository/root/release and enrolls
the outbound guest. Caller commands, SSH configuration or bootstrap URLs cannot select this work.

Start, stop, delete and adopt require the observed owner generation and original ws1 identity.
The owner journal checks comparison-and-set before admission. Cloud security registration accepts
monotonic authority only from the same assigned actor and retires old guest/renewal/child authority
before publication; it has no second operational CAS or replay queue. Stop preserves the disk.
Delete retires only after exact authenticated absence and physical/credential settlement.

Explicit adopt prepares a known Codespace or registers an exact provider name after current
owner, billable-owner and numeric-repository proof. After reconnection or repository rename,
the same controller must drain old provisioning custody before publishing a new authorization
epoch and reproving the guest. Another device cannot silently replace that custody. Historical
identities with no assignment stay fenced until earlier custody can actually be proved settled.

A lost create reply retains the original unknown marker and receipt. Pure collection can discover
that exact Codespace, but never repeats create, start or SSH. A found environment with incomplete
provisioning requires explicit adopt. No match does not prove create was never dispatched.
An explicit delete can retire an exact known provider name after a currently authorized GET
confirms 404; ordinary list/get does not perform retirement.

Command/file calls require the already enrolled live guest. They never implicitly start a stopped
Codespace or bootstrap from cloud. Owner `running` and provider `available` alone are insufficient:
the router must have the current resource/authorization/life connection. Explicit registration
401/403 rejects startup readiness; temporary transport loss reconnects observation without replay.

Disconnect revokes guest/renewal routes, retires known scoped children and parent authorization.
It neither stops nor deletes a VM or disk. Explicitly stop a running VM to end compute use;
preserved disks can still incur storage charges until explicitly deleted.
Minimal owned/billable/unknown identities remain for
explicit cleanup and block account deletion while unretired. Reconnection does not silently
restore authority. Public IDs, disks and archived uncertain history remain preserved.

Provider failures retain typed transport, HTTP or invalid-reply evidence with safe status/request
identity and refusal reason when available. Known create refusals include HTTP 401 and 402;
timeout, 5xx and accepted responses whose authority publication was lost remain uncertain.
A reason containing token-, secret-, JWT- or URL-shaped content is dropped whole.
Collect the original owner/request before deciding on another mutation.

For Local browser deletion, the controller binds explicit owner confirmation to the exact
device/resource, observed generation and original request identity. Its durable lifecycle journal
retains that authority; cloud storage does not queue the mutation. MCP deletion retains the agent's
repository permission and work-lease requirements; a preflight refusal records no new delete intent.

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

Local original receipts live in the controller journal. `pending_request_ids` in owner-backed
resource summaries identifies accepted/unconfirmed work for collection after a page reload;
confirmed terminal receipts retire those pointers; retained uncertain errors remain collectable.
Collection and read-only snapshots do not repeat an
effect, advance a lifecycle generation or extend a lease. Ordinary work retains current
account/device/connection/repository/lease checks. Owner cleanup instead requires the current
admitted account, active device, exact connection/resource binding and web-control approval,
without extending repository grants or the work lease.
Finishing a command, disconnecting an MCP client or ending a conversation never
deletes a persistent codespace.

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
GitHub SSH dispatch nor the Local controller.

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

`preview_image` reads a complete owner file and validates PNG/JPEG container framing and
positive dimensions without decoding pixels. Explicit `max_bytes` is a caller-selected
whole-file bound; no fixed Moira byte, dimension or pixel-count quota replaces it.

Materialize archive delivery resolves authorized workflow text in the cloud as
`{path,content:string}`. The selected controller alone encodes UTF-8, constructs
`materialize.tar`, stages and publishes it. A presentation grant retains the full owner
scope and original ws1 identity; repeated requests collect that receipt before rerendering
or resolving Note/Playbook references. Current paused-node/context authority is rechecked
before streaming. There is no archive file-count or byte quota. The separate owner-free
in-context fallback retains its 256 KiB UTF-8 budget and refuses instead of truncating.

The workspace or paired controller owns immutable attachment publication and communication receipts. `owner-file://workspace/...` references retain their original guest; `owner-file://controller/...` references retain their original controller. Cloud publication routes authenticate current owner authority and forward the private immutable source. The owner must be reachable; expiry and revocation remain effective. Ordinary owner links are repeatable while authorized, unlike the separately single-use progress-image grant.

The `communication` action `deliver-file` explicitly delivers a publication using `request_id`, `referenceId`, `message`, `kind` and optional `channelId`. It can instead accept a native `file` descriptor with the selected `device_id`, or use the sole eligible live paired controller. Choose and retain the original ws1 ID before submission. Collect with action `operation`, the original `request_id` and its assigned `device_id` or `codespace_id`; collection never downloads again or resends. Missing/ambiguous/offline owner refuses before admission, with no cloud queue or fallback to a different source owner. Text communication remains independent of owner availability.

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

Settings → Development separates environment management, GitHub connection and Local computers.
The common management card retains provider/resource identity, live owner generation, pending
original IDs and nullable machine observation. Local cards group by stable computer UUID rather
than label. A neutral controller can provision GitHub without fabricated Local VM settings.

GitHub create selects an approved repository/ref and a live controller. Several eligible
controllers require a choice; without one, creation is unavailable before admission. Explicit
adopt accepts a provider name or managed resource and preserves its disk. Lifecycle actions use
an original ws1 identity and observed owner generation. **Check state again** collects retained
originals or refreshes when none is pending; newer metadata alone cannot settle an uncertain effect.
Errors remain scoped to their resource. Local browser deletion additionally needs explicit
confirmation and current web-control approval, without broadening permanent agent permissions.

Connection, repository, resource and billing reads retain independent error/refresh states.
Management returns `providers`, minimal live `controllers` and `provider_billing`, with no Moira
aggregate limit view. `CodespaceBillingPanel` shows personal monthly compute, storage, allowances,
cost, payer and retrieval time, or unavailable. Missing `Plan: read` does not deny management.
Automatic pause selects provider timeout for new resources, without a cloud idle timer.

The shared `/api/integrations/github/codespaces` routes and MCP tools return
`CodespaceSummaryView`. Local targets retain discovery's qualified `repository_id`.
Original collection uses `GET /api/integrations/local/devices/:deviceId/operations/:requestId`
or MCP `codespace` action `operation` with `device_id` and `request_id`, including create before
a resource ID returns. See [Codespace Management API](API.md#codespace-management-api) for wire fields.

Offline owners expose no cached policy/grants as current authority; settings drafts stay editable,
but saves are refused. Existing admitted VM work can continue under its local grants and finite
lease. Fresh create needs cloud registration and initial Git authority; confirmed authority refusal
does not allow offline fallback. Local diagnostic recovery is defined by
`packages/shared/src/codespaces/local-failure-guidance.ts` and the
[owner recovery guide](../packages/mcp-server/src/help/content/integration/troubleshooting.md#local-codespaces).

## Readiness and trust

`CodespaceObservabilityService.readiness()` reports configuration only: `disabled`,
`misconfigured` or `ready`, with `configuration`, `resources_enabled`, `reason` and `checked_at`.
It performs no connector probe, SSH check, reconciliation or cached lifecycle observation.
Ready configuration does not prove a controller/guest online; Local policy/device/grant/lease
checks remain independent of GitHub configuration.

Authenticated management and `GET /api/admin/codespaces` expose this metadata. Public backend/MCP
health exposes only `{state,provider,degraded}`; only `misconfigured` degrades that projection.
No administrator lifecycle kill-switch endpoint or mass-stop operation exists. Metrics retain
closed-label `moira_codespace_connection_events_total` and `moira_codespace_rejections_total`
without user/resource/operation labels or cloud lifecycle backlog gauges.

Direct execution is not an agent sandbox. An authorized agent has its repository, installed tools,
network and configured Codespaces secrets, and can modify startup files. The fixed provisioner
runs on the assigned controller with narrowly scoped custody, not inside the multi-tenant cloud.
The guest service/Git broker retain the same-UID trust boundary, not an OS sandbox against
authorized commands. Original OAuth/refresh and device credentials never enter the project.
The normal application Compose has no credential-bearing SSH connector pair.

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
source test does not establish that the live App has them. Original OAuth/refresh credentials remain in the server vault.

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
The remaining environment defaults control provider lifecycle and billing, not command or file execution:

| Variable                              | Default | Meaning                                                     |
| ------------------------------------- | ------: | ----------------------------------------------------------- |
| `CODESPACE_PERSISTENT_RETENTION_DAYS` |      30 | Provider stopped-resource retention, from 1 through 30 days |

`CODESPACE_CODESPACES_ENABLED` defaults false and accepts only `true` or `false`.
Local availability is independent. There are no cloud machine/count ceilings, create throttles,
operation deadlines, claim leases, reconciliation intervals or command/file aggregate quotas.
Provider constraints, actual storage and finite owner authority remain applicable.

## Website authorization API

All routes are mounted under `/api/integrations` after `requireAuth`.

| Method   | Path                          | Behavior                                                                                                                          |
| -------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/github`                     | Refreshes an expired grant snapshot and returns the sanitized connection view with `repositoriesStale`                            |
| `POST`   | `/github/refresh`             | Forces grant enumeration and returns the current view; a provider failure retains the snapshot and sets `repositoriesStale: true` |
| `GET`    | `/github/start`               | Stores one-time browser state and redirects to GitHub; a refused start redirects to Settings with `?github=<outcome>`             |
| `GET`    | `/github/reauthorize`         | For a connected account, stores one-time browser state and redirects to GitHub for updated permissions without disconnecting      |
| `GET`    | `/github/callback`            | Consumes state, verifies GitHub identity/grants and redirects; a return from App installation (no state) re-reads grants          |
| `DELETE` | `/github`                     | Retires guest/renewal and scoped authority, revokes the GitHub grant and disconnects; preserves VM/disks and cleanup witnesses    |
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
managed Codespaces. **Disconnect** retires access and revokes the grant without stopping
or deleting those VMs. Explicitly stop running resources to end compute use; disks remain
until explicitly deleted.
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

Scoped child credentials have separate encrypted custody bound to their original
security request, resource generation, repository and action. A candidate is retained
before validation or delivery. Known children are explicitly revoked on completion,
abort and retirement of parent/grant/device/resource/account authority; parent revocation
is not assumed to prove child disposal. Unknown issuance remains uncertain.
`SCOPED_CREDENTIAL_OUTCOME_UNCONFIRMED`, `SCOPED_CREDENTIAL_CUSTODY_UNCONFIRMED` and
`SCOPED_CREDENTIAL_DISPOSAL_PENDING` retain the original security identity. Pure collection
does not mint a child or refresh its parent; confirmed absence does not authorize automatic
reissuance. On the Local host, `moira-local status --json` lists security receipts and
`moira-local collect ORIGINAL_SECURITY_REQUEST_ID` inspects the exact request. A live
stream is not cancelled by inspection. Orphan disposal requires proved absence of its
exclusive owner, rather than a missing listener or lost reply.

Blocking an account fences new work before retiring known children. Account deletion
returns pending while child/parent custody or nondeleted managed resources remain;
the account stays blocked and retains the keys and routing required for explicit cleanup.
Stop does not delete a persistent disk. Delete managed resources through their existing
confirmed cleanup action before requesting account deletion; the account API does not implicitly
delete external VM disks. Lifecycle HTTP/MCP callers preserve scoped retirement errors
without claiming that the provider stop/delete completed.

## Persistence and audit

SQLite retains connection/resource identity, GitHub grants, minimal route identity and retirement witnesses,
parent and scoped-child credential envelopes. Communication publication metadata and receipts belong to the source owner; complete former transfer/grant rows remain immutable archives. Local policy, control, repository grants,
observations and mutation receipts belong to the owner. Local cloud storage retains only
registration/revocation, immutable resource routing and a confirmed retirement witness.
Owner-confirmed deletion records its generation, original request and retirement time and revokes
the binding and guest credentials. Device or binding revocation alone does not retire a resource
or prove that its disk is absent; unretired identities, including unresolved or unbound resources, block account
deletion. Migration 0064 preserves complete resource and binding rows in the immutable
`archiveLocalResourceLegacyCurrent` and `archiveLocalResourceBindingLegacyCurrent` tables.
The active schema contains no Local machine, desired/observed state, preparation deadline or
operational outcome. Public IDs, native bindings, revocation values and existing guest credential
tuples survive the migration; it never creates or replaces a VM. Nondeleted historical resources
remain conservatively unretired. Rollback restores the coherent pre-migration database backup
with matching owner state and bundles, rather than reconstructing operations from archives.
Migration 0061 separately preserves old Local device,
relay/part, repository, provider-mutation, usage and operational rows in immutable archive
tables; they are not active authority or runnable work. `workspaceAgentCredential` stores scoped
credential digests and measured-life/generation bindings; clear credentials are delivered
only by fixed bootstrap. Command/input/output/file journals live in the workspace.
Token-free security acquisition receipts and PR receipts also belong to the owner;
they retain original recovery IDs without persisting child tokens in project storage.

Historical SQL operation and transfer rows and companion receipts remain archival.
They are not attached to execution, counted as active command work, imported into the
new namespace or replayed. Resource observation timestamps advance only after verified
provider observation. Credential vault envelopes retain their authenticated ownership.

Cloud audit records authorization and public tool boundaries.
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
```

`tests/COVERAGE-MAP.md` maps the focused connection, resource, workspace-service/router,
migration, provider/controller, packaged-service, MCP tool, website management
and configuration-readiness suites, including the ChatGPT-compatible client
scenario over real services, the HTTP contracts against the local container
(`npm run test:mcp-tools`, `npm run test:api`) and the Settings browser scenarios
(`npm run test:e2e`). Deterministic tests and container fixtures do not establish live GitHub or ChatGPT
compatibility, genuine native attachment transfer or physical SDK isolation. Report only
the external acceptance actually performed; live GitHub validation is excluded from the
current work.
