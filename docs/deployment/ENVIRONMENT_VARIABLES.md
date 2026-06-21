# Environment Variables Configuration

## Centralized Config Module

**IMPORTANT:** All env variables are read through the centralized module `packages/shared/src/config/`.

### Architecture

```
packages/shared/src/config/
├── urls.ts      # URL-related: getHost(), getBaseUrl(), getMcpUrl(), etc.
├── env.ts       # All other env: getDbPath(), getLogLevel(), etc.
└── index.ts     # Re-exports
```

### Rules

1. **FORBIDDEN:** direct reads of `process.env.XXX` in application code
2. **ALL** env variables are read through functions in the config module
3. **ALL** fallback values are defined in one place (the config module)
4. On the first access to any config function, validation runs automatically (singleton pattern)

### ESLint Enforcement

The `no-restricted-syntax` ESLint rule forbids direct access to `process.env`:

```json
{
  "no-restricted-syntax": [
    "error",
    {
      "selector": "MemberExpression[object.object.name='process'][object.property.name='env']",
      "message": "Direct process.env access is forbidden. Use config module from @mcp-moira/shared"
    }
  ]
}
```

An exception for the config module itself is configured in `.eslintrc.json` overrides.

### Variable Groups

**REQUIRED (the app fails to start without them):**

- MOIRA_HOST
- BETTER_AUTH_SECRET

**WARNINGS (a warning is logged, the app continues):**

- DB_PATH - fallback: ./data/moira.db
- BREVO_API_KEY - email will not work
- GITHUB_CLIENT_ID - OAuth will not work

**TESTING/DEVELOPMENT:**

- DISABLE_RATE_LIMIT=true - disables rate limiting (used in Docker for tests)

**DEPLOYMENT MODE:**

- `DEPLOYMENT_MODE` - deployment mode: `self-host` | `saas`. Fallback: `self-host`. An invalid value → start error (fail-fast). Getter: `getDeploymentMode()`; predicates `isSelfHost()` / `isSaas()` (`packages/shared/src/config/env.ts`).

The mode sets the default behavior of SaaS-specific features through the `FeatureResolver` (type and default `ModeFeatureResolver` in `packages/shared/src/config/feature-resolver.ts`; the `getFeatureResolver()` / `setFeatureResolver()` accessors are exported from `packages/shared/src/services/index.ts`):

```typescript
import { getFeatureResolver } from "@mcp-moira/shared";

const resolver = getFeatureResolver(); // default: ModeFeatureResolver (driven by DEPLOYMENT_MODE)
resolver.isEnabled("openRegistration"); // self-host → false, saas → true
```

`Feature`: `openRegistration` | `emailVerificationGate` | `verificationEmailOnSignup` | `legalConsents` | `betaNotices` | `multiUserAdmin` | `socialLogin`. In `self-host` all are off; in `saas` all are on. An unknown feature → `false` (safe default). The resolver can be swapped via `setFeatureResolver()` (cloud).

**Auth behavior by mode** (`better-auth-config.ts`, `web-backend/.../auth-middleware.ts`):

| Feature                     | self-host                                             | saas                            |
| --------------------------- | ----------------------------------------------------- | ------------------------------- |
| `openRegistration`          | `/sign-up/email` closed (`REGISTRATION_DISABLED` 403) | open registration               |
| `legalConsents`             | terms/residency consents not required                 | required (otherwise 400)        |
| `emailVerificationGate`     | email verification NOT needed to issue tokens/MCP     | required (otherwise 403)        |
| `verificationEmailOnSignup` | no email sent on registration                         | sent                            |
| `socialLogin`               | GitHub/Google OAuth login hidden                      | OAuth login offered (if config) |

In `self-host`, the admin user is created during migration (open registration is closed), and the MCP client connects with an API token without email verification.

**Production safeguard:** if `NODE_ENV=production` AND `MOIRA_HOST` is a public (non-localhost) host AND `DEPLOYMENT_MODE` is unset → startup is **rejected** (`evaluateUnsetModeSafeguard` in `env.ts`), so a hosted deploy does not silently start in `self-host` with the SaaS gates turned off. In non-production this is a warning. A hosted deploy must set `DEPLOYMENT_MODE=saas`; a public self-host must set it explicitly to `=self-host`.

### First-start secret auto-generation (self-host)

In `self-host` mode, missing critical secrets are generated automatically on first start (before migrations) and reused on subsequent starts. Implementation: `packages/shared/src/config/secrets-bootstrap.ts`, invoked by `scripts/bootstrap-secrets.ts` from `scripts/init-database.sh` before `run-migrations.ts`.

| Variable                  | self-host (if empty)               | saas (if empty) |
| ------------------------- | ---------------------------------- | --------------- |
| `BETTER_AUTH_SECRET`      | generated (256-bit hex), persisted | start error     |
| `TELEGRAM_ENCRYPTION_KEY` | generated (256-bit hex), persisted | start error     |
| `ADMIN_PASSWORD`          | generated, shown in the logs once  | migration error |
| `EMAIL_FROM`              | default `noreply@localhost`        | start error     |
| `CONTACT_EMAIL`           | default `support@localhost`        | start error     |

- **Storage**: `<dirname(DB_PATH)>/.secrets.env` (next to the DB, durable bind-mount; file `0o600`, in `.gitignore`/`.dockerignore`). NOT `.env` (which is baked into the image read-only).
- **Priority**: explicitly set env / `.env` values always win over generated ones (`loadPersistedSecrets()` does not override existing values; it is called in `env.ts loadEnv()`).
- **Idempotency**: when secrets already exist (in env or `.secrets.env`), regeneration is skipped — a restart does not invalidate sessions / Telegram encryption.
- `ADMIN_PASSWORD` is no longer required to start in self-host (`run-migrations.ts` does not fail when empty — mode-dependent: saas is strict, self-host generates/skips).

### Configurable limits & execution retention (admin global settings)

These are **not env variables** but admin-configurable values in the `globalSetting` table (as for artifacts), seeded with defaults by migration `0012_self_host_quotas_retention.sql`:

| Key                         | Default | Purpose                                                                            |
| --------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `notes.max_note_size_kb`    | 100     | Maximum size of a single note (KB)                                                 |
| `notes.max_user_total_kb`   | 1024    | Maximum total size of notes per user (KB)                                          |
| `notes.max_versions`        | 50      | Maximum retained versions per note                                                 |
| `executions.retention_days` | 0       | Delete completed executions older than N days. **0 = never delete (keep forever)** |

- Read by: `NoteService` (quotas), `ExecutionRetentionService` (retention). An invalid/non-positive value → fallback to the hardcoded default.
- Retention: periodic cleanup (every 6h) deletes ONLY `completed` executions older than the cutoff; never `running`; keeps a completed parent that has an active child. It starts when the backend starts.

### CORS origin allowlist

CORS uses an explicit allowlist instead of reflecting any origin. Allowed origins are assembled from:

- the app's own public origin (`getBaseUrl()`, from `MOIRA_HOST`);
- `EXTRA_TRUSTED_ORIGINS` (shared list with Better Auth trusted origins);
- `CORS_ALLOWED_ORIGINS` (explicit deploy list);
- localhost origins (`localhost` / `127.0.0.1`, any port) — a safe default so a local self-host works without configuration.

| Variable               | Format                         | Purpose                                                  |
| ---------------------- | ------------------------------ | -------------------------------------------------------- |
| `CORS_ALLOWED_ORIGINS` | comma-separated origins (opt.) | Additional cross-origin sources for browser API requests |

- Getter: `getCorsAllowedOrigins()` (`packages/shared/src/config/env.ts`). Implementation: `packages/web-backend/src/middleware/cors-middleware.ts` (`setupCorsMiddleware`, `isOriginAllowed`).
- Requests with no `Origin` header (server-to-server, curl) are allowed — CORS only governs cross-origin browser requests. A request with an origin outside the allowlist does not receive an `Access-Control-Allow-Origin` header (the browser blocks it).
- In Docker/prod the frontend and API share one origin (unified nginx), so `CORS_ALLOWED_ORIGINS` is only needed when the frontend is served from a different origin.

### Code Review Checklist

When adding new env variables:

- [ ] Added a getter function to the config module
- [ ] Fallback value in the config module (if any)
- [ ] Required variables added to the REQUIRED list in validateEnvConfig()
- [ ] .env.example updated

ESLint automatically enforces that there are no direct reads of `process.env.XXX`.

## Environment Files

### `.env.local` (Local Development)

- **Location**: Root of each git worktree
- **Git tracked**: NO (in .gitignore)
- **Usage**: Local development, local Docker containers
- **Used by**: `npm run docker:restart`

**Key characteristics**:

- No `BREVO_API_KEY` - emails use TestEmailProvider
- Local URLs: `http://localhost:${MOIRA_PORT}`
- Unique ports per worktree (master=3030, dev=3031, dev2=3032, dev3=3033)

### `.env.remote` (Remote Docker on Windows PC)

- **Location**: Root of git worktree
- **Git tracked**: NO (in .gitignore)
- **Usage**: Remote Docker build/run via `scripts/docker-build-and-run.sh --remote`
- **Used by**: Build script when `--remote` flag is passed

**Variables:**

```bash
REMOTE_DOCKER=true                                    # Enable remote Docker mode
REMOTE_DOCKER_CONTEXT=<your-docker-context>                            # Docker context name (created via docker context create)
REMOTE_HOST=192.0.2.1                                 # Remote PC IP (example placeholder)
REMOTE_SSH_USER=<your-ssh-user>                                 # SSH username for connectivity check
PLAYWRIGHT_REMOTE=true                                # Enable remote Playwright browser (native on PC)
PLAYWRIGHT_WS_ENDPOINT=ws://192.0.2.1:3000/           # Playwright WebSocket endpoint on PC
```

**Note:** This file is loaded by `source` in bash — it must contain only `KEY=value` assignments.

### `.env.production` (Production Server)

- **Location**: `/path/to/moira/.env.production`
- **Git tracked**: NO (in .gitignore)
- **Usage**: Production server (MOIRA_HOST domain)
- **Used by**: passed as `ENV_FILE=.env.production` to `docker build`

### `.env.production.staging` (Staging Server)

- **Location**: `/path/to/moira/.env.production.staging`
- **Git tracked**: NO (in .gitignore)
- **Usage**: Staging server (moira.example.com)
- **Used by**: passed as `ENV_FILE=.env.production.staging` to `docker build`

## Docker Build ARG: `ENV_FILE`

```dockerfile
ARG ENV_FILE=.env.local
COPY ${ENV_FILE} .env
RUN echo "✅ Using env file: ${ENV_FILE}"
```

The Dockerfile default is `ENV_FILE=.env.local` (see `config/Dockerfile`); production
and staging builds must pass the build arg explicitly.

### Usage

**Local Docker** (via `docker-build-and-run.sh`):

```bash
docker build --build-arg ENV_FILE=.env.local ...
```

**Production deploy** (pass the build arg):

```bash
docker build --build-arg ENV_FILE=.env.production ...
```

**Staging deploy** (pass the build arg):

```bash
docker build --build-arg ENV_FILE=.env.production.staging ...
```

## Email Configuration

### Logic (packages/shared/src/email/index.ts)

```typescript
// 1. Check if test email pattern
if (isTestEmail(options.to)) {
  return TestEmailProvider; // Always log, never send
}

// 2. Check if BREVO_API_KEY exists (via config module)
if (!getBrevoApiKey()) {
  return TestEmailProvider; // No key -> test mode
}

// 3. Use real provider
return BrevoProvider; // Send real emails
```

### Environment-specific behavior

**Local development** (`.env.local` without BREVO_API_KEY):

- All emails -> TestEmailProvider (logged, not sent)

**Production** (`.env.production` with BREVO_API_KEY):

- Test email patterns -> TestEmailProvider (logged, not sent)
- Real emails -> BrevoProvider (sent via Brevo API)

## Required Variables by Environment

### Both Environments

```bash
# URL Configuration
MOIRA_HOST=<hostname>               # e.g., example.com or localhost:3032
                                     # Protocol auto-detected: localhost=http, else=https

# Authentication
BETTER_AUTH_SECRET=<random-32-byte-hex>

# Encryption
TELEGRAM_ENCRYPTION_KEY=<random-32-byte-hex>

# Admin
ADMIN_EMAIL=admin@moira.local
ADMIN_PASSWORD=<password>

# Ports
MOIRA_PORT=<port>
DOCKER_PORT=<port>
```

### Production Only

```bash
# Email (MUST be in production env files)
EMAIL_PROVIDER=brevo
BREVO_API_KEY=<brevo-api-key>
EMAIL_FROM=noreply@${MOIRA_HOST}
EMAIL_FROM_NAME="MCP Moira"

# OAuth Production Credentials
GITHUB_CLIENT_ID=<production-oauth-id>
GITHUB_CLIENT_SECRET=<production-oauth-secret>
GOOGLE_CLIENT_ID=<production-oauth-id>
GOOGLE_CLIENT_SECRET=<production-oauth-secret>

# Environment
NODE_ENV=production
```

### Local Development Only

```bash
# Optional OAuth (for testing)
GITHUB_CLIENT_ID=<dev-oauth-id>
GITHUB_CLIENT_SECRET=<dev-oauth-secret>
GOOGLE_CLIENT_ID=<dev-oauth-id>
GOOGLE_CLIENT_SECRET=<dev-oauth-secret>

# NOTE: Telegram bot_token and chat_id are configured via User Settings UI, not env vars
```

## Worktree Isolation

Each git worktree has unique `.env.local` with different ports:

```bash
# master worktree
MOIRA_PORT=3030
DOCKER_PORT=3030
DOCKER_CONTAINER_NAME=mcp-moira-master

# dev worktree
MOIRA_PORT=3031
DOCKER_PORT=3031
DOCKER_CONTAINER_NAME=mcp-moira-dev

# dev2 worktree
MOIRA_PORT=3032
DOCKER_PORT=3032
DOCKER_CONTAINER_NAME=mcp-moira-dev2
```

This allows parallel development without port conflicts.

## Deployment Flow

### Production Server (${MOIRA_HOST})

1. **Build**: build passes `ENV_FILE=.env.production`
2. **Runtime**: Container reads copied `.env` file
3. **Supervisor**: Sets `NODE_ENV=production` for all processes
4. **Email**: BREVO_API_KEY present -> BrevoProvider for real emails

### Staging Server (moira.example.com)

1. **Build**: build passes `ENV_FILE=.env.production.staging` (via buildArgs)
2. **Runtime**: Container reads copied `.env` file
3. **Supervisor**: Sets `NODE_ENV=production`
4. **Email**: BREVO_API_KEY present -> BrevoProvider for real emails

### Local Docker

1. **Build**: `docker-build-and-run.sh` passes `ENV_FILE=.env.local`
2. **Runtime**: Container uses local `.env.local` file
3. **Supervisor**: Sets `NODE_ENV=production` (but BREVO_API_KEY absent)
4. **Email**: No BREVO_API_KEY -> TestEmailProvider for all emails

## Load Testing

### LOAD_TEST_SECRET

For running k6 load tests, set `LOAD_TEST_SECRET`:

```bash
# Generate a secure secret (minimum 16 characters)
LOAD_TEST_SECRET=$(openssl rand -hex 32)

# Add to .env file
echo "LOAD_TEST_SECRET=$LOAD_TEST_SECRET" >> .env.local
```

**The secret enables two features via unified `X-Load-Test` header:**

1. **Authentication bypass** - auto-verifies load test users
2. **Rate limit bypass** - skips rate limiting for stress tests

### How It Works

1. k6 test includes `X-Load-Test` header with the secret value in all requests
2. Backend validates header matches `LOAD_TEST_SECRET` env var
3. If valid:
   - User registration with `@load-testing-noverify.local` domain is auto-verified
   - Request skips rate limiting (apiLimiter, authLimiter, mcpLimiter)
4. Bypass events are logged for audit trail

```javascript
// k6 example
http.get(url, {
  headers: {
    "X-Load-Test": __ENV.LOAD_TEST_SECRET,
  },
});
```

**Security notes:**

- Use different secrets for each environment
- Secret must be at least 16 characters
- Only share with trusted load testing infrastructure
- Load test users are auto-verified and should be cleaned up periodically
- Rate limit bypass is logged with request details

**Usage in k6:**

```bash
docker compose -f docker-compose.k6.yml run --rm \
  -e TARGET_BASE_URL=http://host.docker.internal:3032 \
  -e LOAD_TEST_SECRET=your-secret-here \
  k6 run /scripts/scenarios/auth-test.js
```

### DISABLE_RATE_BYPASS

Set to `true` in k6 to disable bypass header and test rate limiting:

```bash
docker compose -f docker-compose.k6.yml run --rm \
  -e TARGET_BASE_URL=https://staging.example.com \
  -e DISABLE_RATE_BYPASS=true \
  k6 run /scripts/scenarios/rate-limit-test.js
```

When `DISABLE_RATE_BYPASS=true`:

- k6 does NOT include `X-Load-Test` header
- Server rate limiting is applied normally
- Used to verify rate limits work correctly (expect 429 responses)

## Security Notes

### Never Commit

- `.env.local` files (all worktrees)
- `.env.production.*` files
- Any files with API keys or secrets

### API Key Location

**BREVO_API_KEY**:

- ✅ `.env.production` (production server)
- ✅ `.env.production.staging` (staging server)
- ❌ `.env.local` (all worktrees - not needed)
- ❌ Git repository (never)

### Sync Across Worktrees

When adding new required variables, update:

1. `.env.local` in master worktree
2. `.env.local` in dev worktree
3. `.env.local` in dev2 worktree
4. `.env.production` if needed for production
5. `.env.production.staging` if needed for staging

## Verification Commands

### Check current environment

```bash
# In running container
docker exec <container-name> printenv | grep BREVO
docker exec <container-name> printenv | grep NODE_ENV
```

### Check which .env file was used

```bash
docker compose exec moira cat .env | head -5
```

### Test email behavior

```bash
# Check logs for email activity
docker exec <container-name> tail -f /var/log/supervisor/backend-api.log | grep Email

# Expected in local: "TEST MODE: Email logged (not sent)"
# Expected in production for test@example.com: "TEST MODE: Email logged (not sent)"
# Expected in production for real@user.com: Brevo API call
```
