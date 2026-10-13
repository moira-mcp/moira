import { describe, expect, test } from "@jest/globals";
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
  validateCodespaceSshConfig,
} from "../../../packages/web-backend/src/services/github-codespaces-connector-protocol.mjs";

function requestHarness(responder: (body: unknown, options: RequestOptions) => unknown) {
  const calls: Array<{ options: RequestOptions; body: string; timeoutMs: number | null }> = [];
  const requestImpl = (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter() as ClientRequest;
    let timeoutMs: number | null = null;
    Object.assign(request, {
      setTimeout: (milliseconds: number) => {
        timeoutMs = milliseconds;
      },
      destroy: (error?: Error) => queueMicrotask(() => request.emit("error", error)),
      end: (payload?: Buffer) => {
        const body = payload?.toString("utf8") ?? "";
        calls.push({ options, body, timeoutMs });
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
      path: "/bootstrap",
      method: "POST",
    });
    expect(JSON.parse(harness.calls[0].body)).toEqual({
      action: "ssh-config",
      token: "ghu_topsecret",
      resourceName: "silver-space-123",
    });
    expect(JSON.stringify(harness.calls[0].options)).not.toContain("ghu_topsecret");
  });

  test("reports sidecar health without contacting a codespace", async () => {
    const harness = requestHarness(() => ({ state: "available", reason: null }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(connector.health()).resolves.toEqual({ ok: true, reason: null });
    expect(harness.calls[0].options).toMatchObject({ path: "/health", method: "GET" });
  });

  test("fails closed when the sidecar returns token-bearing output", async () => {
    const harness = requestHarness(() => ({ value: "ProxyCommand ghu_topsecret" }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    await expect(
      connector.probeSshConfiguration("ghu_topsecret", "silver-space-123"),
    ).rejects.toThrow(/Codespace/);
  });

  test("fixed bootstrap carries measured guest identity and resource credential only inside its private body", async () => {
    const life = "e".repeat(64),
      release = "a".repeat(64);
    const rootBase64 = Buffer.from("/workspaces/repository").toString("base64");
    const configuration = {
      version: 1,
      repositoryFullName: "owner/repository",
      root: "/workspaces/repository",
      remote: { environmentIdentity: life, credential: "s".repeat(43) },
    };
    const harness = requestHarness((body) => ({
      value: JSON.stringify(
        (body as { action: string }).action === "probe"
          ? { environmentIdentity: life, architecture: "x86_64", rootBase64 }
          : {
              version: 1,
              repositoryFullName: "owner/repository",
              environmentIdentity: life,
              releaseIdentity: release,
            },
      ),
    }));
    const connector = new GitHubCodespacesConnector(harness.requestImpl);
    expect(await connector.probeWorkspace("ghu_topsecret", "silver-space-123")).toEqual({
      environmentIdentity: life,
      architecture: "x86_64",
      rootBase64,
    });
    expect(
      await connector.bootstrapWorkspace("ghu_topsecret", "silver-space-123", configuration),
    ).toMatchObject({ environmentIdentity: life, releaseIdentity: release });
    expect(JSON.parse(harness.calls[1].body)).toEqual({
      action: "install",
      token: "ghu_topsecret",
      resourceName: "silver-space-123",
      configuration,
    });
    expect(JSON.stringify(harness.calls.map((call) => call.options))).not.toContain(
      "ghu_topsecret",
    );
    expect(JSON.stringify(harness.calls.map((call) => call.options))).not.toContain("s".repeat(43));
    expect(connector).not.toHaveProperty("execute");
    expect(connector).not.toHaveProperty("executeFile");
  });

  test.each(["invalid-life", "unsupported-architecture", "token-output"])(
    "probe refuses %s before fixed installation",
    async (reason) => {
      const observation = {
        environmentIdentity: reason === "invalid-life" ? "bad" : "e".repeat(64),
        architecture: reason === "unsupported-architecture" ? "mips" : "aarch64",
        rootBase64: Buffer.from("/workspaces/repository").toString("base64"),
        ...(reason === "token-output" ? { token: "ghu_topsecret" } : {}),
      };
      const connector = new GitHubCodespacesConnector(
        requestHarness(() => ({ value: JSON.stringify(observation) })).requestImpl,
      );
      await expect(connector.probeWorkspace("ghu_topsecret", "silver-space-123")).rejects.toThrow(
        "Invalid workspace",
      );
    },
  );

  test("bootstrap metadata codecs cannot buffer ordinary file or output payloads", () => {
    expect(() =>
      encodeConnectorRequest({ padding: "x".repeat(CONNECTOR_MAX_REQUEST_BYTES) }),
    ).toThrow(/exceeded/);
    expect(() =>
      encodeConnectorResponse({ padding: "x".repeat(CONNECTOR_MAX_RESPONSE_BYTES) }),
    ).toThrow(/exceeded/);
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
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") reject(error);
        });
        child.once("close", (code) =>
          resolveResult({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
        child.stdin.end(
          JSON.stringify({
            token: `ghu_${"secret".repeat(Math.ceil(CONNECTOR_MAX_REQUEST_BYTES / 6) + 1)}`,
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

  describe("generated SSH configuration validation", () => {
    const home = "/tmp/moira-codespaces-connector-abc123";
    const key = `${home}/.ssh/codespaces.auto`;
    const generated = [
      "Host cs.silver-space-123.main",
      "\tUser codespace",
      `\tProxyCommand /usr/bin/gh cs ssh -c silver-space-123 --stdio -- -i ${key}`,
      "\tUserKnownHostsFile=/dev/null",
      "\tStrictHostKeyChecking no",
      "\tLogLevel quiet",
      "\tControlMaster auto",
      `\tIdentityFile ${key}`,
      "",
    ].join("\n");

    test("accepts exactly what gh codespace ssh --config generates for the Codespace", () => {
      expect(
        validateCodespaceSshConfig(generated, { home, resourceName: "silver-space-123" }),
      ).toBe(true);
    });

    test.each([
      ["another Codespace", generated.replaceAll("silver-space-123", "other-space-9")],
      [
        "a foreign identity file",
        generated.replace(`IdentityFile ${key}`, "IdentityFile /root/.ssh/id_ed25519"),
      ],
      [
        "a foreign key in the proxy command",
        generated.replace(`-- -i ${key}`, "-- -i /etc/passwd"),
      ],
      ["a local command hook", `${generated}\tLocalCommand touch /tmp/pwned\n`],
      ["a remote command override", `${generated}\tRemoteCommand rm -rf ~\n`],
      ["an include directive", `${generated}\tInclude /etc/ssh/ssh_config\n`],
      ["a second host block", `${generated}Host evil\n\tProxyCommand nc attacker 22\n`],
      ["a missing proxy command", generated.replace(/\tProxyCommand[^\n]*\n/, "")],
    ])("rejects %s", (_label, config) => {
      expect(validateCodespaceSshConfig(config, { home, resourceName: "silver-space-123" })).toBe(
        false,
      );
    });
  });
});
