import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getSqliteInstance } from "../database/connection.js";
import type {
  WorkspaceConnectionErrorCode,
  WorkspaceConnectionSnapshot,
  WorkspaceConnectionStatus,
  WorkspaceCredentialEnvelope,
  WorkspaceInstallationGrant,
  WorkspaceRepositoryGrant,
} from "./types.js";

interface ConnectionRow {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: WorkspaceConnectionStatus;
  credentialGeneration: number;
  lastErrorCode: WorkspaceConnectionErrorCode | null;
}

interface VaultRow {
  envelopeVersion: number;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  generation: number;
}

export interface StoredWorkspaceCredential {
  connection: ConnectionRow;
  envelope: WorkspaceCredentialEnvelope;
}

export interface StoredWorkspaceRevocation {
  id: string;
  userId: string;
  provider: string;
  envelope: WorkspaceCredentialEnvelope;
}

export interface ConnectedWorkspaceInput {
  connectionId: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: "connected" | "installation_required";
  envelope: WorkspaceCredentialEnvelope;
  installations: WorkspaceInstallationGrant[];
  repositories: WorkspaceRepositoryGrant[];
  now: number;
}

export function digestWorkspaceAuthorizationValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class WorkspaceConnectionRepository {
  constructor(private readonly sqlite: Database.Database = getSqliteInstance()) {}

  storeAuthorizationState(input: {
    stateHash: string;
    userId: string;
    sessionTokenHash: string;
    provider: string;
    redirectPath: string;
    expiresAt: number;
    now: number;
  }): void {
    const tx = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `DELETE FROM workspaceAuthorizationState
           WHERE userId = ? AND provider = ? AND consumedAt IS NULL`,
        )
        .run(input.userId, input.provider);
      this.sqlite
        .prepare(
          `DELETE FROM workspaceAuthorizationState
           WHERE expiresAt < ? OR (consumedAt IS NOT NULL AND consumedAt < ?)`,
        )
        .run(input.now, input.now - 24 * 60 * 60 * 1000);
      this.sqlite
        .prepare(
          `INSERT INTO workspaceAuthorizationState
             (stateHash, userId, sessionTokenHash, provider, redirectPath, expiresAt, consumedAt, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          input.stateHash,
          input.userId,
          input.sessionTokenHash,
          input.provider,
          input.redirectPath,
          input.expiresAt,
          input.now,
        );
    });
    tx();
  }

  consumeAuthorizationState(input: {
    stateHash: string;
    userId: string;
    sessionTokenHash: string;
    provider: string;
    now: number;
  }): { redirectPath: string } | null {
    const tx = this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare(
          `SELECT redirectPath FROM workspaceAuthorizationState
           WHERE stateHash = ? AND userId = ? AND sessionTokenHash = ? AND provider = ?
             AND consumedAt IS NULL AND expiresAt >= ?`,
        )
        .get(input.stateHash, input.userId, input.sessionTokenHash, input.provider, input.now) as
        { redirectPath: string } | undefined;
      if (!row) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE workspaceAuthorizationState SET consumedAt = ?
           WHERE stateHash = ? AND consumedAt IS NULL`,
        )
        .run(input.now, input.stateHash);
      return result.changes === 1 ? row : null;
    });
    return tx();
  }

  reserveConnection(input: {
    userId: string;
    provider: string;
    externalAccountId: string;
    externalLogin: string;
    now: number;
  }): string {
    const tx = this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare("SELECT id FROM workspaceConnection WHERE userId = ? AND provider = ?")
        .get(input.userId, input.provider) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.sqlite
          .prepare(
            `UPDATE workspaceConnection
             SET externalAccountId = ?, externalLogin = ?, status = 'connecting',
                 lastErrorCode = NULL, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND userId = ? AND provider = ?`,
          )
          .run(
            input.externalAccountId,
            input.externalLogin,
            input.now,
            id,
            input.userId,
            input.provider,
          );
      } else {
        this.sqlite
          .prepare(
            `INSERT INTO workspaceConnection
             (id, userId, provider, externalAccountId, externalLogin, status,
              credentialGeneration, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, 'connecting', 1, ?, ?)`,
          )
          .run(
            id,
            input.userId,
            input.provider,
            input.externalAccountId,
            input.externalLogin,
            input.now,
            input.now,
          );
      }
      return id;
    });
    return tx();
  }

  completeConnection(input: ConnectedWorkspaceInput): void {
    const tx = this.sqlite.transaction(() => {
      const owned = this.sqlite
        .prepare("SELECT id FROM workspaceConnection WHERE id = ? AND userId = ? AND provider = ?")
        .get(input.connectionId, input.userId, input.provider);
      if (!owned) throw new Error("Workspace connection is not owned by user");

      this.sqlite
        .prepare(
          `UPDATE workspaceConnection
           SET externalAccountId = ?, externalLogin = ?, status = ?, credentialGeneration = ?,
               refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL, lastErrorCode = NULL,
               updatedAt = ?
           WHERE id = ? AND userId = ?`,
        )
        .run(
          input.externalAccountId,
          input.externalLogin,
          input.status,
          input.envelope.generation,
          input.now,
          input.connectionId,
          input.userId,
        );
      this.sqlite
        .prepare(
          `INSERT INTO workspaceCredentialVault
             (connectionId, envelopeVersion, keyVersion, iv, authTag, ciphertext, generation, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(connectionId) DO UPDATE SET
             envelopeVersion = excluded.envelopeVersion,
             keyVersion = excluded.keyVersion,
             iv = excluded.iv,
             authTag = excluded.authTag,
             ciphertext = excluded.ciphertext,
             generation = excluded.generation,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          input.connectionId,
          input.envelope.envelopeVersion,
          input.envelope.keyVersion,
          input.envelope.iv,
          input.envelope.authTag,
          input.envelope.ciphertext,
          input.envelope.generation,
          input.now,
        );

      this.sqlite
        .prepare("DELETE FROM workspaceConnectionRepository WHERE connectionId = ?")
        .run(input.connectionId);
      this.sqlite
        .prepare("DELETE FROM workspaceConnectionInstallation WHERE connectionId = ?")
        .run(input.connectionId);
      const installationStatement = this.sqlite.prepare(
        `INSERT INTO workspaceConnectionInstallation
         (connectionId, externalInstallationId, repositorySelection, createdAt)
         VALUES (?, ?, ?, ?)`,
      );
      for (const installation of input.installations) {
        installationStatement.run(
          input.connectionId,
          installation.externalInstallationId,
          installation.repositorySelection,
          input.now,
        );
      }
      const repositoryStatement = this.sqlite.prepare(
        `INSERT INTO workspaceConnectionRepository
         (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const repository of input.repositories) {
        repositoryStatement.run(
          input.connectionId,
          repository.externalInstallationId,
          repository.externalRepositoryId,
          repository.fullName,
          repository.private ? 1 : 0,
          input.now,
        );
      }
    });
    tx();
  }

  getConnection(userId: string, provider: string): WorkspaceConnectionSnapshot | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, userId, provider, externalAccountId, externalLogin, status,
                credentialGeneration, lastErrorCode
         FROM workspaceConnection WHERE userId = ? AND provider = ?`,
      )
      .get(userId, provider) as ConnectionRow | undefined;
    if (!row) return null;
    const installations = this.sqlite
      .prepare(
        `SELECT externalInstallationId, repositorySelection
         FROM workspaceConnectionInstallation WHERE connectionId = ?
         ORDER BY externalInstallationId`,
      )
      .all(row.id) as WorkspaceInstallationGrant[];
    const repositories = this.sqlite
      .prepare(
        `SELECT externalInstallationId, externalRepositoryId, fullName, private
         FROM workspaceConnectionRepository WHERE connectionId = ? ORDER BY fullName`,
      )
      .all(row.id) as Array<Omit<WorkspaceRepositoryGrant, "private"> & { private: number }>;
    return {
      ...row,
      installations,
      repositories: repositories.map((repository) => ({
        ...repository,
        private: repository.private === 1,
      })),
    };
  }

  getCredential(userId: string, provider: string): StoredWorkspaceCredential | null {
    const row = this.sqlite
      .prepare(
        `SELECT c.id, c.userId, c.provider, c.externalAccountId, c.externalLogin, c.status,
                c.credentialGeneration, c.lastErrorCode,
                v.envelopeVersion, v.keyVersion, v.iv, v.authTag, v.ciphertext, v.generation
         FROM workspaceConnection c
         JOIN workspaceCredentialVault v ON v.connectionId = c.id
         WHERE c.userId = ? AND c.provider = ?`,
      )
      .get(userId, provider) as (ConnectionRow & VaultRow) | undefined;
    if (!row) return null;
    return {
      connection: {
        id: row.id,
        userId: row.userId,
        provider: row.provider,
        externalAccountId: row.externalAccountId,
        externalLogin: row.externalLogin,
        status: row.status,
        credentialGeneration: row.credentialGeneration,
        lastErrorCode: row.lastErrorCode,
      },
      envelope: {
        envelopeVersion: row.envelopeVersion as 1,
        keyVersion: row.keyVersion,
        iv: row.iv,
        authTag: row.authTag,
        ciphertext: row.ciphertext,
        generation: row.generation,
      },
    };
  }

  storePendingRevocation(input: {
    id: string;
    userId: string;
    provider: string;
    envelope: WorkspaceCredentialEnvelope;
    now: number;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO workspaceCredentialRevocation
         (id, userId, provider, envelopeVersion, keyVersion, iv, authTag, ciphertext,
          generation, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.userId,
        input.provider,
        input.envelope.envelopeVersion,
        input.envelope.keyVersion,
        input.envelope.iv,
        input.envelope.authTag,
        input.envelope.ciphertext,
        input.envelope.generation,
        input.now,
        input.now,
      );
  }

  getPendingRevocations(userId: string, provider: string): StoredWorkspaceRevocation[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, userId, provider, envelopeVersion, keyVersion, iv, authTag, ciphertext, generation
         FROM workspaceCredentialRevocation
         WHERE userId = ? AND provider = ? ORDER BY createdAt, id`,
      )
      .all(userId, provider) as Array<{ id: string; userId: string; provider: string } & VaultRow>;
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      envelope: {
        envelopeVersion: row.envelopeVersion as 1,
        keyVersion: row.keyVersion,
        iv: row.iv,
        authTag: row.authTag,
        ciphertext: row.ciphertext,
        generation: row.generation,
      },
    }));
  }

  deletePendingRevocation(userId: string, provider: string, id: string): boolean {
    return (
      this.sqlite
        .prepare(
          `DELETE FROM workspaceCredentialRevocation
           WHERE id = ? AND userId = ? AND provider = ?`,
        )
        .run(id, userId, provider).changes === 1
    );
  }

  claimRefresh(input: {
    userId: string;
    connectionId: string;
    expectedGeneration: number;
    leaseId: string;
    now: number;
    leaseExpiresAt: number;
  }): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE workspaceConnection SET refreshLeaseId = ?, refreshLeaseExpiresAt = ?, updatedAt = ?
         WHERE id = ? AND userId = ? AND status = 'connected' AND credentialGeneration = ?
           AND refreshLeaseId IS NULL`,
      )
      .run(
        input.leaseId,
        input.leaseExpiresAt,
        input.now,
        input.connectionId,
        input.userId,
        input.expectedGeneration,
      );
    return result.changes === 1;
  }

  markExpiredRefreshFailed(input: {
    userId: string;
    connectionId: string;
    expectedGeneration: number;
    now: number;
  }): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE workspaceConnection
         SET status = 'refresh_failed',
             lastErrorCode = CASE
               WHEN lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED'
                 THEN 'AUTH_GRANT_REVOCATION_REQUIRED'
               ELSE 'AUTH_REFRESH_FAILED'
             END,
             refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND userId = ? AND status = 'connected' AND credentialGeneration = ?
           AND refreshLeaseId IS NOT NULL AND refreshLeaseExpiresAt <= ?`,
      )
      .run(input.now, input.connectionId, input.userId, input.expectedGeneration, input.now);
    return result.changes === 1;
  }

  markRefreshSubmitted(input: {
    userId: string;
    connectionId: string;
    leaseId: string;
    expectedGeneration: number;
    now: number;
  }): boolean {
    const result = this.sqlite
      .prepare(
        `UPDATE workspaceConnection
         SET lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED', updatedAt = ?
         WHERE id = ? AND userId = ? AND status = 'connected'
           AND credentialGeneration = ? AND refreshLeaseId = ?`,
      )
      .run(
        input.now,
        input.connectionId,
        input.userId,
        input.expectedGeneration,
        input.leaseId,
      );
    return result.changes === 1;
  }

  isRefreshSubmissionInFlight(userId: string, provider: string, now: number): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM workspaceConnection
           WHERE userId = ? AND provider = ? AND status = 'connected'
             AND lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED'
             AND refreshLeaseId IS NOT NULL AND refreshLeaseExpiresAt > ?`,
        )
        .get(userId, provider, now),
    );
  }

  clearRefreshRecoveryMarker(userId: string, connectionId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceConnection SET lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ?
             AND lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED'`,
        )
        .run(now, connectionId, userId).changes === 1
    );
  }

  completeRefresh(input: {
    userId: string;
    connectionId: string;
    leaseId: string;
    expectedGeneration: number;
    envelope: WorkspaceCredentialEnvelope;
    now: number;
  }): boolean {
    const tx = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE workspaceConnection
           SET credentialGeneration = ?, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
               lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND status = 'connected'
             AND credentialGeneration = ? AND refreshLeaseId = ?`,
        )
        .run(
          input.envelope.generation,
          input.now,
          input.connectionId,
          input.userId,
          input.expectedGeneration,
          input.leaseId,
        );
      if (result.changes !== 1) return false;
      const vaultResult = this.sqlite
        .prepare(
          `UPDATE workspaceCredentialVault
           SET envelopeVersion = ?, keyVersion = ?, iv = ?, authTag = ?, ciphertext = ?,
               generation = ?, updatedAt = ?
           WHERE connectionId = ? AND generation = ?`,
        )
        .run(
          input.envelope.envelopeVersion,
          input.envelope.keyVersion,
          input.envelope.iv,
          input.envelope.authTag,
          input.envelope.ciphertext,
          input.envelope.generation,
          input.now,
          input.connectionId,
          input.expectedGeneration,
        );
      if (vaultResult.changes !== 1) {
        throw new Error("Workspace credential generation changed during refresh");
      }
      return true;
    });
    return tx();
  }

  markRefreshFailed(input: {
    userId: string;
    connectionId: string;
    leaseId: string;
    now: number;
    errorCode?: "AUTH_REFRESH_FAILED" | "AUTH_GRANT_REVOCATION_REQUIRED";
  }): void {
    this.sqlite
      .prepare(
        `UPDATE workspaceConnection
         SET status = 'refresh_failed', lastErrorCode = ?,
             refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND userId = ? AND refreshLeaseId = ?`,
      )
      .run(
        input.errorCode ?? "AUTH_REFRESH_FAILED",
        input.now,
        input.connectionId,
        input.userId,
        input.leaseId,
      );
  }

  clearUnreadableCredentialFailure(userId: string, connectionId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceConnection
           SET lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND lastErrorCode = 'CREDENTIAL_UNREADABLE'`,
        )
        .run(now, connectionId, userId).changes === 1
    );
  }

  markCredentialFailed(
    userId: string,
    connectionId: string,
    now: number,
    errorCode: "AUTH_REFRESH_FAILED" | "CREDENTIAL_UNREADABLE" = "AUTH_REFRESH_FAILED",
  ): void {
    this.sqlite
      .prepare(
        `UPDATE workspaceConnection
         SET status = CASE WHEN status = 'revocation_pending' THEN status ELSE 'refresh_failed' END,
             lastErrorCode = ?,
             refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND userId = ? AND status != 'disconnected'`,
      )
      .run(errorCode, now, connectionId, userId);
  }

  abandonAfterExternalRevocation(input: {
    userId: string;
    provider: string;
    connectionId?: string;
    now: number;
  }): boolean {
    const tx = this.sqlite.transaction(() => {
      let changed = 0;
      if (input.connectionId) {
        const result = this.sqlite
          .prepare(
            `UPDATE workspaceConnection
             SET status = 'disconnected', credentialGeneration = credentialGeneration + 1,
                 lastErrorCode = NULL, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND userId = ? AND provider = ?`,
          )
          .run(input.now, input.connectionId, input.userId, input.provider);
        if (result.changes !== 1) return false;
        changed += result.changes;
        this.sqlite
          .prepare("DELETE FROM workspaceCredentialVault WHERE connectionId = ?")
          .run(input.connectionId);
        this.sqlite
          .prepare("DELETE FROM workspaceConnectionRepository WHERE connectionId = ?")
          .run(input.connectionId);
        this.sqlite
          .prepare("DELETE FROM workspaceConnectionInstallation WHERE connectionId = ?")
          .run(input.connectionId);
      }
      const pending = this.sqlite
        .prepare("DELETE FROM workspaceCredentialRevocation WHERE userId = ? AND provider = ?")
        .run(input.userId, input.provider);
      return changed + pending.changes > 0;
    });
    return tx();
  }

  beginDisconnect(userId: string, provider: string, now: number): StoredWorkspaceCredential | null {
    const tx = this.sqlite.transaction(() => {
      const stored = this.getCredential(userId, provider);
      if (!stored) return null;
      this.sqlite
        .prepare(
          `UPDATE workspaceConnection
           SET status = 'revocation_pending', refreshLeaseId = NULL,
               refreshLeaseExpiresAt = NULL, updatedAt = ?
           WHERE id = ? AND userId = ?`,
        )
        .run(now, stored.connection.id, userId);
      stored.connection.status = "revocation_pending";
      return stored;
    });
    return tx();
  }

  completeDisconnect(userId: string, connectionId: string, now: number): boolean {
    const tx = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE workspaceConnection
           SET status = 'disconnected', credentialGeneration = credentialGeneration + 1,
               lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND status = 'revocation_pending'`,
        )
        .run(now, connectionId, userId);
      if (result.changes !== 1) return false;
      this.sqlite
        .prepare("DELETE FROM workspaceCredentialVault WHERE connectionId = ?")
        .run(connectionId);
      this.sqlite
        .prepare("DELETE FROM workspaceConnectionRepository WHERE connectionId = ?")
        .run(connectionId);
      this.sqlite
        .prepare("DELETE FROM workspaceConnectionInstallation WHERE connectionId = ?")
        .run(connectionId);
      return true;
    });
    return tx();
  }
}
