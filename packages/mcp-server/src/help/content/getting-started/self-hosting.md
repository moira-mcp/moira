---
title: Self-Hosting
description: Run your own Moira instance with Docker Compose using the prebuilt image
---

Run Moira on your own machine with Docker Compose. The default path pulls a prebuilt
image from the registry — no source checkout or local build needed.

## Prerequisites

- Docker with the Compose plugin (`docker compose`)
- The public `docker-compose.yml`, `.env.example` and `config/traefik-self-host.yml`; no source build, private repository,
  host SQLite CLI, or separate upgrade script is required for the normal path

## Quick Start

Download the current public self-host files:

```bash
MOIRA_FILES=https://raw.githubusercontent.com/moira-mcp/moira/master
curl -fLO "$MOIRA_FILES/docker-compose.yml"
curl -fLo .env.example "$MOIRA_FILES/.env.example"
mkdir -p config
curl -fLo config/traefik-self-host.yml "$MOIRA_FILES/config/traefik-self-host.yml"
```

1.  **Create your config**

    ```bash
    cp .env.example .env
    ```

    For a `localhost` run, the defaults work unchanged.

2.  **Start the services**

    ```bash
    docker compose up -d
    ```

    Compose starts the application and its static Traefik ingress on the same public port.
    The ingress needs no Docker socket. Keep its configuration beside the Compose file.

3.  **Open the Web UI**

    ```
    http://localhost:8080
    ```

    Your instance also serves this documentation at `http://localhost:8080/docs/`
    (and `/ru/docs/`), and the MCP endpoint at `http://localhost:8080/mcp`.

On first start, Moira generates the missing secrets and a one-time admin password.

## Configuration

`DEPLOYMENT_MODE=self-host` (the default) runs a private-team install with open
registration and administrator approval. A newly registered account can inspect its
approval status and sign out, but cannot use workflows, API tokens, OAuth, or MCP until
an administrator approves it. Email verification is a separate gate and is not required
in self-host mode. Missing secrets are generated on first start.

The self-host administrator keeps the **Users** page for approval, blocking, and account
recovery. Its rows also show recorded activity, the last accepted step when recorded, run count
and most-used flows. These management facts are independent of analytics periods and exclusions;
absence of an activity or step record is shown as unknown. Cross-user workflow/execution/artifact
administration, cloud analytics, the operational
dashboard, and deliberate monitoring-test tools are disabled by the server and omitted from the
navigation. These are deployment capabilities, not security controls implemented only in the UI.
The SaaS policy enables them through the same resolver used by the API and the Web UI.
The self-host dashboard still shows database health, setting-definition status, and managed-workflow
reconciliation, but it neither requests nor renders installation-wide workflow or execution totals.

### Approve new accounts

In the Web UI, sign in as an administrator, open **Admin Panel → Users**, and select an
account marked **Pending approval**. Choose **Approve account** and confirm the dialog.
The action shows progress while it is running and changes the account badge to **Approved**;
the registrant's waiting page detects that transition and opens Moira without another login.
On a narrow screen, open the Admin Panel navigation with the menu button first.

The equivalent API operation is `POST /api/admin/users/:id/approve`;
`GET /api/admin/users` lists the approval timestamp. Approval is idempotent, so retrying a
request after an uncertain response does not replace the first approval time or create a second
transition.
Existing users are marked approved during the database migration; the bootstrap administrator
is always created as approved. Blocking and email verification remain independent controls:
a blocked account is denied even when approved.

### Configure email or recover without it

Email delivery is disabled by default. To enable password-reset and verification messages,
configure a standard SMTP server in `.env` and restart the container:

```bash
EMAIL_PROVIDER=smtp
EMAIL_FROM=moira@example.com
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
```

SMTP authentication is optional, but `SMTP_USER` and `SMTP_PASSWORD` must be set together.
Use `SMTP_SECURE=true` for implicit TLS (commonly port 465); otherwise
`SMTP_REQUIRE_TLS=true` requires STARTTLS. Brevo remains available with
`EMAIL_PROVIDER=brevo`, `BREVO_API_KEY`, and `EMAIL_FROM`. Invalid partial configuration
stops startup. SaaS mode also refuses to start without a real provider.

With `EMAIL_PROVIDER=none` (the default), Moira starts normally and the Web UI explains that
forgot-password and email actions are unavailable. An administrator can instead open an
ordinary user's detail page, choose **Set temporary password**, and send that password through
a separate secure channel. This action revokes all of the user's sessions, API tokens, OAuth
credentials and consents. The user signs in with the temporary password and must immediately
replace it. Administrator accounts must use the command-line recovery procedure below.

`EMAIL_PROVIDER=test` is only a log sink for automated testing. It never means that delivery is
configured and never reports a logged message as sent.

### Recover administrator access

From the directory containing `docker-compose.yml`, supply a new password without putting it
in shell history:

```bash
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
docker compose exec -e ADMIN_PASSWORD moira npx tsx scripts/create-admin-user.ts
unset ADMIN_PASSWORD
```

`ADMIN_PASSWORD` is required. `ADMIN_EMAIL` and `ADMIN_ID` default to
`admin@moira.local` and `system-admin`; `DB_PATH` defaults to `./data/moira.db`. Add
`-e ADMIN_EMAIL`, `-e ADMIN_ID`, or `-e DB_PATH` to `docker compose exec` when overriding
them. The command creates or repairs the administrator, marks it verified and approved, clears any
account block, and replaces its credential. It never prints the password.

### Roll back to a version without account approval

An older image ignores `approvedAt`. Before pinning such an image, stop external traffic,
back up the database, and run the conversion on the current image:

```bash
docker compose exec moira npm run prepare:account-approval-downgrade -- \
  --confirm-block-pending-users
```

The command refuses to run without the confirmation argument. It blocks every pending user
with the legacy `blocked` control and revokes that user's sessions, API tokens, OAuth tokens,
and OAuth consents in one transaction. Verify the printed counts before stopping the current
container. Do not roll back first, because the old image cannot make this conversion. If you
later restore the approval-aware version, review each converted account before approving and
explicitly unblocking it.

### Host-dependent variables

These three must point at your host and keep their ports consistent. The shipped
defaults target `localhost:8080`, so a localhost run needs no edits.

| Variable                  | Default                 | Purpose                              |
| ------------------------- | ----------------------- | ------------------------------------ |
| `MOIRA_HOST`              | `localhost:8080`        | Public host (protocol auto-detected) |
| `MOIRA_PORT`              | `8080`                  | Host port mapped to the container    |
| `STATIC_ARTIFACTS_DOMAIN` | `static.localhost:8080` | Domain for served HTML artifacts     |

For a real host or a different port, edit all three together:

```bash
MOIRA_HOST=moira.example.com
MOIRA_PORT=8080
STATIC_ARTIFACTS_DOMAIN=static.example.com
```

> **caution:** `STATIC_ARTIFACTS_DOMAIN` is required — startup aborts if it is empty.

### Behind a reverse proxy

Moira keys rate limits, the `RATE_LIMIT_WHITELIST` exemption, audit records and session addresses on
the client address. It takes that address from `X-Forwarded-For` only through the proxies named in
`TRUST_PROXY`; entries a client writes itself are never used.

- The supplied Compose sets `TRUST_PROXY=2`: ordinary requests pass through Traefik and nginx;
  workspace streams pass directly through Traefik to the backend. Traefik discards untrusted
  client-supplied forwarding headers.
- With an additional reverse proxy, configure that proxy to replace untrusted forwarding headers
  and explicitly set the trusted addresses/subnets for the complete topology. Workspace and
  ordinary routes have different hop counts, so do not add a blanket hop count without checking both.

If that external proxy supplies client addresses, add
`--entrypoints.web.forwardedheaders.trustedips=<its IP or CIDR>` to the supplied ingress command;
trust only that proxy's actual source addresses. Do not enable insecure forwarded-header trust.

```bash
TRUST_PROXY=loopback,172.18.0.0/16       # example: trust only your actual proxy network and nginx
```

Without it, every client behind your proxy shares the proxy's address and one rate-limit budget.
`TRUST_PROXY=true` is refused, and an invalid value stops startup with an error that lists the
accepted forms.

The public `/api/workspaces/` path requires HTTP/1.1 Upgrade forwarded directly to the application
backend on port 3001. The supplied ingress provides this route and leaves established streams
without an idle or transfer-duration deadline. Keep TLS and the same application origin at an
external ingress. A generic route through nginx 80, or the standalone application container's
frontend port alone, is not the supported workspace stream path. The application's global proxy
default remains `loopback`; the supplied Compose overrides it for its own topology.

### Auto-generated secrets

In self-host mode these are generated on first start and persisted to
`<data-dir>/.secrets.env`. Leave them empty in `.env`:

| Variable                  | Generated value                          |
| ------------------------- | ---------------------------------------- |
| `BETTER_AUTH_SECRET`      | Session encryption key                   |
| `TELEGRAM_ENCRYPTION_KEY` | Telegram credential encryption key       |
| `ADMIN_PASSWORD`          | Admin password, printed to the logs once |

The admin login is shown once in the container logs on first start:

```bash
docker compose logs | grep -A3 "ADMIN LOGIN"
```

Sign in with `ADMIN_EMAIL` (default `admin@moira.local`) and the printed password.

### Connect local codespaces

**Settings → Development → Local computers** connects a computer running Moira Local to this
account. Local and GitHub environments share strict purpose-specific command, file, process
and lifecycle tools with returned references. Enrollment,
public repository reads and basic local work do not require the GitHub App or server credential
vault. Enrolled private-repository access, push and PR operations require the server's GitHub App
OAuth connection and vault configuration. Local work requires the owner's current computer grants
and enabled work permission until explicit disable, without cloud operational controls or an aggregate resource quota.
The GitHub `CODESPACE_CODESPACES_ENABLED` switch does not gate Local.

The companion makes outbound HTTPS requests and exposes no public listening port.

Enrollment and `run` require neither `init`, a Local SDK nor a disk image. For GitHub and
communication files, run the browser-provided `enroll` command, confirm the device, then
`npm run local -- install` and `npm run local -- run`. Installation stages a complete immutable
release and registers login startup on macOS; `run` starts or connects to the persistent host owner
and returns. Closing that client does not stop VMs. Configure physical Local capability separately.

Use Node.js 24 and macOS on Apple silicon with the pinned Docker Sandboxes `sbx` 0.46.0
signed bundle from [Docker's release artifacts](https://github.com/docker/sandboxes/releases/tag/v0.46.0).
See [Docker's installation requirements](https://docs.docker.com/ai/sandboxes/install/).
Physical Local VM execution on Linux is refused. Build the private companion package from a Moira source checkout
with the controller platform's C compiler available;
there is no published global npm installer:

```bash
npm ci
npm run local:build
npm run local -- init --sbx /absolute/path/to/Sbx.app/Contents/MacOS/sbx --label My-computer
npm run local -- login
npm run local -- setup
npm run local -- approve OWNER/REPO
npm run local -- enable
npm run local -- doctor
```

`init` creates private state and a bounded disk image, with work disabled. The image uses a short
device-owned mount path for the SDK sockets. `--state PATH` chooses another state directory;
repeat it on every command. `--storage-gib`, `--cpus` and `--memory-gib`
choose local resource allocations at initialization. `setup` requires an empty dedicated SDK profile.
`doctor` checks prerequisites under enabled work permission; its
`liveVmIsolationVerified: false` is not a live microVM isolation result.

The companion keeps Docker sign-in in a separate encrypted SDK store and does not alter personal
Docker or Keychain selection. If the host owner is running, use the explicit maintenance pause
described below before local login, setup or credential recovery. Credential-store replacement
additionally requires disabled work and `npm run local -- login --new-store`. This explicit action checks owned
shutdown, creates a separate store and preserves existing credentials. It never automatically
rotates a failed store or imports personal credentials.
This machine-only store trusts the host account: its generated password is kept in an owner-only
local file, and sleep/interval auto-lock is disabled only for that SDK store, not personal Keychain.
The macOS login service runs in its own non-GUI security session. A failed unlock remains a
credential refusal; the service does not reset the store or repeatedly start browser sign-in.

Repository permissions are granted on the computer. `approve OWNER/REPO` allows read access.
Add `--private`, `--push` or `--delete` only for those rights.
Manual repository tokens are not accepted. Paired private access and push use the approved
GitHub App grant through the trusted owner's scoped credential broker, with no host-token fallback.
`enable` permits work until you explicitly run `disable`. There is no work-duration or renewal
parameter. The browser can change these settings only after you explicitly approve web
control on this computer, as described below.

In **Local computers**, choose **Connect a computer**. Copy the displayed command and pairing token
separately. From the source checkout, run the command as
`npm run local -- enroll --server <displayed HTTPS application URL> --pairing-id <displayed ID>`.
Enter the token on stdin and end input; never append it to the command. The server URL includes
the app prefix when configured and contains no credentials, query or fragment.
Refresh the browser, verify the pending computer's identity, then confirm. Current rights
are read from the reachable Local controller after connection.

The server and owner require matching control contracts. `service-status` reports the running
release separately from a staged update. Ordinary installation retains the active owner, its
broker/tunnel and running VMs; an incompatible client reports a maintenance requirement.
To replace the physical owner, back up the server database, complete private Local state and SDK
backing storage, including VM disks, and retain the matching executable bundles. Build and stage:

```bash
npm run local:build
npm run local -- install
npm run local -- service-status
npm run local -- maintenance --confirm
```

Maintenance prints its original request ID before submission. Use `collect ORIGINAL_REQUEST_ID`
after a lost reply; do not create another maintenance request. Replacement waits for exact physical
settlement, preserves VM identities/disks and intended running state, then recovers the same known
environments without replaying commands. This operation interrupts work and reports unavailable
environments separately. Unconfirmed settlement blocks replacement. Rebuilding a checkout or
staging a package alone does not replace the running owner.

Direct local administration that needs the owner gate uses an explicit pause. Collect the printed
request until its phase is `paused`, perform the intended local action, then resume that same ID:

```bash
npm run local -- maintenance --pause --confirm
npm run local -- collect ORIGINAL_REQUEST_ID
# Perform the intended local login, setup or approval action only after phase paused.
npm run local -- maintenance --resume --request-id ORIGINAL_REQUEST_ID --confirm
```

Repeat `--state PATH` throughout when configured. Pausing interrupts physical work while retaining
the original intent; it does not reset credentials or authorize a second owner. Preserve original
receipts and repair an unconfirmed pause before resuming. A host reboot also interrupts execution;
login startup recovers saved known VM intent when runtime and credentials are available, without
replaying commands. It does not run before login or promise uninterrupted guest processes.

Migration 0061 preserves old cloud Local policy/control, relay, grants and operational rows in
immutable archives; those rows are not current authority or queued work. The owner imports only
verified existing native bindings and preserves unknown outcomes. Unsupported private owner state
remains a refusal: retain the backup, identity, journals and disks rather than editing cloud policy
to bypass it. Rollback restores paired snapshots and matching bundles; it does not reset the SDK
or require replacement enrollment.

The server retains only Local resource/repository/connection identity, the approved device/profile
binding and confirmed retirement evidence. Machine, current state and lifecycle generation come
from the live owner. Migration 0064 preserves complete resource and binding rows in immutable
archives separately from migration 0061, while retaining public IDs, revocation values and existing
guest credentials. It does not recreate VMs or disks. Device revocation does not prove disk removal;
account deletion remains pending for unresolved or unretired Local resources. Restore the coherent
pre-migration database and matching owner backup for rollback; do not rebuild work from archives.

After pairing is confirmed, approve local web control:

```bash
npm run local -- web-control --confirm
```

Use the same `--state PATH` as setup. On first approval, unspecified resource ceilings use the
current local values. Repeat `web-control --confirm`
on this computer to revise its approval; unspecified options then retain the previously approved
ceilings. Supply a changed maximum with `--cpus`, `--memory-gib`, `--storage-gib` or `--docker-gib`.
The server, account, computer and connection must remain the same. Existing permissions and
application/recovery state are preserved; browser or agent requests cannot raise these maxima.
Approval alone neither enables work nor changes the actual disk size.

For example, to permit a shared storage size of 50 GiB while the owner is running, pause through
the maintenance procedure above and wait for `paused`. Then run:

```bash
npm run local -- web-control --confirm --storage-gib 50
npm run local -- maintenance --resume --request-id ORIGINAL_REQUEST_ID --confirm
```

Repeat the same `--state PATH` on both commands when configured. Do not use `disable` just to
revise a maximum: that also disables and stops owned work. Refresh **Local computers**,
set Storage to 50 in that computer's existing editor and choose **Request settings change**.
The companion applies the requested size through the existing stopped-runtime resize path.
Wait for the applied revision and actual size; a pending request is not a completed resize.
Local confirmation preserves the existing disk and codespaces; it does not create replacement VMs.
If the owner has not been installed or started, start or connect after local approval:

```bash
npm run local -- run
```

In **Local computers**, edit the device name, enabled state, CPU/RAM, bounded disk and
guest Docker capacity, repository permissions and commit author. Enabled permission remains
effective until you explicitly disable it.
Commands and file streams have no Moira concurrency, byte, output-retention or runtime quotas.
An explicitly requested command deadline and real machine/storage capacity still apply.
**Request settings change** sends a caller-identified request to the live owner, not effective
permission. Offline saves are refused and the draft remains in the editor; reconnect and refresh
before explicitly saving. Applied and rejected revisions identify what the owner accepted. Read the
effective permissions above the editor before starting work. Errors preserve the draft; updates
adopt untouched fields without replacing independent edits. The control connection can receive
settings while work is disabled, but guest work remains off until enablement is applied.
Changes to labels, grants, Git identity, delegation and new-VM defaults apply live when enablement
and shared storage are unchanged; they do not stop unrelated VMs. Settings from the CLI and browser
share the same guarded revision. Git author changes update policy; workspace preparation applies
that value to repository-local Git config. Saving the setting does not rewrite an already running checkout.
After a lost reply, collect the original settings request rather
than submitting it again. Historical outcomes stay original; refresh current permissions separately.
CPU/RAM and guest Docker defaults apply to new environments; existing VMs retain their admitted
profile. The storage capacity is the computer's shared SDK backing image, not a separate allocation
of that size to every codespace. Bounded disk changes require stopped owned work and verified resizing; a refused change
does not authorize further work or erase data.
For private repositories, push and PR creation through Moira, connect GitHub and grant the App
access to the repository. Those operations also require the device's matching repository rights;
reading PR metadata uses repository read access. Original OAuth/refresh authorization remains
server-side; the trusted broker receives only its derived scoped child. Supply a commit author or leave both author fields empty to use your verified GitHub
identity when available; the computer's Git configuration is not copied.

With local web control approved, the owner can enable repository-management delegation here.
It defaults off and binds the verified personal GitHub account, separate existing/new-private
permissions and optional push. `workspace_targets({ provider: "local-sandboxes" })` returns approved
Local repository targets and observed controller contact status without GitHub installation reads.
Use `workspace_targets({ provider: "github-codespaces" })` for GitHub targets, registered controllers
and eligible personal App installations. A GitHub setup warning does not erase registered choices;
registration does not certify reachability. Availability is decided by actual dispatch, without fallback.

Use `repository_admit({ controller, repository })` with a returned controller and the GitHub
repository ID. Only confirmed owner application grants access. For a new empty private repository,
use `repository_create({ controller, installation, name })` with returned references. Agents
cannot change consent or supply rights. Current grants and existing VMs are preserved.

Keep the returned original operation. `operation_get({ reference })` only collects it.
If installation access or permissions need repair, explicitly continue that original private
creation with `operation_resume({ reference })`; it reconstructs the original request from its
retained record and never creates a replacement repository. Unknown creation uses its retained
recovery marker, never an unrelated same-name repository. Missing results and uncertain replies
do not authorize replay. A rejected admission may leave the confirmed repository on GitHub:
restore its grant in Settings, or explicitly request existing-private admission when consent permits.
Safe error guidance names the failing setup stage and reported provider status when available.

The owner must approve **Repository creation: write** or **Administration: write** for the
[create API](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user),
and **GitHub App installation repository access: write** for a
[selected installation](https://docs.github.com/en/rest/apps/installations#add-a-repository-to-an-app-installation).
Approved push still needs Contents write. Use **Update GitHub permissions** after approval;
Original OAuth and refresh credentials stay on the server. The trusted owner broker receives
only a derived credential scoped to the approved repository and action. It executes Git/PR
HTTPS directly and disposes the child after the upstream connection closes; cloud Moira does
not proxy Git bytes or execute PR requests. Tokens are not project files, arguments, environment
values or tool results. Same-UID broker trust is not an OS sandbox.

Use ordinary `git fetch`/`git push`. `pull_request_create` takes meaningful head/base/title
fields and returns an original operation reference. Collect it with `operation_get` after an
uncertain reply, then use `pull_request_read` for the same head/base before deliberately creating
another PR. The guest CLI equivalents are `pr-create HEAD BASE TITLE`, `get OPERATION_REF`,
`pr-find HEAD BASE` and `pr-get NUMBER`. Credential custody/disposal uncertainty remains
unconfirmed; preserve the original operation and follow its separate security-collection guidance
rather than requesting another token. Collection does not cancel a live stream.

Each codespace has its own VM; a repository can have multiple codespaces.
Local VMs and operations do not consume cloud Codespaces slots or use its machine ceiling.
The same guest workspace service owns commands, files, sessions and retained output in both providers.
Use `command_run` with argv or script, or `command_run_native` with required native stdin.
Copy returned operation/process references; use `operation_get`, `process_output` and
`process_stop` without resubmitting command fields. A lost first reply needs explicit
`operation_find` and candidate selection. Identical deliberate calls are distinct intents;
absence or unavailability is not proof of non-execution.

The guest retains results and complete output on its disk. Cloud Moira routes live authorized
requests without an offline queue or separate result store. Observation loss does not cancel
commands; provider stop can interrupt them. Explicit `timeout_seconds` and observation windows
remain, alongside physical storage and repository/owner guards. Cancellation is not confirmed
until its physical result is known. File changes use existing confined atomic transactions.

`file_read` reads complete UTF-8 characters by lines or cursor and returns a whole-file reference.
`file_create` requires an absent target; `file_replace` checks complete text or a file reference;
`file_patch` matches old/new text without caller-computed hashes or byte edits.
`file_upload` streams a required native descriptor to an explicit create path or checked replacement.
`file_download` publishes the complete path without a separate stat; name and MIME are derived
when omitted. Its immutable publication supports repeated reads until expiry under current authority.
`communication_deliver_publication` separately sends that publication, optionally to one
configured `channel`; delivery does not consume or renew it. `communication_deliver` accepts
a native descriptor directly at the selected paired controller. Both return an original operation
for `operation_get`; collection never sends again. Workflow attachment notifications also return
their original `operation`; internal execution/visit identities are not required for collection.
Discovery exposes safe metadata and returned references, not full results. Explicit collection
preserves uncertain outcomes as `unconfirmed`, including a terminal private receipt with an
uncertain error; a confirmed refusal remains completed with `outcome.ok:false`.

The fixed provider bootstrap installs the service and `~/.local/bin/moira-workspace` CLI in place,
including on an existing Codespace, without recreating its disk. The CLI talks to the same private
Unix socket as the service; it works inside an authorized running workspace even when the cloud
connection is unavailable. It supplies its own verified Node.js 24.21.0 and ripgrep 15.2.0, independent
of the project's Node version or PATH. Project runtimes remain the project's responsibility.

```bash
~/.local/bin/moira-workspace --help
~/.local/bin/moira-workspace exec -- pwd
~/.local/bin/moira-workspace stat package.json
~/.local/bin/moira-workspace search . TODO
~/.local/bin/moira-workspace get "$OPERATION_REF"
~/.local/bin/moira-workspace output "$PROCESS_REF" --stream stdout
```

The CLI returns the same semantic operation, process and checked-file references as remote work.
Each deliberate mutation is a new intent; `get` collects and `find` discovers retained originals.
Do not choose request IDs or replay after a lost reply. CLI create/replace/patch use absent-target,
complete-text or checked-file preconditions. Native descriptors are read from stdin.
The public image is `ghcr.io/moira-mcp/moira-workspace-service`; the optional Feature is
`ghcr.io/moira-mcp/features/workspace-service`. Choose a published release tag. Both use the
same payload and support glibc x64/arm64 and a repository owned by the service user, including
explicit root configuration. A project keeps its own runtime; fixed bootstrap updates an existing
environment without requiring a Dev Container rebuild.

To add the Feature to a project's `.devcontainer/devcontainer.json`, merge this entry into
its existing `features` object and replace `RELEASE_TAG` with an available published tag:

```json
{
  "features": {
    "ghcr.io/moira-mcp/features/workspace-service:RELEASE_TAG": {}
  }
}
```

Alternatively select `ghcr.io/moira-mcp/moira-workspace-service:RELEASE_TAG` as the Dev Container
image and set `overrideCommand: true` so the container can start before paired bootstrap prepares
the service. These assets install the runtime; they do not grant cloud or repository authority.

Public package registries and public DNS destinations use approved brokered egress. There is no
socket-count or transfer-duration quota; streaming backpressure, public-address checks, current
permission and revocation remain. Host/LAN/service destinations stay denied. Browser compatibility
requires the project's guest packages. `file_preview` reads a current repository PNG/JPEG and
checks its container before returning native image content; inspect it before treating it as
visual evidence. Optional `max_bytes` sets the caller's whole-image bound. There is no generic byte,
edge or pixel-count ceiling. PNG/JPEG validation checks structure, not decoded pixels.
`file_download` publishes the complete original file.
See [the tools reference](/docs/reference/tools/#development-codespaces).

In **Settings → Development → Local computers**, open a computer's codespaces and choose an
approved repository. `workspace_targets({ provider: "local-sandboxes" })` returns its target references;
computers offering the same repository remain distinct. `workspace_list({ provider: "local-sandboxes" })`
and `workspace_observe` return
workspace references for explicit lifecycle decisions. Browser revocation denies new server work
but cannot prove physical shutdown of an offline computer; local disable enforces shutdown.

Lifecycle tools consume returned workspace references, not caller-supplied generations or IDs.
A conflict requires a fresh observation and a deliberate new decision. An operation response
returns its original handle for `operation_get`, including when creation is still unresolved.
When the first reply was lost, `operation_find` at the selected controller finds candidates;
select explicitly, even when there is one. No match does not prove no effect.
Known `pending_operations` restore collection after reload; a newer snapshot alone does not
settle an uncertain mutation.

If registration exists without an owner resource observation, discovery retains an observe-only
identity and reports unavailability instead of inventing a machine, state or generation.
Pending creation preserves its original operation for collection. A handler receipt containing
typed uncertainty is still unconfirmed; repetition cannot turn it into a second VM.
Generic operation payloads describe their own kind, not necessarily a workspace. Successful
workspace observations can have `machine: null`, including a confirmed-deleted result.

Each computer card contains its own creation form, codespaces and collapsed settings. Computers
with the same name remain distinct, and one repository can have several separate VMs. Shared
computer storage is shown at the computer level; CPU and RAM belong to each VM. GitHub Codespaces
has a separate subsection. Refresh and action errors stay with the affected section or codespace.
Local cards show the last verified observation, or that none exists, and a localized lifecycle
refusal. **Check state again** collects the original lifecycle receipt when its identity is
known; otherwise it performs a read-only refresh. It never resubmits start, stop or delete.
New explicit actions use the returned workspace observation unchanged.
`created` does not certify shutdown: the native
owner must confirm exact runtime and worker settlement. An unavailable observation preserves the
last verified state and never becomes a successful stop.

**Delete** remains available for pending creation, cleanup and uncertain local state, with explicit
confirmation and the captured workspace reference. It targets the same owned VM and waits for confirmed
removal; a failed observation cannot remove the card as if the VM were absent. A failed card does
not prevent healthy sibling codespaces from refreshing or running.

Owner deletion requires an active paired computer with local web-control approval and a running,
reachable companion. It remains available when agent deletion permission is denied or work is
disabled. Confirmation authorizes only exact observation and removal; it does not
change repository grants or enable work. MCP deletion still requires the agent's
deletion grant and enabled work permission.

A refused deletion shows its error in the dialog and ends the spinner. **Cancel** stays available
while a separate explicit read closes that decision and obtains a new observation for another confirmation. An operation's
403 refusal preserves the browser session; account admission or expired-session errors retain
their sign-in handling.

Physical VM startup is distinct from guest readiness: commands become available only after guest
preparation completes. For Local, `CODESPACE_LOCAL_SETUP_INCOMPLETE` means that preparation failed, even if
the VM is confirmed stopped. Repair the reported prerequisite, then choose **Resume setup** or
`workspace_lifecycle({ workspace, action: "resume_setup" })` with its returned workspace
reference. This continues the same proved VM/disk and preserves files
and the original create result. Ordinary start and custody `recover` do not resume setup.
Unknown creation remains collection of its original operation, not permission to adopt or replace a VM.
The optional `setup_failure` distinguishes a preserved unproved repository (`repository_unproven`,
inspect locally), missing Python3/libc/filesystem exclusive-publication support
(`prerequisite_unavailable`), repository access/ref repair (`repository_checkout_failed`) and
fixed guest-configuration diagnostics (`configuration_failed`). Proved published repositories keep
their branch and user changes; redirected Git metadata or an unproved existing root is preserved
and refused rather than overwritten.

The working guest Unix API is ready before optional workspace credentials or cloud registration.
Waiting for that cloud response does not block local validation or stop, and a changed runtime,
generation or authority prevents applying a stale reply. Warm preparation uses configured or exact
retained Git author data; public checkout does not wait for optional author lookup. Initial private
checkout still needs current authorization. Optional observed
`remote.state` distinguishes `unconfigured`, `enrollment_unavailable`, `connecting`, `connected`,
`unavailable` and `refused`; an absent observation stays unknown. Temporary enrollment failure
does not prevent locally authorized work. Existing remote transport reconnects without command
replay; confirmed refusal retires that remote authority. Later enrollment reloads the same Unix
owner without restarting accepted commands. Remote MCP work still needs current authority and a live route.

Install matching server and companion builds. Their strict snapshot and management-result contract
includes exact creation identity, guest readiness and native stop confirmation. Records remain
unobserved until a verified read. Follow the explicit maintenance and backup procedure above;
rollback restores the matching server database, complete local state, SDK storage and bundles
together. Preserve unsupported private owner state for diagnosis; old cloud state stays archival.
Updating the server or rebuilding the CLI does not replace an already running daemon's journal and
installed executable release. Fixed guest bootstrap refreshes the common service in place.
A receipt without start proof leaves that start
unconfirmed. Inspect the original operation instead of
restarting the companion to recover a lost reply. Client exit and observer disconnect do not
authorize physical VM stop; explicit stop, disable and physical maintenance retain that boundary.

The host CLI supports `create OWNER/REPO --ref BRANCH`, `start WORKSPACE_REF`,
`resume-setup WORKSPACE_REF`, `stop WORKSPACE_REF`, `remove WORKSPACE_REF --confirm`,
`observe WORKSPACE_REF`, `collect OPERATION_REF` and
`operations CONTROLLER_REF` through the running private controller.
Mutations preserve the captured workspace reference; human maintenance retains its separate
explicit request-ID contract. Fresh create needs cloud route registration and initial Git authority.
`collect ORIGINAL_REQUEST_ID` also reads retained privileged maintenance or security custody;
it does not submit lifecycle work or issue a replacement credential. Controller discovery
returns safe metadata; use explicit collection for full original outcomes.
Already admitted VMs can start, stop or be cleaned up offline under applicable current owner
authority. Starting needs enabled permission; owner-confirmed cleanup does not enable it.
Raw host execution is unsupported; ordinary commands/files use the guest CLI or MCP.
`recover` remains a separate custody acknowledgement.
After a crash or computer reboot, login registration starts the selected release; `run` with the
same state directory also starts or connects to it. Startup automatically
reclaims a stale runner marker only under the system lock and after proving both previous host
owners absent. Saved policy, VM records and unknown operations are retained without replay.
Live, unknown or malformed ownership stays refused; do not delete its marker manually.
If `service-status` reports a retained startup failure, repeating `run` only reads that service's
status. After repairing the prerequisite, use the explicit maintenance recovery procedure in
[Troubleshooting](/docs/integration/troubleshooting/#local-codespaces), preserving any original
maintenance identity; a client connection does not retry owner initialization.
On macOS, startup also remounts the existing default disk image from that same state directory
when needed. It verifies the native image/mount binding and the volume's ownership and approved
capacity before work, without a fixed free-space reserve; a lost attach reply is checked against the observed binding. Custom
storage mounts must be mounted manually. Missing images or conflicting bindings remain refused;
startup does not create a replacement disk or reset its data.
Sparse image growth does not require full logical preallocation or an extra host reserve.
Shrinking still requires the native APFS minimum and enough capacity for existing data;
uncertain physical changes retain their original resize journal.
Work and `doctor` enforce current authority from SDK startup onward. Installation, bootstrap and
guest registration wait for actual completion; explicit disable and addressed
cancellation retain their physical effect. Parent/observer loss releases observation without
manufacturing stop intent. Fixed metadata checks and the bounded `doctor` diagnostic are observations,
not proof that a pending operation has settled.
The local daemon separates server contact from VM lifetime. Network/5xx failures reconnect;
remote owner state is unavailable until connection succeeds, without stopping already-admitted
work. Remote mutations are refused rather than queued. An addressed resource refusal stays with
that request. Confirmed remote device revocation/identity failure fences the remote route;
local disable remains physical policy. Existing grants remain enforced; cached results do not repeat effects.
Closing the `run` client leaves the persistent owner running; `npm run local -- disable` stops owned work independently
and keeps VM data. Stop keeps files, while `remove WORKSPACE_REF --confirm` deletes the exact owned VM.
An uncertain command or edit is retained by its own operation identity and is not retried
automatically. It does not block independent work. Inspect the saved result before repeating the
same edit or modifying affected files; a failed delivery is not proof that an edit was not applied. Ordinary
stop/start requires no manual synchronization. If runtime ownership itself needs recovery, first
confirm that the VM is physically stopped, then use `recover SPACE_ID --confirm` with the same
state directory. It checks exact identity and network policy without replaying jobs; retained jobs
and unknown outcomes remain unchanged. If the acknowledged unknown occurred during initial
preparation, the VM remains setup-incomplete. Repair its prerequisite and explicitly use
`resume-setup WORKSPACE_REF` on that same VM; acknowledgement alone does not complete setup or enable
ordinary start.
For an orphan device
shutdown, `recover --confirm` requires disabled work, proves physical stop and retains jobs/data.
See [Troubleshooting](/docs/integration/troubleshooting/#local-codespaces) for refusal recovery.

Local VMs have no host mounts, shared skills, host MCP gateway or forwarded host credentials,
environment or agent sockets. External SDK policy denies host/LAN/VPN/metadata/other-VM access and
direct egress; only locally approved brokered public egress is admitted. Public SDK API/GitHub
credential placeholders in guest variables are not user tokens. Root-guest controlled checks
observe host canaries and reachable loopback/LAN/VPN-interface challenge delivery; a proxy connection
alone is not delivery. They do not establish remote VPN, metadata-service or other-VM physical
isolation without reachable controlled targets. Those external probes remain unexecuted on the
validation host. Codespace content is intentionally visible to Moira; review returned code before
running it on the computer.

### Enable the GitHub codespace connection

The GitHub codespace connection is separate from GitHub social login. It stays disabled unless
all GitHub App and credential-vault values are present and valid. Create a GitHub App with expiring
user authorization tokens and "Request user authorization (OAuth) during installation" enabled,
grant it the repository permissions Codespaces (write), Codespaces lifecycle admin (write),
Codespaces metadata (read), Contents (write), Pull requests (write) and Metadata (read), then configure its callback URL
to the exact Moira API path and its installation URL to the app's GitHub slug. No Setup URL is
needed: GitHub returns the browser to the callback URL after an installation:

```bash
CODESPACE_GITHUB_APP_CLIENT_ID=<github-app-client-id>
CODESPACE_GITHUB_APP_CLIENT_SECRET=<github-app-client-secret>
CODESPACE_GITHUB_APP_CALLBACK_URL=https://moira.example.com/api/integrations/github/callback
CODESPACE_GITHUB_APP_INSTALL_URL=https://github.com/apps/<github-app-slug>/installations/new
CODESPACE_CREDENTIAL_VAULT_KEY=<64-hex-random-key>
CODESPACE_CREDENTIAL_VAULT_KEY_VERSION=v1
```

Generate the dedicated vault key outside the repository and put its output in the untracked
deployment environment:

```bash
openssl rand -hex 32
docker compose up -d
```

The callback origin must equal the public Moira origin. A public callback uses HTTPS and has no
query or fragment. Use the client secret generated by GitHub; placeholder, repeated-character and
other low-diversity values are rejected. The vault key is not auto-generated and must remain stable
across container restarts; changing it makes existing connection credentials unreadable.

If a key or ciphertext is lost, ordinary Reconnect and Disconnect cannot prove remote revocation.
First remove the Moira GitHub App grant in GitHub settings. Then return to **Settings → Development → GitHub connection**
and choose **Forget after external revoke** in the GitHub card. The confirmation deletes
unreadable local ciphertext; do not confirm while GitHub still lists the grant.
If the original key and version are restored, Moira no longer offers this unreadable-credential
recovery. Ordinary **Reconnect GitHub** and **Disconnect** are available again; both revoke the
readable predecessor credential exactly.

The same external-revoke confirmation appears if a refresh may have returned a new credential that
Moira could neither retain nor revoke. Revoke the entire GitHub App grant before confirming; this
state deliberately disables Reconnect and ordinary Disconnect.

After the container is healthy, each user opens **Settings → Development → GitHub connection**, selects
**Connect GitHub** and authorizes once on GitHub. If the app is not installed on the account yet,
the browser continues straight to GitHub's installation page; after the user installs it for the
intended personal repositories, Settings shows the connection as connected without a second
authorization. If that return does not arrive, **Check installation** reads the installation again.
To switch GitHub accounts, disconnect and connect again. Authorization never happens through an MCP
tool or agent. When setup is
missing or a credential must be renewed, the user returns to this website.

GitHub Codespaces requires `CODESPACE_CODESPACES_ENABLED=true`, current App grants and an
active registered paired controller. Choose a returned controller reference if more than one controller is registered,
even when only one is reachable. Selection does not probe each controller; the normal route
reports whether the chosen owner can receive the request and never switches to another owner.
The controller owns original-operation journals and fixed provisioning through its packaged gh,
trusted SSH and verified Linux payload; cloud Moira retains minimal resource/account authority
and fixed provider API calls. No cloud connector Compose service is required.
The selected controller reads personal-payer preflight and offered machines, then saves its
machine choice and applicable idle/retention settings before the fixed create request. The cloud
rechecks current authority and settings; it does not choose a different machine or controller.

Use `workspace_list({ provider: "github-codespaces" })`,
`workspace_targets({ provider: "github-codespaces" })` and `workspace_setup_help` for discovery.
Lists default to `view: "actionable"`, including known incomplete setup. Select
`view: "diagnostics"` for uncertain or unavailable identities and their original-operation
references, or `view: "history"` for confirmed retirement. These views are also available in
Settings. Diagnostic identities have no lifecycle generation; collect their original operations
or request an observation instead of inventing mutation authority. Provider failures stay explicit.
Local discovery does not await GitHub or billing. Billing loads separately when the GitHub
settings subsection is active; Environment Refresh does not read it.
Create with a returned target; start/stop/delete use the captured workspace reference.
`workspace_adopt` uses an observed workspace and explicitly selected controller;
`workspace_adopt_external` uses the selected controller and known owned provider name.
Both preserve the disk. Explicit adoption of a stopped environment can start it.
Pending/unconfirmed preparation is not usable readiness: collect its original operation without
creating, starting or installing again. `GITHUB_PROVISIONING_INCOMPLETE` remains actionable.

The GitHub guest starts its verified local Unix API before optional cloud enrollment. If first
enrollment is unavailable, local CLI work remains available, while remote MCP work does not.
Once the original operation and SSH custody have settled, choose **Resume setup** or call
`workspace_lifecycle({ workspace, action: "resume_setup" })` with the returned observation.
The selected controller checks the saved original repository/root, guest life, installed release
and current assignment, then continues fixed configuration and enrollment on that same environment.
It does not reinstall, start the provider, adopt or create another VM. A changed life or authority
refuses continuation. `operation_get` only collects; it never performs this setup step.

After a cold restart, an already enrolled GitHub guest with retained renewal authority makes its
Unix API ready before remote renewal. Temporary network/store failures retry in the existing
reconnect loop without using the previous life's remote credential or replaying work. Confirmed
refusal closes remote authority. Later enrollment or renewal keeps the same live Unix owner and
accepted commands; the cold restart itself can interrupt processes. A never-enrolled guest cannot
replace its original proof after a life change. Preserve the environment and use explicit owner
inspection through the assigned controller before choosing another lifecycle action.

Only an authenticated enrolled guest admits remote command/file work. Ordinary routing does not
start a VM or open SSH. Unix readiness alone does not prove remote registration. Confirmed 401/403
refusal retires that credential; ordinary network loss reconnects. Collect with `operation_get`,
read retained output with `process_output`, and cancel with `process_stop`.
Cloud/client loss does not itself cancel an owned command.

An agent working in a codespace acts as the ordinary Codespace user: it can read the repository,
use the network and read any secrets configured for that Codespace. Moira's isolation protects the
Moira server and other users, not the codespace from the agent its owner authorized. When setup is
incomplete, actionable refusals carry the same applicable Settings, repository-creation and
provider-console links as `setup_help`, plus App installation when its URL is configured, instead of
starting any authorization flow. A codespace is
personal rather than shared; collaboration happens through version-control branches.

Users manage the same codespaces from the **Development environments** card in **Settings →
Development → GitHub Codespaces**: create one for an approved repository, start or stop it (stop keeps the repository
data) and delete it after an explicit confirmation. GitHub owns idle activity detection:
the **Automatic pause** card in the same section sets `codespaces.auto_stop_enabled` (on by default)
and `codespaces.idle_timeout_minutes` (30 by default, 5 to 240) are sent when a new Codespace is
created. Turning the preference off requests GitHub's maximum 240 minutes, not unlimited runtime.
Existing Codespaces retain their provider settings. GitHub observes editor, browser and terminal
input/output; a silent command can be interrupted by its idle shutdown. Local follows its computer
owner's current permission and policy. Current resources and GitHub billing are shown separately; billing
unavailability does not revoke workspace access. Admin Settings → Codespaces is a read-only
configuration view with refresh, not a lifecycle kill-switch panel.

Health reports configuration readiness `disabled`, `misconfigured` or `ready`; `ready` does not
prove that a particular controller or guest is connected. Resource get/list and original-operation
collection report current owner observations separately. Restore the assigned owner rather than
starting an ordinary file call to repair provisioning.

Disconnect disables local use before GitHub revocation. If GitHub is temporarily unavailable, the
page shows a revocation-pending state and **Disconnect** retries the exact encrypted capability;
the credential is not returned to the browser or model.

## Connect an MCP Client

The MCP endpoint is your host plus `/mcp`:

```
http://localhost:8080/mcp
```

Add it as an MCP server in your AI client and complete OAuth authentication. See
[Quick Start](/docs/getting-started/quickstart/) for client configuration.

## Updating and Recovery

The ordinary update path does not require a version lookup or a repository-side helper:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

If an existing `.env` came from the older broken template and still contains the removed `0.3.5`
tag, change it once before updating:

```bash
MOIRA_IMAGE=ghcr.io/moira-mcp/moira:latest
```

Before the new self-host image runs migrations against an existing database, its startup guard uses
SQLite online backup and verifies `PRAGMA integrity_check`. It stores the database and matching
`prompt-manifest.json` under `data/.moira-startup-backups/current/`, rotating the prior states to
`previous-1/` and `previous-2/`. A genuine first start has no database to back up.

The current slot carries a persistent initialization-pending marker. If the container or host is killed
before initialization commits, the next start restores that verified slot before creating a new
backup, so a partially migrated database cannot become the next baseline.
On the first start, a marker without a fake database backup records that no database existed. An
interrupted retry removes only the incomplete new database, WAL/SHM, and prompt manifest before
starting clean; successful initialization removes the marker.

If schema, prompt, or workflow initialization fails after writing data, the guard removes WAL/SHM,
restores the verified database and prompt manifest, writes `/tmp/init-failed`, and keeps MCP, the API,
and nginx stopped. The recovery copy remains available. Inspect and retry after correcting the
configuration or catalog:

```bash
docker compose logs moira
docker compose exec -T moira sqlite3 /app/data/moira.db 'PRAGMA integrity_check;'
docker compose exec -T moira sqlite3 /app/data/.moira-startup-backups/current/moira.db 'PRAGMA integrity_check;'
docker compose restart moira
docker compose ps
```

`latest` intentionally follows the current public release. Automatic recovery protects persistent
data; it cannot replace the Docker image itself. If the image cannot reach the startup guard, the
database has not been migrated. Temporarily set `MOIRA_IMAGE` to a previous version from
[GitHub Releases](https://github.com/moira-mcp/moira/releases), run `docker compose up -d`, and return
to `latest` after a corrected release.

An upgrade that changes a bundled workflow can leave a run that was paused inside it unable to
continue. Startup names those runs before applying the update — the workflow, the execution and the
node each is paused on — so they appear in `docker compose logs moira` while the old definitions are
still in place. The warning never stops an upgrade. A run invalidated because its workflow changed
can be repaired afterwards with `session({ action: 'diagnose', ... })` followed by
`session({ action: 'recover', ... })`; a run whose workflow the upgrade removes cannot, since no
definition remains to resume against, and the line says which case it is. No warning means no paused
run would be affected.

When conflict detection has produced a local bundle under `data/.moira-reconciliation/pending`,
follow its `AGENT INSTRUCTIONS` with one-off Compose CLI containers. The CLI itself does not stop or
restart services and does not replace the database snapshot. It uses only local files—never
`--force`, MCP, an HTTP API, or UI transport. Initialization fails closed: after restoring the
database the container stops with MCP, API, and nginx unavailable. After bundle application, the
final `docker compose up -d` starts that stopped container normally.

```bash
docker compose run --rm moira npm run reconcile -- status
docker compose run --rm moira npm run reconcile -- diff --reference owner/slug
# Read previous.json, current.json, and incoming.json from the printed bundle paths.
# Record one revision-bound current, incoming, or merged decision for every conflict:
docker compose run --rm moira npm run reconcile -- choose \
  --reference owner/slug --selection incoming --revision REVISION \
  --rationale "Incoming supersedes the local experiment"
docker compose run --rm moira npm run reconcile -- apply
docker compose up -d
```

For a merge, use `incoming.json` as the base, reapply only local intent still justified by
`previous.json → current.json`, validate the complete merged state with `reconcile validate`, and
pass it to `choose --selection merged --file ...`. `choose` changes only the local decisions
manifest. `apply` refuses an incomplete or stale manifest and is the only command that changes the
database.

### Optional preflight before downtime

Operators who want to test an exact image on an isolated database copy before replacing the active
container may download the advanced helper from that release. This is optional; normal updates use
the two Compose commands above. The host `sqlite3` CLI is required only for this advanced path.

```bash
RELEASE_VERSION=x.y.z
TARGET_IMAGE=ghcr.io/moira-mcp/moira:${RELEASE_VERSION}
curl -fLo self-host-upgrade.sh "https://raw.githubusercontent.com/moira-mcp/moira/v${RELEASE_VERSION}/scripts/self-host-upgrade.sh"
chmod +x self-host-upgrade.sh
./self-host-upgrade.sh preflight "$TARGET_IMAGE"
./self-host-upgrade.sh upgrade "$TARGET_IMAGE"
```

The helper retains its verified snapshot and diagnostic copy under `.moira-upgrade/`; use
`./self-host-upgrade.sh rollback` if its replacement or health check fails. Because this advanced
path writes the exact image to `.env`, set `MOIRA_IMAGE=ghcr.io/moira-mcp/moira:latest` afterward if
you want to rejoin the normal release channel.

## File owners and notification images

Run a paired controller for native attachment capture and workflow progress rendering.
Owning these communication files requires neither a Local VM nor enabled physical Local work.
Select a returned controller reference when several active controllers are registered, even if only one is
reachable. The selected identity stays fixed; an unavailable route does not authorize another
owner or prove that a previous submission never ran. Preserve the owner's private
immutable files and delivery journal when updating its matched executable release.
Workspace publications remain with their workspace owner.
Materialize archives use the paired controller's immutable publication and original receipt;
their separate `session materialize` text fallback requires no file owner.

Ordinary text, waiting reminders and trusted lock PIN delivery continue without a file owner.
Explicit file delivery reports an unavailable owner instead of downloading in the cloud.
Optional workflow progress images may be omitted while text still sends.
`COMMUNICATION_OWNER_UNAVAILABLE` on progress mint/read is HTTP 503: restore the paired connection.

The supplied ingress streams `/api/communication/` without request/response buffering,
temporary body files or a generic body-size ceiling. Preserve that configuration. Binary
requests carry framed metadata followed by opaque source bytes. Public owner-file links
are capabilities; do not log them. Installed binary extension artifacts are selected by
digest, and their channel secrets stay at the trusted cloud transport.

## Enable extensions

Extensions require a source checkout because the companion runner image is built locally. The
published Moira application image remains unchanged. From the repository root:

```bash
cp .env.example .env
mkdir -p extensions
cp -R examples/extensions/webhook-notify extensions/
```

Replace the placeholder `example.com` in both the copied manifest's top-level
`permissions.network` and its communication channel's `permissions.network` with the exact host
your endpoint uses. Node and channel permissions are separate. Set the endpoint, default
notification recipient, and other values for each user on Moira's Settings page. Then add the
runner address to `.env` and enable the profile:

```bash
printf '\nMOIRA_EXTENSION_RUNNER_URL=http://moira-extension-runner:9110\n' >> .env
docker compose --profile extensions up -d --build
```

The profile builds the runner, mounts `./extensions` read-only into that container, waits for runner
health, and then starts Moira. The runner is absent from an ordinary `docker compose up -d`.

Runner and Moira load the extension catalogue at startup. After changing installed bundles:

```bash
docker compose --profile extensions up -d --force-recreate --wait moira-extension-runner
docker compose --profile extensions restart moira
```

Inspect rejected bundles and the live catalogue without exposing the runner port:

```bash
docker compose --profile extensions logs moira-extension-runner
docker compose --profile extensions exec moira-extension-runner curl -fsS http://127.0.0.1:9110/health
```

An empty directory is valid. The health response lists loaded node types and communication channel
IDs. If Moira reports the registry unavailable, confirm the URL, runner health and logs, then
restart both services in the order above. If one contribution is missing, inspect the manifest
rejection reasons. See [Writing an Extension](/docs/guides/writing-extensions/) for the manifest,
SDK, permissions, settings, editor, delivery, failure and security contracts.

## Adding Your Own Workflow Flows

The image ships a bundled workflow catalog in `./workflows/production`. To ALSO load
your own flows, set `WORKFLOWS_DIRS` to a colon-separated list of catalog base
directories (each containing a `flows/<uuid>.json` layout):

```bash
WORKFLOWS_DIRS=./workflows/production:./my-private-workflows/production
```

The directories are merged and de-duplicated by `(owner, slug)`. A **later** directory
overrides an earlier one on a collision, so a directory listed last can extend or
shadow the bundled catalog. Unset → just the bundled `./workflows/production`. Mount
your extra directory into the container (e.g. via a compose volume) so the path exists
at runtime.

## Build From Source

Building locally is an alternative for contributors who need to modify the image.
In `docker-compose.yml`, comment out the `image:` line and uncomment the `build:`
block, then:

```bash
docker compose up -d --build
```

## Related

- [Quick Start](/docs/getting-started/quickstart/) - Connect an AI client
- [MCP Clients](/docs/integration/mcp-clients/) - Client integrations
