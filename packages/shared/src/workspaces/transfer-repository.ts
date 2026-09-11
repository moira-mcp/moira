import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkspaceResourcePolicy, WorkspaceTransferRecord } from "./resource-types.js";

const LIVE_STATES = ["reserved", "ready", "claimed"] as const;

export function digestWorkspaceTransferToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class WorkspaceTransferRepository {
  constructor(private readonly sqlite: Database.Database) {}

  reserve(input: {
    userId: string;
    purpose: WorkspaceTransferRecord["purpose"];
    fileName: string;
    mimeType: string;
    declaredSize: number;
    ownerPid: number;
    ownerStartTime: string | null;
    policy: WorkspaceResourcePolicy;
    now: number;
  }): { token: string; record: WorkspaceTransferRecord } | null {
    return this.sqlite
      .transaction(() => {
        const states = LIVE_STATES.map(() => "?").join(",");
        const user = this.sqlite
          .prepare(
            `SELECT COUNT(*) count, COALESCE(SUM(declaredSize), 0) bytes,
             COALESCE(SUM(CASE WHEN state IN ('reserved','claimed') THEN declaredSize ELSE 0 END), 0) inflight
           FROM workspaceTransfer WHERE userId = ? AND state IN (${states})`,
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
           FROM workspaceTransfer WHERE state IN (${states})`,
          )
          .get(...LIVE_STATES) as { count: number; bytes: number; inflight: number };
        if (
          input.declaredSize > (input.policy.maxTransferFileBytes ?? 4 * 1024 * 1024) ||
          user.count >= (input.policy.maxTransferObjectsPerUser ?? 10) ||
          global.count >= (input.policy.maxTransferObjectsGlobal ?? 1000) ||
          user.bytes + input.declaredSize >
            (input.policy.maxTransferBytesPerUser ?? 100 * 1024 * 1024) ||
          global.bytes + input.declaredSize >
            (input.policy.maxTransferBytesGlobal ?? 1024 * 1024 * 1024) ||
          user.inflight + input.declaredSize >
            (input.policy.maxTransferInflightBytesPerUser ?? 40 * 1024 * 1024) ||
          global.inflight + input.declaredSize >
            (input.policy.maxTransferInflightBytesGlobal ?? 256 * 1024 * 1024)
        ) {
          return null;
        }
        const id = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const objectKey = randomBytes(24).toString("hex");
        const expiresAt = input.now + (input.policy.transferTtlMs ?? 10 * 60_000);
        this.sqlite
          .prepare(
            `INSERT INTO workspaceTransfer
           (id, tokenDigest, userId, purpose, state, fileName, mimeType, declaredSize,
            objectKey, ownerPid, ownerStartTime, expiresAt, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            digestWorkspaceTransferToken(token),
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
          `UPDATE workspaceTransfer SET state = 'ready', declaredSize = ?, observedSize = ?, sha256 = ?, mimeType = COALESCE(?, mimeType),
           updatedAt = ? WHERE id = ? AND state = 'reserved' AND declaredSize >= ? AND expiresAt > ?`,
        )
        .run(observedSize, observedSize, sha256, mimeType ?? null, now, id, observedSize, now)
        .changes === 1
    );
  }

  claim(
    token: string,
    purpose: WorkspaceTransferRecord["purpose"],
    now: number,
    claimExpiresAt: number,
    userId?: string,
  ): WorkspaceTransferRecord | null {
    const digest = digestWorkspaceTransferToken(token);
    const claimId = randomUUID();
    return this.sqlite
      .transaction(() => {
        const changed = this.sqlite
          .prepare(
            `UPDATE workspaceTransfer SET state = 'claimed', claimId = ?, claimExpiresAt = ?, updatedAt = ?
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
          .prepare("SELECT * FROM workspaceTransfer WHERE tokenDigest = ? AND claimId = ?")
          .get(digest, claimId) as WorkspaceTransferRecord;
      })
      .immediate();
  }

  release(id: string, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceTransfer SET state = 'ready', claimId = NULL, claimExpiresAt = NULL,
           updatedAt = ? WHERE id = ? AND state = 'claimed' AND claimId = ? AND expiresAt > ?`,
        )
        .run(now, id, claimId, now).changes === 1
    );
  }

  consume(id: string, claimId: string, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE workspaceTransfer SET state = 'consumed', claimId = NULL, claimExpiresAt = NULL,
           updatedAt = ? WHERE id = ? AND state = 'claimed' AND claimId = ?`,
        )
        .run(now, id, claimId).changes === 1
    );
  }

  remove(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM workspaceTransfer WHERE id = ?").run(id).changes === 1;
  }

  listCleanup(now: number, includeReserved = false): WorkspaceTransferRecord[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM workspaceTransfer WHERE (? = 1 AND state = 'reserved')
         OR state = 'consumed' OR expiresAt <= ?
         OR (state = 'claimed' AND claimExpiresAt <= ?) ORDER BY createdAt, id`,
      )
      .all(includeReserved ? 1 : 0, now, now) as WorkspaceTransferRecord[];
  }

  listLive(): WorkspaceTransferRecord[] {
    return this.sqlite
      .prepare("SELECT * FROM workspaceTransfer WHERE state IN ('reserved','ready','claimed')")
      .all() as WorkspaceTransferRecord[];
  }

  private require(id: string): WorkspaceTransferRecord {
    const row = this.sqlite.prepare("SELECT * FROM workspaceTransfer WHERE id = ?").get(id) as
      WorkspaceTransferRecord | undefined;
    if (!row) throw new Error("Workspace transfer disappeared");
    return row;
  }
}
