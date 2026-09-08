# Workspaces and GitHub Connection

This reference describes Moira's provider-neutral workspace control plane and
the built-in GitHub Codespaces provider. A workspace is a persistent,
user-owned development environment addressed by an opaque workspace ID. It is
not a chat session: Moira does not receive or store a ChatGPT conversation ID,
and different authorized clients may reuse the same workspace.

GitHub authorization belongs to the authenticated website. Agents do not
receive provider credentials, OAuth operations, SSH configuration or lifecycle
capabilities. The public MCP workspace tools and website workspace-management
screens are not exposed yet; the current runtime supplies the connection,
lifecycle, direct-operation and reconciliation services they will use.

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
- `packages/web-backend/src/routes/workspace-connections.ts` and
  `packages/web-frontend/src/pages/settings/GitHubWorkspaceSettings.tsx` own the
  authenticated website authorization boundary.

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
interpolated into a shell program. The current GitHub connector accepts inline
stdin; native file-reference input belongs to the file-transfer layer and is not
available yet.

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

## Trust and isolation

Direct execution is not an agent sandbox. An authorized agent has the same
repository, installed tools, network and configured Codespaces secrets available
to the Codespace user. Repository content can influence the agent, and commands
can read or transmit those values. A command may also create a detached daemon
or modify startup files beyond the foreground process group. Moira therefore
does not claim to protect workspace data from an agent the user authorized;
restricted execution would require a separate opt-in mode.

The connector boundary protects the multi-tenant Moira server:

- the credential-bearing connector is non-root, read-only, capability-limited
  and bounded to 1 CPU, 640 MiB memory and 96 PIDs;
- it mounts only private Unix-socket volumes and a bounded tmpfs, with no Moira
  database, data directory, vault key, Docker socket or other-tenant volume;
- `network_mode: none` removes its direct network path;
- a separate credential-free CONNECT proxy accepts only reviewed
  GitHub/Codespaces HTTPS hosts, rejects IP-literal and non-public resolution,
  and verifies the connected peer; the proxy is bounded to 0.25 CPU, 128 MiB
  memory and 64 PIDs.

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
| `WORKSPACE_MAX_OPERATIONS_PER_DAY`             |      10 | Submitted lifecycle and direct operations per user/UTC day   |
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

The global active-resource limit cannot be lower than the per-user limit; the
same rule applies to operation concurrency. Configured operation input cannot
exceed 4096 KiB, either output stream cannot exceed 8192 KiB, command duration
cannot exceed 900 seconds and persistent retention cannot exceed 30 days.

## Website authorization API

All routes are mounted under `/api/integrations` after `requireAuth`.

| Method   | Path                          | Behavior                                                         |
| -------- | ----------------------------- | ---------------------------------------------------------------- |
| `GET`    | `/github`                     | Returns the current user's sanitized connection view             |
| `GET`    | `/github/start`               | Stores one-time browser state and redirects to GitHub            |
| `GET`    | `/github/callback`            | Consumes state, verifies GitHub identity/grants and redirects    |
| `DELETE` | `/github`                     | Stops managed work, revokes the GitHub grant and disconnects     |
| `DELETE` | `/github/external-revocation` | Clears an eligible blocked state after external grant revocation |

The external-revocation body must be `{ "confirmed": true }`, and the user
must first revoke the GitHub App grant in GitHub. Start stores a SHA-256 digest
of one-time state bound to the Moira user, web session and provider. It expires
after ten minutes, is consumed once and returns only a bounded outcome on the
same-origin Settings URL. Callback query strings are redacted from application
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

Migrations `0025_workspace_connections.sql`, `0026_workspace_resources.sql` and
`0027_persistent_workspace_operations.sql` own the connection, resource,
lifecycle-capability, policy-usage, provider-mutation, provider-control and
operation tables. Credential tables contain versioned ciphertext; resource and
operation tables contain authority and accounting metadata but no command,
content, result stream, provider token or SSH material.

Audit actions cover connection start/completion/refresh failure/disconnect;
resource create/pending/rejection/cleanup/start/stop/delete; and operation
reservation/reconciliation/terminal outcomes. Metadata is limited to opaque
resource relationships, provider, state/outcome, selected machine facts, byte
counts and exit code. Repository content, source, argv, cwd, stdin, stdout,
stderr, OAuth code/state, session token and provider credentials are excluded.

## Verification

Use the root project commands; do not call Jest directly:

```bash
npm run test:unit
npm run test:integration
docker compose config --quiet --no-env-resolution --no-path-resolution --no-interpolate
```

`tests/COVERAGE-MAP.md` maps the focused connection, resource, operation,
migration, connector, egress and packaged-isolation suites. Live GitHub App user
credentials, an actual personal Codespace and ChatGPT are separate external
compatibility gates; deterministic tests do not establish them.
