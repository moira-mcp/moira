/**
 * Workflow Sharing Service - Business logic for workflow invite links and access
 * Wraps WorkflowSharingRepository with validation, ownership checks, and audit logging
 *
 * Key concepts:
 * - Invites: One-time tokens with 7-day expiration for sharing workflows
 * - Access: Granted permissions allowing view/start/copy (not edit)
 * - Only workflow owner can create invites and revoke access
 */

import type { AuditRepository } from "../database/repositories/audit-repository.js";
import type { WorkflowRepository } from "../database/repositories/workflow-repository.js";
import {
  WorkflowSharingRepository,
  DEFAULT_INVITE_TTL_MS,
  type InviteInfo,
  type AccessInfo,
  type InviteFilter,
  type AccessFilter,
  type InviteListResult,
  type AccessListResult,
} from "../database/repositories/workflow-sharing-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import {
  WorkflowNotFoundError,
  WorkflowAccessDeniedError,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
  AccessNotFoundError,
} from "../errors/domain-errors.js";

// Re-export domain errors for backward compatibility
export {
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
  AccessNotFoundError,
};

// Re-export types from repository
export type { InviteInfo, AccessInfo, InviteListResult, AccessListResult };

// ===== Service Options =====
// Note: These have different signatures from repository options (include ownership context)

export interface ServiceCreateInviteOptions {
  workflowId: string;
  userId: string; // The user creating the invite (must be owner)
  ttlMs?: number;
}

export interface ServiceAcceptInviteOptions {
  token: string;
  userId: string; // The user accepting the invite
}

export interface RevokeAccessOptions {
  workflowId: string;
  targetUserId: string; // The user whose access is being revoked
  userId: string; // The user performing the revoke (must be owner)
}

export interface RevokeInviteOptions {
  inviteId: string;
  userId: string; // The user performing the revoke (must be owner)
}

export interface ListAccessOptions {
  workflowId: string;
  userId: string; // The user requesting the list (must be owner)
  limit?: number;
  offset?: number;
}

export interface ListInvitesOptions {
  workflowId: string;
  userId: string; // The user requesting the list (must be owner)
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

// ===== Result Types =====
// Note: Service results include additional context compared to repository

export interface ServiceCreateInviteResult {
  invite: InviteInfo;
  inviteUrl: string;
}

export interface ServiceAcceptInviteResult {
  accessId: string;
  workflowId: string;
  /** Owner's handle for constructing redirect URL */
  ownerHandle: string;
  /** Workflow slug for constructing redirect URL */
  slug: string;
}

// ===== Service Class =====

export class WorkflowSharingService {
  private logger = createLogger({ component: "WorkflowSharingService" });

  constructor(
    private sharingRepo: WorkflowSharingRepository,
    private workflowRepo: WorkflowRepository,
    private auditRepo: AuditRepository,
    private baseUrl?: string, // For generating invite URLs
  ) {}

  // ===== Invite Operations =====

  /**
   * Create an invite link for a workflow
   * @throws WorkflowNotFoundError if workflow doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the owner
   */
  async createInvite(options: ServiceCreateInviteOptions): Promise<ServiceCreateInviteResult> {
    const { workflowId, userId, ttlMs = DEFAULT_INVITE_TTL_MS } = options;

    this.logger.debug("createInvite() called", { workflowId, userId, ttlMs });

    // Verify workflow exists and user is owner
    await this.verifyOwnership(workflowId, userId);

    // Create invite
    const invite = await this.sharingRepo.createInvite({
      workflowId,
      createdBy: userId,
      ttlMs,
    });

    // Generate invite URL
    const inviteUrl = this.generateInviteUrl(invite.token);

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.SHARING_INVITE_CREATE,
      resource: "workflow",
      resourceId: workflowId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        inviteId: invite.id,
        expiresAt: invite.expiresAt,
        ttlMs,
      }),
    });

    this.logger.info("Invite created", {
      userId,
      workflowId,
      inviteId: invite.id,
      expiresAt: new Date(invite.expiresAt).toISOString(),
    });

    return { invite, inviteUrl };
  }

  /**
   * Accept an invite and gain access to the workflow
   * @throws InviteNotFoundError if invite doesn't exist
   * @throws InviteExpiredError if invite has expired
   * @throws InviteAlreadyUsedError if invite was already used
   * @throws SelfInviteError if user is the workflow owner
   * @throws AccessAlreadyExistsError if user already has access
   */
  async acceptInvite(options: ServiceAcceptInviteOptions): Promise<ServiceAcceptInviteResult> {
    const { token, userId } = options;

    this.logger.debug("acceptInvite() called", { tokenPrefix: token.slice(0, 8), userId });

    // Get invite to validate
    const invite = await this.sharingRepo.getInviteByToken(token);
    if (!invite) {
      throw new InviteNotFoundError(token, "token");
    }

    // Check if already used
    if (invite.usedAt !== null) {
      throw new InviteAlreadyUsedError(token);
    }

    // Check if expired
    const now = Date.now();
    if (invite.expiresAt < now) {
      throw new InviteExpiredError(token);
    }

    // Check if user is the owner (can't accept own invite)
    if (invite.createdBy === userId) {
      throw new SelfInviteError();
    }

    // Check if user already has access
    const hasAccess = await this.sharingRepo.hasAccess(invite.workflowId, userId);
    if (hasAccess) {
      throw new AccessAlreadyExistsError(invite.workflowId, userId);
    }

    // Accept invite (this does validation too, but we want better error messages)
    const result = await this.sharingRepo.acceptInvite({ token, userId });
    if (!result) {
      // This should not happen given our pre-checks, but handle gracefully
      throw new InviteNotFoundError(token, "token");
    }

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.SHARING_INVITE_ACCEPT,
      resource: "workflow",
      resourceId: invite.workflowId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        inviteId: invite.id,
        accessId: result.accessId,
        grantedBy: invite.createdBy,
      }),
    });

    // Get workflow ownership info for redirect URL
    const ownership = await this.workflowRepo.getOwnership(invite.workflowId);
    if (!ownership.exists || !ownership.ownerHandle || !ownership.slug) {
      // This should not happen - workflow should exist for valid invite
      throw new WorkflowNotFoundError(invite.workflowId, "id");
    }

    this.logger.info("Invite accepted", {
      userId,
      workflowId: invite.workflowId,
      inviteId: invite.id,
      accessId: result.accessId,
      ownerHandle: ownership.ownerHandle,
      slug: ownership.slug,
    });

    return {
      accessId: result.accessId,
      workflowId: invite.workflowId,
      ownerHandle: ownership.ownerHandle,
      slug: ownership.slug,
    };
  }

  /**
   * Revoke an invite (delete it)
   * @throws InviteNotFoundError if invite doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the workflow owner
   */
  async revokeInvite(options: RevokeInviteOptions): Promise<void> {
    const { inviteId, userId } = options;

    this.logger.debug("revokeInvite() called", { inviteId, userId });

    // Get invite to find workflow
    const invite = await this.sharingRepo.getInviteById(inviteId);
    if (!invite) {
      throw new InviteNotFoundError(inviteId, "id");
    }

    // Verify user is owner
    await this.verifyOwnership(invite.workflowId, userId);

    // Delete invite
    const deleted = await this.sharingRepo.deleteInvite(inviteId);
    if (!deleted) {
      throw new InviteNotFoundError(inviteId, "id");
    }

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.SHARING_INVITE_REVOKE,
      resource: "workflow",
      resourceId: invite.workflowId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        inviteId,
        wasUsed: invite.usedAt !== null,
        usedBy: invite.usedBy,
      }),
    });

    this.logger.info("Invite revoked", {
      userId,
      workflowId: invite.workflowId,
      inviteId,
    });
  }

  /**
   * List invites for a workflow
   * @throws WorkflowNotFoundError if workflow doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the owner
   */
  async listInvites(options: ListInvitesOptions): Promise<InviteListResult> {
    const { workflowId, userId, activeOnly = true, limit = 50, offset = 0 } = options;

    // Verify ownership
    await this.verifyOwnership(workflowId, userId);

    // List invites
    const filter: InviteFilter = {
      workflowId,
      activeOnly,
      limit,
      offset,
    };

    return await this.sharingRepo.listInvites(filter);
  }

  // ===== Access Operations =====

  /**
   * Revoke a user's access to a workflow
   * @throws WorkflowNotFoundError if workflow doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the owner
   * @throws AccessNotFoundError if target user doesn't have access
   */
  async revokeAccess(options: RevokeAccessOptions): Promise<void> {
    const { workflowId, targetUserId, userId } = options;

    this.logger.debug("revokeAccess() called", { workflowId, targetUserId, userId });

    // Verify user is owner
    await this.verifyOwnership(workflowId, userId);

    // Revoke access
    const revoked = await this.sharingRepo.revokeAccess(workflowId, targetUserId);
    if (!revoked) {
      throw new AccessNotFoundError(workflowId, targetUserId);
    }

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.SHARING_ACCESS_REVOKE,
      resource: "workflow",
      resourceId: workflowId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        targetUserId,
      }),
    });

    this.logger.info("Access revoked", {
      userId,
      workflowId,
      targetUserId,
    });
  }

  /**
   * List users with access to a workflow
   * @throws WorkflowNotFoundError if workflow doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the owner
   */
  async listAccess(options: ListAccessOptions): Promise<AccessListResult> {
    const { workflowId, userId, limit = 50, offset = 0 } = options;

    // Verify ownership
    await this.verifyOwnership(workflowId, userId);

    // List access
    const filter: AccessFilter = {
      workflowId,
      limit,
      offset,
    };

    return await this.sharingRepo.listAccess(filter);
  }

  /**
   * Check if a user has shared access to a workflow
   * This is a read-only operation, no ownership check required
   */
  async hasAccess(workflowId: string, userId: string): Promise<boolean> {
    return await this.sharingRepo.hasAccess(workflowId, userId);
  }

  /**
   * List all workflows a user has shared access to
   */
  async listSharedWorkflows(userId: string): Promise<string[]> {
    return await this.sharingRepo.listUserAccess(userId);
  }

  /**
   * Get public invite info by token (for invite landing page)
   * Returns null if invite not found
   */
  async getInviteInfo(token: string): Promise<{
    isValid: boolean;
    isExpired: boolean;
    isUsed: boolean;
    workflowName: string;
    createdByHandle: string | null;
    expiresAt: number;
    remainingMs: number;
  } | null> {
    const invite = await this.sharingRepo.getInviteByToken(token);
    if (!invite) {
      return null;
    }

    const now = Date.now();
    const isExpired = invite.expiresAt < now;
    const isUsed = invite.usedAt !== null;
    const isValid = !isExpired && !isUsed;

    // Get workflow name from ownership info
    const ownership = await this.workflowRepo.getOwnership(invite.workflowId);
    const workflowName = ownership.exists
      ? ownership.name || "Shared Workflow"
      : "Unknown Workflow";

    return {
      isValid,
      isExpired,
      isUsed,
      workflowName,
      createdByHandle: invite.createdByHandle || null,
      expiresAt: invite.expiresAt,
      remainingMs: Math.max(0, invite.expiresAt - now),
    };
  }

  // ===== Maintenance Operations =====

  /**
   * Clean up expired invites
   * Returns number of deleted invites
   */
  async cleanupExpiredInvites(): Promise<number> {
    return await this.sharingRepo.deleteExpiredInvites();
  }

  // ===== Helper Methods =====

  /**
   * Verify that user owns the workflow
   * @throws WorkflowNotFoundError if workflow doesn't exist
   * @throws WorkflowAccessDeniedError if user is not the owner
   */
  private async verifyOwnership(workflowId: string, userId: string): Promise<void> {
    // Use getOwnership which checks without access filters
    const ownership = await this.workflowRepo.getOwnership(workflowId);

    if (!ownership.exists) {
      throw new WorkflowNotFoundError(workflowId, "id");
    }

    if (ownership.ownerId !== userId) {
      throw new WorkflowAccessDeniedError(workflowId, userId, "write");
    }
  }

  /**
   * Generate full invite URL
   */
  private generateInviteUrl(token: string): string {
    const base = this.baseUrl || "https://moira.ai";
    return `${base}/invites/${token}`;
  }
}
