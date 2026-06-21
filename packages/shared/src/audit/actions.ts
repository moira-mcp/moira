/**
 * Audit Action Types
 * Centralized enum for type-safe audit logging
 */

export enum AuditAction {
  // Auth events
  AUTH_SIGN_UP = "auth:sign_up",
  AUTH_SIGN_IN = "auth:sign_in",
  AUTH_SIGN_OUT = "auth:sign_out",

  // User profile events
  USER_PASSWORD_CHANGED = "user:password_changed",
  USER_PROFILE_UPDATE = "user:profile_update",
  USER_REVOKE_SESSION = "user:revoke_session",
  USER_REVOKE_OAUTH_CONSENT = "user:revoke_oauth_consent",

  // Workflow events
  WORKFLOW_CREATE = "workflow:create",
  WORKFLOW_EDIT = "workflow:edit",
  WORKFLOW_DELETE = "workflow:delete",
  WORKFLOW_RESTORE = "workflow:restore",
  WORKFLOW_HARD_DELETE = "workflow:hard_delete",

  // Execution events
  EXECUTION_START = "execution:start",
  EXECUTION_STEP = "execution:step",
  EXECUTION_STEP_FAIL = "execution:step_fail", // Node-level failure with context
  EXECUTION_COMPLETE = "execution:complete",
  EXECUTION_FAIL = "execution:fail",
  EXECUTION_CANCEL = "execution:cancel",
  EXECUTION_DELETE = "execution:delete",
  EXECUTION_UPDATE_CONTEXT = "execution:update_context",

  // Attempt events (failed user actions for observability)
  WORKFLOW_START_ATTEMPT = "workflow:start_attempt", // Failed attempt to start workflow
  EXECUTION_STEP_ATTEMPT = "execution:step_attempt", // Failed attempt before engine (validation, parsing)

  // Admin user management
  ADMIN_BLOCK_USER = "admin:block_user",
  ADMIN_UNBLOCK_USER = "admin:unblock_user",
  ADMIN_VERIFY_EMAIL = "admin:verify_email",
  ADMIN_SEND_VERIFICATION = "admin:send_verification",
  ADMIN_SEND_RESET = "admin:send_reset",
  ADMIN_UPDATE_USER = "admin:update_user",
  ADMIN_DELETE_USER = "admin:delete_user",

  // Admin execution management
  ADMIN_UPDATE_EXECUTION_CONTEXT = "admin:update_execution_context",

  // Admin database operations
  ADMIN_VACUUM_DB = "admin:vacuum_db",
  ADMIN_BACKUP_DB = "admin:backup_db",

  // User settings
  SETTINGS_SET = "settings:set",
  SETTINGS_DELETE = "settings:delete",

  // Notes events
  NOTE_CREATE = "note:create",
  NOTE_UPDATE = "note:update",
  NOTE_DELETE = "note:delete",
  NOTE_RESTORE = "note:restore",
  NOTE_HARD_DELETE = "note:hard_delete",
  NOTE_LIST = "note:list",
  NOTE_GET = "note:get",
  NOTE_HISTORY = "note:history",
  NOTE_STATS = "note:stats",

  // Admin settings management
  ADMIN_SETTINGS_CREATE_DEFINITION = "admin:settings:create_definition",
  ADMIN_SETTINGS_UPDATE_DEFINITION = "admin:settings:update_definition",
  ADMIN_SETTINGS_DELETE_DEFINITION = "admin:settings:delete_definition",
  ADMIN_SETTINGS_EXPORT_SCHEMA = "admin:settings:export_schema",

  // Admin global settings export
  ADMIN_GLOBAL_SETTINGS_EXPORT = "admin:global_settings:export",

  // Admin global settings management
  ADMIN_GLOBAL_SETTINGS_UPDATE = "admin:global_settings:update",
  ADMIN_GLOBAL_SETTINGS_RESET = "admin:global_settings:reset",

  // Admin security actions
  ADMIN_FORCE_PASSWORD_RESET = "admin:force_password_reset",
  ADMIN_REVOKE_SESSION = "admin:revoke_session",
  ADMIN_REVOKE_ALL_SESSIONS = "admin:revoke_all_sessions",
  ADMIN_REVOKE_OAUTH_PROVIDER = "admin:revoke_oauth_provider",
  ADMIN_REVOKE_ALL_OAUTH = "admin:revoke_all_oauth",

  // Admin system-wide operations
  ADMIN_LOGOUT_ALL_USERS = "admin:logout_all_users",

  // MCP Tool Read Operations (for complete observability)
  MCP_WORKFLOW_LIST = "mcp:workflow_list",
  MCP_SESSION_INFO = "mcp:session_info",
  MCP_SETTINGS_READ = "mcp:settings_read",
  MCP_TOKEN_CREATE = "mcp:token_create",
  MCP_HELP_REQUEST = "mcp:help_request",
  MCP_NOTES_LIST = "mcp:notes_list",

  // User token events
  TOKEN_CREATE = "token:create",
  TOKEN_REVOKE = "token:revoke",

  // Admin token management
  ADMIN_TOKEN_REVOKE = "admin:token_revoke",

  // Artifact events
  ARTIFACT_CREATE = "artifact:create",
  ARTIFACT_UPDATE = "artifact:update",
  ARTIFACT_DELETE = "artifact:delete",
  ARTIFACT_LIST = "artifact:list",
  ARTIFACT_GET = "artifact:get",
  ARTIFACT_STATS = "artifact:stats",
  ARTIFACT_TOKEN_CREATE = "artifact:token_create",
  ARTIFACT_REPORT = "artifact:report",

  // Admin artifact management
  ADMIN_ARTIFACT_DELETE = "admin:artifact_delete",
  ADMIN_ARTIFACT_LIST = "admin:artifact_list",
  ADMIN_ARTIFACT_QUOTA_UPDATE = "admin:artifact_quota_update",
  ADMIN_ARTIFACT_TAKEDOWN = "admin:artifact_takedown",
  ADMIN_ARTIFACT_LIST_REPORTED = "admin:artifact_list_reported",

  // OAuth consent events
  OAUTH_CONSENT_GRANT = "oauth:consent_grant",
  OAUTH_CONSENT_UPDATE = "oauth:consent_update",

  // Workflow sharing events
  SHARING_INVITE_CREATE = "sharing:invite_create",
  SHARING_INVITE_ACCEPT = "sharing:invite_accept",
  SHARING_INVITE_REVOKE = "sharing:invite_revoke",
  SHARING_ACCESS_REVOKE = "sharing:access_revoke",

  // Execution lock events
  LOCK_CREATE = "lock:create",
  LOCK_UNLOCK = "lock:unlock",
  LOCK_ATTEMPT_FAIL = "lock:attempt_fail",

  // Admin lock management
  ADMIN_UNLOCK = "admin:lock_unlock",
}
