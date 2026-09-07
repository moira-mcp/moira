import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getSqliteInstance } from "../database/connection.js";

export const COMMUNICATION_UPLOAD_AUDIENCE = "communication-upload";
export const COMMUNICATION_GRANT_PURPOSE = "notification";
export const COMMUNICATION_GRANT_TTL_MS = 5 * 60 * 1000;
export const MAX_COMMUNICATION_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_OUTSTANDING_COMMUNICATION_GRANTS_PER_USER = 10;
export const MAX_OUTSTANDING_COMMUNICATION_GRANTS_GLOBAL = 1000;

export type CommunicationGrantKind = "image" | "document";
export type CommunicationGrantFormat = "plain" | "markdown" | "html";

export interface CreateCommunicationAttachmentGrant {
  userId: string;
  message: string;
  format?: CommunicationGrantFormat;
  silent?: boolean;
  kind: CommunicationGrantKind;
  filename: string;
  mimeType: string;
  declaredSize: number;
}

export interface CommunicationAttachmentGrantRecord extends CreateCommunicationAttachmentGrant {
  tokenDigest: string;
  correlationId: string;
  format: CommunicationGrantFormat;
  silent: boolean;
  audience: typeof COMMUNICATION_UPLOAD_AUDIENCE;
  purpose: typeof COMMUNICATION_GRANT_PURPOSE;
  claimId: string;
  expiresAt: number;
}

export class CommunicationGrantQuotaError extends Error {
  constructor() {
    super("Too many outstanding communication attachment grants");
    this.name = "CommunicationGrantQuotaError";
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class CommunicationAttachmentGrantService {
  constructor(
    private readonly db: Database.Database = getSqliteInstance(),
    private readonly now: () => number = Date.now,
  ) {}

  create(input: CreateCommunicationAttachmentGrant): {
    grant: string;
    correlationId: string;
    expiresAt: number;
  } {
    const now = this.now();
    const expiresAt = now + COMMUNICATION_GRANT_TTL_MS;
    const grant = randomBytes(32).toString("base64url");
    const correlationId = randomUUID();
    this.db.transaction(() => {
      this.cleanup(now);
      const userCount = this.countPending("user_id = ?", input.userId, now);
      const globalCount = this.countPending("1 = 1", undefined, now);
      if (
        userCount >= MAX_OUTSTANDING_COMMUNICATION_GRANTS_PER_USER ||
        globalCount >= MAX_OUTSTANDING_COMMUNICATION_GRANTS_GLOBAL
      ) {
        throw new CommunicationGrantQuotaError();
      }
      this.db
        .prepare(
          `INSERT INTO communication_attachment_grant
           (token_digest, user_id, correlation_id, audience, purpose, message, format, silent,
            kind, filename, mime_type, declared_size, state, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          digest(grant),
          input.userId,
          correlationId,
          COMMUNICATION_UPLOAD_AUDIENCE,
          COMMUNICATION_GRANT_PURPOSE,
          input.message,
          input.format ?? "plain",
          input.silent ? 1 : 0,
          input.kind,
          input.filename,
          input.mimeType,
          input.declaredSize,
          expiresAt,
          now,
        );
    })();
    return { grant, correlationId, expiresAt };
  }

  reserve(grant: string, userId: string): CommunicationAttachmentGrantRecord | null {
    const now = this.now();
    const tokenDigest = digest(grant);
    const claimId = randomUUID();
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE communication_attachment_grant SET state = 'claimed', claim_id = ?, claimed_at = ?
         WHERE token_digest = ? AND user_id = ? AND audience = ? AND purpose = ?
           AND state = 'pending' AND expires_at > ?`,
        )
        .run(
          claimId,
          now,
          tokenDigest,
          userId,
          COMMUNICATION_UPLOAD_AUDIENCE,
          COMMUNICATION_GRANT_PURPOSE,
          now,
        );
      if (result.changes !== 1) return null;
      const row = this.db
        .prepare(
          `SELECT token_digest AS tokenDigest, user_id AS userId, correlation_id AS correlationId,
                audience, purpose, message, format, silent, kind, filename, mime_type AS mimeType,
                declared_size AS declaredSize, claim_id AS claimId, expires_at AS expiresAt
         FROM communication_attachment_grant WHERE token_digest = ? AND claim_id = ?`,
        )
        .get(tokenDigest, claimId) as Omit<CommunicationAttachmentGrantRecord, "silent"> & {
        silent: number;
      };
      return { ...row, silent: row.silent === 1 };
    })();
  }

  complete(tokenDigest: string, claimId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE communication_attachment_grant SET state = 'completed', completed_at = ?, claim_id = NULL
       WHERE token_digest = ? AND state = 'claimed' AND claim_id = ?`,
        )
        .run(this.now(), tokenDigest, claimId).changes === 1
    );
  }

  release(tokenDigest: string, claimId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE communication_attachment_grant SET state = 'pending', claim_id = NULL, claimed_at = NULL
       WHERE token_digest = ? AND state = 'claimed' AND claim_id = ? AND expires_at > ?`,
        )
        .run(tokenDigest, claimId, this.now()).changes === 1
    );
  }

  cleanup(now = this.now()): void {
    this.db
      .prepare(
        `DELETE FROM communication_attachment_grant
       WHERE expires_at <= ? OR (state = 'completed' AND completed_at <= ?)`,
      )
      .run(now, now - COMMUNICATION_GRANT_TTL_MS);
  }

  private countPending(clause: string, value: string | undefined, now: number): number {
    const statement = this.db.prepare(
      `SELECT COUNT(*) AS count FROM communication_attachment_grant
       WHERE ${clause} AND state IN ('pending', 'claimed') AND expires_at > ?`,
    );
    const row = (value === undefined ? statement.get(now) : statement.get(value, now)) as {
      count: number;
    };
    return row.count;
  }
}
