/**
 * Unified Database Schema
 * All tables: Better Auth + Workflows + Settings
 */

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  index,
  check,
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

// ===== Marketplace Tables =====

/**
 * Marketplace Listing - the public-gallery record for a published workflow.
 *
 * One listing per workflow (workflowId is unique). A listing is created when an
 * owner publishes their private workflow to the marketplace; it carries the
 * gallery metadata (category/tags), moderation/verification state, denormalized
 * rating + counter aggregates, and the paid-groundwork columns (off by default).
 */
export const marketplaceListing = sqliteTable(
  "marketplaceListing",
  {
    id: text("id").primaryKey(),
    // The workflow being listed. One listing per workflow.
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    // Owner who published the listing (denormalized for fast gallery queries / authorship).
    publishedBy: text("publishedBy")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Lifecycle: listed (visible) | unlisted (hidden by owner) | removed (admin takedown).
    status: text("status").notNull().default("listed"),
    title: text("title").notNull(),
    summary: text("summary"),
    // Fixed category from MARKETPLACE_CATEGORIES (free-form discovery is via tags).
    category: text("category").notNull(),
    tags: text("tags").notNull().default("[]"), // JSON string[]
    // Verification: admin-granted trust badge; verifyCandidate flags auto-detected candidates.
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    verifyCandidate: integer("verifyCandidate", { mode: "boolean" }).notNull().default(false),
    verifiedAt: integer("verifiedAt", { mode: "timestamp_ms" }),
    verifiedBy: text("verifiedBy").references(() => user.id, { onDelete: "set null" }),
    featured: integer("featured", { mode: "boolean" }).notNull().default(false),
    // Denormalized aggregates (maintained on review/event writes).
    ratingAvg: real("ratingAvg").notNull().default(0),
    ratingCount: integer("ratingCount").notNull().default(0),
    // installCount = times added to a library (the "install" analytics signal); the
    // gallery also surfaces it. Named to match the design's install vocabulary.
    installCount: integer("installCount").notNull().default(0),
    startCount: integer("startCount").notNull().default(0), // times started from the listing
    viewCount: integer("viewCount").notNull().default(0), // denormalized view counter (extra)
    // Paid groundwork - inert until paidWorkflows feature is enabled.
    isPaid: integer("isPaid", { mode: "boolean" }).notNull().default(false),
    price: integer("price"), // minor units (e.g. cents); null for free listings
    currency: text("currency"), // ISO 4217, null for free listings
    // Federation provenance: local (published here) | imported (from a remote marketplace).
    origin: text("origin").notNull().default("local"),
    importedFrom: text("importedFrom"), // remote marketplace URL/handle when origin=imported
    importedAt: integer("importedAt", { mode: "timestamp_ms" }),
    publishedAt: integer("publishedAt", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    workflowIdx: uniqueIndex("marketplace_listing_workflow_idx").on(table.workflowId),
    statusIdx: index("marketplace_listing_status_idx").on(table.status),
    categoryIdx: index("marketplace_listing_category_idx").on(table.category),
    verifiedIdx: index("marketplace_listing_verified_idx").on(table.verified),
    featuredIdx: index("marketplace_listing_featured_idx").on(table.featured),
    ratingIdx: index("marketplace_listing_rating_idx").on(table.ratingAvg),
    publishedByIdx: index("marketplace_listing_published_by_idx").on(table.publishedBy),
  }),
);

/**
 * Library Entry - a non-implicit membership in a user's personal library.
 *
 * The library the agent sees via list() is: bundled CORE ∪ the user's OWN
 * workflows (workflow.userId = me) ∪ these rows. Core and own are resolved
 * implicitly and are NOT stored here — libraryEntry only holds flows ADDED from
 * the marketplace or SHARED via a private link. `source` records the origin and
 * `kind` the linkage semantics:
 *   - kind=reference → live pointer to the source workflow (auto-updates).
 *   - kind=copy      → an independent frozen copy (its own workflow row): a
 *                      marketplace fork or a self-host file import.
 */
export const libraryEntry = sqliteTable(
  "libraryEntry",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workflowId: text("workflowId")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    // Origin: added (from the marketplace) | shared (via a private share link).
    source: text("source").notNull(),
    // Linkage semantics: reference (live, auto-updates) | copy (frozen own workflow row).
    kind: text("kind").notNull(),
    // For marketplace/shared entries, the listing/share they came from (provenance + counters).
    listingId: text("listingId").references(() => marketplaceListing.id, {
      onDelete: "set null",
    }),
    // File-import provenance key: identifies the source a flow was IMPORTED from so a
    // re-import of an updated file updates this entry's workflow in place instead of
    // duplicating. Format: `<originInstance>|listing|<listingId>` (store pull) or
    // `<originInstance>|workflow|<workflowId>` (same-instance). Null for non-imported entries.
    importKey: text("importKey"),
    addedAt: integer("addedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userWorkflowIdx: uniqueIndex("library_entry_user_workflow_idx").on(
      table.userId,
      table.workflowId,
    ),
    userIdx: index("library_entry_user_idx").on(table.userId),
    listingIdx: index("library_entry_listing_idx").on(table.listingId),
    importKeyIdx: index("library_entry_import_key_idx").on(table.userId, table.importKey),
  }),
);

/**
 * Marketplace Review - a star rating (1-5) plus optional text for a listing.
 *
 * At most one review per (listing, user); a user cannot review their own listing
 * (enforced in the service layer). Listing rating aggregates are recomputed on write.
 */
export const marketplaceReview = sqliteTable(
  "marketplaceReview",
  {
    id: text("id").primaryKey(),
    listingId: text("listingId")
      .notNull()
      .references(() => marketplaceListing.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // 1..5; DB CHECK as defense-in-depth. The author-can't-rate-own rule and
    // aggregate recomputation are enforced in the service layer (Step 3).
    stars: integer("stars").notNull(),
    reviewText: text("reviewText"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    listingUserIdx: uniqueIndex("marketplace_review_listing_user_idx").on(
      table.listingId,
      table.userId,
    ),
    listingIdx: index("marketplace_review_listing_idx").on(table.listingId),
    starsRange: check("marketplace_review_stars_check", sql`${table.stars} between 1 and 5`),
  }),
);

/**
 * Marketplace Entitlement - records a user's right to a (paid) listing.
 *
 * Paid groundwork: free additions do not require an entitlement; this table backs
 * purchase-gated downloads once the paidWorkflows feature is enabled. At most one
 * active entitlement per (user, listing).
 */
export const marketplaceEntitlement = sqliteTable(
  "marketplaceEntitlement",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    listingId: text("listingId")
      .notNull()
      .references(() => marketplaceListing.id, { onDelete: "cascade" }),
    // How the right was granted: free | purchase | admin.
    source: text("source").notNull(),
    grantedAt: integer("grantedAt", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }), // null = perpetual
  },
  (table) => ({
    userListingIdx: uniqueIndex("marketplace_entitlement_user_listing_idx").on(
      table.userId,
      table.listingId,
    ),
    userIdx: index("marketplace_entitlement_user_idx").on(table.userId),
  }),
);

/**
 * Marketplace Event - append-only analytics signal for a listing.
 *
 * Drives trending/popularity ranking and listing counters. userId is nullable
 * (anonymous gallery views). No FK on userId to keep events durable across user
 * deletion (anonymized analytics).
 */
export const marketplaceEvent = sqliteTable(
  "marketplaceEvent",
  {
    id: text("id").primaryKey(),
    listingId: text("listingId")
      .notNull()
      .references(() => marketplaceListing.id, { onDelete: "cascade" }),
    userId: text("userId"), // nullable; no FK (anonymized, survives user deletion)
    // Signal type: view | install | start | rate.
    type: text("type").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    listingAtIdx: index("marketplace_event_listing_at_idx").on(table.listingId, table.at),
    typeAtIdx: index("marketplace_event_type_at_idx").on(table.type, table.at),
  }),
);
