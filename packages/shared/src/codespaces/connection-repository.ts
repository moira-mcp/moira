import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getSqliteInstance } from "../database/connection.js";
import type {
  CodespaceConnectionErrorCode,
  CodespaceConnectionSnapshot,
  CodespaceConnectionStatus,
  CodespaceCredentialEnvelope,
  CodespaceInstallationGrant,
  CodespaceRepositoryGrant,
} from "./types.js";

interface ConnectionRow {
  id: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: CodespaceConnectionStatus;
  credentialGeneration: number;
  lastErrorCode: CodespaceConnectionErrorCode | null;
}

interface VaultRow {
  envelopeVersion: number;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  generation: number;
}

export interface StoredCodespaceCredential {
  connection: ConnectionRow;
  envelope: CodespaceCredentialEnvelope;
}

export interface StoredCodespaceRevocation {
  id: string;
  userId: string;
  provider: string;
  envelope: CodespaceCredentialEnvelope;
}

export interface ConnectedCodespaceInput {
  connectionId: string;
  userId: string;
  provider: string;
  externalAccountId: string;
  externalLogin: string;
  status: "connected" | "installation_required";
  envelope: CodespaceCredentialEnvelope;
  installations: CodespaceInstallationGrant[];
  repositories: CodespaceRepositoryGrant[];
  /**
   * The credential this commit replaces, already encrypted for the revocation queue. It is queued in
   * the same transaction that stores its successor, so no moment exists in which the old token is
   * neither stored nor queued for revocation.
   */
  supersededRevocation?: { id: string; envelope: CodespaceCredentialEnvelope };
  now: number;
}

export function digestCodespaceAuthorizationValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class CodespaceConnectionRepository {
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
          `DELETE FROM codespaceAuthorizationState
           WHERE userId = ? AND provider = ? AND consumedAt IS NULL`,
        )
        .run(input.userId, input.provider);
      this.sqlite
        .prepare(
          `DELETE FROM codespaceAuthorizationState
           WHERE expiresAt < ? OR (consumedAt IS NOT NULL AND consumedAt < ?)`,
        )
        .run(input.now, input.now - 24 * 60 * 60 * 1000);
      this.sqlite
        .prepare(
          `INSERT INTO codespaceAuthorizationState
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
          `SELECT redirectPath FROM codespaceAuthorizationState
           WHERE stateHash = ? AND userId = ? AND sessionTokenHash = ? AND provider = ?
             AND consumedAt IS NULL AND expiresAt >= ?`,
        )
        .get(input.stateHash, input.userId, input.sessionTokenHash, input.provider, input.now) as
        { redirectPath: string } | undefined;
      if (!row) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE codespaceAuthorizationState SET consumedAt = ?
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
        .prepare("SELECT id FROM codespaceConnection WHERE userId = ? AND provider = ?")
        .get(input.userId, input.provider) as { id: string } | undefined;
      const id = existing?.id ?? randomUUID();
      if (existing) {
        this.sqlite
          .prepare(
            `UPDATE codespaceConnection
             SET status = 'connecting',
                 lastErrorCode = NULL, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND userId = ? AND provider = ?`,
          )
          .run(input.now, id, input.userId, input.provider);
      } else {
        this.sqlite
          .prepare(
            `INSERT INTO codespaceConnection
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

  completeConnection(input: ConnectedCodespaceInput): void {
    const tx = this.sqlite.transaction(() => {
      const owned = this.sqlite
        .prepare(
          `SELECT id, externalAccountId, credentialGeneration FROM codespaceConnection
           WHERE id = ? AND userId = ? AND provider = ?`,
        )
        .get(input.connectionId, input.userId, input.provider) as
        { id: string; externalAccountId: string; credentialGeneration: number } | undefined;
      if (!owned) throw new Error("Codespace connection is not owned by user");

      this.sqlite
        .prepare(
          `UPDATE codespaceConnection
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
          `INSERT INTO codespaceCredentialVault
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

      if (input.supersededRevocation) {
        this.storePendingRevocation({
          id: input.supersededRevocation.id,
          userId: input.userId,
          provider: input.provider,
          envelope: input.supersededRevocation.envelope,
          now: input.now,
        });
      }

      this.sqlite
        .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = ?")
        .run(input.connectionId);
      this.sqlite
        .prepare("DELETE FROM codespaceConnectionInstallation WHERE connectionId = ?")
        .run(input.connectionId);
      this.sqlite
        .prepare(
          `UPDATE codespaceConnection
           SET grantsRefreshedAt = ?, grantsVersion = grantsVersion + 1
           WHERE id = ?`,
        )
        .run(input.now, input.connectionId);
      const installationStatement = this.sqlite.prepare(
        `INSERT INTO codespaceConnectionInstallation
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
        `INSERT INTO codespaceConnectionRepository
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

  /**
   * Replace the installation and repository grants of a connection with what the provider reports now.
   * The same wholesale replacement `completeConnection` performs, reachable without re-authorizing —
   * a repository added to the installation after connecting is otherwise invisible until the user
   * reconnects.
   */
  replaceGrants(input: {
    connectionId: string;
    userId: string;
    provider: string;
    expectedCredentialGeneration: number;
    expectedGrantsVersion: number;
    installations: CodespaceInstallationGrant[];
    repositories: CodespaceRepositoryGrant[];
    now: number;
  }): boolean {
    const tx = this.sqlite.transaction(() => {
      const status = input.installations.length > 0 ? "connected" : "installation_required";
      const guarded = this.sqlite
        .prepare(
          `UPDATE codespaceConnection
           SET status = ?, grantsRefreshedAt = ?, grantsVersion = grantsVersion + 1, updatedAt = ?
           WHERE id = ? AND userId = ? AND provider = ?
             AND credentialGeneration = ?
             AND grantsVersion = ?
             AND status IN ('connected', 'installation_required')`,
        )
        .run(
          status,
          input.now,
          input.now,
          input.connectionId,
          input.userId,
          input.provider,
          input.expectedCredentialGeneration,
          input.expectedGrantsVersion,
        );
      if (guarded.changes !== 1) return false;
      this.sqlite
        .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = ?")
        .run(input.connectionId);
      this.sqlite
        .prepare("DELETE FROM codespaceConnectionInstallation WHERE connectionId = ?")
        .run(input.connectionId);
      const installationStatement = this.sqlite.prepare(
        `INSERT INTO codespaceConnectionInstallation
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
        `INSERT INTO codespaceConnectionRepository
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
      return true;
    });
    return tx.immediate();
  }

  /** Version and timestamp of the complete grant snapshot, read atomically for refresh CAS. */
  grantSnapshot(connectionId: string): { refreshedAt: number | null; version: number } | null {
    const row = this.sqlite
      .prepare("SELECT grantsRefreshedAt, grantsVersion FROM codespaceConnection WHERE id = ?")
      .get(connectionId) as { grantsRefreshedAt: number | null; grantsVersion: number } | undefined;
    return row ? { refreshedAt: row.grantsRefreshedAt, version: row.grantsVersion } : null;
  }

  getConnection(userId: string, provider: string): CodespaceConnectionSnapshot | null {
    const row = this.sqlite
      .prepare(
        `SELECT id, userId, provider, externalAccountId, externalLogin, status,
                credentialGeneration, lastErrorCode
         FROM codespaceConnection WHERE userId = ? AND provider = ?`,
      )
      .get(userId, provider) as ConnectionRow | undefined;
    if (!row) return null;
    const installations = this.sqlite
      .prepare(
        `SELECT externalInstallationId, repositorySelection
         FROM codespaceConnectionInstallation WHERE connectionId = ?
         ORDER BY externalInstallationId`,
      )
      .all(row.id) as CodespaceInstallationGrant[];
    const repositories = this.sqlite
      .prepare(
        `SELECT externalInstallationId, externalRepositoryId, fullName, private
         FROM codespaceConnectionRepository WHERE connectionId = ? ORDER BY fullName`,
      )
      .all(row.id) as Array<Omit<CodespaceRepositoryGrant, "private"> & { private: number }>;
    return {
      ...row,
      installations,
      repositories: repositories.map((repository) => ({
        ...repository,
        private: repository.private === 1,
      })),
    };
  }

  getCredential(userId: string, provider: string): StoredCodespaceCredential | null {
    const row = this.sqlite
      .prepare(
        `SELECT c.id, c.userId, c.provider, c.externalAccountId, c.externalLogin, c.status,
                c.credentialGeneration, c.lastErrorCode,
                v.envelopeVersion, v.keyVersion, v.iv, v.authTag, v.ciphertext, v.generation
         FROM codespaceConnection c
         JOIN codespaceCredentialVault v ON v.connectionId = c.id
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
        envelopeVersion: row.envelopeVersion as 1 | 2,
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
    envelope: CodespaceCredentialEnvelope;
    now: number;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO codespaceCredentialRevocation
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

  getPendingRevocations(userId: string, provider: string): StoredCodespaceRevocation[] {
    const rows = this.sqlite
      .prepare(
        `SELECT id, userId, provider, envelopeVersion, keyVersion, iv, authTag, ciphertext, generation
         FROM codespaceCredentialRevocation
         WHERE userId = ? AND provider = ? ORDER BY createdAt, id`,
      )
      .all(userId, provider) as Array<{ id: string; userId: string; provider: string } & VaultRow>;
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      provider: row.provider,
      envelope: {
        envelopeVersion: row.envelopeVersion as 1 | 2,
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
          `DELETE FROM codespaceCredentialRevocation
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
        `UPDATE codespaceConnection SET refreshLeaseId = ?, refreshLeaseExpiresAt = ?, updatedAt = ?
         WHERE id = ? AND userId = ?
           AND status IN ('connected', 'installation_required') AND credentialGeneration = ?
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
        `UPDATE codespaceConnection
         SET status = 'refresh_failed',
             lastErrorCode = CASE
               WHEN lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED'
                 THEN 'AUTH_GRANT_REVOCATION_REQUIRED'
               ELSE 'AUTH_REFRESH_FAILED'
             END,
             refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL, updatedAt = ?
         WHERE id = ? AND userId = ?
           AND status IN ('connected', 'installation_required') AND credentialGeneration = ?
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
        `UPDATE codespaceConnection
         SET lastErrorCode = 'AUTH_GRANT_REVOCATION_REQUIRED', updatedAt = ?
         WHERE id = ? AND userId = ? AND status IN ('connected', 'installation_required')
           AND credentialGeneration = ? AND refreshLeaseId = ?`,
      )
      .run(input.now, input.connectionId, input.userId, input.expectedGeneration, input.leaseId);
    return result.changes === 1;
  }

  isRefreshSubmissionInFlight(userId: string, provider: string, now: number): boolean {
    return Boolean(
      this.sqlite
        .prepare(
          `SELECT 1 FROM codespaceConnection
           WHERE userId = ? AND provider = ?
             AND status IN ('connected', 'installation_required')
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
          `UPDATE codespaceConnection SET lastErrorCode = NULL, updatedAt = ?
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
    envelope: CodespaceCredentialEnvelope;
    now: number;
  }): boolean {
    const tx = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `UPDATE codespaceConnection
           SET credentialGeneration = ?, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
               lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND status IN ('connected', 'installation_required')
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
          `UPDATE codespaceCredentialVault
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
        throw new Error("Codespace credential generation changed during refresh");
      }
      this.sqlite
        .prepare(
          `UPDATE codespaceResource SET authorizationGeneration = ?, updatedAt = ?
           WHERE connectionId = ? AND userId = ? AND authorizationGeneration = ?
             AND state NOT IN ('deleted', 'rejected')`,
        )
        .run(
          input.envelope.generation,
          input.now,
          input.connectionId,
          input.userId,
          input.expectedGeneration,
        );
      this.sqlite
        .prepare(
          `UPDATE codespaceOperation SET authorizationGeneration = ?, updatedAt = ?
           WHERE userId = ? AND authorizationGeneration = ?
             AND resourceId IN (SELECT id FROM codespaceResource WHERE connectionId = ?)
             AND (state IN ('reserved', 'running', 'cancel_pending', 'reconcile_pending')
               OR (remoteCleanupPending = 1
                 AND state IN ('succeeded', 'failed', 'cancelled', 'timed_out')))`,
        )
        .run(
          input.envelope.generation,
          input.now,
          input.userId,
          input.expectedGeneration,
          input.connectionId,
        );
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
        `UPDATE codespaceConnection
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
          `UPDATE codespaceConnection
           SET lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND lastErrorCode = 'CREDENTIAL_UNREADABLE'`,
        )
        .run(now, connectionId, userId).changes === 1
    );
  }

  /**
   * Puts back the status and error a reservation replaced, when the authorization that reserved the
   * connection never committed its credential. A connection that moved on since (committed,
   * disconnected) is left alone.
   */
  restoreReservedConnection(input: {
    userId: string;
    connectionId: string;
    status: CodespaceConnectionStatus;
    lastErrorCode: CodespaceConnectionErrorCode | null;
    now: number;
  }): void {
    this.sqlite
      .prepare(
        `UPDATE codespaceConnection SET status = ?, lastErrorCode = ?, updatedAt = ?
         WHERE id = ? AND userId = ? AND status = 'connecting'`,
      )
      .run(input.status, input.lastErrorCode, input.now, input.connectionId, input.userId);
  }

  markCredentialFailed(
    userId: string,
    connectionId: string,
    now: number,
    errorCode: "AUTH_REFRESH_FAILED" | "CREDENTIAL_UNREADABLE" = "AUTH_REFRESH_FAILED",
  ): void {
    this.sqlite
      .prepare(
        `UPDATE codespaceConnection
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
            `UPDATE codespaceConnection
             SET status = 'disconnected', credentialGeneration = credentialGeneration + 1,
                 lastErrorCode = NULL, refreshLeaseId = NULL, refreshLeaseExpiresAt = NULL,
                 updatedAt = ?
             WHERE id = ? AND userId = ? AND provider = ?`,
          )
          .run(input.now, input.connectionId, input.userId, input.provider);
        if (result.changes !== 1) return false;
        changed += result.changes;
        this.sqlite
          .prepare("DELETE FROM codespaceCredentialVault WHERE connectionId = ?")
          .run(input.connectionId);
        this.sqlite
          .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = ?")
          .run(input.connectionId);
        this.sqlite
          .prepare("DELETE FROM codespaceConnectionInstallation WHERE connectionId = ?")
          .run(input.connectionId);
      }
      const pending = this.sqlite
        .prepare("DELETE FROM codespaceCredentialRevocation WHERE userId = ? AND provider = ?")
        .run(input.userId, input.provider);
      return changed + pending.changes > 0;
    });
    return tx();
  }

  beginDisconnect(userId: string, provider: string, now: number): StoredCodespaceCredential | null {
    const tx = this.sqlite.transaction(() => {
      const stored = this.getCredential(userId, provider);
      if (!stored) return null;
      this.sqlite
        .prepare(
          `UPDATE codespaceConnection
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
          `UPDATE codespaceConnection
           SET status = 'disconnected', credentialGeneration = credentialGeneration + 1,
               lastErrorCode = NULL, updatedAt = ?
           WHERE id = ? AND userId = ? AND status = 'revocation_pending'`,
        )
        .run(now, connectionId, userId);
      if (result.changes !== 1) return false;
      this.sqlite
        .prepare("DELETE FROM codespaceCredentialVault WHERE connectionId = ?")
        .run(connectionId);
      this.sqlite
        .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = ?")
        .run(connectionId);
      this.sqlite
        .prepare("DELETE FROM codespaceConnectionInstallation WHERE connectionId = ?")
        .run(connectionId);
      return true;
    });
    return tx();
  }
}
