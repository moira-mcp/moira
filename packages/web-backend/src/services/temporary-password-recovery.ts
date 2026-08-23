import {
  account,
  apiToken,
  auditLog,
  AuditAction,
  getDatabase,
  oauthAccessToken,
  oauthConsent,
  session,
  user,
  type AuditRequestContext,
} from "@mcp-moira/shared";
import { hashPassword } from "better-auth/crypto";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export type TemporaryPasswordRecoveryErrorCode = "TARGET_NOT_FOUND" | "TARGET_NOT_ORDINARY";

export class TemporaryPasswordRecoveryError extends Error {
  constructor(
    readonly code: TemporaryPasswordRecoveryErrorCode,
    readonly userId: string,
    message: string,
  ) {
    super(message);
    this.name = "TemporaryPasswordRecoveryError";
  }
}

interface TemporaryPasswordRecoveryInput {
  userId: string;
  requestedBy: string;
  temporaryPassword: string;
  audit: AuditRequestContext;
}

interface TemporaryPasswordRecoveryDependencies {
  database?: ReturnType<typeof getDatabase>;
  hash?: typeof hashPassword;
  now?: () => string;
}

export async function recoverOrdinaryUserWithTemporaryPassword(
  input: TemporaryPasswordRecoveryInput,
  dependencies: TemporaryPasswordRecoveryDependencies = {},
) {
  const db = dependencies.database ?? getDatabase();
  const password = await (dependencies.hash ?? hashPassword)(input.temporaryPassword);
  const now = (dependencies.now ?? (() => new Date().toISOString()))();

  const recovery = db.transaction(
    (tx) => {
      const userData = tx.select().from(user).where(eq(user.id, input.userId)).limit(1).get();
      if (!userData) {
        throw new TemporaryPasswordRecoveryError(
          "TARGET_NOT_FOUND",
          input.userId,
          `User not found: ${input.userId}`,
        );
      }
      if (userData.isAdmin) {
        throw new TemporaryPasswordRecoveryError(
          "TARGET_NOT_ORDINARY",
          input.userId,
          "Temporary-password recovery is limited to non-admin users",
        );
      }

      const sessionsBefore = tx
        .select()
        .from(session)
        .where(eq(session.userId, input.userId))
        .all();
      const tokensBefore = tx
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.userId, input.userId))
        .all();
      const consentsBefore = tx
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.userId, input.userId))
        .all();
      const apiTokensBefore = tx
        .select()
        .from(apiToken)
        .where(and(eq(apiToken.userId, input.userId), isNull(apiToken.revokedAt)))
        .all();
      const accountsBefore = tx
        .select()
        .from(account)
        .where(eq(account.userId, input.userId))
        .all();
      const credential = accountsBefore.find((entry) => entry.providerId === "credential");

      if (credential) {
        tx.update(account)
          .set({ password, updatedAt: now })
          .where(and(eq(account.id, credential.id), eq(account.userId, input.userId)))
          .run();
      } else {
        tx.insert(account)
          .values({
            id: randomUUID(),
            accountId: input.userId,
            providerId: "credential",
            userId: input.userId,
            password,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      tx.update(account)
        .set({
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(account.userId, input.userId))
        .run();
      tx.delete(session).where(eq(session.userId, input.userId)).run();
      tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, input.userId)).run();
      tx.delete(oauthConsent).where(eq(oauthConsent.userId, input.userId)).run();
      tx.update(apiToken)
        .set({ revokedAt: now })
        .where(and(eq(apiToken.userId, input.userId), isNull(apiToken.revokedAt)))
        .run();
      const userUpdate = tx
        .update(user)
        .set({
          passwordResetRequired: true,
          passwordResetRequestedAt: now,
          passwordResetRequestedBy: input.requestedBy,
          updatedAt: now,
        })
        .where(and(eq(user.id, input.userId), eq(user.isAdmin, false)))
        .run();
      if (userUpdate.changes !== 1) {
        throw new TemporaryPasswordRecoveryError(
          "TARGET_NOT_ORDINARY",
          input.userId,
          "Temporary-password recovery is limited to non-admin users",
        );
      }

      tx.insert(auditLog)
        .values({
          id: randomUUID(),
          userId: input.requestedBy,
          action: AuditAction.ADMIN_FORCE_PASSWORD_RESET,
          resource: "user",
          resourceId: input.userId,
          source: input.audit.source ?? null,
          ip: input.audit.ip ?? null,
          country: input.audit.country ?? null,
          userAgent: input.audit.userAgent ?? null,
          metadata: JSON.stringify({
            recoveryMethod: "temporary-password",
            targetEmail: userData.email,
            targetUserId: input.userId,
            sessionsRevoked: sessionsBefore.length,
            oauthTokensRevoked: tokensBefore.length,
            oauthConsentsRevoked: consentsBefore.length,
            apiTokensRevoked: apiTokensBefore.length,
            linkedAccountCredentialsCleared: accountsBefore.filter(
              (entry) =>
                entry.providerId !== "credential" &&
                (entry.accessToken || entry.refreshToken || entry.idToken),
            ).length,
          }),
          createdAt: new Date(now),
        })
        .run();

      return {
        userData,
        sessionsRevoked: sessionsBefore.length,
        oauthTokensRevoked: tokensBefore.length,
        oauthConsentsRevoked: consentsBefore.length,
        apiTokensRevoked: apiTokensBefore.length,
        linkedAccountCredentialsCleared: accountsBefore.filter(
          (entry) =>
            entry.providerId !== "credential" &&
            (entry.accessToken || entry.refreshToken || entry.idToken),
        ).length,
      };
    },
    { behavior: "immediate" },
  );

  return { ...recovery, now };
}
