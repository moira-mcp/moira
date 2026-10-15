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
  buildProgressStepsModel,
  renderProgressStepsSvg,
  builtinNodeTypeDescriptors,
  projectExecutionRun,
  runPageUrl,
  getActiveCommunicationChannelRegistry,
  getActiveUserCommunicationService,
  resetClientFactory,
  setTestClientFactory,
  notificationLiveRun,
} from "@mcp-moira/workflow-engine";
import type {
  CommunicationChannelAdapter,
  IDataRepository,
  IGraphExecutionEngine,
  PortableCommunicationMessage,
  UserNotificationNode,
  WorkflowExecution,
  WorkflowGraph,
  CommunicationFileOwner,
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
  test("delivers arbitrary text and repeated requests without a cross-provider workload budget", async () => {
    const texts: string[] = [];
    const service = new UserCommunicationService([
      adapter("owner", async (message) => void texts.push(message.text)),
    ]);
    const text = "complete message ".repeat(1000);
    for (let index = 0; index < 40; index++) {
      await expect(
        service.deliver({ userId: "same-user", text }, repository),
      ).resolves.toMatchObject({
        status: "delivered",
      });
    }
    expect(texts).toEqual(Array(40).fill(text));
  });

  test("held real adapter work remains pending across the former deadline while independent callers deliver", async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const texts: string[] = [];
    const service = new UserCommunicationService([
      adapter("held", async (message) => {
        if (message.text === "held") await gate;
        texts.push(message.text);
      }),
    ]);
    let settled = false;
    const held = service
      .deliver({ userId: "same-user", text: "held" }, repository)
      .then((value) => {
        settled = true;
        return value;
      });
    await jest.advanceTimersByTimeAsync(10_001);
    expect(settled).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        service.deliver({ userId: "same-user", text: `independent-${index}` }, repository),
      ),
    );
    expect(results.every((result) => result.status === "delivered")).toBe(true);
    release();
    await expect(held).resolves.toMatchObject({ status: "delivered" });
    expect(texts).toHaveLength(41);
    expect(texts.at(-1)).toBe("held");
  });

  test("prepares mutable content after channel configuration and validates it before handoff", async () => {
    let title = "Old";
    const texts: string[] = [];
    const service = new UserCommunicationService([
      {
        ...adapter("late", async (message) => {
          texts.push(message.text);
        }),
        isConfigured: async () => {
          title = "Current";
          return true;
        },
      },
    ]);
    await service.deliver({ userId: "u", text: "Old" }, repository, async () => ({ text: title }));
    expect(texts).toEqual(["Current"]);
    await service.deliver({ userId: "u", text: "Old" }, repository, async () => ({
      text: "x".repeat(11),
    }));
    await service.deliver({ userId: "u", text: "Old" }, repository, async () => null);
    expect(texts).toEqual(["Current", "x".repeat(11)]);
  });
  test("tests one registered channel through its configured adapter without fanning out", async () => {
    const calls: string[] = [];
    const registry = new CommunicationChannelRegistry([
      adapter("selected", async (message) => void calls.push(`selected:${message.text}`)),
      adapter("other", async () => void calls.push("other")),
    ]);
    const service = new UserCommunicationService(registry);

    await expect(service.testChannel("selected", "user-1", repository)).resolves.toMatchObject({
      status: "delivered",
      channels: [{ channelId: "selected", status: "delivered" }],
    });
    expect(calls).toEqual(["selected:Test notification from MCP Moira."]);
    await expect(service.testChannel("selected", "user-1", repository)).resolves.toMatchObject({
      status: "delivered",
      channels: [{ channelId: "selected", status: "delivered" }],
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
      channels: [{ channelId: "broken-settings", status: "failed", reason: "configuration_error" }],
    });
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
      adapter("first", async () => void calls.push("first")),
    ]);
    const service = new UserCommunicationService(registry);
    await service.deliver({ userId: "u1", text: "one" }, repository);
    registry.register(adapter("second", async () => void calls.push("second")));
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
});

describe("TelegramCommunicationAdapter", () => {
  test("fits workflow text only for the selected provider and preserves the full extension message", async () => {
    const telegramTexts: string[] = [],
      extensionTexts: string[] = [];
    setTestClientFactory(
      () =>
        ({
          sendMessage: async ({ text }: { text: string }) => {
            telegramTexts.push(text);
            return { ok: true };
          },
        }) as never,
    );
    const repo = {
      getSetting: async (_u: string, key: string) =>
        key === "telegram.bot_token" ? "123:token" : key === "telegram.chat_id" ? "chat" : null,
      getWorkflow: async () => null,
    } as unknown as IDataRepository;
    const service = new UserCommunicationService([
      new TelegramCommunicationAdapter(),
      adapter("extension", async (message) => {
        extensionTexts.push(message.text);
      }),
    ]);
    const body = "complete authored content ".repeat(1000);
    const result = await new UserNotificationHandler(service).execute(
      { type: "user-notification", id: "notify", message: body, connections: { default: "end" } },
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
    expect(result.data?.userNotificationStatus).toBe("delivered");
    expect(extensionTexts[0]).toContain(body.trim());
    expect(telegramTexts[0].length).toBeLessThanOrEqual(4096);
    expect(telegramTexts[0]).toContain("…");
  });
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
      adapter("second", async (message) => void secondCalls.push(message)),
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
    const calls: Array<{
      method: string;
      chatId: string;
      filename?: string;
      disableLinkPreview?: boolean;
    }> = [];
    setTestClientFactory((token, defaultChatId) => {
      expect(token).toBe("123:secret-token");
      expect(defaultChatId).toBe("private-recipient");
      return {
        sendMessage: async ({
          chatId,
          disableLinkPreview,
        }: {
          chatId: string;
          disableLinkPreview?: boolean;
        }) => {
          // A notification links its run page; the preview card would show the login page.
          calls.push({ method: "text", chatId, disableLinkPreview });
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

    expect(calls).toEqual([
      { method: "text", chatId: "private-recipient", disableLinkPreview: true },
    ]);
  });

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
  test("workflow and direct callers deliver through the same configured providers", async () => {
    const sharedDeliver = jest.fn(async () => undefined);
    const independentDeliver = jest.fn(async () => undefined);
    const registry = new CommunicationChannelRegistry([adapter("shared", sharedDeliver)]);
    const service = new UserCommunicationService(registry);
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
      status: "delivered",
      deliveredChannels: 2,
      channels: [
        { channelId: "shared", status: "delivered" },
        { channelId: "independent", status: "delivered" },
      ],
    });
    expect(sharedDeliver).toHaveBeenCalledTimes(2);
    expect(independentDeliver).toHaveBeenCalledTimes(1);
  });

  test("routes a skipped unsupported channel through default but an attempted failure through error", async () => {
    const skippedDeliver = jest.fn(async () => undefined);
    const skippedHandler = new UserNotificationHandler(
      new UserCommunicationService([adapter("non-text", skippedDeliver, true, { text: false })]),
    );
    const repo = { getWorkflow: async () => null } as unknown as IDataRepository;
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "x",
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
    ).execute(node, context, new AgentMessageQueue(), repo, {} as IGraphExecutionEngine);

    expect(skipped.outputPath).toBe("default");
    expect(skipped.data).toMatchObject({
      userNotificationStatus: "no_configured_channels",
      configuredChannels: 1,
      deliveredChannels: 0,
      channels: [{ channelId: "non-text", status: "unsupported" }],
    });
    expect(skippedDeliver).not.toHaveBeenCalled();
    expect(failed.outputPath).toBe("error");
    expect(failed.data).toMatchObject({ userNotificationStatus: "all_failed" });
  });

  test("executes the canonical node through real engine dispatch and traversal", async () => {
    const calls: PortableCommunicationMessage[] = [];
    const registry = getActiveCommunicationChannelRegistry();
    const channelId = "test.engine-channel";
    registry.register(adapter(channelId, async (message) => void calls.push(message)));
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

  test("hands the current progress descriptor to its owner and preserves partial text delivery when the optional image is unavailable", async () => {
    const deliver = jest.fn<UserCommunicationService["deliver"]>(async () => ({
      status: "partial" as const,
      configuredChannels: 2,
      deliveredChannels: 1,
      channels: [
        { channelId: "telegram", status: "delivered" as const },
        { channelId: "mail", status: "failed" as const },
      ],
    }));
    const renderedFor: Array<{
      currentNodeId: string | null;
      waitingOn: string | null;
      lastVisitNode?: string;
    }> = [];
    const pictures: string[] = [];
    const handler = new UserNotificationHandler(
      { deliver } as unknown as UserCommunicationService,
      {
        select: async () => {
          throw new Error("unused selection");
        },
        collect: async () => {
          throw new Error("unused collection");
        },
        openPublication: async () => {
          throw new Error("unused publication");
        },
        async submit(_userId, input) {
          if (input.source.type !== "progress") throw new Error("Expected progress source");
          const workflow = input.source.descriptor.graph as unknown as WorkflowGraph;
          const execution = input.source.descriptor.run as unknown as WorkflowExecution;
          pictures.push(
            renderProgressStepsSvg(
              buildProgressStepsModel(projectExecutionRun(workflow, execution)!),
            ),
          );
          renderedFor.push({
            currentNodeId: execution.currentNodeId,
            waitingOn: execution.waitingForInputNodeId ?? null,
            lastVisitNode: execution.visits?.at(-1)?.nodeId,
          });
          throw new Error("Controlled unavailable owner; no image delivery admitted");
        },
      } satisfies CommunicationFileOwner,
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
      getExecution: async () => ({
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
        createdAt: 0,
        updatedAt: 0,
        revision: 1,
        status: "running",
        currentNodeId: "previous-wait",
        waitingForInputNodeId: null,
        globalContext: { variables: {}, nodeStates: {} },
        visits: [{ seq: 0, nodeId: "previous-wait", exitKey: null, changes: {}, waited: true }],
      }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    const liveRun = notificationLiveRun(
      { execution: (await repo.getExecution("12345678-rest"))! },
      [],
      {},
      "notify",
    );
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
      undefined,
      undefined,
      liveRun,
    );

    expect(result.outputPath).toBe("default");
    expect(result.data).toMatchObject({
      userNotificationStatus: "partial",
      configuredChannels: 2,
      deliveredChannels: 1,
      attachmentStatus: "unavailable",
    });
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        text: expect.stringContaining("Done success"),
        format: "markdown",
      }),
      repo,
      expect.any(Function),
    );
    expect(deliver.mock.calls[0][0]).not.toHaveProperty("attachment");
    // The owner descriptor names this node, not the wait the persisted route still ends on.
    // The graph has no successor node for `notify`, so nothing is waited on.
    expect(renderedFor).toEqual([
      { currentNodeId: "notify", waitingOn: null, lastVisitNode: "notify" },
    ]);
    // A notification leading to a lock gives the owner the same waiting run the text describes.
    renderedFor.length = 0;
    const gated = {
      ...graph,
      nodes: [
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "p",
          message: "Done",
          connections: { default: "pin-gate" },
        },
        {
          id: "pin-gate",
          type: "lock",
          progressNodeId: "p",
          reason: "Approve",
          connections: { unlocked: "end" },
        },
        { id: "end", type: "end", progressNodeId: "p" },
      ],
    };
    await handler.execute(
      { ...node, connections: { default: "pin-gate", error: "failed" } },
      {
        variables: { status: "ok" },
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      { ...repo, getWorkflowGraph: async () => gated } as unknown as IDataRepository,
      {} as IGraphExecutionEngine,
      undefined,
      undefined,
      liveRun,
    );
    expect(renderedFor).toEqual([
      { currentNodeId: "pin-gate", waitingOn: "pin-gate", lastVisitNode: "pin-gate" },
    ]);
    const gatedText = (deliver.mock.calls as unknown as Array<[{ text: string }]>).at(-1)![0].text;
    expect(gatedText).toContain("🙋 waiting for you: Progress");
    // Rendering that descriptor would tell the same story even though this owner is unavailable.
    expect(pictures.at(-1)).toContain("waiting for you");
    expect(pictures.at(-1)).not.toContain("agent on the step");
  });

  test("the message names done/total and the current item of the bound list nearest the run", async () => {
    const deliver = jest.fn(async () => ({
      status: "delivered" as const,
      configuredChannels: 1,
      deliveredChannels: 1,
      channels: [{ channelId: "telegram", status: "delivered" as const }],
    }));
    const handler = new UserNotificationHandler({
      deliver,
    } as unknown as UserCommunicationService);
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "Checkpoint",
      connections: { default: "end" },
    };
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      variableRegistry: {
        tasks: { type: "array", description: "tasks" },
        current_task: { type: "number", description: "cursor" },
      },
      progress: {
        nodes: [
          {
            id: "work",
            label: "Work",
            list: { items: "tasks", title: "action", current: "current_task" },
          },
          { id: "report", label: "Report" },
        ],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Do",
          completionCondition: "Done",
          connections: { success: "notify" },
          connectionLabels: { success: "done" },
        },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "report",
          message: "Checkpoint",
          connections: { default: "tidy" },
        },
        // A step after the message: the run goes on, so the list still has an item in progress.
        {
          id: "tidy",
          type: "expression",
          progressNodeId: "report",
          expressions: ["current_task = current_task"],
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "report" },
      ],
    };
    const tasks = [{ action: "Write it" }, { action: "Ship it" }];
    const repo = {
      getWorkflowGraph: async () => graph,
      getExecution: async () => ({
        revision: 1,
        status: "running",
        currentNodeId: "task",
        globalContext: { variables: { tasks, current_task: 2 }, nodeStates: {} },
        visits: [
          { seq: 0, nodeId: "start", exitKey: "default", changes: { tasks, current_task: 1 } },
          {
            seq: 1,
            nodeId: "task",
            exitKey: "success",
            changes: { current_task: 2 },
            waited: true,
          },
        ],
      }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    await handler.execute(
      node,
      {
        variables: { tasks, current_task: 2 },
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    const text = (deliver.mock.calls as unknown as Array<[{ text: string }]>)[0][0].text;
    // The notification's own block binds nothing; the line comes from the checklist block the
    // route just left, and an unbound block adds no count of its own.
    expect(text).toContain("📝 1/2: Ship it");
    expect(text.match(/📝/gu)).toHaveLength(1);
    // The run is moving through this node, not paused on it: no actor line.
    expect(text).not.toMatch(/agent on the step|waiting for you/u);
  });

  test("the message names the agent on the step after the list line while the projected run is paused, and never says it waits for the reader", async () => {
    const deliver = jest.fn(async () => ({
      status: "delivered" as const,
      configuredChannels: 1,
      deliveredChannels: 1,
      channels: [{ channelId: "telegram", status: "delivered" as const }],
    }));
    const handler = new UserNotificationHandler({
      deliver,
    } as unknown as UserCommunicationService);
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "Checkpoint",
      connections: { default: "end" },
    };
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      variableRegistry: {
        tasks: { type: "array", description: "tasks" },
        current_task: { type: "number", description: "cursor" },
      },
      progress: {
        nodes: [
          {
            id: "work",
            label: "Work",
            list: { items: "tasks", title: "action", current: "current_task" },
          },
          { id: "report", label: "Report the checkpoint" },
        ],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Do",
          completionCondition: "Done",
          connections: { success: "notify" },
          connectionLabels: { success: "done" },
        },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "report",
          message: "Checkpoint",
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "report" },
      ],
    };
    const tasks = [{ action: "Write it" }, { action: "Ship it" }];
    // A notification node never waits itself; the message names the actor of the node the run
    // pauses on right after it — here the directive `next`, so the agent — with that node's block.
    const paused = {
      ...graph,
      nodes: graph.nodes.map((n: any) =>
        n.id === "notify" ? { ...n, connections: { default: "next" } } : n,
      ),
    };
    paused.nodes.push({
      id: "next",
      type: "agent-directive",
      progressNodeId: "report",
      directive: "Report",
      completionCondition: "Reported",
      connections: { success: "end" },
    });
    const repo = {
      getWorkflowGraph: async () => paused,
      getExecution: async () => ({
        revision: 1,
        status: "running",
        currentNodeId: "notify",
        waitingForInputNodeId: null,
        globalContext: { variables: { tasks, current_task: 2 }, nodeStates: {} },
        visits: [
          { seq: 0, nodeId: "start", exitKey: "default", changes: { tasks, current_task: 1 } },
          {
            seq: 1,
            nodeId: "task",
            exitKey: "success",
            changes: { current_task: 2 },
            waited: true,
          },
        ],
      }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    await handler.execute(
      node,
      {
        variables: { tasks, current_task: 2 },
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    const text = (deliver.mock.calls as unknown as Array<[{ text: string }]>)[0][0].text;
    expect(
      text.endsWith("Checkpoint\n\n📝 1/2: Ship it\n\n⏳ agent on the step: Report the checkpoint"),
    ).toBe(true);
    expect(text).not.toContain("waiting for you");
    expect(text).not.toContain("ждёт вас");
  });

  test("a notification followed by a lock gate tells the reader the run waits for them", async () => {
    const deliver = jest.fn(async () => ({
      status: "delivered" as const,
      deliveredChannels: 1,
      channels: [{ channelId: "telegram", status: "delivered" as const }],
    }));
    const handler = new UserNotificationHandler({
      deliver,
    } as unknown as UserCommunicationService);
    const node: UserNotificationNode = {
      type: "user-notification",
      id: "notify",
      message: "Approve",
      connections: { default: "pin-gate" },
    };
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      variableRegistry: {},
      progress: {
        nodes: [
          { id: "work", label: "Work" },
          { id: "approval", label: "Approval gate" },
        ],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Do",
          completionCondition: "Done",
          connections: { success: "notify" },
          connectionLabels: { success: "done" },
        },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "approval",
          message: "Approve",
          connections: { default: "pin-gate" },
        },
        {
          id: "pin-gate",
          type: "lock",
          progressNodeId: "approval",
          reason: "A person approves",
          connections: { unlocked: "end" },
        },
        { id: "end", type: "end", progressNodeId: "approval" },
      ],
    };
    const repo = {
      getWorkflowGraph: async () => graph,
      getExecution: async () => ({
        revision: 1,
        status: "running",
        currentNodeId: "notify",
        waitingForInputNodeId: null,
        globalContext: { variables: {}, nodeStates: {} },
        visits: [
          { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
          { seq: 1, nodeId: "task", exitKey: "success", changes: {}, waited: true },
        ],
      }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    await handler.execute(
      node,
      {
        variables: {},
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    const text = (deliver.mock.calls as unknown as Array<[{ text: string }]>)[0][0].text;
    expect(text.endsWith("Approve\n\n🙋 waiting for you: Approval gate")).toBe(true);
    expect(text).not.toContain("agent on the step");
  });

  test("a run whose blocks bind no list gets no count, only the heading and the message", async () => {
    const deliver = jest.fn(async () => ({
      status: "delivered" as const,
      configuredChannels: 1,
      deliveredChannels: 1,
      channels: [{ channelId: "telegram", status: "delivered" as const }],
    }));
    const handler = new UserNotificationHandler({
      deliver,
    } as unknown as UserCommunicationService);
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      progress: { nodes: [{ id: "work", label: "Work" }] },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "notify" } },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "work",
          message: "Checkpoint",
          connections: { default: "end" },
        },
        { id: "end", type: "end", progressNodeId: "work" },
      ],
    };
    const repo = {
      getWorkflowGraph: async () => graph,
      getExecution: async () => ({
        revision: 1,
        status: "running",
        currentNodeId: "start",
        globalContext: { variables: {}, nodeStates: {} },
        visits: [{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }],
      }),
      getWorkflow: async () => ({ metadata: graph.metadata }),
    } as unknown as IDataRepository;
    await handler.execute(
      {
        type: "user-notification",
        id: "notify",
        message: "Checkpoint",
        connections: { default: "end" },
      },
      {
        variables: {},
        nodeStates: {},
        executionId: "12345678-rest",
        workflowId: "workflow-id",
        userId: "user-1",
      },
      new AgentMessageQueue(),
      repo,
      {} as IGraphExecutionEngine,
    );
    const text = (deliver.mock.calls as unknown as Array<[{ text: string }]>)[0][0].text;
    expect(text).toBe(`Example\n${runPageUrl({ executionId: "12345678-rest" })}\n\nCheckpoint`);
  });

  test("never substitutes a system identity when the execution has no user", async () => {
    const deliver = jest.fn<UserCommunicationService["deliver"]>();
    const handler = new UserNotificationHandler({
      deliver,
    } as unknown as UserCommunicationService);
    const queue = new AgentMessageQueue();
    const result = await handler.execute(
      {
        type: "user-notification",
        id: "notify",
        message: "x",
        connections: { default: "end", error: "failed" },
      },
      { variables: {}, nodeStates: {}, executionId: "e", workflowId: "w", userId: "" },
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
