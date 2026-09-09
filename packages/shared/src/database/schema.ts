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
import { sql } from "drizzle-orm";

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
  // Independent account-admission decision. null means pending approval.
  approvedAt: text("approvedAt"),
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
  // Better Auth 1.6 reads this field directly from SQLite as `redirectUrls`.
  redirectUrls: text("redirectUrls").notNull(),
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
  // Static MCP catalog revision accepted by initialization or inherited during OAuth refresh.
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

// ===== Workspace Provider Connections =====

/**
 * Provider-neutral connection metadata. Provider credentials deliberately live
 * in workspaceCredentialVault rather than Better Auth accounts or settings.
 */
export const workspaceConnection = sqliteTable(
  "workspaceConnection",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalAccountId: text("externalAccountId").notNull(),
    externalLogin: text("externalLogin").notNull(),
    status: text("status").notNull(),
    credentialGeneration: integer("credentialGeneration").notNull().default(1),
    refreshLeaseId: text("refreshLeaseId"),
    refreshLeaseExpiresAt: integer("refreshLeaseExpiresAt", { mode: "timestamp_ms" }),
    lastErrorCode: text("lastErrorCode"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userProviderIdx: uniqueIndex("workspace_connection_user_provider_idx").on(
      table.userId,
      table.provider,
    ),
    userIdx: index("workspace_connection_user_idx").on(table.userId),
  }),
);

/** Versioned authenticated ciphertext for one provider connection. */
export const workspaceCredentialVault = sqliteTable("workspaceCredentialVault", {
  connectionId: text("connectionId")
    .primaryKey()
    .references(() => workspaceConnection.id, { onDelete: "cascade" }),
  envelopeVersion: integer("envelopeVersion").notNull(),
  keyVersion: text("keyVersion").notNull(),
  iv: text("iv").notNull(),
  authTag: text("authTag").notNull(),
  ciphertext: text("ciphertext").notNull(),
  generation: integer("generation").notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

/**
 * Exact encrypted credentials retained only while provider revocation is
 * pending. A separate row prevents credential replacement from destroying the
 * capability needed to retry a failed remote revoke.
 */
export const workspaceCredentialRevocation = sqliteTable(
  "workspaceCredentialRevocation",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    envelopeVersion: integer("envelopeVersion").notNull(),
    keyVersion: text("keyVersion").notNull(),
    iv: text("iv").notNull(),
    authTag: text("authTag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    generation: integer("generation").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userProviderIdx: index("workspace_credential_revocation_user_provider_idx").on(
      table.userId,
      table.provider,
    ),
  }),
);

/** Browser-only, single-use GitHub authorization state stored as a digest. */
export const workspaceAuthorizationState = sqliteTable(
  "workspaceAuthorizationState",
  {
    stateHash: text("stateHash").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionTokenHash: text("sessionTokenHash").notNull(),
    provider: text("provider").notNull(),
    redirectPath: text("redirectPath").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumedAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userExpiresIdx: index("workspace_authorization_state_user_expires_idx").on(
      table.userId,
      table.expiresAt,
    ),
  }),
);

/** GitHub App installation selected for a connection. */
export const workspaceConnectionInstallation = sqliteTable(
  "workspaceConnectionInstallation",
  {
    connectionId: text("connectionId")
      .notNull()
      .references(() => workspaceConnection.id, { onDelete: "cascade" }),
    externalInstallationId: text("externalInstallationId").notNull(),
    repositorySelection: text("repositorySelection").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.connectionId, table.externalInstallationId] }),
  }),
);

/** Repository grants observed through the selected GitHub App installation. */
export const workspaceConnectionRepository = sqliteTable(
  "workspaceConnectionRepository",
  {
    connectionId: text("connectionId")
      .notNull()
      .references(() => workspaceConnection.id, { onDelete: "cascade" }),
    externalInstallationId: text("externalInstallationId").notNull(),
    externalRepositoryId: text("externalRepositoryId").notNull(),
    fullName: text("fullName").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.connectionId, table.externalRepositoryId] }),
    connectionIdx: index("workspace_connection_repository_connection_idx").on(table.connectionId),
  }),
);

/** Durable intent and exact ownership record for one disposable workspace. */
export const workspaceResource = sqliteTable(
  "workspaceResource",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    connectionId: text("connectionId")
      .notNull()
      .references(() => workspaceConnection.id),
    authorizationGeneration: integer("authorizationGeneration").notNull().default(1),
    provider: text("provider").notNull(),
    repositoryId: text("repositoryId").notNull(),
    repositoryFullName: text("repositoryFullName").notNull(),
    requestedRef: text("requestedRef").notNull(),
    operationMarker: text("operationMarker").notNull(),
    providerResourceName: text("providerResourceName"),
    externalOwnerId: text("externalOwnerId"),
    billableOwnerId: text("billableOwnerId"),
    machineName: text("machineName").notNull(),
    machineDisplayName: text("machineDisplayName").notNull(),
    machineOperatingSystem: text("machineOperatingSystem").notNull(),
    machineCpuCores: integer("machineCpuCores").notNull(),
    machineMemoryBytes: integer("machineMemoryBytes").notNull(),
    machineStorageBytes: integer("machineStorageBytes").notNull(),
    state: text("state").notNull(),
    retentionPolicy: text("retentionPolicy").notNull().default("legacy_disposable"),
    desiredState: text("desiredState").notNull().default("running"),
    observedState: text("observedState").notNull().default("unknown"),
    generation: integer("generation").notNull().default(1),
    createDeadlineAt: integer("createDeadlineAt", { mode: "timestamp_ms" }).notNull(),
    remoteExpiresAt: integer("remoteExpiresAt", { mode: "timestamp_ms" }).notNull(),
    cleanupDeadlineAt: integer("cleanupDeadlineAt", { mode: "timestamp_ms" }),
    claimId: text("claimId"),
    claimExpiresAt: integer("claimExpiresAt", { mode: "timestamp_ms" }),
    lastOutcome: text("lastOutcome"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    markerIdx: uniqueIndex("workspace_resource_operation_marker_idx").on(table.operationMarker),
    providerNameIdx: uniqueIndex("workspace_resource_provider_name_idx").on(
      table.provider,
      table.providerResourceName,
    ),
    userStateIdx: index("workspace_resource_user_state_idx").on(table.userId, table.state),
    reconcileIdx: index("workspace_resource_reconcile_idx").on(
      table.state,
      table.claimExpiresAt,
      table.remoteExpiresAt,
    ),
  }),
);

/** Non-transferable lifecycle authority; only its digest is persisted. */
export const workspaceLifecycleCapability = sqliteTable("workspaceLifecycleCapability", {
  resourceId: text("resourceId")
    .primaryKey()
    .references(() => workspaceResource.id, {
      onDelete: "cascade",
    }),
  userId: text("userId")
    .notNull()
    .references(() => user.id),
  capabilityHash: text("capabilityHash").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
});

/** Submitted operations are charged once per UTC day and are never refunded. */
export const workspacePolicyUsage = sqliteTable(
  "workspacePolicyUsage",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    utcDay: text("utcDay").notNull(),
    submittedOperations: integer("submittedOperations").notNull().default(0),
    requiredCleanupOperations: integer("requiredCleanupOperations").notNull().default(0),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.provider, table.utcDay] }),
  }),
);

/** One durable record per external provider mutation attempt. */
export const workspaceProviderMutation = sqliteTable(
  "workspaceProviderMutation",
  {
    id: text("id").primaryKey(),
    resourceId: text("resourceId")
      .notNull()
      .references(() => workspaceResource.id),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    provider: text("provider").notNull(),
    generation: integer("generation").notNull(),
    kind: text("kind").notNull(),
    attempt: integer("attempt").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    attemptIdx: uniqueIndex("workspace_provider_mutation_attempt_idx").on(
      table.resourceId,
      table.generation,
      table.kind,
      table.attempt,
    ),
    userDayIdx: index("workspace_provider_mutation_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  }),
);

/** Durable global/provider emergency controls owned by core. */
export const workspaceProviderControl = sqliteTable("workspaceProviderControl", {
  scope: text("scope").primaryKey(),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  reason: text("reason"),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  updatedBy: text("updatedBy").references(() => user.id),
});

/** Durable metadata for an exact operation in a user-owned workspace. */
export const workspaceOperation = sqliteTable(
  "workspaceOperation",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id),
    resourceId: text("resourceId")
      .notNull()
      .references(() => workspaceResource.id),
    resourceGeneration: integer("resourceGeneration").notNull(),
    authorizationGeneration: integer("authorizationGeneration").notNull(),
    provider: text("provider").notNull(),
    providerResourceName: text("providerResourceName").notNull(),
    remoteMarker: text("remoteMarker").notNull().unique(),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    inputBytes: integer("inputBytes").notNull(),
    stdoutLimitBytes: integer("stdoutLimitBytes").notNull(),
    stderrLimitBytes: integer("stderrLimitBytes").notNull(),
    outputBytes: integer("outputBytes").notNull().default(0),
    exitCode: integer("exitCode"),
    remoteCleanupPending: integer("remoteCleanupPending").notNull().default(1),
    resultExpiresAt: integer("resultExpiresAt", { mode: "timestamp_ms" }),
    deadlineAt: integer("deadlineAt", { mode: "timestamp_ms" }).notNull(),
    claimId: text("claimId"),
    claimExpiresAt: integer("claimExpiresAt", { mode: "timestamp_ms" }),
    lastOutcome: text("lastOutcome"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    ownerIdx: index("workspace_operation_owner_idx").on(table.userId, table.resourceId),
    reconcileIdx: index("workspace_operation_reconcile_idx").on(table.state, table.claimExpiresAt),
  }),
);

/** Metadata-only authority for private, expiring workspace byte transfers. */
export const workspaceTransfer = sqliteTable(
  "workspaceTransfer",
  {
    id: text("id").primaryKey(),
    tokenDigest: text("tokenDigest").notNull().unique(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    state: text("state").notNull(),
    fileName: text("fileName").notNull(),
    mimeType: text("mimeType").notNull(),
    declaredSize: integer("declaredSize").notNull(),
    observedSize: integer("observedSize"),
    sha256: text("sha256"),
    objectKey: text("objectKey").notNull().unique(),
    ownerPid: integer("ownerPid").notNull(),
    ownerStartTime: text("ownerStartTime"),
    claimId: text("claimId"),
    claimExpiresAt: integer("claimExpiresAt", { mode: "timestamp_ms" }),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    ownerStateExpiryIdx: index("workspace_transfer_owner_state_expiry_idx").on(
      table.userId,
      table.state,
      table.expiresAt,
    ),
    stateExpiryIdx: index("workspace_transfer_state_expiry_idx").on(table.state, table.expiresAt),
  }),
);

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

/** Last upstream state observed for a bundled workflow. */
export const managedWorkflowBaseline = sqliteTable(
  "managedWorkflowBaseline",
  {
    ownerId: text("ownerId").notNull(),
    slug: text("slug").notNull(),
    state: text("state").notNull(),
    sourceVersion: text("sourceVersion"),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.ownerId, table.slug] }),
  }),
);

/** Durable, MCP-visible evidence for an unresolved bundled-workflow merge. */
export const workflowReconciliationConflict = sqliteTable(
  "workflowReconciliationConflict",
  {
    ownerId: text("ownerId").notNull(),
    slug: text("slug").notNull(),
    currentWorkflowId: text("currentWorkflowId"),
    currentWorkflowSlug: text("currentWorkflowSlug"),
    previousManagedSlug: text("previousManagedSlug"),
    classification: text("classification").notNull(),
    previousState: text("previousState"),
    currentState: text("currentState").notNull(),
    incomingState: text("incomingState").notNull(),
    instruction: text("instruction").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.ownerId, table.slug] }),
  }),
);

/** Bounded evidence for the last accepted resolution of a managed workflow. */
export const workflowReconciliationResolution = sqliteTable(
  "workflowReconciliationResolution",
  {
    ownerId: text("ownerId").notNull(),
    slug: text("slug").notNull(),
    incomingDigest: text("incomingDigest").notNull(),
    resultDigest: text("resultDigest").notNull(),
    selection: text("selection").notNull(),
    merged: integer("merged", { mode: "boolean" }).notNull(),
    rationale: text("rationale").notNull(),
    residualDelta: text("residualDelta").notNull(),
    actorId: text("actorId"),
    source: text("source").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.ownerId, table.slug] }),
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
  revision: integer("revision").notNull().default(0), // Workflow-step generation
  reminders: text("reminders").notNull().default("[]"), // JSON ExecutionReminder[]
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
  completedAt: integer("completedAt", { mode: "timestamp_ms" }),
});

/** Durable replay and ownership state for state-changing MCP workflow operations. */
export const executionMutationAttempt = sqliteTable(
  "executionMutationAttempt",
  {
    attemptId: text("attemptId").primaryKey(),
    operation: text("operation").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    executionId: text("executionId").references(() => workflowExecution.executionId, {
      onDelete: "cascade",
    }),
    reservedExecutionId: text("reservedExecutionId"),
    executionRevision: integer("executionRevision"),
    nodeId: text("nodeId"),
    workflowId: text("workflowId").notNull(),
    workflowVersion: text("workflowVersion").notNull(),
    workflowDigest: text("workflowDigest").notNull(),
    requestPayload: text("requestPayload"),
    inputFingerprint: text("inputFingerprint"),
    state: text("state").notNull(),
    ownerId: text("ownerId"),
    fence: integer("fence").notNull().default(0),
    heartbeatAt: integer("heartbeatAt", { mode: "timestamp_ms" }),
    leaseExpiresAt: integer("leaseExpiresAt", { mode: "timestamp_ms" }),
    response: text("response"),
    nextAttemptId: text("nextAttemptId"),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completedAt", { mode: "timestamp_ms" }),
  },
  (table) => ({
    executionStateIdx: index("attempt_execution_state_idx").on(
      table.executionId,
      table.state,
      table.createdAt,
    ),
    userOperationStateIdx: index("attempt_user_operation_state_idx").on(
      table.userId,
      table.operation,
      table.state,
      table.createdAt,
    ),
    leaseIdx: index("attempt_state_lease_idx").on(table.state, table.leaseExpiresAt),
    cleanupIdx: index("attempt_operation_completed_idx").on(table.operation, table.completedAt),
    reservedExecutionIdx: uniqueIndex("attempt_reserved_execution_idx").on(
      table.reservedExecutionId,
    ),
    currentStepIdx: uniqueIndex("attempt_current_step_idx")
      .on(table.executionId)
      .where(
        sql`${table.operation} = 'step' AND ${table.state} IN ('presented', 'executing', 'outcome_unknown')`,
      ),
  }),
);

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
  executionId: text("execution_id").references(() => workflowExecution.executionId, {
    onDelete: "cascade",
  }),
  nodeId: text("node_id"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // 'upload' | 'download' | 'materialize'
  workflowVersion: text("workflow_version"),
  executionRevision: integer("execution_revision"),
  optionsJson: text("options_json"),
  claimId: text("claim_id"),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  used: integer("used", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Digest-only, short-lived grants for authenticated communication attachment uploads. */
export const communicationAttachmentGrant = sqliteTable(
  "communication_attachment_grant",
  {
    tokenDigest: text("token_digest").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    correlationId: text("correlation_id").notNull(),
    audience: text("audience").notNull(),
    purpose: text("purpose").notNull(),
    message: text("message").notNull(),
    format: text("format").notNull(),
    silent: integer("silent", { mode: "boolean" }).notNull().default(false),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    declaredSize: integer("declared_size").notNull(),
    state: text("state").notNull().default("pending"),
    claimId: text("claim_id"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    userStateExpiryIdx: index("communication_grant_user_state_expiry_idx").on(
      table.userId,
      table.state,
      table.expiresAt,
    ),
    stateExpiryIdx: index("communication_grant_state_expiry_idx").on(table.state, table.expiresAt),
  }),
);

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

/**
 * Values of settings declared by extension manifests.
 *
 * A separate table on purpose. `userSettingValue.settingKey` is a foreign key into
 * `settingDefinition`, and an extension's definition never enters the database — it lives in the
 * manifest and disappears with the bundle. There is deliberately no foreign key here: removing an
 * extension must leave the values an administrator entered, so that reinstalling it restores a
 * working state instead of an empty form.
 */
export const extensionSettingValue = sqliteTable(
  "extensionSettingValue",
  {
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    settingKey: text("settingKey").notNull(),
    value: text("value").notNull(),
    encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.settingKey] }),
  }),
);

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
    toolsVersion: text("toolsVersion"),
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
 * Simple block/unblock gate with a hashed PIN and internal delivery states
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
    status: text("status").notNull().default("active"), // pending_delivery | active | unlocked | delivery_failed
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    unlockedAt: integer("unlockedAt", { mode: "timestamp_ms" }),
  },
  (table) => ({
    executionIdx: index("execution_lock_execution_idx").on(table.executionId),
    statusIdx: index("execution_lock_status_idx").on(table.status),
  }),
);
