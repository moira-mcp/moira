/**
 * Unit tests for TelegramNotificationHandler error handling
 *
 * Tests cover:
 * - Handler adds actionable notifications to messageQueue on errors
 * - Handler uses correct error type in notifications
 * - Handler returns actionable error messages in result data
 * - Handler notifies about missing Telegram configuration
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  TelegramNotificationHandler,
  AgentMessageQueue,
  buildExecutionProgressVisualModel,
  projectExecutionRun,
  renderProgressVisualSvg,
  TelegramErrorType,
  setTestClientFactory,
  resetClientFactory,
} from "@mcp-moira/workflow-engine";
import type {
  TelegramNotificationNode,
  ExecutionContext,
  TelegramError,
} from "@mcp-moira/workflow-engine";
import type { IDataRepository } from "@mcp-moira/workflow-engine";
import type { IGraphExecutionEngine } from "@mcp-moira/workflow-engine";
import { ServiceLogger } from "@mcp-moira/shared/logging/logger";

// Helper to create a minimal telegram notification node
function createTelegramNode(
  overrides: Partial<TelegramNotificationNode> = {},
): TelegramNotificationNode {
  return {
    type: "telegram-notification",
    id: "test-telegram-node",
    message: "Test notification: {{status}}",
    connections: { default: "next-node" },
    ...overrides,
  };
}

// Helper to create execution context
function createContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    variables: { status: "completed" },
    nodeStates: {},
    executionId: "test-exec-123",
    workflowId: "test-workflow",
    userId: "test-user",
    ...overrides,
  };
}

describe("TelegramNotificationHandler Error Handling", () => {
  let handler: TelegramNotificationHandler;
  let messageQueue: AgentMessageQueue;
  let mockEngine: IGraphExecutionEngine;

  // Mock repository that returns valid telegram settings by default
  let mockRepository: IDataRepository;

  beforeEach(() => {
    handler = new TelegramNotificationHandler();
    messageQueue = new AgentMessageQueue();

    mockEngine = {} as IGraphExecutionEngine;

    mockRepository = {
      getSetting: jest
        .fn<(userId: string, key: string) => Promise<unknown>>()
        .mockImplementation((_userId: string, key: string) => {
          if (key === "telegram.bot_token")
            return Promise.resolve("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
          if (key === "telegram.chat_id") return Promise.resolve("12345");
          if (key === "telegram.enabled") return Promise.resolve(true);
          return Promise.resolve(null);
        }),
    } as unknown as IDataRepository;
  });

  afterEach(() => {
    resetClientFactory();
  });

  test("adds notification with actionable message when INVALID_CHAT_ID error occurs", async () => {
    // Mock TelegramClient that throws INVALID_CHAT_ID error
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("Bad Request: chat not found") as TelegramError;
            error.type = TelegramErrorType.INVALID_CHAT_ID;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    // Handler should continue (graceful degradation)
    expect(result.action).toBe("continue");
    expect(result.data?.telegramNotificationFailed).toBe(true);
    expect(result.data?.errorType).toBe(TelegramErrorType.INVALID_CHAT_ID);

    // Actionable error message in result data
    expect(result.data?.errorMessage).toContain("send any message to your bot");

    // Notification added to messageQueue
    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);
    expect(flushed.messages[0].type).toBe("notification");

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("send any message to your bot");
    expect(notification.status).toBe(TelegramErrorType.INVALID_CHAT_ID);
  });

  test("renders and sends attached workflow progress through photo transport", async () => {
    const sent: Array<{ photo: Uint8Array; caption?: string }> = [];
    const distinctive = Buffer.from("wrapper-image");
    const renderedFor: Array<{
      currentNodeId: string | null;
      waitingOn: string | null;
      lastVisitNode?: string;
    }> = [];
    const pictures: string[] = [];
    const statisticsReceived: unknown[] = [];
    handler = new TelegramNotificationHandler(async (workflow, execution, _options, statistics) => {
      statisticsReceived.push(statistics ?? null);
      pictures.push(
        renderProgressVisualSvg(
          await buildExecutionProgressVisualModel(projectExecutionRun(workflow, execution)!),
        ),
      );
      renderedFor.push({
        currentNodeId: execution.currentNodeId,
        waitingOn: execution.waitingForInputNodeId ?? null,
        lastVisitNode: execution.visits?.at(-1)?.nodeId,
      });
      return {
        buffer: distinctive,
        mimeType: "image/png",
        width: 640,
        height: 224,
        workflowVersion: "1.0.0",
        executionRevision: execution.revision,
      };
    });
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendPhoto: async (params: { photo: Uint8Array; caption?: string }) => {
            sent.push(params);
            return { ok: true };
          },
        }) as any,
    );
    const graph = {
      metadata: { name: "Progress", version: "1.0.0", description: "" },
      progress: { nodes: [{ id: "notify", label: "Notify" }] },
      nodes: [
        { id: "start", type: "start", connections: { default: "test-telegram-node" } },
        createTelegramNode({ progressNodeId: "notify", attachProgressImage: true }),
        { id: "next-node", type: "end" },
      ],
    } as any;
    const execution = {
      executionId: "test-exec-123",
      workflowId: "test-workflow",
      userId: "system",
      currentNodeId: "test-telegram-node",
      status: "running",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      globalContext: createContext(),
    } as any;
    mockRepository.getWorkflowGraph = jest.fn(async () => graph);
    mockRepository.getExecution = jest.fn(async () => execution);
    mockRepository.getWorkflow = jest.fn(async () => ({ metadata: graph.metadata }) as any);

    const result = await handler.execute(
      createTelegramNode({ progressNodeId: "notify", attachProgressImage: true }),
      createContext(),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    expect(result.action).toBe("continue");
    expect(sent).toHaveLength(1);
    expect(Buffer.from(sent[0].photo).equals(distinctive)).toBe(true);
    expect(sent[0].caption).toContain("Test notification: completed");
    // Rendered as of the notification node inside the current cycle, not of the persisted wait;
    // the successor is an end, so nothing is waited on.
    expect(renderedFor).toEqual([
      { currentNodeId: "test-telegram-node", waitingOn: null, lastVisitNode: "test-telegram-node" },
    ]);
    // An unstamped run's picture is drawn without statistics; a version-stamped run's carries the
    // statistics of that version over the owner's completed runs.
    expect(statisticsReceived).toEqual([null]);
    statisticsReceived.length = 0;
    mockRepository.getExecution = jest.fn(async () => ({ ...execution, workflowVersion: "1.0.0" }));
    (mockRepository as any).summarizeExecutionsByWorkflowVersion = jest.fn(async () => ({
      count: 0,
      lastCompletedAt: null,
      unstamped: 0,
    }));
    (mockRepository as any).listExecutionsByWorkflowVersion = jest.fn(async () => []);
    await handler.execute(
      createTelegramNode({ progressNodeId: "notify", attachProgressImage: true }),
      createContext(),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    expect(statisticsReceived).toEqual([
      expect.objectContaining({
        workflowId: "test-workflow",
        workflowVersion: "1.0.0",
        sampledRuns: 0,
      }),
    ]);
    mockRepository.getExecution = jest.fn(async () => execution);

    // A notification that leads to a lock gate renders the image from the same copy the footer
    // describes: the run waiting on the gate, so the picture says «waiting for you» too.
    renderedFor.length = 0;
    sent.length = 0;
    const gated = {
      ...graph,
      nodes: [
        { id: "start", type: "start", connections: { default: "test-telegram-node" } },
        createTelegramNode({
          progressNodeId: "notify",
          attachProgressImage: true,
          connections: { default: "pin-gate" },
        }),
        {
          id: "pin-gate",
          type: "lock",
          progressNodeId: "notify",
          reason: "Approve",
          connections: { unlocked: "end" },
        },
        { id: "end", type: "end", progressNodeId: "notify" },
      ],
    };
    mockRepository.getWorkflowGraph = jest.fn(async () => gated);
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendPhoto: async (params: { photo: Uint8Array; caption?: string }) => {
            sent.push(params);
            return { ok: true };
          },
        }) as any,
    );
    await handler.execute(
      createTelegramNode({
        progressNodeId: "notify",
        attachProgressImage: true,
        connections: { default: "pin-gate" },
      }),
      createContext(),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    expect(renderedFor).toEqual([
      { currentNodeId: "pin-gate", waitingOn: "pin-gate", lastVisitNode: "pin-gate" },
    ]);
    expect(sent[0].caption).toContain("🙋 waiting for you: Notify");
    // The photo says the same as its caption: the gate's block waits for the reader.
    expect(pictures.at(-1)).toContain("waiting for you");
    expect(pictures.at(-1)).not.toContain("agent on the step");

    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendPhoto: async () => {
            const error = new Error("chat not found") as TelegramError;
            error.type = TelegramErrorType.INVALID_CHAT_ID;
            throw error;
          },
        }) as any,
    );
    const failureQueue = new AgentMessageQueue();
    const failure = await handler.execute(
      createTelegramNode({ progressNodeId: "notify", attachProgressImage: true }),
      createContext(),
      failureQueue,
      mockRepository,
      mockEngine,
    );
    expect(failure.data).toMatchObject({
      telegramNotificationFailed: true,
      errorType: TelegramErrorType.INVALID_CHAT_ID,
    });
    expect(failureQueue.flush("test-process").messages).toHaveLength(1);
  });

  /** A checklist block followed by the notification's own block, as the footer tests share it. */
  function checklistGraph() {
    return {
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
          connections: { success: "test-telegram-node" },
          connectionLabels: { success: "done" },
        },
        createTelegramNode({ progressNodeId: "report", connections: { default: "end" } }),
        { id: "end", type: "end", progressNodeId: "report" },
      ],
    } as any;
  }
  const checklist = [{ action: "Write it" }, { action: "Ship it" }];

  async function footerOf(graph: any, execution: any): Promise<string> {
    const sent: string[] = [];
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async ({ text }: { text: string }) => {
            sent.push(text);
            return { ok: true };
          },
        }) as any,
    );
    mockRepository.getWorkflowGraph = jest.fn(async () => graph);
    mockRepository.getExecution = jest.fn(async () => execution);
    mockRepository.getWorkflow = jest.fn(async () => ({ metadata: graph.metadata }) as any);
    const result = await handler.execute(
      createTelegramNode(),
      createContext({ variables: execution.globalContext.variables }),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    expect(result.data?.telegramNotificationSent).toBe(true);
    expect(sent).toHaveLength(1);
    return sent[0];
  }

  test("the footer names done/total and the current item of the bound list the route just left, with no actor line while the run moves", async () => {
    const text = await footerOf(checklistGraph(), {
      revision: 1,
      status: "running",
      currentNodeId: "task",
      globalContext: { variables: { tasks: checklist, current_task: 2 }, nodeStates: {} },
      visits: [
        {
          seq: 0,
          nodeId: "start",
          exitKey: "default",
          changes: { tasks: checklist, current_task: 1 },
        },
        { seq: 1, nodeId: "task", exitKey: "success", changes: { current_task: 2 }, waited: true },
      ],
    });
    expect(text).toContain("🔄 Workflow: Example\n📝 1/2: Ship it\n🤖 via MCP Moira");
    expect(text).not.toMatch(/agent on the step|waiting for you/u);
  });

  test("the footer names the agent on the step before the list line when the notification leads to a directive, never that it waits for the reader", async () => {
    // A notification node never waits itself; the actor is the one of the node the run pauses on
    // right after it — the directive `next` here, in the notification's block.
    const graph = checklistGraph();
    graph.nodes = graph.nodes.map((n: any) =>
      n.id === "test-telegram-node" ? { ...n, connections: { default: "next" } } : n,
    );
    graph.nodes.push({
      id: "next",
      type: "agent-directive",
      progressNodeId: "report",
      directive: "Report",
      completionCondition: "Reported",
      connections: { success: "end" },
    });
    const text = await footerOf(graph, {
      revision: 1,
      status: "running",
      currentNodeId: "test-telegram-node",
      waitingForInputNodeId: null,
      globalContext: { variables: { tasks: checklist, current_task: 2 }, nodeStates: {} },
      visits: [
        {
          seq: 0,
          nodeId: "start",
          exitKey: "default",
          changes: { tasks: checklist, current_task: 1 },
        },
        { seq: 1, nodeId: "task", exitKey: "success", changes: { current_task: 2 }, waited: true },
      ],
    });
    expect(text).toContain(
      "🔄 Workflow: Example\n⏳ agent on the step: Report the checkpoint\n📝 1/2: Ship it\n🤖 via MCP Moira",
    );
    expect(text).not.toContain("waiting for you");
    expect(text).not.toContain("ждёт вас");
  });

  test("a notification followed by a lock gate tells the reader the run waits for them", async () => {
    const graph = checklistGraph();
    graph.nodes = graph.nodes.map((n: any) =>
      n.id === "test-telegram-node" ? { ...n, connections: { default: "pin-gate" } } : n,
    );
    graph.nodes.push({
      id: "pin-gate",
      type: "lock",
      progressNodeId: "report",
      reason: "A person approves",
      connections: { unlocked: "end" },
    });
    const text = await footerOf(graph, {
      revision: 1,
      status: "running",
      currentNodeId: "test-telegram-node",
      waitingForInputNodeId: null,
      globalContext: { variables: { tasks: checklist, current_task: 2 }, nodeStates: {} },
      visits: [
        {
          seq: 0,
          nodeId: "start",
          exitKey: "default",
          changes: { tasks: checklist, current_task: 1 },
        },
        { seq: 1, nodeId: "task", exitKey: "success", changes: { current_task: 2 }, waited: true },
      ],
    });
    expect(text).toContain(
      "🔄 Workflow: Example\n🙋 waiting for you: Report the checkpoint\n📝 1/2: Ship it\n🤖 via MCP Moira",
    );
    expect(text).not.toContain("agent on the step");
  });

  test("a run whose blocks bind no list gets no count in the footer", async () => {
    const graph = {
      metadata: { name: "Example", version: "1.0.0", description: "x" },
      progress: { nodes: [{ id: "work", label: "Work" }] },
      nodes: [
        {
          id: "start",
          type: "start",
          progressNodeId: "work",
          connections: { default: "test-telegram-node" },
        },
        createTelegramNode({ progressNodeId: "work", connections: { default: "end" } }),
        { id: "end", type: "end", progressNodeId: "work" },
      ],
    } as any;
    const text = await footerOf(graph, {
      revision: 1,
      status: "running",
      currentNodeId: "start",
      globalContext: { variables: { status: "completed" }, nodeStates: {} },
      visits: [{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }],
    });
    expect(text).toContain("🔄 Workflow: Example\n🤖 via MCP Moira");
    expect(text).not.toContain("📝");
  });

  test("keeps an explicit legacy chatId as the Telegram recipient", async () => {
    const recipients: string[] = [];
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "default-chat",
          sendMessage: async ({ chatId }: { chatId: string }) => {
            recipients.push(chatId);
            return { ok: true };
          },
        }) as any,
    );
    mockRepository.getWorkflow = jest.fn(async () => null);
    const result = await handler.execute(
      createTelegramNode({ chatId: "legacy-explicit-chat" }),
      createContext({ userId: "user-1" }),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    expect(result.data?.telegramNotificationSent).toBe(true);
    expect(recipients).toEqual(["legacy-explicit-chat"]);
  });

  test("does not emit legacy destination or message content in log metadata", async () => {
    const debug = jest.spyOn(ServiceLogger.prototype, "debug").mockImplementation(() => undefined);
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "default-chat",
          sendMessage: async () => ({ ok: true }),
        }) as any,
    );
    mockRepository.getWorkflow = jest.fn(async () => null);
    await handler.execute(
      createTelegramNode({
        chatId: "private-legacy-destination",
        message: "private legacy message {{status}}",
      }),
      createContext({ userId: "user-1" }),
      messageQueue,
      mockRepository,
      mockEngine,
    );
    const emitted = JSON.stringify(debug.mock.calls);
    expect(emitted).toContain("messageLength");
    expect(emitted).not.toContain("private-legacy-destination");
    expect(emitted).not.toContain("private legacy message");
    expect(emitted).not.toContain("completed");
  });

  test("adds notification with actionable message when INVALID_TOKEN error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("Unauthorized") as TelegramError;
            error.type = TelegramErrorType.INVALID_TOKEN;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.data?.errorType).toBe(TelegramErrorType.INVALID_TOKEN);
    expect(result.data?.errorMessage).toContain("@BotFather");
    expect(result.data?.errorMessage).toContain("Settings > Notifications");

    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("@BotFather");
    expect(notification.status).toBe(TelegramErrorType.INVALID_TOKEN);
  });

  test("adds notification with actionable message when NETWORK_ERROR occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("fetch failed") as TelegramError;
            error.type = TelegramErrorType.NETWORK_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.data?.errorType).toBe(TelegramErrorType.NETWORK_ERROR);
    expect(result.data?.errorMessage).toContain("Network error");

    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("Network error");
    expect(notification.status).toBe(TelegramErrorType.NETWORK_ERROR);
  });

  test("adds notification about configuring Telegram when bot token is not set", async () => {
    // Repository returns null for bot_token
    mockRepository = {
      getSetting: jest
        .fn<(userId: string, key: string) => Promise<unknown>>()
        .mockImplementation((_userId: string, key: string) => {
          if (key === "telegram.bot_token") return Promise.resolve(null);
          if (key === "telegram.chat_id") return Promise.resolve(null);
          if (key === "telegram.enabled") return Promise.resolve(true);
          return Promise.resolve(null);
        }),
    } as unknown as IDataRepository;

    const node = createTelegramNode();
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    // Handler should continue (not configured = skip, not error)
    expect(result.action).toBe("continue");
    expect(result.data?.telegramNotificationSent).toBe(false);

    // Notification about missing configuration
    const flushed = messageQueue.flush("test-process");
    expect(flushed.totalMessages).toBe(1);

    const notification = flushed.messages[0] as any;
    expect(notification.notificationText).toContain("Settings > Notifications");
    expect(notification.notificationText).toContain(
      'start({ workflowId: "moira/telegram-setup", parentExecutionId: "none", skipNotificationCheck: true })',
    );
    expect(notification.status).toBe("configuration_error");
  });

  test("uses error connection when available and error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("API error") as TelegramError;
            error.type = TelegramErrorType.API_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode({
      connections: { default: "next-node", error: "error-handler-node" },
    });
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("error");
    expect(result.data?.telegramNotificationFailed).toBe(true);
  });

  test("uses default connection when no error connection and error occurs", async () => {
    setTestClientFactory(
      () =>
        ({
          getDefaultChatId: () => "12345",
          sendMessage: async () => {
            const error = new Error("API error") as TelegramError;
            error.type = TelegramErrorType.API_ERROR;
            throw error;
          },
          getRateLimitStatus: () => ({ allowed: true, currentCount: 0 }),
          sendMessageToDefault: async () => {
            throw new Error("not implemented");
          },
          testConnection: async () => true,
        }) as any,
    );

    const node = createTelegramNode({
      connections: { default: "next-node" },
    });
    const context = createContext();

    const result = await handler.execute(node, context, messageQueue, mockRepository, mockEngine);

    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("default");
    expect(result.data?.telegramNotificationFailed).toBe(true);
  });
});
