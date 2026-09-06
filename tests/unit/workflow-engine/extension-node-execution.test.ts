/**
 * Engine-level tests for a custom (extension-contributed) node inside a real graph traversal.
 *
 * The property under test is the one the source issue states as acceptance: the result is stored
 * only under the node's own id and is readable by a later node through `{{node-id.field}}`.
 * A storage snapshot alone cannot show that — a result can be stored correctly and still be
 * unreadable — so the reading node's rendered directive is observed too.
 */

import { describe, test, expect, afterEach } from "@jest/globals";
import {
  GraphExecutionEngine,
  UniversalGraphExecutor,
  ExtensionRegistry,
  InMemoryRepository,
  AgentMessageQueue,
  EXTENSION_API_VERSION,
  setActiveExtensionRegistry,
  setActiveExtensionRunnerClient,
  initializeExtensionsForProcess,
  syncExtensionRegistryFromRunner,
} from "@mcp-moira/workflow-engine";
import type {
  ExecutionContext,
  ExtensionManifest,
  IExtensionRunnerClient,
  WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const MANIFEST: ExtensionManifest = {
  apiVersion: EXTENSION_API_VERSION,
  name: "corporate-messenger",
  version: "1.0.0",
  entrypoint: "dist/index.js",
  nodes: [
    {
      type: "corporate-messenger.send",
      title: "Send message",
      configSchema: { type: "object", properties: { text: { type: "string" } } },
      outputSchema: {
        type: "object",
        required: ["messageId"],
        properties: { messageId: { type: "string" }, deliveredAt: { type: "string" } },
      },
    },
  ],
};

const client: IExtensionRunnerClient = {
  async invoke() {
    return { output: { messageId: "m-77", deliveredAt: "2026-09-02T00:00:00.000Z" } };
  },
};

function graph(): WorkflowGraph {
  return {
    metadata: { name: "Extension execution", version: "1.0.0", description: "test" },
    nodes: [
      { type: "start", id: "start", connections: { default: "send" } },
      {
        type: "corporate-messenger.send",
        id: "send",
        config: { text: "hello" },
        connections: { success: "report", error: "end" },
      },
      {
        type: "agent-directive",
        id: "report",
        directive: "Confirm delivery of {{send.messageId}}",
        completionCondition: "Confirmed",
        inputSchema: { type: "object", properties: { confirmed: { type: "boolean" } } },
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ] as WorkflowGraph["nodes"],
  };
}

function context(): ExecutionContext {
  return {
    variables: {},
    nodeStates: {},
    executionId: "exec-extension",
    workflowId: "wf-extension",
    userId: "user-1",
  };
}

describe("Executing a custom node inside a graph", () => {
  test("result is stored under the node id and read by the next node through a template", async () => {
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    const engine = new GraphExecutionEngine(new InMemoryRepository(), {
      extensionRegistry: registry,
      extensionRunnerClient: client,
    });
    const queue = new AgentMessageQueue();
    const ctx = context();

    const result = await engine.executeGraph(graph(), ctx, queue, "start");

    // Stored shape: the result lives in the node's own scope and adds no global names. Comparing
    // the stored variables (not what a consumer receives) is what separates node-scoped storage
    // from a result merged into the global scope.
    expect(result.context.variables.send).toEqual({
      messageId: "m-77",
      deliveredAt: "2026-09-02T00:00:00.000Z",
    });
    expect(result.context.variables.messageId).toBeUndefined();
    expect(result.context.variables.deliveredAt).toBeUndefined();

    // Readability: the later node's directive resolved the node-scoped field. A stored-but-
    // unreadable result would leave the placeholder unresolved here while the assertion above
    // still passed.
    const flushed = queue.flush("exec-extension");
    const directives = flushed.messages
      .filter((message) => "directive" in message)
      .map((message) => (message as { directive: string }).directive)
      .join(" ");
    expect(directives).toContain("Confirm delivery of m-77");
    expect(directives).not.toContain("{{send.messageId}}");
  });

  test("a graph using a custom type fails clearly when the extension is not installed", async () => {
    // No registry at all: the same graph must not execute, and the reason must point at the
    // extension rather than at an unknown node type.
    const engine = new GraphExecutionEngine(new InMemoryRepository());
    const queue = new AgentMessageQueue();

    await expect(engine.executeGraph(graph(), context(), queue, "start")).rejects.toThrow(
      /belongs to an extension that is not currently installed/,
    );
  });

  test("a registered type without a runner client refuses instead of silently continuing", async () => {
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    const engine = new GraphExecutionEngine(new InMemoryRepository(), {
      extensionRegistry: registry,
    });
    const queue = new AgentMessageQueue();

    await expect(engine.executeGraph(graph(), context(), queue, "start")).rejects.toThrow(
      /runner is not configured/i,
    );
  });

  test("a configured runner unavailable at startup follows the authored error branch", async () => {
    await initializeExtensionsForProcess({
      runnerUrl: "http://runner.local",
      createClient: () => ({
        listExtensions: async () => Promise.reject(new Error("connection refused")),
        invoke: async () => ({ output: {} }),
      }),
      publishSnapshot: false,
    });

    try {
      const executor = new UniversalGraphExecutor(new InMemoryRepository());
      const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;
      const queue = new AgentMessageQueue();
      const result = await engine.executeGraph(graph(), context(), queue, "start");

      expect(result.context.variables.send).toMatchObject({
        extensionFailed: true,
        failureKind: "runner-unavailable",
      });
      const directives = queue
        .flush("exec-extension")
        .messages.filter((message) => "directive" in message)
        .map((message) => (message as { directive: string }).directive);
      expect(directives).toEqual([]);
    } finally {
      setActiveExtensionRegistry(null);
      setActiveExtensionRunnerClient(null);
    }
  });

  test("a live catalog still reports a missing extension as not installed", async () => {
    const engine = new GraphExecutionEngine(new InMemoryRepository(), {
      extensionRegistry: new ExtensionRegistry("live"),
      extensionRunnerClient: client,
    });

    await expect(
      engine.executeGraph(graph(), context(), new AgentMessageQueue(), "start"),
    ).rejects.toThrow(/belongs to an extension that is not currently installed/);
  });

  test("a failed refresh cannot execute through preserved declarations", async () => {
    const registry = new ExtensionRegistry("live");
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);
    let invoked = false;
    const unavailableClient = {
      listExtensions: async () => Promise.reject(new Error("incompatible catalog")),
      invoke: async () => {
        invoked = true;
        return { output: { messageId: "must-not-exist" } };
      },
    };
    setActiveExtensionRunnerClient(unavailableClient);
    await syncExtensionRegistryFromRunner(unavailableClient, { publish: false });

    try {
      const executor = new UniversalGraphExecutor(new InMemoryRepository());
      const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;
      const queue = new AgentMessageQueue();
      const result = await engine.executeGraph(graph(), context(), queue, "start");

      expect(registry.has("corporate-messenger.send")).toBe(true);
      expect(registry.origin).toBe("unreachable");
      expect(result.context.variables.send).toMatchObject({
        extensionFailed: true,
        failureKind: "runner-unavailable",
      });
      expect(queue.flush("exec-extension").messages.some((message) => "directive" in message)).toBe(
        false,
      );
      expect(invoked).toBe(false);
    } finally {
      setActiveExtensionRegistry(null);
      setActiveExtensionRunnerClient(null);
    }
  });
});

describe("Both repository implementations agree about extension settings", () => {
  afterEach(() => {
    setActiveExtensionRegistry(null);
  });

  test("the in-memory repository serves a declared setting like the database one", async () => {
    // Required state: the two implementations of the settings contract answer the same. Plausible
    // wrong state: only the database repository merges declarations, so a handler reading a granted
    // alias gets the value in production and null in every test that uses the in-memory store —
    // a disagreement that makes tests green for the wrong reason.
    const registry = new ExtensionRegistry();
    registry.register({
      ...MANIFEST,
      settings: [
        { key: "corporate-messenger.token", type: "string", label: "Token" },
        {
          key: "corporate-messenger.empty-default",
          type: "string",
          label: "Empty default",
          defaultValue: "",
        },
        {
          key: "corporate-messenger.default-null",
          type: "json",
          label: "Default null",
          defaultValue: "null",
        },
        { key: "corporate-messenger.stored-null", type: "json", label: "Stored null" },
        { key: "corporate-messenger.unset", type: "json", label: "Unset" },
      ],
    });
    setActiveExtensionRegistry(registry);

    const repository = new InMemoryRepository();
    expect(await repository.getSettingDefinition("corporate-messenger.token")).not.toBeNull();

    await repository.setSetting("user-1", "corporate-messenger.token", "value-from-admin");
    expect(await repository.getSetting("user-1", "corporate-messenger.token")).toBe(
      "value-from-admin",
    );

    await repository.setSetting("user-1", "corporate-messenger.stored-null", null);
    expect(await repository.getSetting("user-1", "corporate-messenger.empty-default")).toBe("");
    expect(await repository.getSetting("user-1", "corporate-messenger.default-null")).toBeNull();
    expect(await repository.getSetting("user-1", "corporate-messenger.stored-null")).toBeNull();

    for (const settings of [
      await repository.getSettings("user-1"),
      await repository.getSettingsForApi("user-1"),
    ]) {
      expect(settings["corporate-messenger.empty-default"]).toBe("");
      expect(Object.hasOwn(settings, "corporate-messenger.default-null")).toBe(true);
      expect(settings["corporate-messenger.default-null"]).toBeNull();
      expect(Object.hasOwn(settings, "corporate-messenger.stored-null")).toBe(true);
      expect(settings["corporate-messenger.stored-null"]).toBeNull();
      expect(Object.hasOwn(settings, "corporate-messenger.unset")).toBe(false);
    }
  });
});

describe("The executor takes the same registry as validation", () => {
  afterEach(() => {
    setActiveExtensionRegistry(null);
    setActiveExtensionRunnerClient(null);
  });

  test("an executor built with no options resolves custom types from the process registry", async () => {
    // Required state: what validation accepts, execution runs. Plausible wrong state: the executor
    // keeps its own null default, so every validator accepts the workflow and the run refuses it —
    // a disagreement invisible to any test that passes the registry explicitly.
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);

    const executor = new UniversalGraphExecutor(new InMemoryRepository(), {
      extensionRunnerClient: client,
    });

    const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;
    const queue = new AgentMessageQueue();
    const result = await engine.executeGraph(graph(), context(), queue, "start");

    expect(result.context.variables.send).toEqual({
      messageId: "m-77",
      deliveredAt: "2026-09-02T00:00:00.000Z",
    });
  });

  test("an executor built with no options also takes the process runner client", async () => {
    // Required state: what an installation validates, it runs. Plausible wrong state: only the
    // registry has a process default, so the node type resolves and the call has nowhere to go —
    // the run refuses with "runner is not configured" while every validator accepts the workflow.
    // Passing the client explicitly, as every other test here does, hides exactly that gap.
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);
    setActiveExtensionRunnerClient(client);

    try {
      const executor = new UniversalGraphExecutor(new InMemoryRepository());
      const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;
      const result = await engine.executeGraph(
        graph(),
        context(),
        new AgentMessageQueue(),
        "start",
      );

      expect(result.context.variables.send).toEqual({
        messageId: "m-77",
        deliveredAt: "2026-09-02T00:00:00.000Z",
      });
    } finally {
      setActiveExtensionRunnerClient(null);
    }
  });

  test("without a process runner client the same executor cannot execute the node", async () => {
    const registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    setActiveExtensionRegistry(registry);

    const executor = new UniversalGraphExecutor(new InMemoryRepository());
    const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;

    await expect(
      engine.executeGraph(graph(), context(), new AgentMessageQueue(), "start"),
    ).rejects.toThrow(/runner is not configured/i);
  });

  test("without a process registry the same executor refuses the custom node", async () => {
    const executor = new UniversalGraphExecutor(new InMemoryRepository(), {
      extensionRunnerClient: client,
    });

    const engine = (executor as unknown as { graphEngine: GraphExecutionEngine }).graphEngine;
    const queue = new AgentMessageQueue();

    await expect(engine.executeGraph(graph(), context(), queue, "start")).rejects.toThrow(
      /belongs to an extension that is not currently installed/,
    );
  });
});
