# MCP Moira

Agent Workflow Engine for AI agents.

**Primary users:** AI agents via MCP protocol. Web UI is supplementary for workflow management.

See [docs/VISION.md](docs/VISION.md) for product vision and design principles.

## Two ways to run Moira

- **Self-host (this repository, Apache-2.0)** — run the full engine + Web UI + MCP
  server in a single Docker container on your own infrastructure. Free and open
  source; your data stays with you. Start in the [Quick Start](#self-host-recommended)
  below.
- **Moira Cloud (managed)** — a hosted instance with nothing to operate, at
  [moira-mcp.com](https://moira-mcp.com).

Both run the **same engine and MCP tools**. Self-host is a single-tenant
private-team deployment with administrator-approved accounts. Cloud adds managed
hosting and SaaS-only policy and administration, including social login, legal
consent, email verification, and the broader multi-user administration surface.

## Architecture

**Monorepo**: Clean separation of concerns with npm workspaces
**Workflow Engine**: Node-graph execution over a set of node types (@mcp-moira/workflow-engine)
**MCP Server**: HTTP protocol server exposing the MCP tools (@mcp-moira/mcp-server)
**Web Backend**: Express API server (@mcp-moira/web-backend)
**Web Frontend**: React UI with webpack (@mcp-moira/web-frontend)
**Docs**: Astro 5 + Starlight documentation site, EN+RU (@mcp-moira/docs)
**Shared**: Database layer + Better Auth + logging (@mcp-moira/shared)
**Database**: Modular repository pattern with Drizzle ORM
**Settings System**: Universal settings with encryption and dynamic UI generation
**Docker Deployment**: Multi-stage container with TypeScript validation
**Validation**: JSON Schema with AJV

### Package Structure

- **packages/workflow-engine/** - Core node-graph execution engine
- **packages/mcp-server/** - MCP protocol HTTP server with tools
- **packages/web-backend/** - Express API for workflow management
- **packages/web-frontend/** - React UI for workflow visualization
- **packages/docs/** - Astro 5 + Starlight documentation site (EN+RU), built into the image and served at `/docs`
- **packages/shared/** - Database layer (schema, connection, repositories) + Better Auth + logging
  - `database/` - Modular repositories (Workflow, Execution, Settings)
  - `auth/` - Better Auth configuration
  - `logging/` - Structured logging
- **Docker Config** (`config/`) - Unified container deployment configuration

## Quick Start

### Self-Host (recommended)

Run a complete Moira instance locally with Docker — no source build required:

```bash
cp .env.example .env       # defaults work locally; review host, port, and artifact domain for another host
docker compose up -d
```

Then open:

- **Web UI**: http://localhost:8080
- **Documentation**: http://localhost:8080/docs/
- **MCP endpoint**: http://localhost:8080/mcp

The image is pulled from the public registry by default. Data (SQLite + execution
storage) persists in `./data`. See [Self-Hosting](#self-host-recommended) or the in-app docs
at `/docs/` for the full reference.

### Updating / Upgrading

Update a normal self-host installation with the standard Compose commands:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

Older `.env` files may still override Compose with the removed `0.3.5` tag; change that line once to
`MOIRA_IMAGE=ghcr.io/moira-mcp/moira:latest` before updating.

The image protects existing self-host data before its startup migrations: it creates and verifies a
coherent SQLite backup, includes the prompt manifest, and keeps three rotating recovery states under
`data/.moira-startup-backups/`. If initialization fails, it restores the database and manifest before
refusing to start the services. A persistent pending marker also restores the verified state before the
next attempt if the container or host was interrupted mid-initialization. A fresh installation skips
the nonexistent-database backup and uses only a temporary persistent marker so an interrupted first
start is removed before retry.

The complete automatic recovery behavior and optional pinned-image preflight are documented in
[Self-hosting: Updating and Recovery](packages/docs/src/content/docs/docs/getting-started/self-hosting.mdx#updating-and-recovery), with a matching [Russian version](packages/docs/src/content/docs/ru/docs/getting-started/self-hosting.mdx#обновление-и-восстановление). Release notes are on the [GitHub Releases](https://github.com/moira-mcp/moira/releases) page.

### Local Development (from source)

For contributors who want to build and run from the source tree, switch
`docker-compose.yml` to **Option B** first — comment out the `image:` line and
uncomment the `build:` block (the file documents both options inline). Then:

```bash
npm install
docker compose up -d --build   # builds the image locally from config/Dockerfile
# Web UI: http://localhost:8080  |  MCP: http://localhost:8080/mcp
```

(The default `docker-compose.yml` uses the prebuilt public image — `docker compose
up -d` without `--build` — which is the recommended self-host path.)

### Testing

The integration/API/E2E suites run against a local Docker container, configured by
`.env.local`. Copy the template once before running them (or before
`npm run docker:restart`):

```bash
cp .env.local.example .env.local   # then set BETTER_AUTH_SECRET
npm test              # All tests
npm run test:unit     # Unit tests only (no container needed)
npm run test:e2e      # E2E tests
```

### Code Quality

```bash
npm run fix                   # ESLint + Prettier fix all files
```

**Configuration in `.env`** (copy from `.env.example`):

- MOIRA_PORT: External access port (default 8080)
- MOIRA_HOST: Public host:port the instance is served on (default localhost:8080)
- STATIC_ARTIFACTS_DOMAIN: Wildcard subdomain base for published artifacts
- BETTER_AUTH_SECRET: generated and persisted on first start when empty; set it
  explicitly only when you want to manage the auth signing secret yourself
- Database: SQLite at `./data/moira.db` (bind-mounted, persists across restarts)
- Admin: ADMIN_EMAIL, ADMIN_PASSWORD (auto-generated on first start if unset)

## Authentication

MCP Moira uses Better Auth with OAuth 2.1 for centralized authentication.

**Browser Access:**

- Email/password login at http://localhost:8080/login
- GitHub/Google OAuth (saas mode only; disabled in self-host)
- Better Auth UI components (Tailwind + shadcn/ui)

**MCP Clients:**

- OAuth 2.1 authorization code flow
- HTTP 401 triggers OAuth discovery
- Dynamic Client Registration (DCR) supported
- Access token required for all MCP tool calls

**Protected:**

- All MCP tools require authentication
- All API routes (/api/_) require authentication (except /api/auth/_)
- Centralized protection via middleware (no manual checks)

**Testing:**

```bash
docker compose up -d
# Access:        http://localhost:8080/login
# MCP Inspector: http://localhost:8080/mcp
```

See [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for complete setup and OAuth flow details.

### MCP Configuration

Point your MCP client (e.g. Claude Code) at your running instance:

| Server        | URL                       | Purpose                       |
| ------------- | ------------------------- | ----------------------------- |
| `moira-local` | http://localhost:8080/mcp | Your local self-host instance |

```json
{
  "mcpServers": {
    "moira-local": { "url": "http://localhost:8080/mcp" }
  }
}
```

> Replace `localhost:8080` with your own host/port (`MOIRA_HOST`) if you serve Moira
> on a different address.

## Representative Node Examples

The examples below show common graph patterns; they are not the complete node-type inventory. See
the [Nodes reference](packages/docs/src/content/docs/docs/concepts/nodes.mdx) for every supported
type and its current contract, including automatic note operations and file materialization.

### Start Node

```json
{
  "type": "start",
  "id": "start",
  "connections": { "default": "next-node-id" }
}
```

### Agent Directive Node

```json
{
  "type": "agent-directive",
  "id": "task",
  "directive": "Task instruction",
  "completionCondition": "Success criteria",
  "inputSchema": {/* JSON Schema */},
  "connections": { "success": "next-node-id" }
}
```

### Condition Node

```json
{
  "type": "condition",
  "id": "check",
  "condition": {
    "operator": "gte",
    "left": { "contextPath": "score" },
    "right": 8
  },
  "connections": {
    "true": "success-path",
    "false": "failure-path"
  }
}
```

### Telegram Notification Node

```json
{
  "type": "telegram-notification",
  "id": "notify",
  "message": "Task completed: {{result}}",
  "chatId": "{{user_chat_id}}",
  "connections": { "default": "next-node-id" }
}
```

### End Node

```json
{
  "type": "end",
  "id": "end",
  "finalOutput": ["result", "score"]
}
```

### Expression Node

```json
{
  "type": "expression",
  "id": "increment-counter",
  "expressions": ["counter = counter + 1"],
  "connections": { "default": "next-step" }
}
```

### Teleport Node

```json
{
  "type": "teleport",
  "id": "teleport-replan",
  "directive": "Rewrite the development plan",
  "completionCondition": "New plan created",
  "hint": "Use when plan needs restructuring",
  "connections": { "success": "plan-node" }
}
```

### Subgraph Node

```json
{
  "type": "subgraph",
  "id": "run-subtask",
  "graphId": "subtask-workflow",
  "inputMapping": { "parentVar": "subVar" },
  "outputMapping": { "subResult": "parentResult" },
  "connections": { "success": "next-step" }
}
```

### Lock Node

```json
{
  "type": "lock",
  "id": "approval-gate",
  "reason": "Waiting for user approval before deployment",
  "connections": { "unlocked": "next-step" }
}
```

Pauses execution until explicitly unlocked. Sends PIN via Telegram with inline approve button. Unlockable via MCP tool, web UI, or Telegram callback.

## Workflow Format

```json
{
  "id": "workflow-id",
  "metadata": {
    "name": "Workflow Name",
    "version": "1.0.0",
    "description": "What this workflow does"
  },
  "nodes": [/* Node definitions */]
}
```

## Templates

Variables processed in `directive`, `completionCondition`, and `message` fields:

- `{{variable}}` - Context variable
- `{{nested.path}}` - Object property access
- `{{executionId}}` - System: current process ID
- `{{workflowId}}` - System: current workflow ID

## MCP Tools

```bash
# Workflow Management
list
start {"workflowId": "workflow-id"}
step {"processId": "process-id", "input": "data"}
manage {"action": "create", "workflow": {...}}
manage {"action": "edit", "workflowId": "workflow-id", "changes": {...}}
manage {"action": "get", "workflowId": "workflow-id"}

# Session Information
session {"action": "user"}
session {"action": "executions"}
session {"action": "execution_context", "executionId": "execution-id"}
session {"action": "current_step", "executionId": "execution-id"}

# Execution Locking
lock {"action": "lock", "executionId": "execution-id", "reason": "Awaiting approval"}
lock {"action": "unlock", "executionId": "execution-id", "pin": "123456"}
lock {"action": "status", "executionId": "execution-id"}
lock {"action": "list"}

# User Settings
settings {"action": "get"}
settings {"action": "get", "category": "ui"}
settings {"action": "set", "key": "ui.theme", "value": "dark"}
settings {"action": "list"}

# Workflow Tokens
token {"action": "upload", "ttlMinutes": 60}
token {"action": "download", "workflowId": "workflow-id", "ttlMinutes": 60}

# Documentation
help
help {"topic": "tools"}
help {"topic": "step"}
```

## File Structure

```
packages/workflow-engine/  # Core execution engine
packages/mcp-server/       # MCP HTTP server (internal port, behind nginx)
packages/web-backend/      # Express API (internal port, behind nginx)
packages/web-frontend/     # React UI (static build served by nginx)
data/                      # SQLite database (moira.db)
workflows/                 # Bundled public workflow catalog
docs/                      # Technical documentation
```

## Development

All development happens through Docker containers.

```bash
docker compose up -d --build  # Build and run the container
npm test                      # Run all tests
npm run fix                   # ESLint + Prettier fix
```

**Database**: SQLite at DB_PATH (default: ./data/moira.db)
**Migrations**: Drizzle ORM (`npx tsx scripts/run-migrations.ts`)
**Storage**: Workflows and executions in database with user isolation

## Documentation

**User Documentation**: Served by your running instance at `/docs/` (EN) and `/ru/docs/` (RU), built from `packages/docs` (Starlight).

**Technical Documentation**: `/docs` directory - system reference, API specs, development guides.

**[Project Checklist](docs/PROJECT_CHECKLIST.md)** - mandatory pre-commit checks executed by development workflows.

## Claude Code Commands

Custom slash commands in `/commands` directory. See [commands/README.md](commands/README.md) for installation and usage.

## HTTP Transport

### Architecture

- **Stateless Mode**: Each HTTP request creates new transport, no session storage
- **JSON-RPC 2.0**: MCP protocol over HTTP with proper error handling
- **Direct Tools**: MCP tools integrated in single process
- **Environment Inheritance**: HTTP server environment variables passed to tools

### Endpoints

```http
POST /mcp     # JSON-RPC requests (tools calls)
GET  /health  # Server health check
```

### Environment Variables

```bash
# Required for Telegram integration
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_DEFAULT_CHAT_ID=your_chat_id

# Optional
MCP_PORT=4202  # Internal MCP server port (accessed via nginx proxy)
LOG_LEVEL=info
DEBUG_CONSOLE=true  # Console logging for development
WORKFLOWS_DIR=./packages/web-backend/workflows/production
```

## Configuration

MCP server configuration (see [MCP Configuration](#mcp-configuration) for details):

```json
{
  "mcpServers": {
    "moira-local": {
      "url": "http://localhost:8080/mcp",
      "type": "http"
    }
  }
}
```

Environment variables passed via HTTP headers (recommended for HTTP transport).

Alternative: Set environment variables in your `.env` file.

## Code Quality

### ESLint + Prettier

Project uses ESLint with TypeScript support and Prettier for code formatting.

```bash
npm run fix   # Auto-fix lint errors and format code
```

**Pre-commit Hook:**
Husky pre-commit hook automatically runs ESLint and Prettier on staged files.

**Configuration:**

- `.eslintrc.json` - ESLint rules (strict for production code, relaxed for tests)
- `.prettierrc` - Prettier formatting rules
- Production code: `any` types are errors, must be properly typed
- Test code: `any` types allowed for flexibility

## Security

### Rate Limiting

Protection against spam and DoS attacks with tiered limits:

- **API routes** (`/api/*`): 100 requests/minute
- **Auth routes** (`/api/auth/*`): 100 requests/minute
- **MCP endpoint** (`/mcp`): 30 requests/minute

Exceeded limits return HTTP 429 Too Many Requests.

### Data Size Limits

Protection against oversized payloads:

- **Workflow JSON**: max 5MB
- **Execution context**: max 10MB

Exceeded limits return HTTP 413 Payload Too Large.

### GeoIP Logging

Request logging includes country detection via geoip-lite:

```json
{
  "method": "POST",
  "path": "/api/workflows",
  "ip": "203.0.113.1",
  "country": "US",
  "duration": 45,
  "status": 200
}
```

## Admin Features

### User Management

Admin panel at `/admin/users` provides:

- **User list** with approval, email verification, and blocked status
- **User details** page with sessions, OAuth connections, email history
- **Approve** pending self-host registrations
- **Session management** - revoke individual sessions or all sessions
- **OAuth management** - revoke tokens by provider or all OAuth connections
- **Block/Unblock** users with reason
- **Send verification email** manually
- **Send password reset email** manually
- **Set a temporary password** for an ordinary user when email delivery is unavailable

### Execution Monitoring

The Cloud `multiUserAdmin` capability enables the cross-user panel at `/admin/executions`. It is
server-denied and hidden by the default self-host policy:

- View all user executions
- Filter by user, status
- Search by execution ID or workflow ID
- Inspect execution context and variables

### Email History

Track every email attempt:

- Verification emails
- Password reset emails
- Notifications
- Status (`sent`, `failed`, or log-only `logged`) with error messages

## Email Features

### Email Verification (SaaS)

- Verification email sent on SaaS signup; self-host registration uses
  administrator approval instead
- Link expires in 24 hours
- Admin can resend manually

### Password Reset

- With a real SMTP or Brevo provider, the user requests via `/forgot-password`
  and receives a reset link
- Link expires in 1 hour
- Without real delivery, the reset form and email-send actions report the
  capability as unavailable; an administrator can set a temporary password for
  an ordinary user and require replacement at the next login

### Email Provider

Configured via environment variables:

```bash
EMAIL_PROVIDER=smtp          # smtp, brevo, auto, none, or explicit test sink
EMAIL_FROM=noreply@domain    # Required for real delivery
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_REQUIRE_TLS=true
# SMTP_USER and SMTP_PASSWORD are optional, but must be supplied together
```

Real delivery supports generic SMTP and Brevo. With `EMAIL_PROVIDER=auto` (or
unset), a complete SMTP configuration takes precedence and a legacy
`BREVO_API_KEY` plus `EMAIL_FROM` configuration remains supported. The explicit
`test` provider logs messages and is never advertised as real delivery.

## Documentation Map

Where things are documented. After changing code, find the area below and update
the matching file in the same change.

### Public docs — `packages/docs/src/content/docs/docs/` (EN) + `…/ru/docs/` (RU)

Rendered to the docs site (`/docs`) and read by users. Each EN page has an RU mirror.

| Area            | Covers                                                                                  | Path               |
| --------------- | --------------------------------------------------------------------------------------- | ------------------ |
| Getting started | Introduction, quickstart, self-hosting                                                  | `getting-started/` |
| Concepts        | Workflows, nodes, templates, notes, artifacts                                           | `concepts/`        |
| Guides          | Writing directives, creating & editing workflows                                        | `guides/`          |
| Reference       | Tools, input schema, magic variables, condition operators, validation, workflow catalog | `reference/`       |
| Integration     | MCP clients, Claude Code, agent guide, Telegram setup, troubleshooting                  | `integration/`     |
| Patterns        | Branching, validation loop, escalation, subagent review, workspace, and more            | `patterns/`        |

### Internal docs — `docs/`

For contributors working on the codebase (implementation detail, not end-user docs).

| File                   | Covers                                               | Path                                                              |
| ---------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Development setup      | Build, Docker, local dev, project structure          | `docs/DEVELOPMENT.md`                                             |
| Testing                | Test types, runner, fixtures, antipatterns           | `docs/TESTING.md` + `docs/testing/`                               |
| API                    | Backend & admin HTTP API reference                   | `docs/API.md`                                                     |
| System architecture    | Engine, storage, MCP transport, handlers, validation | `docs/SYSTEM.md`                                                  |
| Authentication         | Better Auth, OAuth 2.1, API tokens                   | `docs/AUTHENTICATION.md`                                          |
| Web UI                 | Frontend architecture, components                    | `docs/WEB-UI.md`                                                  |
| Audit system           | Audit logging design                                 | `docs/AUDIT-SYSTEM.md`                                            |
| Workflows              | Workflow authoring, tools, catalog                   | `docs/WORKFLOW.md`, `docs/WORKFLOWS.md`, `docs/WORKFLOW-TOOLS.md` |
| Design system          | UI design tokens and components                      | `docs/DESIGN-SYSTEM.md`                                           |
| Documentation style    | How to write internal **and** public docs            | `docs/DOCUMENTATION-STYLE-GUIDE.md`                               |
| Logging                | Structured logging conventions                       | `docs/LOGGING.md`                                                 |
| Issue management       | GitHub issue conventions                             | `docs/ISSUE-MANAGEMENT.md`                                        |
| Architecture decisions | ADRs (licensing, OSS model, …)                       | `docs/adr/`                                                       |
| Deployment             | Environment variables, restart procedures            | `docs/deployment/`                                                |
| Legal                  | License/legal notes                                  | `docs/legal/`                                                     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the PR flow, DCO sign-off, and how
releases are automated (Conventional Commits → semantic-release → versioned GHCR
image). For upgrading a self-host instance, see [Updating / Upgrading](#updating--upgrading).

## License

[Apache License 2.0](LICENSE)
