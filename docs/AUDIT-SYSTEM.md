# Audit System Architecture

## Purpose

Persistent audit trail for:

- Product demand analysis (active users, feature usage, engagement)
- Security monitoring (admin actions, suspicious activity)
- Compliance and troubleshooting

## Architecture

### Components

**1. AuditAction Enum** (`packages/shared/src/audit/actions.ts`)

- Type-safe action types covering all state-changing operations
- Type-safe, with autocomplete and compile-time checks
- Action types cover all state-changing operations and MCP read operations

**2. AuditRepository** (`packages/shared/src/database/repositories/audit-repository.ts`)

- Methods: `log()`, `listAuditLogs()`, `getAuditLog()`
- Query by userId, action, date range
- Pagination support

**3. Service Layer** (`packages/shared/src/services/`)

- `WorkflowService` - workflow CRUD with automatic audit
- `ExecutionService` - execution lifecycle with automatic audit
- `SettingsService` - settings management with automatic audit
- Services obtain the source from the AsyncLocalStorage context automatically

**4. Audit Helpers**

- `logAuditEvent(repository, req, context)` - for Express routes
- `logAuditEventDirect(repository, context)` - for MCP tools and background tasks
- `computeChanges(oldObj, newObj, fields?)` - generates diff for the changes field

**5. Better Auth Integration**

- Automatic auth event logging via hooks
- Intercepts sign-up, sign-in, sign-out
- Requires no manual logging in auth routes

### Database

**`auditLog` table:**

```sql
CREATE TABLE auditLog (
  id TEXT PRIMARY KEY,
  userId TEXT,
  action TEXT NOT NULL,      -- AuditAction enum value
  resource TEXT,             -- workflow, user, settings, execution, database
  resourceId TEXT,           -- ID of the changed resource
  ip TEXT,                   -- Client IP address
  country TEXT,              -- Country code (via GeoIP)
  userAgent TEXT,            -- User-Agent of the browser/client
  metadata TEXT,             -- JSON with additional data
  changes TEXT,              -- JSON array of field changes (AuditChange[])
  source TEXT,               -- Request origin: 'mcp' | 'web' | 'api' | 'system'
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (userId) REFERENCES user(id)
);
```

**Changes Field Format:**

```typescript
interface AuditChange {
  field: string; // Changed field name
  oldValue: unknown; // Previous value
  newValue: unknown; // New value
}

// Example stored value:
// [{"field":"name","oldValue":"Old Name","newValue":"New Name"}]
```

**Indexes:**

- `idx_auditLog_userId` - fast lookup by user
- `idx_auditLog_action` - filtering by action type
- `idx_auditLog_createdAt` - sorting by time

### Global Service and Audit Source

The audit source is determined automatically from the global `service` value:

```typescript
// At process startup (in server.ts)
import { setGlobalService, Service } from "@mcp-moira/shared";
setGlobalService(Service.MCP_SERVER); // or Service.WEB_BACKEND

// When creating an audit entry
import { getAuditSource } from "@mcp-moira/shared";
const source = getAuditSource();
// 'mcp' if the process is MCP_SERVER
// 'web' if the process is WEB_BACKEND
```

AsyncLocalStorage holds only per-request data: `requestId`, `userId`, `startTime`.

### Data Flow

```
User Action → Express Route/MCP Tool
    ↓
Request Context Set (AsyncLocalStorage: requestId, userId, startTime)
    ↓
Service Layer (WorkflowService/ExecutionService/SettingsService)
    ↓
Business Logic + Automatic Audit
    ↓
getAuditSource() → source from global service
    ↓
AuditRepository.log()
    ↓
Database INSERT → auditLog table (with source)
```

## Service Layer Architecture

### Mandatory Pattern

**IMPORTANT:** All data-changing operations MUST go through the Service Layer to guarantee audit logging.

```
✅ CORRECT:
Route/Tool → Service → Repository → Database
               ↓
          Automatic Audit

❌ INCORRECT:
Route/Tool → Repository → Database (audit lost!)
```

### Exceptions

**Auth hooks** may use AuditRepository directly - this is Better Auth infrastructure code, not business logic.

### Rules

1. **Forbidden** to use Repositories directly for write operations in routes/tools
2. **Required** to use Services for all CRUD operations:
   - `getWorkflowService()` for workflows
   - `getExecutionService()` for executions
   - `getSettingsService()` for user settings
   - `getGlobalSettingsService()` for admin global settings
3. **Read operations** may use repositories directly (no audit needed)
4. **DatabaseRepository** in workflow-engine uses Services internally for write operations

### Available Services

| Service                | Factory Function              | Operations                                             |
| ---------------------- | ----------------------------- | ------------------------------------------------------ |
| WorkflowService        | `getWorkflowService()`        | save, softDelete, restore, hardDelete                  |
| ExecutionService       | `getExecutionService()`       | start, step, complete, fail, cancel, delete            |
| SettingsService        | `getSettingsService()`        | set, delete, createDefinition, deleteDefinition        |
| GlobalSettingsService  | `getGlobalSettingsService()`  | setValue                                               |
| WorkflowSharingService | `getWorkflowSharingService()` | createInvite, acceptInvite, revokeInvite, revokeAccess |

### Code Example

```typescript
// ✅ CORRECT - via Service Layer
import { getWorkflowService, getSettingsService } from "@mcp-moira/shared";

// In a route handler
const workflowService = getWorkflowService();
await workflowService.save({ graph, userId, visibility }); // Audit automatic

const settingsService = getSettingsService();
await settingsService.set(userId, key, value); // Audit automatic
```

```typescript
// ❌ INCORRECT - direct Repository call
import { WorkflowRepository } from "@mcp-moira/shared";

const workflowRepo = new WorkflowRepository(db);
await workflowRepo.save(graph, userId, visibility); // Audit NOT logged!
```

## Action Types

### Auth Events

- `AUTH_SIGN_UP` - new user registered
- `AUTH_SIGN_IN` - user signed in
- `AUTH_SIGN_OUT` - user signed out

**Logged via:** Better Auth hooks (automatic)

### User Profile Events

- `USER_PASSWORD_CHANGED` - user changed their password
- `USER_PROFILE_UPDATE` - user updated their profile
- `USER_REVOKE_SESSION` - user revoked their own session
- `USER_REVOKE_OAUTH_CONSENT` - user revoked OAuth consent

**Logged via:** REST API (`/api/user/*`)
**Security:** Creates audit trail for user-initiated security actions

### OAuth Consent Events

- `OAUTH_CONSENT_GRANT` - OAuth consent granted by user (first-time approval)
- `OAUTH_CONSENT_UPDATE` - OAuth consent updated (scope changes)

**Logged via:** REST API (`/api/oauth/consent`)

### Workflow Events

- `WORKFLOW_CREATE` - workflow created
- `WORKFLOW_EDIT` - workflow changed
- `WORKFLOW_DELETE` - soft delete workflow
- `WORKFLOW_RESTORE` - restore of a deleted workflow (admin)
- `WORKFLOW_HARD_DELETE` - permanent delete (admin)

**Logged via:** WorkflowService (automatic)

### Workflow Sharing Events

- `SHARING_INVITE_CREATE` - invite link created for workflow
- `SHARING_INVITE_ACCEPT` - invite accepted, access granted
- `SHARING_INVITE_REVOKE` - invite revoked by owner
- `SHARING_ACCESS_REVOKE` - user access revoked by owner

**Logged via:** WorkflowSharingService (automatic)

### Execution Events

- `EXECUTION_START` - execution started
- `EXECUTION_STEP` - execution step performed
- `EXECUTION_STEP_FAIL` - step failed with context (nodeId, nodeType, sanitized input)
- `EXECUTION_COMPLETE` - execution completed successfully
- `EXECUTION_FAIL` - execution completed with an error
- `EXECUTION_CANCEL` - execution cancelled
- `EXECUTION_DELETE` - execution deleted
- `EXECUTION_UPDATE_CONTEXT` - execution context changed

**Logged via:** MCPEngine (for MCP tools: EXECUTION_START, EXECUTION_STEP, EXECUTION_COMPLETE, EXECUTION_STEP_FAIL). ExecutionService provides database operations but does NOT log audit events - MCPEngine is the single audit logging point for MCP execution operations. REST API routes log EXECUTION_DELETE, EXECUTION_CANCEL, EXECUTION_UPDATE_CONTEXT separately.

### Attempt Events

- `WORKFLOW_START_ATTEMPT` - failed attempt to start a workflow (workflow not found, validation error)
- `EXECUTION_STEP_ATTEMPT` - validation/handler errors that return pause without throwing exception

**Logged via:** MCPEngine

**WORKFLOW_START_ATTEMPT Metadata:**

```json
{
  "workflowId": "workflow-id",
  "note": "user note if provided",
  "parentExecutionId": "parent-id or null",
  "errorMessage": "Workflow not found",
  "errorCode": "WORKFLOW_NOT_FOUND",
  "stage": "pre-engine"
}
```

**EXECUTION_STEP_ATTEMPT Metadata:**

```json
{
  "workflowId": "workflow-uuid",
  "nodeId": "current-node-id",
  "errorMessage": "Validation error description",
  "errorType": "validation",
  "input": {
    /* Full sanitized step input data */
  }
}
```

**Note:** Three audit actions cover all execute-step scenarios:

- `EXECUTION_STEP` - successful node transition
- `EXECUTION_STEP_ATTEMPT` - validation/handler errors (pause without exception)
- `EXECUTION_STEP_FAIL` - exceptions thrown during step execution

**Metadata Structure:**

`EXECUTION_STEP_FAIL`:

```json
{
  "workflowId": "workflow-uuid",
  "workflowName": "Workflow Name",
  "nodeId": "current-node-id",
  "note": "execution note",
  "errorMessage": "Error description",
  "errorCode": "NOT_FOUND|VALIDATION_ERROR|UNKNOWN",
  "input": {
    /* Full sanitized step input data */
    /* Sensitive fields (password, token, secret) removed */
    /* Large values truncated to 1KB */
    /* Total size limited to 10KB */
    /* Nesting limited to 3 levels */
  }
}
```

`EXECUTION_STEP`:

```json
{
  "workflowId": "workflow-id",
  "fromNodeId": "previous-node-id",
  "toNodeId": "current-node-id",
  "input": {
    /* step input data */
  }
}
```

`EXECUTION_COMPLETE`:

```json
{
  "workflowId": "workflow-id",
  "totalSteps": 5,
  "durationMs": 12345
}
```

### User Settings

- `SETTINGS_SET` - user set a setting value
- `SETTINGS_DELETE` - user deleted a setting

**Logged via:** SettingsService (automatic)

### Note Events

- `NOTE_CREATE`, `NOTE_UPDATE`, `NOTE_DELETE` - note CRUD operations
- `NOTE_RESTORE`, `NOTE_HARD_DELETE` - restore / permanent delete
- `NOTE_LIST`, `NOTE_GET`, `NOTE_HISTORY`, `NOTE_STATS` - read operations
- `MCP_NOTES_LIST` - notes list via MCP tool

**Logged via:** NoteService (`packages/shared/src/services/note-service.ts`) and MCP tools

### Artifact Events

- `ARTIFACT_CREATE`, `ARTIFACT_UPDATE`, `ARTIFACT_DELETE` - artifact CRUD operations
- `ARTIFACT_LIST`, `ARTIFACT_GET`, `ARTIFACT_STATS` - read operations
- `ARTIFACT_TOKEN_CREATE` - token creation for artifact upload/download
- `ARTIFACT_REPORT` - artifact reported by a user

**Logged via:** ArtifactService (`packages/shared/src/services/artifact-service.ts`) and MCP tools

### Token Events

- `TOKEN_CREATE` - persistent API token created (user)
- `TOKEN_REVOKE` - persistent API token revoked (user)
- `ADMIN_TOKEN_REVOKE` - token revoked by admin

**Logged via:** TokenManager / REST API

### Admin User Management

- `ADMIN_BLOCK_USER` - admin blocked a user
- `ADMIN_UNBLOCK_USER` - admin unblocked a user
- `ADMIN_VERIFY_EMAIL` - admin verified an email
- `ADMIN_SEND_VERIFICATION` - admin sent a verification email
- `ADMIN_SEND_RESET` - admin sent a password reset
- `ADMIN_UPDATE_USER` - admin changed user data
- `ADMIN_DELETE_USER` - admin deleted a user
- `ADMIN_LOGOUT_ALL_USERS` - admin logged out all users

**Logged via:** REST API (`/api/admin/users/*`)

### Admin Security Actions

- `ADMIN_FORCE_PASSWORD_RESET` - admin set the forced password reset flag
- `ADMIN_REVOKE_SESSION` - admin revoked a specific user session
- `ADMIN_REVOKE_ALL_SESSIONS` - admin revoked all of a user's sessions
- `ADMIN_REVOKE_OAUTH_PROVIDER` - admin revoked OAuth tokens for a specific provider
- `ADMIN_REVOKE_ALL_OAUTH` - admin revoked all of a user's OAuth tokens

**Logged via:** REST API (`/api/admin/users/:id/security/*`)

### Admin Settings Management

- `ADMIN_SETTINGS_CREATE_DEFINITION` - admin created a setting definition
- `ADMIN_SETTINGS_UPDATE_DEFINITION` - admin changed a definition
- `ADMIN_SETTINGS_DELETE_DEFINITION` - admin deleted a definition
- `ADMIN_SETTINGS_EXPORT_SCHEMA` - admin exported the schema (definitions)
- `ADMIN_GLOBAL_SETTINGS_UPDATE` - admin changed a global setting value
- `ADMIN_GLOBAL_SETTINGS_RESET` - admin reset a global setting value
- `ADMIN_GLOBAL_SETTINGS_EXPORT` - admin exported global settings values

**Logged via:** REST API (`/api/admin/settings/definitions`, `/api/admin/global-settings`)

### Admin Execution Management

- `ADMIN_UPDATE_EXECUTION_CONTEXT` - admin changed an execution context

**Logged via:** REST API (`/api/admin/executions/:id/context`)

### Admin Database Operations

- `ADMIN_VACUUM_DB` - admin ran a database vacuum
- `ADMIN_BACKUP_DB` - admin created a database backup

**Logged via:** REST API (`/api/admin/database/*`)

### Admin Artifact Management

- `ADMIN_ARTIFACT_DELETE` - admin deleted an artifact
- `ADMIN_ARTIFACT_LIST` - admin listed artifacts
- `ADMIN_ARTIFACT_QUOTA_UPDATE` - admin updated an artifact quota
- `ADMIN_ARTIFACT_TAKEDOWN` - admin took down a reported artifact
- `ADMIN_ARTIFACT_LIST_REPORTED` - admin listed reported artifacts

**Logged via:** REST API (`/api/admin/artifacts/*`)

### Execution Lock Management

- `LOCK_CREATE` - execution lock created with PIN
- `LOCK_UNLOCK` - lock unlocked with correct PIN
- `LOCK_ATTEMPT_FAIL` - failed PIN validation attempt
- `ADMIN_UNLOCK` - admin override unlock (bypasses PIN)

**Logged via:** LockService (`packages/shared/src/services/lock-service.ts`)

### MCP Read Operations

- `MCP_WORKFLOW_LIST` - list workflows operation
- `MCP_SESSION_INFO` - session info operations (user, executions, execution_context, current_step)
- `MCP_SETTINGS_READ` - settings get/list operations
- `MCP_TOKEN_CREATE` - token creation for upload/download
- `MCP_HELP_REQUEST` - help documentation requests

**Logged via:** MCP tools (`packages/mcp-server/src/tools/*`)

## Rules for Adding Audit Logging

### Must Be Logged

1. **All POST/PUT/DELETE endpoints** (except technical ones)
2. **All admin actions** without exception
3. **Auth events** (automatically via Better Auth)
4. **Changes to critical data** (workflows, settings, users)

### Do NOT Log

- Health checks (`/health`, `/api/health`)
- Technical endpoints (validation without changes)
- HTTP methods are logged at the Traefik/Nginx level

**Note:** MCP read operations (list workflows, session info, help) are logged for full observability.

### How to Add Audit to a New Endpoint

#### Service Layer (Recommended)

Use existing services with automatic audit logging:

```typescript
import { getWorkflowService, getExecutionService, getSettingsService } from "@mcp-moira/shared";

// Workflow operations - audit logged automatically
const workflowService = getWorkflowService();
await workflowService.save({ graph, userId, isUpdate: false }); // WORKFLOW_CREATE
await workflowService.save({ graph, userId, isUpdate: true }); // WORKFLOW_EDIT
await workflowService.softDelete(workflowId, userId); // WORKFLOW_DELETE

// Execution operations - audit logged automatically
const executionService = getExecutionService();
await executionService.start(execution); // EXECUTION_START
await executionService.step(execution, nodeId); // EXECUTION_STEP
await executionService.complete(execution); // EXECUTION_COMPLETE

// Settings operations - audit logged automatically
const settingsService = getSettingsService();
await settingsService.set(userId, key, value); // SETTINGS_SET
await settingsService.delete(userId, key); // SETTINGS_DELETE
```

#### Express Route Example (Manual Audit)

```typescript
import { logAuditEvent, AuditAction, computeChanges, type AuditChange } from "@mcp-moira/shared";

router.put(
  "/api/something/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;

    // 1. Get old state for diff
    const oldData = await repository.getSomething(req.params.id);

    // 2. Business logic
    const result = await repository.updateSomething(req.params.id, req.body, userId);

    // 3. Compute changes for audit
    const changes = computeChanges(
      { name: oldData.name, status: oldData.status },
      { name: result.name, status: result.status },
    );

    // 4. Audit logging with changes
    await logAuditEvent(repository, req, {
      userId,
      action: AuditAction.SOMETHING_UPDATE,
      resource: "something",
      resourceId: result.id,
      metadata: { key: "value" },
      changes: changes.length > 0 ? changes : undefined,
    });

    // 5. Response
    res.json({ success: true, data: result });
  }),
);
```

#### MCP Tool Example

```typescript
import { logAuditEventDirect, AuditAction } from "@mcp-moira/shared";

async function mcpTool(params: Params, userId: string) {
  // 1. Business logic
  const result = await repository.doSomething(params, userId);

  // 2. Audit logging
  await logAuditEventDirect(repository, {
    userId,
    action: AuditAction.SOMETHING_ACTION,
    resource: "something",
    resourceId: result.id,
    metadata: { changes: "description" },
  });

  return result;
}
```

### Best Practices

1. **Use the AuditAction enum** - not strings

   ```typescript
   // ✅ Correct
   action: AuditAction.WORKFLOW_CREATE;

   // ❌ Incorrect
   action: "workflow:create";
   ```

2. **Log AFTER a successful operation**

   ```typescript
   // ✅ Correct
   const result = await repository.create(data);
   await logAuditEvent(...);
   res.json(result);

   // ❌ Incorrect
   await logAuditEvent(...);  // Logging before execution
   const result = await repository.create(data);
   ```

3. **Include resourceId for tracing**

   ```typescript
   // ✅ Correct
   resourceId: workflow.id;

   // ❌ Incorrect
   resourceId: undefined; // Cannot tell what changed
   ```

4. **Metadata for important details**

   ```typescript
   // ✅ Useful metadata
   metadata: {
     nodeCount: workflow.nodes.length,
     visibility: workflow.visibility
   }

   // ⚠️ Do not log sensitive data
   metadata: { password: '...' }  // ❌ NEVER
   ```

5. **Do NOT log passwords, tokens, secrets**
   - Actions only, not access credentials
   - Email is fine, password is not
   - User ID is fine, session token is not

## Product Demand Analysis

The audit trail is used for:

### Active Users

```sql
SELECT COUNT(DISTINCT userId)
FROM auditLog
WHERE createdAt > (strftime('%s', 'now') - 86400) * 1000;
-- Users active last 24 hours
```

### Feature Usage

```sql
SELECT action, COUNT(*) as count
FROM auditLog
WHERE action LIKE 'workflow:%'
GROUP BY action
ORDER BY count DESC;
-- Most used workflow features
```

### User Engagement

```sql
SELECT userId, COUNT(*) as actions
FROM auditLog
WHERE createdAt > (strftime('%s', 'now') - 604800) * 1000
GROUP BY userId
ORDER BY actions DESC
LIMIT 10;
-- Most active users last 7 days
```

### Retention

```sql
SELECT
  DATE(createdAt / 1000, 'unixepoch') as date,
  COUNT(DISTINCT userId) as active_users
FROM auditLog
GROUP BY date
ORDER BY date DESC;
-- Daily active users trend
```

## Security Monitoring

### Admin Actions Audit

```sql
SELECT * FROM auditLog
WHERE action LIKE 'admin:%'
ORDER BY createdAt DESC
LIMIT 50;
```

### Suspicious Activity

```sql
SELECT userId, COUNT(*) as failed_attempts
FROM auditLog
WHERE action = 'auth:sign_in'
  AND metadata LIKE '%failed%'
  AND createdAt > (strftime('%s', 'now') - 3600) * 1000
GROUP BY userId
HAVING failed_attempts > 5;
```

### Geographic Distribution

```sql
SELECT country, COUNT(*) as requests
FROM auditLog
WHERE country IS NOT NULL
GROUP BY country
ORDER BY requests DESC;
```

## Troubleshooting

### No Audit Logs

1. Check that AuditRepository is initialized
2. Check that logAuditEvent is called after success
3. Check that the auditLog table exists (migrations)
4. Check the logs for audit logging errors

### Incomplete Data

1. Check that IP/country/userAgent are captured
2. GeoIP may return null for local IPs
3. Metadata must be valid JSON

### Performance Issues

1. Audit logging is asynchronous and does not block the response
2. At >10k entries/day - consider archiving old logs
3. Indexes on userId, action, createdAt are critical

## Adding New Actions

1. **Add to the AuditAction enum**

   ```typescript
   // packages/shared/src/audit/actions.ts
   export enum AuditAction {
     // ... existing
     NEW_FEATURE_ACTION = "feature:action",
   }
   ```

2. **Use it in code**

   ```typescript
   await logAuditEvent(repository, req, {
     userId,
     action: AuditAction.NEW_FEATURE_ACTION,
     resource: "feature",
     resourceId: id,
   });
   ```

3. **Add tests**

   ```typescript
   test("feature:action event logged", async () => {
     // ... perform action
     const logs = await repository.listAuditLogs({ action: AuditAction.NEW_FEATURE_ACTION });
     expect(logs.length).toBe(1);
   });
   ```

4. **Update the documentation**
   - Add to the list of action types above
   - Note where it is logged (REST/MCP)

## Admin Analytics Dashboard

### Overview

**Route:** `/app/admin/analytics`
**Access:** Admin only
**Component:** `packages/web-frontend/src/pages/AdminAnalytics.tsx`

### Features

**1. System Overview**

- Total users, workflows, executions
- Active/completed/failed executions
- Time range filter (today, week, month)

**2. Workflow Analytics**

- Top workflows by usage
- Execution count per workflow
- Success rate per workflow

**3. User Activity**

- Active users count
- New users count
- Top users by execution count

**4. Workflow Quality Analytics**

Per-workflow analysis:

- Hot steps - most frequently executed nodes
- Dead steps - nodes never reached
- Problematic steps - high failure rate nodes
- Completion rate

**API Endpoint:** `GET /api/admin/analytics/workflow-quality/:workflowId`

### API Endpoints

| Endpoint                                    | Description                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/admin/analytics/overview`             | Totals (users, workflows, executions)                                                          |
| `/api/admin/analytics/executions`           | Execution stats with time series                                                               |
| `/api/admin/analytics/top-workflows`        | Most used workflows                                                                            |
| `/api/admin/analytics/users`                | User activity metrics                                                                          |
| `/api/admin/analytics/audit-summary`        | Audit log summary by action                                                                    |
| `/api/admin/analytics/workflow-quality/:id` | Per-workflow quality analytics                                                                 |
| `/api/admin/analytics/operational`          | Operational metrics with granularity, breakdowns, and filter params (action, source, resource) |
| `/api/admin/analytics/conversion-funnel`    | User conversion funnel (registered → verified → first workflow → active)                       |
| `/api/admin/analytics/engagement`           | Engagement metrics (returning rate, avg executions, time-to-first-workflow)                    |
| `/api/admin/audit/actions`                  | Available action types for filtering                                                           |

### Operational Dashboard

**Route:** `/app/admin/analytics/operational`
**Component:** `packages/web-frontend/src/pages/OperationalDashboard.tsx`

**Sections:**

1. **Metric Cards** — 6 cards: Unique Users/Day, Total Calls/Day, Calls/Second, Workflows Started/Day, Workflows Completed/Day, MCP Calls/Second
2. **Time Series Charts** — Tremor AreaChart/LineChart/BarChart with chart type toggle (area/line/bar icons)
3. **Multi-Series Charts** — Workflow comparison (started vs completed), rate comparison (calls/s vs mcp/s). Hidden when insufficient data
4. **Breakdowns** — 3-column layout: Top Actions, By Source, By Resource (horizontal bar tables)
5. **Business Analytics** — Conversion funnel, top workflows bar chart, engagement cards (returning users, avg executions, time-to-first-workflow, active users)

**Interactive Controls:**

- Time range selector (Last 24h, 7 days, 30 days, year, all)
- Granularity selector (Auto, Hourly, Daily)
- Auto-refresh toggle
- Chart type toggle (area/line/bar) — switches all time series charts
- Filter dropdowns (Action, Source, Resource) — populated from breakdowns data, passed to API as `filterAction`, `filterSource`, `filterResource`

**i18n Keys:** `admin.operational.filters.*`, `admin.operational.chartType.*`

## Audit Log Viewer UI

### Admin Interface

**Route:** `/app/admin/audit-log`
**Access:** Admin only
**Component:** `packages/web-frontend/src/pages/AuditLog.tsx`

### Features

**1. Table Display**

- Timestamp (local format)
- User email
- Action type (color-coded badge)
- Resource type
- Source (WEB, MCP, API, SYSTEM badge)
- IP address
- Country code
- Detail button

**2. Filtering**

- User filter (dropdown select)
- Action filter (multi-select dropdown with search)
- Resource filter (text input)
- Source filter (dropdown: WEB, MCP, API, SYSTEM)
- Date range filter (from/to date inputs)
- All filters debounced (400ms)

**3. Sorting**

- Clickable column headers: Timestamp, Action, Resource, Source
- Server-side sorting via `sortBy` and `sortOrder` query params
- Default: `createdAt` descending (newest first)

**5. Pagination**

- 50 entries per page
- Server-side pagination (limit/offset)
- Previous/Next navigation

**6. Detail Modal**

- Full audit entry metadata
- Structured view for execution actions:
  - Workflow ID
  - From Node / To Node
  - Node ID
  - Total Steps
  - Duration
  - Error details
  - Validation errors
- JSON formatting for non-execution metadata
- Resource ID and timestamps

### API Endpoint

```
GET /api/admin/audit-log
```

**Query Parameters:**

```typescript
{
  userId?: string;         // Filter by user ID
  action?: string;         // Filter by action type (single)
  resource?: string;       // Filter by resource
  source?: string;         // Filter by source (web, mcp, api, system)
  fromDate?: string;       // Filter from date (unix timestamp ms)
  toDate?: string;         // Filter to date (unix timestamp ms)
  sortBy?: string;         // Sort column: createdAt | action | resource | source
  sortOrder?: string;      // Sort direction: asc | desc (default: desc)
  limit: number;           // Page size (default: 50)
  offset: number;          // Pagination offset
}
```

**Response:**

```typescript
{
  success: true,
  data: {
    entries: AuditLogEntry[], // includes source field
    totalCount: number,
    limit: number,
    offset: number
  }
}
```

**Authentication:** Required (admin only)
**Rate Limiting:** Applied via `apiLimiter`

### Multi-Select Action Filter

**Implementation:** Custom dropdown with search/autocomplete

**Features:**

- Shows all AuditAction enum values
- Search input filters actions in real-time
- Checkbox selection for multiple actions
- Displays count of selected actions
- Click-outside to close

**User Flow:**

1. Click "Select actions..." to open dropdown
2. Type in search to filter (e.g., "workflow")
3. Check desired actions
4. Click outside to close
5. Table filters by selected actions

**Code Location:** `packages/web-frontend/src/pages/AuditLog.tsx:212-263`

### UI Performance

**Debouncing:**

- Filter inputs: 400ms delay before API call
- Prevents UI jank during rapid typing
- Smooth user experience

**Server-Side Pagination:**

- Only requested page loaded (50 entries)
- No client-side pagination overhead
- Efficient for large audit log datasets

### Security

**Access Control:**

- `requireAuth` middleware enforces authentication
- `requireAdmin` middleware restricts to admins
- Non-admin users redirected to `/app/workflows`
- Route guards in frontend prevent access

**IP Detection:**

- Express configured with `trust proxy: true`
- Extracts real client IP from `x-forwarded-for` header
- Falls back to `req.ip` and `req.socket.remoteAddress`
- GeoIP lookup for country code

### Testing

**E2E Tests:** `tests/e2e/audit-log.spec.ts`

- Admin access verification
- Table display
- User filter
- Multi-select action filter
- Clear filters
- Pagination
- Detail modal
- Navigation

**Test Coverage:** the E2E suite exercises the audit log UI functionality end to end

## Compliance

- Audit logs contain PII (userId, email in metadata)
- Store in accordance with GDPR/privacy policy
- When deleting a user, consider anonymizing their audit logs
- Retention policy: minimum 90 days for security, one year for analytics

## API Authorization Rules

### Middleware

**requireAuth** (`packages/web-backend/src/middleware/auth-middleware.ts`)

- Validates session token via Better Auth
- Extracts userId from session
- Returns 401 if not authenticated

**requireAdmin** (`packages/web-backend/src/middleware/auth-middleware.ts`)

- Requires user to have admin role
- Returns 403 if not admin
- Must be used after requireAuth

### Route Protection

| Route Pattern             | Protection        | Description                     |
| ------------------------- | ----------------- | ------------------------------- |
| `/api/health`             | Public            | Health check                    |
| `/api/startup-ready`      | Public            | Startup readiness check         |
| `/api/auth/*`             | Public            | Authentication endpoints        |
| `/api/public/workflows/*` | Token-based       | Public workflow upload/download |
| `/api/workflows/*`        | requireAuth       | User workflow operations        |
| `/api/executions/*`       | requireAuth       | User execution operations       |
| `/api/user/*`             | requireAuth       | User profile operations         |
| `/api/settings/*`         | requireAuth       | User settings                   |
| `/api/admin/*`            | requireAuth+Admin | Admin operations                |
| `/api/stats/*`            | requireAuth       | User statistics                 |

### Public Routes Justification

| Route                              | Justification                           |
| ---------------------------------- | --------------------------------------- |
| `/api/health`                      | Load balancer health checks             |
| `/api/startup-ready`               | Container orchestration readiness probe |
| `/api/auth/*`                      | Login/register flow before auth exists  |
| `/api/public/workflows/upload/*`   | Token-authenticated workflow upload     |
| `/api/public/workflows/download/*` | Token-authenticated workflow download   |

### Token-Based Access

Public workflow endpoints use short-lived tokens instead of session auth:

```typescript
// Generate upload token (admin only)
POST /api/admin/tokens/upload
Response: { token: "abc123", expiresAt: 1234567890 }

// Use token for upload
POST /api/public/workflows/upload/:token
Body: FormData with workflow JSON

// Generate download token
POST /api/admin/tokens/download
Body: { workflowId: "my-workflow" }
Response: { token: "xyz789", expiresAt: 1234567890 }

// Use token for download
GET /api/public/workflows/download/:token
```

### Verification

API authorization is verified by tests:

- `tests/api/authorization.test.ts` - comprehensive authorization tests
- Tests verify 401 for unauthenticated requests
- Tests verify 403 for non-admin on admin routes
- Tests verify public routes are accessible

## AuditAction Coverage Status

The full set of `AuditAction` types is defined in `packages/shared/src/audit/actions.ts`.
Every action type has call sites in the codebase, logged via the source noted below:

| Category              | Logged via                          |
| --------------------- | ----------------------------------- |
| Auth events           | ✅ Via Better Auth hooks            |
| User profile          | ✅ Via REST API                     |
| OAuth consent         | ✅ Via REST API                     |
| Workflow              | ✅ Via WorkflowService              |
| Workflow sharing      | ✅ Via WorkflowSharingService       |
| Execution             | ✅ Via ExecutionService + MCPEngine |
| Attempt events        | ✅ Via MCPEngine + MCP tools        |
| User settings         | ✅ Via SettingsService              |
| Notes                 | ✅ Via NoteService + MCP tools      |
| Artifacts             | ✅ Via ArtifactService + MCP tools  |
| Tokens                | ✅ Via TokenManager / REST API      |
| Admin user mgmt       | ✅ Via REST API                     |
| Admin security        | ✅ Via REST API                     |
| Admin settings        | ✅ Via REST API                     |
| Admin global settings | ✅ Via GlobalSettingsService        |
| Admin execution       | ✅ Via REST API                     |
| Admin database        | ✅ Via REST API                     |
| Admin artifacts       | ✅ Via REST API                     |
| Execution lock mgmt   | ✅ Via LockService                  |
| MCP read ops          | ✅ Via MCP tools                    |
