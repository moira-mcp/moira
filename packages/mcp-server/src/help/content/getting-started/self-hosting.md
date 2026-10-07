---
title: Self-Hosting
description: Run your own Moira instance with Docker Compose using the prebuilt image
---

Run Moira on your own machine with Docker Compose. The default path pulls a prebuilt
image from the registry — no source checkout or local build needed.

## Prerequisites

- Docker with the Compose plugin (`docker compose`)
- The public `docker-compose.yml` and `.env.example`; no source build, private repository,
  host SQLite CLI, or separate upgrade script is required for the normal path

## Quick Start

Download the current public self-host files:

```bash
MOIRA_FILES=https://raw.githubusercontent.com/moira-mcp/moira/master
curl -fLO "$MOIRA_FILES/docker-compose.yml"
curl -fLo .env.example "$MOIRA_FILES/.env.example"
```

1.  **Create your config**

    ```bash
    cp .env.example .env
    ```

    For a `localhost` run, the defaults work unchanged.

2.  **Start the container**

    ```bash
    docker compose up -d
    ```

    Compose pulls `ghcr.io/moira-mcp/moira:latest`, the current public release, and starts
    the container.

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

- Unset (the default) trusts only the nginx inside the container. Use it when clients connect to the
  container's published port directly.
- Behind one more reverse proxy — Traefik, Caddy, a load balancer — set the number of proxy hops, or
  that proxy's address or subnet:

```bash
TRUST_PROXY=2                            # your proxy, then the nginx inside the container
TRUST_PROXY=loopback,172.18.0.0/16       # or: loopback plus the proxy's Docker network
```

Without it, every client behind your proxy shares the proxy's address and one rate-limit budget.
`TRUST_PROXY=true` is refused, and an invalid value stops startup with an error that lists the
accepted forms.

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
OAuth connection and vault configuration. Local work does not require the GitHub connector
Compose profile below.
Server work still requires `CODESPACE_CODESPACES_ENABLED=true` and enabled instance controls.
The companion makes outbound HTTPS requests and exposes no public listening port.

Use Node.js 24 and macOS on Apple silicon with the pinned Docker Sandboxes `sbx` 0.46.0
signed bundle from [Docker's release artifacts](https://github.com/docker/sandboxes/releases/tag/v0.46.0).
See [Docker's installation requirements](https://docs.docker.com/ai/sandboxes/install/).
Linux execution is refused. Build the private companion package from a Moira source checkout
with the macOS command-line C compiler available;
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
For standalone work without enrollment, a private repository can use a GitHub token supplied on
stdin to `npm run local -- git-token OWNER/REPO`; never put it in arguments or shell history.
That repository token stays local and is separate from the device credential. An enrolled
companion serving Moira uses server OAuth authorization for private access and push and never
falls back to this local token.
The finite work lease defaults to 8 hours and cannot exceed seven days. Renew it locally with
`enable --hours N`. The browser can change these settings only after you explicitly approve web
control on this computer, as described below.

In **Local computers**, choose **Connect a device**. Copy the displayed command and pairing token
separately. From the source checkout, run the command as
`npm run local -- enroll --server <displayed HTTPS application URL> --pairing-id <displayed ID>`.
Enter the token on stdin and end input; never append it to the command. The server URL includes
the app prefix when configured and contains no credentials, query or fragment.
Refresh the browser, review the pending computer's repositories, push/delete rights,
resource allocations and lease, then confirm.

The server, companion and running owner guards need a matching control-contract edition.
Strict heartbeat/approval schemas refuse mixed editions even with delegation off; rebuilding the
CLI does not update a live guard. Before updating, use the companion's ordinary owner-managed
shutdown and confirm settlement of its owned work and guards. While both sides are stopped,
back up the server database, the complete private companion state and its SDK backing storage,
including VM disks. Keep the matching server and companion bundles with that backup. Update server and local checkout
together, run `npm ci` and `npm run local:build`, then restart normally. Preserve the same state,
disks, SDK profile, credentials and connection. Management and running jobs may be interrupted;
there is no uninterrupted mixed-edition rolling upgrade. Live repository append within the matched
edition separately preserves existing VMs.

When the saved control format contains unsupported fields, back up the server database and the
computer's private state and disks, then convert only those fields while both sides are stopped.
Remove obsolete repository domain lists, repository-count/network-profile delegation fields and
technical quota fields from every saved policy, control and pending-intent copy, including retained
creation-request delegation. Preserve grants, request receipts/markers, IDs, generations, jobs,
credentials and disks; validate the matching strict format before starting matching bundles.
Server public-policy digests must match the converted canonical policy. There is no automatic
compatibility reader for an unsupported saved format. Rollback restores the paired snapshots and
matching bundles; it does not reset the SDK or require replacement enrollment.

After pairing is confirmed, approve local web control:

```bash
npm run local -- web-control --confirm --max-lease-hours 168
```

Use the same `--state PATH` as setup. Unspecified numeric ceilings keep the current local values;
the command's lease ceiling defaults to seven days. To permit larger resource settings, supply
the intended ceilings with `--cpus`, `--memory-gib`, `--storage-gib` and `--docker-gib`.
This approval does not itself renew the work lease.
An existing web-control approval is not replaced by rerunning this command; browser requests must
fit its saved ceilings.
Start the foreground companion after confirmation and local approval:

```bash
npm run local -- run
```

In **Local computers**, edit the device name, enabled state, expiry, CPU/RAM, bounded disk and
guest Docker capacity, repository permissions and commit author. **Allow seven days** sets
a finite expiry within the locally approved ceiling; it does not renew automatically.
Commands carry bounded request timeouts and output sizes, without separate owner-set operation quotas.
**Request settings change** records a request, not effective permission. Pending requests wait
for the computer; applied and rejected revisions identify what the companion accepted. Read the
effective permissions above the editor before starting work. Errors preserve the draft; updates
adopt untouched fields without replacing independent edits. The control connection can receive a
renewal while work is disabled or expired, but guest work remains off until it applies.
CPU/RAM and guest Docker defaults apply to new environments; existing VMs retain their admitted
profile. The storage capacity is the computer's shared SDK backing image, not a separate allocation
of that size to every codespace. Bounded disk changes require stopped owned work and verified resizing; a refused change
does not authorize further work or erase data.
For private repositories, push and PR creation through Moira, connect GitHub and grant the App
access to the repository. Those operations also require the device's matching repository rights;
reading PR metadata uses repository read access. GitHub authorization remains on the server, not
in the guest. Supply a commit author or leave both author fields empty to use your verified GitHub
identity when available; the computer's Git configuration is not copied.

With local web control approved, the owner can enable agent repository management here.
It defaults off and binds the verified personal GitHub account, separate existing/new-private permissions,
and optional push. Repository additions have no count quota or fixed technology profile.
Only companion acknowledgement makes it effective. `codespace({ action: "local_devices" })`
shows owned computer IDs, labels, contact status and enablement, plus eligible personal App
installations. A warning asks for GitHub setup while retaining device discovery; inspect applied
consent in Settings. `repository_add` takes `device_id`, the GitHub numeric `repository_id`
and a stable UUID `request_id`. MCP waits for companion acknowledgement and returns `repository_id`
only after access is applied. An unconfirmed or rejected request is not permission; resume its same
identity after the applicable repair. The App must already expose the repository. Agent additions
preserve existing grants, VMs and lease; agents cannot change consent or supply rights.
For a new empty private repository, enable and apply new-private consent, then use `repository_create`
with `device_id`, stable UUID `request_id`, `repository_name` and discovered `installation_id`.
Only the connected personal account is supported. Resume the same complete payload: `unknown`
does not retry creation blindly, and `setup_required` can retain the confirmed GitHub ID/name while
permissions or installation access are repaired. Only acknowledged admission returns usable `repository_id`.
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
OAuth stays on the server. Live App permissions and provider compatibility require separate verification.

Each codespace has its own VM; a repository can have multiple codespaces.
Local VMs and operations do not consume cloud Codespaces slots or use its machine ceiling.
Use `codespace_process` for background start/get/read/stop in that VM. Ordinary `codespace` commands
and files wait for their result, without normal polling. Backend, frontend and browser checks share
guest localhost. A client's transport timeout remains independent; after interrupted or unknown
delivery, recover the accepted identity instead of starting another effect. Public package registries and other public
DNS destinations are available independently of the language or framework, with public-address and
computer-network checks on every connection. Network downloads have no cumulative traffic budget or
per-download byte quota; bounded socket capacity provides backpressure. Host, LAN and service
addresses remain denied. Browser/system-library installation uses guest commands and compatible
guest privileges; network access does not certify browser compatibility. `preview_image`
returns a repository PNG/JPEG as native MCP image content: pass `codespace_id`, `path` and optional
`max_bytes` up to 4 MiB, or resume with only `codespace_id` and `operation_id`. Header/container
checks cap dimensions at 8192 per edge and 16 million pixels; they do not fully decode pixels.
Inspect the image before treating a screenshot as visual evidence.

In **Settings → Development → Local computers**, open the connected computer's codespaces and
choose its approved repository to create a VM, or discover
its qualified `repository_id` through `codespace({ action: "repositories" })`. Different computers
offering the same repository are distinct choices. Further operations use the existing
`codespace_id`, execution/session/file and native-transfer contracts. The GitHub provider remains
independently available. Settings can revoke one device; **Refresh** rereads current state. Browser revocation
denies new server work but cannot prove physical shutdown of an offline computer; local disable
and lease expiry enforce shutdown independently.

Each computer card contains its own creation form, codespaces and collapsed settings. Computers
with the same name remain distinct, and one repository can have several separate VMs. Shared
computer storage is shown at the computer level; CPU and RAM belong to each VM. GitHub Codespaces
has a separate subsection. Refresh and action errors stay with the affected section or codespace.
Local cards show the last verified observation, or that none exists, and a localized lifecycle
refusal. **Check state again** retries the existing start/stop/delete intent for the exact
codespace; a pending create is only refreshed. `created` does not certify shutdown: the native
owner must confirm exact runtime and worker settlement. An unavailable observation preserves the
last verified state and never becomes a successful stop.

**Delete** remains available for pending creation, cleanup and uncertain local state, with explicit
confirmation and the current generation. It targets the same owned VM and waits for confirmed
removal; a failed observation cannot remove the card as if the VM were absent. A failed card does
not prevent healthy sibling codespaces from refreshing or running.
Physical VM startup is distinct from guest readiness: commands become available only after guest
preparation completes. `CODESPACE_LOCAL_SETUP_INCOMPLETE` means that preparation failed, even if
the VM is confirmed stopped. Delete it and confirm removal before creating a replacement;
restarting or `recover` does not complete initial setup.

Install matching server and companion builds. Their strict snapshot and management-result contract
includes exact creation identity, guest readiness and native stop confirmation. Records remain
unobserved until a verified read. Follow the coordinated shutdown and backup procedure above;
rollback restores the matching server database, complete local state, SDK storage and bundles
together. Convert unsupported saved policy/control formats only while both sides are stopped.

Manager-backed CLI create/start/exec commands are one-shot and stop owned VM processes on exit;
persistent server work uses `run`. Stop it before another command needs the same runner lock.
The local daemon separates server contact from VM lifetime. Network/5xx failures reconnect;
malformed control-plane responses suspend new claims until confirmation succeeds, without stopping
already-admitted work. An addressed resource or delivery-claim refusal stays with that request;
background delivery confirms the same current device authority and continues independent claims
without a daemon-wide fault or retry delay. Confirmed device revocation/identity failure, local disable and lease expiry
stop work. Existing grants and finite deadlines are never extended; cached results do not repeat effects.
Ctrl+C closes the foreground companion; `npm run local -- disable` stops owned work independently
and keeps VM data. Stop keeps files, while `remove SPACE_ID --confirm` deletes the exact owned VM.
An uncertain guest outcome is fenced, not retried automatically. Once that VM is confirmed stopped,
`recover SPACE_ID --confirm` acknowledges the outcome without replaying jobs. It also acknowledges
an initialized clean stopped VM whose generation conflicts with its server binding, after checking
exact identity and network policy. Use the same state directory and restart `run`; retained jobs
and unknown outcomes remain unchanged. Confirmed ordinary clean stops retain that receipt automatically.
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

GitHub codespace creation and agent operations additionally require `CODESPACE_CODESPACES_ENABLED=true`
and the connector pair from the disabled-by-default Compose profile:

```bash
docker compose --profile codespaces up -d
```

With the connection and connector in place, an authenticated MCP client uses `codespace`,
choosing the operation with `action`: `list` shows compact existing codespaces, `repositories`
shows approved targets and refreshes stale grants, `setup_help` returns the current user-owned setup step and
the provider's exact links, `create` provisions a persistent personal-billed Codespace for an approved repository,
and `exec`, `stat`, `search`, `read`, `write`, `apply_patch`, `upload` and `download` work inside it
by `codespace_id`. Create/start wait for a usable environment, stop for confirmed shutdown while
keeping data, and delete for confirmed absence with explicit confirmation. Ordinary successful
calls return useful results without operation journals or quota envelopes. Use `codespace_process`
with `process_id` for background start/get/read/stop. Different chats and clients may reuse the same
codespace; nothing is deleted when a command finishes or a client disconnects.

An agent working in a codespace acts as the ordinary Codespace user: it can read the repository,
use the network and read any secrets configured for that Codespace. Moira's isolation protects the
Moira server and other users, not the codespace from the agent its owner authorized. When setup is
incomplete, actionable refusals carry the same applicable Settings, repository-creation and
provider-console links as `setup_help`, plus App installation when its URL is configured, instead of
starting any authorization flow. A codespace is
personal rather than shared; collaboration happens through version-control branches.

Users manage the same codespaces from the **Development environments** card in **Settings →
Development → GitHub Codespaces**: create one for an approved repository, start or stop it (stop keeps the repository
data) and delete it after an explicit confirmation. Each user's idle codespaces pause on their own:
the **Automatic pause** card in the same section sets `codespaces.auto_stop_enabled` (on by default)
and `codespaces.idle_timeout_minutes` (30 by default, 5 to 240), which decide when Moira stops a
codespace no agent has used through Moira, and the next agent operation starts it again. The **Your
limits** card beside it shows the user's codespace, command and transfer limits against current
use. Direct use in a browser, an editor or over SSH is not seen, so
users who work in their codespaces directly should turn pausing off. Administrators open
**Admin → Settings → Codespaces** to see the instance readiness (configuration, connector,
reconciliation backlog, active codespaces and operations against their limits) and to pause work with the global or provider kill switch; pausing refuses new
codespaces, starts and agent operations and stops running codespaces without deleting anything.

For monitoring, `GET /api/health` and the MCP `/health` endpoint report the readiness state
(`disabled`, `misconfigured`, `control_disabled`, `connector_unavailable` or `ready`); a disabled
feature is healthy, while invalid configuration or an unreachable connector marks the instance
degraded. Health answers from a cached decision refreshed on the reconciliation interval, and the
connector probe is bounded to two seconds, so a stalled connector cannot hang the health check. The internal metrics port exposes `moira_codespace_*` gauges and counters. Alert when
`moira_codespace_ready` stays at 0 with `CODESPACE_CODESPACES_ENABLED=true`, when
`moira_codespace_connector_available` is 0, when
`moira_codespace_reconciliation_oldest_due_age_seconds` exceeds several reconcile intervals, or when
`moira_codespace_rejections_total` grows for quota or busy codes.

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
