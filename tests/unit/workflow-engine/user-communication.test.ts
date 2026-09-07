import { afterEach, describe, expect, jest, test } from "@jest/globals";
import {
  AgentMessageQueue,
  CommunicationChannelError,
  CommunicationChannelRegistry,
  GraphValidator,
  GraphExecutionEngine,
  InMemoryRepository,
  TelegramCommunicationAdapter,
  TelegramErrorType,
  UserCommunicationService,
  UserNotificationHandler,
  builtinNodeTypeDescriptors,
  getActiveCommunicationChannelRegistry,
  getActiveUserCommunicationService,
  resetClientFactory,
  setTestClientFactory,
} from "@mcp-moira/workflow-engine";
import type {
  CommunicationChannelAdapter,
  IDataRepository,
  IGraphExecutionEngine,
  PortableCommunicationMessage,
  UserNotificationNode,
} from "@mcp-moira/workflow-engine";

const repository = {} as IDataRepository;

afterEach(() => {
  resetClientFactory();
  jest.useRealTimers();
});

function adapter(
  id: string,
  deliver: CommunicationChannelAdapter["deliver"],
  configured = true,
  capabilities: Partial<CommunicationChannelAdapter["capabilities"]> = {},
): CommunicationChannelAdapter {
  return {
    id,
    provider: id,
    capabilities: { text: true, image: true, document: true, trusted: false, ...capabilities },
    metadata: {
      title: id,
      origin: "extension",
      extensionName: "test",
      settingKeys: [],
    },
    isConfigured: async () => configured,
    deliver,
  };
}

describe("UserCommunicationService", () => {
  test("tests one registered channel through the common limits without fanning out", async () => {
    const calls: string[] = [];
    const registry = new CommunicationChannelRegistry([
      adapter("selected", async (message) => calls.push(`selected:${message.text}`)),
      adapter("other", async () => calls.push("other")),
    ]);
    const service = new UserCommunicationService(registry, { maxRequestsPerWindow: 1 });

    await expect(service.testChannel("selected", "user-1", repository)).resolves.toMatchObject({
      status: "delivered",
      channels: [{ channelId: "selected", status: "delivered" }],
    });
    expect(calls).toEqual(["selected:Test notification from MCP Moira."]);
    await expect(service.testChannel("selected", "user-1", repository)).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ channelId: "selected", status: "rate_limited" }],
    });
    await expect(service.testChannel("missing", "user-1", repository)).resolves.toBeNull();
  });

  test("fans out and returns only sanitized partial-delivery outcomes", async () => {
    const captured: PortableCommunicationMessage[] = [];
    const configurationKeys: string[][] = [];
    const service = new UserCommunicationService([
      adapter("first", async (request, configuration) => {
        captured.push(request);
        configurationKeys.push(Object.keys(configuration));
      }),
      adapter("second", async () => {
        throw new Error("secret destination 123456 and message body");
      }),
    ]);
    const result = await service.deliver(
      { userId: "user-1", text: "private message", format: "plain" },
      repository,
    );

    expect(result).toEqual({
      status: "partial",
      configuredChannels: 2,
      deliveredChannels: 1,
      channels: [
        { channelId: "first", status: "delivered" },
        { channelId: "second", status: "failed", reason: "channel_error" },
      ],
    });
    expect(captured[0].text).toBe("private message");
    expect(captured[0]).not.toHaveProperty("userId");
    expect(configurationKeys).toEqual([["get"]]);
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(JSON.stringify(result)).not.toContain("private message");
  });

  test("distinguishes no configured channels from total delivery failure", async () => {
    const none = new UserCommunicationService([adapter("off", async () => undefined, false)]);
    await expect(none.deliver({ userId: "u", text: "x" }, repository)).resolves.toMatchObject({
      status: "no_configured_channels",
      channels: [{ channelId: "off", status: "not_configured" }],
    });
    const failed = new UserCommunicationService([
      adapter("on", async () => {
        throw new Error("provider failure");
      }),
    ]);
    await expect(failed.deliver({ userId: "u", text: "x" }, repository)).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ channelId: "on", status: "failed" }],
    });
    const unreadable = new UserCommunicationService([
      {
        ...adapter("broken-settings", async () => undefined),
        isConfigured: async () => {
          throw new Error("database contained a secret");
        },
      },
    ]);
    await expect(unreadable.deliver({ userId: "u", text: "x" }, repository)).resolves.toEqual({
      status: "all_failed",
      configuredChannels: 0,
      deliveredChannels: 0,
      channels: [{ channelId: "broken-settings", status: "failed", reason: "availability_error" }],
    });
  });

  test("shares per-user rate budget across sequential callers", async () => {
    const availability = jest.fn(async () => true);
    const service = new UserCommunicationService(
      [{ ...adapter("one", async () => undefined), isConfigured: availability }],
      {
        maxRequestsPerWindow: 1,
      },
    );
    await expect(
      service.deliver({ userId: "same-user", text: "one" }, repository),
    ).resolves.toMatchObject({
      status: "delivered",
    });
    await expect(
      service.deliver({ userId: "same-user", text: "two" }, repository),
    ).resolves.toEqual({
      status: "all_failed",
      configuredChannels: 0,
      deliveredChannels: 0,
      channels: [{ channelId: "one", status: "rate_limited", reason: "rate_limit" }],
    });
    expect(availability).toHaveBeenCalledTimes(1);
    await expect(
      service.deliver({ userId: "other-user", text: "three" }, repository),
    ).resolves.toMatchObject({
      status: "delivered",
      channels: [{ status: "delivered" }],
    });
    expect(availability).toHaveBeenCalledTimes(2);
  });

  test("bounds a stuck adapter with a deadline and rejects unsupported payloads", async () => {
    const service = new UserCommunicationService(
      [
        adapter("text-only", async () => new Promise<void>(() => undefined), true, {
          image: false,
        }),
      ],
      { deadlineMs: 5, maxConcurrentPerUser: 1, maxConcurrentPerProvider: 1 },
    );
    await expect(service.deliver({ userId: "u", text: "x" }, repository)).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ status: "timed_out" }],
    });
    await expect(
      service.deliver(
        {
          userId: "u2",
          text: "x",
          attachment: {
            kind: "image",
            bytes: Uint8Array.of(1),
            filename: "x.png",
            mimeType: "image/png",
          },
        },
        repository,
      ),
    ).resolves.toEqual({
      status: "no_configured_channels",
      configuredChannels: 1,
      deliveredChannels: 0,
      channels: [{ channelId: "text-only", status: "unsupported" }],
    });
    await expect(
      service.deliver({ userId: "u", text: "again" }, repository),
    ).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ status: "rate_limited" }],
    });
    await expect(
      service.deliver({ userId: "another-user", text: "provider busy" }, repository),
    ).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ status: "rate_limited" }],
    });
  });

  test("rejects text and attachment bytes beyond configured quotas before delivery", async () => {
    const deliver = jest.fn(async () => undefined);
    const service = new UserCommunicationService([adapter("bounded", deliver)], {
      maxTextLength: 3,
      maxAttachmentBytes: 2,
    });
    await expect(service.deliver({ userId: "u", text: "four" }, repository)).rejects.toThrow(
      "text exceeds",
    );
    await expect(
      service.deliver(
        {
          userId: "u",
          text: "ok",
          attachment: {
            kind: "document",
            bytes: Uint8Array.of(1, 2, 3),
            filename: "x.bin",
            mimeType: "application/octet-stream",
          },
        },
        repository,
      ),
    ).rejects.toThrow("attachment exceeds");
    await expect(
      service.deliver(
        {
          userId: "u",
          text: "ok",
          attachment: {
            kind: "document",
            bytes: Uint8Array.of(1),
            filename: "../secret",
            mimeType: "application/octet-stream",
          },
        },
        repository,
      ),
    ).rejects.toThrow("filename is invalid");
    await expect(
      service.deliver(
        {
          userId: "u",
          text: "ok",
          attachment: {
            kind: "document",
            bytes: Uint8Array.of(1),
            filename: "safe.bin",
            mimeType: "not-a-mime",
          },
        },
        repository,
      ),
    ).rejects.toThrow("MIME type is invalid");
    expect(deliver).not.toHaveBeenCalled();
  });

  test("refuses adapter-supplied failure text as a public reason", async () => {
    const service = new UserCommunicationService([
      adapter("unsafe", async () => {
        throw new CommunicationChannelError("secret destination 123");
      }),
    ]);
    const result = await service.deliver({ userId: "u", text: "private" }, repository);
    expect(result).toMatchObject({
      status: "all_failed",
      channels: [{ channelId: "unsafe", status: "failed", reason: "channel_error" }],
    });
    expect(JSON.stringify(result)).not.toContain("secret destination");
  });

  test("observes provider registry changes without replacing the shared service", async () => {
    const calls: string[] = [];
    const registry = new CommunicationChannelRegistry([
      adapter("first", async () => calls.push("first")),
    ]);
    const service = new UserCommunicationService(registry);
    await service.deliver({ userId: "u1", text: "one" }, repository);
    registry.register(adapter("second", async () => calls.push("second")));
    const expanded = await service.deliver({ userId: "u2", text: "two" }, repository);
    expect(expanded).toMatchObject({ status: "delivered", configuredChannels: 2 });
    expect(calls).toEqual(["first", "first", "second"]);
    expect(registry.unregister("first")).toBe(true);
    const reduced = await service.deliver({ userId: "u3", text: "three" }, repository);
    expect(reduced).toMatchObject({ status: "delivered", configuredChannels: 1 });
    expect(calls).toEqual(["first", "first", "second", "second"]);
  });

  test("rejects invalid or duplicate channel identities without replacing the registered channel", () => {
    const original = adapter("valid.channel", async () => undefined);
    const registry = new CommunicationChannelRegistry([original]);
    expect(() => registry.register(adapter("recipient 123", async () => undefined))).toThrow(
      "identity is invalid",
    );
    expect(() => registry.register(adapter("valid.channel", async () => undefined))).toThrow(
      "already registered",
    );
    expect(registry.list()).toEqual([original]);
  });

  test("composes later channels into the process service that workflow and MCP callers share", async () => {
    const registry = getActiveCommunicationChannelRegistry();
    const service = getActiveUserCommunicationService();
    const channelId = "test.dynamic-channel";
    registry.register(adapter(channelId, async () => undefined));
    try {
      const repo = {
        getSetting: async () => null,
      } as unknown as IDataRepository;
      const result = await service.deliver({ userId: "dynamic-channel-user", text: "x" }, repo);
      expect(getActiveUserCommunicationService()).toBe(service);
      expect(result).toMatchObject({
        status: "delivered",
        configuredChannels: 1,
        channels: expect.arrayContaining([
          { channelId: "telegram", status: "not_configured" },
          { channelId, status: "delivered" },
        ]),
      });
    } finally {
      registry.unregister(channelId);
    }
  });

  test("checks channel availability concurrently and bounds a stuck resolver", async () => {
    jest.useFakeTimers();
    const fastAvailability = jest.fn(async () => true);
    const registry = new CommunicationChannelRegistry([
      {
        ...adapter("stuck", async () => undefined),
        isConfigured: async () => new Promise<boolean>(() => undefined),
      },
      { ...adapter("fast", async () => undefined), isConfigured: fastAvailability },
    ]);
    const service = new UserCommunicationService(registry, {
      deadlineMs: 5,
      maxConcurrentPerProvider: 1,
    });
    const delivery = service.deliver({ userId: "u", text: "x" }, repository);
    await Promise.resolve();
    await Promise.resolve();
    expect(fastAvailability).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5);
    await expect(delivery).resolves.toMatchObject({
      status: "partial",
      configuredChannels: 1,
      deliveredChannels: 1,
      channels: expect.arrayContaining([
        { channelId: "stuck", status: "timed_out", reason: "deadline_exceeded" },
        { channelId: "fast", status: "delivered" },
      ]),
    });
    const next = await service.deliver({ userId: "another-user", text: "x" }, repository);
    expect(next).toMatchObject({
      status: "partial",
      configuredChannels: 1,
      deliveredChannels: 1,
      channels: expect.arrayContaining([
        {
          channelId: "stuck",
          status: "rate_limited",
          reason: "availability_concurrency_limit",
        },
        { channelId: "fast", status: "delivered" },
      ]),
    });
  });

  test("refuses new limiter identities at its bound and reclaims expired idle state", async () => {
    let now = 0;
    const deliver = jest.fn(async () => undefined);
    const service = new UserCommunicationService(
      [adapter("provider", deliver)],
      { maxLimiterKeys: 5, windowMs: 10 },
      () => now,
    );
    for (const userId of ["u1", "u2", "u3"])
      await expect(service.deliver({ userId, text: "x" }, repository)).resolves.toMatchObject({
        status: "delivered",
      });
    await expect(service.deliver({ userId: "u4", text: "x" }, repository)).resolves.toMatchObject({
      status: "all_failed",
      channels: [{ status: "rate_limited" }],
    });
    expect(deliver).toHaveBeenCalledTimes(3);
    now = 11;
    await expect(service.deliver({ userId: "u5", text: "x" }, repository)).resolves.toMatchObject({
      status: "delivered",
    });
    expect(deliver).toHaveBeenCalledTimes(4);
  });
});

describe("TelegramCommunicationAdapter", () => {
  test("fans out one aggregate through configured Telegram and a second channel", async () => {
    const telegramCalls: string[] = [];
    const secondCalls: PortableCommunicationMessage[] = [];
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ text }: { text: string }) => {
            telegramCalls.push(text);
            return { ok: true };
          },
        }) as never,
    );
    const repo = {
      getSetting: async (_userId: string, key: string) => {
        if (key === "telegram.enabled") return true;
        if (key === "telegram.bot_token") return "123:secret-token";
        if (key === "telegram.chat_id") return "private-recipient";
        return null;
      },
    } as unknown as IDataRepository;
    const service = new UserCommunicationService([
      new TelegramCommunicationAdapter(),
      adapter("second", async (message) => secondCalls.push(message)),
    ]);

    const result = await service.deliver({ userId: "u", text: "fan out" }, repo);

    expect(result).toEqual({
      status: "delivered",
      configuredChannels: 2,
      deliveredChannels: 2,
      channels: [
        { channelId: "telegram", status: "delivered" },
        { channelId: "second", status: "delivered" },
      ],
    });
    expect(telegramCalls).toEqual(["fan out"]);
    expect(secondCalls).toHaveLength(1);
  });

  test("keeps Telegram credentials and recipient resolution inside the adapter", async () => {
    const calls: Array<{ method: string; chatId: string; filename?: string }> = [];
    setTestClientFactory((token, defaultChatId) => {
      expect(token).toBe("123:secret-token");
      expect(defaultChatId).toBe("private-recipient");
      return {
        sendMessage: async ({ chatId }: { chatId: string }) => {
          calls.push({ method: "text", chatId });
          return { ok: true };
        },
        sendPhoto: async ({ chatId, filename }: { chatId: string; filename: string }) => {
          calls.push({ method: "photo", chatId, filename });
          return { ok: true };
        },
        sendDocument: async ({ chatId, filename }: { chatId: string; filename: string }) => {
          calls.push({ method: "document", chatId, filename });
          return { ok: true };
        },
      } as never;
    });
    const repo = {
      getSetting: async (_userId: string, key: string) => {
        if (key === "telegram.enabled") return true;
        if (key === "telegram.bot_token") return "123:secret-token";
        if (key === "telegram.chat_id") return "private-recipient";
        return null;
      },
    } as unknown as IDataRepository;
    const telegram = new TelegramCommunicationAdapter();
    const service = new UserCommunicationService([telegram]);

    await service.deliver({ userId: "u", text: "hello" }, repo);
    await service.deliver(
      {
        userId: "u",
        text: "image",
        attachment: {
          kind: "image",
          bytes: Uint8Array.of(1),
          filename: "progress.png",
          mimeType: "image/png",
        },
      },
      repo,
    );
    await service.deliver(
      {
        userId: "u",
        text: "document",
        attachment: {
          kind: "document",
          bytes: Uint8Array.of(2),
          filename: "report.pdf",
          mimeType: "application/pdf",
        },
      },
      repo,
    );

    expect(calls).toEqual([
      { method: "text", chatId: "private-recipient" },
      { method: "photo", chatId: "private-recipient", filename: "progress.png" },
      { method: "document", chatId: "private-recipient", filename: "report.pdf" },
    ]);
  });

  test.each(["image", "document"] as const)(
    "preserves text above the Telegram caption limit for a %s",
    async (kind) => {
      const calls: Array<{ method: string; text?: string; caption?: string }> = [];
      setTestClientFactory(
        () =>
          ({
            sendMessage: async ({ text }: { text: string }) => {
              calls.push({ method: "text", text });
              return { ok: true };
            },
            sendPhoto: async ({ caption }: { caption?: string }) => {
              calls.push({ method: "image", caption });
              return { ok: true };
            },
            sendDocument: async ({ caption }: { caption?: string }) => {
              calls.push({ method: "document", caption });
              return { ok: true };
            },
          }) as never,
      );
      const repo = {
        getSetting: async (_userId: string, key: string) => {
          if (key === "telegram.enabled") return true;
          if (key === "telegram.bot_token") return "123:token";
          if (key === "telegram.chat_id") return "recipient";
          return null;
        },
      } as unknown as IDataRepository;
      const text = "x".repeat(1025);
      const result = await new UserCommunicationService([
        new TelegramCommunicationAdapter(),
      ]).deliver(
        {
          userId: "u",
          text,
          attachment: {
            kind,
            bytes: Uint8Array.of(1),
            filename: kind === "image" ? "x.png" : "x.pdf",
            mimeType: kind === "image" ? "image/png" : "application/pdf",
          },
        },
        repo,
      );
      expect(result.status).toBe("delivered");
      expect(calls).toEqual([
        { method: kind, caption: undefined },
        { method: "text", text },
      ]);
    },
  );

  test("maps provider errors to a stable reason without returning provider text", async () => {
    setTestClientFactory(
      () =>
        ({
          sendMessage: async () => {
            const error = new Error("secret provider response") as Error & { type: string };
            error.type = TelegramErrorType.INVALID_TOKEN;
            throw error;
          },
        }) as never,
    );
    const repo = {
      getSetting: async (_userId: string, key: string) => {
        if (key === "telegram.enabled") return true;
        if (key === "telegram.bot_token") return "123:token";
        if (key === "telegram.chat_id") return "recipient";
        return null;
      },
    } as unknown as IDataRepository;
    const result = await new UserCommunicationService([new TelegramCommunicationAdapter()]).deliver(
      { userId: "u", text: "private message" },
      repo,
    );
    expect(result).toMatchObject({
      status: "all_failed",
      channels: [
        { channelId: "telegram", status: "failed", reason: TelegramErrorType.INVALID_TOKEN },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret provider response");
    expect(JSON.stringify(result)).not.toContain("private message");
  });
});

describe("user-notification graph contract", () => {
  test("accepts the portable node and rejects simultaneous authored and progress attachments", async () => {
    const validator = new GraphValidator();
    const base = {
      metadata: { name: "Notification", version: "1.0.0", description: "test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "notify" } },
        {
          type: "user-notification",
          id: "notify",
          message: "Done",
          attachment: {
            kind: "document",
            data: "eA==",
            encoding: "base64",
            filename: "x.txt",
            mimeType: "text/plain",
          },
          connections: { default: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const valid = await validator.validateUnified(base as never);
    expect(valid.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    (base.nodes[1] as Record<string, unknown>).attachProgressImage = false;
    const explicitFalse = await validator.validateUnified(base as never);
    expect(explicitFalse.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    (base.nodes[1] as Record<string, unknown>).attachProgressImage = true;
    const invalid = await validator.validateUnified(base as never);
    expect(invalid.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  test.each([
    ["provider", "telegram"],
    ["chatId", "12345"],
    ["botToken", "123:secret"],
  ])("rejects provider-specific field %s", async (field, value) => {
    const validator = new GraphValidator();
    const result = await validator.validateUnified({
      metadata: { name: "Neutral", version: "1.0.0", description: "test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "notify" } },
        {
          type: "user-notification",
          id: "notify",
          message: "Done",
          [field]: value,
          connections: { default: "end" },
        },
        { type: "end", id: "end" },
      ],
    } as never);
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  test("rejects a path-bearing attachment filename in the public graph schema", async () => {
    const validator = new GraphValidator();
    const result = await validator.validateUnified({
      metadata: { name: "Safe filename", version: "1.0.0", description: "test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "notify" } },
        {
          type: "user-notification",
          id: "notify",
          message: "Done",
          attachment: {
            kind: "document",
            data: "eA==",
            encoding: "base64",
            filename: "../secret.txt",
            mimeType: "text/plain",
          },
          connections: { default: "end" },
        },
        { type: "end", id: "end" },
      ],
    } as never);
    expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  test("publishes the legacy deprecation and canonical replacement through the catalog", () => {
    const descriptors = builtinNodeTypeDescriptors();
    const legacy = descriptors.find((descriptor) => descriptor.type === "telegram-notification");
    const canonical = descriptors.find((descriptor) => descriptor.type === "user-notification");
    expect(legacy?.schema).toMatchObject({ deprecated: true });
    expect(legacy?.description).toContain("use User Notification");
    expect(canonical).toMatchObject({ title: "User Notification", origin: "builtin" });
  });
});

describe("UserNotificationHandler", () => {
  test("shares one provider budget with direct callers while another provider remains independent", async () => {
    const sharedDeliver = jest.fn(async () => undefined);
    const independentDeliver = jest.fn(async () => undefined);
    const registry = new CommunicationChannelRegistry([adapter("shared", sharedDeliver)]);
    const service = new UserCommunicationService(registry, { maxRequestsPerWindow: 1 });
    const handler = new UserNotificationHandler(service);
    const repo = { getWorkflow: async () => null } as unknown as IDataRepository;

    const workflowResult = await handler.execute(
      {
        type: "user-notification",
        id: "notify",
        message: "workflow",
        connections: { default: "end", error: "failed" },
      },
      {
        variables: {},
        nodeStates: {},
        executionId: "execution",
        workflowId: "workflow",
        userId: "same-user",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    registry.register(adapter("independent", independentDeliver));

    const directResult = await service.deliver({ userId: "same-user", text: "direct" }, repository);

    expect(workflowResult.data?.userNotificationStatus).toBe("delivered");
    expect(directResult).toMatchObject({
      status: "partial",
      deliveredChannels: 1,
      channels: [
        { channelId: "shared", status: "rate_limited", reason: "rate_limit" },
        { channelId: "independent", status: "delivered" },
      ],
    });
    expect(sharedDeliver).toHaveBeenCalledTimes(1);
    expect(independentDeliver).toHaveBeenCalledTimes(1);
  });

  test("routes a skipped unsupported channel through default but an attempted failure through error", async () => {
    const skippedDeliver = jest.fn(async () => undefined);
    const skippedHandler = new UserNotificationHandler(
      new UserCommunicationService([
        adapter("text-only", skippedDeliver, true, { document: false }),
      ]),
    );
    const repo = { getWorkflow: async () => null } as unknown as IDataRepository;
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "x",
      attachment: {
        kind: "document",
        data: "eA==",
        encoding: "base64",
        filename: "x.txt",
        mimeType: "text/plain",
      },
      connections: { default: "end", error: "failed" },
    };
    const context = {
      variables: {},
      nodeStates: {},
      executionId: "execution",
      workflowId: "workflow",
      userId: "user",
    };

    const skipped = await skippedHandler.execute(
      node,
      context,
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    const failed = await new UserNotificationHandler(
      new UserCommunicationService([
        adapter("failing", async () => {
          throw new Error("provider failed");
        }),
      ]),
    ).execute(
      { ...node, attachment: undefined },
      context,
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );

    expect(skipped.outputPath).toBe("default");
    expect(skipped.data).toMatchObject({
      userNotificationStatus: "no_configured_channels",
      configuredChannels: 1,
      deliveredChannels: 0,
      channels: [{ channelId: "text-only", status: "unsupported" }],
    });
    expect(skippedDeliver).not.toHaveBeenCalled();
    expect(failed.outputPath).toBe("error");
    expect(failed.data).toMatchObject({ userNotificationStatus: "all_failed" });
  });

  test("executes the canonical node through real engine dispatch and traversal", async () => {
    const calls: PortableCommunicationMessage[] = [];
    const registry = getActiveCommunicationChannelRegistry();
    const channelId = "test.engine-channel";
    registry.register(adapter(channelId, async (message) => calls.push(message)));
    try {
      const engine = new GraphExecutionEngine(new InMemoryRepository());
      const result = await engine.executeGraph(
        {
          metadata: { name: "Engine notification", version: "1.0.0", description: "test" },
          nodes: [
            { type: "start", id: "start", connections: { default: "notify" } },
            {
              type: "user-notification",
              id: "notify",
              message: "Engine delivery",
              connections: { default: "end" },
            },
            { type: "end", id: "end", finalOutput: ["notify"] },
          ],
        },
        {
          variables: {},
          nodeStates: {},
          executionId: "engine-notification-execution",
          workflowId: "engine-notification-workflow",
          userId: "engine-notification-user",
        },
        new AgentMessageQueue(),
        "start",
      );
      expect(result).toMatchObject({
        action: "complete",
        visitedNodes: ["start", "notify", "end"],
        context: {
          variables: {
            notify: {
              userNotificationStatus: "delivered",
              configuredChannels: 1,
              deliveredChannels: 1,
            },
          },
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].text).toContain("Engine delivery");
    } finally {
      registry.unregister(channelId);
    }
  });

  test("renders portable progress attachment and routes a partial result through default", async () => {
    const deliver = jest.fn(async () => ({
      status: "partial" as const,
      configuredChannels: 2,
      deliveredChannels: 1,
      channels: [
        { channelId: "telegram", status: "delivered" as const },
        { channelId: "mail", status: "failed" as const },
      ],
    }));
    const handler = new UserNotificationHandler(
      { deliver } as unknown as UserCommunicationService,
      async () => ({
        buffer: Buffer.from("png"),
        mimeType: "image/png",
        width: 10,
        height: 10,
        workflowVersion: "1.0.0",
        executionRevision: 1,
      }),
    );
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "Done {{status}}",
      format: "markdown",
      attachProgressImage: true,
      connections: { default: "end", error: "failed" },
    };
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      progress: { nodes: [{ id: "p", label: "Progress" }] },
      nodes: [],
    };
    const repo = {
      getWorkflowGraph: async () => graph,
      getExecution: async () => ({ revision: 1 }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    const result = await handler.execute(
      node,
      {
        variables: { status: "success" },
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );

    expect(result.outputPath).toBe("default");
    expect(result.data).toMatchObject({
      userNotificationStatus: "partial",
      configuredChannels: 2,
      deliveredChannels: 1,
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        text: expect.stringContaining("Done success"),
        format: "markdown",
        attachment: expect.objectContaining({ kind: "image", filename: "workflow-progress.png" }),
      }),
      repo,
    );
  });

  test("never substitutes a system identity when the execution has no user", async () => {
    const deliver = jest.fn();
    const handler = new UserNotificationHandler({ deliver } as unknown as UserCommunicationService);
    const queue = new AgentMessageQueue();
    const result = await handler.execute(
      {
        type: "user-notification",
        id: "notify",
        message: "x",
        connections: { default: "end", error: "failed" },
      },
      { variables: {}, nodeStates: {}, executionId: "e", workflowId: "w" },
      queue,
      repository,
      {} as IGraphExecutionEngine,
    );
    expect(result.outputPath).toBe("error");
    expect(deliver).not.toHaveBeenCalled();
  });

  test.each([
    ["no_configured_channels", true, "default"],
    ["all_failed", true, "error"],
    ["all_failed", false, "default"],
  ] as const)("routes %s with error edge %s through %s", async (status, hasError, outputPath) => {
    const handler = new UserNotificationHandler({
      deliver: async () => ({
        status,
        configuredChannels: status === "all_failed" ? 1 : 0,
        deliveredChannels: 0,
        channels:
          status === "all_failed" ? [{ channelId: "telegram", status: "failed" as const }] : [],
      }),
    } as unknown as UserCommunicationService);
    const repo = { getWorkflow: async () => null } as unknown as IDataRepository;
    const result = await handler.execute(
      {
        type: "user-notification",
        id: "notify",
        message: "x",
        connections: { default: "end", ...(hasError ? { error: "failed" } : {}) },
      },
      {
        variables: {},
        nodeStates: {},
        executionId: "execution",
        workflowId: "workflow",
        userId: "user",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    expect(result.outputPath).toBe(outputPath);
    expect(result.data?.userNotificationStatus).toBe(status);
  });
});
