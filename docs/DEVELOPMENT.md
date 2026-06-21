# Development Guide

## Setup

```bash
npm install

# Local environment — copy the template, then set BETTER_AUTH_SECRET.
# .env.local drives docker:restart and the container-backed test suites.
cp .env.local.example .env.local

# Docker
npm run docker:restart    # Build → Start → Wait for ready (reads .env.local)
npm run docker:stop       # Stop container

# Tests
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests
npm run test:api          # API tests (Docker required)
npm run test:e2e          # E2E tests (Docker required)

# Code Quality
npm run fix               # ESLint + Prettier fix all files
```

**All development happens through Docker containers.**

### Code Quality

**Linting and Formatting:**

- ESLint 9 flat config (`eslint.config.js`)
- Prettier with astro plugin (`.prettierrc`, `.prettierignore`)
- Pre-commit hook runs lint-staged (ESLint + Prettier)

**ESLint Rules:**

- Production: `@typescript-eslint/no-explicit-any: error`, `no-console: error`
- Tests/scripts: `any` allowed, console allowed
- `no-restricted-syntax`: blocks direct `process.env` access (use config module)
- E2E tests: `no-restricted-imports` enforces `./fixtures.js` over `@playwright/test`

**CI Checks (GitHub Actions):**

```bash
npx eslint .          # ESLint
npx prettier --check . # Prettier
```

**Configuration files:**

- `eslint.config.js` - ESLint 9 flat config (unified for all packages)
- `.prettierrc` - Prettier settings
- `.prettierignore` - Excluded from Prettier
- `.husky/pre-commit` - Git hook running lint-staged

### Docker Build Configuration

**Build IDs for cache isolation:**

The local build uses a `local` BUILD_ID for BuildKit cache isolation
(`docker compose up -d --build`).

**BUILD_INFO file:**

Every Docker image contains `/app/BUILD_INFO` with build metadata:

```
commit: aed4278
build_time: 2025-12-19T02:08:35.347Z
build_id: local
env_file: .env.example
```

Check the running version:

```bash
docker compose exec moira cat /app/BUILD_INFO
```

## Workflow Files

### Folder Structure

```
workflows/
├── production/           # Workflows included in Docker image
│   ├── public/           # Public workflows (visible to all users)
│   │   ├── quick-task.json
│   │   ├── robust-task.json
│   │   ├── verified-research.json
│   │   ├── iterative-research.json
│   │   └── ...
│   └── private/          # Private workflows (admin only)
│       ├── development-flow.json
│       ├── feature-completion-workflow.json
│       └── ...
└── backup/               # Old/archived workflows (NOT in Docker image)
```

### Catalog Structure

- `workflows/production/flows/<uuid>.json` → one file per flow, named by its UUID. Each file carries
  catalog metadata `owner` (owning user id) and `visibility` (`public` | `private`). Identity is
  `(owner, slug)` — a slug is unique only per owner. The bundled folder ships the **public** catalog;
  private flows are supplied as an additional catalog directory merged via `WORKFLOWS_DIRS` (below).
- `workflows/backup/` → Excluded from Docker image via `.dockerignore`

**Multiple catalog directories.** The catalog can be loaded from more than one base directory.
`WORKFLOWS_DIRS` (colon-separated, PATH-style) lists the directories to merge; it falls back to the
single `WORKFLOWS_DIR`, then to the bundled default `./workflows/production`. Directories are merged
by `readWorkflowCatalogs()` and de-duplicated by `(owner, slug)` — a **later** directory overrides an
earlier one on a collision, so a directory listed last can extend or shadow earlier ones. Unset →
single bundled directory (default).

### Migration Process

At Docker container startup, `scripts/migrate-workflows-in-docker.ts` runs:

1. Enumerates the merged catalog via `readWorkflowCatalogs(getWorkflowsDirs())` (see "Multiple catalog directories" above — one or more base directories, merged and de-duplicated by `(owner, slug)`)
2. Installs each flow under its catalog `owner` with its `visibility`
3. Skips and reports a flow whose `owner` does not exist on the target (never reassigns to a system owner)
4. Version-aware and idempotent; non-destructive (only touches flows it owns)

### Prompt Migration

At startup, `scripts/prompt-migration.ts` syncs `config/prompts/` files into `globalSettings` DB table:

- **First deploy (no manifest):** Records current DB hash as baseline. Does not overwrite existing DB values.
- **Subsequent deploys:** Compares file hash vs manifest hash. If file changed and DB value unchanged → updates DB. If DB was manually edited (DB hash ≠ manifest hash) → migration fails with conflict error (`process.exit(1)`), blocking service startup via sentinel.
- **Null safety:** Handles null `globalSetting.value` gracefully (skips hash comparison).
- **Atomicity:** All DB writes wrapped in `db.transaction()`.

Manifest stored in `config/prompts/manifest.json`.

### Adding New Workflows

```bash
# Add a flow to the catalog (file name = UUID). Set `owner` + `visibility` inside the JSON:
#   public showcase flow → "owner": "system-moira", "visibility": "public"
#   private internal flow → "owner": "system-admin", "visibility": "private"
cp my-workflow.json workflows/production/flows/

# Rebuild Docker to apply
npm run docker:restart
```

### Workflow CLI

```bash
# View structure
moira-workflow workflows/production/public/my-workflow.json structure --graph

# Search nodes
moira-workflow workflows/production/public/my-workflow.json search "pattern"

# Edit node
moira-workflow workflows/production/public/my-workflow.json update node-id --directive "new text"
```

## Project Structure

```
src/graph/core/     # UniversalGraphExecutor, ContextManager, EdgeResolver
src/graph/handlers/ # StartHandler, AgentDirectiveHandler, ConditionHandler, EndHandler, TelegramHandler
src/graph/storage/  # DatabaseRepository, InMemoryRepository (IDataRepository implementations)
src/graph/types/    # TypeScript definitions
packages/mcp-server/src/tools/     # MCP tool implementations
packages/mcp-server/src/messages/  # Centralized English messages (i18n ready)
src/server.ts       # StreamableHTTPServerTransport (stateless mode)
packages/web-backend/           # Express API server (internal port 4201)
packages/web-frontend/src/      # React UI components (static build served by nginx)
config/             # Docker deployment configuration
├── docker-compose.yml  # 4-service Docker setup
├── Dockerfile          # Single-stage Node.js build
├── supervisord.conf    # Process manager (init-database → services)
├── nginx.conf          # Reverse proxy configuration
├── environment.env     # Environment variables template
├── docker-deploy.sh    # Deployment automation script
└── prompts/            # File-based prompt storage (migrated to DB at startup)
    ├── systemPrompt.md
    ├── systemReminder.md
    ├── toolDescriptions/*.md  # MCP tool descriptions
    ├── errorMessages.json
    ├── validationHelp.json
    └── agents/           # Agent-specific prompt overrides
        └── {agent}/      # e.g., chatgpt/, cursor/
            ├── systemPrompt.md
            ├── systemReminder.md
            ├── toolDescriptions/*.md
            └── models/{model}/  # Model-level overrides
                └── *.md
tests/unit/         # Component tests
tests/integration/  # Workflow execution tests
scripts/
├── run-migrations.ts         # Drizzle ORM migrations
├── migrate-workflows-in-docker.ts  # Workflow JSON → DB migration
├── init-database.sh          # Migration wrapper with sentinel files
└── wait-for-init.sh          # Service startup gate (polls for sentinel)
```

## MCP HTTP Transport Architecture

### Streamable HTTP Transport (2025-03-26)

- **State-of-the-art**: Latest MCP specification transport
- **Stateless Mode**: Each request creates new transport (serverless compatible)
- **Single Endpoint**: POST `/mcp` for all JSON-RPC communication
- **Direct Tools**: MCP tools integrated in single process
- **Environment Variables**: Configured via process.env

### Transport Configuration

```typescript
// Stateless mode (no session management)
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless for scalability
});
```

### Tool Execution Flow

```
HTTP POST /mcp → JSON-RPC → Spawned Process → Tool Logic → JSON Response
```

### Environment Variables Pattern

```bash
# Set on HTTP server process
TELEGRAM_BOT_TOKEN=token
TELEGRAM_DEFAULT_CHAT_ID=chat_id

# Used by MCP server and tools via process.env
```

### Best Practices (2025)

- **Stateless Design**: No in-memory session storage for horizontal scaling
- **Service Integration**: Tools integrated in main process
- **Explicit Consent**: Tool descriptions treated as untrusted content
- **JSON-RPC 2.0**: Proper error handling with structured responses

## Node Handler Development

### Interface

```typescript
interface INodeHandler {
  getNodeType(): string;
  execute(
    node: GraphNode,
    context: ExecutionContext,
    input?: unknown,
  ): Promise<NodeExecutionResult>;
}
```

### Implementation Pattern

```typescript
export class MyNodeHandler implements INodeHandler {
  getNodeType(): string {
    return "my-node-type";
  }

  async execute(
    node: GraphNode,
    context: ExecutionContext,
    input?: unknown,
  ): Promise<NodeExecutionResult> {
    // Validation
    if (!isMyNode(node)) {
      throw new Error("Invalid node type");
    }

    // Processing logic

    // Return result
    return NodeResultBuilder.continue(node.id, "success", outputData);
  }
}
```

### Result Types

```typescript
NodeResultBuilder.pause(nodeId); // Pause for user input
NodeResultBuilder.continue(nodeId, outputPath, data); // Continue to next node
NodeResultBuilder.complete(nodeId, finalData); // End workflow
NodeResultBuilder.error(nodeId, errorMessage); // Fail execution
```

## Handler Behavior (Code Facts)

### StartNodeHandler

- **Auto-execution** - immediately continues
- **Data merge** - combines initialData + input → context
- **Output path** - always 'default'

### AgentDirectiveHandler

- **Pause behavior** - pauses for user input when no input provided
- **Template processing** - processes templates in directive/completionCondition
- **Validation** - validates input against inputSchema
- **Retry logic** - maxRetries (default: 3) with retry counter

### ConditionHandler

- **Auto-execution** - immediately evaluates and continues
- **Operators** - 10 supported: eq, neq, gt, gte, lt, lte, contains, exists, and, or, not
- **Output paths** - 'true' or 'false' based on evaluation
- **Context access** - resolves {{contextPath}} references

### TelegramNotificationHandler

- **Auto-execution** - sends message and continues
- **Template processing** - processes templates in message
- **Rate limiting** - built-in Telegram API compliance
- **Error handling** - graceful degradation on failures with actionable error messages via messageQueue
- **Error classification** - `classifyTelegramError()` and `getActionableTelegramErrorMessage()` provide structured error types and user-friendly messages

### EndNodeHandler

- **Auto-execution** - collects data and completes
- **Data collection** - finalOutput array or all variables
- **Completion signal** - returns 'complete' action

### ExpressionNodeHandler

- **Auto-execution** - evaluates expressions and continues
- **Sandboxed parser** - custom arithmetic parser, NOT JavaScript eval
- **Operations** - `+`, `-`, `*`, `/`, parentheses
- **Assignment** - `result = a + b`, context path access
- **Error handling** - division by zero and undefined variables route to `error` connection

### LockHandler

- **Pause behavior** - creates lock and pauses execution until unlocked
- **PIN generation** - 6-digit PIN via crypto.randomInt; stored as a scrypt hash (`scrypt$<saltHex>$<hashHex>`) via `hashPin()`, verified with `verifyPin()` (constant-time). Plaintext PIN is returned once at lock creation, never persisted.
- **Telegram notification** - sends lock reason + PIN with inline approve button
- **Unlock sources** - MCP tool, web UI button, Telegram callback webhook
- **Single connection** - only "unlocked" path (no rejection or expiration)

## Testing

### Test Structure

```typescript
describe("Feature", () => {
  let executor: UniversalGraphExecutor;
  let repository: InMemoryRepository;

  beforeEach(async () => {
    // Global helper - no imports needed
    const setup = await createTestExecutor();
    repository = setup.repository;
    executor = setup.executor;
  });

  test("should execute workflow", async () => {
    const workflow = await repository.getWorkflowGraph("test-workflow", TEST_USER_ID);
    const processId = await executor.startWorkflow(workflow, undefined, TEST_USER_ID);
    const result = await executor.executeStep(processId, input);
    expect(result).toContain("expected");
  });
});
```

### Test Commands

```bash
npm test                          # All tests

# By category
npm run test:unit [path]          # Unit tests (in-memory)
npm run test:integration [path]   # Integration (test-integration.db)
npm run test:api [path]           # API (Docker required)
npm run test:mcp-tools [path]     # MCP tools (Docker required)
npm run test:e2e [path]           # E2E browser (Docker required)
```

Full documentation: `tests/TESTING-GUIDE.md`

## Web UI Development Process

### Startup Sequence

```bash
npm install            # Install dependencies first
npm run docker:restart # Build and start Docker container
```

**Result:** All services available at http://localhost:${DOCKER_PORT} (from .env.local)

### Verification Steps

1. Check health: `curl http://localhost:${DOCKER_PORT}/startup-ready`
2. Open UI: `http://localhost:${DOCKER_PORT}/app`
3. **MANDATORY**: Run E2E tests after ANY changes: `npm run test:e2e`

## Web UI Testing Protocol

### After ANY Web UI Changes

```bash
# 1. Rebuild Docker
npm run docker:restart

# 2. MANDATORY: E2E tests
npm run test:e2e
```

**Testing checklist:**

- [ ] Workflow list loads
- [ ] Workflow visualization displays
- [ ] Node details work on click
- [ ] Backend API responds correctly

## Frontend-Backend Architecture

### Docker Container

All services run inside single Docker container managed by supervisord:

- **Port**: DOCKER_PORT from .env.local
- **Frontend**: `/app/*` → static files (nginx)
- **Backend API**: `/api/*` → Express server
- **MCP Server**: `/mcp/*` → MCP HTTP server

**Service Startup Order:**

```
init-database (priority 10) → sentinel file → services (priority 50)
```

`scripts/init-database.sh` runs DB migrations first, writes `/tmp/init-success` on completion. All services (`mcp-server`, `backend-api`, `nginx`) wait for this sentinel via `scripts/wait-for-init.sh` before starting. If migrations fail, `/tmp/init-failed` is written and services refuse to start.

### Request Flow

```
Browser → nginx:80 → internal services
```

## Debugging

### Storage Inspection

```bash
ls -la .graph-storage/executions/              # Active processes
cat .graph-storage/executions/<uuid>.json      # Process state
jq '.globalContext.variables' <uuid>.json      # Context variables
```

### Execution Tracing

```bash
# Check Docker logs for debugging
docker logs ${DOCKER_CONTAINER_NAME}
```

### Common Issues

**Template Variables Null**

- Cause: Variable not in context when template processed
- Fix: Check variable availability timing

**Validation Failures**

- Cause: Input doesn't match inputSchema
- Fix: Review schema requirements vs actual input

**Connection Errors**

- Cause: Invalid node ID in connections
- Fix: Verify all connection targets exist

**Condition Failures**

- Cause: Type mismatch in operands
- Fix: Ensure consistent types (string vs number)

## Code Standards

### TypeScript

- Strict mode enabled
- No `any` types
- Proper interface implementation
- Type guards for node types
- Exhaustive switch/if-else checks using `never` type for all dispatch patterns (e.g., node type handlers). Every switch/map must have a default branch with `const _exhaustive: never = value` to catch unhandled cases at compile time.

### Error Handling

**Unified Error Hierarchy** (`@mcp-moira/shared`):

```typescript
import {
  ValidationError, // 400 - invalid input
  NotFoundError, // 404 - resource not found
  AuthenticationError, // 401 - invalid credentials
  AuthorizationError, // 403 - insufficient permissions
  ConflictError, // 409 - resource conflict
  RateLimitError, // 429 - rate limit exceeded
  DatabaseError, // 500 - DB failures
  ConfigurationError, // 500 - missing config
  ExternalServiceError, // 502 - external API failures
  InternalError, // 500 - unexpected errors
  normalizeError,
  isOperationalError,
} from "@mcp-moira/shared";

// Throw typed errors (execution layer)
throw new ValidationError("Invalid workflow ID", { workflowId });
throw new NotFoundError("Workflow not found", { workflowId });

// Normalize unknown errors (boundary layer)
const appError = normalizeError(unknownError);

// Check error type for logging level
const level = isOperationalError(error) ? "warn" : "error";
```

**Error Types**:

- `isOperational=true` (WARN): Expected errors - validation, not found, auth
- `isOperational=false` (ERROR): Programmer errors - DB, config, internal

**For node handlers** (workflow-engine):

```typescript
// Return structured errors, don't throw
return NodeResultBuilder.error(nodeId, "Specific error message");

// Log errors properly
this.logger.error("Operation failed", error, { context });
```

### Context Management

```typescript
// Safe context updates
context.variables.newField = value;
context.nodeStates[nodeId] = nodeData;

// Avoid full replacement
// context.variables = {}; // WRONG - loses data
```

## Hot Reload

### Auto-Reload (No Restart)

- Workflow JSON file changes
- Test file modifications
- Web UI code changes

### Restart Required

- Core engine changes (`src/graph/`)
- MCP tool modifications
- Server configuration changes

### Restart Process

```bash
npm run docker:stop     # Stop container
npm run docker:restart  # Rebuild and restart
```

## Testing Strategy

### Development Testing

```bash
npm run docker:restart  # Rebuild Docker
npm run test:e2e        # Run E2E tests
# Access: http://localhost:${DOCKER_PORT}/app
```

### MCP Servers

| Server        | URL                       | Purpose                  |
| ------------- | ------------------------- | ------------------------ |
| `moira-local` | http://localhost:8080/mcp | Local Docker development |

### Test Execution

```bash
npm test                  # All tests
npm run test:api          # API tests
npm run test:mcp-tools    # MCP tests
npm run test:e2e          # E2E browser tests
```

Docker commands route through configured context: `tests/utils/docker-command.ts`.

### MCP Version Check

Server validates client MCP tools version on each request. OAuth tokens store `toolsVersion` at authorization time.

**Behavior:**

- Token version matches server version → request proceeds
- Token version differs or null → HTTP 426 Upgrade Required with reconnect instruction

**After deploy with version bump:**

```bash
# Client receives HTTP 426 error with message:
# "MCP server updated to vX.Y.Z. Run '/mcp reconnect moira' to refresh tools."

# In Claude Code:
/mcp reconnect moira-local  # Local Docker
```

**Version source:** Root `package.json` version field

## Validation Rules (Code Facts)

### Graph Validation

- **Required nodes** - At least one start and one end node
- **Unique IDs** - All node IDs must be unique
- **Connection targets** - All connection references must exist
- **Node types** - Only supported types allowed

### Performance Warnings

- **20+ agent-directive nodes** - Warning in validator (not limit)

### Retry Logic

- **maxRetries default** - 3 attempts for agent-directive nodes
- **Configurable per node** - Can override default
