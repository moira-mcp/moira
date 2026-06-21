/**
 * Services export index for shared package
 */

import { getDatabase } from "../database/connection.js";
import { WorkflowRepository } from "../database/repositories/workflow-repository.js";
import { ExecutionRepository } from "../database/repositories/execution-repository.js";
import { SettingsRepository } from "../database/repositories/settings-repository.js";
import { GlobalSettingsRepository } from "../database/repositories/global-settings-repository.js";
import { AuditRepository } from "../database/repositories/audit-repository.js";
import { UserRepository } from "../database/repositories/user-repository.js";
import { NoteRepository } from "../database/repositories/note-repository.js";
import { ArtifactRepository } from "../database/repositories/artifact-repository.js";
import { WorkflowSharingRepository } from "../database/repositories/workflow-sharing-repository.js";
import { LockRepository } from "../database/repositories/lock-repository.js";
import { WorkflowService } from "./workflow-service.js";
import { NoteService } from "./note-service.js";
import { ArtifactService } from "./artifact-service.js";
import { ExecutionService } from "./execution-service.js";
import { SettingsService } from "./settings-service.js";
import { GlobalSettingsService } from "./global-settings-service.js";
import { UserService } from "./user-service.js";
import { McpTextService } from "./mcp-text-service.js";
import { WorkflowSharingService } from "./workflow-sharing-service.js";
import { WorkflowMutationService } from "./workflow-mutation-service.js";
import { LockService } from "./lock-service.js";
import { getBaseUrl } from "../config/urls.js";
import { ModeFeatureResolver, type FeatureResolver } from "../config/feature-resolver.js";
import { ExecutionRetentionService } from "./execution-retention-service.js";

export { TokenManager, type WorkflowToken } from "./token-manager.js";
export {
  WorkflowService,
  type SaveWorkflowOptions,
  type SaveWorkflowResult,
} from "./workflow-service.js";
export { ExecutionService } from "./execution-service.js";
export { SettingsService } from "./settings-service.js";
export { GlobalSettingsService } from "./global-settings-service.js";
export { UserService } from "./user-service.js";
export {
  NoteService,
  NoteNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
  NoteVersionNotFoundError,
  validateNoteKey,
  validateTag,
  validateTags,
  NOTE_KEY_MIN_LENGTH,
  NOTE_KEY_MAX_LENGTH,
  MAX_TAGS_PER_NOTE,
  MAX_TAG_LENGTH,
  MIN_TAG_LENGTH,
  type SaveNoteOptions,
  type BatchSaveResult,
} from "./note-service.js";
export {
  McpTextService,
  MCP_TOOL_NAMES,
  MCP_TEXT_KEYS,
  MCP_CATEGORY,
  MCP_AGENT_CATEGORY,
  MCP_MODEL_CATEGORY,
  type McpToolName,
  type McpPromptContext,
} from "./mcp-text-service.js";
export {
  ArtifactService,
  ArtifactNotFoundError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  ArtifactAccessDeniedError,
  InvalidArtifactContentError,
  InvalidArtifactTokenError,
  validateHtmlContent,
  validateArtifactName,
  MAX_ARTIFACT_SIZE,
  MAX_USER_TOTAL_SIZE as MAX_ARTIFACT_TOTAL_SIZE,
  MAX_ARTIFACTS_PER_USER,
  DEFAULT_TTL_MS as DEFAULT_ARTIFACT_TTL_MS,
  DEFAULT_TOKEN_TTL_MS as DEFAULT_ARTIFACT_TOKEN_TTL_MS,
  type Artifact,
  type ArtifactInfo,
  type ArtifactListResult,
  type ArtifactStats,
  type PublicArtifact,
  type CreateArtifactOptions,
  type UpdateArtifactOptions,
  type QuotaOverrides as ArtifactQuotaOverrides,
} from "./artifact-service.js";
export {
  WorkflowSharingService,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
  AccessNotFoundError,
  type ServiceCreateInviteOptions,
  type ServiceAcceptInviteOptions,
  type RevokeAccessOptions,
  type RevokeInviteOptions,
  type ListAccessOptions,
  type ListInvitesOptions,
  type ServiceCreateInviteResult,
  type ServiceAcceptInviteResult,
} from "./workflow-sharing-service.js";

export {
  WorkflowMutationService,
  type MutationSaveOptions,
  type MutationSaveResult,
  type MigrationBatchResult,
} from "./workflow-mutation-service.js";

// Workflow query functions (pure, no DB dependency)
export {
  getWorkflowStructure,
  getNode,
  searchNodes,
  validateWorkflow,
  validateWorkflowUnified,
  getWorkflowVariables,
  getWorkflowVariableValues,
  getWorkflowVariable,
  setWorkflowVariable,
  deleteWorkflowVariable,
  buildFlowGraph,
  // New shared functions for CLI/MCP parity
  listNodesCompact,
  analyzeVariableUsage,
  searchWorkflow,
  type WorkflowStructure,
  type GraphConnection,
  type NodeSearchResult,
  type ValidationResult,
  type WorkflowValidationIssue,
  type ValidationWarning,
  type VariableInfo,
  // New types for CLI/MCP parity
  type CompactNode,
  type ListNodesOptions,
  type VariableSource,
  type VariableUsage,
  type VariableAnalysis,
  type SearchResult,
  type SearchOptions,
} from "./workflow-query-service.js";

export {
  SYSTEM_OWNER_IDS,
  getCatalogDir,
  isSystemOwner,
  readCatalogEntry,
  readWorkflowCatalog,
  readWorkflowCatalogs,
  catalogByOwnerSlug,
  ownerSlugKey,
  findCatalogEntryBySlug,
  findSystemCatalogEntry,
  systemOwnerForVisibility,
  type SystemOwnerId,
  type WorkflowVisibility,
  type CatalogEntry,
} from "./workflow-catalog.js";

export {
  installCatalogEntry,
  installCatalogEntries,
  CatalogContentMismatchError,
  type EntryOutcome,
  type CatalogLoadResult,
  type CatalogLoadDeps,
} from "./workflow-catalog-loader.js";

export {
  LockService,
  LockNotFoundError,
  LockNotActiveError,
  type CreateLockOptions,
  type CreateLockResult,
  type ValidatePinResult,
} from "./lock-service.js";

export {
  ModeFeatureResolver,
  type FeatureResolver,
  type Feature,
  type FeatureContext,
} from "../config/feature-resolver.js";

export { ExecutionRetentionService } from "./execution-retention-service.js";

// Singleton service instances (lazy initialized)
let workflowServiceInstance: WorkflowService | null = null;
let executionServiceInstance: ExecutionService | null = null;
let settingsServiceInstance: SettingsService | null = null;
let globalSettingsServiceInstance: GlobalSettingsService | null = null;
let userServiceInstance: UserService | null = null;
let mcpTextServiceInstance: McpTextService | null = null;
let noteServiceInstance: NoteService | null = null;
let artifactServiceInstance: ArtifactService | null = null;
let workflowSharingServiceInstance: WorkflowSharingService | null = null;
let workflowMutationServiceInstance: WorkflowMutationService | null = null;
let lockServiceInstance: LockService | null = null;
let featureResolverInstance: FeatureResolver | null = null;
let executionRetentionServiceInstance: ExecutionRetentionService | null = null;

// Shared repository instances for cross-service wiring
let workflowRepoInstance: WorkflowRepository | null = null;
let sharingRepoInstance: WorkflowSharingRepository | null = null;

/**
 * Get shared WorkflowRepository instance
 * Internal helper for cross-service wiring
 */
function getWorkflowRepo(): WorkflowRepository {
  if (!workflowRepoInstance) {
    const db = getDatabase();
    workflowRepoInstance = new WorkflowRepository(db);
  }
  return workflowRepoInstance;
}

/**
 * Get shared WorkflowSharingRepository instance
 * Internal helper for cross-service wiring
 */
function getSharingRepo(): WorkflowSharingRepository {
  if (!sharingRepoInstance) {
    const db = getDatabase();
    sharingRepoInstance = new WorkflowSharingRepository(db);
  }
  return sharingRepoInstance;
}

/**
 * Get the FeatureResolver singleton.
 *
 * Defaults to {@link ModeFeatureResolver} (driven by DEPLOYMENT_MODE). A cloud
 * build can override it via {@link setFeatureResolver} before first use.
 */
export function getFeatureResolver(): FeatureResolver {
  if (!featureResolverInstance) {
    featureResolverInstance = new ModeFeatureResolver();
  }
  return featureResolverInstance;
}

/**
 * Override the FeatureResolver implementation (e.g. a cloud per-plan resolver).
 */
export function setFeatureResolver(resolver: FeatureResolver): void {
  featureResolverInstance = resolver;
}

/**
 * Reset the FeatureResolver singleton (test isolation).
 */
export function resetFeatureResolver(): void {
  featureResolverInstance = null;
}

/**
 * Get the ExecutionRetentionService singleton (periodic cleanup of old
 * completed executions, gated by the `executions.retention_days` setting).
 */
export function getExecutionRetentionService(): ExecutionRetentionService {
  if (!executionRetentionServiceInstance) {
    const db = getDatabase();
    const executionRepo = new ExecutionRepository(db);
    const globalSettingsService = getGlobalSettingsService();
    executionRetentionServiceInstance = new ExecutionRetentionService(
      executionRepo,
      globalSettingsService,
    );
  }
  return executionRetentionServiceInstance;
}

/**
 * Get WorkflowService singleton instance
 * Uses shared database connection and repositories
 * Includes UserRepository for handle/slug resolution
 * Issue #463: Now wired with WorkflowMutationService for validation caching
 */
export function getWorkflowService(): WorkflowService {
  if (!workflowServiceInstance) {
    const db = getDatabase();
    const workflowRepo = getWorkflowRepo();
    const auditRepo = new AuditRepository(db);
    const userRepo = new UserRepository(db);

    // Wire up shared access checking
    const sharingRepo = getSharingRepo();
    workflowRepo.setSharedAccessChecker((workflowId, userId) =>
      sharingRepo.hasAccess(workflowId, userId),
    );

    workflowServiceInstance = new WorkflowService(workflowRepo, auditRepo, userRepo);

    // Wire mutation service for validation caching (Issue #463)
    const mutationService = getWorkflowMutationService();
    workflowServiceInstance.setMutationService(mutationService);
  }
  return workflowServiceInstance;
}

/**
 * Get ExecutionService singleton instance
 * Uses shared database connection and repositories
 */
export function getExecutionService(): ExecutionService {
  if (!executionServiceInstance) {
    const db = getDatabase();
    const executionRepo = new ExecutionRepository(db);
    const auditRepo = new AuditRepository(db);
    executionServiceInstance = new ExecutionService(executionRepo, auditRepo);
  }
  return executionServiceInstance;
}

/**
 * Get SettingsService singleton instance
 * Uses shared database connection and repositories
 */
export function getSettingsService(): SettingsService {
  if (!settingsServiceInstance) {
    const db = getDatabase();
    const settingsRepo = new SettingsRepository(db);
    const auditRepo = new AuditRepository(db);
    settingsServiceInstance = new SettingsService(settingsRepo, auditRepo);
  }
  return settingsServiceInstance;
}

/**
 * Get GlobalSettingsService singleton instance
 * Uses shared database connection and repositories
 */
export function getGlobalSettingsService(): GlobalSettingsService {
  if (!globalSettingsServiceInstance) {
    const db = getDatabase();
    const globalSettingsRepo = new GlobalSettingsRepository(db);
    const auditRepo = new AuditRepository(db);
    globalSettingsServiceInstance = new GlobalSettingsService(globalSettingsRepo, auditRepo);
  }
  return globalSettingsServiceInstance;
}

/**
 * Get UserService singleton instance
 * Uses shared database connection and repositories
 */
export function getUserService(): UserService {
  if (!userServiceInstance) {
    const db = getDatabase();
    const userRepo = new UserRepository(db);
    const auditRepo = new AuditRepository(db);
    userServiceInstance = new UserService(userRepo, auditRepo);
  }
  return userServiceInstance;
}

/**
 * Get McpTextService singleton instance
 * Provides access to tool descriptions, system prompt, and error messages from DB
 */
export function getMcpTextService(): McpTextService {
  if (!mcpTextServiceInstance) {
    const db = getDatabase();
    const globalSettingsRepo = new GlobalSettingsRepository(db);
    mcpTextServiceInstance = new McpTextService(globalSettingsRepo);
  }
  return mcpTextServiceInstance;
}

/**
 * Get NoteService singleton instance
 * Uses shared database connection and repositories
 */
export function getNoteService(): NoteService {
  if (!noteServiceInstance) {
    const db = getDatabase();
    const noteRepo = new NoteRepository(db);
    const auditRepo = new AuditRepository(db);
    const globalSettingsService = getGlobalSettingsService();
    noteServiceInstance = new NoteService(noteRepo, auditRepo, globalSettingsService);
  }
  return noteServiceInstance;
}

/**
 * Get ArtifactService singleton instance
 * Uses shared database connection and repositories
 * Wired with GlobalSettingsService and UserQuotaProvider for dynamic quotas
 */
export function getArtifactService(): ArtifactService {
  if (!artifactServiceInstance) {
    const db = getDatabase();
    const artifactRepo = new ArtifactRepository(db);
    const auditRepo = new AuditRepository(db);
    const globalSettingsService = getGlobalSettingsService();
    const userRepo = new UserRepository(db);

    // Create UserQuotaProvider adapter
    const userQuotaProvider = {
      getUserQuota: async (userId: string) => {
        return userRepo.getArtifactQuota(userId);
      },
    };

    artifactServiceInstance = new ArtifactService(
      artifactRepo,
      auditRepo,
      undefined, // No static quota overrides
      globalSettingsService,
      userQuotaProvider,
    );
  }
  return artifactServiceInstance;
}

/**
 * Get WorkflowSharingService singleton instance
 * Uses shared database connection and repositories
 */
export function getWorkflowSharingService(): WorkflowSharingService {
  if (!workflowSharingServiceInstance) {
    const db = getDatabase();
    const sharingRepo = getSharingRepo();
    const workflowRepo = getWorkflowRepo();
    const auditRepo = new AuditRepository(db);

    // Get base URL from centralized config
    const baseUrl = getBaseUrl();

    workflowSharingServiceInstance = new WorkflowSharingService(
      sharingRepo,
      workflowRepo,
      auditRepo,
      baseUrl,
    );
  }
  return workflowSharingServiceInstance;
}

/**
 * Get WorkflowMutationService singleton instance
 * Centralized service for all workflow mutations with validation caching
 * Issue #463: Performance optimization
 */
export function getWorkflowMutationService(): WorkflowMutationService {
  if (!workflowMutationServiceInstance) {
    const db = getDatabase();
    const workflowRepo = getWorkflowRepo();
    const auditRepo = new AuditRepository(db);

    workflowMutationServiceInstance = new WorkflowMutationService(workflowRepo, auditRepo);
  }
  return workflowMutationServiceInstance;
}

/**
 * Initialize WorkflowMutationService and run validation migration
 * Issue #463: Call this at application startup to populate validation cache
 * for any workflows that were created before the migration
 *
 * Should be called AFTER workflow migration (migrate-workflows-in-docker.ts)
 * to ensure newly migrated workflows also get validated.
 */
export async function initializeWorkflowValidationCache(): Promise<void> {
  const mutationService = getWorkflowMutationService();
  await mutationService.initialize();
}

/**
 * Get LockService singleton instance
 * Uses shared database connection and repositories
 */
export function getLockService(): LockService {
  if (!lockServiceInstance) {
    const db = getDatabase();
    const lockRepo = new LockRepository(db);
    const auditRepo = new AuditRepository(db);
    lockServiceInstance = new LockService(lockRepo, auditRepo);
  }
  return lockServiceInstance;
}
