import { describe, expect, jest, test } from "@jest/globals";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { GitHubCodespacesConnector } from "../../../packages/web-backend/src/services/github-codespaces-connector.js";

describe("GitHub Codespaces connector boundary", () => {
  test("passes the credential through stdin only, bounds argv, and removes operation HOME", async () => {
    const calls: Array<{
      executable: string;
      argv: readonly string[];
      env: NodeJS.ProcessEnv;
      stdin: string;
    }> = [];
    const spawnImpl = (
      executable: string,
      argv: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ): ChildProcessWithoutNullStreams => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const chunks: Buffer[] = [];
      stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stdin.on("finish", () => {
        calls.push({ executable, argv, env: options.env, stdin: Buffer.concat(chunks).toString() });
        stdout.end("Host cs\n  ProxyCommand gh codespace ssh --stdio\n");
        stderr.end();
        queueMicrotask(() => child.emit("close", 0));
      });
      Object.assign(child, { stdin, stdout, stderr, kill: jest.fn(() => true) });
      return child;
    };
    const connector = new GitHubCodespacesConnector(spawnImpl, "/usr/bin/gh", "/usr/bin/ssh");
    await connector.probeSshConfiguration("ghu_topsecret", "silver-space-123");

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].stdin)).toEqual({
      token: "ghu_topsecret",
      home: calls[0].env.HOME,
    });
    expect(JSON.stringify(calls.map(({ argv, env }) => ({ argv, env })))).not.toContain(
      "ghu_topsecret",
    );
    expect(Object.keys(calls[0].env).sort()).toEqual([
      "GCM_INTERACTIVE",
      "GH_CONFIG_DIR",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
    ]);
    expect(calls[0].executable).toBe("/usr/local/bin/tsx");
    expect(calls[0].argv).toEqual([
      "/app/packages/web-backend/src/services/github-codespaces-connector-worker.ts",
      "ssh-config",
      "silver-space-123",
    ]);
    expect(existsSync(calls[0].env.HOME!)).toBe(false);
  });

  test.each([
    ["oversized output", "oversized"],
    ["token-bearing output", "token"],
    ["nonzero worker exit", "exit"],
    ["worker spawn error", "spawn"],
    ["command timeout", "timeout"],
  ] as const)("fails generically and removes HOME after %s", async (_name, mode) => {
    let observedHome = "";
    const kill = jest.fn(() => true);
    const spawnImpl = (
      _executable: string,
      _argv: readonly string[],
      options: { env: NodeJS.ProcessEnv },
    ): ChildProcessWithoutNullStreams => {
      observedHome = options.env.HOME!;
      if (mode === "spawn") throw new Error("worker spawn failed");
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdin.on("finish", () => {
        if (mode === "timeout") return;
        if (mode === "oversized") stdout.end(Buffer.alloc(64 * 1024 + 1, "x"));
        else if (mode === "token") stdout.end("ProxyCommand ghu_topsecret");
        else stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", mode === "exit" ? 23 : 0));
      });
      Object.assign(child, { stdin, stdout, stderr, kill });
      return child;
    };
    const connector = new GitHubCodespacesConnector(
      spawnImpl,
      "/usr/bin/gh",
      "/usr/bin/ssh",
      "/usr/local/bin/tsx",
      "/app/packages/web-backend/src/services/github-codespaces-connector-worker.ts",
      1,
    );
    await expect(
      connector.probeSshConfiguration("ghu_topsecret", "silver-space-123"),
    ).rejects.toThrow(/Connector|Codespace/);
    expect(existsSync(observedHome)).toBe(false);
    if (mode === "oversized" || mode === "timeout") expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  test("reports incompatible tooling as unavailable without attempting a workspace", async () => {
    const spawnImpl = (
      executable: string,
      argv: readonly string[],
      _options: { env: NodeJS.ProcessEnv },
    ): ChildProcessWithoutNullStreams => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdin.on("finish", () => {
        if (executable.endsWith("gh")) stdout.end("gh version 2.96.0\n");
        else if (executable.endsWith("ssh")) stderr.end("OpenSSH_10.3p1\n");
        else stdout.end(argv.includes("health") ? "connector-worker-ok\n" : "");
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", 0));
      });
      Object.assign(child, { stdin, stdout, stderr, kill: jest.fn(() => true) });
      return child;
    };
    const connector = new GitHubCodespacesConnector(spawnImpl);
    await expect(connector.health()).resolves.toEqual({
      ok: false,
      reason: "GitHub CLI 2.97 is unavailable",
    });
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
            token: `ghu_${"secret".repeat(500)}`,
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
