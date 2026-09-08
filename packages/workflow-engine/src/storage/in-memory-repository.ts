/**
 * In-Memory Repository Implementation
 * For testing purposes - no persistence
 */

import { createHash, randomUUID } from "node:crypto";
import { IDataRepository, WorkflowInfo, SettingDefinition } from "../interfaces/data-repository.js";
import {
  extensionSettingDefinition,
  mergeSettingDefinitions,
  prepareExtensionSettingValue,
} from "../extensions/extension-settings.js";
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
  canonicalJson,
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
  private executionAttempts = new Map<string, ExecutionAttempt>();
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

  async createPresentedExecutionAttempt(attempt: PresentedExecutionAttempt): Promise<void> {
    if (this.executionAttempts.has(attempt.attemptId)) throw new ConflictError("Attempt exists");
    this.executionAttempts.set(attempt.attemptId, {
      ...structuredClone(attempt),
      operation: "step",
      reservedExecutionId: null,
      requestPayload: null,
      inputFingerprint: null,
      state: "presented",
      ownerId: null,
      fence: 0,
      heartbeatAt: null,
      leaseExpiresAt: null,
      nextAttemptId: null,
      expiresAt: null,
      updatedAt: attempt.createdAt,
      completedAt: null,
    });
  }

  async prepareStartExecutionAttempt(attempt: PreparedStartExecutionAttempt): Promise<void> {
    for (const [attemptId, existing] of this.executionAttempts) {
      if (
        existing.operation === "start" &&
        existing.userId === attempt.userId &&
        existing.state === "presented" &&
        (existing.expiresAt ?? 0) <= attempt.createdAt
      ) {
        this.executionAttempts.delete(attemptId);
      }
    }
    const live = [...this.executionAttempts.values()]
      .filter(
        (existing) =>
          existing.operation === "start" &&
          existing.userId === attempt.userId &&
          existing.state === "presented",
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.attemptId.localeCompare(right.attemptId),
      );
    for (const existing of live.slice(0, Math.max(0, live.length - 99))) {
      this.executionAttempts.delete(existing.attemptId);
    }
    if (this.executionAttempts.has(attempt.attemptId)) throw new ConflictError("Attempt exists");
    this.executionAttempts.set(attempt.attemptId, {
      ...structuredClone(attempt),
      operation: "start",
      executionId: null,
      executionRevision: null,
      nodeId: null,
      state: "presented",
      ownerId: null,
      fence: 0,
      heartbeatAt: null,
      leaseExpiresAt: null,
      response: null,
      nextAttemptId: null,
      updatedAt: attempt.createdAt,
      completedAt: null,
    });
  }

  async claimStartExecutionAttempt(
    input: ClaimStartExecutionAttemptInput,
  ): Promise<ExecutionAttemptClaimResult> {
    const attempt = this.executionAttempts.get(input.attemptId);
    if (!attempt || attempt.operation !== "start" || attempt.userId !== input.userId)
      return { kind: "invalid" };
    if (attempt.state === "completed" && attempt.response !== null)
      return { kind: "completed", attempt: structuredClone(attempt), response: attempt.response };
    if (attempt.state === "outcome_unknown")
      return { kind: "outcome_unknown", attempt: structuredClone(attempt) };
    if (attempt.state === "executing")
      return { kind: "processing", attempt: structuredClone(attempt) };
    if ((attempt.expiresAt ?? 0) <= input.now) {
      this.executionAttempts.delete(input.attemptId);
      return { kind: "invalid" };
    }
    if (
      attempt.reservedExecutionId !== input.execution.executionId ||
      attempt.workflowId !== input.workflowId ||
      attempt.workflowVersion !== input.workflowVersion ||
      attempt.workflowDigest !== input.workflowDigest ||
      attempt.inputFingerprint === null
    )
      return { kind: "stale" };
    const storedWorkflow = this.workflows.get(attempt.workflowId);
    if (
      !storedWorkflow ||
      (storedWorkflow.userId !== input.userId && storedWorkflow.visibility !== "public") ||
      storedWorkflow.graph.metadata.version !== attempt.workflowVersion ||
      createHash("sha256").update(canonicalJson(storedWorkflow.graph)).digest("hex") !==
        attempt.workflowDigest
    )
      return { kind: "stale" };
    if (input.execution.parentExecutionId) {
      const parent = this.executions.get(input.execution.parentExecutionId);
      if (!parent || parent.userId !== input.userId || parent.status !== "running")
        return { kind: "stale" };
    }
    if (this.executions.has(input.execution.executionId)) return { kind: "stale" };

    const fence = attempt.fence + 1;
    Object.assign(attempt, {
      executionId: input.execution.executionId,
      executionRevision: input.execution.revision,
      nodeId: input.execution.currentNodeId,
      state: "executing",
      ownerId: input.ownerId,
      fence,
      heartbeatAt: input.now,
      leaseExpiresAt: input.now + input.leaseMs,
      updatedAt: input.now,
    });
    this.executions.set(input.execution.executionId, structuredClone(input.execution));
    return { kind: "claimed", attempt: structuredClone(attempt), fence };
  }

  async completeStartAttemptPrecondition(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): Promise<StartPreconditionCompletionResult> {
    const attempt = this.executionAttempts.get(attemptId);
    if (!attempt || attempt.operation !== "start" || attempt.userId !== userId)
      return { kind: "invalid" };
    if (attempt.state === "completed" && attempt.response !== null)
      return { kind: "replay", response: attempt.response };
    if (attempt.state === "executing")
      return { kind: "processing", attempt: structuredClone(attempt) };
    if (attempt.state === "outcome_unknown")
      return { kind: "outcome_unknown", attempt: structuredClone(attempt) };
    if ((attempt.expiresAt ?? 0) <= now) {
      this.executionAttempts.delete(attemptId);
      return { kind: "invalid" };
    }
    Object.assign(attempt, { state: "completed", response, completedAt: now, updatedAt: now });
    return { kind: "completed", response };
  }

  async getBlockingStartExecutionAttempt(
    executionId: string,
    userId: string,
  ): Promise<ExecutionAttempt | null> {
    const attempt = [...this.executionAttempts.values()].find(
      (candidate) =>
        candidate.operation === "start" &&
        candidate.state === "outcome_unknown" &&
        candidate.executionId === executionId &&
        candidate.userId === userId,
    );
    return attempt ? structuredClone(attempt) : null;
  }

  async cancelExecutionWithStartAttempt(
    executionId: string,
    userId: string,
    expectedRevision: number,
    error: ExecutionError,
  ): Promise<boolean> {
    const execution = this.executions.get(executionId);
    const blockingAttempt = [...this.executionAttempts.values()].find(
      (attempt) =>
        attempt.operation === "start" &&
        attempt.state === "outcome_unknown" &&
        attempt.executionId === executionId &&
        attempt.userId === userId,
    );
    if (
      !execution ||
      !blockingAttempt ||
      execution.userId !== userId ||
      execution.status !== "running" ||
      execution.revision !== expectedRevision
    )
      return false;
    const updated = structuredClone(execution);
    updated.status = "completed";
    updated.error = error.message;
    updated.errors = [...(updated.errors ?? []), error];
    updated.completedAt = error.timestamp;
    updated.updatedAt = error.timestamp;
    updated.revision += 1;
    this.executions.set(executionId, updated);
    for (const [attemptId, attempt] of this.executionAttempts) {
      if (
        attempt.operation === "start" &&
        attempt.state === "outcome_unknown" &&
        attempt.executionId === executionId &&
        attempt.userId === userId
      )
        this.executionAttempts.delete(attemptId);
    }
    return true;
  }

  async getExecutionAttempt(attemptId: string): Promise<ExecutionAttempt | null> {
    const attempt = this.executionAttempts.get(attemptId);
    return attempt ? structuredClone(attempt) : null;
  }

  async updatePresentedExecutionAttemptResponse(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): Promise<boolean> {
    const attempt = this.executionAttempts.get(attemptId);
    if (!attempt || attempt.userId !== userId || attempt.state !== "presented") return false;
    attempt.response = response;
    attempt.updatedAt = now;
    return true;
  }

  async getCurrentExecutionAttempt(
    executionId: string,
    userId: string,
  ): Promise<ExecutionAttempt | null> {
    const attempts = [...this.executionAttempts.values()]
      .filter(
        (attempt) =>
          attempt.executionId === executionId &&
          attempt.userId === userId &&
          attempt.operation === "step" &&
          ["presented", "executing", "outcome_unknown"].includes(attempt.state),
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    return attempts[0] ? structuredClone(attempts[0]) : null;
  }

  async claimExecutionAttempt(input: {
    attemptId: string;
    userId: string;
    executionId: string;
    executionRevision: number;
    nodeId: string;
    workflowId: string;
    workflowVersion: string;
    workflowDigest: string;
    inputFingerprint: string;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): Promise<ExecutionAttemptClaimResult> {
    const attempt = this.executionAttempts.get(input.attemptId);
    if (!attempt || attempt.operation !== "step" || attempt.userId !== input.userId)
      return { kind: "invalid" };
    if (attempt.executionId !== input.executionId) return { kind: "stale" };
    if (attempt.inputFingerprint && attempt.inputFingerprint !== input.inputFingerprint)
      return { kind: "conflict" };
    if (attempt.state === "completed" && attempt.response !== null)
      return { kind: "completed", attempt: structuredClone(attempt), response: attempt.response };
    if (
      attempt.executionRevision !== input.executionRevision ||
      attempt.nodeId !== input.nodeId ||
      attempt.workflowId !== input.workflowId ||
      attempt.workflowVersion !== input.workflowVersion ||
      attempt.workflowDigest !== input.workflowDigest
    )
      return { kind: "stale" };
    if (attempt.state === "outcome_unknown")
      return { kind: "outcome_unknown", attempt: structuredClone(attempt) };
    if (attempt.state === "executing")
      return { kind: "processing", attempt: structuredClone(attempt) };
    attempt.state = "executing";
    attempt.inputFingerprint = input.inputFingerprint;
    attempt.ownerId = input.ownerId;
    attempt.fence += 1;
    attempt.heartbeatAt = input.now;
    attempt.leaseExpiresAt = input.now + input.leaseMs;
    attempt.updatedAt = input.now;
    return { kind: "claimed", attempt: structuredClone(attempt), fence: attempt.fence };
  }

  async heartbeatExecutionAttempt(
    attemptId: string,
    ownerId: string,
    fence: number,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    const attempt = this.executionAttempts.get(attemptId);
    if (
      !attempt ||
      attempt.state !== "executing" ||
      attempt.ownerId !== ownerId ||
      attempt.fence !== fence
    )
      return false;
    attempt.heartbeatAt = now;
    attempt.leaseExpiresAt = now + leaseMs;
    attempt.updatedAt = now;
    return true;
  }

  async completeExecutionAttempt(input: CompleteExecutionAttemptInput): Promise<boolean> {
    const attempt = this.executionAttempts.get(input.attemptId);
    const current = this.executions.get(input.execution.executionId);
    if (
      !attempt ||
      !current ||
      attempt.state !== "executing" ||
      attempt.ownerId !== input.ownerId ||
      attempt.fence !== input.fence ||
      attempt.inputFingerprint !== input.inputFingerprint ||
      current.revision !== input.execution.revision
    )
      return false;
    if (input.nextAttempt && this.executionAttempts.has(input.nextAttempt.attemptId)) {
      throw new ConflictError("Next execution attempt already exists");
    }
    const nextRevision = input.execution.revision + 1;
    const updatedExecution = structuredClone(input.execution);
    updatedExecution.revision = nextRevision;
    const now = Date.now();
    const completedAttempt: ExecutionAttempt = {
      ...structuredClone(attempt),
      state: "completed",
      response: input.response,
      nextAttemptId: input.nextAttempt?.attemptId ?? null,
      ownerId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now,
    };
    const presentedAttempt: ExecutionAttempt | undefined = input.nextAttempt
      ? {
          ...structuredClone(input.nextAttempt),
          executionRevision: nextRevision,
          operation: "step",
          reservedExecutionId: null,
          requestPayload: null,
          inputFingerprint: null,
          state: "presented",
          ownerId: null,
          fence: 0,
          heartbeatAt: null,
          leaseExpiresAt: null,
          nextAttemptId: null,
          expiresAt: null,
          updatedAt: input.nextAttempt.createdAt,
          completedAt: null,
        }
      : undefined;

    this.executions.set(input.execution.executionId, updatedExecution);
    this.executionAttempts.set(input.attemptId, completedAttempt);
    if (presentedAttempt) this.executionAttempts.set(presentedAttempt.attemptId, presentedAttempt);
    input.execution.revision = nextRevision;
    return true;
  }

  async markExecutionAttemptOutcomeUnknown(
    attemptId: string,
    ownerId: string,
    fence: number,
    now: number,
  ): Promise<boolean> {
    const attempt = this.executionAttempts.get(attemptId);
    if (
      !attempt ||
      attempt.state !== "executing" ||
      attempt.ownerId !== ownerId ||
      attempt.fence !== fence
    )
      return false;
    Object.assign(attempt, {
      state: "outcome_unknown",
      response: null,
      ownerId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
    return true;
  }

  async reconcileExpiredExecutionAttempts(now: number): Promise<ReconciledExecutionAttemptCounts> {
    const counts: ReconciledExecutionAttemptCounts = { start: 0, step: 0 };
    for (const attempt of this.executionAttempts.values()) {
      if (
        attempt.state === "executing" &&
        attempt.leaseExpiresAt !== null &&
        attempt.leaseExpiresAt < now
      ) {
        attempt.state = "outcome_unknown";
        attempt.response = null;
        attempt.ownerId = null;
        attempt.heartbeatAt = null;
        attempt.leaseExpiresAt = null;
        attempt.updatedAt = now;
        counts[attempt.operation] += 1;
      }
    }
    return counts;
  }

  async cleanupExecutionAttempts(now: number): Promise<number> {
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const completed = [...this.executionAttempts.values()].filter(
      (attempt) => attempt.operation === "step" && attempt.state === "completed",
    );
    const removable = new Set(
      completed.filter((attempt) => (attempt.completedAt ?? 0) < cutoff).map((a) => a.attemptId),
    );
    const byExecution = new Map<string, ExecutionAttempt[]>();
    for (const attempt of completed) {
      const id = attempt.executionId!;
      const list = byExecution.get(id) ?? [];
      list.push(attempt);
      byExecution.set(id, list);
    }
    for (const attempts of byExecution.values()) {
      attempts
        .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
        .slice(1_000)
        .forEach((attempt) => removable.add(attempt.attemptId));
    }
    for (const attempt of this.executionAttempts.values()) {
      if (
        attempt.operation === "start" &&
        attempt.state === "presented" &&
        (attempt.expiresAt ?? 0) <= now
      )
        removable.add(attempt.attemptId);
    }
    const startsByUser = new Map<string, ExecutionAttempt[]>();
    for (const attempt of this.executionAttempts.values()) {
      if (attempt.operation !== "start" || attempt.state !== "completed") continue;
      if ((attempt.completedAt ?? 0) < cutoff) removable.add(attempt.attemptId);
      const list = startsByUser.get(attempt.userId) ?? [];
      list.push(attempt);
      startsByUser.set(attempt.userId, list);
    }
    for (const attempts of startsByUser.values()) {
      attempts
        .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))
        .slice(1_000)
        .forEach((attempt) => removable.add(attempt.attemptId));
    }
    removable.forEach((id) => this.executionAttempts.delete(id));
    return removable.size;
  }

  // === Settings Operations ===

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSetting<T = any>(userId: string, key: string): Promise<T | null> {
    const definition = extensionSettingDefinition(key) ?? this.settingDefinitions.get(key);
    if (!definition) {
      return null;
    }

    const userValues = this.settingValues.get(userId);
    const userValue = userValues?.get(key);

    let rawValue: string;

    if (!userValue) {
      if (definition.defaultValue === null || definition.defaultValue === undefined) {
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
    const declared = extensionSettingDefinition(key);
    const definition = declared ?? this.settingDefinitions.get(key);
    if (!definition) {
      throw new Error(`Setting definition not found: ${key}`);
    }

    if (declared) {
      const prepared = prepareExtensionSettingValue(declared, value);
      if (prepared.problem) {
        throw new ValidationError(
          `Value for setting '${key}' does not satisfy type '${declared.type}' and the schema declared by extension '${declared.extensionName}': ${prepared.problem}`,
          { key, extensionName: declared.extensionName },
        );
      }
      value = prepared.value;
    }

    let stringValue: string;
    // Match the production repository's storage boundary: structural values are serialized before
    // type conversion reads them back. Limiting this to manifest-declared JSON would make ordinary
    // stored JSON definitions become "[object Object]" only in the in-memory implementation.
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
      const hasStoredValue = this.settingValues.get(userId)?.has(def.key) ?? false;
      const hasDefault = def.defaultValue !== null && def.defaultValue !== undefined;
      if (hasStoredValue || hasDefault) {
        result[def.key] = await this.getSetting(userId, def.key);
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
        const hasStoredValue = this.settingValues.get(userId)?.has(def.key) ?? false;
        const hasDefault = def.defaultValue !== null && def.defaultValue !== undefined;
        if (hasStoredValue || hasDefault) {
          result[def.key] = await this.getSetting(userId, def.key);
        }
      }
    }

    return result;
  }

  async getSettingDefinition(key: string): Promise<SettingDefinition | null> {
    // Settings declared by installed extensions are visible here for the same reason they are in
    // the database repository: two implementations of the same interface that disagree about which
    // settings exist would make a test green while the product refuses the very same key. The
    // declaration wins over a stored row of the same key, as it does there.
    return extensionSettingDefinition(key) ?? this.settingDefinitions.get(key) ?? null;
  }

  async getSettingDefinitions(category?: string): Promise<SettingDefinition[]> {
    const all = mergeSettingDefinitions(Array.from(this.settingDefinitions.values()));

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
    this.executionAttempts.clear();
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
