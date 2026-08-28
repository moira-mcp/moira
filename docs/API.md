# Web Backend API

## Rate Limiting

All endpoints are protected by rate limiting.

### Limits

- API endpoints (`/api/*`): 100 requests/minute
- Auth endpoints (`/api/auth/*`): 1000 requests/minute
- MCP endpoint (`/mcp`): 1000 requests/minute

### Response Headers

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1699876543
```

### Exceeded Limit

HTTP 429 Too Many Requests

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Rate limit exceeded",
    "details": {
      "requestId": "req_123456789",
      "limit": 100,
      "window": 60000,
      "resetTime": 45
    }
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

## Size Limits

### Workflow Size

Maximum workflow JSON: 5MB

Error on exceed:

```
Workflow size 6.50MB exceeds maximum 5MB limit
```

### Execution Context Size

Maximum execution context: 10MB

Error on exceed:

```
Execution context size 12.00MB exceeds maximum 10MB limit
```

## Features API

### GET /api/features

Public (no auth). Returns the deployment mode, the resolved feature flags so
the frontend can hide SaaS-specific UI in self-host, and the runtime-resolved
MCP endpoint URL. Read pre-auth by the login/register pages.

Response:

```typescript
{
  success: boolean;
  data: {
    deploymentMode: "self-host" | "saas";
    features: {
      openRegistration: boolean;
      accountApproval: boolean;
      emailVerificationGate: boolean;
      verificationEmailOnSignup: boolean;
      legalConsents: boolean;
      betaNotices: boolean;
      multiUserAdmin: boolean;
      userManagement: boolean;
      adminAnalytics: boolean;
      adminOperations: boolean;
      operationsDevelopment: boolean;
      socialLogin: boolean;
    }
    mcpUrl: string;
    emailDelivery: {
      state: "real" | "test" | "unavailable" | "configuration-error";
      provider: "smtp" | "brevo" | "test" | null;
      available: boolean;
      reason: string | null;
    }
  }
  timestamp: string;
}
```

Flags are resolved via `getFeatureResolver()` (`ModeFeatureResolver` by
`DEPLOYMENT_MODE`). Self-host enables `openRegistration`, `accountApproval`, and
`userManagement`; SaaS enables its existing registration/email/legal/admin flags
and leaves `accountApproval` disabled.

`mcpUrl` is `getMcpUrl()` — `<protocol>://<MOIRA_HOST>/mcp`, resolved from the
server's host configuration at request time. The frontend uses it as the MCP
endpoint shown in the Web UI so the value matches the actual host/port the
instance is served from.

`emailDelivery` is the sanitized runtime delivery capability; it contains no credentials.
`available` is true only for `state: "real"`. The `test` state writes messages to the explicit
test log and does not deliver them.

Authentication: Not required.

## Settings API

User settings management with authentication and validation.

### GET /api/settings/definitions

List setting definitions for user settings page.

Behavior:

- Always filters out `adminOnly=true` definitions
- This endpoint is for user settings page — admin settings are managed via `/api/admin/*` routes

Query parameters:

- `category` (optional): Filter by category

Response:

```typescript
{
  success: boolean;
  data: SettingDefinition[];
  timestamp: string;
}
```

SettingDefinition:

```typescript
interface SettingDefinition {
  key: string; // telegram.bot_token
  type: string; // 'string' | 'number' | 'boolean' | 'json' | 'encrypted'
  category: string; // telegram, ui, profile
  label: string;
  description?: string;
  defaultValue?: string;
  required: boolean;
  validation?: string; // JSON Schema
  adminOnly: boolean;
  createdAt: number;
  updatedAt: number;
}
```

Behavior:

- Always filters out `adminOnly=true` definitions
- This endpoint is for user settings page — admin settings are managed via `/api/admin/*` routes

Authentication: Required (401 if not authenticated)

### GET /api/settings/:category

Get user settings for category.

Parameters:

- `category`: Setting category (e.g., "telegram", "ui")

Response:

```typescript
{
  success: boolean;
  data: Record<string, any>; // { "ui.theme": "dark", ... }
  timestamp: string;
}
```

Behavior:

- Returns user values if set, otherwise default from definition
- Encrypted values masked: `"●●●●last4"`

Authentication: Required

### Execution variables

`GET /api/executions/:id/variables` returns registry declarations, current value presence/value,
declared policy, write phase, effective editability, denial reasons and applied filters. `names`,
`search`, `types`, `hasValue`, `editable`, and `writePhase=current|other` filter results;
unknown requested names are returned separately. `PUT /api/executions/:id/variables/:name` accepts
`value` and `expectedRevision` and writes only when `runtimePolicy.externalVariableWrites` permits
the current paused node and the value satisfies its registry JSON Schema. Arbitrary bulk variables
and `nodeStates` mutation is rejected; the legacy context-path route applies the same policy/schema
to its top-level declared variable.

Authentication: Required

`GET /api/workflows/:id/variables` provides definition-level names/search/types/hasDefault/
externallyWritable filters with `hasDefault` and policy on each entry, applied filters and unknown
names. It does not claim current execution editability.

The local definition CLI authors policy with
`moira-workflow <file> set-variable-write-policy <name> <node-ids|all|none>` and discovers it with
`list-variables` plus the same definition filters.

### PUT /api/settings/:key

Update setting value.

Parameters:

- `key`: Setting key (e.g., "ui.theme")

Request body:

```typescript
{
  value: any; // Type depends on definition
}
```

Validation:

- Type check (string, number, boolean, json)
- Enum validation (value in allowed list)
- String length (minLength, maxLength)
- Required field check

Response:

```typescript
{
  success: boolean;
  data: { key: string, updated: boolean };
  timestamp: string;
}
```

Errors:

- 400: Validation failed
- 403: Admin-only setting (non-admin user)
- 404: Setting definition not found

Authentication: Required

### DELETE /api/settings/:key

Delete user setting value (reset to default).

Parameters:

- `key`: Setting key

Response:

```typescript
{
  success: boolean;
  data: { key: string, deleted: boolean };
  timestamp: string;
}
```

Behavior:

- Deletes user value from database
- Subsequent GET returns default value

Errors:

- 404: Setting definition not found

Authentication: Required

## Notes API

User notes management with authentication. All operations scoped to authenticated user.

### Audit Trail

All Notes API operations are logged to the audit trail:

| Operation        | Audit Action       | Metadata                                               |
| ---------------- | ------------------ | ------------------------------------------------------ |
| List notes       | `note:list`        | tag, keySearch, limit, offset, resultCount, totalCount |
| Get note         | `note:get`         | version                                                |
| Get note version | `note:get`         | version, requestedVersion: true                        |
| Get history      | `note:history`     | versionsCount                                          |
| Get stats        | `note:stats`       | totalNotes, totalSize                                  |
| Create note      | `note:create`      | version, size, tagsCount                               |
| Update note      | `note:update`      | version, size, tagsCount                               |
| Delete note      | `note:delete`      | -                                                      |
| Restore note     | `note:restore`     | -                                                      |
| Hard delete      | `note:hard_delete` | -                                                      |

### GET /api/notes

List notes with optional filtering.

Query parameters:

- `tag` (optional): Filter by tag
- `keySearch` (optional): Search by key (prefix/contains)
- `limit` (optional): Max results (default: 50)
- `offset` (optional): Pagination offset (default: 0)

Response:

```typescript
{
  success: boolean;
  data: {
    notes: Array<{
      id: string;
      key: string;
      tags: string[];
      size: number;
      version: number;
      preview?: string;
      createdAt: number;
      updatedAt: number;
    }>;
    total: number;
    allTags: string[];  // All user's tags for autocomplete
  }
  timestamp: string;
}
```

Authentication: Required

### GET /api/notes/stats

Get user's note statistics.

Response:

```typescript
{
  success: boolean;
  data: {
    totalNotes: number;
    totalSize: number;
    limit: number; // 1048576 (1MB)
    usedPercent: number;
  }
  timestamp: string;
}
```

Authentication: Required

### GET /api/notes/:key

Get single note by key.

Parameters:

- `key`: Note key

Query parameters:

- `version` (optional): Specific version number

Response:

```typescript
{
  success: boolean;
  data: {
    id: string;
    key: string;
    value: string;
    tags: string[];
    size: number;
    version: number;
    createdAt: number;
    updatedAt: number;
  }
  timestamp: string;
}
```

Errors:

- 404: Note not found
- 404: Version not found

Authentication: Required

### GET /api/notes/:key/history

Get version history for a note.

Parameters:

- `key`: Note key

Response:

```typescript
{
  success: boolean;
  data: Array<{
    version: number;
    size: number;
    preview?: string;
    createdAt: number;
  }>;
  timestamp: string;
}
```

Errors:

- 404: Note not found

Authentication: Required

### POST /api/notes

Create a new note.

Request body:

```typescript
{
  key: string;      // 1-100 chars, alphanumeric/underscore/hyphen
  value: string;    // Max 100KB
  tags?: string[];  // Max 10 tags, each 1-50 chars
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    id: string;
    key: string;
    version: number;
    created: boolean;
  }
  timestamp: string;
}
```

Errors:

- 400: Key is required
- 400: Value is required
- 400: Note with key already exists
- 400: Invalid key format
- 400: Too many tags
- 400: Note size exceeded (100KB)
- 400: Quota exceeded (1MB total)

Authentication: Required

### PUT /api/notes/:key

Update an existing note.

Parameters:

- `key`: Note key

Request body:

```typescript
{
  value: string;    // Max 100KB
  tags?: string[];  // Max 10 tags
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    id: string;
    key: string;
    version: number;
    updated: boolean;
  }
  timestamp: string;
}
```

Errors:

- 400: Value is required
- 404: Note not found

Authentication: Required

### DELETE /api/notes/:key

Soft delete a note.

Parameters:

- `key`: Note key

Response:

```typescript
{
  success: boolean;
  data: {
    key: string;
    deleted: boolean;
  }
  timestamp: string;
}
```

Errors:

- 404: Note not found

Authentication: Required

### POST /api/notes/:key/restore

Restore a soft-deleted note.

Parameters:

- `key`: Note key

Response:

```typescript
{
  success: boolean;
  data: {
    key: string;
    restored: boolean;
  }
  timestamp: string;
}
```

Errors:

- 404: Note not found or not deleted

Authentication: Required

## Artifacts API

Static HTML artifacts hosting with quota enforcement. All operations scoped to authenticated user.

### GET /api/artifacts

List user's artifacts with pagination.

Query parameters:

- `limit` (optional): Max results (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)

Response:

```typescript
{
  success: boolean;
  data: {
    artifacts: Array<{
      uuid: string;
      url: string; // https://${STATIC_ARTIFACTS_DOMAIN}/{uuid}.html
      name: string;
      size: number;
      mimeType: string;
      executionId: string | null;
      expiresAt: string; // ISO 8601
      createdAt: string;
      updatedAt: string;
    }>;
    total: number;
  }
  timestamp: string;
}
```

Authentication: Required

### GET /api/artifacts/stats

Get user's artifact quota statistics.

Response:

```typescript
{
  success: boolean;
  data: {
    totalArtifacts: number;
    totalSize: number;
    storageLimit: number; // 52428800 (50MB)
    countLimit: number; // 100
    storageUsedPercent: number;
    countUsedPercent: number;
  }
  timestamp: string;
}
```

Authentication: Required

### GET /api/artifacts/:uuid

Get artifact metadata by UUID.

Parameters:

- `uuid`: Artifact UUID

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    url: string;
    name: string;
    size: number;
    mimeType: string;
    executionId: string | null;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }
  timestamp: string;
}
```

Errors:

- 404: Artifact not found (or belongs to another user)

Authentication: Required

### POST /api/artifacts

Create a new artifact.

Request body:

```typescript
{
  name: string;           // Artifact name (e.g., "report.html")
  content: string;        // HTML content (must contain <html> tag)
  executionId?: string;   // Link to workflow execution (optional)
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    url: string;
    name: string;
    size: number;
    expiresAt: string;
  }
  timestamp: string;
}
```

Errors:

- 400: Invalid HTML content (must contain `<html>` tag)
- 400: Size exceeded (max 5MB)
- 400: Storage quota exceeded (50MB total)
- 400: Count quota exceeded (100 artifacts)

Authentication: Required

### PUT /api/artifacts/:uuid

Update artifact content.

Parameters:

- `uuid`: Artifact UUID

Request body:

```typescript
{
  name?: string;    // Optional new name
  content: string;  // New HTML content
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    updated: boolean;
  }
  timestamp: string;
}
```

Errors:

- 400: Invalid HTML content
- 400: Size exceeded
- 404: Artifact not found

Authentication: Required

### DELETE /api/artifacts/:uuid

Delete an artifact.

Parameters:

- `uuid`: Artifact UUID

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    deleted: boolean;
  }
  timestamp: string;
}
```

Errors:

- 404: Artifact not found

Authentication: Required

### POST /api/public/artifacts/upload/:token

Upload artifact via one-time token. Token created via MCP `artifacts` tool with `action: "token"`.

Parameters:

- `token`: One-time upload token (UUID)

Request: JSON body or `multipart/form-data`

JSON body:

```typescript
{
  name: string;           // Artifact name
  content: string;        // HTML content
  executionId?: string;   // Optional execution link
}
```

Multipart form:

```
file: <file>              # HTML file
executionId: string       # Optional execution link (form field)
```

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    url: string;
    name: string;
    size: number;
    expiresAt: string;
  }
  timestamp: string;
}
```

Behavior:

- Token is single-use (consumed after successful upload)
- Token expires after TTL (default: 60 minutes)
- Supports both JSON and multipart file upload

Errors:

- 400: Invalid HTML content
- 400: Missing name or content
- 401: Invalid, expired, or already used token

Authentication: Via token (no session required)

## User Profile API

User profile and password management.

### GET /api/user/me

Get the current session's identity and admission status. This is the only app API
available to a self-host account that is still pending approval.

```typescript
{
  success: true;
  data: {
    id: string;
    email: string;
    handle: string | null;
    isAdmin: boolean;
    passwordResetRequired: boolean;
    blocked: boolean;
    emailVerified: boolean;
    approvedAt: string | null;
    accountApproved: boolean;
    accountApprovalRequired: boolean;
  }
  timestamp: string;
}
```

Authentication: Valid session required. Blocked accounts are denied. Pending
approval is allowed for this status endpoint only.

### GET /api/user/profile

Get current user profile.

Response:

```typescript
{
  success: boolean;
  data: {
    id: string;
    email: string;
    name: string | null;
    handle: string; // Globally unique user handle (4-40 chars)
    emailVerified: boolean;
    createdAt: string; // ISO 8601
    image: string | null;
  }
  timestamp: string;
}
```

Authentication: Required (requireAuth middleware)

### PATCH /api/user/profile

Update user profile name.

Request:

```typescript
{
  name: string; // max 100 characters
}
```

Response:

```typescript
{
  success: boolean;
  message: "Profile updated successfully";
}
```

Validation errors (400):

- Name exceeds 100 characters

Authentication: Required

### POST /api/user/change-password

Change user password. Automatically revokes all sessions except current and all OAuth tokens.

Request:

```typescript
{
  currentPassword: string;
  newPassword: string; // min 6 chars, max 128 chars
}
```

Response:

```typescript
{
  success: boolean;
  message: "Password changed successfully. All other sessions and OAuth tokens have been revoked.";
}
```

Errors:

- 400: Current password incorrect
- 400: New password less than 6 characters
- 400: New password same as current password

Authentication: Required

Security:

- Revokes all sessions except current (user remains logged in)
- Revokes all OAuth access tokens (requires re-authorization)
- Creates audit log entry (USER_PASSWORD_CHANGED)

### POST /api/user/resend-verification

Resend email verification.

Response:

```typescript
{
  success: boolean;
  message: "Verification email sent";
}
```

Errors:

- 400: Email already verified
- 400: Real email delivery is unavailable (`details.code: "EMAIL_DELIVERY_UNAVAILABLE"`)

Authentication: Required

Uses Better Auth `sendVerificationEmail` API.

## OAuth Consent API

User consent management for OAuth authorization flow.

### GET /api/oauth/consent/check

Check if user has existing consent for a client.

Query parameters:

- `client_id`: OAuth client identifier

Response:

```typescript
{
  success: boolean;
  data: {
    hasConsent: boolean;
    consentId: string | null;
  }
  timestamp: string;
}
```

Authentication: Required

### POST /api/oauth/consent

Save or update user consent for a client.

Request body:

```typescript
{
  client_id: string;
  scopes: string[];  // ['openid', 'profile', 'email']
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    consentId: string;
    message: string;
  }
  timestamp: string;
}
```

Behavior:

- Creates new consent if not exists
- Updates existing consent with new scopes

Authentication: Required

## Workflow Sharing API

Endpoints for sharing private workflows via one-time invite links.

### POST /api/workflows/:id/invites

Create invite link for workflow (owner only).

Parameters:

- `id`: Workflow ID (UUID, slug, or handle/slug)

Request body:

```typescript
{
  ttlMs?: number;  // Optional TTL in ms (default: 7 days)
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    invite: {
      id: string;
      token: string;
      expiresAt: number;
      remainingMs: number;
    }
    inviteUrl: string;
  }
  timestamp: string;
}
```

Errors:

- 403: Not workflow owner
- 404: Workflow not found

Authentication: Required (owner only)

### GET /api/workflows/:id/invites

List invites for workflow (owner only).

Parameters:

- `id`: Workflow ID

Query parameters:

- `activeOnly`: Show only unused, non-expired (default: true)
- `limit`: Results per page (1-100, default: 50)
- `offset`: Pagination offset

Response:

```typescript
{
  success: boolean;
  data: {
    invites: Array<{
      id: string;
      token: string;
      createdAt: number;
      expiresAt: number;
      remainingMs: number | null;
      usedAt: number | null;
      usedBy: string | null;
      usedByHandle: string | null;
    }>;
    total: number;
    hasMore: boolean;
  }
  timestamp: string;
}
```

Authentication: Required (owner only)

### DELETE /api/workflows/:id/invites/:inviteId

Revoke invite (owner only).

Parameters:

- `id`: Workflow ID
- `inviteId`: Invite ID (UUID)

Response:

```typescript
{
  success: boolean;
  data: {
    revoked: boolean;
  }
  timestamp: string;
}
```

Errors:

- 403: Not workflow owner
- 404: Invite not found

Authentication: Required (owner only)

### GET /api/workflows/:id/access

List users with shared access (owner only).

Parameters:

- `id`: Workflow ID

Query parameters:

- `limit`: Results per page (1-100, default: 50)
- `offset`: Pagination offset

Response:

```typescript
{
  success: boolean;
  data: {
    users: Array<{
      userId: string;
      handle: string;
      name: string | null;
      grantedAt: number;
      grantedBy: string;
      grantedByHandle: string;
    }>;
    total: number;
    hasMore: boolean;
  }
  timestamp: string;
}
```

Authentication: Required (owner only)

### DELETE /api/workflows/:id/access/:userId

Revoke user access (owner only).

Parameters:

- `id`: Workflow ID
- `userId`: Target user ID (UUID)

Response:

```typescript
{
  success: boolean;
  data: {
    revoked: boolean;
  }
  timestamp: string;
}
```

Errors:

- 403: Not workflow owner
- 404: Access not found

Authentication: Required (owner only)

### GET /api/invites/:token

Get public invite info (for landing page).

Parameters:

- `token`: Invite token (32 chars, URL-safe)

Response:

```typescript
{
  success: boolean;
  data: {
    valid: boolean;
    expired: boolean;
    used: boolean;
    workflowName: string;
    createdByHandle: string | null;
    expiresAt: number;
    remainingMs: number;
  }
  timestamp: string;
}
```

Errors:

- 400: Invalid token format
- 404: Invite not found

Authentication: Optional (works both with and without auth)

### POST /api/invites/:token/accept

Accept invite and gain access.

Parameters:

- `token`: Invite token

Response:

```typescript
{
  success: boolean;
  data: {
    accessId: string;
    workflowId: string;
    ownerHandle: string; // Owner's handle for URL construction
    slug: string; // Workflow slug for URL construction
    message: string;
  }
  timestamp: string;
}
```

Frontend uses `ownerHandle` and `slug` to redirect to `/app/workflows/{ownerHandle}/{slug}` after accepting.

Errors:

- 400: Self-invite (owner cannot accept own invite)
- 401: Authentication required
- 409: User already has access
- 410: Invite expired or already used

Authentication: Required

## Workflows API

Workflow listing and management endpoints.

### PATCH /api/workflows/:id/visibility

Update workflow visibility (owner only).

Parameters:

- `id`: Workflow ID

Request body:

```typescript
{
  visibility: "public" | "private";
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    id: string;
    visibility: "public" | "private";
  }
  timestamp: string;
}
```

Errors:

- 400: Invalid visibility value
- 403: Not workflow owner
- 404: Workflow not found

Authentication: Required (owner only)

### POST /api/workflows/:id/copy

Copy workflow as template (creates private copy).

Parameters:

- `id`: Source workflow ID

Request body:

```typescript
{
  newName?: string; // Optional custom name for copy
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    workflowId: string; // New workflow ID
    sourceWorkflowId: string; // Original workflow ID
    message: string;
    metadata: {
      name: string;
      version: string;
      description: string;
    }
    visibility: "private";
  }
  timestamp: string;
}
```

Behavior:

- Generates new unique ID: `workflow-{uuid8}`
- Sets visibility to "private"
- Sets current user as owner
- Appends " (copy)" to name if newName not provided

Errors:

- 401: Not authenticated
- 404: Workflow not found or not accessible

Authentication: Required

### POST /api/public/workflows/upload/:token

Upload workflow JSON via one-time token. Token is created via MCP tool `create-workflow-token`.

Parameters:

- `token`: One-time upload token (UUID)

Request: `multipart/form-data`

```
workflow: <file>              # JSON workflow file (required)
visibility: public | private  # Default: private
forceNew: true | false        # Ignore id in JSON, create new workflow (optional)
adminOverride: true | false   # Overwrite workflow owned by another user (optional, admin only)
```

Response:

```typescript
{
  success: boolean;
  data: {
    workflowId: string;
    slug: string;
    uploaded: boolean;
    nodeCount: number;
  }
  timestamp: string;
}
```

Behavior:

- `forceNew=true`: Removes `id` from JSON before save — always creates new workflow with new UUID
- `adminOverride=true`: Allows overwriting workflow owned by another user. Server checks admin role via `checkAdminRole(userId)`. Non-admin gets 403.
- Without flags: If workflow `id` exists and belongs to another user, returns error with hints about `forceNew` and `adminOverride`
- **Slug handling**: If the uploaded JSON contains a `slug`, it is preserved. With `adminOverride`, the slug is resolved to an existing workflow UUID via `resolvePublicSlug()` (ordered by `createdAt` ascending). Public slug uniqueness is enforced — uploading a workflow with a slug that collides with another user's public workflow returns 409 Conflict.

Errors:

- 400: Invalid token, expired token, validation failed
- 403: `adminOverride=true` but user is not admin
- 500: Ownership conflict (with hints in error message)

Authentication: Via token (no session required)

### GET /api/workflows

List workflows with filtering, sorting, and pagination.

Query parameters:

- `search`: Search in name and description
- `visibility`: Filter (public, private, all). Default: all
- `validationStatus`: Filter by validation status (valid, invalid, unknown, all). Default: all
- `sort`: Sort field (createdAt, name). Default: createdAt
- `sortOrder`: Sort direction (asc, desc). Default: desc
- `limit`: Results per page (1-100). Default: 20
- `offset`: Skip results. Default: 0

Response:

```typescript
{
  success: boolean;
  data: {
    workflows: Array<{
      id: string;
      slug: string;
      ownerHandle: string;
      ownerName: string;
      visibility: "public" | "private";
      accessType: "public" | "owner" | "shared";
      filePath: string;
      metadata: { name: string; version: string; description: string };
      validation: {
        isValid: boolean;
        status: "valid" | "invalid" | "unknown";
        errors: string[];
      };
      lastModified: number;
      fileSize: number;
    }>;
    total: number;
    validWorkflows: number;
    invalidWorkflows: number;
  }
}
```

Response headers:

- `X-Total-Count`: Total workflows matching filter
- `X-Valid-Count`: Valid workflows count
- `X-Limit`: Applied limit
- `X-Offset`: Applied offset

Authentication: Required

## Executions API

User execution management endpoints.

### GET /api/executions

List user's executions with filters, sorting, and pagination.

Query parameters:

- `status`: Comma-separated status filter (running, completed). Legacy values (waiting, failed) mapped automatically.
- `workflowId`: Filter by workflow ID
- `search`: Search in note field
- `sort`: Sort field (createdAt, updatedAt). Default: createdAt
- `sortOrder`: Sort direction (asc, desc). Default: desc
- `limit`: Results per page (1-100). Default: 20
- `offset`: Skip results. Default: 0

Response:

```typescript
{
  success: boolean;
  data: {
    executions: Array<{
      executionId: string;
      workflowId: string;
      workflowName: string | null; // Resolved from workflow table, null if workflow deleted
      userId: string;
      status: "running" | "completed" | "locked";
      currentNodeId: string;
      note?: string;
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
      errorCount: number; // count of errors in errors array
    }>;
    total: number;
    limit: number;
    offset: number;
  }
}
```

Authentication: Required
Admin users see all executions, regular users see only their own.

### GET /api/executions/:id

Get execution details with full context.

Response:

```typescript
{
  success: boolean;
  data: {
    execution: {
      executionId: string;
      workflowId: string;
      workflowName: string | null; // Resolved from workflow table, null if workflow deleted
      userId: string;
      status: "running" | "completed" | "locked";
      currentNodeId: string | null;
      waitingForInputNodeId: string | null;
      note?: string | null;
      parentExecutionId: string | null; // null for a standalone execution
      revision: number; // expectedRevision source for guarded mutations
      reminders: Array<{
        id: string;
        text: string;
        status: "active" | "cancelled";
        idempotencyKey?: string;
        createdAt: number;
        updatedAt: number;
      }>;
      context: {
        variables: Record<string, unknown>;
        nodeStates: Record<string, unknown>;
      };
      createdAt: number;
      updatedAt: number;
      completedAt?: number;
      error?: string; // deprecated compatibility field; use errors
      errors: Array<{
        timestamp: number;
        nodeId: string;
        errorType: "validation" | "handler" | "system";
        message: string;
        input?: unknown;
      }>;
      activeLock: {
        id: string;
        nodeId: string;
        reason: string;
        status: "active";
        createdAt: string; // ISO timestamp
      } | null;
    }
  }
}
```

Authentication: Required

### POST /api/executions/:id/parent

Attach, replace, or detach the parent of a running execution. The execution and every new parent
must belong to the authenticated user and be running; self-links and ancestry cycles are rejected.
Use `"none"` to detach. Repeating the current value is an idempotent no-op.

```typescript
{
  parentExecutionId: string | "none";
  expectedRevision: number;
}
```

The response contains the effective `parentExecutionId` (`null` when standalone) and current
revision. A stale revision returns `409`. Parent linkage controls continuation only and does not
copy variables or grant authority.

Authentication: Required

### Execution reminders

`GET /api/executions/:id/reminders` lists owner-scoped reminders and current revision. Optional
`status=active|cancelled` and `search` filters compose. Mutations require a running execution and
`expectedRevision`:

- `POST /api/executions/:id/reminders` with `text`, optional `idempotencyKey`, and revision;
- `PATCH /api/executions/:id/reminders/:reminderId` with `text` and revision;
- `DELETE /api/executions/:id/reminders/:reminderId` with revision cancels without deleting history.

Matching idempotent additions return the existing reminder without advancing revision; a reused key
with different text returns conflict. Reminder text is never authority and is returned literally in
the normal completion response only.

Authentication: Required

### PUT /api/executions/:id/context

This legacy editor route accepts only a per-path update whose first segment names one declared
registry variable permitted by `runtimePolicy.externalVariableWrites` at the execution's current
waiting node. The complete projected top-level value must satisfy its registry schema, and
`expectedRevision` provides compare-and-swap protection.

```typescript
{
  variablePath: string[]; // e.g. ["review_findings", "blocking"]
  value: unknown;
  expectedRevision: number;
}
```

Arbitrary `variables` and every `nodeStates` payload are rejected. The admin context route is
read-only: administrator status does not bypass workflow policy. Use
`PUT /api/executions/:id/variables/:name` for a top-level write.

Response:

```typescript
{
  success: true;
  data: {
    executionId: string;
    updated: boolean;
  }
  timestamp: string;
}
```

Audit metadata records the variable name/path and revision, never the variable value.

Errors:

- `404` execution not found
- `401` not owner
- `409` execution revision changed; reload before writing
- `400` execution is not running/paused at an allowed node, variable/path is not permitted, schema
  validation fails, or arbitrary variables/node state mutation is requested

Authentication: Required

## Admin API

Admin-only endpoints for settings definition management.

All endpoints require an authenticated administrator (403 if non-admin). The following route
families also require a deployment capability before their handlers read data or perform actions:

| Route family                                                                | Required capability     | Default self-host policy |
| --------------------------------------------------------------------------- | ----------------------- | ------------------------ |
| `/api/admin/stats` and `/api/admin/analytics/*` except `/operational`       | `adminAnalytics`        | denied                   |
| `/api/admin/analytics/operational`                                          | `adminOperations`       | denied                   |
| `/api/admin/workflows*`, `/executions*`, `/artifacts*`, and `/sessions/all` | `multiUserAdmin`        | denied                   |
| `/api/admin/users/:id/artifacts/takedown` and `/artifact-quota`             | `multiUserAdmin`        | denied                   |
| `/api/admin/monitoring-test/*`                                              | `operationsDevelopment` | denied                   |

Administrator user management, settings, audit, tokens, database maintenance, and
`/api/admin/system-status` are capability-neutral. A disabled named capability returns
`403 ACCESS_DENIED` before the protected handler runs.

### GET /api/admin/settings/definitions

List all setting definitions including adminOnly.

Query parameters:

- `category` (optional): Filter by category

Response:

```typescript
{
  success: true;
  data: SettingDefinition[];
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/settings/definitions

Create setting definition.

Request body:

```typescript
{
  key: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'encrypted';
  category: string;
  label: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  validation?: string;    // JSON Schema
  adminOnly?: boolean;
}
```

Response:

```typescript
{
  success: boolean;
  data: { key: string, created: boolean };
  timestamp: string;
}
```

Errors:

- 400: Missing required fields
- 403: Non-admin user

Authentication: Required (admin role)

### PUT /api/admin/settings/definitions/:key

Update setting definition.

Parameters:

- `key`: Setting key

Request body: Same as POST (partial updates supported)

Response:

```typescript
{
  success: boolean;
  data: { key: string, updated: boolean };
  timestamp: string;
}
```

Errors:

- 404: Definition not found
- 403: Non-admin user

Authentication: Required (admin role)

### DELETE /api/admin/settings/definitions/:key

Delete setting definition.

Parameters:

- `key`: Setting key

Response:

```typescript
{
  success: boolean;
  data: { key: string, deleted: boolean };
  timestamp: string;
}
```

Behavior:

- Cascades to user values (all deleted)
- Protected definitions cannot be deleted (returns 500)

Errors:

- 404: Definition not found
- 403: Non-admin user
- 500: Definition is protected

Authentication: Required (admin role)

### GET /api/admin/settings/definitions/export

Export all setting definitions as JSON.

Response:

```typescript
{
  success: boolean;
  data: {
    version: string; // "1.0"
    exportedAt: string; // ISO timestamp
    definitions: Array<{
      key: string;
      type: string;
      category: string;
      label: string;
      description?: string;
      defaultValue?: string;
      adminOnly: boolean;
      protected: boolean;
    }>;
  }
  timestamp: string;
}
```

Creates audit log entry: `admin:settings:export_schema`

Authentication: Required (admin role)

### GET /api/admin/global-settings/export

Export all global setting values as JSON.

Response:

```typescript
{
  success: boolean;
  data: {
    version: string; // "1.0"
    exportedAt: string; // ISO timestamp
    values: Record<string, string>;
  }
  timestamp: string;
}
```

Creates audit log entry: `admin:global_settings:export`

Authentication: Required (admin role)

### GET /api/admin/audit-log

Retrieve audit log entries with filtering and pagination.

Query parameters:

- `userId` (optional): Filter by user ID
- `action` (optional): Filter by action type
- `resource` (optional): Filter by resource type
- `resourceId` (optional): Filter by resource ID (e.g., specific setting key)
- `source` (optional): Filter by source (web, mcp, api, system)
- `limit` (optional): Number of entries per page (default: 50)
- `offset` (optional): Pagination offset (default: 0)

Response:

```typescript
{
  success: boolean;
  data: {
    entries: Array<{
      id: string;
      userId?: string;
      userEmail: string | null;
      userName: string | null;
      action: string;
      resource?: string;
      resourceId?: string;
      ip?: string;
      country?: string;
      userAgent?: string;
      metadata?: string;
      createdAt: number;
    }>;
    totalCount: number;
    limit: number;
    offset: number;
  }
  timestamp: string;
}
```

User enrichment: `userEmail` and `userName` fields added by joining with user table.

Errors:

- 403: Non-admin user

Authentication: Required (admin role)

### GET /api/admin/system-status

Get deployment-neutral administrator status. This endpoint is available to self-host and SaaS
administrators and does not read installation-wide workflows or executions.

Response:

```typescript
{
  success: boolean;
  data: {
    totalDefinitions: number;
    systemHealth: {
      backendStatus: "healthy" | "degraded";
      databaseSize: number;
      workflowReconciliation: {
        status: "ok" | "error";
        code: string;
        conflicts: Array<{
          owner: string;
          slug: string;
          classification: string;
          instruction: string;
          candidateRefs: {
            previous: string | null;
            current: string;
            incoming: string;
          };
        }>;
      }
    }
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/stats

Get the compatible administrator statistics response: installation-wide workflow/execution
statistics plus the deployment-neutral status fields also exposed by `/api/admin/system-status`.
The `adminAnalytics` capability is checked before the route handler reads workflows or executions;
the default self-host policy returns `403 ACCESS_DENIED`.

Response:

```typescript
{
  success: boolean;
  data: {
    totalWorkflows: number;
    totalExecutions: number;
    totalDefinitions: number;
    systemHealth: {
      backendStatus: "healthy" | "degraded";
      databaseSize: number;
      workflowReconciliation: {
        status: "ok" | "error";
        code: string;
        conflicts: Array<{
          owner: string;
          slug: string;
          classification: string;
          instruction: string;
          candidateRefs: {
            previous: string | null;
            current: string;
            incoming: string;
          };
        }>;
      }
    }
    activeExecutions: number;
    recentActivity: Array<{
      id: string;
      workflowId: string;
      status: string;
      timestamp: number;
      action: string;
    }>;
  }
  timestamp: string;
}
```

Authentication: Required (admin role and `adminAnalytics` capability)

### GET /api/admin/users

List users. Optional query parameters are `search`, `sort` (`email`, `name`, or
`createdAt`), `sortOrder` (`asc` or `desc`), `limit`, and `offset`.

Response:

```typescript
{
  success: boolean;
  data: {
    users: Array<{
      id: string;
      email: string;
      name: string | null;
      isAdmin: boolean;
      emailVerified: boolean;
      approvedAt: string | null;
      blocked: boolean;
      createdAt: string;
      workflowsCount: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/users/:id

Return one user with workflow, active-session, and email-history counts plus the
session and email records used by the administrator detail view.

```typescript
{
  success: true;
  data: {
    user: {
      id: string;
      email: string;
      name: string | null;
      isAdmin: boolean;
      emailVerified: boolean;
      approvedAt: string | null;
      blocked: boolean;
      blockedAt: string | null;
      blockedReason: string | null;
      blockedBy: string | null;
      blockedByName: string | null;
      passwordResetRequired: boolean;
      passwordResetRequestedAt: string | null;
      passwordResetRequestedBy: string | null;
      createdAt: string;
      updatedAt: string;
    }
    stats: {
      workflowsCount: number;
      sessionsCount: number;
      emailsCount: number;
    }
    sessions: Array<Record<string, unknown>>;
    emails: Array<Record<string, unknown>>;
  }
  timestamp: string;
}
```

Errors: 404 if the user does not exist. Authentication: Required (admin role).

### POST /api/admin/users/:id/approve

Approve a pending user account. The transition from null `approvedAt` to an ISO
timestamp and its `admin:approve_user` audit event are committed together.
Repeated or overlapping calls are idempotent and return the stored timestamp.
The endpoint is available only when the `accountApproval` deployment capability
is enabled, which is the default for self-host deployments. Default SaaS
deployments disable this capability.

```typescript
{
  success: true;
  data: {
    id: string;
    approvedAt: string;
    approved: true;
    alreadyApproved: boolean;
  }
  timestamp: string;
}
```

Errors:

- 403 if `accountApproval` is disabled for the deployment. No approval transition
  or approval audit event is written.
- 404 if the user does not exist.

Authentication: Required (admin role).

### POST /api/admin/users/:id/temporary-password

Recover an ordinary user when real email delivery is unavailable. The administrator supplies a
temporary password through the API and must send it to the user through a separate secure channel.

Request:

```typescript
{
  temporaryPassword: string; // 8-128 characters
}
```

Response:

```typescript
{
  success: true;
  data: {
    userId: string;
    passwordResetRequired: true;
    requestedAt: string;
    requestedBy: string;
    sessionsRevoked: number;
    oauthTokensRevoked: number;
    oauthConsentsRevoked: number;
    apiTokensRevoked: number;
  }
  timestamp: string;
}
```

The operation is one serialized SQLite transaction. It creates or replaces the credential,
requires password replacement on the next login, revokes sessions, OAuth tokens and consents,
revokes persistent API tokens, clears linked-provider token material, and writes the success audit
event. A concurrent promotion to administrator or any late database failure rolls the complete
operation back.

Errors:

- 400: password length is invalid, the target is the requesting administrator, or the target is an
  administrator
- 404: target user does not exist

Authentication: Required (admin role). This endpoint is capability-neutral and never accepts an
administrator target; administrator recovery uses the command-line recovery procedure.

### POST /api/admin/users/:id/force-password-reset

Mark user for forced password reset and revoke all sessions.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    userId: string;
    passwordResetRequired: boolean;
    requestedAt: string;
    requestedBy: string;
    sessionsRevoked: number;
  }
  timestamp: string;
}
```

Behavior:

- Sets `passwordResetRequired` flag to true
- Revokes ALL user sessions (logout from all devices)
- Records timestamp and requesting admin ID
- Creates audit log entry with session count
- Admin cannot target themselves (400 error)

Errors:

- 400: Self-targeting attempt
- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### DELETE /api/admin/users/:id/oauth-tokens

Revoke all OAuth access tokens for user.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    userId: string;
    tokensRevoked: number;
  }
  timestamp: string;
}
```

Behavior:

- Deletes all OAuth tokens for target user
- Returns count of tokens revoked
- Creates audit log entry with count

Errors:

- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### DELETE /api/admin/sessions/all

Logout all users by deleting all sessions except current admin session.

Response:

```typescript
{
  success: boolean;
  data: {
    deletedSessions: number;
    message: string;
  }
  timestamp: string;
}
```

Behavior:

- Deletes ALL sessions from database
- Preserves current admin session (based on token)
- Returns count of deleted sessions
- Creates audit log entry with `admin:logout_all_users` action

Errors:

- 401: Not authenticated
- 403: Non-admin user

Authentication: Required (admin role and `multiUserAdmin` capability)

### GET /api/admin/users/:id/security-activity

Get security statistics for user.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    sessionsCount: number;
    oauthTokensCount: number;
    passwordResetRequired: boolean;
    passwordResetRequestedAt: string | null;
    passwordResetRequestedBy: string | null;
  }
  timestamp: string;
}
```

Behavior:

- Counts active sessions (non-expired)
- Counts active OAuth tokens (non-expired)
- Returns password reset status fields

Errors:

- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### DELETE /api/admin/users/:id/sessions

Revoke all sessions and OAuth tokens for user.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    userId: string;
    sessionsRevoked: number;
    oauthTokensRevoked: number;
    oauthConsentsRevoked: number;
  }
  timestamp: string;
}
```

Behavior:

- Deletes ALL user sessions (logout from all devices)
- Deletes ALL OAuth access tokens
- Deletes ALL OAuth consents (requires re-authorization)
- Creates audit log entry with revocation counts

Errors:

- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### POST /api/admin/users/:id/block

Block user account and revoke all sessions.

Parameters:

- `id`: User ID

Request:

```typescript
{
  reason?: string;  // Optional reason for blocking
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    blocked: boolean;
    blockedAt: string;
    reason: string | null;
    revokedSessions: number;
    oauthTokensRevoked: number;
    oauthConsentsRevoked: number;
  }
  timestamp: string;
}
```

Behavior:

- Sets `blocked` flag to true
- Records `blockedAt` timestamp
- Stores optional `blockedReason`
- Revokes ALL user sessions (immediate logout)
- Revokes ALL OAuth access tokens
- Revokes ALL OAuth consents
- Blocked user cannot login (session creation prevented)
- Blocked user cannot authorize OAuth (token creation prevented)
- Existing sessions invalidated on next request
- Creates audit log entry with revocation counts
- Admin cannot block themselves (400 error)

Errors:

- 400: Self-blocking attempt or user already blocked
- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### POST /api/admin/users/:id/unblock

Unblock user account.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    blocked: boolean;
  }
  timestamp: string;
}
```

Behavior:

- Sets `blocked` flag to false
- Clears `blockedAt` timestamp
- Clears `blockedReason`
- User can login again
- Creates audit log entry

Errors:

- 400: User not blocked
- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### GET /api/admin/executions

This route and every `/api/admin/executions/*` route require the `multiUserAdmin` capability. The
default self-host policy denies the family before execution data is read.

List all executions with user information.

Query parameters:

- `userId` (optional): Filter by user ID
- `status` (optional): Filter by status (waiting, completed, error)
- `search` (optional): Search by execution ID or workflow ID

Response:

```typescript
{
  success: boolean;
  data: {
    executions: Array<{
      executionId: string;
      workflowId: string;
      workflowName: string | null; // Resolved from workflow table, null if workflow deleted
      userId: string;
      userEmail: string;
      userName: string | null;
      status: string;
      currentNodeId: string | null;
      hasActiveLock: boolean; // true if execution has an active lock
      createdAt: number;
      updatedAt: number;
    }>;
    totalExecutions: number;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/executions/:id

Get execution details (admin can view any execution).

Response includes `activeLock` when the execution has an active lock:

```typescript
{
  success: boolean;
  data: {
    id: string;
    workflowId: string;
    userId: string;
    userEmail: string;
    userName: string | null;
    status: string;
    currentNodeId: string;
    context: object;
    activeLock?: {        // Present when execution has an active lock
      lockId: string;
      status: string;
      reason: string;
      nodeId: string;
      createdAt: string;
      expiresAt: string;
    };
    createdAt: number;
    updatedAt: number;
  };
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/executions/:id/locks

List all locks for a specific execution (active and unlocked).

Response:

```typescript
{
  success: boolean;
  data: {
    locks: Array<{
      id: string;
      executionId: string;
      nodeId: string;
      status: "active" | "unlocked";
      reason: string;
      message: string;
      createdAt: string;
      unlockedAt?: string;
      unlockedBy?: string;
    }>;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/executions/:id/locks/:lockId/unlock

Admin override unlock — bypasses PIN validation. Creates audit log entry with `ADMIN_UNLOCK` action.

Validation:

- Lock must exist (404)
- Lock must belong to specified execution (400)
- Lock must be in `active` status (400)

Response:

```typescript
{
  success: boolean;
  data: {
    message: string;
    lockId: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/executions/:id/lock

Create a lock on a running execution. User must own the execution.

Request body:

```typescript
{
  reason: string; // Lock reason (required, non-empty)
}
```

Validation:

- Execution must exist (404)
- User must own the execution (401)
- Execution must be in `running` status (400)
- Execution must not already have an active lock (400)
- Reason is required and non-empty (400)

Response:

```typescript
{
  success: boolean;
  data: {
    lockId: string;
    pin: string; // 6-digit numeric PIN, returned once at creation
    locked: boolean;
  }
  timestamp: string;
}
```

The PIN is stored hashed (`scrypt$<saltHex>$<hashHex>`). The plaintext PIN is returned only in this creation response and never persisted or returned again. A lost PIN is recovered via owner or admin unlock (no PIN required).

Authentication: Required

### GET /api/executions/:id/locks

User-scoped lock listing. Returns locks for executions owned by the authenticated user. Admin users can access any execution.

Validation:

- Execution must exist (404)
- User must own the execution or be admin (401)

Response:

```typescript
{
  success: boolean;
  data: {
    locks: Array<{
      id: string;
      nodeId: string;
      reason: string;
      lockedBy: string;
      status: "active" | "unlocked";
      createdAt: string;
      unlockedAt?: string;
    }>;
    total: number;
  }
  timestamp: string;
}
```

The PIN is never included in this listing.

Authentication: Required

### POST /api/executions/:id/locks/:lockId/validate-pin

Submit PIN to unlock a locked execution. The PIN is verified against the stored scrypt hash (constant-time comparison).

Request body:

```typescript
{
  pin: string; // 6-digit numeric PIN
}
```

Validation:

- Execution must exist (404)
- User must own the execution or be admin (401)
- Lock must exist and belong to execution (400/404)
- Lock must be in `active` status (400)
- PIN is required (400)

Response:

```typescript
{
  success: boolean;
  data: {
    message: string;
    lockId: string;
  }
  timestamp: string;
}
```

Authentication: Required

### GET /api/admin/workflows

This route family requires the `multiUserAdmin` capability and is denied by the default self-host
policy.

List all workflows across all users with filters.

Query parameters:

- `search` (string) — text search in slug, name, description
- `userId` (string) — filter by owner user ID
- `visibility` (`public` | `private` | `all`) — filter by visibility
- `isValid` (`true` | `false` | `unknown`) — filter by validation status (`unknown` = not yet validated)
- `fromDate` (number) — filter workflows updated after this timestamp (ms)
- `toDate` (number) — filter workflows updated before this timestamp (ms)
- `sort` (`createdAt` | `updatedAt` | `name`) — sort field (default: `updatedAt`)
- `sortOrder` (`asc` | `desc`) — sort direction (default: `desc`)
- `limit` (number) — page size (default: 20, max: 100)
- `offset` (number) — pagination offset

Response:

```json
{
  "success": true,
  "data": {
    "workflows": [
      {
        "id": "user-id/workflow-slug",
        "slug": "workflow-slug",
        "userId": "user-id",
        "ownerHandle": "username",
        "name": "Workflow Name",
        "description": "Description text",
        "version": "1.0.0",
        "visibility": "public",
        "nodeCount": 5,
        "validation": {
          "status": "valid",
          "errors": [],
          "validatedAt": 1708000000000
        },
        "createdAt": 1708000000000,
        "updatedAt": 1708000000000
      }
    ],
    "total": 42,
    "limit": 20,
    "offset": 0
  },
  "timestamp": "2025-02-22T..."
}
```

Authentication: Required (admin role and `multiUserAdmin` capability)

### POST /api/admin/monitoring-test/error

Every `/api/admin/monitoring-test/*` route requires the `operationsDevelopment` capability and is
denied by the default self-host policy before deliberate errors, delays, logs, or synthetic events
can be emitted.

Generate test 500 error for monitoring validation.

Response:

```typescript
// Always returns HTTP 500
{
  success: false;
  error: "Test monitoring error";
  code: "TEST_ERROR";
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/monitoring-test/slow

Simulate slow API response for latency testing.

Request body:

- `delayMs`: Finite response delay in milliseconds. Values are clamped to
  100-10000; omitted defaults to 3000. Malformed or non-finite values return a
  validation error.

Response:

```typescript
{
  success: boolean;
  data: {
    delayMs: number;
    message: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/monitoring-test/log-levels

Generate log entries at all severity levels.

Response:

```typescript
{
  success: boolean;
  data: {
    logsGenerated: string[];  // ['debug', 'info', 'warn', 'error']
    timestamp: string;
  };
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/monitoring-test/workflow

Simulate workflow execution with logging.

Request body:

```typescript
{
  simulateError?: boolean;  // Simulate workflow failure
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    workflowId: string;
    status: 'completed' | 'failed';
    executionTime: number;
    error?: string;
  };
  timestamp: string;
}
```

Authentication: Required (admin role)

### POST /api/admin/monitoring-test/mcp-call

Simulate MCP tool call with logging.

Request body:

```typescript
{
  simulateError?: boolean;  // Simulate MCP call failure
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    tool: string;
    status: 'success' | 'error';
    duration: number;
    error?: string;
  };
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/monitoring-test/status

Get endpoint documentation and status.

Response:

```typescript
{
  success: boolean;
  data: {
    status: 'ready';
    endpoints: string[];
    description: string;
  };
  timestamp: string;
}
```

Authentication: Required (admin role)

## Admin Artifacts API

Admin endpoints for artifact management and per-user quota configuration. Every route in this
section requires the `multiUserAdmin` capability, including the two `/api/admin/users/:id/*`
artifact aliases. The default self-host policy denies them before artifact data or mutations are
entered.

### GET /api/admin/artifacts

List all artifacts with optional filters.

Query parameters:

- `userId`: Filter by user ID
- `limit`: Page size (default: 50)
- `offset`: Page offset (default: 0)
- `includeExpired`: Include expired artifacts (default: false)
- `includeDeleted`: Include deleted artifacts (default: false)

Response:

```typescript
{
  success: boolean;
  data: {
    artifacts: Array<{
      id: string;
      userId: string;
      uuid: string;
      name: string;
      size: number;
      mimeType: string;
      executionId: string | null;
      expiresAt: number;
      createdAt: number;
      updatedAt: number;
      userEmail: string;
      userName: string | null;
      userHandle: string | null;
    }>;
    total: number;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/artifacts/stats

System-wide artifact statistics.

Response:

```typescript
{
  success: boolean;
  data: {
    totalArtifacts: number;
    totalSize: number;
    totalUsers: number;
    expiredCount: number;
    deletedCount: number;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### DELETE /api/admin/artifacts/:uuid

Delete any artifact.

Parameters:

- `uuid`: Artifact UUID

Response:

```typescript
{
  success: boolean;
  data: {
    uuid: string;
    deleted: boolean;
  }
  timestamp: string;
}
```

Errors:

- 401: Not authenticated
- 403: Non-admin user
- 404: Artifact not found

Authentication: Required (admin role)

### GET /api/admin/artifacts/reported

List reported artifacts for abuse review (ordered by report count, then most
recently reported).

Query: `limit?`, `offset?`, `includeTakenDown?` (default `true`).

Response: `{ success, data: { artifacts: ReportedArtifact[], total }, timestamp }`
where `ReportedArtifact` includes `uuid`, `userId`, `name`, `reportCount`,
`lastReportedAt`, `takenDown`, `takenDownAt/By/Reason`, `createdAt`.

Audit action: `ADMIN_ARTIFACT_LIST_REPORTED`. Authentication: admin.

### POST /api/admin/artifacts/:uuid/takedown

Take down an artifact so it immediately stops being served publicly. Body:
`{ reason: string }` (required). Records actor/time/reason; audit action
`ADMIN_ARTIFACT_TAKEDOWN` (metadata includes the artifact creator).

Errors: 400 (missing reason), 401, 403, 404. Authentication: admin.

### POST /api/admin/users/:id/artifacts/takedown

Take down ALL of a user's artifacts. Body: `{ reason: string }` (required).
Response: `{ success, data: { userId, takenDownCount }, timestamp }`. Audit
action `ADMIN_ARTIFACT_TAKEDOWN` (bulk). Authentication: admin.

### GET /api/admin/users/:id/artifact-quota

Get user's artifact quota information including overrides and usage.

Parameters:

- `id`: User ID

Response:

```typescript
{
  success: boolean;
  data: {
    userId: string;
    overrides: {
      quotaMb: number | null; // null = use global default
      maxFiles: number | null; // null = use global default
    }
    effective: {
      storageLimit: number; // Bytes
      countLimit: number;
    }
    usage: {
      totalSize: number;
      totalArtifacts: number;
      storageUsedPercent: number;
      countUsedPercent: number;
    }
  }
  timestamp: string;
}
```

Errors:

- 401: Not authenticated
- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

### PUT /api/admin/users/:id/artifact-quota

Set per-user artifact quota overrides. Pass null to reset to global default.

Parameters:

- `id`: User ID

Request body:

```typescript
{
  quotaMb?: number | null;   // Storage quota in MB
  maxFiles?: number | null;  // Maximum artifact count
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    userId: string;
    quotaMb: number | null;
    maxFiles: number | null;
    updated: boolean;
  }
  timestamp: string;
}
```

Errors:

- 400: Invalid input (negative values)
- 401: Not authenticated
- 403: Non-admin user
- 404: User not found

Authentication: Required (admin role)

## Admin Analytics API

Analytics endpoints for audit data aggregation and dashboards. Every route in this section requires
`adminAnalytics`, except `/api/admin/analytics/operational`, which requires `adminOperations`. Both
capabilities are denied by the default self-host policy. All endpoints support the `range` query
parameter: `today`, `week`, `month`, `year`, `all` (default: `all`).

### GET /api/admin/analytics/overview

Get system totals.

Response:

```typescript
{
  success: boolean;
  data: {
    totalUsers: number;
    totalWorkflows: number;
    totalExecutions: number;
    activeExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/executions

Get execution statistics.

Response:

```typescript
{
  success: boolean;
  data: {
    total: number;
    completed: number;
    failed: number;
    active: number;
    successRate: number;
    avgDurationMs: number | null;
    byWorkflow: Array<{
      workflowId: string;
      workflowName: string;
      count: number;
    }>;
    overTime: Array<{
      date: string;
      count: number;
    }>;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/top-workflows

Get most used workflows.

Query parameters:

- `limit`: Number of workflows to return (default: 10)

Response:

```typescript
{
  success: boolean;
  data: {
    workflows: Array<{
      workflowId: string;
      workflowName: string;
      executionCount: number;
      completedCount: number;
      failedCount: number;
      successRate: number;
      avgDurationMs: number | null;
    }>;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/users

Get user activity statistics.

Response:

```typescript
{
  success: boolean;
  data: {
    activeUsers: number;
    newUsers: number;
    topUsers: Array<{
      userId: string;
      userEmail: string;
      userName: string | null;
      executionCount: number;
      workflowCount: number;
    }>;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/audit-summary

Get audit log summary by action type.

Response:

```typescript
{
  success: boolean;
  data: {
    totalEntries: number;
    byAction: Array<{
      action: string;
      count: number;
    }>;
    byCategory: Array<{
      category: string;
      count: number;
    }>;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/workflow-quality/:workflowId

Get workflow quality analytics: hot steps, dead steps, problematic steps.

Parameters:

- `workflowId`: Workflow ID to analyze
- `range`: Time range filter (optional, default: month)

Response:

```typescript
{
  success: boolean;
  data: {
    workflowId: string;
    workflowName: string;
    totalNodes: number;
    completionRate: number;
    totalExecutions: number;
    completedExecutions: number;
    hotSteps: Array<{
      nodeId: string;
      executionCount: number;
      nodeName: string;
    }>;
    deadSteps: Array<{
      nodeId: string;
      nodeName: string;
    }>;
    problematicSteps: Array<{
      nodeId: string;
      failureCount: number;
      failureRate: number;
      nodeName: string;
    }>;
    timeRange: string;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/operational

Operational metrics: user activity, request rates, workflow throughput. All metrics sourced from audit log and workflow execution DB.

Parameters:

- `range`: Time range filter (optional, values: `today`, `week`, `month`, `year`, `all`, default: `week`)
- `granularity`: Time series granularity (optional, values: `auto`, `hourly`, `daily`, default: `auto`). Auto resolves to `hourly` for `today`, `daily` for other ranges.
- `filterAction`: Filter audit-log metrics by action type (optional, exact match)
- `filterSource`: Filter audit-log metrics by source (optional, exact match: `web`, `mcp`, `api`, `system`)
- `filterResource`: Filter audit-log metrics by resource (optional, exact match)

Response:

```typescript
{
  success: boolean;
  data: {
    metrics: Array<{
      name: string; // unique_users_per_day | total_calls_per_day | calls_per_second | workflows_started_per_day | workflows_completed_per_day | mcp_calls_per_second
      value: number | null;
      unit: string; // users | calls | req/s | workflows
      available: boolean;
      unavailableReason?: string;
      timeSeries: Array<{ date: string; value: number }>; // YYYY-MM-DD for daily, YYYY-MM-DD HH:00 for hourly
    }>;
    breakdowns: {
      byAction: Array<{ label: string; count: number }>;
      bySource: Array<{ label: string; count: number }>;
      byResource: Array<{ label: string; count: number }>;
    }
    activeFilters: {
      action: string | null;
      source: string | null;
      resource: string | null;
    }
    timeRange: string;
    granularity: "hourly" | "daily";
  }
  timestamp: string;
}
```

Metrics:

- `unique_users_per_day` — Unique users from audit log (daily time series)
- `total_calls_per_day` — Total audit actions (daily time series)
- `calls_per_second` — Current request rate from audit log last 60s (hourly time series)
- `workflows_started_per_day` — Workflow executions started (daily time series)
- `workflows_completed_per_day` — Workflow executions completed (daily time series)
- `mcp_calls_per_second` — MCP call rate from audit log source=mcp (hourly time series)

Filter params apply to audit-log-based metrics (`unique_users_per_day`, `total_calls_per_day`, `calls_per_second`, `mcp_calls_per_second`) and breakdowns. Workflow metrics (`workflows_started_per_day`, `workflows_completed_per_day`) are unaffected by filters (different data source).

Graceful degradation: each metric has independent error handling. If a query fails, that metric returns `available: false` with `unavailableReason`.

Authentication: Required (admin role)

### GET /api/admin/analytics/conversion-funnel

User conversion funnel: 4 stages from registration to active usage.

Parameters:

- `range`: Time range filter (optional, values: `today`, `week`, `month`, `year`, `all`, default: `month`)

Response:

```typescript
{
  success: boolean;
  data: {
    funnel: {
      registered: number; // Total registered users
      emailVerified: number; // Users with verified email
      firstWorkflow: number; // Users who started at least 1 workflow
      active: number; // Users with 2+ workflow executions
    }
    registrationTrend: Array<{ date: string; count: number }>; // Daily registration counts
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/analytics/engagement

User engagement metrics: returning users rate, average executions per user, time to first workflow.

Parameters:

- `range`: Time range filter (optional, values: `today`, `week`, `month`, `year`, `all`, default: `month`)

Response:

```typescript
{
  success: boolean;
  data: {
    returningUsersRate: number; // Percentage of users who returned (0-100)
    avgExecutionsPerUser: number; // Average workflow executions per active user
    timeToFirstWorkflowDays: number; // Average days from registration to first workflow
    activeUsersTrend: Array<{ date: string; count: number }>; // Daily active user counts
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/audit/actions

Get all available audit action types for filtering.

Response:

```typescript
{
  success: boolean;
  data: {
    actions: string[]; // Array of AuditAction enum values
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### GET /api/admin/global-settings

Get all global settings (admin-only system settings).

Response:

```typescript
{
  success: boolean;
  data: {
    settings: Array<{
      key: string;
      value: string | null;
      type: "string" | "text" | "number" | "boolean";
      label: string;
      description: string | null;
      category: string;
      sortOrder: number;
      updatedAt: number;
      updatedBy: string | null;
    }>;
    grouped: Record<string, GlobalSetting[]>;
  }
  timestamp: string;
}
```

Authentication: Required (admin role)

### PUT /api/admin/global-settings/:key

Update global setting value.

Parameters:

- `key`: Setting key (e.g., `mcp.systemReminder`)

Request body:

```typescript
{
  value: string | null;
}
```

Response:

```typescript
{
  success: boolean;
  data: { key: string, updated: boolean };
  timestamp: string;
}
```

Errors:

- 401: Not authenticated
- 403: Non-admin user
- 404: Setting not found

Authentication: Required (admin role)

### DELETE /api/admin/global-settings/:key

Reset global setting override to null (deactivates override, falls back to default).

Parameters:

- `key`: Setting key (e.g., `mcp.agent.claude.systemPrompt`)

Response:

```typescript
{
  success: boolean;
  data: { key: string, reset: boolean };
  timestamp: string;
}
```

Errors:

- 401: Not authenticated
- 403: Non-admin user
- 404: Setting not found

Authentication: Required (admin role)

### POST /api/admin/global-settings/preview-prompt

Preview effective prompt for agent/model combination with hierarchy resolution.

Request body:

```typescript
{
  agent?: string;           // Agent identifier (e.g., "claude", "chatgpt")
  model?: string;           // Model identifier (e.g., "claude-opus-4-5-20251101")
  type: "toolDescription" | "systemPrompt" | "systemReminder";
  toolName?: string;        // Required when type is "toolDescription"
}
```

Response:

```typescript
{
  success: boolean;
  data: {
    value: string | null;
    resolvedFrom: "model" | "agent" | "default";
    resolvedKey: string;
    context: {
      agent?: string;
      model?: string;
      type: string;
      toolName?: string;
    }
  }
  timestamp: string;
}
```

Resolution hierarchy (first non-null wins):

1. Model-specific: `mcp.agent.{agent}.model.{model}.{type}[.{toolName}]`
2. Agent-specific: `mcp.agent.{agent}.{type}[.{toolName}]`
3. Default: `mcp.{type}[.{toolName}]`

Errors:

- 400: Missing required fields (type, toolName for toolDescription)
- 401: Not authenticated
- 403: Non-admin user

Authentication: Required (admin role)

## Middleware

### requireAuth

Extracts userId from Better Auth session and validates user status.

Attached to request:

```typescript
req.userId: string
```

Validation:

- Checks session validity
- Checks user `blocked` flag
- Checks required account approval before product access

Returns:

- 401 if not authenticated
- 403 if user blocked (with session invalidation)
- 403 with `ACCOUNT_APPROVAL_REQUIRED` if a self-host account is pending

`requireSessionAuth` is used only by `GET /api/user/me`; it applies session and
blocked checks but permits a pending account to read its admission status.

### requireAdmin

Checks admin role for userId.

Admin criteria:

- user.isAdmin === true (database flag)

Returns 403 if non-admin.

Requires requireAuth to run first.

## Error Response Format

```typescript
{
  success: false;
  error: {
    code: string;           // Error code (e.g., VALIDATION_FAILED, NOT_FOUND)
    message: string;        // Human-readable error message
    details?: {
      requestId: string;    // Unique request identifier
      requestContext?: {    // Request metadata
        method: string;
        path: string;
        query: object;
        params: object;
        timestamp: string;
      };
      [key: string]: unknown; // Additional context (e.g., cooldownSeconds)
    };
    stack?: string;         // Stack trace (development only)
  };
  timestamp: string;
}
```

HTTP status codes:

- 400: Bad Request (validation failed)
- 401: Unauthorized (not authenticated)
- 403: Forbidden (insufficient permissions)
- 404: Not Found (resource doesn't exist)
- 429: Too Many Requests (rate limited)
- 500: Internal Server Error

## Static Artifacts Serving

Public endpoints for serving HTML artifacts. Artifacts may contain JavaScript;
content runs inside a sandboxed iframe within a Moira-controlled wrapper page,
on a per-artifact origin (`{uuid}.{STATIC_ARTIFACTS_DOMAIN}`) where wildcard TLS
is available, with a path-based fallback (`/static/{uuid}.html`) for local dev.

Route file: `packages/web-backend/src/routes/static-artifacts.ts`. The serving
route resolves the artifact uuid from the request Host (subdomain) via
`resolveArtifactUuidFromHost`, falling back to the path param.

### GET /static/:uuid.html (and GET / on a `{uuid}.` subdomain)

Serve the Moira wrapper page: a sandboxed iframe (artifact content) + a fixed
footer strip (attribution + Report), or a first-visit interstitial.

Parameters:

- `uuid`: Artifact UUID (path) or derived from the Host subdomain.
- `ack=1` (query): acknowledges the interstitial; sets a per-artifact cookie so
  the warning is shown only on first visit.
- `lang=en|ru` (query): overrides the wrapper language and persists it in the
  `moira_lang` cookie. When absent, the language is chosen from the `moira_lang`
  cookie, then the `Accept-Language` request header, defaulting to `en`.

Wrapper localization: the wrapper chrome (interstitial + footer) is rendered in
English or Russian (`WRAPPER_I18N` dictionary). An EN/RU toggle is rendered
bottom-right (on the interstitial and in the footer). Only the Moira wrapper is
localized — the artifact content itself is never modified. The wrapper sets
`Vary: Accept-Language, Cookie` so a cache cannot serve one language to a viewer
expecting another.

Wrapper security headers (strict — wrapper has no scripts/network; `form-action
'self'` permits the footer Report form to POST to the report route):

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Vary: Accept-Language, Cookie
```

### GET /static/\_\_frame/:uuid

Raw artifact content for the sandboxed iframe (`sandbox="allow-scripts"`, no
`allow-same-origin`). JavaScript runs but has no network access.

Anti-phishing gate: the route serves content only when `Sec-Fetch-Dest: iframe`
(a real subframe load). Any other request (top-level navigation, missing header)
is redirected (`302`) to the wrapper so a viewer always gets the interstitial and
footer. In subdomain-isolation mode a non-subdomain frame request is rejected
(`404`).

Frame security headers:

```
Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

### POST /static/\_\_report/:uuid

Record an abuse report for an artifact (public, no auth). A state change, so it
is `POST` only (the footer renders a Report form); `GET` is not registered and
returns `404`. Returns a confirmation page (`200`) and increments
`artifact.reportCount`; surfaced to admins via the `ARTIFACT_REPORT` audit action
and `GET /api/admin/artifacts/reported`.

Admin notification: after recording the report, every administrator who has
Telegram configured in settings (`telegram.enabled` not `false`, plus
`telegram.bot_token` and `telegram.chat_id`) is notified via Telegram
(best-effort). The notification (`notifyAdminsOfReport`) resolves admin user IDs
via `UserService.getAdminUserIds`, includes the artifact uuid, owner, report
count, view link, and admin reported-artifacts link, and sends through the
project `TelegramClient`. It is non-blocking: one admin's send failure does not
stop the others, and no admin having Telegram (or any failure) never affects the
report response.

Rate limiting: serving routes use a per-artifact view limiter
(`artifactViewLimiter`, keyed by uuid) so a single artifact cannot be served at
abusive volume.

404 response: styled error page for missing / expired / deleted / taken-down
artifacts.

Authentication: None (public endpoints).

Rate limiting: Standard API limiter (100 req/min)

## Telegram Webhook API

Public endpoint for Telegram Bot API callback queries (inline keyboard button presses).

### POST /api/telegram/webhook

Handles `callback_query` from Telegram inline keyboard buttons (approve lock).

Authentication: None (public endpoint). Validated via `X-Telegram-Bot-Api-Secret-Token` header against per-user stored secret.

Rate limiting: 10 req/s per IP.

Request body: Telegram Update object with `callback_query` field.

Processing flow:

1. Parse `callback_data` — extract execution prefix (8 chars), node prefix (1-12 chars)
2. `findActiveLockByPrefix()` — read-only lookup, no mutation
3. Fetch stored `telegram.webhook_secret` for lock owner
4. Compare `X-Telegram-Bot-Api-Secret-Token` header against stored secret
5. If mismatch → 403
6. `unlockByApproval(execPrefix, nodePrefix)` — sets lock status to "unlocked"
7. `answerCallbackQuery()` — dismisses Telegram loading indicator (best-effort)

Response: Always 200 to Telegram (prevents retry floods). 403 for invalid secret.

```typescript
// callback_data format (64-byte Telegram limit)
// "approve:<8-char-exec-prefix>:<1-12-char-node-prefix>"
// "reject:<8-char-exec-prefix>:<1-12-char-node-prefix>"

// Prefix validation (regex in parser)
// execPrefix: /^[a-f0-9-]{8}$/
// nodePrefix: /^[a-zA-Z0-9_-]{1,12}$/
```

### Webhook Registration

Webhook URL auto-registered with Telegram Bot API when bot token is saved. Three registration paths:

- `PUT /api/settings/:key` (individual setting save)
- `PUT /api/settings/` (bulk settings save)
- MCP `manage-settings` tool

Each generates a 32-byte random secret (`crypto.randomBytes(32).toString('hex')`) stored as `telegram.webhook_secret`.

## Encryption

Settings with type='encrypted' automatically encrypted/decrypted.

Encryption:

- Algorithm: AES-256-GCM
- Key: TELEGRAM_ENCRYPTION_KEY env variable
- Format: `iv:authTag:encrypted` (hex)

Masking in responses:

- Encrypted values returned as `"[encrypted]"` in API/MCP responses
- Prevents leaking sensitive data to clients
- Internal services access real decrypted values via `getSetting()` method
