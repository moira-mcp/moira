/**
 * User Service - Business logic with automatic audit
 * Centralized user operations with audit trail
 *
 * Key concepts:
 * - handle: Globally unique user identifier
 * - Handle changes are audited
 */

import type {
  UserRepository,
  UserProfile,
  UserSession,
  SessionFilter,
  SessionListResult,
  OAuthConsentFilter,
  OAuthConsentListResult,
} from "../database/repositories/user-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import {
  HandleConflictError,
  InvalidHandleError,
  UserNotFoundError,
} from "../errors/domain-errors.js";
import { validateHandle, normalizeHandle } from "../validation/slug-handle.js";

export class UserService {
  private logger = createLogger({ component: Component.Auth });

  constructor(
    private userRepo: UserRepository,
    private auditRepo: AuditRepository,
  ) {}

  /**
   * Get user profile (now includes handle)
   */
  async getProfile(userId: string): Promise<UserProfile | null> {
    return await this.userRepo.getProfile(userId);
  }

  /**
   * Get user's current handle
   */
  async getHandle(userId: string): Promise<string | null> {
    return await this.userRepo.getHandle(userId);
  }

  /**
   * Get the user IDs of all (non-blocked) administrators. Used to fan out admin
   * notifications such as artifact abuse reports.
   */
  async getAdminUserIds(): Promise<string[]> {
    return await this.userRepo.getAdminUserIds();
  }

  /**
   * Update user handle with validation and audit
   * @throws HandleConflictError if handle is already taken
   * @throws InvalidHandleError if handle format is invalid
   */
  async updateHandle(userId: string, newHandle: string): Promise<boolean> {
    // Validate handle format
    const validation = validateHandle(newHandle);
    if (!validation.valid) {
      throw new InvalidHandleError(newHandle, validation.error!);
    }

    const normalizedHandle = normalizeHandle(newHandle);

    // Get current handle for audit
    const oldHandle = await this.userRepo.getHandle(userId);
    if (oldHandle === null) {
      throw new UserNotFoundError(userId, "id");
    }

    // Check if handle actually changed
    if (oldHandle === normalizedHandle) {
      return true; // No change needed
    }

    // Check if new handle is already taken
    const exists = await this.userRepo.handleExists(normalizedHandle, userId);
    if (exists) {
      throw new HandleConflictError(normalizedHandle);
    }

    // Update handle
    const success = await this.userRepo.updateHandle(userId, normalizedHandle);

    if (success) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.USER_PROFILE_UPDATE,
        resource: "user",
        resourceId: userId,
        source: getAuditSource(),
        changes: JSON.stringify([
          {
            field: "handle",
            oldValue: oldHandle,
            newValue: normalizedHandle,
          },
        ]),
      });

      this.logger.info("User handle updated", {
        userId,
        oldHandle,
        newHandle: normalizedHandle,
      });
    }

    return success;
  }

  /**
   * Update user profile with audit
   */
  async updateProfile(userId: string, updates: { name?: string | null }): Promise<void> {
    // Get old values for audit
    const oldProfile = await this.userRepo.getProfile(userId);
    if (!oldProfile) {
      throw new UserNotFoundError(userId, "id");
    }

    // Build changes array
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    if (updates.name !== undefined && updates.name !== oldProfile.name) {
      changes.push({
        field: "name",
        oldValue: oldProfile.name,
        newValue: updates.name,
      });
    }

    // Update user via repository
    await this.userRepo.updateProfile(userId, updates);

    // Log audit if changes were made
    if (changes.length > 0) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.USER_PROFILE_UPDATE,
        resource: "user",
        resourceId: userId,
        source: getAuditSource(),
        changes: JSON.stringify(changes),
      });

      this.logger.info("User profile updated", { userId, changes: changes.map((c) => c.field) });
    }
  }

  /**
   * Get user sessions with current session indicator
   */
  async getSessions(
    userId: string,
    currentToken?: string,
  ): Promise<Array<UserSession & { isCurrent: boolean }>> {
    const sessions = await this.userRepo.getSessions(userId);
    const now = new Date();

    return sessions
      .filter((s) => new Date(s.expiresAt) > now)
      .map((s) => ({
        ...s,
        isCurrent: s.token === currentToken,
      }));
  }

  /**
   * List sessions with server-side pagination and filters
   */
  async listSessionsWithFilters(filter: SessionFilter): Promise<SessionListResult> {
    return await this.userRepo.listSessionsWithFilters(filter);
  }

  /**
   * Revoke session with audit
   */
  async revokeSession(
    userId: string,
    sessionId: string,
    currentToken?: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Verify session belongs to user
    const targetSession = await this.userRepo.getSessionById(sessionId, userId);

    if (!targetSession) {
      return { success: false, error: "Session not found or does not belong to user" };
    }

    // Prevent revoking current session
    if (currentToken && targetSession.token === currentToken) {
      return { success: false, error: "Cannot revoke current session" };
    }

    // Delete session via repository
    await this.userRepo.deleteSession(sessionId);

    // Log audit
    await this.auditRepo.log({
      userId,
      action: AuditAction.USER_REVOKE_SESSION,
      resource: "session",
      resourceId: sessionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        ipAddress: targetSession.ipAddress,
        userAgent: targetSession.userAgent,
      }),
    });

    this.logger.info("Session revoked", { userId, sessionId });
    return { success: true };
  }

  /**
   * Revoke all sessions except current with audit
   */
  async revokeAllSessions(
    userId: string,
    currentToken?: string,
  ): Promise<{ revokedCount: number }> {
    const revokedCount = await this.userRepo.deleteAllSessionsExcept(userId, currentToken);

    // Log audit if any sessions revoked
    if (revokedCount > 0) {
      await this.auditRepo.log({
        userId,
        action: AuditAction.USER_REVOKE_SESSION,
        resource: "session",
        resourceId: "all",
        source: getAuditSource(),
        metadata: JSON.stringify({
          revokedCount,
          excludedCurrent: !!currentToken,
        }),
      });

      this.logger.info("All sessions revoked", {
        userId,
        revokedCount,
        excludedCurrent: !!currentToken,
      });
    }

    return { revokedCount };
  }

  /**
   * Get user OAuth consents
   */
  async getOAuthConsents(userId: string) {
    return await this.userRepo.getOAuthConsents(userId);
  }

  /**
   * List OAuth consents with server-side pagination and filters
   */
  async listOAuthConsentsWithFilters(filter: OAuthConsentFilter): Promise<OAuthConsentListResult> {
    return await this.userRepo.listOAuthConsentsWithFilters(filter);
  }

  /**
   * Revoke OAuth consent with audit
   */
  async revokeOAuthConsent(
    userId: string,
    consentId: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Verify consent belongs to user
    const consent = await this.userRepo.getOAuthConsentById(consentId, userId);

    if (!consent) {
      return { success: false, error: "Consent not found or does not belong to user" };
    }

    // Delete consent via repository
    await this.userRepo.deleteOAuthConsent(consentId);

    // Also revoke access tokens for this client
    await this.userRepo.deleteOAuthTokensForClient(userId, consent.clientId);

    // Log audit
    await this.auditRepo.log({
      userId,
      action: AuditAction.USER_REVOKE_OAUTH_CONSENT,
      resource: "oauth_consent",
      resourceId: consentId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        clientId: consent.clientId,
        scopes: consent.scopes,
      }),
    });

    this.logger.info("OAuth consent revoked", { userId, consentId, clientId: consent.clientId });
    return { success: true };
  }

  /**
   * Revoke all OAuth tokens for user (used after password change)
   */
  async revokeAllOAuthTokens(userId: string): Promise<{ revokedCount: number }> {
    const revokedCount = await this.userRepo.deleteAllOAuthTokens(userId);

    this.logger.info("All OAuth tokens revoked", { userId, revokedCount });
    return { revokedCount };
  }
}
