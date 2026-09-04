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
recovery. Cross-user workflow/execution/artifact administration, cloud analytics, the operational
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
