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
  type: "upload" | "download" | "materialize";
  expiresAt: number;
  used: boolean;
  createdAt: number;
}

export class TokenManager {
  static readonly MATERIALIZE_TTL_MS = 5 * 60 * 1000;
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

  validateToken(
    token: string,
    expectedType: "upload" | "download" | "materialize",
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
    }
    const row = db
      .prepare(
        `
      SELECT token, workflow_id as workflowId, execution_id as executionId, node_id as nodeId,
             user_id as userId, type, expires_at as expiresAt, used, created_at as createdAt
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
    };
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
    }
    const row = db
      .prepare(
        `
      SELECT token, workflow_id as workflowId, execution_id as executionId, node_id as nodeId,
             user_id as userId, type, expires_at as expiresAt, used, created_at as createdAt
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
    };
  }

  clear(): void {
    const db = getSqliteInstance();
    db.prepare("DELETE FROM workflow_tokens").run();
  }
}
