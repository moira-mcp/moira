import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import type { CodespaceResourcePolicy, CodespaceTransferRecord } from "./resource-types.js";
import { CodespaceResourceError } from "./resource-types.js";

const LIVE_STATES = ["reserved", "ready", "claimed"] as const;
const NATIVE_PURPOSES = ["codespace_input", "codespace_download"] as const;
const RELAY_PURPOSES = [
  "local_relay_input",
  "local_relay_output",
  "operation_input",
  "operation_result",
] as const;

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
    /** Internal control objects follow their owning operation's retention. */
    expiresAt?: number;
    binding?: {
      requestId: string;
      requestDigest: string;
      direction: string;
      resourceId: string;
      provider: string;
      resourceGeneration: number;
      authorizationGeneration: number;
      environmentIdentity: string;
      expectedSha256: string | null;
    };
    persist?: (token: string, record: CodespaceTransferRecord) => void;
  }): { token: string; record: CodespaceTransferRecord } | null {
    if (![...NATIVE_PURPOSES, ...RELAY_PURPOSES].includes(input.purpose)) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer purpose");
    }
    return this.sqlite
      .transaction(() => {
        if (input.binding) {
          const existing = this.getByRequest(input.userId, input.binding.requestId);
          if (existing) return { token: "", record: existing };
        }
        const relay = input.purpose !== "codespace_input" && input.purpose !== "codespace_download";
        const purposes = relay ? RELAY_PURPOSES : NATIVE_PURPOSES;
        const states = LIVE_STATES.map(() => "?").join(",");
        const user = this.sqlite
          .prepare(
            `SELECT COUNT(*) count, COALESCE(SUM(declaredSize), 0) bytes,
             COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0) inflight
           FROM codespaceTransfer WHERE userId = ? AND purpose IN (${purposes.map(() => "?").join(",")}) AND state IN (${states})`,
          )
          .get(input.userId, ...purposes, ...LIVE_STATES) as {
          count: number;
          bytes: number;
          inflight: number;
        };
        const global = this.sqlite
          .prepare(
            `SELECT COUNT(*) count, COALESCE(SUM(declaredSize), 0) bytes,
             COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0) inflight
           FROM codespaceTransfer WHERE purpose IN (${purposes.map(() => "?").join(",")}) AND state IN (${states})`,
          )
          .get(...purposes, ...LIVE_STATES) as { count: number; bytes: number; inflight: number };
        const effective = effectiveCodespaceLimits(input.policy);
        const limits = relay ? effective.relayTransfers : effective.transfers;
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
        const expiresAt =
          relay && input.expiresAt !== undefined ? input.expiresAt : input.now + limits.ttlMs;
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
        if (input.binding) this.bind(id, input.binding);
        const record = this.require(id);
        input.persist?.(token, record);
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
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE codespaceTransfer SET state = 'ready', declaredSize = ?, observedSize = ?, sha256 = ?, mimeType = COALESCE(?, mimeType),
           uploadedBytes = ?, expectedSha256 = CASE WHEN requestId IS NOT NULL THEN COALESCE(expectedSha256, ?) ELSE expectedSha256 END,
           updatedAt = ? WHERE id = ? AND state = 'reserved' AND declaredSize >= ? AND expiresAt > ?
           AND (expectedSha256 IS NULL OR expectedSha256 = ?)`,
        )
        .run(
          observedSize,
          observedSize,
          sha256,
          mimeType ?? null,
          observedSize,
          sha256,
          now,
          id,
          observedSize,
          now,
          sha256,
        ).changes === 1
    );
  }

  claim(
    token: string,
    purpose: CodespaceTransferRecord["purpose"],
    now: number,
    claimExpiresAt: number,
    policy: CodespaceResourcePolicy,
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
        const relay = !NATIVE_PURPOSES.includes(
          candidate.purpose as (typeof NATIVE_PURPOSES)[number],
        );
        const purposes = relay ? RELAY_PURPOSES : NATIVE_PURPOSES;
        const limits = relay
          ? effectiveCodespaceLimits(policy).relayTransfers
          : effectiveCodespaceLimits(policy).transfers;
        const usage = this.sqlite
          .prepare(
            `SELECT
          COALESCE(SUM(CASE WHEN userId = ? THEN declaredSize ELSE 0 END), 0) userBytes,
          COALESCE(SUM(declaredSize), 0) globalBytes
          FROM codespaceTransfer WHERE purpose IN (${purposes.map(() => "?").join(",")})
          AND state IN ('reserved', 'claimed')`,
          )
          .get(candidate.userId, ...purposes) as { userBytes: number; globalBytes: number };
        if (
          usage.userBytes + candidate.declaredSize > limits.maxInflightBytesPerUser ||
          usage.globalBytes + candidate.declaredSize > limits.maxInflightBytesGlobal
        )
          return null;
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
          `UPDATE codespaceTransfer SET claimExpiresAt = MIN(?, expiresAt), updatedAt = ?
      WHERE id = ? AND state = 'claimed' AND claimId = ? AND claimExpiresAt > ? AND expiresAt > ?`,
        )
        .run(expiresAt, now, id, claimId, now, now).changes === 1
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
   * The user's native file transfers: the objects and declared bytes the per-user ceilings limit, and the
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
         WHERE userId = ? AND purpose IN (?, ?) AND state IN (${LIVE_STATES.map(() => "?").join(",")})`,
      )
      .get(userId, ...NATIVE_PURPOSES, ...LIVE_STATES) as {
      objects: number;
      bytes: number;
      inflightBytes: number;
    };
  }

  listLive(): CodespaceTransferRecord[] {
    return this.sqlite
      .prepare("SELECT * FROM codespaceTransfer WHERE state IN ('reserved','ready','claimed')")
      .all() as CodespaceTransferRecord[];
  }

  getReadyOwned(
    id: string,
    userId: string,
    purpose: CodespaceTransferRecord["purpose"],
    now: number,
  ): CodespaceTransferRecord | null {
    return (
      (this.sqlite
        .prepare(
          "SELECT * FROM codespaceTransfer WHERE id = ? AND userId = ? AND purpose = ? AND state = 'ready' AND expiresAt > ?",
        )
        .get(id, userId, purpose, now) as CodespaceTransferRecord | undefined) ?? null
    );
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

  getByRequest(userId: string, requestId: string): CodespaceTransferRecord | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM codespaceTransfer WHERE userId = ? AND requestId = ?")
        .get(userId, requestId) as CodespaceTransferRecord | undefined) ?? null
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

  /** Only short synchronous descriptor/checkpoint mutations belong inside this transaction. */
  mutate<T>(userId: string, id: string, action: (record: CodespaceTransferRecord) => T): T {
    return this.sqlite
      .transaction(() => {
        const record = this.getOwned(userId, id);
        if (!record)
          throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer is unavailable");
        return action(record);
      })
      .immediate();
  }

  bind(
    id: string,
    input: {
      requestId: string;
      requestDigest: string;
      direction: string;
      resourceId: string;
      provider: string;
      resourceGeneration: number;
      authorizationGeneration: number;
      environmentIdentity: string;
      expectedSha256: string | null;
    },
  ): void {
    this.sqlite
      .prepare(
        `UPDATE codespaceTransfer SET requestId = ?, requestDigest = ?, direction = ?,
      resourceId = ?, provider = ?, resourceGeneration = ?, authorizationGeneration = ?,
      environmentIdentity = ?, expectedSha256 = ? WHERE id = ? AND state = 'reserved'`,
      )
      .run(
        input.requestId,
        input.requestDigest,
        input.direction,
        input.resourceId,
        input.provider,
        input.resourceGeneration,
        input.authorizationGeneration,
        input.environmentIdentity,
        input.expectedSha256,
        id,
      );
  }

  checkpoint(id: string, offset: number, now: number): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceTransfer SET uploadedBytes = ?, updatedAt = ? WHERE id = ? AND state = 'reserved'",
      )
      .run(offset, now, id);
  }

  replaceIngestionOwner(
    id: string,
    ownerPid: number,
    ownerStartTime: string | null,
    now: number,
  ): void {
    this.sqlite
      .prepare(
        "UPDATE codespaceTransfer SET ownerPid = ?, ownerStartTime = ?, uploadedBytes = 0, updatedAt = ? WHERE id = ? AND state = 'reserved'",
      )
      .run(ownerPid, ownerStartTime, now, id);
  }
}
