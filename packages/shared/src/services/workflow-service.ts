/**
 * Workflow Service - Business logic with automatic audit
 * Centralized workflow operations with audit trail
 *
 * Key concepts:
 * - Workflows are identified by UUID internally
 * - User-facing operations use slugs
 * - Global reference format: handle/slug
 * - Slug changes are audited
 */

import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type {
  WorkflowRepository,
  WorkflowFilter,
  WorkflowListResult,
  WorkflowInfo,
  ValidationCache,
} from "../database/repositories/workflow-repository.js";
import type { WorkflowMutationService } from "./workflow-mutation-service.js";
import type { UserRepository } from "../database/repositories/user-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { computeChanges } from "../logging/audit-logger.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import {
  WorkflowNotFoundError,
  UserNotFoundError,
  SlugConflictError,
  InvalidSlugError,
} from "../errors/domain-errors.js";
import { validateSlug, normalizeSlug, parseWorkflowReference } from "../validation/slug-handle.js";

/**
 * Options for saving a workflow via service
 */
export interface SaveWorkflowOptions {
  graph: WorkflowGraph;
  userId: string;
  slug?: string;
  visibility?: "public" | "private";
  /** Explicit flag to indicate update (skips DB lookup for existence) */
  isUpdate?: boolean;
  /**
   * Admin bypass flag - allows updating workflow owned by another user
   * IMPORTANT: Caller MUST verify admin role before setting this flag
   */
  adminBypass?: boolean;
}

/**
 * Result of saving a workflow
 */
export interface SaveWorkflowResult {
  id: string;
  slug: string;
  /** Validation result from mutation service (Issue #463) */
  validation?: ValidationCache;
}

export class WorkflowService {
  private logger = createLogger({ component: Component.Workflow });
  private mutationService?: WorkflowMutationService;

  constructor(
    private workflowRepo: WorkflowRepository,
    private auditRepo: AuditRepository,
    private userRepo?: UserRepository,
  ) {}

  /**
   * Set the mutation service for delegating saves
   * Called by service factory after both services are created
   * Issue #463: Centralized validation caching
   */
  setMutationService(mutationService: WorkflowMutationService): void {
    this.mutationService = mutationService;
  }

  /**
   * List workflows with filters
   */
  async list(filter: WorkflowFilter): Promise<WorkflowListResult> {
    return await this.workflowRepo.listWithFilters(filter);
  }

  /**
   * Get workflow by ID
   */
  async get(
    workflowId: string,
    userId: string,
    includeDeleted = false,
  ): Promise<WorkflowGraph | null> {
    return await this.workflowRepo.get(workflowId, userId, includeDeleted);
  }

  /**
   * Get workflow by slug (for current user's own workflow)
   */
  async getBySlug(
    slug: string,
    userId: string,
    includeDeleted = false,
  ): Promise<WorkflowGraph | null> {
    return await this.workflowRepo.getBySlug(slug, userId, includeDeleted);
  }

  /**
   * Get workflow by global reference (handle/slug)
   * @param reference - Global reference in format "handle/slug"
   * @param currentUserId - Current user for access check
   * @returns Workflow or throws error
   */
  async getByReference(
    reference: string,
    currentUserId: string,
  ): Promise<{ workflow: WorkflowGraph; info: WorkflowInfo }> {
    if (!this.userRepo) {
      throw new Error("UserRepository required for reference resolution");
    }

    const parsed = parseWorkflowReference(reference);
    if (!parsed) {
      throw new InvalidSlugError(
        reference,
        "Invalid workflow reference format (expected handle/slug)",
      );
    }

    // Resolve handle to user ID
    const ownerId = await this.userRepo.resolveHandle(parsed.handle);
    if (!ownerId) {
      throw new UserNotFoundError(parsed.handle, "handle");
    }

    // Resolve slug to workflow ID with access check
    const workflowId = await this.workflowRepo.resolveSlugWithAccess(
      parsed.slug,
      ownerId,
      currentUserId,
    );
    if (!workflowId) {
      throw new WorkflowNotFoundError(`${parsed.handle}/${parsed.slug}`, "reference");
    }

    // Get full workflow info
    const info = await this.workflowRepo.getFullInfo(workflowId, currentUserId);
    if (!info) {
      throw new WorkflowNotFoundError(workflowId, "id");
    }

    return { workflow: info.workflow, info };
  }

  /**
   * Get full workflow info including slug and owner handle
   */
  async getFullInfo(
    workflowId: string | undefined,
    userId: string,
    includeDeleted = false,
  ): Promise<WorkflowInfo | null> {
    return await this.workflowRepo.getFullInfo(workflowId, userId, includeDeleted);
  }

  /**
   * Save workflow with automatic audit and validation caching
   * Now generates UUID and slug automatically for new workflows
   *
   * Issue #463: Delegates to WorkflowMutationService for validation caching
   * while preserving detailed audit logging with change detection
   */
  async save(options: SaveWorkflowOptions): Promise<SaveWorkflowResult> {
    const { graph, userId, slug, visibility = "private", isUpdate, adminBypass } = options;

    // Get existing workflow for change detection (needed for audit)
    const existing =
      isUpdate !== undefined
        ? isUpdate
          ? await this.workflowRepo.get(graph.id, userId, true)
          : null
        : await this.workflowRepo.get(graph.id, userId, true);
    const isCreate = isUpdate !== undefined ? !isUpdate : !existing;

    // Validate slug if provided
    if (slug) {
      const validation = validateSlug(slug);
      if (!validation.valid) {
        throw new InvalidSlugError(slug, validation.error!);
      }

      // Check for collision on create
      if (isCreate) {
        const exists = await this.workflowRepo.slugExists(normalizeSlug(slug), userId);
        if (exists) {
          throw new SlugConflictError(slug, userId);
        }
      }
    }

    // Delegate to mutation service for save with validation caching
    // Skip audit in mutation service - we handle it here with change detection
    if (this.mutationService) {
      const mutationResult = await this.mutationService.save({
        graph,
        userId,
        slug,
        visibility,
        adminBypass,
        skipAudit: true, // We handle audit here with change detection
      });

      // Perform detailed audit logging
      await this.auditSave(
        graph,
        userId,
        mutationResult.id,
        mutationResult.slug,
        visibility,
        isCreate,
        existing,
      );

      return {
        id: mutationResult.id,
        slug: mutationResult.slug,
        validation: mutationResult.validation,
      };
    }

    // Fallback: direct repository save (for backward compatibility during transition)
    this.logger.warn("WorkflowMutationService not set, using direct repository save");
    const result = await this.workflowRepo.save({
      graph,
      userId,
      slug,
      visibility,
      adminBypass,
    });

    // Perform detailed audit logging
    await this.auditSave(graph, userId, result.id, result.slug, visibility, isCreate, existing);

    return result;
  }

  /**
   * Internal helper for audit logging with change detection
   */
  private async auditSave(
    graph: WorkflowGraph,
    userId: string,
    workflowId: string,
    resultSlug: string,
    visibility: "public" | "private",
    isCreate: boolean,
    existing: WorkflowGraph | null,
  ): Promise<void> {
    const source = getAuditSource();

    if (isCreate) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_CREATE,
        resource: "workflow",
        resourceId: workflowId,
        source,
        metadata: JSON.stringify({
          name: graph.metadata.name,
          version: graph.metadata.version,
          slug: resultSlug,
          visibility,
          nodeCount: graph.nodes?.length || 0,
        }),
      });
      this.logger.info("Workflow created", {
        workflowId,
        slug: resultSlug,
        userId,
      });
    } else {
      // Compute changes for update
      const changes = existing
        ? computeChanges(
            {
              name: existing.metadata.name,
              version: existing.metadata.version,
              description: existing.metadata.description,
              nodeCount: existing.nodes?.length || 0,
            },
            {
              name: graph.metadata.name,
              version: graph.metadata.version,
              description: graph.metadata.description,
              nodeCount: graph.nodes?.length || 0,
            },
          )
        : [];

      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_EDIT,
        resource: "workflow",
        resourceId: workflowId,
        source,
        metadata: JSON.stringify({
          name: graph.metadata.name,
          version: graph.metadata.version,
          slug: resultSlug,
          visibility,
        }),
        changes: changes.length > 0 ? JSON.stringify(changes) : undefined,
      });
      this.logger.info("Workflow updated", {
        workflowId,
        slug: resultSlug,
        userId,
        changes: changes.length,
      });
    }
  }

  /**
   * Resolve a slug to find a public workflow (any owner)
   * Used for admin override to find existing public workflow by slug
   */
  async resolvePublicSlug(
    slug: string,
  ): Promise<{ id: string; userId: string; ownerHandle: string | null } | null> {
    return await this.workflowRepo.resolvePublicSlug(slug);
  }

  /**
   * Update workflow slug with audit
   */
  async updateSlug(workflowId: string, userId: string, newSlug: string): Promise<boolean> {
    // Validate slug format
    const validation = validateSlug(newSlug);
    if (!validation.valid) {
      throw new InvalidSlugError(newSlug, validation.error!);
    }

    // Get current workflow for audit
    const info = await this.workflowRepo.getFullInfo(workflowId, userId);
    if (!info) {
      throw new WorkflowNotFoundError(workflowId, "id");
    }

    const oldSlug = info.slug;
    const normalizedSlug = normalizeSlug(newSlug);

    // Check if slug actually changed
    if (oldSlug === normalizedSlug) {
      return true; // No change needed
    }

    // Check for collision
    const exists = await this.workflowRepo.slugExists(normalizedSlug, userId, workflowId);
    if (exists) {
      throw new SlugConflictError(normalizedSlug, userId);
    }

    // Update slug
    const success = await this.workflowRepo.updateSlug(workflowId, userId, normalizedSlug);

    if (success) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_EDIT,
        resource: "workflow",
        resourceId: workflowId,
        source: getAuditSource(),
        metadata: JSON.stringify({
          name: info.metadata.name,
          version: info.metadata.version,
        }),
        changes: JSON.stringify([
          {
            field: "slug",
            oldValue: oldSlug,
            newValue: normalizedSlug,
          },
        ]),
      });
      this.logger.info("Workflow slug updated", {
        workflowId,
        userId,
        oldSlug,
        newSlug: normalizedSlug,
      });
    }

    return success;
  }

  /**
   * Soft delete workflow with audit
   */
  async softDelete(workflowId: string, userId: string): Promise<boolean> {
    // Get workflow info before delete
    const existing = await this.workflowRepo.get(workflowId, userId);
    if (!existing) {
      return false;
    }

    const success = await this.workflowRepo.softDelete(workflowId, userId);

    if (success) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_DELETE,
        resource: "workflow",
        resourceId: workflowId,
        source: getAuditSource(),
        metadata: JSON.stringify({
          name: existing.metadata.name,
          version: existing.metadata.version,
        }),
      });
      this.logger.info("Workflow soft deleted", { workflowId, userId });
    }

    return success;
  }

  /**
   * Restore soft-deleted workflow with audit
   */
  async restore(workflowId: string, userId: string): Promise<boolean> {
    const success = await this.workflowRepo.restore(workflowId, userId);

    if (success) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_RESTORE,
        resource: "workflow",
        resourceId: workflowId,
        source: getAuditSource(),
      });
      this.logger.info("Workflow restored", { workflowId, userId });
    }

    return success;
  }

  /**
   * List deleted workflows
   */
  async listDeleted(userId: string): Promise<WorkflowInfo[]> {
    return await this.workflowRepo.listDeleted(userId);
  }

  /**
   * Hard delete workflow (permanent)
   */
  async hardDelete(workflowId: string, userId: string): Promise<void> {
    const existing = await this.workflowRepo.get(workflowId, userId, true);

    await this.workflowRepo.delete(workflowId, userId);

    if (existing) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_HARD_DELETE,
        resource: "workflow",
        resourceId: workflowId,
        source: getAuditSource(),
        metadata: JSON.stringify({
          name: existing.metadata.name,
          version: existing.metadata.version,
        }),
      });
      this.logger.info("Workflow permanently deleted", { workflowId, userId });
    }
  }

  /**
   * Update workflow visibility with audit
   */
  async updateVisibility(
    workflowId: string,
    userId: string,
    visibility: "public" | "private",
  ): Promise<boolean> {
    // Get current workflow for audit
    const existing = await this.workflowRepo.get(workflowId, userId);
    if (!existing) {
      return false;
    }

    // Get current visibility for change detection
    const ownership = await this.workflowRepo.getOwnership(workflowId);
    const oldVisibility = ownership.visibility;

    // Update visibility
    const success = await this.workflowRepo.updateVisibility(workflowId, userId, visibility);

    if (success && oldVisibility !== visibility) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.WORKFLOW_EDIT,
        resource: "workflow",
        resourceId: workflowId,
        source: getAuditSource(),
        metadata: JSON.stringify({
          name: existing.metadata.name,
          version: existing.metadata.version,
        }),
        changes: JSON.stringify([
          {
            field: "visibility",
            oldValue: oldVisibility,
            newValue: visibility,
          },
        ]),
      });
      this.logger.info("Workflow visibility updated", {
        workflowId,
        userId,
        oldVisibility,
        newVisibility: visibility,
      });
    }

    return success;
  }
}
