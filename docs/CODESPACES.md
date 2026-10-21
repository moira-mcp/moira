# Codespaces and Local Computers

This reference describes Moira's provider-neutral codespace control plane and
the GitHub Codespaces and Moira Local providers. A codespace is a persistent,
user-owned development environment selected through a returned workspace reference. It is
not a chat session: Moira does not receive or store a ChatGPT conversation ID,
and different authorized clients may reuse the same codespace.

A codespace is a personal instrument for executing a flow for an agent that has
no filesystem of its own. It is not shared and is not a collaboration container;
collaboration happens through version-control branches in the repository.

GitHub authorization belongs to the authenticated website. Agents do not
receive provider credentials, OAuth operations, SSH configuration or lifecycle
capabilities. Agents reach codespaces through the authenticated MCP
purpose-specific workspace, command, file and process tools and the direct workspace CLI described below; the website owns the GitHub connection and
offers the same basic codespace management (list, create, start, stop, confirmed
delete and GitHub adoption) over the same services. Cloud checks current account, repository and
assigned-device authority. Physical lifecycle and its original-operation journal belong to the
paired controller; existing Local work follows current owner grants and permission enabled until explicit disable.

## Component boundary

Shared connection/resource services own tenant authorization, repository grants, billing reads
and minimal resource routing identity. The paired controller owns GitHub and Local lifecycle,
original receipts and live observations; Local policy and repository admission also remain there.
`packages/workspace-service/` owns commands, sessions, input, output and guarded files
inside each workspace. `createWorkspaceOwner()` provides their common operation API;
tool presentation calls it directly. The Unix HTTP server adapts external callers and
raw streams to that API, and the terminal CLI uses this private socket. Presentation
does not send an HTTP request back to its own service.

The backend workspace router authenticates scoped agent credentials and forwards raw
HTTP streams over outbound HTTPS Upgrade connections. Its rendezvous state is in memory:
there is no cloud command queue or result store. `WorkspaceAuthRepository` stores only
credential digests bound to user, resource, authorization/resource generations and measured
guest life. Fixed provider bootstrap installs the common payload without giving project
commands the original GitHub OAuth, refresh or device credentials.

The backend workspace router owns the live CONTROL/DATA connections and dispatch decision.
MCP and other server processes forward requests through its protected Unix socket. Actor and
publication authorization checks current account, credential, registration, resource generations
and enrolled guest life independently of connection availability. The router selects the current
connection and rechecks authority after asynchronous DATA rendezvous before dispatch. Explicit
GitHub status reads observe guest health through that same route; they do not establish a separate
presence gate for subsequent operations.

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
sessions, output and guarded file operations. A login-started persistent host service holds the
daemon, controller, native guard and VM egress; the CLI is its client. The runtime factory currently selects only the supported SBX backend; no Lima backend
is implemented. Before each fixed guest attachment, that backend verifies configuration, exact
identity, mounts and network receipt once, then rechecks the current local grant and runtime state
after those asynchronous proofs and before dispatch.

Moira Local uses outbound authenticated HTTPS to a locally selected Moira application URL.
Local work requires the computer owner's current grant and enabled permission. Remote work also checks the
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
npm run local -- enable
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
the volume's device ownership and approved capacity checks before work. Admission does not require
a fixed free-space reserve. A lost attach reply
is resolved from the observed binding rather than another attach. Custom storage mounts require
manual mounting; a missing image or unsafe binding remains a refusal. Startup never creates a
replacement image, resets storage or substitutes an unbounded directory.

`setup` initializes only an empty dedicated SDK profile. `doctor` checks storage, supported SDK,
settings, global network policy and owned inventory under enabled work permission. Its
`liveVmIsolationVerified: false` result is explicit: it does not execute a microVM isolation test.
Work and `doctor` check current authority from the start of SDK startup. Explicit disable
retains its physical-stop authority; caller cancellation fences its affected startup request. Observer or parent loss releases
native observation without manufacturing a VM stop or physical settlement receipt.
Installation, bootstrap and registration wait for actual completion rather than a general work
deadline; fixed metadata observations and the bounded `doctor` diagnostic remain distinct.
The SDK profile has its own HOME, namespace and encrypted credential store; it does not select
the user's personal Docker profile or change personal Keychain default/search metadata.
The bundled native helper prepares and unlocks only the owned store without interactive password
prompts. `login --new-store` is an explicit recovery operation: it requires disabled work,
the runner lock and confirmed shutdown, creates a separate store, and preserves existing stores.
An unreadable store never causes automatic rotation or personal credential adoption.
The machine-only store uses an owner-readable generated password file. The native helper sets and
checks the effective no-idle-timeout interval and disables sleep locking for that owned SDK store,
including after unlocking an existing store with its saved password. The persistent owner's launchd
registration creates a dedicated security session for its SDK children. This does not remove genuine
vendor sign-in requirements or guarantee that every SDK authentication failure can recover unattended.
It trusts the host user account; it is not protection
against another process already acting as that same user. Personal Keychain lock policy is unchanged.

`approve OWNER/REPO` grants repository read access;
`--private`, `--push`, `--delete` and `--pull-requests` grant those capabilities explicitly.
An enrolled private/write repository uses the server's GitHub connection and
repository grant; the guest receives no original OAuth token. Public read-only Git is direct
and needs no App grant. Controller operations cannot expand local authority.
`enable` permits work until explicit `disable`; no work-duration or renewal parameter is required.

Open **Settings → Development → Local computers** (`/settings#integrations-local`, under the app's
configured prefix), choose **Connect a computer**, and copy the enrollment command and token
separately. From this checkout, use `npm run local -- enroll` with the displayed `--server` and
`--pairing-id` arguments. Enter the token on stdin and end input; do not append it to the command
or put it in shell history. The trusted server URL must be HTTPS, without credentials, query or
fragment. Refresh the browser, verify the pending computer's identity, then confirm. Its
current rights are read from the reachable owner after connection. Only then run:

```bash
npm run local -- run
npm run local -- service-status
```

`run` starts or connects to the persistent owner and returns; closing the CLI does not stop VMs.
The owner starts through the user's macOS login registration, with its own copied Node executable,
private state and broker/tunnel. `service-status` reports its running release, readiness, failure,
control-plane state and active/staged installation selection. Local service readiness is not proof
that every VM or the remote route is available. Reconnection uses the owner's durable original
request journal, so a lost response does not authorize redispatch.

Select a returned target with `workspace_targets` for creation, or a workspace observation with
`workspace_list`/`workspace_observe` for lifecycle work. `workspace_lifecycle` and
`workspace_delete` consume that captured workspace reference; they do not refresh its comparison
generation before admission. Internal request identities are minted before effects and returned as
operation references. Use `operation_get` to collect an original, including creation before a
workspace reference is available. After a lost first reply, `operation_find` searches the selected
controller's originals; choose a candidate explicitly. An absent or unavailable result does not
prove the action never happened and does not authorize automatic replay. A deliberate new call is
a distinct intent. References grant no authority, and lifecycle generations remain separate from
stable Git routing generations.

Network failures and server 5xx responses make remote owner state unavailable without
stopping already admitted work. Offline settings and lifecycle mutations are refused;
there is no cloud or browser dispatch queue. A failed response to an accepted operation
requires collection of its original identity after connection returns.
Only device-endpoint unauthorized responses or confirmed device identity/revocation failures
invalidate remote device authority. They fence the remote controller route without converting
local intended-running state into a physical stop. Local disable and explicit
physical maintenance retain their independent stop boundaries. Existing work remains bounded by its current
local grant and enabled permission. Reconnection may return retained receipts, but
their effects are not redispatched.
The browser can revoke a specific device; revocation invalidates its generation and denies new
work. Local `disable` independently stops owned SDK/VM processes and preserves data, including when
credentials cannot be read. Neither closing an MCP client nor losing the connection deletes a codespace.

Broker shutdown fences new admission and waits for owned HTTP/CONNECT tasks, accepted socket
closure and connection-capacity reservation/release. A CONNECT reservation finishing after
shutdown is released without destination lookup or connection, so closed service ownership does
not leave an upstream connection running after shutdown.

The host CLI supports `create OWNER/REPO --ref BRANCH`, `workspaces`, `observe WORKSPACE_REF`,
`start WORKSPACE_REF`, `resume-setup WORKSPACE_REF`, `stop WORKSPACE_REF`,
`remove WORKSPACE_REF --confirm` and `collect OPERATION_REF` through the running private controller.
Copy references from its output unchanged. `operations CONTROLLER_REF` discovers original work,
with optional `--kind`, `--query` and `--cursor` filters. Ordinary lifecycle calls mint their own
identity and return the original operation reference; caller `--request-id` is reserved for explicit
maintenance. A stale workspace observation is refused rather than silently refreshed.
Discovery returns only safe intent metadata and operation references; use `collect` for the full
original outcome. `collect MAINTENANCE_OR_SECURITY_REQUEST_ID` separately accepts the privileged
identifiers printed by maintenance or reported in `status.credentialRequests`. It reads the original
maintenance receipt or observes the original issuer request, including existing recovered-child
cleanup. It never submits maintenance, issues another credential or collects raw lifecycle IDs;
an unknown privileged ID is locally absent without requiring pairing.
Fresh create requires live cloud route registration and initial Git authority. Already admitted
VMs can start, stop or be cleaned up offline under applicable current owner authority.
Starting requires enabled work permission; owner-confirmed cleanup does not enable it.
Raw host execution is unsupported; commands/files use the guest `moira-workspace` CLI.
`status` and `recover SPACE_ID --confirm` retain their custody/recovery roles. Native observation
release is distinct from physical settlement: helper EOF, failed partial capture or a client exit
does not signal previously observed peers. Explicit stop still targets their original kernel-held
identity and waits for positive settlement. A missing listener or exited observer is not stop proof.

After host-owner termination, the same login registration restarts its selected immutable release.
Recovery retains the same state, SDK profile, known VM identities/disks and intended-running records;
it observes surviving workers or starts a verified stopped known VM, without replaying commands.
After a Mac reboot, startup requires user login, the original bounded storage and actual runtime and
credential availability. Guest boot/process identity can change; pre-reboot commands are not replayed.
Kernel boot identity prevents an old-boot PID from being mistaken for a current owner, but grants no
custody by itself. The runner gate and exact profile/owner checks still exclude a competing owner.
Unverifiable ownership remains refused; do not unlink locks, clear journals or adopt a VM by name.
Explicit disabled-device recovery proves physical settlement without enabling work or replaying
unknown commands.

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
already running guard. An incompatible client reports `LOCAL_SERVICE_MAINTENANCE_REQUIRED`
instead of replacing that owner. Coordinate server/control-contract changes without claiming
uninterrupted management across incompatible editions.

Build a complete release and stage it without interrupting the running owner:

```bash
npm run local:build
npm run local -- install
npm run local -- service-status
```

The installer seals the complete executable closure under `STATE/service-releases/`, with its own
Node and assets. It publishes a staged selection, leaving the running release and egress services
unchanged. Only first registration selects an initial release. Do not edit sealed files, copy a
single JavaScript entry, or rewrite selection pointers by hand.

Updating the physical owner requires a separately approved interruption and coherent backup of
the complete private state, SDK storage/disks and matching bundles. Use the same `--state` throughout:

```bash
npm run local -- maintenance --confirm
# Keep the printed original requestId; collect after a lost reply:
npm run local -- collect ORIGINAL_REQUEST_ID
```

Maintenance records intended-running identities, fences admission and settles the exact old native
owner before selecting the staged release. The successor recovers each known VM independently;
inspect `recovery.restored` and `recovery.unavailable`, not just `phase: completed`. Disabled
work permission still refuses VM start. Interruption can change guest boot and interrupt
commands; original receipts remain collectable and are never replayed. Unconfirmed custody blocks
replacement. After an explicit local recovery, continue maintenance with its original `--request-id`
rather than creating another interruption. A missing legacy service registration or retained old
endpoint requires a controlled initial cutover with actual old-owner settlement; routine install
does not adopt a live legacy owner or promise hot custody handoff.

Commands requiring exclusive native setup/credential/recovery access can use
`maintenance --pause --confirm`, followed by the required operation and
`maintenance --resume --request-id ORIGINAL_REQUEST_ID --confirm`. Collect until the original pause
is actually `paused` before using the released runner gate. Preserve state, disk image, SDK profile,
credential store and connection; do not initialize replacement state or erase journals to bypass a
refusal. `login --new-store` and device recovery additionally require disabled work.

Persisted policy/control shapes must match their installed reader. An unsupported
shape is a refusal, not permission to clear journals or adopt replacement state.
The current private policy is version 2. Its guarded, one-way conversion from the recognized
version 1 policy requires the physical runner gate and exact previous-owner settlement. It preserves
disabled or expired permission as disabled, retains original receipts and publishes settings revision
and delegation with policy. An unresolved physical settings effect must settle before conversion.
Migration 0061 archives old cloud Local policy/control/relay/grant and operational records;
the archived rows are not dispatchable authority. The owner imports only verified existing
native bindings, preserving VM/profile/disk identity and unknown receipts. Do not reconstruct
cloud policy or clear unknown state to bypass a refusal. Rollback must retain matching bundles
and coherent state rather than resetting the SDK.

After pairing confirmation, approve web control on the local machine. If the persistent owner is
already running, first request `maintenance --pause --confirm` and collect its printed request ID
until the receipt is `paused`; `web-control` requires that released runner gate. Then run:

```bash
npm run local -- web-control --confirm
# When paused, resume using the SAME original maintenance request ID:
npm run local -- maintenance --resume --request-id ORIGINAL_REQUEST_ID --confirm
```

Use the same `--state` argument when configured. On first approval, omitted resource
ceilings use the current local policy.
Repeat `web-control --confirm` to revise an existing approval; omitted options then retain
the previously approved resource ceilings. The exact server, user,
device and connection must match. Applied and rejected revisions, delegation, repository
receipts and pending recovery records are preserved. Web or agent settings requests cannot
change these locally approved maxima. Applied resources must still fit them; a pending
request is retained and its ordinary application can reject values outside a revised maximum.

For example, to approve a shared storage maximum of 50 GiB, run:

```bash
npm run local -- web-control --confirm --storage-gib 50
```

Use the same `--state PATH` when configured and the pause/resume procedure above if an owner is
running. Closing its CLI does not release the runner gate; do not use `disable` to change only a maximum, because that also
changes work enablement and stops owned work. Refresh Local computers after the companion reports
the approval, then request Storage 50 in that computer's existing settings editor. Raising
the maximum alone neither resizes storage nor enables work. Physical resizing
happens only when the companion applies that settings revision through its existing
stopped-runtime path. Read the applied policy rather than treating a pending request as success.
Management reports remain available while work is disabled without authorizing guest work.
A lost approval-report reply is resolved by reporting the same saved approval again; do not
erase local approval or recovery records or enroll a replacement computer.

The Local computers editor controls persistent enablement, defaults, storage,
repository grants and permissions and optional Git author identity.
Saving creates a requested revision. Applied means the companion confirmed that
revision; pending or rejected settings are distinct from the applied device policy.
Browser settings admission checks the session and matching Origin before incremental JSON
parsing, then revalidates the session and unchanged account before owner submission. Variable
repository policy does not pass through the ordinary web API body ceiling. Native enrollment
and bootstrap use a separate bounded parser for their closed identity metadata.
Successful settings responses project the checked snapshot stored in that owner operation,
with current cloud device registration revalidated. Collection preserves the original outcome;
a typed device result is added only when that original snapshot matches the current contract.
A historical success can lack that projection. Refresh current owner state separately rather
than treating historical permission as current authority or resubmitting the settings effect.
Offline contact does not imply application: saving is refused and the editor retains its draft.
Reconnect and refresh before explicitly saving. The live controller can receive management
changes while work is disabled, without authorizing guest work. Offline revocation cannot promise
instant physical shutdown.

An admitted owner can confirm deletion of one owned local codespace in Settings while the
paired computer remains active and local web control is approved. This cleanup does not require
enabled agent work or the repository's agent `allowDelete` permission.
It authorizes only observation and deletion of that exact codespace at its current generation;
it does not enable work, change grants or permit creation, start or guest commands. The
companion must be running and reachable to complete the removal.

Settings that preserve enablement and shared storage capacity apply live: labels, repository rights,
Git identity, delegation and new-VM defaults do not stop unrelated VMs. Current grants still gate
affected access. A Git author change updates policy immediately; workspace preparation uses that
value to configure repository-local Git identity. Saving the setting does not force a rewrite in an already running checkout.
A delegated repository request can only append its separately authorized exact grant.
Changing enablement or shared storage uses the stopped-runtime transition. CLI and browser settings
share the owner settings gate; applied revision and delegation publish with policy. Interrupted
conversion or application preserves newer explicit decisions and original uncertain evidence.
CPU, RAM and Docker disk
defaults apply to new VMs; existing VMs restart with their admitted machine and
repository identity. The storage setting bounds the computer's SDK backing filesystem, while
Docker disk capacity belongs to each admitted VM. The default owned APFS image can grow or shrink while stopped
after checking the native APFS minimum and whether existing data fits, preserving data. Sparse
image creation and growth do not require the entire logical capacity plus a fixed host reserve
to be free in advance; actual filesystem failures still refuse the operation. Storage and Docker byte
values must be positive safe integers, storage must exceed Docker capacity, and native
sector alignment and usable filesystem capacity remain authoritative. Unknown physical changes retain their journal
and keep work fenced. Collecting the original settings receipt cannot enable work or
repeat a resize; an unrelated request cannot erase an uncertain resize.

### Delegated repository additions

After local web-control opt-in, the owner can enable agent repository management in the
Local computers editor. It is off by default and binds the connected, verified personal GitHub
account, separate permissions for existing and new private repositories and optional push.
There is no repository-count quota or technology-specific network profile.
Saving requests a revision; only confirmed owner application makes its delegation effective.
The MCP caller cannot enable that consent, change
its account or supply rights. New-private consent authorizes the
separate `repository_create` action; it does not authorize adding unrelated existing repositories.

`workspace_targets` returns selected controller and repository-target references, contact status,
and eligible personal GitHub App installation references.
A warning asks for missing GitHub setup while devices remain discoverable. Applied delegation
and detailed owner permissions are inspected in Settings, not returned in this compact discovery.
`repository_admit` takes that `controller` reference and the existing GitHub numeric `repository` ID.
Its adapter mints the internal admission identity. It verifies the current GitHub App installation grant, repository ID, owner,
private visibility and required read/push rights. It adds only a private repository owned by the
connected personal account. The retained admission records distinguish pending, applied and rejected
grants. MCP returns a usable target only after exact owner admission, together with its original
operation reference. Inspect that reference after uncertainty; do not submit the payload again.
An existing local grant is reused through discovery rather than added again. Requests
racing unapplied owner settings are refused.
Admission reuses its post-GitHub owner observation for the current decision and checks cloud
registration again. Completion requires the original owner result and its actually applied grant;
admission metadata alone cannot release a repository-creation reservation.

`repository_create` takes `controller`, the personal `installation` reference from discovery and
`name`. The name is 1–100 ASCII letters, digits, underscores, dots or
hyphens, excluding `.`/`..` and a `.git` suffix. The server creates only an empty private repository
in the connected user's personal account through fixed GitHub API endpoints; callers cannot select
another owner or visibility. Current applied new-private consent, enabled work permission and
device/account identity are checked before the durable submit fence permits an external create.

Inspect the returned operation with `operation_get`. After repairing a confirmed setup prerequisite,
`operation_resume` explicitly continues that retained private-repository creation; it reconstructs
the original input from its existing record rather than accepting another create payload.
It does not resume commands or repeat an unknown provider create. `pending`, `unknown`, `setup_required` and `rejected` are
not local authority. A confirmed `github_repository_id` and `full_name` may remain available while
installation setup is incomplete internally; MCP returns a usable `target` reference only after confirmed owner admission.
A selected installation receives only that confirmed new repository, then the refreshed actual App
grant is checked; a successful installation PUT alone does not grant access. Missing permissions
return Settings/install guidance and preserve the confirmed result for continuation.
In the owner admission API, `error.stage` names the failed setup step when present (`github_connection`, `device_delegation`,
`authority_validation`, `repository_lookup`, `repository_create`, `installation_access` or
`local_admission`); `error.provider_status` carries the GitHub HTTP status. Compact MCP errors carry
the safe cause and original operation reference for collection or explicit continuation. The returned
`instruction` describes the applicable repair. A returned rejected local admission preserves
the already-created repository identity. An unchanged rejected receipt remains rejected: restore
its original grant in Settings, or explicitly use `repository_admit` with the retained GitHub ID
if existing-private consent permits it. Do not submit another repository creation.

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
the child token in memory, checks its finite credential authority and disposes it after the upstream
transport physically closes. Its same-UID trust boundary is not an OS sandbox against
authorized project commands. Explicitly approved public read-only Local fetch can use
anonymous access; failed scoped issuance never enables that branch.

Each Local Git authorization phase returns one coherent owner observation: repository rights,
stable route generation, owner lifecycle generation and applied settings revision.
The issuer and author-identity resolver reuse that observation within the phase. They reauthorize
after asynchronous GitHub grant refresh and credential issuance; an earlier observation cannot
authorize use after those rights change.

Guest Git identity is repository-local: use owner-configured name/email or the
verified GitHub login and numeric-account noreply address. Host Git configuration
and secrets are not forwarded. An existing empty remote can open an unborn
requested branch: the agent creates files, commits and pushes the first branch,
then pushes a feature branch. A nonempty remote with an absent ref is refused.
The MCP `pull_request_create` and `pull_request_read` tools
use the owned codespace and approved repository. Only creation requires the
pull-request permission; reads and exact head/base lookup use read authority.
Creation returns an original operation reference. After uncertainty, use `operation_get` on that
reference, then `pull_request_read` with an exact head/base query before considering another create.
If the first reply was lost, use `operation_find` on the selected workspace and explicitly inspect
the matching candidate. Collection never creates a PR. Unknown creation retains its original PR
reference and any `security_operation` reference; the latter addresses credential issuance/disposal
separately from the PR effect. Reads take either a PR number or head/base query. There is no atomic
exactly-once guarantee across the owner and GitHub.

The installed CLI uses the same owner:

```bash
moira-workspace pr-create feature/change main "Describe the change" --body description.md
moira-workspace get "$OPERATION_REF"
moira-workspace find --kind pull-request --query "feature/change"
moira-workspace pr-get 7
moira-workspace pr-find feature/change main
```

Set `OPERATION_REF` to the reference returned by creation; discovery returns candidates when that
reply was lost. `--body` reads a file or `-` for stdin; `--draft` is optional. CLI errors preserve the owner result;
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
the bound authority after waiting. Revoked grants and disabled work remain refusals.
The guest loopback proxy authenticates CONNECT and absolute-HTTP requests to the host broker with
its installed per-space broker credential, so clients such as npm need not send a proxy-auth header.
A client-supplied proxy credential cannot select another space. Repository Git authorization remains
separate. The host still checks enabled permission, current grant, destination and public network address;
this credential is neither a GitHub token nor a forwarded host credential.
The fixed tunnel's five-second framing guard ends when its broker connection is established.
The broker's 15-second CONNECT guard ends after the connected peer passes address verification.
These guards do not impose an idle deadline on an established tunnel. Current permission, revocation,
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

Creation consumes a returned target that binds its repository, provider and selected registered
controller. Selection never substitutes a different owner. The actual route reports whether that
selected controller can receive the request; discovery availability is not dispatch authority.
The controller admits the original operation before invoking fixed provider
actions. It reads payer preflight and offered machines, chooses the machine and saves that choice
with the applicable idle and retention settings before create. Cloud rechecks account, App grant,
numeric repository, personal payer, settings and assignment at
those boundaries; parent authorization never leaves cloud. The controller receives narrowly scoped
provisioning authority, installs the packaged service and retains measured repository/root,
guest-life and release proof in its original journal. It configures and verifies the Unix owner
before requesting outbound enrollment. Caller commands, SSH configuration or bootstrap URLs cannot
select this work.

Start, stop and delete consume the observed workspace reference; adoption also selects its controller.
Their adapters retain the internal original identity and the generation captured in that reference.
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
that exact Codespace, but never repeats create, start or SSH. A found environment without retained
setup proof requires explicit adopt. A known environment with matching proof can instead continue
initial enrollment through explicit `resume_setup`. No match does not prove create was never dispatched.
An explicit delete can retire an exact known provider name after a currently authorized GET
confirms 404; ordinary list/get does not perform retirement.

Remote command/file calls require the already enrolled live guest. They never implicitly start a stopped
Codespace or bootstrap from cloud. Owner `running` and provider `available` alone are insufficient:
the router must have the current resource/authorization/life connection. Explicit registration
401/403 retires that remote authority; temporary transport or authority-store failure reconnects
observation without replay. Unix readiness for either provider does not wait for cloud registration.

For GitHub, verified local readiness and remote availability are separate observations. The guest
CLI can work while initial enrollment is unavailable; remote tools still require the live route.
After the initial operation and its scoped SSH custody settle, **Resume setup** or
`workspace_lifecycle({ workspace, action: "resume_setup" })` asks the selected controller to
continue that same known environment. It compares the original repository/root, guest life,
installed release and current assignment before fixed configuration, health checks and enrollment.
It does not install a payload, start the provider, adopt another environment or create a VM.
The original proof and create result remain unchanged. A changed life, generation or authority
refuses this continuation; ordinary collection never performs enrollment. A guest that has never
enrolled has no authority to enroll itself after a life change.

An enrolled GitHub guest with installed renewal authority can recover from a genuine cold life
change on its preserved root. It verifies the local binding and opens the Unix API first, while
withholding the previous life's remote authority. Its existing reconnect loop renews with one
durable original renewal request before opening CONTROL or DATA connections. Temporary network or
store failure leaves local work available and retries renewal; confirmed refusal closes remote
authority. Successful enrollment or renewal attaches to the same running Unix owner without
replaying commands. A cold restart itself can interrupt processes; it does not promise command
continuity across the restart.

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
repository permission and enabled-work requirements; a preflight refusal records no new delete intent.

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
that cause visible through both lifecycle settlement and read-only refresh. Ordinary start and
guest work remain refused. After repairing the reported prerequisite, use Local `resume_setup`
(host `resume-setup WORKSPACE_REF`) with the captured workspace observation to
continue preparation on that same known runtime and disk. The original create result remains
unchanged. Custody acknowledgement with `recover` is a separate operation.

Repository preparation records an owned unpublished stage and publishes it exclusively: even an
existing empty destination is preserved. A proved published root resumes without repeating
checkout or overwriting its branch or user files. Git's effective worktree, Git directory, common
directory and ordinary local configuration must remain within the proved repository. Unproved
or redirected roots are preserved for inspection. Local exclusive publication requires Python3,
libc `renameat2` and filesystem no-replace support; unsupported prerequisites have no unsafe fallback.
The optional `setup_failure` gives a closed remedy: `repository_unproven` requires local inspection
of preserved contents; `prerequisite_unavailable` requires the publication prerequisites;
`repository_checkout_failed` requires repairing repository access or the requested ref;
`configuration_failed` requires inspecting fixed guest-configuration diagnostics before resuming.
Unknown creation remains original-operation collection, not setup permission or name-based adoption.
For a known VM whose initial preparation has `LOCAL_GUEST_SETTLEMENT_UNKNOWN`, explicit custody
acknowledgement first proves exact physical stop. It preserves the unknown operation and leaves
preparation incomplete; only a subsequent `resume_setup` continues that same VM. Acknowledgement
alone never marks it usable.

A working local Unix API is ready before optional workspace-credential acquisition, not just before
CONTROL connects. Warm preparation uses configured or exact repository/runtime-cached Git author
data; public checkout does not wait for optional remote author lookup. Initial private checkout
still requires genuine current authorization. Cloud credential acquisition runs outside local
lifecycle and work lanes, so validation, stop and observation release do not wait for that response.
Before applying it, the owner rechecks the original runtime, repository, generation, grant and
connection; a stale response cannot configure another admission.
Optional observed `remote.state`
reports `unconfigured`, `enrollment_unavailable`, `connecting`, `connected`, `unavailable` or `refused`;
an absent field means no observation. Unavailable enrollment can be retried by the host under current
authority; an existing unavailable connection reconnects without reissuing credentials or replaying
work. Confirmed refusal retires its remote authority, without declaring the VM unusable or stopping
locally authorized work. Later enrollment reloads the same Unix owner's current configuration;
accepted commands and their original results are retained.

Local status inspection is scoped to the retained resource and its exact owned creation marker.
It can recover the owned durable manifest after the create reply expires, without adopting an
unrelated SDK VM. Only settled authenticated absence proves removal; failed or partial inventory
is not an empty successful list. Read-only inspection uses stable owned identity and current native
state without synchronizing lifecycle counters or authorizing guest work. Each failing resource retains its diagnostic and verified state,
while healthy peers refresh and run; the aggregate refresh reports stale data when any observation
could not be confirmed.

Local original receipts live in the controller journal. Internal `pending_request_ids` are projected
as `pending_operations` references for browser collection after a page reload;
confirmed terminal receipts retire those pointers; retained uncertain errors remain collectable.
Collection and read-only snapshots do not repeat an
effect or advance a lifecycle generation. Ordinary work retains current
account/device/connection/repository and enabled-permission checks. Owner cleanup instead requires the current
admitted account, active device, exact connection/resource binding and web-control approval,
without expanding repository grants or enabling work.
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

Each new ordinary call is a fresh intent. Its adapter mints an internal identity once, and the owner
durably binds immutable input before effects. Copy the returned operation/process references for
collection and output. After reply loss discover original candidates rather than resubmitting the
command. Safe discovery labels contain executable basenames, explicit session names, paths or PR
head/base, without command arguments, scripts, input, messages or source URLs. Candidate discovery
returns metadata, not full outcomes; collect a chosen reference explicitly to inspect its result.
Repeated identical new calls remain distinct intents; there is no hidden MCP invocation identity or durable CLI retry
guarantee. Observer/service reconnect never authorizes launch replay.

The owner admission record binds the original request to its operation. Collection
reads the authoritative result for that operation: command execution uses the engine's
physical launch/result evidence, while communication uses its original delivery receipt.
Neither an observer failure nor collection creates a second logical outcome.

Exec accepts argv or a script. An explicitly named session preserves working directory
and exported variables; opening/ending is explicit. Session context publication serializes
within that session, while distinct sessions/stateless commands remain independent.
An unnamed script uses a temporary session that closes after the command.
`stdin_text` is inline text; `stdin_file` streams native attachment input before launch.
Native descriptor identity and byte validation are shared with upload and communication;
the transient signed URL is not part of durable input identity. Repository authority is
checked before source acquisition. Preparation can finish before the final locked
session/repository gate rejects execution, so prepared input does not prove a command
started. Collect the original no-start or uncertain outcome without fetching or launching again.

The semantic projection reports `pending`, `completed`, `unconfirmed` or `absent`.
Completed results contain `outcome: {ok,result/error}`; uncertainty retains the original observation.
The engine separately retains actual running, terminal, proved `not_started` and unknown evidence.
Credential custody/disposal and vendor uncertainty stay unconfirmed in discovery and exact collection;
confirmed non-start refusals remain completed refusals. Missing witnesses cannot manufacture
terminal success/failure/cancellation. Addressed cancellation requires actual execution
evidence to settle. Observer disconnect does not cancel detached work. Output stays in
the workspace. Ordinary text output uses returned process references and UTF-8 continuation cursors;
private byte-range endpoints retain binary access.

Only explicit `timeout_seconds` imposes an execution deadline. Observation windows
and transport authentication checks do not stop commands. Moira imposes no aggregate
command/session/stdin/output or implicit runtime ceiling. Caller output windows bound
one response, not retained output. Actual disk/process failures, scoped authority and
provider lifecycle still apply: GitHub may stop silent work; Local requires current owner grants
and enabled work permission.

The adapter opens outbound authenticated CONTROL carrying bounded call identities and
per-call DATA carrying raw HTTP. Native backpressure bounds stream buffers. Offline
work is not durably queued in the cloud. Before-dispatch loss is a known refusal;
after-dispatch loss can be unknown. Reconnection collects existing work, never replays it.

## File operations and native transfer

Stat/search/read/write/patch share that confined owner. Repository binding, safe paths,
no-follow descriptors, link/inode identity and current preconditions remain enforced.
File sizes/range positions must be safely representable. Workspace files and native
binary streams have no artificial Moira size ceiling.

`file_stat` returns metadata and an observed file reference. `file_read` returns text selected by
line/window or an original file cursor, together with that same descriptor's content version and
identity. File and command/output windows contain complete UTF-8 characters. An undersized window
returns `minimum_bytes`; a live incomplete output suffix returns `pending_utf8` without advancing
its cursor. A file changed since the cursor observation conflicts rather than refreshing it.
Binary files use native download/publication; private binary reads retain streaming byte ranges.
Search accepts caller-selected
`max_matches`/`max_bytes` response windows rather than an execution quota.

`file_create` requires an absent destination. `file_replace` requires full expected text or an
observed file reference. `file_patch` matches old/new text against one immutable original per file:
ambiguous default matches and overlapping replacements refuse; `occurrence: "all"` is explicit.
Expected file references fence both content and inode identity. Native upload selects either a
new path or replacement of an observed file. Internal writes stage bytes before guarded publication.
Mutation journals retain original
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

`file_preview` reads a complete owner file and validates PNG/JPEG container framing and
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

`communication_deliver_publication` delivers a returned `publication` reference with `kind`
(`image` or `document`), optional `message` and configured `channel`. `communication_deliver` accepts
a native `file` and optional selected `owner` controller reference; otherwise it uses the sole
active registered controller under the existing authority rules. Multiple registered controllers
require an explicit selection, even if only one is reachable. Both return an original operation
reference. `operation_get` collects that same receipt; collection never downloads again or resends.
An unavailable route refuses the current dispatch, with no cloud queue or fallback to another source
owner. It does not prove that a previous submission never ran. `communication_send` sends ordinary
text independently of a file owner.

Preparation supplies channel authority, declared text/image/document capabilities, allowed
operation IDs and actual provider constraints. The owner validates the complete selected delivery
plan before any vendor stage. An explicitly unsupported channel or no eligible implicit channel
refuses delivery. The owner chooses caption and follow-up text stages without truncating content.
Extension handlers receive declared nonsecret settings; secrets and settings used for recipients
or endpoint addresses remain at the trusted transport. The cloud broker checks current authority,
fixed destinations, secrets and HTTP framing without downloading the source or choosing the plan.

## MCP tools

Strict purpose-specific tools expose workspace discovery/lifecycle, commands, files, processes,
repositories and communication. `command_run` and `command_run_native` return process/operation
references; `process_output`, `process_stop` and `operation_get` consume them. `operation_find`
lists retained safe intent metadata without returning full candidate outcomes, collecting candidates
or issuing another effect. Exact collection uses the same uncertainty classification across the
guest, host CLI and cloud adapters; a prior pending-control refusal remains a completed refusal.

The typed registry owns fields, defaults, native metadata and examples; use the
[public tool reference](../packages/docs/src/content/docs/docs/reference/tools.mdx).
`files_setup`, `transfer_status` and scoped file-capability CLI are not actions.
The installed `moira-workspace` CLI uses the same local owner independently of cloud
connectivity for `exec`, `get`, `find`, `output`, `stop`, `session-close`, `stat`, `read`, `search`,
`create`, `replace`, `patch`, `upload`, `native-upload`, `download`, `preview`, PR and delivery commands.
Run `moira-workspace --help` for their concrete arguments. The CLI implicitly selects its configured
Unix owner and uses the same semantic contract as MCP. It prints returned references and accepts
no ordinary raw control JSON or caller request IDs. Pass signed native descriptors to
`native-upload`, `exec --native-stdin` or `deliver --native` on stdin. Local upload and raw command
stdin use the existing framed byte stream. Download derives the path basename and MIME type when
omitted, falling back to `application/octet-stream`. Put descriptor URLs on stdin, never argv.
Known auth/provider/pre-dispatch failures remain bounded refusals. Unknown dispatched
outcomes require collection of the original identity, not a fresh ID to bypass uncertainty.

## Website management

Settings → Development separates environment management, GitHub connection and Local computers.
The common management card retains provider/resource identity, captured workspace references,
pending original operation references and nullable machine observation. Local cards group by stable computer UUID rather
than label. A neutral controller can provision GitHub without fabricated Local VM settings.

GitHub create selects an approved repository/ref and an active registered controller. Several
registered controllers require a choice, irrespective of their observed availability; without one,
creation is unavailable before admission. Explicit
adopt accepts a provider name or managed workspace reference and preserves its disk. Lifecycle
actions retain the selected observation without refreshing its precondition. Delete confirmation
keeps that same decision through background refresh; a different observation requires a new
confirmation. **Check state again** collects retained originals or refreshes when none is pending;
newer metadata alone cannot settle an uncertain effect. If a first reply was lost, the browser
offers original discovery on the selected controller and explicit candidate selection, including
when only one candidate is found. No match or an absent receipt leaves the action blocked.
Errors remain scoped to their resource. Local browser deletion additionally needs explicit
confirmation and current web-control approval, without broadening permanent agent permissions.

Connection, repository, resource and billing reads retain independent error/refresh states.
Management returns `providers`, minimal live `controllers` and `provider_billing`, with no Moira
aggregate limit view. `CodespaceBillingPanel` shows personal monthly compute, storage, allowances,
cost, payer and retrieval time, or unavailable. Missing `Plan: read` does not deny management.
Automatic pause selects provider timeout for new resources, without a cloud idle timer.

The website's `/api/integrations/github/codespaces` management projection adds returned
`workspace`, `controller` and `pending_operations` references instead of exposing raw lifecycle
generation and request IDs. Purpose calls use
`POST /api/integrations/github/codespaces/operations/:purpose` with the shared strict schema.
MCP uses those same semantic operations, including `operation_get` before a workspace ID is known.
The separate private settings/maintenance controller APIs retain their own original identities.
See [Codespace Management API](API.md#codespace-management-api) for wire fields.

Offline owners expose no cached policy/grants as current authority; settings drafts stay editable,
but saves are refused. Existing admitted VM work can continue under its current local grants and
enabled permission. Fresh create needs cloud registration and initial Git authority; confirmed authority refusal
does not allow offline fallback. Local diagnostic recovery is defined by
`packages/shared/src/codespaces/local-failure-guidance.ts` and the
[owner recovery guide](../packages/mcp-server/src/help/content/integration/troubleshooting.md#local-codespaces).

## Readiness and trust

`CodespaceObservabilityService.readiness()` reports configuration only: `disabled`,
`misconfigured` or `ready`, with `configuration`, `resources_enabled`, `reason` and `checked_at`.
It performs no connector probe, SSH check, reconciliation or cached lifecycle observation.
Ready configuration does not prove a controller/guest online; Local policy/device/grant
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

Fixed provider brokerage keeps these permissions tied to actions: preflight, machine offers and
inspection are reads; create/delete use Codespaces write; start/stop use lifecycle admin write.
The controller's provisioning child has only its declared Codespaces read and lifecycle-admin
authority for trusted SSH, not the parent create/delete capability. Parent credentials stay in
the server vault. Configured permission declarations and controlled fixtures do not establish
that a live GitHub grant or scoped token is accepted; check actual provider refusal guidance.

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
Provider constraints, actual storage, current owner authority and actual credential expiry remain applicable.

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
Settings page, the website codespace list and `workspace_targets` show a new
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
npm run workspace:verify:guest
docker compose config --quiet --no-env-resolution --no-path-resolution --no-interpolate
```

`tests/COVERAGE-MAP.md` maps the focused connection, resource, workspace-service/router,
migration, provider/controller, packaged-service, MCP tool, website management
and configuration-readiness suites, including the ChatGPT-compatible client
scenario over real services, the HTTP contracts against the local container
(`npm run test:mcp-tools`, `npm run test:api`) and the Settings browser scenarios
(`npm run test:e2e`). Deterministic tests and container fixtures do not establish live GitHub or ChatGPT
compatibility, genuine native attachment transfer or physical SDK isolation. Packaged Linux
verification exercises Unix readiness before enrollment and cold-life renewal using disposable
persistent guest storage; it does not provision a real GitHub Codespace. Live provider acceptance
requires separately authorized external verification.
