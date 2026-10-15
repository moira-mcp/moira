/**
 * How the HTTP client turns transport reality into failure classes.
 *
 * The classes are what a workflow author reacts to: "the runner is not running" and "my extension
 * is broken" lead to different repairs, and once they are collapsed into one class nothing
 * downstream can separate them again. Two branches cannot be reached through a live service —
 * a service that accepts the connection and then never answers, and a service that answers with an
 * error status — so they are observed here through the client's own `fetchImpl` option.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { Agent, Dispatcher1Wrapper } from "undici";
import { fetchWork } from "@mcp-moira/shared/http/work-fetch";
import {
  EXTENSION_API_VERSION,
  HttpExtensionRunnerClient,
  ExtensionInvocationError,
} from "@mcp-moira/workflow-engine";

const request = {
  nodeType: "probe.behave",
  nodeId: "node-1",
  executionId: "exec-1",
  workflowId: "wf-1",
  config: {},
  timeoutMs: 50,
};

describe("Requests that carry no deadline of their own", () => {
  test("work survives the actual HTTP parser clocks for held headers and body, while caller cancellation still closes it", async () => {
    const timers = createRequire(import.meta.url)("undici/lib/util/timers.js") as {
      tick(delay: number): void;
    };
    let arrived!: () => void;
    let incoming = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let response!: ServerResponse;
    let withHeaders = false;
    const server = createServer((request, reply) => {
      request.resume();
      request.once("end", () => {
        response = reply;
        if (withHeaders) {
          reply.writeHead(200, { "content-type": "application/json" });
          reply.write('{"ok":');
        }
        arrived();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected test listener");
    const url = `http://127.0.0.1:${address.port}`;
    const defaults = new Dispatcher1Wrapper(new Agent());
    const abort = new AbortController();
    try {
      // The same installed parser clock must actually expire the unconfigured transport.
      const controlOptions: RequestInit & { dispatcher: Dispatcher1Wrapper } = {
        dispatcher: defaults,
      };
      const control = fetch(url, controlOptions);
      control.catch(() => undefined);
      await incoming;
      timers.tick(1);
      timers.tick(300_001);
      // Node fetch can wrap an error crossing the test VM boundary by its message.
      await expect(control).rejects.toMatchObject({
        cause: { message: expect.stringContaining("Headers Timeout Error") },
      });

      incoming = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const client = new HttpExtensionRunnerClient({ baseUrl: url });
      let delivered = false;
      const delivery = client
        .deliverCommunicationChannel({
          channelId: "probe.notifications",
          message: { text: "original text" },
          settings: {},
          secrets: {},
        })
        .then(() => {
          delivered = true;
        });
      await incoming;
      timers.tick(1);
      timers.tick(300_001);
      await setImmediate();
      expect(delivered).toBe(false);
      response.end('{"ok":true,"output":{}}');
      await delivery;

      withHeaders = true;
      incoming = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const controlBodyResponse = await fetch(url, controlOptions);
      let controlBodySettled = false;
      const controlBody = controlBodyResponse.json().finally(() => {
        controlBodySettled = true;
      });
      controlBody.catch(() => undefined);
      await incoming;
      await setImmediate();
      expect(controlBodySettled).toBe(false);
      timers.tick(1);
      timers.tick(300_001);
      // The body is live before advancing the parser clock and rejected only afterward.
      // Native fetch's stream error can cross the test VM without retaining its cause.
      await expect(controlBody).rejects.toMatchObject({ name: "TypeError" });

      incoming = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const bodyResponse = await fetchWork(url);
      let bodyDone = false;
      const body = bodyResponse.json().then((value) => {
        bodyDone = true;
        return value;
      });
      await incoming;
      timers.tick(1);
      timers.tick(300_001);
      await setImmediate();
      expect(bodyDone).toBe(false);
      response.end("true}");
      await expect(body).resolves.toEqual({ ok: true });

      withHeaders = false;
      incoming = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const cancelled = fetchWork(url, { signal: abort.signal });
      cancelled.catch(() => undefined);
      await incoming;
      abort.abort();
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      abort.abort();
      await defaults.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test("a silent runner fails the metadata lookup instead of waiting indefinitely", async () => {
    // Required state: asking the runner what it provides cannot hold up the caller. Plausible wrong
    // state: only `invoke` has a deadline, so a runner that accepts the connection and never answers
    // stalls whoever asked — at startup, the server process itself, for the transport's own default.
    const client = new HttpExtensionRunnerClient({
      baseUrl: "http://runner.invalid",
      metadataTimeoutMs: 50,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as typeof fetch,
    });

    // The deadline is the configured one, read on a fake clock: still waiting one millisecond
    // before it, failed at it. A real clock would also count the time a loaded machine takes to
    // run the test at all.
    jest.useFakeTimers();
    try {
      let settled = false;
      const lookup = client.listExtensions().finally(() => {
        settled = true;
      });
      lookup.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await expect(lookup).rejects.toMatchObject({ kind: "runner-unavailable" });
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([
    ["JSON error status", new Response('{"error":"bad gateway"}', { status: 502 })],
    [
      "incompatible protocol version",
      Response.json({ apiVersion: "moira.extensions/v99", extensions: [] }),
    ],
    [
      "legacy manifest version used as runner protocol",
      Response.json({ apiVersion: EXTENSION_API_VERSION, extensions: [] }),
    ],
  ])("%s cannot become an authoritative empty catalog", async (_case, response) => {
    const client = new HttpExtensionRunnerClient({
      baseUrl: "http://runner.invalid",
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });

    await expect(client.listExtensions()).rejects.toMatchObject({ kind: "runner-unavailable" });
  });
});

describe("Transport reality mapped to failure classes", () => {
  test("a service that accepts the call and never answers is a timeout, not an unavailable runner", async () => {
    // Required state: the wait is attributed to the call. Plausible wrong state: every transport
    // problem is reported as an unreachable runner, so a hanging extension reads as a stopped
    // service and the operator restarts the wrong thing.
    const client = new HttpExtensionRunnerClient({
      baseUrl: "http://runner.invalid",
      transportGraceMs: 50,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        })) as typeof fetch,
    });

    await expect(client.invoke(request)).rejects.toMatchObject({ kind: "timeout" });
  });

  test("an error status from the service is an unavailable runner, not a handler failure", async () => {
    const client = new HttpExtensionRunnerClient({
      baseUrl: "http://runner.invalid",
      fetchImpl: (async () =>
        new Response("upstream is unhappy", { status: 502 })) as unknown as typeof fetch,
    });

    const failure = await client.invoke(request).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtensionInvocationError);
    expect(failure).toMatchObject({ kind: "runner-unavailable" });
    expect((failure as Error).message).toContain("502");
  });

  test("a typed failure in a successful response keeps the class the service assigned", async () => {
    // The counterpart of the case above: HTTP 200 carrying `ok: false` is the extension failing,
    // and its class must survive the client untouched.
    const client = new HttpExtensionRunnerClient({
      baseUrl: "http://runner.invalid",
      fetchImpl: (async () =>
        Response.json({
          ok: false,
          kind: "invalid-output",
          message: "result does not match the declared outputSchema",
        })) as unknown as typeof fetch,
    });

    await expect(client.invoke(request)).rejects.toMatchObject({
      kind: "invalid-output",
      message: "result does not match the declared outputSchema",
    });
  });
});
