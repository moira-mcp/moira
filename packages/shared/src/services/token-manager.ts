/**
 * Token Manager Service
 * Database-backed token management for workflow file upload/download
 * Shared between mcp-server and web-backend processes
 */

import { randomUUID } from "crypto";
import { getSqliteInstance } from "../database/connection.js";
import { createLogger } from "../logging/logger.js";
import { DatabaseError } from "../errors/index.js";

const logger = createLogger({ component: "TokenManager" });

export interface WorkflowToken {
  token: string;
  workflowId: string | null; // null for upload (workflow doesn't exist yet)
  userId: string; // User who created the token
  executionId: string | null;
  nodeId: string | null;
  type: "upload" | "download" | "materialize" | "progress-image";
  workflowVersion: string | null;
  executionRevision: number | null;
  optionsJson: string | null;
  claimId?: string | null;
  claimedAt?: number | null;
  expiresAt: number;
  used: boolean;
  createdAt: number;
}

export class TokenManager {
  static readonly MATERIALIZE_TTL_MS = 5 * 60 * 1000;
  static readonly PROGRESS_IMAGE_TTL_MS = 5 * 60 * 1000;
  private static instance: TokenManager;

  private constructor() {
    // Ensure table exists (migration should have created it)
    this.initializeCleanup();
  }

  static getInstance(): TokenManager {
    if (!TokenManager.instance) {
      TokenManager.instance = new TokenManager();
    }
    return TokenManager.instance;
  }

  /**
   * Start periodic cleanup of expired tokens
   */
  private initializeCleanup(): void {
    // Clean up expired tokens every 5 minutes
    setInterval(
      () => {
        this.cleanupExpiredTokens();
      },
      5 * 60 * 1000,
    );
  }

  /**
   * Remove expired tokens from database
   */
  private cleanupExpiredTokens(): void {
    const db = getSqliteInstance();
    const now = Date.now();

    db.prepare("DELETE FROM workflow_tokens WHERE expires_at < ?").run(now);
  }

  createUploadToken(userId: string, ttlMs: number = 3600000): string {
    const db = getSqliteInstance();
    const token = randomUUID();
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO workflow_tokens (token, workflow_id, user_id, type, expires_at, used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(token, null, userId, "upload", now + ttlMs, 0, now);

    return token;
  }

  createDownloadToken(workflowId: string, userId: string, ttlMs: number = 3600000): string {
    const db = getSqliteInstance();
    const token = randomUUID();
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO workflow_tokens (token, workflow_id, user_id, type, expires_at, used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(token, workflowId, userId, "download", now + ttlMs, 0, now);

    return token;
  }

  createMaterializeToken(executionId: string, nodeId: string, userId: string): string {
    try {
      const db = getSqliteInstance();
      const token = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflow_tokens
         (token, workflow_id, execution_id, node_id, user_id, type, expires_at, used, created_at)
         VALUES (?, NULL, ?, ?, ?, 'materialize', ?, 0, ?)`,
      ).run(token, executionId, nodeId, userId, now + TokenManager.MATERIALIZE_TTL_MS, now);
      return token;
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError(
        "Failed to create materialize grant",
        { executionId, nodeId },
        error instanceof Error ? error : undefined,
      );
    }
  }

  createProgressImageToken(
    executionId: string,
    workflowId: string,
    userId: string,
    workflowVersion: string,
    executionRevision: number,
    optionsJson: string,
    ttlMs: number = TokenManager.PROGRESS_IMAGE_TTL_MS,
  ): string {
    const db = getSqliteInstance();
    const token = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow_tokens
       (token, workflow_id, execution_id, user_id, type, workflow_version,
        execution_revision, options_json, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, 'progress-image', ?, ?, ?, ?, 0, ?)`,
    ).run(
      token,
      workflowId,
      executionId,
      userId,
      workflowVersion,
      executionRevision,
      optionsJson,
      now + ttlMs,
      now,
    );
    return token;
  }

  validateToken(
    token: string,
    expectedType: "upload" | "download" | "materialize" | "progress-image",
  ): WorkflowToken | null {
    const db = getSqliteInstance();
    const now = Date.now();

    logger.debug("Validating token", {
      expectedType,
    });

    interface ValidatedTokenRow {
      token: string;
      workflowId: string | null;
      executionId: string | null;
      nodeId: string | null;
      userId: string;
      type: string;
      expiresAt: number;
      used: number;
      createdAt: number;
      workflowVersion: string | null;
      executionRevision: number | null;
      optionsJson: string | null;
      claimId: string | null;
      claimedAt: number | null;
    }
    const row = db
      .prepare(
        `
      SELECT token, workflow_id as workflowId, execution_id as executionId, node_id as nodeId,
             user_id as userId, type, workflow_version as workflowVersion,
             execution_revision as executionRevision, options_json as optionsJson,
             claim_id as claimId, claimed_at as claimedAt,
             expires_at as expiresAt, used, created_at as createdAt
      FROM workflow_tokens
      WHERE token = ? AND type = ? AND used = 0 AND expires_at > ?
    `,
      )
      .get(token, expectedType, now) as ValidatedTokenRow | undefined;

    logger.debug("Token validation result", { valid: !!row });

    if (!row) {
      return null;
    }

    return {
      token: row.token,
      workflowId: row.workflowId,
      executionId: row.executionId,
      nodeId: row.nodeId,
      userId: row.userId,
      type: row.type as WorkflowToken["type"],
      expiresAt: row.expiresAt,
      used: row.used === 1,
      createdAt: row.createdAt,
      workflowVersion: row.workflowVersion,
      executionRevision: row.executionRevision,
      optionsJson: row.optionsJson,
      claimId: row.claimId,
      claimedAt: row.claimedAt,
    };
  }

  reserveProgressImageToken(token: string, claimId: string): boolean {
    const db = getSqliteInstance();
    const result = db
      .prepare(
        `UPDATE workflow_tokens SET claim_id = ?, claimed_at = ?
         WHERE token = ? AND type = 'progress-image' AND used = 0 AND claim_id IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM workflowExecution AS execution
             JOIN workflow ON workflow.id = execution.workflowId
             WHERE execution.executionId = workflow_tokens.execution_id
               AND execution.userId = workflow_tokens.user_id
               AND execution.revision = workflow_tokens.execution_revision
               AND workflow.version = workflow_tokens.workflow_version
           )`,
      )
      .run(claimId, Date.now(), token, Date.now());
    return result.changes === 1;
  }

  completeProgressImageToken(token: string, claimId: string): boolean {
    const result = getSqliteInstance()
      .prepare(
        `UPDATE workflow_tokens SET used = 1, claim_id = NULL, claimed_at = NULL
         WHERE token = ? AND type = 'progress-image' AND used = 0 AND claim_id = ?`,
      )
      .run(token, claimId);
    return result.changes === 1;
  }

  releaseProgressImageToken(token: string, claimId: string): boolean {
    const result = getSqliteInstance()
      .prepare(
        `UPDATE workflow_tokens SET claim_id = NULL, claimed_at = NULL
         WHERE token = ? AND type = 'progress-image' AND used = 0 AND claim_id = ?`,
      )
      .run(token, claimId);
    return result.changes === 1;
  }

  claimProgressImageToken(token: string): boolean {
    const claimId = randomUUID();
    return (
      this.reserveProgressImageToken(token, claimId) &&
      this.completeProgressImageToken(token, claimId)
    );
  }

  claimMaterializeToken(
    token: string,
    executionId: string,
    nodeId: string,
    userId: string,
  ): boolean {
    const db = getSqliteInstance();
    const result = db
      .prepare(
        `UPDATE workflow_tokens SET used = 1
         WHERE token = ? AND type = 'materialize' AND execution_id = ? AND node_id = ?
           AND user_id = ? AND used = 0 AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM workflowExecution AS execution
             WHERE execution.executionId = workflow_tokens.execution_id
               AND execution.userId = workflow_tokens.user_id
               AND execution.state = 'running'
               AND execution.currentNodeId = workflow_tokens.node_id
               AND execution.waitingForInputNodeId = workflow_tokens.node_id
           )`,
      )
      .run(token, executionId, nodeId, userId, Date.now());
    return result.changes === 1;
  }

  markTokenAsUsed(token: string): void {
    const db = getSqliteInstance();

    db.prepare("UPDATE workflow_tokens SET used = 1 WHERE token = ?").run(token);
  }

  deleteToken(token: string): void {
    const db = getSqliteInstance();

    db.prepare("DELETE FROM workflow_tokens WHERE token = ?").run(token);
  }

  // For testing
  getTokenData(token: string): WorkflowToken | undefined {
    const db = getSqliteInstance();

    interface TokenDataRow {
      token: string;
      workflowId: string | null;
      executionId: string | null;
      nodeId: string | null;
      userId: string;
      type: string;
      expiresAt: number;
      used: number;
      createdAt: number;
      workflowVersion: string | null;
      executionRevision: number | null;
      optionsJson: string | null;
      claimId: string | null;
      claimedAt: number | null;
    }
    const row = db
      .prepare(
        `
      SELECT token, workflow_id as workflowId, execution_id as executionId, node_id as nodeId,
             user_id as userId, type, workflow_version as workflowVersion,
             execution_revision as executionRevision, options_json as optionsJson,
             claim_id as claimId, claimed_at as claimedAt,
             expires_at as expiresAt, used, created_at as createdAt
      FROM workflow_tokens
      WHERE token = ?
    `,
      )
      .get(token) as TokenDataRow | undefined;

    if (!row) {
      return undefined;
    }

    return {
      token: row.token,
      workflowId: row.workflowId,
      executionId: row.executionId,
      nodeId: row.nodeId,
      userId: row.userId,
      type: row.type as WorkflowToken["type"],
      expiresAt: row.expiresAt,
      used: row.used === 1,
      createdAt: row.createdAt,
      workflowVersion: row.workflowVersion,
      executionRevision: row.executionRevision,
      optionsJson: row.optionsJson,
      claimId: row.claimId,
      claimedAt: row.claimedAt,
    };
  }

  clear(): void {
    const db = getSqliteInstance();
    db.prepare("DELETE FROM workflow_tokens").run();
  }
}
