/**
 * Shared Database Layer
 * Centralized database access with modular repositories
 */

export * from "./schema.js";
export { getDatabase, getSqliteInstance, closeDatabase } from "./connection.js";
export {
  executeListQuery,
  executeListQueryWithCount,
  clampPagination,
} from "./list-query-builder.js";
export type { ListQueryConfig, ListQueryParams, ListQueryResult } from "./list-query-builder.js";
export { WorkflowRepository } from "./repositories/workflow-repository.js";
export { ExecutionRepository } from "./repositories/execution-repository.js";
export type { ExecutionFilter, ExecutionListResult } from "./repositories/execution-repository.js";
export { SettingsRepository } from "./repositories/settings-repository.js";
export { AuditRepository } from "./repositories/audit-repository.js";
export { GlobalSettingsRepository } from "./repositories/global-settings-repository.js";
export { UserRepository } from "./repositories/user-repository.js";
export {
  NoteRepository,
  MAX_VERSIONS_PER_NOTE,
  MAX_NOTE_SIZE,
  MAX_USER_TOTAL_SIZE,
} from "./repositories/note-repository.js";
export type {
  NoteFilter,
  NoteListResult,
  NoteInfo,
  Note,
  NoteVersionInfo,
  NoteStats,
} from "./repositories/note-repository.js";
export type {
  WorkflowInfo,
  WorkflowFilter,
  WorkflowListResult,
  WorkflowOwnership,
  SaveWorkflowOptions as RepoSaveWorkflowOptions,
  SharedAccessChecker,
  ValidationStatus,
  ValidationCache,
  AdminWorkflowFilter,
  AdminWorkflowInfo,
  AdminWorkflowListResult,
} from "./repositories/workflow-repository.js";
export type {
  UserProfile,
  UserInfo,
  UserSession,
  OAuthConsentInfo,
  SessionFilter,
  OAuthConsentFilter,
  SessionListResult,
  OAuthConsentListResult,
} from "./repositories/user-repository.js";
export type { AuditLogEntry, AuditLogFilter } from "./repositories/audit-repository.js";
export type {
  GlobalSetting,
  GlobalSettingType,
} from "./repositories/global-settings-repository.js";
export {
  ArtifactRepository,
  DEFAULT_TTL_MS,
  MAX_ARTIFACT_SIZE,
  MAX_USER_TOTAL_SIZE as MAX_ARTIFACT_USER_TOTAL_SIZE,
  MAX_ARTIFACTS_PER_USER,
  DEFAULT_TOKEN_TTL_MS,
} from "./repositories/artifact-repository.js";
export type {
  ArtifactFilter,
  ArtifactInfo,
  Artifact,
  PublicArtifact,
  ArtifactListResult,
  CreateArtifactOptions as RepoCreateArtifactOptions,
  UpdateArtifactOptions as RepoUpdateArtifactOptions,
  ArtifactStats,
  ArtifactTokenData,
} from "./repositories/artifact-repository.js";
export {
  WorkflowSharingRepository,
  DEFAULT_INVITE_TTL_MS,
  TOKEN_LENGTH,
} from "./repositories/workflow-sharing-repository.js";
export type {
  InviteInfo,
  AccessInfo,
  InviteFilter,
  AccessFilter,
  InviteListResult,
  AccessListResult,
  CreateInviteOptions,
  AcceptInviteOptions,
  AcceptInviteResult,
} from "./repositories/workflow-sharing-repository.js";
