import { afterEach, describe, expect, test } from "@jest/globals";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const supervisorPath = resolve(
  process.cwd(),
  "packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs",
);
const directories: string[] = [];

function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "moira-direct-supervisor-"));
  directories.push(directory);
  const workspacesRoot = join(directory, "workspaces");
  const repository = join(workspacesRoot, "repository");
  const home = join(directory, "home");
  const stateRoot = join(directory, "state");
  mkdirSync(repository, { recursive: true });
  mkdirSync(home);
  for (const argv of [
    ["init", "--initial-branch=main", repository],
    ["-C", repository, "remote", "add", "origin", "https://github.com/owner/repository.git"],
  ]) {
    const result = spawnSync("git", argv, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return {
    environment: {
      ...process.env,
      HOME: home,
      MOIRA_WORKSPACES_ROOT: workspacesRoot,
      MOIRA_OPERATION_STATE_DIR: stateRoot,
    },
    stateRoot,
  };
}

function request(environment: NodeJS.ProcessEnv, value: Record<string, unknown>): Promise<unknown> {
  const supervisor = readFileSync(supervisorPath, "utf8");
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64");
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8")));
        return;
      }
      const envelope = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      const result = envelope.result as Record<string, unknown>;
      resolveResult(
        typeof result?.stdoutBase64 === "string" && typeof result?.stderrBase64 === "string"
          ? {
              ...result,
              stdout: Buffer.from(result.stdoutBase64, "base64").toString("utf8"),
              stderr: Buffer.from(result.stderrBase64, "base64").toString("utf8"),
              stdoutBase64: undefined,
              stderrBase64: undefined,
            }
          : result,
      );
    });
    child.stdin.end(`${supervisor}\nawait runEncoded("${encoded}");\n`);
  });
}

async function inspectUntilTerminal(
  environment: NodeJS.ProcessEnv,
  remoteMarker: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = (await request(environment, {
      action: "inspect",
      version: 1,
      remoteMarker,
    })) as Record<string, unknown>;
    if (result.state !== "running") return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("remote operation did not become terminal");
}

describe("direct Codespace operation supervisor", () => {
  test.each([
    [0, "succeeded"],
    [23, "failed"],
  ] as const)("preserves argv/stdin and reports exact exit %i", async (exitCode, state) => {
    const value = fixture();
    const remoteMarker = `moira-op-${exitCode === 0 ? "0" : "1".repeat(32)}`.padEnd(
      "moira-op-".length + 32,
      "0",
    );
    const script =
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(process.argv[1]+'|'+s);process.stderr.write('err');process.exit(Number(process.argv[2]));});";
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", script, "argument with spaces;$(false)", String(exitCode)],
        cwd: ".",
        stdin: Buffer.from("native stdin").toString("base64"),
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
      }),
    ).resolves.toEqual({ state: "running" });
    const terminal = {
      state,
      stdout: "argument with spaces;$(false)|native stdin",
      stderr: "err",
      exitCode,
    };
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toEqual(terminal);
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual(terminal);
    await expect(
      request(value.environment, { action: "finalize", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
  });

  test("reports cancellation only after the foreground process group is absent", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2".repeat(32)}`;
    const effectPath = join(value.stateRoot, "..", "foreground-effect");
    await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [
        process.execPath,
        "-e",
        "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10)",
        effectPath,
      ],
      cwd: ".",
      stdin: "",
      timeoutMs: 30_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    });
    for (let attempt = 0; attempt < 40 && !existsSync(effectPath); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    expect(existsSync(effectPath)).toBe(true);
    const identity = JSON.parse(
      readFileSync(join(value.stateRoot, remoteMarker, "pid"), "utf8"),
    ) as { pid: number; startTime: string | null };
    expect(identity.pid).toBeGreaterThan(1);
    expect(identity.startTime).toEqual(
      process.platform === "linux" ? expect.stringMatching(/^[0-9]+$/) : null,
    );
    let result = (await request(value.environment, {
      action: "cancel",
      version: 1,
      remoteMarker,
    })) as Record<string, unknown>;
    if (result.state === "running") {
      result = await inspectUntilTerminal(value.environment, remoteMarker);
    }
    expect(result.state).toBe("cancelled");
    const bytesAfterCancel = readFileSync(effectPath).length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(readFileSync(effectPath).length).toBe(bytesAfterCancel);
  });

  test("waits for the exact live runner to publish a terminal result after child exit", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"5".repeat(32)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    const runnerStartTime = processStartTime(process.pid);
    writeFileSync(
      join(operationDirectory, "pid"),
      JSON.stringify({ pid: 2_147_483_647, startTime: process.platform === "linux" ? "1" : null }),
    );
    writeFileSync(
      join(operationDirectory, "runner-pid"),
      JSON.stringify({ pid: process.pid, startTime: runnerStartTime }),
    );

    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "running" });

    rmSync(join(operationDirectory, "runner-pid"));
    await expect(
      request(value.environment, { action: "inspect", version: 1, remoteMarker }),
    ).resolves.toEqual({
      state: "failed",
      stdout: "",
      stderr: "operation supervisor exited without a result",
      exitCode: null,
    });
  });

  test.each([
    ["output", "setInterval(()=>process.stdout.write('x'.repeat(1024)),0)", 5_000, 64, "failed"],
    ["timeout", "setInterval(()=>{},1000)", 50, 4096, "timed_out"],
  ] as const)(
    "enforces the %s bound on the remote foreground group",
    async (_name, script, timeoutMs, outputLimitBytes, expectedState) => {
      const value = fixture();
      const remoteMarker = `moira-op-${expectedState === "failed" ? "3" : "4".repeat(32)}`.padEnd(
        "moira-op-".length + 32,
        expectedState === "failed" ? "3" : "4",
      );
      await request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", script],
        cwd: ".",
        stdin: "",
        timeoutMs,
        maxStdoutBytes: outputLimitBytes,
        maxStderrBytes: 4096,
      });
      const result = await inspectUntilTerminal(value.environment, remoteMarker);
      expect(result.state).toBe(expectedState);
    },
  );
});
