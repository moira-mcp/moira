import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import type { CodespaceResourcePolicy, CodespaceTransferRecord } from "./resource-types.js";
import { CodespaceResourceError } from "./resource-types.js";

export function digestCodespaceTransferToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class CodespaceTransferRepository {
  constructor(private readonly sqlite: Database.Database) {}

  reserve(input: {
    userId: string;
    purpose: CodespaceTransferRecord["purpose"];
    fileName: string;
    mimeType: string;
    declaredSize: number;
    ownerPid: number;
    ownerStartTime: string | null;
    policy: CodespaceResourcePolicy;
    now: number;
  }): { token: string; record: CodespaceTransferRecord } {
    if (input.purpose !== "codespace_download") {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer purpose");
    }
    return this.sqlite
      .transaction(() => {
        const id = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const objectKey = randomBytes(24).toString("hex");
        const expiresAt = input.now + effectiveCodespaceLimits(input.policy).transfers.ttlMs;
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= input.now) {
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Invalid control object retention",
          );
        }
        this.sqlite
          .prepare(
            `INSERT INTO codespaceTransfer
           (id, tokenDigest, userId, purpose, state, fileName, mimeType, declaredSize,
            objectKey, ownerPid, ownerStartTime, expiresAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            digestCodespaceTransferToken(token),
            input.userId,
            input.purpose,
            input.fileName,
            input.mimeType,
            input.declaredSize,
            objectKey,
            input.ownerPid,
            input.ownerStartTime,
            expiresAt,
            input.now,
            input.now,
          );
        const record = this.require(id);
        return { token, record };
      })
      .immediate();
  }

  markReady(
    id: string,
    observedSize: number,
    sha256: string,
    now: number,
    mimeType?: string,
    expiresAt?: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET state = 'ready', declaredSize = ?, observedSize = ?, sha256 = ?, mimeType = COALESCE(?, mimeType),
           uploadedBytes = ?, expectedSha256 = CASE WHEN requestId IS NOT NULL THEN COALESCE(expectedSha256, ?) ELSE expectedSha256 END,
           expiresAt = COALESCE(?, expiresAt), updatedAt = ? WHERE id = ? AND state = 'reserved' AND declaredSize >= ?
           AND (expectedSha256 IS NULL OR expectedSha256 = ?)`,
        )
        .run(
          observedSize,
          observedSize,
          sha256,
          mimeType ?? null,
          observedSize,
          sha256,
          expiresAt ?? null,
          now,
          id,
          observedSize,
          sha256,
        ).changes === 1
    );
  }

  claim(
    token: string,
    purpose: CodespaceTransferRecord["purpose"],
    now: number,
    claimExpiresAt: number,
    _policy: CodespaceResourcePolicy,
    userId?: string,
  ): CodespaceTransferRecord | null {
    const digest = digestCodespaceTransferToken(token);
    const claimId = randomUUID();
    return this.sqlite
      .transaction(() => {
        const candidate = this.sqlite
          .prepare(
            `SELECT * FROM codespaceTransfer
          WHERE tokenDigest = ? AND purpose = ? AND state = 'ready' AND expiresAt > ?
          AND (? IS NULL OR userId = ?)`,
          )
          .get(digest, purpose, now, userId ?? null, userId ?? null) as
          CodespaceTransferRecord | undefined;
        if (!candidate) return null;
        const changed = this.sqlite
          .prepare(
            `UPDATE codespaceTransfer SET state = 'claimed', claimId = ?, claimExpiresAt = ?, updatedAt = ?
           WHERE tokenDigest = ? AND purpose = ? AND state = 'ready' AND expiresAt > ?
             AND (? IS NULL OR userId = ?)`,
          )
          .run(
            claimId,
            claimExpiresAt,
            now,
            digest,
            purpose,
            now,
            userId ?? null,
            userId ?? null,
          ).changes;
        if (changed !== 1) return null;
        return this.sqlite
          .prepare("SELECT * FROM codespaceTransfer WHERE tokenDigest = ? AND claimId = ?")
          .get(digest, claimId) as CodespaceTransferRecord;
      })
      .immediate();
  }

  release(id: string, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET state = 'ready', claimId = NULL, claimExpiresAt = NULL,
           updatedAt = ? WHERE id = ? AND state = 'claimed' AND claimId = ? AND expiresAt > ?`,
        )
        .run(now, id, claimId, now).changes === 1
    );
  }

  renewClaim(id: string, claimId: string, now: number, expiresAt: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET claimExpiresAt = ?, updatedAt = ?
      WHERE id = ? AND state = 'claimed' AND claimId = ? AND claimExpiresAt > ?`,
        )
        .run(expiresAt, now, id, claimId, now).changes === 1
    );
  }

  consume(id: string, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET state = 'consumed', claimId = NULL, claimExpiresAt = NULL,
           updatedAt = ? WHERE id = ? AND state = 'claimed' AND claimId = ?`,
        )
        .run(now, id, claimId).changes === 1
    );
  }

  remove(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM codespaceTransfer WHERE id = ?").run(id).changes === 1;
  }

  listCleanup(now: number, includeReserved = false): CodespaceTransferRecord[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM codespaceTransfer WHERE (? = 1 AND state = 'reserved')
         OR state = 'consumed' OR (state = 'ready' AND expiresAt <= ?)
         OR (state = 'claimed' AND claimExpiresAt <= ?) ORDER BY createdAt, id`,
      )
      .all(includeReserved ? 1 : 0, now, now) as CodespaceTransferRecord[];
  }

  listLive(): CodespaceTransferRecord[] {
    return this.sqlite
      .prepare("SELECT * FROM codespaceTransfer WHERE state IN ('reserved','ready','claimed')")
      .all() as CodespaceTransferRecord[];
  }

  private require(id: string): CodespaceTransferRecord {
    const row = this.sqlite.prepare("SELECT * FROM codespaceTransfer WHERE id = ?").get(id) as
      CodespaceTransferRecord | undefined;
    if (!row) throw new Error("Codespace transfer disappeared");
    return row;
  }

  getOwned(userId: string, id: string): CodespaceTransferRecord | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM codespaceTransfer WHERE userId = ? AND id = ?")
        .get(userId, id) as CodespaceTransferRecord | undefined) ?? null
    );
  }

  getByToken(userId: string, token: string): CodespaceTransferRecord | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM codespaceTransfer WHERE userId = ? AND tokenDigest = ?")
        .get(userId, digestCodespaceTransferToken(token)) as CodespaceTransferRecord | undefined) ??
      null
    );
  }

  /** Only short synchronous descriptor/checkpoint mutations belong inside this transaction. */
  mutateByObjectKey<T>(
    objectKey: string,
    action: (record: CodespaceTransferRecord | null) => T,
  ): T {
    return this.sqlite
      .transaction(() => {
        const record = this.sqlite
          .prepare("SELECT * FROM codespaceTransfer WHERE objectKey = ?")
          .get(objectKey) as CodespaceTransferRecord | undefined;
        return action(record ?? null);
      })
      .immediate();
  }
}
