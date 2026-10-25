# Deployment configuration

Start with the supplied Compose configuration and environment example. Keep operator secrets outside Git and image layers. Application settings are resolved through [shared config](../../packages/shared/src/config/env.ts) and [URL helpers](../../packages/shared/src/config/urls.ts); use those getters when changing application code, rather than adding direct environment reads or independent defaults.

## Environment loading and durable secrets

On first getter access the config singleton loads `.env.local` when `NODE_ENV=development`, otherwise `.env`, from `ENV_FILE_FOLDER` or the current directory. Existing process environment wins. Persisted secrets next to `DB_PATH` fill missing values without overriding real supplied values. Build arguments and browser bundles are not runtime secret storage; changing a build-time browser option requires rebuilding its consumer.

`MOIRA_HOST` supplies the public application host; URL helpers derive protocol/base/MCP URLs. Set `STATIC_ARTIFACTS_DOMAIN` for per-artifact origins, DNS and wildcard TLS separately. `APP_BASE_PATH` selects the browser prefix; use generated links instead of hardcoding `/app`. `DB_PATH` defaults to `./data/moira.db`.

The image's first-start bootstrap generates missing self-host `BETTER_AUTH_SECRET`, `TELEGRAM_ENCRYPTION_KEY` and `ADMIN_PASSWORD`, persisting them in `<dirname(DB_PATH)>/.secrets.env` with private permissions. The generated administrator password is surfaced once. Preserve that file with the database; restarts reuse it. Supplied real values take precedence, and bootstrap replaces only missing/empty/known build placeholders. SaaS requires operator-supplied secrets instead. See [secrets-bootstrap.ts](../../packages/shared/src/config/secrets-bootstrap.ts) and [init-database.sh](../../scripts/init-database.sh).

Do not regenerate encryption keys as a troubleshooting step. Settings ciphertext and the independent workspace credential vault have separate key lifecycles; see [authentication](../reference/authentication.md#encrypted-settings).

## Startup guard and failure recovery

The image entrypoint clears stale initialization sentinels before Supervisor can start any waiter. Supervisor then runs the self-host startup guard around secret bootstrap, database migrations and bundled-catalog reconciliation. MCP, backend and nginx wait for initialization; an old success marker cannot admit them after a container restart. The child initializer cannot publish success independently of the guard.

For an existing self-host database, the guard takes an integrity-checked SQLite online snapshot together with the prompt manifest (including its explicit absence) under `<dirname(DB_PATH)>/.moira-startup-backups/`. The `current`, `previous-1` and `previous-2` slots rotate only after preparing the new snapshot. A persistent pending marker makes an interrupted initialization restore the protected state before taking the next backup. Success transitions the marker to committed before publishing `/tmp/init-success`; initialization failure attempts restoration before publishing `/tmp/init-failed`. If restoration fails, services remain blocked and recovery material stays available for inspection. These startup snapshots do not replace an operator's protected backups or preserve every external effect.

A first start has no database to back up. Its separate marker preserves the original prompt-manifest state without inventing an empty database backup; failure/interruption removes the incomplete database and restores that manifest state. Do not delete markers, touch success sentinels or bypass the guard to make services start. Inspect `docker compose logs moira`, the reported cause and retained live/backup integrity before repairing configuration or selecting a previous image. Do not repeatedly restart an unchanged failing image or use reconciliation commands for arbitrary migration/storage failures. Only a confirmed bundled-workflow conflict follows the [bundled-catalog recovery procedure](../reference/bundled-catalog.md).

SaaS bypasses this self-host backup/restore guard; its deployment owner must perform copied-database preflight and controlled swap outside it. Direct/SaaS initialization still publishes its own terminal sentinel. Keep those responsibilities separate when changing startup. Source owners: [entrypoint](../../scripts/container-entrypoint.sh), [startup guard](../../scripts/self-host-startup-guard.sh), [initializer](../../scripts/init-database.sh), [online backup](../../scripts/sqlite-online-backup.sh) and [service waiter](../../scripts/wait-for-init.sh).

## Deployment policy

Set `DEPLOYMENT_MODE=self-host` or `saas` explicitly for a public deployment. The default is self-host; invalid values fail. Production on a non-localhost host refuses an unset mode, while nonproduction warns. This prevents silently choosing a different account policy.

The built-in [feature resolver](../../packages/shared/src/config/feature-resolver.ts) supplies the following policy. Unknown capabilities are false; there are no independent per-capability environment switches. A custom composition can replace the resolver programmatically.

| Capability                                                                     | Self-host | SaaS     |
| ------------------------------------------------------------------------------ | --------- | -------- |
| `openRegistration`, `userManagement`                                           | enabled   | enabled  |
| `accountApproval`                                                              | enabled   | disabled |
| `emailVerificationGate`, `verificationEmailOnSignup`                           | disabled  | enabled  |
| `legalConsents`, `betaNotices`, `socialLogin`                                  | disabled  | enabled  |
| `multiUserAdmin`, `adminAnalytics`, `adminOperations`, `operationsDevelopment` | disabled  | enabled  |

Self-host keeps ordinary-user approval/recovery, settings, audit, API-token and local database administration, deployment-neutral system status and managed-workflow reconciliation. Broad workflows/executions/artifacts administration, installation statistics, analytics and deliberate monitoring-test effects have their named capabilities. This table is deployment policy, not an assertion that every privileged route has an extra capability gate: administrator middleware and actual route mounting remain authoritative. Inspect [server.ts](../../packages/web-backend/src/server.ts) and [admin route selection](../../packages/web-backend/src/middleware/admin-route-capability.ts) when changing a surface.

`GET /api/features` returns effective public capability booleans and sanitized email state. UI hiding is not enforcement; the server must gate the corresponding read/effect. Core workflow execution, notes, playbooks, artifacts, settings, sharing, workspace orchestration and Web UI remain public product responsibilities. Private branding, catalogs and deployment material belong to their external owner.

## Email delivery

Choose `EMAIL_PROVIDER=smtp|brevo|test|none|auto` (unset also selects automatically). SMTP needs `SMTP_HOST` and `EMAIL_FROM`; authentication requires both `SMTP_USER` and `SMTP_PASSWORD` or neither. `SMTP_PORT` defaults to 587; `SMTP_SECURE` and `SMTP_REQUIRE_TLS` accept explicit booleans. Brevo needs `BREVO_API_KEY` and `EMAIL_FROM`. Automatic selection prefers a complete SMTP configuration, then complete Brevo; a supplied incomplete group produces a configuration error rather than pretending delivery works.

`GET /api/features` distinguishes `real`, `test`, `unavailable` and `configuration-error`. Invalid provider configuration fails startup in either mode. Self-host may start with unavailable/test delivery, but email actions remain unavailable; SaaS requires `real`. `EMAIL_TEST_RECIPIENTS` and the explicit test provider are testing sinks, never proof of sending. Set `EMAIL_FROM`, optional `EMAIL_FROM_NAME` and deployment contact details intentionally. Use [account recovery](accounts.md) when real delivery is absent.

## GitHub workspace integration

Workspace GitHub App authorization is independent of GitHub/Google social login. Supply the complete group: `CODESPACE_GITHUB_APP_CLIENT_ID`, `CODESPACE_GITHUB_APP_CLIENT_SECRET`, `CODESPACE_GITHUB_APP_CALLBACK_URL`, `CODESPACE_GITHUB_APP_INSTALL_URL` and `CODESPACE_CREDENTIAL_VAULT_KEY`; `CODESPACE_CREDENTIAL_VAULT_KEY_VERSION` defaults to `v1`. With the entire group absent the integration is disabled; partial/invalid configuration exposes a safe unavailable configuration state without disabling unrelated authentication.

The callback must share the application origin and exact `/api/integrations/github/callback` path, without credentials/query/fragment, and use HTTPS outside loopback. The installation URL is the exact GitHub App installation path on `https://github.com`. The vault key is a dedicated random 32-byte hex key; bootstrap does not generate this group. Keep its version and key recoverable with existing ciphertext. [github-app-config.ts](../../packages/shared/src/codespaces/github-app-config.ts) owns validation; [authentication](../reference/authentication.md#device-and-external-credential-custody) owns recovery after unreadable custody.

`CODESPACE_CODESPACES_ENABLED=true` enables GitHub Codespaces; it is not a Local permission switch. The current [resource policy](../../packages/shared/src/codespaces/resource-policy.ts) also accepts `CODESPACE_PERSISTENT_RETENTION_DAYS` (1–30, default 30). It does not provide generic CPU/memory/count/concurrency/creation-throttle/file-size or command-duration ceilings. The selected controller records its actual machine choice and applicable provider settings before creation. Local allocations remain owner-approved; real storage/provider failures still apply.

Personal `codespaces.auto_stop_enabled` and `codespaces.idle_timeout_minutes` choose GitHub's native timeout for newly created environments. Existing environments retain provider settings; disabling automatic pause requests the provider maximum rather than indefinite running. Provider timeout is not a Moira command deadline. See [workspace lifecycle](../reference/workspaces.md#github-lifecycle).

## Network admission

Set `TRUST_PROXY` to the actual trusted proxy topology before relying on client-IP limits or audit attribution. Unset means `loopback`; the supplied public Compose uses `2` for its ingress route. A nonnegative integer is a hop count; otherwise use the accepted IP/CIDR/named subnet list. `true` and malformed values refuse startup. Public ingress must replace untrusted forwarded headers. `RATE_LIMIT_WHITELIST` uses the resolved client address. `DISABLE_RATE_LIMIT=true` is a test/development control, not an appropriate default for public ingress.

Browser CORS permits the application origin, configured `EXTRA_TRUSTED_ORIGINS`/`CORS_ALLOWED_ORIGINS` and localhost origins. Requests without Origin retain server-to-server semantics. CORS is a browser response policy, not caller authentication. For workspace streams, the supplied Traefik route sends HTTP/1.1 Upgrade traffic under `/api/workspaces/` directly to backend 3001 and ordinary traffic to nginx on the same public entry. Sending everything through the ordinary nginx route does not support this transport. See [streaming transport](../reference/workspaces.md#streaming-transport).

## Stored settings and catalogs

Global/admin settings and per-user settings are database configuration, not environment variables. Installed declarations take precedence over DB definitions. Preserve absent, null and intentional empty values; use the settings service and its schemas instead of truthiness fallbacks. Built-in and extension secrets have explicit public masking policies. HTTP bulk writes can partially refuse and return 207; do not assume one transaction for the whole batch. Effective prompt overrides likewise preserve model→agent→default first-non-null precedence, including an empty existing override.

### Artifact quotas and body admission

The administrator's user quota form controls storage, file count and maximum size of one artifact.
The per-file `maxFileSizeMb` override takes precedence over global `artifacts.max_file_size_mb`,
then the 5 MiB default. One MiB is 1,048,576 bytes. Clearing that field stores null and restores
inheritance without resetting storage/count; the full reset clears all three overrides. HTTP PUT
also preserves omitted fields. The effective `maxFileSizeBytes` appears in user quota reads and
artifact stats. Storage and count are independent budgets, not another per-file ceiling.

File-size values must be positive and convert to a whole safe integer byte count; fractional MiB
values are allowed. Both the byte count and `6 × bytes + 65,536` must be safe integers. The same
validation applies to the global setting, including history restoration. Invalid persisted values
fall back through the policy rather than disabling admission. Retention is separate; use each
artifact's returned `expiresAt`, not a fixed lifetime inferred from an unavailable-artifact page.

Upload admission authenticates the session or validates the token before reading a large body.
For effective decoded HTML limit `N` bytes, artifact JSON create/update/token upload admits at most
`6 × N + 65,536` bytes, allowing JSON escaping and finite metadata. The service rechecks the current
decoded UTF-8 content limit before writing. Multipart token upload permits one file up to `N`,
two text fields up to 16 KiB each, three parts and field names up to 100 bytes. The bundled
multipart parser enforces its native 16 KiB header-block limit per part; this is not a configurable
header-count setting. Oversized content frames/files return 413; malformed multipart headers,
invalid multipart metadata or malformed JSON return 400.
An invalid token returns 401 without parsing content. Tokens are marked used after successful
creation; this does not establish atomic exactly-once behavior for concurrent uploads.

Authenticated MCP JSON requests use `max(20 MiB, 6 × N + 65,536)` as an incremental body budget,
independently of the tool name or JSON property order. This also bounds a direct MCP listener;
it is not an unlimited-body endpoint. Authentication is checked before and after reading.
Requests beyond the frame return HTTP 413 with JSON-RPC code `-32000` and `data.limitBytes`;
the decoded artifact limit remains `N` even when the frame is larger.

Supplied root and `/app` nginx configurations stream MCP and artifact upload paths without a
second proxy body ceiling; the application's finite admission owns those bodies. Ordinary ingress
retains its 20 MiB ceiling and ordinary backend JSON retains 10 MiB. Preserve these distinct owners
when adding a reverse proxy; a lower proxy cap would refuse otherwise permitted uploads.
See [HTTP admission](../reference/http-api.md#settings-notes-playbooks-and-artifacts) and
[upload guidance](../../packages/mcp-server/src/help/content/patterns/artifacts-publishing.md).

Notes quotas and completed-execution retention use global settings. `executions.retention_days=0` disables automatic retention; retention does not remove running executions or a completed parent with an active child. Confirm the current [retention service](../../packages/shared/src/services/execution-retention-service.ts) before changing cleanup behavior. Workspace original receipts and credential-custody records have separate ownership and cannot be cleared as execution-retention housekeeping.

`WORKFLOWS_DIRS` is an ordered colon-separated catalog list; later directories override the same `(owner, slug)`. It falls back to `WORKFLOWS_DIR`, then `./workflows/production`. Private catalogs can extend the public image without copying definitions into OSS. Use the canonical catalog reader; test fixtures choose their own source-owned catalog explicitly. For commands and acceptance boundaries use [the testing guide](../../tests/TESTING-GUIDE.md).
