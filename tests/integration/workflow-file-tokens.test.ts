/**
 * Workflow File Token Integration Tests
 * Tests token lifecycle: create, validate, use, expire
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  DatabaseError,
  getSqliteInstance,
  metadataRevision,
  TokenManager,
} from "@mcp-moira/shared";
import type { WorkflowExecution, WorkflowGraph } from "@mcp-moira/workflow-engine";
import { createExecutionMaterializeRoutes } from "../../packages/web-backend/src/routes/execution-materialize.js";

describe("Workflow File Tokens", () => {
  let tokenManager: TokenManager;
  const testUserId = "system-admin"; // Use existing admin user

  beforeEach(() => {
    tokenManager = TokenManager.getInstance();
    tokenManager.clear(); // Clean state before each test
  });

  afterEach(() => {
    tokenManager.clear();
    const db = getSqliteInstance();
    db.prepare("DELETE FROM workflowExecution WHERE executionId = ?").run(
      "materialize-token-execution",
    );
    db.prepare("DELETE FROM workflow WHERE id = ?").run("materialize-token-workflow");
    db.prepare("DELETE FROM workflowExecution WHERE executionId = ?").run(
      "progress-token-execution",
    );
    db.prepare("DELETE FROM workflow WHERE id = ?").run("progress-token-workflow");
    jest.restoreAllMocks();
  });

  function seedMaterializeExecution(): void {
    const db = getSqliteInstance();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow
       (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'private', ?, ?)`,
    ).run(
      "materialize-token-workflow",
      testUserId,
      "materialize-token-workflow",
      "Materialize token workflow",
      "1.0.0",
      "{}",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO workflowExecution
       (executionId, workflowId, userId, state, currentNodeId, waitingForInputNodeId, context, createdAt, updatedAt)
       VALUES (?, ?, ?, 'running', 'materialize', 'materialize', '{}', ?, ?)`,
    ).run("materialize-token-execution", "materialize-token-workflow", testUserId, now, now);
  }

  function seedProgressExecution(): void {
    const db = getSqliteInstance();
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflow
       (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
       VALUES ('progress-token-workflow', ?, 'progress-token-workflow', 'Progress', '2.0.0', '{}', 'private', ?, ?)`,
    ).run(testUserId, now, now);
    db.prepare(
      `INSERT INTO workflowExecution
       (executionId, workflowId, userId, state, currentNodeId, context, revision, createdAt, updatedAt)
       VALUES ('progress-token-execution', 'progress-token-workflow', ?, 'running', 'work', '{}', 3, ?, ?)`,
    ).run(testUserId, now, now);
  }

  test("createUploadToken generates valid token", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000); // 1 hour

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const tokenData = tokenManager.getTokenData(token);
    expect(tokenData).toBeDefined();
    expect(tokenData!.type).toBe("upload");
    expect(tokenData!.workflowId).toBeNull();
    expect(tokenData!.userId).toBe(testUserId);
    expect(tokenData!.used).toBe(false);
  });

  test("createDownloadToken generates valid token with workflowId", () => {
    const workflowId = "test-workflow-123";
    const token = tokenManager.createDownloadToken(workflowId, testUserId, 3600000);

    expect(token).toBeDefined();
    const tokenData = tokenManager.getTokenData(token);
    expect(tokenData).toBeDefined();
    expect(tokenData!.type).toBe("download");
    expect(tokenData!.workflowId).toBe(workflowId);
    expect(tokenData!.userId).toBe(testUserId);
    expect(tokenData!.used).toBe(false);
  });

  test("validateToken returns token data for valid token", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);
    const tokenData = tokenManager.validateToken(token, "upload");

    expect(tokenData).toBeDefined();
    expect(tokenData!.token).toBe(token);
    expect(tokenData!.type).toBe("upload");
    expect(tokenData!.userId).toBe(testUserId);
  });

  test("validateToken returns null for wrong type", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);
    const tokenData = tokenManager.validateToken(token, "download");

    expect(tokenData).toBeNull();
  });

  test("validateToken returns null for non-existent token", () => {
    const tokenData = tokenManager.validateToken("non-existent-token", "upload");

    expect(tokenData).toBeNull();
  });

  test("materialize token has a fixed five-minute TTL and execution/node binding", () => {
    seedMaterializeExecution();
    const now = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockReturnValue(now);
    const token = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
    );
    const tokenData = tokenManager.getTokenData(token)!;
    expect(tokenData.type).toBe("materialize");
    expect(tokenData.executionId).toBe("materialize-token-execution");
    expect(tokenData.nodeId).toBe("materialize");
    expect(tokenData.expiresAt - tokenData.createdAt).toBe(TokenManager.MATERIALIZE_TTL_MS);

    jest.spyOn(Date, "now").mockRestore();
    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValue(tokenData.expiresAt - 1);
    expect(tokenManager.validateToken(token, "materialize")).not.toBeNull();
    clock.mockReturnValue(tokenData.expiresAt);
    expect(tokenManager.validateToken(token, "materialize")).toBeNull();
  });

  test("current materialize grant resolves the newest presentation and ignores superseded ones", () => {
    seedMaterializeExecution();
    const superseded = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
    );
    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValue(Date.now() + 1000);
    const current = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
    );
    clock.mockRestore();

    // Serving the superseded grant would deliver a presentation the agent is no longer on.
    const resolved = tokenManager.getCurrentMaterializeGrant(
      "materialize-token-execution",
      testUserId,
    );
    expect(resolved?.token).toBe(current);
    expect(resolved?.token).not.toBe(superseded);
    expect(resolved?.nodeId).toBe("materialize");
  });

  test("current materialize grant is absent for another user and after expiry", () => {
    seedMaterializeExecution();
    const token = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
    );
    const expiresAt = tokenManager.getTokenData(token)!.expiresAt;

    expect(
      tokenManager.getCurrentMaterializeGrant("materialize-token-execution", "someone-else"),
    ).toBeNull();

    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValue(expiresAt - 1);
    expect(
      tokenManager.getCurrentMaterializeGrant("materialize-token-execution", testUserId),
    ).not.toBeNull();
    clock.mockReturnValue(expiresAt);
    expect(
      tokenManager.getCurrentMaterializeGrant("materialize-token-execution", testUserId),
    ).toBeNull();
    clock.mockRestore();
  });

  test("materialize grant creation converts a real SQLite failure to DatabaseError", () => {
    let caught: unknown;
    try {
      tokenManager.createMaterializeToken(
        "missing-materialize-execution",
        "materialize",
        testUserId,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DatabaseError);
    expect((caught as Error).message).toBe("Failed to create materialize grant");
    expect((caught as Error).message).not.toMatch(/SQLITE|FOREIGN KEY/i);
    expect(
      getSqliteInstance().prepare("SELECT COUNT(*) AS count FROM workflow_tokens").get(),
    ).toEqual({ count: 0 });
  });

  test("progress image token is bound, expires, and claims once only while current", () => {
    seedProgressExecution();
    const now = 1_800_000_000_000;
    jest.spyOn(Date, "now").mockReturnValue(now);
    const token = tokenManager.createProgressImageToken(
      "progress-token-execution",
      "progress-token-workflow",
      testUserId,
      "2.0.0",
      3,
      '{"theme":"dark","viewportWidth":720}',
      1000,
    );
    const data = tokenManager.getTokenData(token)!;
    expect(data).toMatchObject({
      type: "progress-image",
      workflowVersion: "2.0.0",
      executionRevision: 3,
      optionsJson: '{"theme":"dark","viewportWidth":720}',
      used: false,
    });
    expect(data.expiresAt).toBe(now + 1000);
    const expiring = tokenManager.createProgressImageToken(
      "progress-token-execution",
      "progress-token-workflow",
      testUserId,
      "2.0.0",
      3,
      "{}",
      1000,
    );
    const clock = jest.spyOn(Date, "now");
    clock.mockReturnValue(now + 999);
    expect(tokenManager.validateToken(expiring, "progress-image")).not.toBeNull();
    clock.mockReturnValue(now + 1000);
    expect(tokenManager.validateToken(expiring, "progress-image")).toBeNull();
    clock.mockReturnValue(now);
    expect(tokenManager.reserveProgressImageToken(token, "claim-a")).toBe(true);
    expect(tokenManager.reserveProgressImageToken(token, "claim-b")).toBe(false);
    expect(tokenManager.releaseProgressImageToken(token, "claim-a")).toBe(true);
    expect(tokenManager.reserveProgressImageToken(token, "claim-b")).toBe(true);
    expect(tokenManager.completeProgressImageToken(token, "claim-b")).toBe(true);
    expect(tokenManager.reserveProgressImageToken(token, "claim-c")).toBe(false);

    const staleRevision = tokenManager.createProgressImageToken(
      "progress-token-execution",
      "progress-token-workflow",
      testUserId,
      "2.0.0",
      3,
      "{}",
      1000,
    );
    getSqliteInstance()
      .prepare(
        "UPDATE workflowExecution SET revision = 4 WHERE executionId = 'progress-token-execution'",
      )
      .run();
    expect(tokenManager.claimProgressImageToken(staleRevision)).toBe(false);
    getSqliteInstance()
      .prepare(
        "UPDATE workflowExecution SET revision = 3 WHERE executionId = 'progress-token-execution'",
      )
      .run();
    getSqliteInstance()
      .prepare("UPDATE workflow SET version = '2.1.0' WHERE id = 'progress-token-workflow'")
      .run();
    expect(tokenManager.claimProgressImageToken(staleRevision)).toBe(false);
    clock.mockRestore();
  });

  test("materialize authorization is reusable during its TTL and checks every binding", () => {
    seedMaterializeExecution();
    const create = () =>
      tokenManager.createMaterializeToken("materialize-token-execution", "materialize", testUserId);

    const wrongBindingToken = create();
    expect(tokenManager.validateToken(wrongBindingToken, "download")).toBeNull();
    expect(
      tokenManager.authorizeMaterializeToken(
        wrongBindingToken,
        "materialize-token-execution",
        "wrong-node",
        testUserId,
      ),
    ).toBe(false);
    expect(
      tokenManager.authorizeMaterializeToken(
        wrongBindingToken,
        "wrong-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(
      tokenManager.authorizeMaterializeToken(
        wrongBindingToken,
        "materialize-token-execution",
        "materialize",
        "wrong-user",
      ),
    ).toBe(false);
    expect(tokenManager.validateToken(wrongBindingToken, "materialize")).not.toBeNull();

    const uploadToken = tokenManager.createUploadToken(testUserId);
    expect(
      tokenManager.authorizeMaterializeToken(
        uploadToken,
        "materialize-token-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(tokenManager.getTokenData(uploadToken)?.used).toBe(false);

    const fixedNow = 1_800_000_000_000;
    const clock = jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    const expiredAtClaim = create();
    const expiry = tokenManager.getTokenData(expiredAtClaim)!.expiresAt;
    clock.mockReturnValue(expiry);
    expect(
      tokenManager.authorizeMaterializeToken(
        expiredAtClaim,
        "materialize-token-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(tokenManager.getTokenData(expiredAtClaim)?.used).toBe(false);
    clock.mockRestore();

    const advancedExecutionToken = create();
    getSqliteInstance()
      .prepare(
        `UPDATE workflowExecution
         SET currentNodeId = 'end', waitingForInputNodeId = NULL
         WHERE executionId = ?`,
      )
      .run("materialize-token-execution");
    expect(
      tokenManager.authorizeMaterializeToken(
        advancedExecutionToken,
        "materialize-token-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(tokenManager.getTokenData(advancedExecutionToken)?.used).toBe(false);
    getSqliteInstance()
      .prepare(
        `UPDATE workflowExecution
         SET currentNodeId = 'materialize', waitingForInputNodeId = 'materialize'
         WHERE executionId = ?`,
      )
      .run("materialize-token-execution");

    const completedExecutionToken = create();
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET state = 'completed' WHERE executionId = ?")
      .run("materialize-token-execution");
    expect(
      tokenManager.authorizeMaterializeToken(
        completedExecutionToken,
        "materialize-token-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(tokenManager.getTokenData(completedExecutionToken)?.used).toBe(false);
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET state = 'running' WHERE executionId = ?")
      .run("materialize-token-execution");

    const token = create();
    const authorize = () =>
      tokenManager.authorizeMaterializeToken(
        token,
        "materialize-token-execution",
        "materialize",
        testUserId,
      );
    expect(authorize()).toBe(true);
    expect(authorize()).toBe(true);
    expect(tokenManager.getTokenData(token)?.used).toBe(false);
    expect(tokenManager.validateToken(token, "materialize")).not.toBeNull();
  });

  test("one materialize URL downloads repeatedly through HTTP until expiry or node transition", async () => {
    seedMaterializeExecution();
    const graph: WorkflowGraph = {
      id: "materialize-token-workflow",
      metadata: { name: "Materialize", version: "1.0.0", description: "Integration" },
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        {
          id: "materialize",
          type: "materialize",
          basePath: "workspace",
          files: [{ path: "guide.md", content: "" }],
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    const execution: WorkflowExecution = {
      revision: 0,
      executionId: "materialize-token-execution",
      workflowId: "materialize-token-workflow",
      userId: testUserId,
      currentNodeId: "materialize",
      waitingForInputNodeId: "materialize",
      globalContext: {
        executionId: "materialize-token-execution",
        workflowId: "materialize-token-workflow",
        userId: testUserId,
        variables: {},
        nodeStates: {},
      },
      status: "running",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const repository = {
      getExecution: async () => execution,
      getWorkflowGraph: async () => graph,
    };
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(tokenManager, repository),
    );
    const token = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
      metadataRevision(execution.globalContext),
    );
    const url = `/api/public/executions/materialize/${token}`;

    await request(app)
      .get(url)
      .expect(200)
      .expect("Content-Type", /application\/x-tar/);
    await request(app)
      .get(url)
      .expect(200)
      .expect("Content-Type", /application\/x-tar/);

    execution.globalContext.variables.changed = true;
    await request(app).get(url).expect(401);
    execution.globalContext.variables = {};

    getSqliteInstance()
      .prepare(
        `UPDATE workflowExecution
         SET currentNodeId = 'end', waitingForInputNodeId = NULL
         WHERE executionId = ?`,
      )
      .run("materialize-token-execution");
    await request(app).get(url).expect(401);

    getSqliteInstance()
      .prepare(
        `UPDATE workflowExecution
         SET currentNodeId = 'materialize', waitingForInputNodeId = 'materialize'
         WHERE executionId = ?`,
      )
      .run("materialize-token-execution");
    const expiring = tokenManager.createMaterializeToken(
      "materialize-token-execution",
      "materialize",
      testUserId,
    );
    const expiry = tokenManager.getTokenData(expiring)!.expiresAt;
    const clock = jest.spyOn(Date, "now").mockReturnValue(expiry);
    await request(app).get(`/api/public/executions/materialize/${expiring}`).expect(401);
    clock.mockRestore();
  });

  test("markTokenAsUsed prevents reuse", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);

    // First validation succeeds
    let tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeDefined();

    // Mark as used
    tokenManager.markTokenAsUsed(token);

    // Second validation fails
    tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeNull();
  });

  test("expired token is automatically invalid", async () => {
    const token = tokenManager.createUploadToken(testUserId, 100); // 100ms TTL

    // Initially valid
    let tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeDefined();

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Now invalid (validateToken checks expiry)
    tokenData = tokenManager.validateToken(token, "upload");
    expect(tokenData).toBeNull();

    // getTokenData still returns data (doesn't check expiry, only validateToken does)
    const rawData = tokenManager.getTokenData(token);
    expect(rawData).toBeDefined();
    expect(rawData!.expiresAt).toBeLessThan(Date.now());
  });

  test("deleteToken removes token immediately", () => {
    const token = tokenManager.createUploadToken(testUserId, 3600000);

    // Token exists
    expect(tokenManager.getTokenData(token)).toBeDefined();

    // Delete
    tokenManager.deleteToken(token);

    // Token gone
    expect(tokenManager.getTokenData(token)).toBeUndefined();
    expect(tokenManager.validateToken(token, "upload")).toBeNull();
  });

  test("multiple tokens can coexist", () => {
    const uploadToken = tokenManager.createUploadToken(testUserId, 3600000);
    const downloadToken = tokenManager.createDownloadToken("workflow-1", testUserId, 3600000);

    expect(tokenManager.validateToken(uploadToken, "upload")).toBeDefined();
    expect(tokenManager.validateToken(downloadToken, "download")).toBeDefined();

    // Each token has correct type
    expect(tokenManager.validateToken(uploadToken, "download")).toBeNull();
    expect(tokenManager.validateToken(downloadToken, "upload")).toBeNull();
  });

  test("clear removes all tokens", () => {
    const token1 = tokenManager.createUploadToken(testUserId, 3600000);
    const token2 = tokenManager.createDownloadToken("workflow-1", testUserId, 3600000);
    const token3 = tokenManager.createDownloadToken("workflow-2", testUserId, 3600000);

    tokenManager.clear();

    // All tokens gone from database
    expect(tokenManager.getTokenData(token1)).toBeUndefined();
    expect(tokenManager.getTokenData(token2)).toBeUndefined();
    expect(tokenManager.getTokenData(token3)).toBeUndefined();
  });
});
