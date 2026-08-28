/**
 * In-Memory Repository Implementation
 * For testing purposes - no persistence
 */

import { randomUUID } from "node:crypto";
import { IDataRepository, WorkflowInfo, SettingDefinition } from "../interfaces/data-repository.js";
import { WorkflowGraph } from "../interfaces/core-interfaces.js";
import {
  WorkflowExecution,
  type ReminderMutation,
  type ReminderMutationResult,
} from "../types/base-types.js";
import {
  ConflictError,
  ValidationError,
  applyExecutionReminderMutation,
  createLogger,
  mapLegacyStatusArray,
} from "@mcp-moira/shared";
import { encryptValue, decryptValue } from "../utils/encryption.js";
import type {
  ExecutionFilter,
  ExecutionListResult,
  WorkflowFilter,
  WorkflowListResult,
  ExecutionError,
} from "@mcp-moira/shared";

export class InMemoryRepository implements IDataRepository {
  private workflows = new Map<
    string,
    {
      graph: WorkflowGraph;
      userId: string;
      visibility: "public" | "private";
      createdAt: number;
      updatedAt: number;
    }
  >();
  private executions = new Map<string, WorkflowExecution>();
  private settingDefinitions = new Map<string, SettingDefinition>();
  private settingValues = new Map<string, Map<string, { value: string; encrypted: boolean }>>();
  private logger = createLogger({ component: "InMemoryRepository" });

  constructor() {
    this.logger.info("InMemoryRepository initialized");
  }

  // === Workflow Operations ===

  async listWorkflows(userId: string): Promise<WorkflowInfo[]> {
    const result: WorkflowInfo[] = [];

    for (const [id, data] of this.workflows.entries()) {
      if (data.userId === userId || data.visibility === "public") {
        result.push({
          id,
          slug: id, // In-memory uses ID as slug
          userId: data.userId,
          ownerHandle: "test-user", // In-memory doesn't track handles
          visibility: data.visibility,
          accessType: data.userId === userId ? "owner" : "public",
          metadata: data.graph.metadata,
          storagePath: `memory:workflow:${id}`,
          size: JSON.stringify(data.graph).length,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          workflow: data.graph,
          // In-memory uses unknown validation status (not cached)
          validation: { status: "unknown", errors: [], validatedAt: null },
        });
      }
    }

    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listWorkflowsWithFilters(filter: WorkflowFilter): Promise<WorkflowListResult> {
    const {
      userId,
      search,
      visibility,
      sort = "createdAt",
      sortOrder = "desc",
      limit = 20,
      offset = 0,
    } = filter;

    // Start with all workflows
    let workflows: WorkflowInfo[] = [];

    for (const [id, data] of this.workflows.entries()) {
      // Visibility filter
      if (visibility === "public") {
        if (data.visibility !== "public") continue;
      } else if (visibility === "private") {
        if (data.userId !== userId || data.visibility !== "private") continue;
      } else {
        // 'all' or undefined - user's own + public
        if (data.userId !== userId && data.visibility !== "public") continue;
      }

      workflows.push({
        id,
        slug: id, // In-memory uses ID as slug
        userId: data.userId,
        ownerHandle: "test-user", // In-memory doesn't track handles
        visibility: data.visibility,
        accessType: data.userId === userId ? "owner" : "public",
        metadata: data.graph.metadata,
        storagePath: `memory:workflow:${id}`,
        size: JSON.stringify(data.graph).length,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        workflow: data.graph,
        // In-memory uses unknown validation status (not cached)
        validation: { status: "unknown", errors: [], validatedAt: null },
      });
    }

    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      workflows = workflows.filter(
        (w) =>
          w.metadata.name.toLowerCase().includes(searchLower) ||
          (w.metadata.description && w.metadata.description.toLowerCase().includes(searchLower)),
      );
    }

    // Get total count before pagination
    const total = workflows.length;

    // Sort
    workflows.sort((a, b) => {
      if (sort === "name") {
        const cmp = a.metadata.name.localeCompare(b.metadata.name);
        return sortOrder === "asc" ? cmp : -cmp;
      } else {
        // createdAt
        return sortOrder === "asc" ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
      }
    });

    // Apply pagination
    const effectiveLimit = Math.min(Math.max(1, limit), 100);
    const effectiveOffset = Math.max(0, offset);
    workflows = workflows.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    return { workflows, total };
  }

  async getWorkflowGraph(workflowId: string, userId: string): Promise<WorkflowGraph | null> {
    const data = this.workflows.get(workflowId);

    if (!data) {
      return null;
    }

    if (data.userId !== userId && data.visibility !== "public") {
      return null;
    }

    return data.graph;
  }

  async getWorkflowGraphBySlug(slug: string, userId: string): Promise<WorkflowGraph | null> {
    // In-memory repository uses ID as slug, so just call getWorkflowGraph
    return this.getWorkflowGraph(slug, userId);
  }

  async resolveWorkflow(
    identifier: string,
    userId: string,
  ): Promise<{ workflow: WorkflowGraph; workflowId: string; slug: string } | null> {
    // In-memory repository uses ID as slug
    // Try to get by ID (which also serves as slug in memory)
    const workflow = await this.getWorkflowGraph(identifier, userId);
    if (workflow) {
      return { workflow, workflowId: identifier, slug: identifier };
    }

    // Handle/slug format - extract slug part
    if (identifier.includes("/")) {
      const slug = identifier.split("/")[1];
      const resolved = await this.getWorkflowGraph(slug, userId);
      if (resolved) {
        return { workflow: resolved, workflowId: slug, slug };
      }
    }

    return null;
  }

  async getWorkflow(workflowId: string, userId: string): Promise<WorkflowInfo | null> {
    const data = this.workflows.get(workflowId);

    if (!data) {
      return null;
    }

    if (data.userId !== userId && data.visibility !== "public") {
      return null;
    }

    return {
      id: workflowId,
      slug: workflowId, // In-memory uses ID as slug
      userId: data.userId,
      ownerHandle: "test-user", // In-memory doesn't track handles
      visibility: data.visibility,
      accessType: data.userId === userId ? "owner" : "public",
      metadata: data.graph.metadata,
      storagePath: `memory:workflow:${workflowId}`,
      size: JSON.stringify(data.graph).length,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      workflow: data.graph,
      // In-memory uses unknown validation status (not cached)
      validation: { status: "unknown", errors: [], validatedAt: null },
    };
  }

  async saveWorkflow(
    graph: WorkflowGraph,
    userId: string,
    visibility: "public" | "private" = "private",
  ): Promise<void> {
    const now = Date.now();
    // id is server-assigned; generate one for a new (id-less) graph.
    const workflowId = graph.id ?? randomUUID();
    const storedGraph = graph.id ? graph : { ...graph, id: workflowId };
    const existing = this.workflows.get(workflowId);

    this.workflows.set(workflowId, {
      graph: storedGraph,
      userId,
      visibility,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });

    this.logger.debug("Workflow saved in memory", {
      workflowId,
      userId: userId.slice(0, 8),
    });
  }

  async deleteWorkflow(workflowId: string, userId: string): Promise<void> {
    const data = this.workflows.get(workflowId);

    if (!data) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (data.userId !== userId) {
      throw new Error(`Access denied: workflow ${workflowId}`);
    }

    this.workflows.delete(workflowId);

    this.logger.debug("Workflow deleted from memory", {
      workflowId,
      userId: userId.slice(0, 8),
    });
  }

  async softDeleteWorkflow(workflowId: string, userId: string): Promise<boolean> {
    // In-memory doesn't support soft delete - just hard delete
    await this.deleteWorkflow(workflowId, userId);
    return true;
  }

  async restoreWorkflow(_workflowId: string, _userId: string): Promise<boolean> {
    // In-memory doesn't support restore
    return false;
  }

  async listDeletedWorkflows(_userId: string): Promise<WorkflowInfo[]> {
    // In-memory doesn't support deleted list
    return [];
  }

  async listAllDeletedWorkflows(): Promise<
    Array<{ id: string; name: string; deletedAt: number | null; deletedBy: string | null }>
  > {
    // In-memory doesn't support deleted list
    return [];
  }

  async listAllDeletedWorkflowsPaginated(_filter: {
    search?: string;
    sort?: "name" | "deletedAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    items: Array<{ id: string; name: string; deletedAt: number | null; deletedBy: string | null }>;
    total: number;
  }> {
    return { items: [], total: 0 };
  }

  // === Execution Operations ===

  async saveExecution(execution: WorkflowExecution): Promise<void> {
    const current = this.executions.get(execution.executionId);
    if (current) {
      if (current.revision !== execution.revision) {
        throw new ConflictError("Execution state changed; reload before writing", {
          executionId: execution.executionId,
          expectedRevision: execution.revision,
          currentRevision: current.revision,
        });
      }
      execution.revision += 1;
    }
    this.executions.set(execution.executionId, structuredClone(execution));

    this.logger.debug("Execution saved in memory", {
      executionId: execution.executionId.slice(0, 8),
    });
  }

  async getExecution(executionId: string): Promise<WorkflowExecution | null> {
    const execution = this.executions.get(executionId);
    return execution ? structuredClone(execution) : null;
  }

  async listExecutions(): Promise<WorkflowExecution[]> {
    return Array.from(this.executions.values()).map((e) => ({ ...e }));
  }

  async listUserExecutions(userId: string): Promise<WorkflowExecution[]> {
    return Array.from(this.executions.values())
      .filter((e) => e.userId === userId)
      .map((e) => ({ ...e }));
  }

  async listExecutionsWithFilters(filter: ExecutionFilter): Promise<ExecutionListResult> {
    const {
      userId,
      status,
      workflowId,
      search,
      sort = "createdAt",
      sortOrder = "desc",
      limit = 20,
      offset = 0,
    } = filter;

    // Start with all executions
    let executions = Array.from(this.executions.values());

    // Apply filters
    if (userId) {
      executions = executions.filter((e) => e.userId === userId);
    }

    // Map legacy statuses for backward compatibility
    // Both filter and execution statuses are mapped:
    // 'waiting' → 'running', 'failed' → 'completed'
    if (status && status.length > 0) {
      const { dbStatuses: mappedFilterStatuses } = mapLegacyStatusArray(status);
      executions = executions.filter((e) => {
        // Map execution's status too (it might be 'waiting' or 'failed' in legacy data)
        const { dbStatuses: mappedExecStatuses } = mapLegacyStatusArray([e.status]);
        return mappedExecStatuses.some((s) => mappedFilterStatuses.includes(s));
      });
    }

    if (workflowId) {
      executions = executions.filter((e) => e.workflowId === workflowId);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      executions = executions.filter((e) => e.note?.toLowerCase().includes(searchLower));
    }

    // Get total count before pagination
    const total = executions.length;

    // Sort
    executions.sort((a, b) => {
      const aVal = sort === "updatedAt" ? a.updatedAt : a.createdAt;
      const bVal = sort === "updatedAt" ? b.updatedAt : b.createdAt;
      return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
    });

    // Apply pagination
    const effectiveLimit = Math.min(Math.max(1, limit), 100);
    const effectiveOffset = Math.max(0, offset);
    executions = executions.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    return {
      executions: executions.map((e) => ({ ...e })),
      total,
    };
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.executions.delete(executionId);

    this.logger.debug("Execution deleted from memory", {
      executionId: executionId.slice(0, 8),
    });
  }

  async updateExecutionNote(executionId: string, note: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (execution) {
      execution.note = note;
      execution.updatedAt = Date.now();
      execution.revision += 1;
    }
  }

  async appendError(executionId: string, error: ExecutionError): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return false;
    }

    // Initialize errors array if not present
    if (!execution.errors) {
      execution.errors = [];
    }

    // Append error
    execution.errors.push(error);
    execution.updatedAt = Date.now();
    execution.revision += 1;

    this.logger.debug("Error appended to execution", {
      executionId: executionId.slice(0, 8),
      errorType: error.errorType,
      nodeId: error.nodeId,
      errorCount: execution.errors.length,
    });

    return true;
  }

  async cancelExecution(
    executionId: string,
    error: ExecutionError,
  ): Promise<{ changed: boolean; execution: WorkflowExecution | null }> {
    const execution = this.executions.get(executionId);
    if (!execution) return { changed: false, execution: null };
    if (execution.status === "completed") {
      return { changed: false, execution: structuredClone(execution) };
    }

    execution.errors ??= [];
    execution.errors.push(error);
    execution.status = "completed";
    execution.updatedAt = Date.now();
    execution.completedAt = execution.updatedAt;
    execution.revision += 1;
    return { changed: true, execution: structuredClone(execution) };
  }

  async findActiveChildExecutions(parentExecutionId: string): Promise<string[]> {
    const result: string[] = [];
    for (const execution of this.executions.values()) {
      if (
        execution.parentExecutionId === parentExecutionId &&
        (execution.status === "running" || execution.status === "waiting")
      ) {
        result.push(execution.executionId);
      }
    }
    return result;
  }

  async setExecutionParent(
    executionId: string,
    parentExecutionId: string | null,
    userId: string,
    expectedRevision: number,
  ): Promise<WorkflowExecution> {
    const child = this.executions.get(executionId);
    if (!child) throw new ValidationError("Execution must exist");
    if (child.userId !== userId)
      throw new ValidationError("Execution must belong to the authenticated user");
    if (child.status !== "running") throw new ValidationError("Execution must be running");
    if ((child.parentExecutionId ?? null) === parentExecutionId) return structuredClone(child);
    if (child.revision !== expectedRevision) {
      throw new ConflictError("Execution state changed; reload before changing parent", {
        executionId,
        expectedRevision,
        currentRevision: child.revision,
      });
    }
    if (parentExecutionId) {
      const parent = this.executions.get(parentExecutionId);
      if (!parent) throw new ValidationError("Parent execution must exist");
      if (parent.userId !== userId)
        throw new ValidationError("Parent execution must belong to the authenticated user");
      if (parent.status !== "running")
        throw new ValidationError("Parent execution must be running");
      if (executionId === parentExecutionId)
        throw new ValidationError("An execution cannot be its own parent");
      const visited = new Set<string>();
      let cursor: WorkflowExecution | undefined = parent;
      while (cursor) {
        if (cursor.executionId === executionId)
          throw new ValidationError("Parent change would create an execution cycle");
        if (visited.has(cursor.executionId))
          throw new ValidationError("Existing execution ancestry contains a cycle");
        visited.add(cursor.executionId);
        cursor = cursor.parentExecutionId
          ? this.executions.get(cursor.parentExecutionId)
          : undefined;
      }
    }
    const updated = structuredClone(child);
    updated.parentExecutionId = parentExecutionId;
    updated.revision += 1;
    updated.updatedAt = Date.now();
    this.executions.set(executionId, updated);
    return structuredClone(updated);
  }

  async mutateExecutionReminder(
    executionId: string,
    userId: string,
    expectedRevision: number,
    mutation: ReminderMutation,
  ): Promise<ReminderMutationResult> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new ValidationError("Execution must exist");
    if (execution.userId !== userId)
      throw new ValidationError("Execution must belong to the authenticated user");
    if (execution.status !== "running")
      throw new ValidationError("Only running executions accept reminder mutations");
    const applied = applyExecutionReminderMutation(execution.reminders ?? [], mutation);
    if (!applied.changed)
      return { reminder: applied.reminder, revision: execution.revision, changed: false };
    if (execution.revision !== expectedRevision)
      throw new ConflictError("Execution state changed; reload before changing reminders");
    const updated = structuredClone(execution);
    updated.reminders = applied.reminders;
    updated.revision += 1;
    updated.updatedAt = Date.now();
    this.executions.set(executionId, updated);
    return { reminder: applied.reminder, revision: updated.revision, changed: true };
  }

  async updateExecutionContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
    expectedRevision: number,
  ): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (!execution) {
      return false;
    }
    if (execution.revision !== expectedRevision) {
      throw new ConflictError("Execution state changed; reload before updating context", {
        executionId,
        expectedRevision,
        currentRevision: execution.revision,
      });
    }

    if (context.variables) {
      execution.globalContext.variables = {
        ...execution.globalContext.variables,
        ...context.variables,
      };
    }
    if (context.nodeStates) {
      execution.globalContext.nodeStates = {
        ...execution.globalContext.nodeStates,
        ...context.nodeStates,
      };
    }
    execution.updatedAt = Date.now();
    execution.revision += 1;
    return true;
  }

  // === Settings Operations ===

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSetting<T = any>(userId: string, key: string): Promise<T | null> {
    const definition = this.settingDefinitions.get(key);
    if (!definition) {
      return null;
    }

    const userValues = this.settingValues.get(userId);
    const userValue = userValues?.get(key);

    let rawValue: string;

    if (!userValue) {
      if (!definition.defaultValue) {
        return null;
      }
      rawValue = definition.defaultValue;
    } else {
      rawValue = userValue.value;

      if (userValue.encrypted && definition.type === "encrypted") {
        rawValue = decryptValue(rawValue);
      }
    }

    return this.convertToType<T>(rawValue, definition.type);
  }

  async getRawSettingValue(userId: string, key: string): Promise<string | null> {
    const userValues = this.settingValues.get(userId);
    const userValue = userValues?.get(key);
    return userValue ? userValue.value : null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async setSetting(userId: string, key: string, value: any): Promise<void> {
    const definition = this.settingDefinitions.get(key);
    if (!definition) {
      throw new Error(`Setting definition not found: ${key}`);
    }

    let stringValue: string;
    if (typeof value === "object" && value !== null) {
      stringValue = JSON.stringify(value);
    } else {
      stringValue = String(value);
    }

    const shouldEncrypt = definition.type === "encrypted";

    if (shouldEncrypt) {
      stringValue = encryptValue(stringValue);
    }

    if (!this.settingValues.has(userId)) {
      this.settingValues.set(userId, new Map());
    }

    this.settingValues.get(userId)!.set(key, {
      value: stringValue,
      encrypted: shouldEncrypt,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettings(userId: string, category?: string): Promise<Record<string, any>> {
    const definitions = await this.getSettingDefinitions(category);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};

    for (const def of definitions) {
      const value = await this.getSetting(userId, def.key);
      if (value !== null) {
        result[def.key] = value;
      }
    }

    return result;
  }

  /**
   * Get settings for API/MCP responses - masks encrypted values
   * Safe for client exposure
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSettingsForApi(userId: string, category?: string): Promise<Record<string, any>> {
    const definitions = await this.getSettingDefinitions(category);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};

    for (const def of definitions) {
      if (def.type === "encrypted") {
        // Check if value exists without decrypting
        const rawValue = await this.getRawSettingValue(userId, def.key);
        if (rawValue !== null) {
          result[def.key] = "[encrypted]";
        }
      } else {
        const value = await this.getSetting(userId, def.key);
        if (value !== null) {
          result[def.key] = value;
        }
      }
    }

    return result;
  }

  async getSettingDefinition(key: string): Promise<SettingDefinition | null> {
    return this.settingDefinitions.get(key) || null;
  }

  async getSettingDefinitions(category?: string): Promise<SettingDefinition[]> {
    const all = Array.from(this.settingDefinitions.values());

    if (category) {
      return all.filter((d) => d.category === category);
    }

    return all;
  }

  async createSettingDefinition(
    definition: Omit<SettingDefinition, "createdAt" | "updatedAt">,
  ): Promise<void> {
    const now = Date.now();

    this.settingDefinitions.set(definition.key, {
      ...definition,
      createdAt: now,
      updatedAt: now,
    });
  }

  async deleteSettingDefinition(key: string): Promise<void> {
    this.settingDefinitions.delete(key);

    // Delete all user values for this setting
    for (const userValues of this.settingValues.values()) {
      userValues.delete(key);
    }
  }

  async deleteUserSettingValue(userId: string, key: string): Promise<void> {
    const userValues = this.settingValues.get(userId);
    if (userValues) {
      userValues.delete(key);
    }
  }

  private convertToType<T>(value: string, type: string): T {
    switch (type) {
      case "number":
        return Number(value) as T;
      case "boolean":
        return (value === "true" || value === "1") as T;
      case "json":
        return JSON.parse(value) as T;
      case "string":
      case "encrypted":
      default:
        return value as T;
    }
  }

  // === Test Helper Methods ===

  clear(): void {
    this.workflows.clear();
    this.executions.clear();
    this.settingDefinitions.clear();
    this.settingValues.clear();
    this.logger.debug("Memory cleared");
  }

  addSettingDefinition(definition: SettingDefinition): void {
    this.settingDefinitions.set(definition.key, definition);
  }

  getWorkflowCount(): number {
    return this.workflows.size;
  }

  getExecutionCount(): number {
    return this.executions.size;
  }
}
