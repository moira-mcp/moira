import { afterAll, afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { eq } from "drizzle-orm";
import {
  auditLog,
  executionLock,
  getDatabase,
  getLockService,
  getWorkflowService,
  isHashedPin,
  user,
} from "@mcp-moira/shared";
import {
  createTrustedExecutionLock,
  DatabaseRepository,
  resetClientFactory,
  setTestClientFactory,
  UniversalGraphExecutor,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { manageLocks } from "../../packages/mcp-server/src/tools/manage-locks.js";

const suffix = `${Date.now()}`;
const TEST_USER_ID = `trusted-lock-${suffix}`;
const VALID_TOKEN = "123456:trusted-lock-test";
const CHAT_ID = "424242";

const graph: WorkflowGraph = {
  metadata: {
    name: `Trusted Lock Lifecycle ${suffix}`,
    version: "1.0.0",
    description: "Exercises production LockHandler delivery failure and persisted re-entry",
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "lock-gate" } },
    {
      id: "lock-gate",
      type: "lock",
      reason: "Human approval is required",
      connections: { unlocked: "end" },
    },
    { id: "end", type: "end" },
  ],
};

type FailureKind = "missing" | "malformed" | "send";

describe("production LockHandler trusted-delivery lifecycle", () => {
  const repository = new DatabaseRepository();
  const executor = new UniversalGraphExecutor(repository);
  const lockService = getLockService();
  const executionIds: string[] = [];
  let workflowId = "";
  let savedGraph: WorkflowGraph;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.invalid`,
        name: "Trusted Lock Test User",
        handle: TEST_USER_ID,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const saved = await getWorkflowService().save({
      graph,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    workflowId = saved.id;
    savedGraph = (await repository.getWorkflowGraph(workflowId, TEST_USER_ID))!;
  });

  afterEach(async () => {
    resetClientFactory();
    await repository.deleteUserSettingValue(TEST_USER_ID, "telegram.bot_token");
    await repository.deleteUserSettingValue(TEST_USER_ID, "telegram.chat_id");
  });

  afterAll(async () => {
    for (const executionId of executionIds) {
      await repository.deleteExecution(executionId);
    }
    await repository.deleteWorkflow(workflowId, TEST_USER_ID);
    resetClientFactory();
  });

  async function newExecution(): Promise<string> {
    const executionId = await executor.startWorkflow(savedGraph, undefined, TEST_USER_ID);
    executionIds.push(executionId);
    return executionId;
  }

  async function configureValidTelegram(): Promise<void> {
    await repository.setSetting(TEST_USER_ID, "telegram.bot_token", VALID_TOKEN);
    await repository.setSetting(TEST_USER_ID, "telegram.chat_id", CHAT_ID);
  }

  async function exerciseFailureAndRetry(kind: FailureKind): Promise<void> {
    const executionId = await newExecution();
    let failedPin: string | undefined;

    if (kind === "malformed") {
      await repository.setSetting(TEST_USER_ID, "telegram.bot_token", "malformed-token");
      await repository.setSetting(TEST_USER_ID, "telegram.chat_id", CHAT_ID);
      resetClientFactory();
    } else if (kind === "send") {
      await configureValidTelegram();
      setTestClientFactory(
        () =>
          ({
            sendMessage: async ({ text }: { text: string }) => {
              failedPin = text.match(/PIN: (\d{6})/)?.[1];
              throw new Error(`sender echoed ${failedPin}`);
            },
          }) as never,
      );
    }

    const failedResponse = await executor.executeStep(executionId);
    const failedExecution = await repository.getExecution(executionId);
    const visibleHistory = await lockService.listLocks(executionId);
    const rawLocks = await getDatabase()
      .select()
      .from(executionLock)
      .where(eq(executionLock.executionId, executionId));
    const audits = await getDatabase()
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, executionId));

    expect(failedExecution?.status).toBe("running");
    expect(failedExecution?.currentNodeId).toBe("lock-gate");
    expect(failedExecution?.globalContext.variables).not.toHaveProperty("_lockId");
    expect(await lockService.getActiveLock(executionId)).toBeNull();
    expect(visibleHistory).toEqual([]);
    expect(failedResponse).toContain("Trusted Telegram PIN delivery");
    expect(failedResponse).not.toContain("lock_created");

    if (kind === "send") {
      expect(failedPin).toMatch(/^\d{6}$/);
      expect(rawLocks).toHaveLength(1);
      expect(rawLocks[0].status).toBe("delivery_failed");
      expect(rawLocks[0].pin).not.toBe(failedPin);
      expect(isHashedPin(rawLocks[0].pin)).toBe(true);
      const publicFailureProjections = JSON.stringify({
        failedResponse,
        executionErrors: failedExecution?.errors,
        visibleHistory,
        audits,
      });
      expect(publicFailureProjections).not.toContain(failedPin!);
    } else {
      expect(failedPin).toBeUndefined();
      expect(rawLocks).toEqual([]);
    }

    await configureValidTelegram();
    let deliveredPin = "";
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ chatId, text }: { chatId: string; text: string }) => {
            expect(chatId).toBe(CHAT_ID);
            deliveredPin = text.match(/PIN: (\d{6})/)?.[1] ?? "";
            return { ok: true };
          },
        }) as never,
    );

    const retryResponse = await executor.executeStep(executionId);
    const activeExecution = await repository.getExecution(executionId);
    const activeLock = await lockService.getActiveLock(executionId);
    const successAudits = await getDatabase()
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, executionId));
    expect(retryResponse).toContain("lock_created");
    expect(retryResponse).not.toContain(deliveredPin);
    expect(activeExecution?.currentNodeId).toBe("lock-gate");
    expect(activeExecution?.globalContext.variables._lockId).toBe(activeLock?.id);
    expect(activeLock?.pin).not.toBe(deliveredPin);
    expect(isHashedPin(activeLock!.pin)).toBe(true);
    expect(
      JSON.stringify({ retryResponse, activeExecution, activeLock, successAudits }),
    ).not.toContain(deliveredPin);

    await expect(lockService.validatePin(activeLock!.id, deliveredPin)).resolves.toEqual({
      valid: true,
      lockStatus: "unlocked",
    });
    await expect(executor.executeStep(executionId)).resolves.toContain(
      "Workflow completed successfully",
    );
  }

  test("missing settings fail before PIN generation and the same execution retries safely", async () => {
    await exerciseFailureAndRetry("missing");
  });

  test("malformed configuration fails before PIN generation and the same execution retries safely", async () => {
    await exerciseFailureAndRetry("malformed");
  });

  test("send failure hides and invalidates the generated PIN before a fresh successful retry", async () => {
    await exerciseFailureAndRetry("send");
  });

  test("failed-attempt invalidation preserves an earlier persisted context reference", async () => {
    const executionId = await newExecution();
    const earlier = await lockService.createLock({
      executionId,
      nodeId: "earlier-human-lock",
      reason: "Earlier human-mediated lock",
      lockedBy: TEST_USER_ID,
    });
    await lockService.validatePin(earlier.lockId, earlier.pin);

    const execution = (await repository.getExecution(executionId))!;
    execution.globalContext.variables._lockId = earlier.lockId;
    await repository.saveExecution(execution);

    await configureValidTelegram();
    let failedPin = "";
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ text }: { text: string }) => {
            failedPin = text.match(/PIN: (\d{6})/)?.[1] ?? "";
            throw new Error(`sender echoed ${failedPin}`);
          },
        }) as never,
    );

    await expect(
      createTrustedExecutionLock(repository, {
        executionId,
        workflowId,
        nodeId: "later-agent-lock",
        reason: "Later failed agent attempt",
        userId: TEST_USER_ID,
      }),
    ).rejects.toThrow("Trusted Telegram PIN delivery failed");

    const reloaded = await repository.getExecution(executionId);
    const locks = await getDatabase()
      .select()
      .from(executionLock)
      .where(eq(executionLock.executionId, executionId));
    expect(reloaded?.globalContext.variables._lockId).toBe(earlier.lockId);
    expect(locks).toContainEqual(
      expect.objectContaining({ id: earlier.lockId, status: "unlocked" }),
    );
    expect(locks).toContainEqual(expect.objectContaining({ status: "delivery_failed" }));
    expect(
      JSON.stringify({ reloaded, visible: await lockService.listLocks(executionId) }),
    ).not.toContain(failedPin);
  });

  test("MCP lock creation delivers the PIN and returns only non-secret metadata", async () => {
    const executionId = await newExecution();
    await configureValidTelegram();
    let deliveredPin = "";
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ chatId, text }: { chatId: string; text: string }) => {
            expect(chatId).toBe(CHAT_ID);
            deliveredPin = text.match(/PIN: (\d{6})/)?.[1] ?? "";
            return { ok: true };
          },
        }) as never,
    );

    const result = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      manageLocks({
        action: "lock",
        executionId,
        reason: "MCP-requested human approval",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual(expect.objectContaining({ locked: true }));
    expect(result.data).not.toHaveProperty("pin");
    expect(JSON.stringify(result)).not.toContain(deliveredPin);
    const active = await lockService.getActiveLock(executionId);
    expect(active?.id).toBe(result.data.lockId);
    expect(active?.pin).not.toBe(deliveredPin);
    await expect(lockService.validatePin(active!.id, deliveredPin)).resolves.toEqual({
      valid: true,
      lockStatus: "unlocked",
    });
  });

  test("MCP lock send failure returns a safe error and no usable lock", async () => {
    const executionId = await newExecution();
    await configureValidTelegram();
    let failedPin = "";
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ text }: { text: string }) => {
            failedPin = text.match(/PIN: (\d{6})/)?.[1] ?? "";
            throw new Error(`sender echoed ${failedPin}`);
          },
        }) as never,
    );

    const result = await runWithMCPContext({ userId: TEST_USER_ID }, () =>
      manageLocks({ action: "lock", executionId, reason: "MCP failed delivery" }),
    );
    const visibleHistory = await lockService.listLocks(executionId);
    const audits = await getDatabase()
      .select()
      .from(auditLog)
      .where(eq(auditLog.resourceId, executionId));

    expect(failedPin).toMatch(/^\d{6}$/);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Trusted Telegram PIN delivery failed");
    expect(await lockService.getActiveLock(executionId)).toBeNull();
    expect(visibleHistory).toEqual([]);
    expect(JSON.stringify({ result, visibleHistory, audits })).not.toContain(failedPin);
  });
});
