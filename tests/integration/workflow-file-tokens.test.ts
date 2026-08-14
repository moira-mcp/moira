/**
 * Workflow File Token Integration Tests
 * Tests token lifecycle: create, validate, use, expire
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { Worker } from "node:worker_threads";
import { DatabaseError, getSqliteInstance, TokenManager } from "@mcp-moira/shared";

interface ClaimWorkerHandle {
  worker: Worker;
  ready: Promise<void>;
  result: Promise<boolean>;
}

function createClaimWorker(): ClaimWorkerHandle {
  const tsxApiUrl = import.meta.resolve("tsx/esm/api");
  const tokenManagerUrl = new URL(
    "../../packages/shared/src/services/token-manager.ts",
    import.meta.url,
  ).href;
  const source = `
    import { parentPort } from "node:worker_threads";
    import { register } from ${JSON.stringify(tsxApiUrl)};
    register();
    const { TokenManager } = await import(${JSON.stringify(tokenManagerUrl)});
    parentPort.postMessage({ type: "ready" });
    parentPort.once("message", (binding) => {
      try {
        const claimed = TokenManager.getInstance().claimMaterializeToken(
          binding.token,
          binding.executionId,
          binding.nodeId,
          binding.userId,
        );
        parentPort.postMessage({ type: "result", claimed });
        setImmediate(() => process.exit(0));
      } catch (error) {
        parentPort.postMessage({
          type: "error",
          error: error instanceof Error ? error.stack : String(error),
        });
        setImmediate(() => process.exit(1));
      }
    });
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    type: "module",
  });
  let resolveReady!: () => void;
  let resolveResult!: (claimed: boolean) => void;
  let rejectReady!: (error: Error) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const result = new Promise<boolean>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  worker.on("message", (message: { type: string; claimed?: boolean; error?: string }) => {
    if (message.type === "ready") resolveReady();
    if (message.type === "result") resolveResult(message.claimed === true);
    if (message.type === "error") rejectResult(new Error(message.error));
  });
  worker.once("error", (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  return { worker, ready, result };
}

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

  test("materialize claim is atomic, one-use, and checks every binding", async () => {
    seedMaterializeExecution();
    const create = () =>
      tokenManager.createMaterializeToken("materialize-token-execution", "materialize", testUserId);

    const wrongBindingToken = create();
    expect(tokenManager.validateToken(wrongBindingToken, "download")).toBeNull();
    expect(
      tokenManager.claimMaterializeToken(
        wrongBindingToken,
        "materialize-token-execution",
        "wrong-node",
        testUserId,
      ),
    ).toBe(false);
    expect(
      tokenManager.claimMaterializeToken(
        wrongBindingToken,
        "wrong-execution",
        "materialize",
        testUserId,
      ),
    ).toBe(false);
    expect(
      tokenManager.claimMaterializeToken(
        wrongBindingToken,
        "materialize-token-execution",
        "materialize",
        "wrong-user",
      ),
    ).toBe(false);
    expect(tokenManager.validateToken(wrongBindingToken, "materialize")).not.toBeNull();

    const uploadToken = tokenManager.createUploadToken(testUserId);
    expect(
      tokenManager.claimMaterializeToken(
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
      tokenManager.claimMaterializeToken(
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
      tokenManager.claimMaterializeToken(
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
      tokenManager.claimMaterializeToken(
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
    const workers = [createClaimWorker(), createClaimWorker()];
    await Promise.all(workers.map((worker) => worker.ready));
    for (const { worker } of workers) {
      worker.postMessage({
        token,
        executionId: "materialize-token-execution",
        nodeId: "materialize",
        userId: testUserId,
      });
    }
    const claims = await Promise.all(workers.map((worker) => worker.result));
    expect(claims.sort()).toEqual([false, true]);
    expect(tokenManager.validateToken(token, "materialize")).toBeNull();
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
