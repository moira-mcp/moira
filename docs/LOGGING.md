# Logging Standards

## RULE: console.log/console.error ARE FORBIDDEN

**ALL logs go ONLY through the logger from @mcp-moira/shared!**

The ESLint rule `no-console: "error"` blocks `console.*` in production code.

Exceptions (eslint overrides):

- `tests/**/*.ts` - test files
- `scripts/**/*.ts` - CLI scripts
- Files with `/* eslint-disable no-console */`:
  - CLI tools (MCP server cli.ts)
  - Frontend files for browser debugging (error boundaries, API errors, theme/layout persistence)

## Using the Logger

### Import

```typescript
import { createLogger, Component } from "@mcp-moira/shared";

const logger = createLogger({
  component: Component.Workflow, // or Auth, Database, MCP, etc.
});
```

**Note:** The service is resolved automatically from a process-global variable that is set when the service starts (see "Service Identifiers").

### HTTP Request Logging (Express)

```typescript
import { requestLogger, geoipLogger, createLogger, Component } from "@mcp-moira/shared";

const httpLogger = createLogger({ component: Component.HTTP });
app.use(requestLogger({ logger: httpLogger }));
app.use(geoipLogger());
```

Logs all HTTP requests via morgan:

```
2025-10-18 02:19:28.636 [INFO] [web-backend] [HTTP] POST /api/auth/sign-up/email 200 164.785 ms
2025-10-18 02:19:30.123 [INFO] [web-backend] [HTTP] GET /api/workflows 200 45.231 ms
```

### Request Body Logging

POST/PUT/PATCH request bodies logged at debug level for debugging:

```typescript
import { requestBodyLogger } from "./middleware/request-body-logger.js";

app.use(express.json());
app.use(requestBodyLogger()); // Must be after express.json()
```

**Features:**

- Logs POST, PUT, PATCH bodies only
- Excludes sensitive endpoints: `/api/auth/**`, `/api/user/change-password`, `/api/public/workflows`
- Truncates bodies > 10KB
- Correlates with X-Request-ID header

**Log format (debug level):**

```
2025-12-24 15:00:00.000 [DEBUG] [web-backend] [HTTP] Request body {"requestId":"abc-123","method":"POST","path":"/api/workflows","bodySize":256,"body":"{...}"}
```

**Enable in production:** Set `LOG_LEVEL=debug` (default: info).

### GeoIP Logging

```typescript
import { geoipLogger } from "@mcp-moira/shared";

app.use(geoipLogger());
```

Logs IP address and country for each request:

```
Request from 192.168.1.1 (RU)
Request from 10.0.0.1 (unknown)
Request from ::1 (unknown)
```

Uses the geoip-lite database for country lookup.

### Audit Logging

```typescript
import { AuditRepository } from "@mcp-moira/shared";

const auditRepo = new AuditRepository(getDatabase());

await auditRepo.log({
  userId: "user-id",
  action: "workflow:create",
  resource: "workflow",
  resourceId: "workflow-id",
  ip: "192.168.1.1",
  country: "US",
  userAgent: "Mozilla/5.0...",
  metadata: JSON.stringify({ key: "value" }),
});
```

Actions are defined in the type-safe `AuditAction` enum (`packages/shared/src/audit/actions.ts`).
They cover, by area:

- **Auth** — `AUTH_SIGN_UP`, `AUTH_SIGN_IN`, `AUTH_SIGN_OUT`
- **User profile** — password change, profile update, session/OAuth-consent revocation
- **Workflow** — `WORKFLOW_CREATE`, `WORKFLOW_EDIT`, `WORKFLOW_DELETE`, `WORKFLOW_RESTORE`, `WORKFLOW_HARD_DELETE`
- **Execution** — start/step/complete/fail/cancel/delete, context updates, and failed-attempt events for observability
- **Settings** — `SETTINGS_SET`, `SETTINGS_DELETE`
- **Notes** — create/update/delete/restore/hard-delete plus read operations (list/get/history/stats)
- **Artifacts** — create/update/delete/list/get/stats, token creation, abuse reporting
- **Tokens** — `TOKEN_CREATE`, `TOKEN_REVOKE`
- **Locks** — `LOCK_CREATE`, `LOCK_UNLOCK`, `LOCK_ATTEMPT_FAIL`
- **OAuth consent** — `OAUTH_CONSENT_GRANT`, `OAUTH_CONSENT_UPDATE`
- **Workflow sharing** — invite create/accept/revoke, access revoke
- **MCP read operations** — workflow list, session info, settings read, token create, help request, notes list
- **Admin** — user management, security actions (force reset, session/OAuth revocation), execution-context updates, database operations (vacuum/backup), settings and global-settings management, artifact moderation (takedown, list reported), and system-wide operations

All actions use the type-safe `AuditAction` enum from `@mcp-moira/shared`.

Query audit logs:

```typescript
// List logs for user
const logs = await auditRepo.listAuditLogs({
  userId: "user-id",
  limit: 50,
  offset: 0,
});

// Filter by action
const authLogs = await auditRepo.listAuditLogs({
  action: "auth:sign_in",
  limit: 50,
});

// Get specific entry
const entry = await auditRepo.getAuditLog("log-id");
```

Auth events are logged via Better Auth hooks in `better-auth-config.ts`. Other events are logged at the API route level.

### Client-side Error Logging

Frontend errors are sent to the backend for centralized logging via `/api/logs/client`.

**Endpoint:** `POST /api/logs/client`

```typescript
// Request body
{
  "level": "error" | "warn" | "info" | "debug",
  "message": "Error description",
  "stack": "Error stack trace",      // optional, max 50000 chars
  "url": "https://...",              // optional, current page URL
  "userAgent": "Mozilla/5.0...",     // optional
  "timestamp": "2025-01-15T...",     // optional, ISO 8601
  "metadata": { "key": "value" }     // optional
}
```

**Batch endpoint:** `POST /api/logs/client/batch` - up to 100 entries at once.

**Log format in Winston:**

```
2025-01-15 12:00:00.000 [ERROR] [web-frontend] Unhandled error: TypeError {
  "type": "client_log",
  "url": "https://moira.example.com/workflows",
  "userAgent": "Mozilla/5.0...",
  "stack": "TypeError: Cannot read...\n    at Component..."
}
```

**Grafana/Loki filter:** `service="web-frontend" type="client_log"`

**Frontend integration:** Global error handlers capture `window.onerror` and `unhandledrejection` events. Logs are buffered (5 sec, max 20 entries) and flushed on errors, page unload, or visibility change.

### Email Error Logging

```typescript
import { createLogger, EmailErrorType } from "@mcp-moira/shared";

const logger = createLogger({ component: "email" });
```

Email errors are classified and logged for Grafana/Loki visibility:

```
2025-01-15 12:00:00.000 [ERROR] [shared] [email] Email send failed {
  "emailType": "verification",
  "recipient": "jo***@example.com",
  "errorType": "rate_limit",
  "errorDetails": "Rate limit exceeded, retry after delay",
  "provider": "brevo"
}
```

**Error Types (EmailErrorType enum):**

- `rate_limit` - HTTP 429 (too many requests)
- `quota_exceeded` - Daily sending limit reached
- `auth_error` - Invalid API key (HTTP 401/403)
- `invalid_recipient` - Bad email address (HTTP 400)
- `network_error` - Connection issues (ECONNREFUSED, ENOTFOUND, ETIMEDOUT)
- `unknown` - Other errors

**Email masking**: Recipient emails are masked for privacy (first 2 chars + domain).

Email errors are also stored in the database `emailLog` table with an error-type prefix.

### Service Identifiers

The service is set globally when the process starts:

```typescript
// In mcp-server/src/server.ts
import { setGlobalService, Service } from "@mcp-moira/shared";
setGlobalService(Service.MCP_SERVER);

// In web-backend/src/server.ts
import { setGlobalService, Service } from "@mcp-moira/shared";
setGlobalService(Service.WEB_BACKEND);
```

**Available values:**

- `Service.MCP_SERVER` - MCP JSON-RPC server
- `Service.WEB_BACKEND` - REST API backend
- `Service.WEB_FRONTEND` - Frontend (for client-side logs)

### Component Enum

Standard component names for log filtering:

```typescript
import { createLogger, Component } from "@mcp-moira/shared";

const logger = createLogger({
  component: Component.HTTP, // or Component.Auth, Component.Workflow, etc.
});
```

Available components:

- `Component.HTTP` - HTTP request/response logs
- `Component.Auth` - Authentication operations
- `Component.Workflow` - Workflow CRUD operations
- `Component.Execution` - Execution lifecycle
- `Component.Database` - Database operations
- `Component.MCP` - MCP tool calls
- `Component.Audit` - Audit logging
- `Component.Settings` - Settings operations
- `Component.Admin` - Admin operations

**Loki filter example:** `component!="HTTP"` to exclude HTTP request logs.

### Request Context (AsyncLocalStorage)

Request context provides automatic propagation of requestId and userId through async call chains without prop drilling.

```typescript
import { getRequestContext, runWithContextAsync } from "@mcp-moira/shared";

// Context is automatically set by middleware
// Access anywhere in the request chain:
const ctx = getRequestContext();
if (ctx) {
  console.log(ctx.requestId); // UUID linking related logs
  console.log(ctx.userId); // User ID (if authenticated)
  console.log(ctx.startTime); // Request start timestamp
}
```

**RequestContext fields:**

- `requestId` - UUID for request tracing
- `userId` - Authenticated user ID (optional)
- `startTime` - Request start timestamp
- `operation` - Operation identifier (e.g., "mcp:start", "POST /api/workflows")
- `inputData` - Sanitized input data (included in error logs only)
- `resourceIds` - Extracted resource IDs (workflowId, executionId, etc.)

**Auto-injection:** ServiceLogger automatically includes requestId and userId in all logs when context is available. The service is taken from the process-global variable.

### Error Diagnostics (inputData in Error Logs)

Error logs automatically include sanitized input data for diagnostics. This enables full error analysis without reproducing the issue.

**How it works:**

1. Input data is captured at entry points (MCP /mcp handler, web-backend middleware, workflow executeStep)
2. Data is sanitized via the `sanitizeInput()` utility
3. ServiceLogger includes inputData/resourceIds only for error level logs

**Example error log with full context:**

```json
{
  "level": "error",
  "message": "Failed to start workflow",
  "errorMessage": "Workflow 'test-workflow' not found",
  "operation": "mcp:start",
  "inputData": { "note": "test execution" },
  "resourceIds": { "workflowId": "test-workflow", "parentExecutionId": "none" },
  "requestId": "abc-123",
  "userId": "user-456"
}
```

**Sanitization rules:**

- Sensitive fields removed: password, token, secret, key, auth, credential, private, session, bearer, refresh, access, pin, otp, cvv, passphrase
- Email masking: `user@domain.com` → `us***@domain.com`
- Truncation: 10KB total, 1KB per string, 3 levels nesting depth
- `_truncated: true` flag added when data was truncated

**Usage:**

```typescript
import { sanitizeInput, updateContext } from "@mcp-moira/shared";

// Sanitize and store in context
const { inputData, resourceIds } = sanitizeInput(args);
updateContext({
  operation: "mcp:start",
  inputData,
  resourceIds,
});

// Error logs will automatically include inputData
logger.error("Operation failed", error); // inputData included
logger.info("Operation started"); // inputData NOT included
```

**Coverage:**

- MCP Server: All tool calls via the `/mcp` endpoint
- Web Backend: All POST/PUT/PATCH requests via `inputContextMiddleware`
- Workflow Engine: All step executions via `executeStep()`

**X-Request-Id header:** The web backend returns an `X-Request-Id` header in all responses for client-side correlation.

### Audit Source

For audit logs, the source is resolved automatically from the global service:

```typescript
import { getAuditSource } from "@mcp-moira/shared";

const source = getAuditSource();
// 'mcp' if the process is mcp-server
// 'web' if the process is web-backend
```

Mapping:

- `Service.MCP_SERVER` → `'mcp'`
- `Service.WEB_BACKEND` → `'web'`

### Log Level Classification

Use the correct log level based on error type. The unified AppError hierarchy from `@mcp-moira/shared` determines log levels automatically via `isOperationalError()`.

**WARN Level** - Operational errors (`isOperational: true`):

- `ValidationError` - wrong input format from agent
- `NotFoundError` - invalid workflow/resource ID
- `AuthenticationError` - invalid credentials
- `AuthorizationError` - insufficient permissions
- `ConflictError` - resource conflicts
- `RateLimitError` - too many requests

**ERROR Level** - Programmer errors (`isOperational: false`):

- `DatabaseError` - database failures
- `ConfigurationError` - missing/invalid config
- `ExternalServiceError` - external service failures
- `InternalError` - unexpected exceptions

```typescript
import { normalizeError, isOperationalError } from "@mcp-moira/shared";

// At boundary (error-middleware, execute-step, etc.)
const appError = normalizeError(error);
const logLevel = isOperationalError(error) ? "warn" : "error";

logger[logLevel]("Operation failed", appError, { context });
```

**Architecture:** "Throw Early, Catch Late, Log Once at Boundary"

- Handlers/services throw errors without logging
- Boundaries (error-middleware, execute-step.ts) catch, log once, return response
- Each error logged exactly once

**warn() signature:**

```typescript
// Both signatures supported:
logger.warn("Deprecated API used", { endpoint: "/old-api" }); // (message, meta)
logger.warn("Validation failed", error, { field: "input" }); // (message, error, meta)
```

### Examples

```typescript
// Info
logger.info("User logged in", { userId: user.id });

// Error - system issues
logger.error("Database connection failed", error, { host });

// Warning - user/validation issues
logger.warn("Invalid workflow ID", error, { workflowId });

// Debug
logger.debug("Processing step", { stepIndex, nodeId });
```

## Log Format

### Production (Docker) - JSON

In production (`NODE_ENV=production`), logs are emitted in JSON format for Promtail/Loki:

```json
{
  "timestamp": "2025-12-02T18:00:00.000+00:00",
  "level": "info",
  "service": "mcp-server",
  "component": "MCPEngine",
  "message": "Workflow started",
  "workflowId": "abc",
  "userId": "xyz"
}
```

**Fields:**

- `timestamp` - ISO 8601 format
- `level` - info/error/warn/debug
- `service` - mcp-server/web-backend/web-frontend
- `component` - component name
- `message` - text message
- `...` - additional metadata fields

**Promtail/Loki queries:**

```logql
{container="mcp-moira"} | json | level="error"
{container="mcp-moira"} | json | service="web-backend" component="HTTP"
{container="mcp-moira"} | json | type="client_log"
```

### Development - Human-readable

In development, logs are emitted in a readable format:

```
2025-10-17 19:00:01.234 [INFO] [mcp-server] [MCPEngine] Workflow started {"workflowId":"abc","userId":"xyz"}
2025-10-17 19:00:02.456 [ERROR] [web-backend] [WorkflowRoutes] Failed to load workflow {"error":"Not found"}
```

**Structure:**

- Timestamp: YYYY-MM-DD HH:mm:ss.SSS
- Level: INFO/ERROR/WARN/DEBUG
- Service: mcp-server/web-backend/web-frontend
- Component: component name
- Message: text message
- Context: JSON metadata

## Reading Logs

### Docker container

```bash
# All logs
docker logs mcp-moira-dev2

# Follow in real time
docker logs -f mcp-moira-dev2

# Last 100 lines
docker logs --tail 100 mcp-moira-dev2

# Errors only
docker logs mcp-moira-dev2 2>&1 | grep ERROR
```

### By service (JSON format)

```bash
# MCP Server only
docker logs mcp-moira-dev2 2>&1 | grep '"service":"mcp-server"'

# Backend only
docker logs mcp-moira-dev2 2>&1 | grep '"service":"web-backend"'

# Frontend (client-side) only
docker logs mcp-moira-dev2 2>&1 | grep '"service":"web-frontend"'

# Client-side errors
docker logs mcp-moira-dev2 2>&1 | grep '"type":"client_log"'
```

### By level (JSON format)

```bash
# Errors only
docker logs mcp-moira-dev2 2>&1 | grep '"level":"error"'

# Warnings and errors
docker logs mcp-moira-dev2 2>&1 | grep -E '"level":"error"|"level":"warn"'
```

### Parse JSON with jq

```bash
# Pretty print last error
docker logs mcp-moira-dev2 2>&1 | grep '"level":"error"' | tail -1 | jq .

# Extract specific fields
docker logs mcp-moira-dev2 2>&1 | grep '"service":"web-backend"' | jq '{ts:.timestamp, msg:.message}'
```

## Troubleshooting

### Startup issues

```bash
# Check that services started
docker logs mcp-moira-dev2 2>&1 | grep "success.*RUNNING"

# Find FATAL errors
docker logs mcp-moira-dev2 2>&1 | grep FATAL

# View the latest errors
docker logs mcp-moira-dev2 2>&1 | grep ERROR | tail -20
```

### Initialization errors

If a service won't start, look at the very first logs:

```bash
docker logs mcp-moira-dev2 2>&1 | head -100
```

### Supervisor logs inside the container

```bash
# Logs for a specific service
docker exec mcp-moira-dev2 cat /var/log/supervisor/mcp-server.log
docker exec mcp-moira-dev2 cat /var/log/supervisor/backend-api.log

# Check status
docker exec mcp-moira-dev2 ps aux | grep tsx
```

## Best Practices

1. **Use structured metadata** instead of string interpolation:

   ```typescript
   // Good
   logger.info("Workflow started", { workflowId, userId });

   // Bad
   logger.info(`Workflow ${workflowId} started by ${userId}`);
   ```

2. **Pass Error objects to the error() method**:

   ```typescript
   logger.error("Operation failed", error, { operation: "save" });
   ```

3. **Context for debugging**:

   ```typescript
   logger.debug("Processing node", {
     nodeId,
     nodeType,
     executionId: exec.id.slice(0, 8),
   });
   ```

4. **Do NOT log sensitive data**:
   ```typescript
   // NO: password, tokens, secrets
   logger.info("User auth", { userId: user.id }); // ✅
   logger.info("User auth", { password: pwd }); // ❌
   ```
