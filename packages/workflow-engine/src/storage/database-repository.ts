/**
 * Database Repository Implementation
 * Aggregator using Service Layer from shared for automatic audit
 * Read operations use repositories directly, write operations use Services
 * User operations handled by Better Auth directly (not in repository)
 */

import {
  getDatabase,
  getSqliteInstance,
  WorkflowRepository,
  ExecutionRepository,
  ExecutionAttemptRepository,
  SettingsRepository,
  ExtensionSettingsRepository,
  AuditRepository,
  getWorkflowService,
  getExecutionService,
  getSettingsService,
  type WorkflowService,
  type ExecutionService,
  type SettingsService,
  type AuditLogEntry,
  type AuditLogFilter,
  type ExecutionFilter,
  type ExecutionListResult,
  type WorkflowFilter,
  type WorkflowListResult,
  type AdminWorkflowFilter,
  type AdminWorkflowListResult,
  type ExecutionError,
} from "@mcp-moira/shared";
import { IDataRepository, WorkflowInfo, SettingDefinition } from "../interfaces/data-repository.js";
import { WorkflowGraph } from "../interfaces/core-interfaces.js";
import { WorkflowExecution } from "../types/base-types.js";
import type { ReminderMutation, ReminderMutationResult } from "../types/base-types.js";
import type {
  CompleteExecutionAttemptInput,
  ClaimStartExecutionAttemptInput,
  ExecutionAttempt,
  ExecutionAttemptClaimResult,
  PreparedStartExecutionAttempt,
  PresentedExecutionAttempt,
  ReconciledExecutionAttemptCounts,
  StartPreconditionCompletionResult,
} from "../types/execution-attempt.js";
import { createLogger, ValidationError, AuditAction, getAuditSource } from "@mcp-moira/shared";
import {
  extensionSettingDefinition,
  extensionSettingDefinitions,
  mergeSettingDefinitions,
  prepareExtensionSettingValue,
} from "../extensions/extension-settings.js";
import { maskEncryptedValue } from "../utils/encryption.js";

function convertSettingValue(raw: string, type: SettingDefinition["type"]): unknown {
  switch (type) {
    case "number":
      return Number(raw);
    case "boolean":
      return raw === "true" || raw === "1";
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

export class DatabaseRepository implements IDataRepository {
  // Repositories for read operations
  private workflowRepo: WorkflowRepository;
  private executionRepo: ExecutionRepository;
  private executionAttemptRepo: ExecutionAttemptRepository;
  private settingsRepo: SettingsRepository;
  private extensionSettingsRepo: ExtensionSettingsRepository;
  private auditRepo: AuditRepository;

  // Services for write operations (with automatic audit)
  private workflowService: WorkflowService;
  private executionService: ExecutionService;
  private settingsService: SettingsService;

  private logger = createLogger({ component: "DatabaseRepository" });

  constructor() {
    // Uses shared singleton connection from getDatabase()
    // Database path from DB_PATH env variable
    const db = getDatabase();

    // Initialize repositories for read operations
    this.workflowRepo = new WorkflowRepository(db);
    this.executionRepo = new ExecutionRepository(db);
    this.executionAttemptRepo = new ExecutionAttemptRepository(getSqliteInstance());
    this.settingsRepo = new SettingsRepository(db);
    this.extensionSettingsRepo = new ExtensionSettingsRepository(db);
    this.auditRepo = new AuditRepository(db);

    // Get singleton services for write operations
    this.workflowService = getWorkflowService();
    this.executionService = getExecutionService();
    this.settingsService = getSettingsService();

    this.logger.info("DatabaseRepository initialized with Service Layer");
  }

  // === Workflow Operations ===
  // Delegate to WorkflowRepository

  async listWorkflows(userId: string): Promise<WorkflowInfo[]> {
    return await this.workflowRepo.list(userId);
  }

  async listWorkflowsWithFilters(filter: WorkflowFilter): Promise<WorkflowListResult> {
    return await this.workflowRepo.listWithFilters(filter);
  }

  async getWorkflowGraph(workflowId: string, userId: string): Promise<WorkflowGraph | null> {
    return await this.workflowRepo.get(workflowId, userId);
  }

  async getWorkflowGraphBySlug(slug: string, userId: string): Promise<WorkflowGraph | null> {
    return await this.workflowRepo.getBySlug(slug, userId);
  }

  /**
   * Resolve workflow identifier to workflow graph
   * Accepts: UUID, slug, or handle/slug reference
   * Returns workflow with its ID and slug for audit logging
   */
  async resolveWorkflow(
    identifier: string,
    userId: string,
  ): Promise<{ workflow: WorkflowGraph; workflowId: string; slug: string } | null> {
    // Try to get by identifier as UUID first
    let workflow = await this.workflowRepo.get(identifier, userId);
    if (workflow) {
      const info = await this.workflowRepo.getFullInfo(identifier, userId);
      return info ? { workflow, workflowId: identifier, slug: info.slug } : null;
    }

    // Check if it's a global reference (handle/slug)
    if (identifier.includes("/")) {
      // Use WorkflowService for global reference resolution
      try {
        const { workflow: resolvedWorkflow, info } = await this.workflowService.getByReference(
          identifier,
          userId,
        );
        return { workflow: resolvedWorkflow, workflowId: info.id, slug: info.slug };
      } catch {
        return null;
      }
    }

    // Try as slug for current user
    workflow = await this.workflowRepo.getBySlug(identifier, userId);
    if (workflow) {
      // Need to get the ID for this slug
      const workflowId = await this.workflowRepo.resolveSlug(identifier, userId);
      if (workflowId) {
        return { workflow, workflowId, slug: identifier };
      }
    }

    return null;
  }

  async getWorkflow(workflowId: string, userId: string): Promise<WorkflowInfo | null> {
    const workflows = await this.workflowRepo.list(userId);
    return workflows.find((w) => w.id === workflowId) || null;
  }

  async saveWorkflow(
    graph: WorkflowGraph,
    userId: string,
    visibility: "public" | "private" = "private",
  ): Promise<void> {
    // Use WorkflowService for automatic audit
    await this.workflowService.save({ graph, userId, visibility });
  }

  async deleteWorkflow(workflowId: string, userId: string): Promise<void> {
    // Use WorkflowService for automatic audit
    await this.workflowService.hardDelete(workflowId, userId);
  }

  async softDeleteWorkflow(workflowId: string, userId: string): Promise<boolean> {
    // Use WorkflowService for automatic audit
    return await this.workflowService.softDelete(workflowId, userId);
  }

  async restoreWorkflow(workflowId: string, userId: string): Promise<boolean> {
    // Use WorkflowService for automatic audit
    return await this.workflowService.restore(workflowId, userId);
  }

  async listDeletedWorkflows(userId: string): Promise<WorkflowInfo[]> {
    return await this.workflowRepo.listDeleted(userId);
  }

  async listAllDeletedWorkflows(): Promise<
    Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>
  > {
    return await this.workflowRepo.listAllDeleted();
  }

  async listAllDeletedWorkflowsPaginated(filter: {
    search?: string;
    sort?: "name" | "deletedAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<{
      id: string;
      name: string;
      deletedAt: number | null;
      deletedBy: string | null;
    }>;
    total: number;
  }> {
    return await this.workflowRepo.listAllDeletedPaginated(filter);
  }

  async listAllWorkflowsPaginated(filter: AdminWorkflowFilter): Promise<AdminWorkflowListResult> {
    return await this.workflowRepo.listAllWorkflowsPaginated(filter);
  }

  // === Execution Operations ===
  // Write operations use ExecutionService

  async saveExecution(execution: WorkflowExecution): Promise<void> {
    // Use ExecutionService.save() - internal method without audit
    // High-level audit (start/step/complete/fail) is handled by MCPEngine
    await this.executionService.save(execution);
  }

  async getExecution(executionId: string): Promise<WorkflowExecution | null> {
    return await this.executionRepo.get(executionId);
  }

  async listExecutions(): Promise<WorkflowExecution[]> {
    return await this.executionRepo.list();
  }

  async listUserExecutions(userId: string): Promise<WorkflowExecution[]> {
    return await this.executionRepo.listByUser(userId);
  }

  async listExecutionsWithFilters(filter: ExecutionFilter): Promise<ExecutionListResult> {
    return await this.executionRepo.listWithFilters(filter);
  }

  async deleteExecution(executionId: string): Promise<void> {
    await this.executionRepo.delete(executionId);
  }

  async updateExecutionNote(executionId: string, note: string): Promise<void> {
    await this.executionRepo.updateNote(executionId, note);
  }

  async appendError(executionId: string, error: ExecutionError): Promise<boolean> {
    return await this.executionRepo.appendError(executionId, error);
  }

  async cancelExecution(
    executionId: string,
    error: ExecutionError,
  ): Promise<{ changed: boolean; execution: WorkflowExecution | null }> {
    return await this.executionRepo.cancelExecution(executionId, error);
  }

  async findActiveChildExecutions(parentExecutionId: string): Promise<string[]> {
    return await this.executionRepo.findActiveChildExecutions(parentExecutionId);
  }

  async setExecutionParent(
    executionId: string,
    parentExecutionId: string | null,
    userId: string,
    expectedRevision: number,
  ): Promise<WorkflowExecution> {
    return await this.executionService.setParent(
      executionId,
      parentExecutionId,
      userId,
      expectedRevision,
    );
  }

  async mutateExecutionReminder(
    executionId: string,
    userId: string,
    expectedRevision: number,
    mutation: ReminderMutation,
  ): Promise<ReminderMutationResult> {
    return this.executionService.mutateReminder(executionId, userId, expectedRevision, mutation);
  }

  async updateExecutionContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
    expectedRevision: number,
  ): Promise<boolean> {
    return await this.executionRepo.updateContext(executionId, context, expectedRevision);
  }

  async createPresentedExecutionAttempt(attempt: PresentedExecutionAttempt): Promise<void> {
    this.executionAttemptRepo.createPresented(attempt);
  }

  async prepareStartExecutionAttempt(attempt: PreparedStartExecutionAttempt): Promise<void> {
    this.executionAttemptRepo.prepareStart(attempt);
  }

  async claimStartExecutionAttempt(
    input: ClaimStartExecutionAttemptInput,
  ): Promise<ExecutionAttemptClaimResult> {
    return this.executionAttemptRepo.claimStart(input);
  }

  async completeStartAttemptPrecondition(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): Promise<StartPreconditionCompletionResult> {
    return this.executionAttemptRepo.completeStartPrecondition(attemptId, userId, response, now);
  }

  async getBlockingStartExecutionAttempt(
    executionId: string,
    userId: string,
  ): Promise<ExecutionAttempt | null> {
    return this.executionAttemptRepo.getBlockingStart(executionId, userId);
  }

  async cancelExecutionWithStartAttempt(
    executionId: string,
    userId: string,
    expectedRevision: number,
    error: import("@mcp-moira/shared").ExecutionError,
  ): Promise<boolean> {
    return this.executionAttemptRepo.cancelWithStartAttempt(
      executionId,
      userId,
      expectedRevision,
      error,
    );
  }

  async getExecutionAttempt(attemptId: string): Promise<ExecutionAttempt | null> {
    return this.executionAttemptRepo.get(attemptId);
  }

  async updatePresentedExecutionAttemptResponse(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): Promise<boolean> {
    return this.executionAttemptRepo.updatePresentedResponse(attemptId, userId, response, now);
  }

  async getCurrentExecutionAttempt(
    executionId: string,
    userId: string,
  ): Promise<ExecutionAttempt | null> {
    return this.executionAttemptRepo.getCurrent(executionId, userId);
  }

  async claimExecutionAttempt(
    input: Parameters<ExecutionAttemptRepository["claim"]>[0],
  ): Promise<ExecutionAttemptClaimResult> {
    return this.executionAttemptRepo.claim(input);
  }

  async heartbeatExecutionAttempt(
    attemptId: string,
    ownerId: string,
    fence: number,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    return this.executionAttemptRepo.heartbeat(attemptId, ownerId, fence, now, leaseMs);
  }

  async completeExecutionAttempt(input: CompleteExecutionAttemptInput): Promise<boolean> {
    return this.executionAttemptRepo.complete(input);
  }

  async markExecutionAttemptOutcomeUnknown(
    attemptId: string,
    ownerId: string,
    fence: number,
    now: number,
  ): Promise<boolean> {
    return this.executionAttemptRepo.markOutcomeUnknown(attemptId, ownerId, fence, now);
  }

  async reconcileExpiredExecutionAttempts(now: number): Promise<ReconciledExecutionAttemptCounts> {
    return this.executionAttemptRepo.reconcileExpired(now);
  }

  async cleanupExecutionAttempts(now: number): Promise<number> {
    return this.executionAttemptRepo.cleanup(now);
  }

  // === Settings Operations ===
  // Write operations use SettingsService for automatic audit

  /**
   * Settings of installed extensions are served from here as well, so that every consumer of this
   * repository — the settings screen, the admin screen, the MCP tool, the execution engine — sees
   * one list and one value. Which half answers is decided by the definition: a declaration from a
   * manifest means the value lives in the extension value store, because the ordinary value table
   * cannot hold a value whose definition is not a row in the database.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSetting<T = any>(userId: string, key: string): Promise<T | null> {
    const declared = extensionSettingDefinition(key);
    if (declared) {
      const stored = await this.extensionSettingsRepo.getValue(userId, key);
      const raw = stored ?? declared.defaultValue ?? null;
      return raw === null ? null : (convertSettingValue(raw, declared.type) as T);
    }
    return await this.settingsRepo.getSetting<T>(userId, key);
  }

  async getRawSettingValue(userId: string, key: string): Promise<string | null> {
    if (extensionSettingDefinition(key)) {
      return await this.extensionSettingsRepo.getRawValue(userId, key);
    }
    return await this.settingsRepo.getRawSettingValue(userId, key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setSetting(userId: string, key: string, value: any): Promise<void> {
    const declared = extensionSettingDefinition(key);
    if (declared) {
      // The settings screen sends what the field held, and a structural setting's field is a
      // textarea — so a `json` setting arrives as text. Parse before checking, or the declared
      // object schema would be applied to a string and reject every correct value an administrator
      // could type.
      const candidate = prepareExtensionSettingValue(declared, value);
      if (candidate.problem) {
        // Named refusal rather than a silently unsaved value: an administrator must be able to tell
        // a rejected value from one that was accepted and then read back empty.
        throw new ValidationError(
          `Value for setting '${key}' does not satisfy type '${declared.type}' and the schema declared by extension '${declared.extensionName}': ${candidate.problem}`,
          { key, extensionName: declared.extensionName },
        );
      }
      // Whether the value is encrypted comes from the declaration, not from the caller: an
      // administrator saving a token must not be able to store it in the clear by accident.
      const serialised =
        declared.type === "json" ? JSON.stringify(candidate.value) : String(candidate.value);
      // Audited like a stored setting: the value store is different, but "who changed which setting
      // and when" is the same question, and an unaudited half would make the log lie by omission.
      // The value itself is never recorded for an encrypted setting. Both rows share one database
      // transaction so a failed audit insert cannot leave a saved value that the caller reports as
      // refused.
      await this.extensionSettingsRepo.setValueWithAudit(
        userId,
        key,
        serialised,
        declared.type === "encrypted",
        {
          action: AuditAction.SETTINGS_SET,
          resource: "setting",
          resourceId: key,
          source: getAuditSource(),
          metadata: JSON.stringify({
            category: declared.category,
            extensionName: declared.extensionName,
          }),
          changes: JSON.stringify([
            {
              field: key,
              newValue: declared.type === "encrypted" ? "[encrypted]" : serialised,
            },
          ]),
        },
      );
      return;
    }
    // Use SettingsService for automatic audit
    await this.settingsService.set(userId, key, value);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettings(userId: string, category?: string): Promise<Record<string, any>> {
    const stored = await this.settingsRepo.getSettings(userId, category);
    return { ...stored, ...(await this.extensionSettingsForInternalUse(userId, category)) };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettingsForApi(userId: string, category?: string): Promise<Record<string, any>> {
    const stored = await this.settingsRepo.getSettingsForApi(userId, category);
    return { ...stored, ...(await this.extensionSettingsForApi(userId, category)) };
  }

  /** Decrypted typed values for trusted in-process consumers. */
  private async extensionSettingsForInternalUse(
    userId: string,
    category?: string,
  ): Promise<Record<string, unknown>> {
    const declarations = extensionSettingDefinitions().filter(
      (definition) => category === undefined || definition.category === category,
    );
    const values: Record<string, unknown> = {};
    for (const definition of declarations) {
      const raw = await this.extensionSettingsRepo.getRawValue(userId, definition.key);
      const hasEffectiveValue =
        raw !== null || (definition.defaultValue !== null && definition.defaultValue !== undefined);
      if (!hasEffectiveValue) continue;
      const value = await this.getSetting(userId, definition.key);
      // A stored/default JSON `null` is a value, while no row and no default is absence. Checking
      // the source separately preserves that distinction even though getSetting uses null as its
      // general not-found sentinel.
      values[definition.key] = value;
    }
    return values;
  }

  /**
   * Extension settings as a consumer-facing map: a set encrypted value appears as a mask of itself,
   * never as plaintext. The mask is of the stored value, so "set" and "not set" stay distinguishable
   * — an empty answer for a filled secret would read as an unfilled setting.
   */
  private async extensionSettingsForApi(
    userId: string,
    category?: string,
  ): Promise<Record<string, unknown>> {
    const declarations = extensionSettingDefinitions().filter(
      (definition) => category === undefined || definition.category === category,
    );
    if (declarations.length === 0) return {};

    const values: Record<string, unknown> = {};
    for (const definition of declarations) {
      const raw = await this.extensionSettingsRepo.getRawValue(userId, definition.key);
      if (definition.type === "encrypted") {
        // Match the built-in settings contract: only a persisted encrypted value is exposed, and
        // it is exposed as a mask. A manifest default must never become plaintext in an API/MCP
        // response merely because no user row exists yet.
        if (raw !== null) values[definition.key] = maskEncryptedValue(raw);
        continue;
      }
      if (raw === null) {
        if (definition.defaultValue !== null && definition.defaultValue !== undefined) {
          values[definition.key] = convertSettingValue(definition.defaultValue, definition.type);
        }
        continue;
      }
      values[definition.key] = convertSettingValue(raw, definition.type);
    }
    return values;
  }

  async getSettingDefinition(key: string): Promise<SettingDefinition | null> {
    // The declaration wins, as it does in the merged list and in every value path: one key must not
    // be described by one source and stored by another.
    const declared = extensionSettingDefinition(key);
    if (declared) return declared;
    return await this.settingsRepo.getSettingDefinition(key);
  }

  async getSettingDefinitions(category?: string): Promise<SettingDefinition[]> {
    const stored = await this.settingsRepo.getSettingDefinitions(category);
    return mergeSettingDefinitions(stored, undefined, category);
  }

  async createSettingDefinition(
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const declared = extensionSettingDefinition(definition.key);
    if (declared) {
      // The key is already declared by an installed extension. Storing a row of the same name would
      // give the key two definitions of different lifetimes — one that disappears with the bundle
      // and one that does not — and the merged list would have to pick a winner every time it is
      // read.
      throw new ValidationError(
        `Setting '${definition.key}' is declared by extension '${declared.extensionName}' and cannot also be defined in the database`,
        { key: definition.key, extensionName: declared.extensionName },
      );
    }
    // Note: createSettingDefinition requires adminUserId for audit
    // This method is called from MCP tools which have user context
    // For now, keep direct repository call - admin audit handled at higher level
    await this.settingsRepo.createSettingDefinition(definition);
  }

  async deleteSettingDefinition(key: string): Promise<void> {
    const declared = extensionSettingDefinition(key);
    if (declared) {
      // Refused by name rather than deleting nothing and reporting success: an extension's
      // definition is not in the database, and it goes away by removing the bundle.
      throw new ValidationError(
        `Setting '${key}' is declared by extension '${declared.extensionName}'; remove the extension to remove the setting`,
        { key, extensionName: declared.extensionName },
      );
    }
    // Note: deleteSettingDefinition requires adminUserId for audit
    // This method is called from MCP tools which have user context
    // For now, keep direct repository call - admin audit handled at higher level
    await this.settingsRepo.deleteSettingDefinition(key);
  }

  async deleteUserSettingValue(userId: string, key: string): Promise<void> {
    const declaredForDelete = extensionSettingDefinition(key);
    if (declaredForDelete) {
      await this.extensionSettingsRepo.deleteValueWithAudit(userId, key, {
        action: AuditAction.SETTINGS_DELETE,
        resource: "setting",
        resourceId: key,
        source: getAuditSource(),
        metadata: JSON.stringify({
          category: declaredForDelete.category,
          extensionName: declaredForDelete.extensionName,
        }),
      });
      return;
    }
    // Use SettingsService for automatic audit
    await this.settingsService.delete(userId, key);
  }

  // === Audit Log Operations ===
  // Delegate to AuditRepository

  async logAudit(entry: Omit<AuditLogEntry, "id" | "createdAt">): Promise<string> {
    return await this.auditRepo.log(entry);
  }

  async listAuditLogs(filter: AuditLogFilter = {}): Promise<AuditLogEntry[]> {
    return await this.auditRepo.list(filter);
  }

  async getAuditLogs(filter: AuditLogFilter): Promise<AuditLogEntry[]> {
    return await this.auditRepo.list(filter);
  }

  async getAuditLogsWithTotal(
    filter: AuditLogFilter,
  ): Promise<{ entries: AuditLogEntry[]; total: number }> {
    return await this.auditRepo.listWithTotal(filter);
  }

  async getAuditLog(id: string): Promise<AuditLogEntry | null> {
    return await this.auditRepo.get(id);
  }

  async countAuditByActionAndResourceId(action: string, resourceId: string): Promise<number> {
    return await this.auditRepo.countByActionAndResourceId(action, resourceId);
  }

  /**
   * Database maintenance operations
   */
  async vacuum(): Promise<void> {
    const db = getSqliteInstance();
    db.pragma("vacuum");
  }

  async backup(backupPath: string): Promise<void> {
    const db = getSqliteInstance();
    await db.backup(backupPath);
  }
}
