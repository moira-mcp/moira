import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AuditAction } from "../../audit/actions.js";
import { getAuditSource } from "../../logging/context.js";

export interface AccountApprovalTransitionResult {
  status: "approved" | "already-approved" | "not-found";
  approvedAt: string | null;
}

/**
 * Owns the atomic persistence boundary for account approval. Keeping the
 * conditional transition and audit insert in one repository transaction makes
 * duplicate concurrent approvals observable as one state change and one event.
 */
export class AccountApprovalRepository {
  constructor(private sqlite: Database.Database) {}

  approve(adminUserId: string, targetUserId: string): AccountApprovalTransitionResult {
    const approveInTransaction = this.sqlite.transaction((): AccountApprovalTransitionResult => {
      const existing = this.sqlite
        .prepare("SELECT approvedAt FROM user WHERE id = ?")
        .get(targetUserId) as { approvedAt: string | null } | undefined;

      if (!existing) {
        return { status: "not-found", approvedAt: null };
      }

      if (existing.approvedAt) {
        return { status: "already-approved", approvedAt: existing.approvedAt };
      }

      const approvedAt = new Date().toISOString();
      const transition = this.sqlite
        .prepare(
          "UPDATE user SET approvedAt = ?, updatedAt = ? WHERE id = ? AND approvedAt IS NULL",
        )
        .run(approvedAt, approvedAt, targetUserId);

      if (transition.changes === 1) {
        this.sqlite
          .prepare(
            `INSERT INTO auditLog
              (id, userId, action, resource, resourceId, source, changes, createdAt)
             VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            adminUserId,
            AuditAction.ADMIN_APPROVE_USER,
            targetUserId,
            getAuditSource(),
            JSON.stringify([{ field: "approvedAt", oldValue: null, newValue: approvedAt }]),
            Date.now(),
          );
        return { status: "approved", approvedAt };
      }

      const current = this.sqlite
        .prepare("SELECT approvedAt FROM user WHERE id = ?")
        .get(targetUserId) as { approvedAt: string | null } | undefined;
      return current
        ? { status: "already-approved", approvedAt: current.approvedAt }
        : { status: "not-found", approvedAt: null };
    });

    return approveInTransaction();
  }
}
