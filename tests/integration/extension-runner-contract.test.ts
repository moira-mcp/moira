/**
 * Contract between Moira and the extension runner, exercised on both sides of the boundary.
 *
 * The property that matters is containment: an extension may fail in any way it likes, and the
 * service must remain answerable and able to serve the next call. "Answerable" is checked after
 * every failure mode rather than once at the end, because the mode that breaks a service is
 * usually the one nobody exercised — an outright process exit, not a thrown error.
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { startExtensionRunner, type RunningRunner } from "@mcp-moira/extension-runner";
import {
  GraphExecutionEngine,
  InMemoryRepository,
  AgentMessageQueue,
  HttpExtensionRunnerClient,
  ExtensionInvocationError,
  ExtensionRegistry,
  setActiveExtensionRegistry,
  getActiveExtensionRegistry,
  syncExtensionRegistryFromRunner,
} from "@mcp-moira/workflow-engine";
import type { ExecutionContext, WorkflowGraph } from "@mcp-moira/workflow-engine";

const BUNDLES_DIR = path.resolve(process.cwd(), "tests/fixtures/extension-bundles");

let runner: RunningRunner;
let client: HttpExtensionRunnerClient;
/** Log lines the service received from handler processes, used to observe cancellation. */
const runnerLogs: string[] = [];

function invocation(behaviour: string, extra: Record<string, unknown> = {}, timeoutMs = 5_000) {
  return {
    nodeType: "probe.behave",
    nodeId: "probe-node",
    executionId: "exec-contract",
    workflowId: "wf-contract",
    config: { behaviour, ...extra },
    timeoutMs,
  };
}

async function healthy(): Promise<boolean> {
  const health = await client.health();
  return health.ready;
}

async function waitForMarkerLines(file: string, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
      if (lines.length >= minimum) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`startup marker did not reach ${minimum} line(s)`);
}

beforeAll(async () => {
  runner = await startExtensionRunner({
    extensionsDir: BUNDLES_DIR,
    port: 0,
    host: "127.0.0.1",
    // The handler process runs the bundle's TypeScript through the same loader the repository uses.
    execArgv: ["--import", "tsx"],
    log: (message) => runnerLogs.push(message),
  });
  client = new HttpExtensionRunnerClient({ baseUrl: `http://127.0.0.1:${runner.port}` });
}, 60_000);

afterAll(async () => {
  await runner?.close();
});

describe("The runner provides what the bundle declares", () => {
  test("declarations reach Moira as metadata and schemas", async () => {
    const extensions = await client.listExtensions();

    expect(extensions.map((extension) => extension.name)).toContain("probe");
    const probe = extensions.find((extension) => extension.name === "probe")!;
    expect(probe.nodes.map((node) => node.type)).toEqual(["probe.behave"]);
    expect(probe.nodes[0].outputSchema).toMatchObject({ required: ["observed"] });
    // Code never crosses the boundary: only the entrypoint's name does.
    expect(JSON.stringify(probe)).not.toContain("defineNode");
  });

  test("a normal call returns the handler result", async () => {
    const result = await client.invoke(invocation("succeed"));

    expect(result.output).toEqual({ observed: "succeeded" });
  });
});

describe("A failing extension does not take the service with it", () => {
  test("a thrown handler error is reported and the service stays answerable", async () => {
    await expect(client.invoke(invocation("throw"))).rejects.toMatchObject({
      kind: "handler-error",
    });

    expect(await healthy()).toBe(true);
    await expect(client.invoke(invocation("succeed"))).resolves.toMatchObject({
      output: { observed: "succeeded" },
    });
  });

  test("a handler that outlives its deadline is stopped, and cancellation reaches it", async () => {
    const before = runnerLogs.length;

    await expect(client.invoke(invocation("hang", {}, 300))).rejects.toMatchObject({
      kind: "timeout",
    });

    // Required state: the deadline reaches the handler. Plausible wrong state: the service stops
    // waiting and kills the process, which produces the same timeout for the caller while the
    // handler never learns it was cancelled. The handler's own log line separates the two, and it
    // can only appear if the abort signal fired inside the handler.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runnerLogs.slice(before).join(" ")).toContain("probe observed cancellation");

    expect(await healthy()).toBe(true);
    await expect(client.invoke(invocation("succeed"))).resolves.toMatchObject({
      output: { observed: "succeeded" },
    });
  });

  test("after one extension fails, a call to a different extension still succeeds", async () => {
    await expect(client.invoke(invocation("crash"))).rejects.toMatchObject({
      kind: "runner-unavailable",
    });

    const other = await client.invoke({
      nodeType: "scribe.write",
      nodeId: "scribe-node",
      executionId: "exec-contract",
      workflowId: "wf-contract",
      config: { name: "after-crash.txt", content: "still working" },
      timeoutMs: 5_000,
    });

    expect(other.output).toEqual({ observed: "written" });
  });

  test("a result violating the declared schema is a failure, not a result", async () => {
    await expect(client.invoke(invocation("bad-output"))).rejects.toMatchObject({
      kind: "invalid-output",
    });

    expect(await healthy()).toBe(true);
  });

  test("a handler process that exits leaves the service running and recovers on the next call", async () => {
    // The case a try/catch cannot cover: the process is gone, not an exception.
    await expect(client.invoke(invocation("crash"))).rejects.toMatchObject({
      kind: "runner-unavailable",
    });

    expect(await healthy()).toBe(true);
    await expect(client.invoke(invocation("succeed"))).resolves.toMatchObject({
      output: { observed: "succeeded" },
    });
  });
});

describe("Capabilities are granted, not assumed", () => {
  test("a host outside the granted network permission is refused by name", async () => {
    const refused = await client.invoke(invocation("network", { host: "not-allowed.example" }));

    expect(String(refused.output.observed)).toContain("network-refused");
    expect(String(refused.output.observed)).toContain("not granted");
  });

  test("an allowed host cannot redirect a request to an ungranted host", async () => {
    let targetReached = false;
    const target = http.createServer((_request, response) => {
      targetReached = true;
      response.end("ungranted target");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    const targetPort = typeof targetAddress === "object" && targetAddress ? targetAddress.port : 0;

    const redirect = http.createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/target` });
      response.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const redirectAddress = redirect.address();
    const redirectPort =
      typeof redirectAddress === "object" && redirectAddress ? redirectAddress.port : 0;

    const root = fs.mkdtempSync(path.join(process.cwd(), "tests/fixtures/redirect-extension-"));
    const bundle = path.join(root, "redirect-probe");
    fs.mkdirSync(bundle);
    fs.writeFileSync(
      path.join(bundle, "index.ts"),
      `import { defineExtension, defineNode } from "@mcp-moira/extension-sdk";
export default defineExtension({ nodes: [defineNode({
  type: "redirect-probe.fetch",
  async handler({ config, services }) {
    try {
      const response = await services.fetch(String(config.url));
      return { observed: await response.text() };
    } catch (error) {
      return { observed: "refused: " + String(error) };
    }
  }
})] });\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(bundle, "moira-extension.json"),
      JSON.stringify({
        apiVersion: "moira.extensions/v1",
        name: "redirect-probe",
        version: "1.0.0",
        entrypoint: "index.ts",
        nodes: [
          {
            type: "redirect-probe.fetch",
            title: "Fetch",
            configSchema: { type: "object" },
            outputSchema: {
              type: "object",
              required: ["observed"],
              properties: { observed: { type: "string" } },
            },
          },
        ],
        permissions: { network: [`127.0.0.1:${redirectPort}`] },
      }),
      "utf-8",
    );

    let redirectRunner: RunningRunner | undefined;
    try {
      redirectRunner = await startExtensionRunner({
        extensionsDir: root,
        host: "127.0.0.1",
        port: 0,
        execArgv: ["--import", "tsx"],
      });
      const redirectClient = new HttpExtensionRunnerClient({
        baseUrl: `http://127.0.0.1:${redirectRunner.port}`,
      });
      const result = await redirectClient.invoke({
        nodeType: "redirect-probe.fetch",
        nodeId: "redirect",
        executionId: "exec-contract",
        workflowId: "wf-contract",
        config: { url: `http://127.0.0.1:${redirectPort}/start` },
        timeoutMs: 5_000,
      });

      expect(String(result.output.observed)).toContain("not granted");
      expect(targetReached).toBe(false);
    } finally {
      await redirectRunner?.close();
      await new Promise<void>((resolve) => redirect.close(() => resolve()));
      await new Promise<void>((resolve) => target.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a secret alias that was not granted is refused, which differs from an unset value", async () => {
    const refused = await client.invoke(invocation("secret", { alias: "telegram.bot_token" }));
    expect(String(refused.output.observed)).toContain("secret-refused");

    const granted = await client.invoke(invocation("secret", { alias: "probe.token" }));
    // Granted but with no value supplied by Moira: "unset", not a refusal.
    expect(granted.output.observed).toBe("secret:unset");
  });

  test("artifact writing without the permission is refused", async () => {
    const refused = await client.invoke(invocation("artifact"));

    expect(String(refused.output.observed)).toContain("artifact-refused");
  });

  test("a granted artifact write produces a result Moira receives", async () => {
    // The refusal above is only half the statement: a permission that is granted has to produce
    // something observable, otherwise "refused" and "granted but going nowhere" look alike.
    const written = await client.invoke({
      nodeType: "scribe.write",
      nodeId: "scribe-node",
      executionId: "exec-contract",
      workflowId: "wf-contract",
      config: { name: "report.txt", content: "written by the extension" },
      timeoutMs: 5_000,
    });

    expect(written.output).toEqual({ observed: "written" });
    expect(written.artifacts).toEqual([
      { name: "report.txt", content: "written by the extension" },
    ]);
  });

  test("a malformed artifact message fails only its handler process", async () => {
    await expect(
      client.invoke({
        nodeType: "scribe.write",
        nodeId: "scribe-node",
        executionId: "exec-contract",
        workflowId: "wf-contract",
        config: { malformedArtifact: true },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ kind: "runner-unavailable" });

    expect(await healthy()).toBe(true);
    await expect(client.invoke(invocation("succeed"))).resolves.toMatchObject({
      output: { observed: "succeeded" },
    });
  });

  test("an artifact beyond the size limit fails the call instead of being carried", async () => {
    // Required state: the return path is bounded. Plausible wrong state: only the request body is
    // capped, so an extension can put unlimited content into the response, the service's memory and
    // the stored execution. The distinguishing observation is that the oversized call fails and the
    // service is unharmed, while an ordinary call still carries its artifact.
    const oversized = await client
      .invoke({
        nodeType: "scribe.write",
        nodeId: "scribe-node",
        executionId: "exec-contract",
        workflowId: "wf-contract",
        config: { name: "huge.txt", size: 512 * 1024 },
        timeoutMs: 5_000,
      })
      .catch((error: unknown) => error);

    expect(oversized).toBeInstanceOf(ExtensionInvocationError);
    expect(oversized).toMatchObject({ kind: "handler-error" });
    expect((oversized as Error).message).toContain("size limit");

    expect(await healthy()).toBe(true);
    const ordinary = await client.invoke({
      nodeType: "scribe.write",
      nodeId: "scribe-node",
      executionId: "exec-contract",
      workflowId: "wf-contract",
      config: { name: "small.txt", content: "still fine" },
      timeoutMs: 5_000,
    });
    expect(ordinary.artifacts).toEqual([{ name: "small.txt", content: "still fine" }]);
  }, 30_000);

  test("artifacts that are each allowed but too large together fail the call", async () => {
    // The second half of the same limit: five artifacts of 250 KiB are individually under the
    // per-artifact bound, so only a running total stops them. Without one, a call could carry an
    // unbounded amount of content in small pieces.
    const overTotal = await client
      .invoke({
        nodeType: "scribe.write",
        nodeId: "scribe-node",
        executionId: "exec-contract",
        workflowId: "wf-contract",
        config: { name: "part.txt", size: 250 * 1024, count: 5 },
        timeoutMs: 5_000,
      })
      .catch((error: unknown) => error);

    expect(overTotal).toBeInstanceOf(ExtensionInvocationError);
    expect(overTotal).toMatchObject({ kind: "handler-error" });
    expect((overTotal as Error).message).toContain("size limit");

    expect(await healthy()).toBe(true);
  }, 30_000);
});

describe("An unreachable runner is distinguishable from a failing extension", () => {
  test("a client pointed at nothing reports the runner as unavailable", async () => {
    const offline = new HttpExtensionRunnerClient({ baseUrl: "http://127.0.0.1:1" });

    await expect(offline.invoke(invocation("succeed"))).rejects.toBeInstanceOf(
      ExtensionInvocationError,
    );
    await expect(offline.invoke(invocation("succeed"))).rejects.toMatchObject({
      kind: "runner-unavailable",
    });
  });
});

describe("The registry Moira serves is filled from the runner", () => {
  afterAll(() => {
    setActiveExtensionRegistry(null);
  });

  test("declarations become registered custom types, and the same object is updated in place", async () => {
    const registry = new ExtensionRegistry();
    setActiveExtensionRegistry(registry);
    expect(registry.has("probe.behave")).toBe(false);

    const result = await syncExtensionRegistryFromRunner(client, { publish: false });

    expect(result.synced).toBe(true);
    expect(result.registered).toContain("probe");
    // Mutated in place: a consumer that took the object earlier — the graph executor does — must
    // see the new types without being rebuilt.
    expect(registry.has("probe.behave")).toBe(true);
    expect(getActiveExtensionRegistry()).toBe(registry);
  });

  test("an unreachable runner leaves the previous state instead of erasing it", async () => {
    const registry = new ExtensionRegistry();
    setActiveExtensionRegistry(registry);
    await syncExtensionRegistryFromRunner(client, { publish: false });
    expect(registry.has("probe.behave")).toBe(true);

    const offline = new HttpExtensionRunnerClient({ baseUrl: "http://127.0.0.1:1" });
    const result = await syncExtensionRegistryFromRunner(offline, { publish: false });

    expect(result.synced).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(registry.has("probe.behave")).toBe(true);
  });
});

describe("One extension cannot occupy the host without limit", () => {
  test("calls beyond the configured concurrency wait instead of running together", async () => {
    const limited = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
      maxConcurrentPerExtension: 1,
    });
    const limitedClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${limited.port}`,
    });

    try {
      // The first call occupies the only slot until its deadline kills it. What separates waiting
      // from running side by side is *when the second call finishes*: total elapsed time cannot
      // show it, because the first call takes its whole deadline either way.
      const started = Date.now();
      let firstFinishedAt = 0;
      let secondFinishedAt = 0;

      const first = limitedClient
        .invoke(invocation("hang", {}, 400))
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          firstFinishedAt = Date.now() - started;
        });
      const second = limitedClient.invoke(invocation("succeed")).then((result) => {
        secondFinishedAt = Date.now() - started;
        return result;
      });

      await expect(second).resolves.toMatchObject({ output: { observed: "succeeded" } });
      await first;

      expect(firstFinishedAt).toBeGreaterThanOrEqual(400);
      // Without the limit this call would be served beside the hanging one and finish long before
      // the first call's deadline.
      expect(secondFinishedAt).toBeGreaterThanOrEqual(400);
    } finally {
      await limited.close();
    }
  }, 30_000);

  test("a queued call whose deadline expires is removed without invoking the extension", async () => {
    const logs: string[] = [];
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const limited = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
      maxConcurrentPerExtension: 1,
      log: (message) => {
        logs.push(message);
        if (message.includes("probe started hang")) blockerStarted();
      },
    });
    const limitedClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${limited.port}`,
    });

    try {
      const blocker = limitedClient.invoke(invocation("hang", {}, 500)).catch(() => undefined);
      await started;

      await expect(limitedClient.invoke(invocation("succeed", {}, 100))).rejects.toMatchObject({
        kind: "timeout",
      });
      await blocker;
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(logs.join(" ")).not.toContain("probe started succeed");
    } finally {
      await limited.close();
    }
  }, 30_000);

  test("a queued call disconnected by its caller is removed without invoking the extension", async () => {
    const logs: string[] = [];
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const limited = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
      maxConcurrentPerExtension: 1,
      log: (message) => {
        logs.push(message);
        if (message.includes("probe started hang")) blockerStarted();
      },
    });

    try {
      const limitedClient = new HttpExtensionRunnerClient({
        baseUrl: `http://127.0.0.1:${limited.port}`,
      });
      const blocker = limitedClient.invoke(invocation("hang", {}, 500)).catch(() => undefined);
      await started;

      const controller = new AbortController();
      const abandoned = fetch(`http://127.0.0.1:${limited.port}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invocation("succeed", {}, 5_000)),
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      controller.abort();
      await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });

      await blocker;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(logs.join(" ")).not.toContain("probe started succeed");
    } finally {
      await limited.close();
    }
  }, 30_000);

  test("queue overflow is refused and shutdown cannot start waiting work", async () => {
    const logs: string[] = [];
    let blockerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const limited = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
      maxConcurrentPerExtension: 1,
      maxQueuedPerExtension: 1,
      log: (message) => {
        logs.push(message);
        if (message.includes("probe started hang")) blockerStarted();
      },
    });
    const limitedClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${limited.port}`,
    });

    const blocker = limitedClient.invoke(invocation("hang", {}, 10_000)).catch((error) => error);
    await started;
    const queued = limitedClient.invoke(invocation("succeed", {}, 5_000)).catch((error) => error);
    // The first request is known to be running. Give the loopback server one event turn to admit
    // the next request into its sole waiting slot before sending the overflow request.
    await new Promise((resolve) => setTimeout(resolve, 75));
    const overflow = limitedClient.invoke(invocation("succeed", {}, 5_000)).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 75));

    await limited.close();
    const [blockerResult, queuedResult, overflowResult] = await Promise.all([
      blocker,
      queued,
      overflow,
    ]);

    expect(blockerResult).toMatchObject({ kind: "runner-unavailable" });
    expect(queuedResult).toMatchObject({ kind: "runner-unavailable" });
    expect(overflowResult).toMatchObject({
      kind: "runner-unavailable",
      message: "extension invocation queue is full",
    });
    expect(logs.join(" ")).not.toContain("probe started succeed");
  }, 30_000);
});

describe("One call's deadline belongs to that call alone", () => {
  test("a healthy call sharing the process with a timed-out one still returns its result", async () => {
    // Required state: a deadline ends the call it belongs to. Plausible wrong state: the deadline
    // kills the shared handler process immediately, so a call well inside its own deadline is
    // failed as `runner-unavailable` for a reason belonging to a different call — invisible while
    // every other observation sends one call at a time.
    const shared = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
    });
    const sharedClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${shared.port}`,
    });

    try {
      // Warm the process so both calls are served by the same one.
      await sharedClient.invoke({ ...invocation("succeed"), nodeId: "warm" });

      const slow = sharedClient
        .invoke(invocation("hang", {}, 400))
        .then(() => "resolved" as const)
        .catch((error: ExtensionInvocationError) => error.kind);
      // Long enough to still be running when the first call's deadline passes.
      const healthy = sharedClient.invoke(invocation("sleep", { ms: 900 }, 5_000));

      expect(await slow).toBe("timeout");
      await expect(healthy).resolves.toMatchObject({ output: { observed: "slept" } });
    } finally {
      await shared.close();
    }
  }, 30_000);
});

describe("A bundle that fails while loading is contained too", () => {
  // Manifest checks happen before any extension code runs, so a bundle that is well-formed on paper
  // and broken in its code is a different failure from a refused bundle: nothing observes it until
  // the handler process tries to load it.
  const BROKEN_DIR = path.resolve(process.cwd(), "tests/fixtures/extension-bundles-broken");
  let broken: RunningRunner;
  let brokenClient: HttpExtensionRunnerClient;

  const call = (nodeType: string) => ({
    nodeType,
    nodeId: "broken-node",
    executionId: "exec-contract",
    workflowId: "wf-contract",
    config: {},
    timeoutMs: 5_000,
  });

  beforeAll(async () => {
    broken = await startExtensionRunner({
      extensionsDir: BROKEN_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
    });
    brokenClient = new HttpExtensionRunnerClient({ baseUrl: `http://127.0.0.1:${broken.port}` });
  }, 60_000);

  afterAll(async () => {
    await broken?.close();
  });

  test("all broken-behavior fixtures pass manifest checks, so failure is not a refusal", () => {
    expect(broken.scan.rejected).toEqual([]);
    expect(broken.scan.bundles.map((bundle) => bundle.manifest.name).sort()).toEqual([
      "disagreeing",
      "exiting",
      "hanging",
      "reordered",
      "slow-start",
      "throwing",
    ]);
  });

  test("a bundle that throws on import fails its call and is reported unhealthy", async () => {
    await expect(brokenClient.invoke(call("throwing.go"))).rejects.toMatchObject({
      kind: "handler-error",
    });

    const health = (await brokenClient.health()) as {
      ready: boolean;
      body: { extensions: Array<{ name: string; healthy: boolean }> };
    };
    expect(health.ready).toBe(true);
    expect(health.body.extensions).toContainEqual(
      expect.objectContaining({ name: "throwing", healthy: false }),
    );
  }, 30_000);

  test("code that restates a schema differently from the manifest refuses the bundle by name", async () => {
    // Required state: one declaration governs. Plausible wrong state: the manifest quietly wins and
    // the author keeps reading the schema in their code — the divergence is invisible until a node
    // is refused for a reason the code does not explain. Manifest checks cannot see this: they run
    // before any extension code is imported.
    await expect(brokenClient.invoke(call("disagreeing.go"))).rejects.toMatchObject({
      kind: "handler-error",
    });

    const health = (await brokenClient.health()) as {
      body: { extensions: Array<{ name: string; healthy: boolean }> };
    };
    expect(health.body.extensions).toContainEqual(
      expect.objectContaining({ name: "disagreeing", healthy: false }),
    );
  }, 30_000);

  test("a bundle whose process dies during startup is answered instead of waited on", async () => {
    // Required state: a start that produces no message at all still ends in an answer. Plausible
    // wrong state: only the reported load failure is handled, so a process that exits silently
    // leaves the start promise unsettled and the call waits until the caller's own deadline —
    // which looks like a slow extension rather than a broken one.
    const started = Date.now();

    await expect(brokenClient.invoke(call("exiting.go"))).rejects.toMatchObject({
      kind: "handler-error",
    });

    // Far below the call's own 5 s deadline: the answer comes from the failed start, not from a
    // transport giving up.
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 30_000);

  test("a bundle whose import never settles is stopped by the invocation deadline", async () => {
    await expect(
      brokenClient.invoke({ ...call("hanging.go"), timeoutMs: 300 }),
    ).rejects.toMatchObject({ kind: "timeout" });

    expect((await brokenClient.health()).ready).toBe(true);
    await expect(brokenClient.invoke(call("reordered.go"))).resolves.toMatchObject({
      output: { observed: "same schema" },
    });
  }, 30_000);

  test("a short cold-start deadline does not fail a concurrent longer call", async () => {
    const marker = path.join(BROKEN_DIR, "slow-start", ".startup-observed");
    fs.rmSync(marker, { force: true });
    try {
      const long = brokenClient.invoke({
        ...call("slow-start.go"),
        nodeId: "long",
        timeoutMs: 2_000,
      });
      await waitForMarkerLines(marker, 1);
      const short = brokenClient
        .invoke({ ...call("slow-start.go"), timeoutMs: 150 })
        .then(() => "resolved" as const)
        .catch((error: ExtensionInvocationError) => error.kind);

      expect(await short).toBe("timeout");
      await expect(long).resolves.toMatchObject({ output: { observed: "started" } });
      expect(fs.readFileSync(marker, "utf-8").trim().split("\n")).toHaveLength(1);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  }, 30_000);

  test("shutdown during cold start cannot fork a replacement handler", async () => {
    const marker = path.join(BROKEN_DIR, "slow-start", ".startup-observed");
    fs.rmSync(marker, { force: true });
    const shuttingDown = await startExtensionRunner({
      extensionsDir: BROKEN_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
    });
    const shuttingDownClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${shuttingDown.port}`,
    });

    try {
      const callDuringStart = shuttingDownClient
        .invoke({ ...call("slow-start.go"), timeoutMs: 5_000 })
        .catch((error) => error);
      await waitForMarkerLines(marker, 1);
      await shuttingDown.close();

      expect(await callDuringStart).toMatchObject({ kind: "runner-unavailable" });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(fs.readFileSync(marker, "utf-8").trim().split("\n")).toHaveLength(1);
    } finally {
      await shuttingDown.close();
      fs.rmSync(marker, { force: true });
    }
  }, 30_000);

  test("equivalent restated schemas are independent of object key order", async () => {
    await expect(brokenClient.invoke(call("reordered.go"))).resolves.toMatchObject({
      output: { observed: "same schema" },
    });
  });
});

describe("A runner that goes away mid-call leaves Moira intact", () => {
  test("the node routes to error with an unavailability diagnostic and the execution continues", async () => {
    // Required state: losing the runner during a call is an ordinary node failure. Plausible wrong
    // state: the failure escapes as an exception out of the engine, so the execution record stops
    // wherever the call was and the workflow's own error route is never taken. Observing the graph
    // reaching its end node through the `error` connection separates the two.
    const dying = await startExtensionRunner({
      extensionsDir: BUNDLES_DIR,
      port: 0,
      host: "127.0.0.1",
      execArgv: ["--import", "tsx"],
    });
    const dyingClient = new HttpExtensionRunnerClient({
      baseUrl: `http://127.0.0.1:${dying.port}`,
    });

    const registry = new ExtensionRegistry();
    setActiveExtensionRegistry(registry);
    try {
      await syncExtensionRegistryFromRunner(dyingClient, { publish: false });
      expect(registry.has("probe.behave")).toBe(true);

      const engine = new GraphExecutionEngine(new InMemoryRepository(), {
        extensionRegistry: registry,
        extensionRunnerClient: dyingClient,
      });

      const graph = {
        metadata: { name: "Runner restart", version: "1.0.0", description: "test" },
        nodes: [
          { type: "start", id: "start", connections: { default: "call" } },
          {
            type: "probe.behave",
            id: "call",
            // Long enough that the call is still in flight when the runner is stopped.
            config: { behaviour: "hang" },
            timeout: 20_000,
            connections: { success: "end", error: "end" },
          },
          { type: "end", id: "end" },
        ],
      };

      const context = {
        variables: { before: "kept" },
        nodeStates: {},
        executionId: "exec-runner-restart",
        workflowId: "wf-runner-restart",
        userId: "user-1",
      };

      const queue = new AgentMessageQueue();
      const running = engine.executeGraph(
        graph as unknown as WorkflowGraph,
        context as ExecutionContext,
        queue,
        "start",
      );
      // Stop the service while the handler is occupied, which is what a restart looks like from
      // Moira's side.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await dying.close();

      const result = await running;

      expect(result.context.variables.call).toMatchObject({
        extensionFailed: true,
        failureKind: "runner-unavailable",
      });
      // The record is intact: what was there before the failed node is still there, and the graph
      // finished through its own error route rather than throwing out of the engine.
      expect(result.context.variables.before).toBe("kept");
      // Reached the end node through the workflow's own `error` route rather than throwing out of
      // the engine or pausing on the failed node.
      expect(result.action).toBe("complete");
      expect(result.visitedNodes).toContain("end");
    } finally {
      setActiveExtensionRegistry(null);
      await dying.close();
    }
  }, 30_000);
});
