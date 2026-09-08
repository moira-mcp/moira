import { describe, expect, jest, test } from "@jest/globals";
import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { GitHubCodespacesConnector } from "../../../packages/web-backend/src/services/github-codespaces-connector.js";
import {
  CONNECTOR_MAX_REQUEST_BYTES,
  CONNECTOR_MAX_RESPONSE_BYTES,
  encodeConnectorRequest,
  encodeConnectorResponse,
} from "../../../packages/web-backend/src/services/github-codespaces-connector-protocol.mjs";
import type { WorkspaceOperationRecord, WorkspaceResourceRecord } from "@mcp-moira/shared";

function requestHarness(responder: (body: unknown, options: RequestOptions) => unknown) {
  const calls: Array<{ options: RequestOptions; body: string }> = [];
  const requestImpl = (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter() as ClientRequest;
    Object.assign(request, {
      setTimeout: jest.fn(),
      destroy: (error?: Error) => queueMicrotask(() => request.emit("error", error)),
      end: (payload?: Buffer) => {
        const body = payload?.toString("utf8") ?? "";
        calls.push({ options, body });
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 200;
        callback(response);
        const value = Buffer.from(
          JSON.stringify(responder(body ? JSON.parse(body) : null, options)),
        );
        queueMicrotask(() => {
          response.emit("data", value);
          response.emit("end");
        });
      },
    });
    return request;
  };
  return { calls, requestImpl };
}

const workspace = {
  id: "workspace-1",
  userId: "user-1",
  provider: "github-codespaces",
  providerResourceName: "silver-space-123",
  repositoryFullName: "owner/repository",
} as WorkspaceResourceRecord;
const operation = {
  id: "operation-1",
  userId: "user-1",
  resourceId: "workspace-1",
  remoteMarker: "moira-op-0123456789abcdef0123456789abcdef",
  stdoutLimitBytes: 4096,
  stderrLimitBytes: 4096,
} as WorkspaceOperationRecord;

describe("GitHub Codespaces connector boundary", () => {
  test("passes credentials only in the Unix-socket request body", async () => {
    const harness = requestHarness(() => ({
      value: "Host silver-space-123\n  ProxyCommand gh codespace ssh --stdio\n",
    }));
    const connector = new GitHubCodespacesConnector(
      harness.requestImpl,
      "/run/test/connector.sock",
    );
    await connector.probeSshConfiguration("ghu_topsecret", "silver-space-123");

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].options).toMatchObject({
      socketPath: "/run/test/connector.sock",
      path: "/job",
      method: "POST",
    });
    expect(JSON.parse(harness.calls[0].body)).toEqual({
      action: "ssh-config",
      token: "ghu_topsecret",
      resourceName: "silver-space-123",
    });
    expect(JSON.stringify(harness.calls[0].options)).not.toContain("ghu_topsecret");
  });

  test("reports sidecar health without contacting a workspace", async () => {
    const harness = requestHarness(() => ({ state: "available", reason: null }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(connector.health()).resolves.toEqual({ ok: true, reason: null });
    expect(harness.calls[0].options).toMatchObject({ path: "/health", method: "GET" });
  });

  test("preserves argv boundaries, stdin bytes and exact nonzero results", async () => {
    const harness = requestHarness(() => ({
      value: JSON.stringify({
        state: "failed",
        stdoutBase64: Buffer.from("partial").toString("base64"),
        stderrBase64: Buffer.from("expected").toString("base64"),
        exitCode: 23,
      }),
    }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(
      connector.execute("ghu_topsecret", workspace, operation, {
        argv: ["printf", "%s", "a value;$(false)"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new TextEncoder().encode("input") },
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      }),
    ).resolves.toEqual({
      state: "failed",
      stdout: "partial",
      stderr: "expected",
      exitCode: 23,
    });
    const body = JSON.parse(harness.calls[0].body);
    expect(body.job.argv).toEqual(["printf", "%s", "a value;$(false)"]);
    expect(Buffer.from(body.job.stdin, "base64").toString("utf8")).toBe("input");
    expect(JSON.stringify(harness.calls[0].options)).not.toContain("ghu_topsecret");
  });

  test("carries contract-max stdin and independent output streams inside wire envelopes", async () => {
    const harness = requestHarness(() => ({ value: JSON.stringify({ state: "running" }) }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await connector.execute("ghu_topsecret", workspace, operation, {
      argv: ["true"],
      cwd: ".",
      stdin: { kind: "inline", bytes: Buffer.alloc(4 * 1024 * 1024, "a") },
      timeoutMs: 5_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 8 * 1024 * 1024,
    });
    expect(Buffer.byteLength(harness.calls[0].body)).toBeLessThanOrEqual(
      CONNECTOR_MAX_REQUEST_BYTES,
    );
    expect(Buffer.byteLength(harness.calls[0].body)).toBeGreaterThan(4 * 1024 * 1024);

    const remoteWireResult = encodeConnectorResponse({
      state: "failed",
      stdoutBase64: Buffer.alloc(8 * 1024 * 1024).toString("base64"),
      stderrBase64: Buffer.alloc(8 * 1024 * 1024).toString("base64"),
      exitCode: 23,
    });
    const maximumWireResult = encodeConnectorResponse({
      value: remoteWireResult.toString("utf8"),
    });
    expect(maximumWireResult.length).toBeLessThanOrEqual(CONNECTOR_MAX_RESPONSE_BYTES);
    expect(() =>
      encodeConnectorRequest({ padding: "x".repeat(CONNECTOR_MAX_REQUEST_BYTES) }),
    ).toThrow(/exceeded its bound/);
  });

  test("sends an explicit remote finalize operation", async () => {
    const harness = requestHarness(() => ({ value: JSON.stringify({ state: "absent" }) }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(
      connector.finalize("ghu_topsecret", workspace, operation),
    ).resolves.toBeUndefined();
    expect(JSON.parse(harness.calls[0].body).job).toMatchObject({
      action: "finalize",
      remoteMarker: operation.remoteMarker,
    });
  });

  test("fails closed when the sidecar returns token-bearing output", async () => {
    const harness = requestHarness(() => ({ value: "ProxyCommand ghu_topsecret" }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(
      connector.probeSshConfiguration("ghu_topsecret", "silver-space-123"),
    ).rejects.toThrow(/Codespace/);
  });

  test("rejects a malformed remote terminal envelope", async () => {
    const harness = requestHarness(() => ({
      value: JSON.stringify({
        state: "succeeded",
        stdoutBase64: "not-base64",
        stderrBase64: "",
        exitCode: 0,
      }),
    }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(
      connector.execute("ghu_topsecret", workspace, operation, {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      }),
    ).rejects.toThrow(/result contract/);
  });

  test("the reviewed worker rejects oversized stdin without echoing credential bytes", async () => {
    const workerPath = resolve(
      process.cwd(),
      "packages/web-backend/src/services/github-codespaces-connector-worker.ts",
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawnProcess(
          process.execPath,
          ["--import", "tsx", workerPath, "ssh-config", "silver-space-123"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.once("error", reject);
        child.once("close", (code) =>
          resolveResult({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
        child.stdin.end(
          JSON.stringify({
            token: `ghu_${"secret".repeat(700_000)}`,
            home: "/tmp/moira-codespaces-connector-oversized",
          }),
        );
      },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Codespaces connector worker failed");
    expect(result.stderr).not.toContain("ghu_secret");
  });
});
