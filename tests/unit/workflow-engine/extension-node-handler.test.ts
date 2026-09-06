/**
 * Unit tests for executing a custom (extension-contributed) node.
 *
 * Two properties are easy to confuse with weaker ones and are therefore observed directly:
 *  - the node is executed OUT of process. A handler imported into Moira would produce identical
 *    output, so the test supplies a client that performs no extension logic at all and only
 *    records the call; if the node still produces a result, that result came through the client.
 *  - a failure never reaches later nodes as success. Four distinct causes must be distinguishable
 *    in the diagnostics, because a custom node's result is consumed downstream.
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import {
  ExtensionNodeHandler,
  ExtensionRegistry,
  ExtensionInvocationError,
  AgentMessageQueue,
  EXTENSION_API_VERSION,
  DEFAULT_EXTENSION_TIMEOUT_MS,
} from "@mcp-moira/workflow-engine";
import type {
  ExecutionContext,
  ExtensionNode,
  ExtensionManifest,
  IExtensionRunnerClient,
  ExtensionInvocationRequest,
  IDataRepository,
  IGraphExecutionEngine,
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
      configSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        required: ["messageId"],
        properties: { messageId: { type: "string" } },
      },
    },
  ],
};

/** A client that runs no extension logic; it only records the call and replays a canned result. */
class RecordingClient implements IExtensionRunnerClient {
  calls: ExtensionInvocationRequest[] = [];

  constructor(private readonly behaviour: () => Promise<Record<string, unknown>>) {}

  async invoke(request: ExtensionInvocationRequest) {
    this.calls.push(request);
    return { output: await this.behaviour() };
  }
}

function createNode(overrides: Partial<ExtensionNode> = {}): ExtensionNode {
  return {
    type: "corporate-messenger.send",
    id: "notify-owner",
    config: { text: "Build {{build_status}}" },
    connections: { success: "next-node", error: "failure-node" },
    ...overrides,
  } as ExtensionNode;
}

function createContext(): ExecutionContext {
  return {
    variables: { build_status: "green" },
    nodeStates: {},
    executionId: "exec-1",
    workflowId: "wf-1",
    userId: "user-1",
  };
}

const repository = {} as IDataRepository;
const engine = {} as IGraphExecutionEngine;

describe("ExtensionNodeHandler", () => {
  let registry: ExtensionRegistry;
  let queue: AgentMessageQueue;

  beforeEach(() => {
    registry = new ExtensionRegistry();
    registry.register(MANIFEST);
    queue = new AgentMessageQueue();
  });

  test("executes the node through the runner client and returns its output on success", async () => {
    const client = new RecordingClient(async () => ({ messageId: "m-42" }));
    const handler = new ExtensionNodeHandler(registry, client);

    const result = await handler.execute(createNode(), createContext(), queue, repository, engine);

    // The client performed no extension logic, so a produced result proves the call left Moira.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].nodeType).toBe("corporate-messenger.send");
    expect(client.calls[0].nodeId).toBe("notify-owner");
    expect(client.calls[0].executionId).toBe("exec-1");
    expect(result.action).toBe("continue");
    expect(result.outputPath).toBe("success");
    expect(result.data).toEqual({ messageId: "m-42" });
  });

  test("declared input and deadline reach the call, with the default deadline when unset", async () => {
    // Dropping either field would still produce a correct-looking result on the happy path, so
    // the request itself is inspected: the extension must receive the input it was given and a
    // deadline, not silently an empty input or someone else's timeout.
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const handler = new ExtensionNodeHandler(registry, client);

    await handler.execute(
      createNode({ input: { attempt: 2 }, timeout: 5000 }),
      createContext(),
      queue,
      repository,
      engine,
    );
    await handler.execute(createNode(), createContext(), queue, repository, engine);

    expect(client.calls[0].input).toEqual({ attempt: 2 });
    expect(client.calls[0].timeoutMs).toBe(5000);
    // A node with no input sends an empty map rather than nothing: input is template-processed and
    // checked against the declaration like configuration, and "absent" is the empty case of that.
    expect(client.calls[1].input).toEqual({});
    expect(client.calls[1].timeoutMs).toBe(DEFAULT_EXTENSION_TIMEOUT_MS);
  });

  test("an explicitly injected registry is the authority for granted secret aliases", async () => {
    // Required state: the handler resolves permissions from the same registry that admitted the
    // node. Plausible wrong state: it consults the process-global registry, so an explicitly
    // constructed engine can execute the node but silently omit its granted secret.
    const explicitRegistry = new ExtensionRegistry();
    explicitRegistry.register({
      ...MANIFEST,
      settings: [{ key: "corporate-messenger.token", type: "encrypted", label: "API token" }],
      permissions: { secrets: ["corporate-messenger.token"] },
    });
    const client = new RecordingClient(async () => ({ messageId: "m-secret" }));
    const handler = new ExtensionNodeHandler(explicitRegistry, client);
    const settingsRepository = {
      async getSetting(_userId: string, key: string) {
        return key === "corporate-messenger.token" ? "secret-from-explicit-registry" : null;
      },
    } as IDataRepository;

    await handler.execute(createNode(), createContext(), queue, settingsRepository, engine);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].secrets).toEqual({
      "corporate-messenger.token": "secret-from-explicit-registry",
    });
  });

  test("node configuration is template-processed before it leaves Moira", async () => {
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const handler = new ExtensionNodeHandler(registry, client);

    await handler.execute(createNode(), createContext(), queue, repository, engine);

    expect(client.calls[0].config).toEqual({ text: "Build green" });
  });

  test("templates are substituted at every depth of configuration and input", async () => {
    // Required state: a template resolves wherever it is written. Plausible wrong state: only the
    // top level is walked, so a string nested in an object or an array reaches the handler as the
    // literal `{{name}}` — still a string, so the declared schema accepts it, and nothing
    // downstream can tell the difference between "the variable was empty" and "nothing substituted".
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const handler = new ExtensionNodeHandler(registry, client);

    await handler.execute(
      createNode({
        config: {
          text: "Build {{build_status}}",
          payload: { title: "Build {{build_status}}", tags: ["{{build_status}}", 7] },
        },
        input: { nested: { note: "was {{build_status}}" } },
      }),
      createContext(),
      queue,
      repository,
      engine,
    );

    expect(client.calls[0].config).toEqual({
      text: "Build green",
      payload: { title: "Build green", tags: ["green", 7] },
    });
    expect(client.calls[0].input).toEqual({ nested: { note: "was green" } });
  });

  test("refuses to execute when no runner client is configured", async () => {
    const handler = new ExtensionNodeHandler(registry, null);

    await expect(
      handler.execute(createNode(), createContext(), queue, repository, engine),
    ).rejects.toThrow(/runner is not configured/i);
  });

  test("refuses a node whose extension is not installed, naming the extension", async () => {
    const emptyRegistry = new ExtensionRegistry();
    const handler = new ExtensionNodeHandler(
      emptyRegistry,
      new RecordingClient(async () => ({ messageId: "x" })),
    );

    await expect(
      handler.execute(createNode(), createContext(), queue, repository, engine),
    ).rejects.toThrow(/not currently installed/i);
  });

  test.each([
    ["handler-error", "boom", /Extension handler failed/],
    ["timeout", "deadline exceeded", /exceeded its deadline/],
    ["runner-unavailable", "connection refused", /runner is unavailable/],
  ])(
    "routes a %s failure to the error connection with its own diagnostics",
    async (kind, message, expectedText) => {
      const failing: IExtensionRunnerClient = {
        async invoke() {
          throw new ExtensionInvocationError(kind as never, message);
        },
      };
      const handler = new ExtensionNodeHandler(registry, failing);

      const result = await handler.execute(
        createNode(),
        createContext(),
        queue,
        repository,
        engine,
      );

      expect(result.action).toBe("continue");
      expect(result.outputPath).toBe("error");
      expect(result.data).toMatchObject({ extensionFailed: true, failureKind: kind });
      expect(String((result.data as { errorMessage: string }).errorMessage)).toContain(message);
      const flushed = queue.flush("exec-1");
      const notificationTexts = flushed.messages
        .filter((message) => "notificationText" in message)
        .map((message) => (message as { notificationText: string }).notificationText)
        .join(" ");
      expect(notificationTexts).toMatch(expectedText);
    },
  );

  test("input that violates the declared inputSchema is refused before the call is made", async () => {
    // Required state: a declared inputSchema is enforced somewhere. Plausible wrong state: it is
    // carried in the manifest, shown in the editor and named in the documentation while nothing
    // reads it, so a wrongly typed value reaches a typed handler and fails inside the extension —
    // or does not fail at all. The distinguishing observation is that the call is never made.
    const typedRegistry = new ExtensionRegistry();
    typedRegistry.register({
      ...MANIFEST,
      nodes: [
        {
          ...MANIFEST.nodes[0],
          inputSchema: {
            type: "object",
            required: ["attempt"],
            properties: { attempt: { type: "number" } },
          },
        },
      ],
    });
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const handler = new ExtensionNodeHandler(typedRegistry, client);

    const result = await handler.execute(
      createNode({ input: { attempt: "two" } }),
      createContext(),
      queue,
      repository,
      engine,
    );

    expect(client.calls).toHaveLength(0);
    expect(result.outputPath).toBe("error");
    expect(result.data).toMatchObject({ extensionFailed: true, failureKind: "invalid-input" });
    expect(String((result.data as { errorMessage: string }).errorMessage)).toContain("inputSchema");
  });

  test("configuration is checked after substitution, not as it was authored", async () => {
    // A template makes the authored text and the sent value different things. Checking the authored
    // text would accept `{{missing}}` for a required field and hand the handler an unresolved
    // placeholder; checking the substituted value is what the handler actually receives.
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const strictRegistry = new ExtensionRegistry();
    strictRegistry.register({
      ...MANIFEST,
      nodes: [
        {
          ...MANIFEST.nodes[0],
          configSchema: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string", enum: ["Build green", "Build red"] } },
          },
        },
      ],
    });
    const handler = new ExtensionNodeHandler(strictRegistry, client);

    const accepted = await handler.execute(
      createNode(),
      createContext(),
      queue,
      repository,
      engine,
    );
    const refused = await handler.execute(
      createNode({ config: { text: "Build {{unknown_variable}}" } }),
      createContext(),
      queue,
      repository,
      engine,
    );

    expect(accepted.outputPath).toBe("success");
    expect(client.calls).toHaveLength(1);
    expect(refused.outputPath).toBe("error");
    expect(refused.data).toMatchObject({ failureKind: "invalid-input" });
    expect(String((refused.data as { errorMessage: string }).errorMessage)).toContain(
      "configSchema",
    );
  });

  test("an output that violates the declared schema is a failure, not a result", async () => {
    // The wrong state this separates from: passing the handler's output through unchecked, which
    // would put a value later nodes read as valid into the execution context.
    const client = new RecordingClient(async () => ({ wrongField: 1 }) as Record<string, unknown>);
    const handler = new ExtensionNodeHandler(registry, client);

    const result = await handler.execute(createNode(), createContext(), queue, repository, engine);

    expect(result.outputPath).toBe("error");
    expect(result.data).toMatchObject({ failureKind: "invalid-output" });
    expect(result.data).not.toMatchObject({ wrongField: 1 });
  });

  test("a long-lived handler uses the schema from an in-place registry refresh", async () => {
    const client = new RecordingClient(async () => ({ messageId: "m-1" }));
    const handler = new ExtensionNodeHandler(registry, client);

    expect(
      (await handler.execute(createNode(), createContext(), queue, repository, engine)).outputPath,
    ).toBe("success");

    registry.replaceAll([
      {
        ...MANIFEST,
        version: "2.0.0",
        nodes: [
          {
            ...MANIFEST.nodes[0],
            configSchema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string", enum: ["Build red"] } },
            },
          },
        ],
      },
    ]);

    const refreshed = await handler.execute(
      createNode(),
      createContext(),
      queue,
      repository,
      engine,
    );
    expect(refreshed.outputPath).toBe("error");
    expect(refreshed.data).toMatchObject({ failureKind: "invalid-input" });
    expect(client.calls).toHaveLength(1);
  });

  test("without an error connection a failure stops the node instead of continuing on success", async () => {
    const failing: IExtensionRunnerClient = {
      async invoke() {
        throw new ExtensionInvocationError("handler-error", "boom");
      },
    };
    const handler = new ExtensionNodeHandler(registry, failing);

    const result = await handler.execute(
      createNode({ connections: { success: "next-node" } }),
      createContext(),
      queue,
      repository,
      engine,
    );

    expect(result.action).toBe("error");
    expect(result.outputPath).toBeUndefined();
  });

  test("canExecute is true only for registered custom types", () => {
    const handler = new ExtensionNodeHandler(registry, null);
    const context = createContext();

    expect(handler.canExecute!(createNode(), context)).toBe(true);
    expect(handler.canExecute!(createNode({ type: "other.thing" } as never), context)).toBe(false);
    expect(
      handler.canExecute!(
        { type: "telegram-notification", id: "t", message: "x", connections: { default: "n" } },
        context,
      ),
    ).toBe(false);
  });
});
