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
  SettingsRepository,
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
import { createLogger } from "@mcp-moira/shared";

export class DatabaseRepository implements IDataRepository {
  // Repositories for read operations
  private workflowRepo: WorkflowRepository;
  private executionRepo: ExecutionRepository;
  private settingsRepo: SettingsRepository;
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
    this.settingsRepo = new SettingsRepository(db);
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

  async findActiveChildExecutions(parentExecutionId: string): Promise<string[]> {
    return await this.executionRepo.findActiveChildExecutions(parentExecutionId);
  }

  async updateExecutionContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
  ): Promise<boolean> {
    return await this.executionRepo.updateContext(executionId, context);
  }

  // === Settings Operations ===
  // Write operations use SettingsService for automatic audit

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSetting<T = any>(userId: string, key: string): Promise<T | null> {
    return await this.settingsRepo.getSetting<T>(userId, key);
  }

  async getRawSettingValue(userId: string, key: string): Promise<string | null> {
    return await this.settingsRepo.getRawSettingValue(userId, key);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setSetting(userId: string, key: string, value: any): Promise<void> {
    // Use SettingsService for automatic audit
    await this.settingsService.set(userId, key, value);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettings(userId: string, category?: string): Promise<Record<string, any>> {
    return await this.settingsRepo.getSettings(userId, category);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettingsForApi(userId: string, category?: string): Promise<Record<string, any>> {
    return await this.settingsRepo.getSettingsForApi(userId, category);
  }

  async getSettingDefinition(key: string): Promise<SettingDefinition | null> {
    return await this.settingsRepo.getSettingDefinition(key);
  }

  async getSettingDefinitions(category?: string): Promise<SettingDefinition[]> {
    return await this.settingsRepo.getSettingDefinitions(category);
  }

  async createSettingDefinition(
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    // Note: createSettingDefinition requires adminUserId for audit
    // This method is called from MCP tools which have user context
    // For now, keep direct repository call - admin audit handled at higher level
    await this.settingsRepo.createSettingDefinition(definition);
  }

  async deleteSettingDefinition(key: string): Promise<void> {
    // Note: deleteSettingDefinition requires adminUserId for audit
    // This method is called from MCP tools which have user context
    // For now, keep direct repository call - admin audit handled at higher level
    await this.settingsRepo.deleteSettingDefinition(key);
  }

  async deleteUserSettingValue(userId: string, key: string): Promise<void> {
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
