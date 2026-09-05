import { describe, expect, it } from "@jest/globals";
import type { IDataRepository } from "@mcp-moira/workflow-engine";
import {
  checkTrustedLockDeliveryConfiguration,
  createTrustedExecutionLock,
  TrustedLockDeliveryError,
  type TrustedLockDeliveryDependencies,
} from "@mcp-moira/workflow-engine";

const PIN = "654321";

function repositoryWithSettings(values: Record<string, string | null>): IDataRepository {
  return {
    getSetting: async (_userId: string, key: string) => values[key] ?? null,
    getWorkflow: async () => ({ metadata: { name: "Trusted workflow" } }),
  } as unknown as IDataRepository;
}

function options() {
  return {
    executionId: "12345678-1234-4123-8123-123456789abc",
    workflowId: "workflow-id",
    nodeId: "lock-gate",
    reason: "Human approval required",
    userId: "user-id",
  };
}

describe("trusted agent-path lock delivery", () => {
  it("turns setting-storage failures into a fixed safe configuration error", async () => {
    const repository = {
      getSetting: async () => {
        throw new Error(`storage response accidentally included ${PIN}`);
      },
    } as unknown as IDataRepository;

    const error = await createTrustedExecutionLock(repository, options()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TrustedLockDeliveryError);
    expect((error as Error).message).toContain("not configured");
    expect(JSON.stringify(error)).not.toContain(PIN);
  });

  it("rejects missing settings before generating a lock secret", async () => {
    let createCalls = 0;
    const dependencies: TrustedLockDeliveryDependencies = {
      lockService: {
        createLockWithDelivery: async () => {
          createCalls += 1;
          return { lockId: "unexpected" };
        },
      },
    };

    await expect(
      createTrustedExecutionLock(repositoryWithSettings({}), options(), dependencies),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "TrustedLockDeliveryError",
        message: expect.not.stringContaining(PIN),
      }),
    );
    expect(createCalls).toBe(0);
  });

  it("rejects malformed configuration before generating a lock secret", async () => {
    let createCalls = 0;
    const repository = repositoryWithSettings({
      "telegram.bot_token": "malformed",
      "telegram.chat_id": "42",
    });
    const dependencies: TrustedLockDeliveryDependencies = {
      clientFactory: () => {
        throw new Error("invalid token");
      },
      lockService: {
        createLockWithDelivery: async () => {
          createCalls += 1;
          return { lockId: "unexpected" };
        },
      },
    };

    await expect(createTrustedExecutionLock(repository, options(), dependencies)).rejects.toEqual(
      expect.objectContaining({
        name: "TrustedLockDeliveryError",
        message: expect.stringContaining("configuration is invalid"),
      }),
    );
    expect(createCalls).toBe(0);
    await expect(
      checkTrustedLockDeliveryConfiguration(repository, options().userId, dependencies),
    ).resolves.toEqual({ configured: false, reason: "invalid" });
  });

  it("returns a fixed safe error when the sender failure contains the real PIN", async () => {
    let trustedMessage = "";
    const capturedLogs: unknown[] = [];
    const dependencies: TrustedLockDeliveryDependencies = {
      clientFactory: () => ({
        sendMessage: async ({ text }) => {
          trustedMessage = text;
          const failure = new Error(`transport echoed ${PIN}`) as Error & { type: string };
          failure.type = PIN;
          throw failure;
        },
      }),
      lockService: {
        createLockWithDelivery: async (_lockOptions, deliver) => {
          await deliver({ lockId: "failed-lock", pin: PIN });
          return { lockId: "failed-lock" };
        },
      },
      logger: {
        info: (message, metadata) => capturedLogs.push({ message, metadata }),
        warn: (message, metadata) => capturedLogs.push({ message, metadata }),
      },
    };

    const error = await createTrustedExecutionLock(
      repositoryWithSettings({
        "telegram.bot_token": "123:valid-shape",
        "telegram.chat_id": "42",
      }),
      options(),
      dependencies,
    ).catch((caught: unknown) => caught);

    expect(trustedMessage).toContain(PIN);
    expect(error).toBeInstanceOf(TrustedLockDeliveryError);
    expect(JSON.stringify(error)).not.toContain(PIN);
    expect((error as Error).message).not.toContain(PIN);
    expect(JSON.stringify(capturedLogs)).not.toContain(PIN);
  });

  it("delivers to the configured chat and returns only non-secret lock identity", async () => {
    let delivered:
      | {
          chatId: string;
          text: string;
          parseMode?: string;
          replyMarkup?: Record<string, unknown>;
        }
      | undefined;
    const capturedLogs: unknown[] = [];
    const dependencies: TrustedLockDeliveryDependencies = {
      clientFactory: (botToken, chatId) => {
        expect(botToken).toBe("123:valid-shape");
        expect(chatId).toBe("42");
        return {
          sendMessage: async (params) => {
            delivered = params as typeof delivered;
            return { ok: true } as never;
          },
        };
      },
      lockService: {
        createLockWithDelivery: async (_lockOptions, deliver) => {
          await deliver({ lockId: "delivered-lock", pin: PIN });
          return { lockId: "delivered-lock" };
        },
      },
      logger: {
        info: (message, metadata) => capturedLogs.push({ message, metadata }),
        warn: (message, metadata) => capturedLogs.push({ message, metadata }),
      },
    };

    const result = await createTrustedExecutionLock(
      repositoryWithSettings({
        "telegram.bot_token": "123:valid-shape",
        "telegram.chat_id": "42",
      }),
      { ...options(), reason: "Review [stage]_* without Telegram markup parsing" },
      dependencies,
    );

    expect(result).toEqual({ lockId: "delivered-lock" });
    expect(result).not.toHaveProperty("pin");
    expect(delivered).toEqual(
      expect.objectContaining({
        chatId: "42",
        text: expect.stringContaining(PIN),
        replyMarkup: expect.any(Object),
      }),
    );
    expect(delivered).not.toHaveProperty("parseMode");
    expect(delivered?.text).toContain("Review [stage]_*");
    expect(JSON.stringify(capturedLogs)).not.toContain(PIN);
  });
});
