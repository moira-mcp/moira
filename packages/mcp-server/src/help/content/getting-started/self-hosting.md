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
account. Local and GitHub development environments share `codespace` for ordinary work and
`codespace_process` for background processes. Enrollment,
public repository reads and basic local work do not require the GitHub App or server credential
vault. Enrolled private-repository access, push and PR operations require the server's GitHub App
OAuth connection and vault configuration. Local work requires the owner's current computer grants
and finite lease, without cloud operational controls or an aggregate resource quota.
The GitHub `CODESPACE_CODESPACES_ENABLED` switch does not gate Local.

The companion makes outbound HTTPS requests and exposes no public listening port.

Enrollment and `run` require neither `init`, a Local SDK nor a disk image. For GitHub and
communication files, run the browser-provided `enroll` command, confirm the device, then
`npm run local -- run`. Configure physical Local capability separately.

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
npm run local -- enable --hours 8
npm run local -- doctor
```

`init` creates private state and a bounded disk image, with work disabled. The image uses a short
device-owned mount path for the SDK sockets. `--state PATH` chooses another state directory;
repeat it on every command. `--storage-gib`, `--cpus` and `--memory-gib`
choose local resource allocations at initialization. `setup` requires an empty dedicated SDK profile.
`doctor` checks prerequisites under an enabled, unexpired lease; its
`liveVmIsolationVerified: false` is not a live microVM isolation result.

The companion keeps Docker sign-in in a separate encrypted SDK store and does not alter personal
Docker or Keychain selection. For credential-store recovery, first disable local work and stop
the companion, then use `npm run local -- login --new-store`. This explicit action checks owned
shutdown, creates a separate store and preserves existing credentials. It never automatically
rotates a failed store or imports personal credentials.
This machine-only store trusts the host account: its generated password is kept in an owner-only
local file, and sleep/interval auto-lock is disabled only for that SDK store, not personal Keychain.

Repository permissions are granted on the computer. `approve OWNER/REPO` allows read access.
Add `--private`, `--push` or `--delete` only for those rights.
Manual repository tokens are not accepted. Paired private access and push use the approved
GitHub App grant through the trusted owner's scoped credential broker, with no host-token fallback.
The finite work lease defaults to 8 hours and cannot exceed seven days. Renew it locally with
`enable --hours N`. The browser can change these settings only after you explicitly approve web
control on this computer, as described below.

In **Local computers**, choose **Connect a computer**. Copy the displayed command and pairing token
separately. From the source checkout, run the command as
`npm run local -- enroll --server <displayed HTTPS application URL> --pairing-id <displayed ID>`.
Enter the token on stdin and end input; never append it to the command. The server URL includes
the app prefix when configured and contains no credentials, query or fragment.
Refresh the browser, verify the pending computer's identity, then confirm. Current rights
are read from the reachable Local controller after connection.

The server, companion and running owner guards need a matching control-contract edition.
Strict heartbeat/approval schemas refuse mixed editions even with delegation off; rebuilding the
CLI does not update a live guard. Before updating, use the companion's ordinary owner-managed
shutdown and confirm settlement of its owned work and guards. While both sides are stopped,
back up the server database, the complete private companion state and its SDK backing storage,
including VM disks. Keep the matching server and companion bundles with that backup. Build with
`npm ci` and `npm run local:build`, then install the complete executable release in an immutable
owner-only directory, which may be outside the source checkout. Point the host launcher at that
release's `cli.js`; copy the CLI, guard, runtime API, configuration bundle, native helpers and
workspace payload together. Rebuilding mutable checkout assets does not replace a running owner.
Restart with the same state,
disks, SDK profile, credentials and connection. Management and running jobs may be interrupted;
there is no uninterrupted mixed-edition rolling upgrade. Live repository append within the matched
edition separately preserves existing VMs.

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
npm run local -- web-control --confirm --max-lease-hours 168
```

Use the same `--state PATH` as setup. On first approval, unspecified resource ceilings use the
current local values and the lease ceiling defaults to seven days. Repeat `web-control --confirm`
on this computer to revise its approval; unspecified options then retain the previously approved
ceilings. Supply a changed maximum with `--cpus`, `--memory-gib`, `--storage-gib` or `--docker-gib`.
The server, account, computer and connection must remain the same. Existing permissions and
application/recovery state are preserved; browser or agent requests cannot raise these maxima.
Approval alone neither renews the work lease nor changes the actual disk size.

For example, to permit a shared storage size of 50 GiB, first stop the foreground companion with
Ctrl+C or its ordinary owner-managed shutdown so the local state lock is released. Then run:

```bash
npm run local -- web-control --confirm --storage-gib 50
npm run local -- run
```

Repeat the same `--state PATH` on both commands when configured. Do not use `disable` just to
revise a maximum: that also changes work enablement and its lease. Refresh **Local computers**,
set Storage to 50 in that computer's existing editor and choose **Request settings change**.
The companion applies the requested size through the existing stopped-runtime resize path.
Wait for the applied revision and actual size; a pending request is not a completed resize.
Local confirmation preserves the existing disk and codespaces; it does not create replacement VMs.
Start the foreground companion after confirmation and local approval:

```bash
npm run local -- run
```

In **Local computers**, edit the device name, enabled state, expiry, CPU/RAM, bounded disk and
guest Docker capacity, repository permissions and commit author. **Allow seven days** sets
a finite expiry within the locally approved ceiling; it does not renew automatically.
Commands and file streams have no Moira concurrency, byte, output-retention or runtime quotas.
An explicitly requested command deadline and real machine/storage capacity still apply.
**Request settings change** sends a caller-identified request to the live owner, not effective
permission. Offline saves are refused and the draft remains in the editor; reconnect and refresh
before explicitly saving. Applied and rejected revisions identify what the owner accepted. Read the
effective permissions above the editor before starting work. Errors preserve the draft; updates
adopt untouched fields without replacing independent edits. The control connection can receive a
renewal while work is disabled or expired, but guest work remains off until it applies.
CPU/RAM and guest Docker defaults apply to new environments; existing VMs retain their admitted
profile. The storage capacity is the computer's shared SDK backing image, not a separate allocation
of that size to every codespace. Bounded disk changes require stopped owned work and verified resizing; a refused change
does not authorize further work or erase data.
For private repositories, push and PR creation through Moira, connect GitHub and grant the App
access to the repository. Those operations also require the device's matching repository rights;
reading PR metadata uses repository read access. Original OAuth/refresh authorization remains
server-side; the trusted broker receives only its derived scoped child. Supply a commit author or leave both author fields empty to use your verified GitHub
identity when available; the computer's Git configuration is not copied.

With local web control approved, the owner can enable agent repository management here.
It defaults off and binds the verified personal GitHub account, separate existing/new-private permissions,
and optional push. Repository additions have no count quota or fixed technology profile.
Only confirmed owner application makes it effective. `codespace({ action: "local_devices" })`
shows owned computer IDs, labels, contact status and `owner_available`, plus eligible personal App
installations. A warning asks for GitHub setup while retaining device discovery; inspect applied
consent in Settings. `repository_add` takes `device_id`, the GitHub numeric `repository_id`
and a stable UUID `request_id`. MCP calls live owner admission and returns `repository_id`
only after access is applied. An unconfirmed or rejected request is not permission; resume its same
identity after the applicable repair. The App must already expose the repository. Agent additions
preserve existing grants, VMs and lease; agents cannot change consent or supply rights.
For a new empty private repository, enable and apply new-private consent, then use `repository_create`
with `device_id`, stable UUID `request_id`, `repository_name` and discovered `installation_id`.
Only the connected personal account is supported. Resume the same complete payload: `unknown`
does not retry creation blindly, and `setup_required` can retain the confirmed GitHub ID/name while
permissions or installation access are repaired. Only confirmed owner admission returns usable `repository_id`.
Selected installation access is checked after adding only the confirmed new repository.
The owner admission API retains `error.stage` for the failed setup step and `error.provider_status`
for the reported GitHub HTTP status when present. MCP errors carry safe repair guidance and the
original `request_id`. Follow that guidance. A rejected local admission can retain an
already-created repository: restore its original grant in Settings, or use `repository_add` with
the retained GitHub ID and a fresh `request_id` when existing-private consent permits it. Repeating
the rejected admission alone does not restore access; do not create another repository.
Unknown requests retain their exact recovery identity without preventing other repository additions.
The private repository description contains a recovery marker, not a credential. Keep it while
an unknown outcome is unresolved; Moira never adopts an unrelated same-name repository.

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

Use ordinary `git fetch`/`git push`. For PR creation choose an original ws1 request ID;
the guest CLI accepts `moira-workspace pull-request-create --request-id ID pr.json`, with
`head`, `base`, `title` and optional `body`/`draft` in the file. Run the same command without
`pr.json` to collect that create, then `moira-workspace pull-request-find HEAD BASE` after an
uncertain outcome. `pull-request-get NUMBER` reads a PR. Collection never creates another PR.
Unknown creation returns an error preserving its original PR ID and any separate
`security_request_id`. Credential custody/disposal uncertainty requires exact security collection,
not another Git/PR attempt: host `moira-local status --json` lists those receipts and
`moira-local collect ORIGINAL_SECURITY_REQUEST_ID` reads the original request without minting.
Inspection does not cancel a live stream; confirmed absence does not automatically reissue a token.

Each codespace has its own VM; a repository can have multiple codespaces.
Local VMs and operations do not consume cloud Codespaces slots or use its machine ceiling.
The same guest workspace service owns commands, files, sessions and retained output in both
providers. Choose a fresh `ws1-<lowercase UUID>` `request_id` before a command, write, patch or
upload. Plain UUIDs belong to repository admission and cannot be used as active workspace identities.
Ordinary exec observes the command for a short window; an unfinished result can be collected with
only `codespace_id` and its original `request_id`. Background start returns that same identity as
`process_id`; use process get/read/stop to inspect output or request cancellation. A lost reply
does not prove that work did not start. Inspection never resubmits the effect, and pending cancellation
does not prove physical termination. Keep the original identity and inspect the result and affected
files before intentionally repeating an uncertain mutation.

The guest retains results and complete stdout/stderr on its own disk. The cloud routes live
authorized requests; it does not queue commands or keep a separate command-result copy. A lost
cloud connection leaves guest commands running; stopping the provider can interrupt them. Saved
terminal results remain inspectable while the workspace data exists and current authority permits
access. Commands and reads are independent; file commit/recovery uses a transaction lock and
expected-content checks. `timeout_seconds` stops a command only when explicitly requested.

`upload` streams a native attachment into its guarded target using its workspace `request_id`.
`download` reads the current `path` and publishes an immutable owned resource link and
`file.reference_id`. Repeated reads are allowed until expiry under current authority; editing
the source does not change that published version. There is no workspace byte quota;
optional `max_bytes` bounds the caller's download or preview request.
`communication({ action: "deliver-file", request_id, referenceId, message })` separately delivers
that source, optionally to one configured `channelId`. Choose a fresh `ws1-<lowercase UUID>`
before submission. Delivery neither consumes the publication nor renews it and accepts no
guest-selected recipient. Retain the original ID and returned owner identity to collect an
uncertain result with `communication({ action: "operation", request_id, device_id })`, or
`codespace_id` instead of `device_id` for a workspace owner. Collection never resends.

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
```

For retries, pass the original `--request-id ws1-<lowercase UUID>`; `status`, `cancel` and `output`
address that identity. File `read`, `write`, `upload`, `download` and `patch` use the same repository
guards. The public image is `ghcr.io/moira-mcp/moira-workspace-service`; the optional Dev Container
Feature is published under `ghcr.io/moira-mcp/features/workspace-service`. Select a published release
tag. The image includes the runtime; the Feature adds the same payload to a project's own Linux
Dev Container. Both support glibc x64/arm64 and a repository owned by the service user, including
an explicitly configured root user. Adding the Feature during a container rebuild is optional;
Moira's fixed bootstrap upgrades an existing environment without requiring that rebuild.

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
socket-count or transfer-duration quota; streaming backpressure, public-address checks, finite
owner lease and revocation remain. Host/LAN/service destinations stay denied. Browser compatibility
requires the project's guest packages. `preview_image` reads a current repository PNG/JPEG and
checks its container before returning native image content; inspect it before treating it as
visual evidence. Optional `max_bytes` sets the caller's whole-image bound. There is no generic byte,
edge or pixel-count ceiling. PNG/JPEG validation checks structure, not decoded pixels.
`download` publishes the complete original file.
See [the tools reference](/docs/reference/tools/#development-codespaces).

In **Settings → Development → Local computers**, open the connected computer's codespaces and
choose its approved repository to create a VM, or discover
its qualified `repository_id` through `codespace({ action: "repositories" })`. Different computers
offering the same repository are distinct choices. Further operations use the existing
`codespace_id`, execution/session/file and native-transfer contracts. The GitHub provider remains
independently available. Settings can revoke one device; **Refresh** rereads current state. Browser revocation
denies new server work but cannot prove physical shutdown of an offline computer; local disable
and lease expiry enforce shutdown independently.

Before Local create/start/stop/delete, choose `request_id` in `ws1-<lowercase UUID>` form;
start/stop/delete also send the observed `generation` from get/list. A stale generation returns
`CODESPACE_GENERATION_CONFLICT`. Collect the original receipt with the `operation` action
and its original `device_id` and `request_id`, even when create returned no codespace ID.
`absent`, `accepted`, `completed` and `unconfirmed` distinguish outcomes; none authorizes automatic
replay. Owner-backed `pending_request_ids` restores collection after reload; a newer snapshot
alone does not complete an uncertain mutation.

If registration exists but the owner has not published a resource observation, get/list report
`CODESPACE_PROVIDER_UNAVAILABLE` rather than a guessed machine or generation. Retained pending
creation instead returns `CODESPACE_LOCAL_CREATION_UNKNOWN` with its original request, device and
codespace IDs for collection. A completed receipt containing an uncertain error is still unknown;
explicit repetition does not turn it into confirmed rejection or create a second VM. Successful
summaries allow `machine: null`, including the confirmed-deleted result.

Each computer card contains its own creation form, codespaces and collapsed settings. Computers
with the same name remain distinct, and one repository can have several separate VMs. Shared
computer storage is shown at the computer level; CPU and RAM belong to each VM. GitHub Codespaces
has a separate subsection. Refresh and action errors stay with the affected section or codespace.
Local cards show the last verified observation, or that none exists, and a localized lifecycle
refusal. **Check state again** collects the original lifecycle receipt when its identity is
known; otherwise it performs a read-only refresh. It never resubmits start, stop or delete.
New explicit actions require a fresh identity and the observed resource generation.
`created` does not certify shutdown: the native
owner must confirm exact runtime and worker settlement. An unavailable observation preserves the
last verified state and never becomes a successful stop.

**Delete** remains available for pending creation, cleanup and uncertain local state, with explicit
confirmation and the current generation. It targets the same owned VM and waits for confirmed
removal; a failed observation cannot remove the card as if the VM were absent. A failed card does
not prevent healthy sibling codespaces from refreshing or running.

Owner deletion requires an active paired computer with local web-control approval and a running,
reachable companion. It remains available with agent deletion permission denied, work disabled
or its lease expired. Confirmation authorizes only exact observation and removal; it does not
change repository grants or renew work permission. MCP deletion still requires the agent's
deletion grant and enabled, unexpired work authority.

A refused deletion shows its error in the dialog and ends the spinner. **Cancel** stays available
while a separate read obtains the current generation for another confirmation. An operation's
403 refusal preserves the browser session; account admission or expired-session errors retain
their sign-in handling.

Physical VM startup is distinct from guest readiness: commands become available only after guest
preparation completes. `CODESPACE_LOCAL_SETUP_INCOMPLETE` means that preparation failed, even if
the VM is confirmed stopped. Delete it and confirm removal before creating a replacement;
restarting or `recover` does not complete initial setup.

Install matching server and companion builds. Their strict snapshot and management-result contract
includes exact creation identity, guest readiness and native stop confirmation. Records remain
unobserved until a verified read. Follow the coordinated shutdown and backup procedure above;
rollback restores the matching server database, complete local state, SDK storage and bundles
together. Preserve unsupported private owner state for diagnosis; old cloud state stays archival.
Updating the server or rebuilding the CLI does not replace an already running daemon's journal and
installed executable release. Fixed guest bootstrap refreshes the common service in place.
A receipt without start proof leaves that start
unconfirmed. Inspect the original operation instead of
restarting the companion to recover a lost reply. Companion shutdown stops its owned VM processes.

The host CLI supports `create OWNER/REPO --ref BRANCH`, `start SPACE_ID`, `stop SPACE_ID`,
`remove SPACE_ID --confirm` and `collect REQUEST_ID` through the running private controller.
Choose `--request-id` before mutation; the CLI prints it before observing the result. Fresh create
requires live cloud route registration and initial Git authority. Already admitted VMs can start,
stop or be cleaned up offline under applicable current owner authority. Starting requires the
finite work lease; owner-confirmed cleanup does not renew it. Raw host execution is
unsupported; ordinary commands/files use the guest `moira-workspace` CLI or MCP. `recover` remains
a custody tool. Persistent paired lifecycle work uses `run`.
After a crash or computer reboot, start `run` with the same state directory. It automatically
reclaims a stale runner marker only under the system lock and after proving both previous host
owners absent. Saved policy, VM records and unknown operations are retained without replay.
Live, unknown or malformed ownership stays refused; do not delete its marker manually.
On macOS, startup also remounts the existing default disk image from that same state directory
when needed. It verifies the native image/mount binding and the volume's ownership, capacity and
free space before work; a lost attach reply is checked against the observed binding. Custom
storage mounts must be mounted manually. Missing images or conflicting bindings remain refused;
startup does not create a replacement disk or reset its data.
The local daemon separates server contact from VM lifetime. Network/5xx failures reconnect;
remote owner state is unavailable until connection succeeds, without stopping already-admitted
work. Remote mutations are refused rather than queued. An addressed resource refusal stays with
that request. Confirmed device revocation/identity failure, local disable and lease expiry
stop work. Existing grants and finite deadlines are never extended; cached results do not repeat effects.
Ctrl+C closes the foreground companion; `npm run local -- disable` stops owned work independently
and keeps VM data. Stop keeps files, while `remove SPACE_ID --confirm` deletes the exact owned VM.
An uncertain command or edit is retained by its own operation identity and is not retried
automatically. It does not block independent work. Inspect the saved result before repeating the
same edit or modifying affected files; a failed delivery is not proof that an edit was not applied. Ordinary
stop/start requires no manual synchronization. If runtime ownership itself needs recovery, first
confirm that the VM is physically stopped, then use `recover SPACE_ID --confirm` with the same
state directory. It checks exact identity and network policy without replaying jobs; retained jobs
and unknown outcomes remain unchanged.
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
available paired controller. Choose `device_id` if more than one controller is available.
The controller owns original-operation journals and fixed provisioning through its packaged gh,
trusted SSH and verified Linux payload; cloud Moira retains minimal resource/account authority
and fixed provider API calls. No cloud connector Compose service is required.

Use `codespace` with `list`, `repositories` and `setup_help` for discovery.
Before create/start/stop/delete/adopt, choose a fresh `ws1-<lowercase UUID>` `request_id`.
Start/stop/delete and adoption of a registered `codespace_id` require its observed `generation`.
Adopt an unmanaged owned environment by `provider_resource_name`; the same disk is prepared in
place. An explicit adoption of a stopped environment can start it. A pending or unconfirmed
receipt does not establish usable guest readiness: collect with
`codespace({ action: "operation", device_id, request_id })` on the assigned controller.
Collection never creates, starts or installs again. Exact recovered provider identity may still
be `GITHUB_PROVISIONING_INCOMPLETE`.

Only a live authenticated, enrolled guest admits command/file work. Ordinary routing does not
start a VM or open SSH. A healthy private Unix endpoint alone does not prove its cloud registration.
A confirmed 401/403 registration refusal retires that credential; ordinary network loss remains
reconnectable. `exec` without command fields collects its original request ID;
`codespace_process` gets/reads/stops the original process. Cloud or client loss does not cancel it.

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
owner's lease and policy. Current resources and GitHub billing are shown separately; billing
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
Owning these communication files requires neither a Local VM nor an enabled Local SDK work
lease. Select `device_id` when several controllers are live. Preserve the owner's private
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
