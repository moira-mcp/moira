/**
 * How the HTTP client turns transport reality into failure classes.
 *
 * The classes are what a workflow author reacts to: "the runner is not running" and "my extension
 * is broken" lead to different repairs, and once they are collapsed into one class nothing
 * downstream can separate them again. Two branches cannot be reached through a live service —
 * a service that accepts the connection and then never answers, and a service that answers with an
 * error status — so they are observed here through the client's own `fetchImpl` option.
 */

import { describe, test, expect } from "@jest/globals";
import { HttpExtensionRunnerClient, ExtensionInvocationError } from "@mcp-moira/workflow-engine";

const request = {
  nodeType: "probe.behave",
  nodeId: "node-1",
  executionId: "exec-1",
  workflowId: "wf-1",
  config: {},
  timeoutMs: 50,
};

describe("Requests that carry no deadline of their own", () => {
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

    const started = Date.now();
    await expect(client.listExtensions()).rejects.toMatchObject({ kind: "runner-unavailable" });
    expect(Date.now() - started).toBeLessThan(2_000);
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
