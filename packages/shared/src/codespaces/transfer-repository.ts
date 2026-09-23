import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import type { CodespaceResourcePolicy, CodespaceTransferRecord } from "./resource-types.js";

const LIVE_STATES = ["reserved", "ready", "claimed"] as const;

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
  }): { token: string; record: CodespaceTransferRecord } | null {
    return this.sqlite
      .transaction(() => {
        const states = LIVE_STATES.map(() => "?").join(",");
        const user = this.sqlite
          .prepare(
            `SELECT COUNT(*) count, COALESCE(SUM(declaredSize), 0) bytes,
             COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0) inflight
           FROM codespaceTransfer WHERE userId = ? AND state IN (${states})`,
          )
          .get(input.userId, ...LIVE_STATES) as {
          count: number;
          bytes: number;
          inflight: number;
        };
        const global = this.sqlite
          .prepare(
            `SELECT COUNT(*) count, COALESCE(SUM(declaredSize), 0) bytes,
             COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0) inflight
           FROM codespaceTransfer WHERE state IN (${states})`,
          )
          .get(...LIVE_STATES) as { count: number; bytes: number; inflight: number };
        const limits = effectiveCodespaceLimits(input.policy).transfers;
        if (
          input.declaredSize > limits.maxFileBytes ||
          user.count >= limits.maxObjectsPerUser ||
          global.count >= limits.maxObjectsGlobal ||
          user.bytes + input.declaredSize > limits.maxBytesPerUser ||
          global.bytes + input.declaredSize > limits.maxBytesGlobal ||
          user.inflight + input.declaredSize > limits.maxInflightBytesPerUser ||
          global.inflight + input.declaredSize > limits.maxInflightBytesGlobal
        ) {
          return null;
        }
        const id = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const objectKey = randomBytes(24).toString("hex");
        const expiresAt = input.now + limits.ttlMs;
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
        return { token, record: this.require(id) };
      })
      .immediate();
  }

  markReady(
    id: string,
    observedSize: number,
    sha256: string,
    now: number,
    mimeType?: string,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET state = 'ready', declaredSize = ?, observedSize = ?, sha256 = ?, mimeType = COALESCE(?, mimeType),
           updatedAt = ? WHERE id = ? AND state = 'reserved' AND declaredSize >= ? AND expiresAt > ?`,
        )
        .run(observedSize, observedSize, sha256, mimeType ?? null, now, id, observedSize, now)
        .changes === 1
    );
  }

  claim(
    token: string,
    purpose: CodespaceTransferRecord["purpose"],
    now: number,
    claimExpiresAt: number,
    userId?: string,
  ): CodespaceTransferRecord | null {
    const digest = digestCodespaceTransferToken(token);
    const claimId = randomUUID();
    return this.sqlite
      .transaction(() => {
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
         OR state = 'consumed' OR expiresAt <= ?
         OR (state = 'claimed' AND claimExpiresAt <= ?) ORDER BY createdAt, id`,
      )
      .all(includeReserved ? 1 : 0, now, now) as CodespaceTransferRecord[];
  }

  /**
   * The user's live transfers: the objects and declared bytes the per-user ceilings limit, and the
   * bytes still in flight (reserved or claimed), which the in-flight ceiling limits — the same
   * predicates `reserve` applies.
   */
  usageForUser(userId: string): { objects: number; bytes: number; inflightBytes: number } {
    return this.sqlite
      .prepare(
        `SELECT COUNT(*) objects, COALESCE(SUM(declaredSize), 0) bytes,
         COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0)
           inflightBytes
         FROM codespaceTransfer
         WHERE userId = ? AND state IN (${LIVE_STATES.map(() => "?").join(",")})`,
      )
      .get(userId, ...LIVE_STATES) as { objects: number; bytes: number; inflightBytes: number };
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
}
