/**
 * Unified Database Schema
 * All tables: Better Auth + Workflows + Settings
 */

import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

// ===== Better Auth Tables =====

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  // Handle: unique user identifier for URLs and workflow references (e.g., @john-doe)
  // Format: alphanumeric + hyphen, 4-40 chars, globally unique
  // Derived from email prefix on registration, with collision resolution via random suffix
  handle: text("handle").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).default(false),
  image: text("image"),
  isAdmin: integer("isAdmin", { mode: "boolean" }).default(false),
  blocked: integer("blocked", { mode: "boolean" }).default(false),
  blockedAt: text("blockedAt"),
  blockedReason: text("blockedReason"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Required to break circular type inference for self-referential FK
  blockedBy: text("blockedBy").references((): any => user.id),
  passwordResetRequired: integer("passwordResetRequired", { mode: "boolean" }).default(false),
  passwordResetRequestedAt: text("passwordResetRequestedAt"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Required to break circular type inference for self-referential FK
  passwordResetRequestedBy: text("passwordResetRequestedBy").references((): any => user.id),
  // Legal consent fields - stored for GDPR compliance proof
  acceptedTermsAt: text("acceptedTermsAt"), // ISO timestamp when Terms of Service accepted
  acceptedNotRussianResidentAt: text("acceptedNotRussianResidentAt"), // ISO timestamp when non-RU resident confirmed
  // Per-user artifact quota overrides (null = use global setting)
  artifactQuotaMb: integer("artifactQuotaMb"), // Max total storage in MB (overrides artifacts.default_quota_mb)
  artifactMaxFiles: integer("artifactMaxFiles"), // Max artifact count (overrides artifacts.default_max_files)
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: text("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  country: text("country"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt"),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: text("expiresAt").notNull(),
  createdAt: text("createdAt"),
  updatedAt: text("updatedAt"),
});

export const oauthApplication = sqliteTable("oauthApplication", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("clientId").notNull().unique(),
  clientSecret: text("clientSecret"),
  redirectURLs: text("redirectURLs").notNull(),
  type: text("type").notNull(),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  accessToken: text("accessToken").notNull(),
  refreshToken: text("refreshToken"),
  accessTokenExpiresAt: text("accessTokenExpiresAt").notNull(),
  refreshTokenExpiresAt: text("refreshTokenExpiresAt"),
  clientId: text("clientId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  // MCP server version at token creation time (#196)
  // Used to detect outdated clients after server deploy
  toolsVersion: text("toolsVersion"),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("clientId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
  consentGiven: integer("consentGiven", { mode: "boolean" }).default(false),
});

// ===== MCP Moira Workflow Tables =====

export const workflow = sqliteTable(
  "workflow",
  {
    // UUID primary key - auto-generated, never user-controlled
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Slug: user-facing identifier for URLs and references (e.g., my-workflow)
    // Format: alphanumeric + hyphen, 4-80 chars, unique per user
    // Global reference: handle/slug (e.g., john-doe/my-workflow)
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"), // Extracted from graph.metadata.description for SQL search
    version: text("version").notNull(),
    graph: text("graph").notNull(), // JSON
    visibility: text("visibility").default("private"), // 'private' | 'public'
    deleted: integer("deleted", { mode: "boolean" }).default(false),
    deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
    deletedBy: text("deletedBy").references(() => user.id),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    // Validation cache columns (Issue #463)
    // null = unknown (not yet validated), true = valid, false = invalid
    isValid: integer("isValid", { mode: "boolean" }),
    // JSON array of validation error messages (empty array or null if valid)
    validationErrors: text("validationErrors"),
    // Timestamp when validation was last performed
    validatedAt: integer("validatedAt", { mode: "timestamp_ms" }),
  },
  (table) => ({
    // Unique constraint: each user can only have one workflow with a given slug
    userSlugIdx: uniqueIndex("workflow_user_slug_idx").on(table.userId, table.slug),
  }),
);

export const workflowExecution = sqliteTable("workflowExecution", {
  executionId: text("executionId").primaryKey(),
  workflowId: text("workflowId")
    .notNull()
    .references(() => workflow.id, { onDelete: "cascade" }),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  state: text("state").notNull(), // 'running' | 'completed' (simplified from 4 to 2 statuses, Issue #386)
  currentNodeId: text("currentNodeId"),
  waitingForInputNodeId: text("waitingForInputNodeId"),
  context: text("context").notNull(), // JSON
  error: text("error"), // DEPRECATED: kept for migration, use errors array instead
  errors: text("errors"), // JSON array of ExecutionError (Issue #386)
  note: text("note"), // User-provided note for identification (max 500 chars)
  parentExecutionId: text("parentExecutionId"), // Links to parent execution for continuation
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
});

// ===== Universal Settings System =====

export const settingDefinition = sqliteTable("settingDefinition", {
  key: text("key").primaryKey(), // telegram.bot_token, ui.theme, etc
  type: text("type").notNull(), // 'string' | 'number' | 'boolean' | 'json' | 'encrypted'
  category: text("category").notNull(), // 'telegram' | 'profile' | 'ui' | 'system'
  label: text("label").notNull(), // Display name for UI
  description: text("description"), // Help text
  defaultValue: text("defaultValue"), // Default if not set
  required: integer("required", { mode: "boolean" }).default(false),
  validation: text("validation"), // JSON Schema for value validation
  adminOnly: integer("adminOnly", { mode: "boolean" }).default(false), // Admin-editable only
  protected: integer("protected", { mode: "boolean" }).default(false), // Cannot be deleted via UI/API
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const userSettingValue = sqliteTable(
  "userSettingValue",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    settingKey: text("settingKey")
      .notNull()
      .references(() => settingDefinition.key, { onDelete: "cascade" }),
    value: text("value").notNull(), // Stored as text, typed on read based on definition
    encrypted: integer("encrypted", { mode: "boolean" }).default(false), // Flag for encrypted values
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.settingKey] }),
  }),
);

// ===== Email Log Table =====

export const emailLog = sqliteTable("emailLog", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'verification' | 'password_reset' | 'notification'
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  messageId: text("messageId").notNull(),
  status: text("status").notNull(), // 'sent' | 'failed'
  error: text("error"),
  createdAt: text("createdAt").notNull(),
});

// ===== Audit Log Table =====

export const auditLog = sqliteTable("auditLog", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => user.id, { onDelete: "cascade" }),
  action: text("action").notNull(), // 'auth:login', 'workflow:create', 'execution:start', etc
  resource: text("resource"), // 'workflow', 'execution', 'user', etc
  resourceId: text("resourceId"), // ID of the affected resource
  source: text("source"), // 'mcp' | 'web' | 'api' | 'system' - where the action originated
  ip: text("ip"),
  country: text("country"),
  userAgent: text("userAgent"),
  metadata: text("metadata"), // JSON for additional context
  changes: text("changes"), // JSON array: [{field, oldValue, newValue}]
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
});

// ===== Workflow File Tokens =====
// Temporary tokens for file upload/download
// Used by web-backend and mcp-server for file transfers

export const workflowTokens = sqliteTable("workflow_tokens", {
  token: text("token").primaryKey(),
  workflowId: text("workflow_id"), // null for upload (workflow doesn't exist yet)
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'upload' | 'download'
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  used: integer("used", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ===== Notes System Tables =====
// User notes for persistent storage between workflow executions
// Versioned content with size tracking and quota enforcement

export const note = sqliteTable(
  "note",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    key: text("key").notNull(), // Unique key per user (alphanumeric, underscore, hyphen)
    tags: text("tags"), // JSON array of strings
    size: integer("size").notNull().default(0), // Current version size in bytes
    currentVersion: integer("currentVersion").notNull().default(1), // Latest version number
    deleted: integer("deleted", { mode: "boolean" }).default(false),
    deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
    deletedBy: text("deletedBy").references(() => user.id),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    // Unique constraint: each user can only have one note with a given key
    userKeyIdx: uniqueIndex("note_user_key_idx").on(table.userId, table.key),
  }),
);

export const noteVersion = sqliteTable(
  "noteVersion",
  {
    id: text("id").primaryKey(),
    noteId: text("noteId")
      .notNull()
      .references(() => note.id, { onDelete: "cascade" }),
    version: integer("version").notNull(), // Version number (1, 2, 3, ...)
    value: text("value").notNull(), // Note content
    size: integer("size").notNull(), // Size in bytes
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    // Unique constraint: each note can only have one version with a given number
    noteVersionIdx: uniqueIndex("note_version_idx").on(table.noteId, table.version),
  }),
);

// ===== Global Settings Table (Admin Only) =====
// System-wide settings not tied to any user
// Only admins can view and modify
// Metadata stored in table for dynamic UI generation

export const globalSetting = sqliteTable("globalSetting", {
  key: text("key").primaryKey(),
  value: text("value"), // Nullable - set default in migration
  type: text("type").notNull(), // 'string' | 'text' | 'number' | 'boolean'
  label: text("label").notNull(), // Display label for UI
  description: text("description"), // Help text for UI
  category: text("category").notNull().default("general"), // Grouping for UI
  sortOrder: integer("sortOrder").notNull().default(0), // Display order within category
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  updatedBy: text("updatedBy").references(() => user.id), // Admin who last modified
});

// ===== Static Artifacts System Tables =====
// User-uploaded HTML artifacts for public hosting
// UUID-based URLs for security, with branding injection and XSS isolation

export const artifact = sqliteTable("artifact", {
  id: text("id").primaryKey(), // Internal UUID
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  uuid: text("uuid").notNull().unique(), // Public URL identifier
  name: text("name").notNull(), // User-provided display name
  content: text("content").notNull(), // HTML content
  size: integer("size").notNull(), // Size in bytes
  mimeType: text("mimeType").notNull().default("text/html"), // MIME type
  executionId: text("executionId").references(() => workflowExecution.executionId, {
    onDelete: "set null",
  }), // Optional link to workflow execution for history
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(), // TTL expiration
  deleted: integer("deleted", { mode: "boolean" }).default(false),
  deletedAt: integer("deletedAt", { mode: "timestamp_ms" }),
  deletedBy: text("deletedBy").references(() => user.id),
  // Abuse handling: viewer reports
  reportCount: integer("reportCount").notNull().default(0), // Number of abuse reports received
  lastReportedAt: integer("lastReportedAt", { mode: "timestamp_ms" }), // Most recent report time
  // Abuse handling: admin takedown (separate from user soft-delete)
  takenDown: integer("takenDown", { mode: "boolean" }).notNull().default(false),
  takenDownAt: integer("takenDownAt", { mode: "timestamp_ms" }),
  takenDownBy: text("takenDownBy").references(() => user.id),
  takenDownReason: text("takenDownReason"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

// One-time tokens for artifact upload via HTTP API
export const artifactToken = sqliteTable("artifactToken", {
  token: text("token").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'upload' only for now
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  used: integer("used", { mode: "boolean" }).default(false),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
});

// ===== Workflow Sharing Tables =====
// One-time invite links for sharing private workflows with specific users
// Two-table design: invites (one-time tokens) and access (granted permissions)

/**
 * Workflow Invites - One-time shareable links
 * Token is cryptographically random, URL-safe, 32 chars
 * Expires after 7 days, single use (usedBy populated on use)
 */
export const workflowInvite = sqliteTable(
  "workflowInvite",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    createdBy: text("createdBy")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(), // URL-safe random token, globally unique
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("usedAt", { mode: "timestamp_ms" }), // null = not used
    usedBy: text("usedBy").references(() => user.id, { onDelete: "set null" }), // Who used the invite
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    // Index on workflowId for efficient list queries
    workflowIdIdx: index("workflow_invite_workflowId_idx").on(table.workflowId),
  }),
);

/**
 * Workflow Access - Granted permissions from accepted invites
 * Links users to workflows they have access to
 * Permissions: view, start, copy (but not edit)
 */
export const workflowAccess = sqliteTable(
  "workflowAccess",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("grantedBy")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    inviteId: text("inviteId").references(() => workflowInvite.id, { onDelete: "set null" }), // Which invite granted this
    grantedAt: integer("grantedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    // Each user can only have one access record per workflow
    userWorkflowIdx: uniqueIndex("workflow_access_user_workflow_idx").on(
      table.workflowId,
      table.userId,
    ),
  }),
);

// ===== API Token Tables =====

export const apiToken = sqliteTable(
  "apiToken",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenPrefix: text("tokenPrefix").notNull(),
    tokenHash: text("tokenHash").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    scopes: text("scopes"),
    expiresAt: text("expiresAt"),
    lastUsedAt: text("lastUsedAt"),
    createdAt: text("createdAt").notNull(),
    revokedAt: text("revokedAt"),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("apiToken_tokenHash_idx").on(table.tokenHash),
    userIdIdx: index("apiToken_userId_idx").on(table.userId),
    expiresAtIdx: index("apiToken_expiresAt_idx").on(table.expiresAt),
  }),
);

// ===== Execution Lock Tables =====

/**
 * Execution Lock - PIN-based lock for workflow execution gates
 * Simple block/unblock gate with plaintext PIN
 */
export const executionLock = sqliteTable(
  "executionLock",
  {
    id: text("id").primaryKey(),
    executionId: text("executionId")
      .notNull()
      .references(() => workflowExecution.executionId, { onDelete: "cascade" }),
    nodeId: text("nodeId").notNull(),
    reason: text("reason").notNull(),
    lockedBy: text("lockedBy")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    pin: text("pin").notNull(),
    status: text("status").notNull().default("active"), // active | unlocked
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    unlockedAt: integer("unlockedAt", { mode: "timestamp_ms" }),
  },
  (table) => ({
    executionIdx: index("execution_lock_execution_idx").on(table.executionId),
    statusIdx: index("execution_lock_status_idx").on(table.status),
  }),
);
