import { afterEach, describe, expect, test } from "@jest/globals";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const supervisorPath = resolve(
  process.cwd(),
  "packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs",
);
const directories: string[] = [];

function parentIdentity(path: string) {
  const value = statSync(path, { bigint: true });
  return { parentDev: value.dev.toString(), parentIno: value.ino.toString() };
}

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
    repository,
  };
}

/**
 * Make what is stored look as if an earlier life of the environment wrote it.
 *
 * The environment's identity comes from the running Linux kernel wherever those sources exist, so a
 * test cannot move the environment to another life by setting a variable — on Linux the variable is
 * deliberately powerless. What a test can do is state the other half of the comparison: that the
 * stored file was written by a life that is not this one, which is exactly the situation the
 * behaviour is about, and it reads the same on every platform.
 */
function storeForeignLife(path: string): void {
  const foreign = "0".repeat(64);
  const raw = readFileSync(path, "utf8");
  if (!raw.trimStart().startsWith("{")) {
    writeFileSync(path, foreign, { mode: 0o600 });
    return;
  }
  const stored = JSON.parse(raw) as Record<string, unknown>;
  stored.environment = foreign;
  writeFileSync(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

function request(
  environment: NodeJS.ProcessEnv,
  value: Record<string, unknown>,
  transformSource?: (source: string) => string,
): Promise<unknown> {
  const source = readFileSync(supervisorPath, "utf8");
  const supervisor = transformSource ? transformSource(source) : source;
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
  test("performs bounded stat, search, ranges and atomic binary writes without shell paths", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "source.txt"), "alpha\nbeta needle\ngamma\n");
    const statMarker = `moira-op-${"6".repeat(32)}`;
    const statResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: statMarker,
      repositoryFullName: "owner/repository",
      request: { action: "stat", path: "source.txt" },
    })) as { state: string; value: { stat: { version: { sha256: string } } } };
    expect(statResult.state).toBe("succeeded");
    expect(statResult.value.stat.version.sha256).toMatch(/^[a-f0-9]{64}$/);

    const readResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "read", path: "source.txt", offset: 6, length: 4 },
    })) as { value: { bytesBase64: string; offset: number; totalSize: number } };
    expect(Buffer.from(readResult.value.bytesBase64, "base64").toString()).toBe("beta");
    expect(readResult.value).toMatchObject({ offset: 6, totalSize: 24 });

    mkdirSync(join(value.repository, "sub"));
    writeFileSync(join(value.repository, "sub", "match.txt"), "needle\n");
    const searchResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"8".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string; line: number }> } };
    expect(searchResult.value.matches).toEqual([
      { path: "sub/match.txt", line: 1, column: 1, preview: "needle" },
    ]);
    const regexSearch = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"ac".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "nee[a-z]+",
        mode: "regex",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string; line: number }>; truncated: boolean } };
    expect(regexSearch.value).toEqual({
      action: "search",
      matches: [{ path: "sub/match.txt", line: 1, column: 1, preview: "needle" }],
      truncated: false,
    });
    const truncatedBound = Buffer.byteLength(
      JSON.stringify({ action: "search", matches: [], truncated: false }),
    );
    const truncatedSearch = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"ab".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: "sub",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: truncatedBound,
      },
    })) as { value: { action: string; matches: unknown[]; truncated: boolean } };
    expect(truncatedSearch.value).toEqual({ action: "search", matches: [], truncated: true });
    expect(Buffer.byteLength(JSON.stringify(truncatedSearch.value))).toBeLessThanOrEqual(
      truncatedBound,
    );
    const equivalent = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"9".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: { action: "stat", path: "sub\\match.txt" },
    })) as { value: { stat: { path: string } } };
    expect(equivalent.value.stat.path).toBe("sub/match.txt");

    const binary = Buffer.from([0, 255, 1, 2, 3]);
    const writeResult = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"a".repeat(32)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "binary.dat",
        bytesBase64: binary.toString("base64"),
        expected: { exists: false },
      },
    })) as { value: { current: { sha256: string } } };
    expect(readFileSync(join(value.repository, "binary.dat"))).toEqual(binary);
    expect(writeResult.value.current.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("searches repository content without descending into version-control internals", async () => {
    const value = fixture();
    // The fixture repository is a real one, so .git already holds refs, config and logs.
    writeFileSync(join(value.repository, ".git", "description"), "needle in the git directory\n");
    writeFileSync(join(value.repository, ".gitignore"), "needle in an ordinary dot-file\n");

    const onlyInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7a".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "needle in the git directory",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: unknown[]; truncated: boolean } };
    // No match, and skipping a directory is not a truncated result.
    expect(onlyInsideGit.value).toEqual({ action: "search", matches: [], truncated: false });

    writeFileSync(join(value.repository, "notes.txt"), "shared needle\n");
    writeFileSync(join(value.repository, ".git", "shared.txt"), "shared needle\n");
    const insideAndOutside = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7b".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "shared needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string }> } };
    expect(insideAndOutside.value.matches).toEqual([
      { path: "notes.txt", line: 1, column: 1, preview: "shared needle" },
    ]);

    const ordinaryDotFile = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7c".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".",
        query: "ordinary dot-file",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { value: { matches: Array<{ path: string }> } };
    expect(ordinaryDotFile.value.matches).toEqual([
      { path: ".gitignore", line: 1, column: 14, preview: "needle in an ordinary dot-file" },
    ]);

    const rootedAtGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7d".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".git",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { state: string };
    expect(rootedAtGit.state).toBe("failed");

    // The directory must exist, or the refusal would be indistinguishable from a missing path.
    mkdirSync(join(value.repository, ".git", "logs"), { recursive: true });
    writeFileSync(join(value.repository, ".git", "logs", "HEAD"), "needle in a reflog\n");
    const rootedInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7f".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "search",
        path: ".git/logs",
        query: "needle",
        mode: "literal",
        maxMatches: 10,
        maxBytes: 4096,
      },
    })) as { state: string };
    expect(rootedInsideGit.state).toBe("failed");

    // A file inside the git directory is still readable when the caller names it exactly.
    const readInsideGit = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"7e".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: { action: "read", path: ".git/description", offset: 0, length: 64 },
    })) as { state: string; value: { bytesBase64: string } };
    expect(readInsideGit.state).toBe("succeeded");
    expect(Buffer.from(readInsideGit.value.bytesBase64, "base64").toString()).toContain("needle");
  });

  test("terminates catastrophic regex matching at the search deadline", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "regex"));
    writeFileSync(join(value.repository, "regex", "adversarial.txt"), `${"a".repeat(10_000)}!`);
    const startedAt = Date.now();
    const result = await request(
      value.environment,
      {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"aa".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "search",
          path: "regex",
          query: "(a+)+$",
          mode: "regex",
          maxMatches: 10,
          maxBytes: 64 * 1024,
        },
      },
      (source) =>
        source.replace("const SEARCH_DEADLINE_MS = 5_000;", "const SEARCH_DEADLINE_MS = 100;"),
    );
    expect(result).toEqual({
      state: "succeeded",
      value: { action: "search", matches: [], truncated: true },
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  test("rejects traversal, symlink, hard-link, special-file and stale write targets", async () => {
    const value = fixture();
    const outside = join(value.repository, "..", "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(value.repository, "linked.txt"));
    writeFileSync(join(value.repository, "original.txt"), "original");
    linkSync(join(value.repository, "original.txt"), join(value.repository, "hard.txt"));
    const fifo = join(value.repository, "special");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    for (const [suffix, path] of [
      ["b", "../outside.txt"],
      ["c", "linked.txt"],
      ["d", "hard.txt"],
      ["e", "special"],
    ]) {
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${suffix.repeat(32)}`,
          repositoryFullName: "owner/repository",
          request: { action: "read", path, offset: 0, length: 64 },
        }),
      ).resolves.toMatchObject({
        state: "failed",
        value: { action: "read", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
      });
    }
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"f".repeat(32)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "write",
          path: "original.txt",
          bytesBase64: Buffer.from("changed").toString("base64"),
          expected: { exists: true, sha256: "0".repeat(64) },
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
    });
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readFileSync(join(value.repository, "original.txt"), "utf8")).toBe("original");
  });

  test("fails closed when a target or parent is substituted after staging", async () => {
    const value = fixture();
    const injectSubstitution = (source: string) =>
      source.replace(
        'await writeDurableJson(directory, "file-transaction.json", entries);',
        `await writeDurableJson(directory, "file-transaction.json", entries);
if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "target") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rm(join(staged[0].root.path, "race.txt"));
  await injectedFs.writeFile(join(staged[0].root.path, "race.txt"), "original");
} else if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "parent") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rename(join(staged[0].root.path, "sub"), join(staged[0].root.path, "sub-moved"));
  await injectedFs.symlink(process.env.MOIRA_TEST_OUTSIDE_DIR, join(staged[0].root.path, "sub"));
} else if (process.env.MOIRA_TEST_FILE_SUBSTITUTION === "absent-parent") {
  const injectedFs = await import("node:fs/promises");
  await injectedFs.rename(join(staged[0].root.path, "empty"), join(staged[0].root.path, "empty-moved"));
  await injectedFs.mkdir(join(staged[0].root.path, "empty"));
}`,
      );

    writeFileSync(join(value.repository, "race.txt"), "original");
    await expect(
      request(
        { ...value.environment, MOIRA_TEST_FILE_SUBSTITUTION: "target" },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3a".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "race.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: true },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(value.repository, "race.txt"), "utf8")).toBe("original");

    const outside = join(value.repository, "..", "outside-directory");
    mkdirSync(join(value.repository, "sub"));
    mkdirSync(outside);
    writeFileSync(join(value.repository, "sub", "inside.txt"), "inside");
    writeFileSync(join(outside, "inside.txt"), "outside");
    await expect(
      request(
        {
          ...value.environment,
          MOIRA_TEST_FILE_SUBSTITUTION: "parent",
          MOIRA_TEST_OUTSIDE_DIR: outside,
        },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3b".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "sub/inside.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: true },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(outside, "inside.txt"), "utf8")).toBe("outside");
    expect(readFileSync(join(value.repository, "sub-moved", "inside.txt"), "utf8")).toBe("inside");

    mkdirSync(join(value.repository, "empty"));
    await expect(
      request(
        { ...value.environment, MOIRA_TEST_FILE_SUBSTITUTION: "absent-parent" },
        {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${"3f".repeat(16)}`,
          repositoryFullName: "owner/repository",
          request: {
            action: "write",
            path: "empty/new.txt",
            bytesBase64: Buffer.from("desired").toString("base64"),
            expected: { exists: false },
          },
        },
        injectSubstitution,
      ),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "write", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
    });
    expect(existsSync(join(value.repository, "empty", "new.txt"))).toBe(false);
    expect(existsSync(join(value.repository, "empty-moved", "new.txt"))).toBe(false);
    if (process.platform === "linux") {
      expect(readdirSync(join(value.repository, "empty-moved"))).toEqual([]);
    }
  });

  test("gives one runner atomic ownership of an overlapping exact-marker mutation", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3c".repeat(16)}`;
    const operation = {
      action: "file-execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "exact-marker.txt",
        bytesBase64: Buffer.from("once").toString("base64"),
        expected: { exists: false },
      },
    };
    const delayOwner = (source: string) =>
      source.replace(
        'if (ownership === "retry") continue;',
        `if (ownership === "retry") continue;
if (process.env.MOIRA_TEST_HOLD_FILE_RUNNER === "1") {
  await new Promise((resolveHold) => setTimeout(resolveHold, 250));
}`,
      );
    const first = request(
      { ...value.environment, MOIRA_TEST_HOLD_FILE_RUNNER: "1" },
      operation,
      delayOwner,
    );
    const runnerPath = join(value.stateRoot, remoteMarker, "file-runner-pid");
    for (let attempt = 0; attempt < 100 && !existsSync(runnerPath); attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(existsSync(runnerPath)).toBe(true);
    await expect(request(value.environment, operation)).resolves.toEqual({ state: "running" });
    await expect(first).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "exact-marker.txt" },
    });
    await expect(
      request(value.environment, { action: "file-inspect", version: 1, remoteMarker }),
    ).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "exact-marker.txt" },
    });
    expect(readFileSync(join(value.repository, "exact-marker.txt"), "utf8")).toBe("once");
  });

  test("publishes a complete ownership candidate before the canonical marker", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3e".repeat(16)}`;
    const operation = {
      action: "file-execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      request: {
        action: "write",
        path: "candidate-race.txt",
        bytesBase64: Buffer.from("winner").toString("base64"),
        expected: { exists: false },
      },
    };
    const delayPublication = (source: string) =>
      source.replace(
        "await link(candidate, target);",
        `if (process.env.MOIRA_TEST_HOLD_FILE_CANDIDATE === "1") {
  await new Promise((resolveHold) => setTimeout(resolveHold, 1000));
}
      await link(candidate, target);`,
      );
    const first = request(
      { ...value.environment, MOIRA_TEST_HOLD_FILE_CANDIDATE: "1" },
      operation,
      delayPublication,
    );
    const operationDirectory = join(value.stateRoot, remoteMarker);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        existsSync(operationDirectory) &&
        readdirSync(operationDirectory).some((name) => name.startsWith(".file-runner-candidate-"))
      ) {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    expect(readdirSync(operationDirectory)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.file-runner-candidate-/)]),
    );
    await expect(request(value.environment, operation)).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "candidate-race.txt" },
    });
    await expect(first).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "candidate-race.txt" },
    });
    expect(readFileSync(join(value.repository, "candidate-race.txt"), "utf8")).toBe("winner");
  });

  test("atomically displaces a dead exact-marker owner before recovery", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"3d".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    writeFileSync(
      join(operationDirectory, "file-runner-pid"),
      JSON.stringify({ pid: 2_147_483_647, startTime: null }),
    );
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: {
          action: "write",
          path: "recovered-owner.txt",
          bytesBase64: Buffer.from("recovered").toString("base64"),
          expected: { exists: false },
        },
      }),
    ).resolves.toMatchObject({
      state: "succeeded",
      value: { action: "write", path: "recovered-owner.txt" },
    });
    expect(readFileSync(join(value.repository, "recovered-owner.txt"), "utf8")).toBe("recovered");
    expect(existsSync(join(operationDirectory, "file-runner-pid"))).toBe(true);
  });

  test("preflights every structured patch target before committing any file", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "one.txt"), "one");
    writeFileSync(join(value.repository, "two.txt"), "two");
    await expect(
      request(value.environment, {
        action: "file-execute",
        version: 1,
        remoteMarker: `moira-op-${"1a".repeat(16)}`,
        repositoryFullName: "owner/repository",
        request: {
          action: "apply_patch",
          summaryMaxBytes: 4096,
          files: [
            {
              path: "one.txt",
              expected: { exists: true },
              edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("ONE").toString("base64") }],
            },
            {
              path: "two.txt",
              expected: { exists: true, sha256: "0".repeat(64) },
              edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("TWO").toString("base64") }],
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      state: "failed",
      value: { action: "apply_patch", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
    });
    expect(readFileSync(join(value.repository, "one.txt"), "utf8")).toBe("one");
    expect(readFileSync(join(value.repository, "two.txt"), "utf8")).toBe("two");
    expect(readdirSync(value.repository).filter((name) => name.startsWith(".moira-"))).toEqual([]);
  });

  test.each([
    ["missing", undefined],
    ["below minimum", 255],
    ["above hard ceiling", 65_537],
  ] as const)(
    "rejects a %s patch-summary budget without target mutation",
    async (_name, budget) => {
      const value = fixture();
      writeFileSync(join(value.repository, "bounded.txt"), "original");
      const requestValue = {
        action: "apply_patch",
        ...(budget === undefined ? {} : { summaryMaxBytes: budget }),
        files: [
          {
            path: "bounded.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 8, bytesBase64: Buffer.from("changed").toString("base64") }],
          },
        ],
      };
      await expect(
        request(value.environment, {
          action: "file-execute",
          version: 1,
          remoteMarker: `moira-op-${String(budget ?? 0).padStart(32, "0")}`,
          repositoryFullName: "owner/repository",
          request: requestValue,
        }),
      ).resolves.toMatchObject({
        state: "failed",
        value: { action: "apply_patch", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
      });
      expect(readFileSync(join(value.repository, "bounded.txt"), "utf8")).toBe("original");
      expect(readdirSync(value.repository).filter((entry) => entry.startsWith(".moira-"))).toEqual(
        [],
      );
    },
  );

  test("commits a structured multi-file patch as one preconditioned result", async () => {
    const value = fixture();
    writeFileSync(join(value.repository, "one.txt"), "one");
    writeFileSync(join(value.repository, "two.txt"), "two");
    const result = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"1b".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: {
        action: "apply_patch",
        summaryMaxBytes: 4096,
        files: [
          {
            path: "one.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("ONE").toString("base64") }],
          },
          {
            path: "two.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 3, bytesBase64: Buffer.from("TWO").toString("base64") }],
          },
        ],
      },
    })) as {
      value: {
        files: Array<{ path: string; current: { sha256: string } }>;
        summary: Record<string, unknown>;
      };
    };
    expect(readFileSync(join(value.repository, "one.txt"), "utf8")).toBe("ONE");
    expect(readFileSync(join(value.repository, "two.txt"), "utf8")).toBe("TWO");
    expect(result.value.files).toEqual([
      {
        path: "one.txt",
        previous: expect.any(Object),
        current: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      },
      {
        path: "two.txt",
        previous: expect.any(Object),
        current: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      },
    ]);
    expect(result.value.summary).toEqual({
      filesChanged: 2,
      editsApplied: 2,
      insertedBytes: 6,
      deletedBytes: 6,
      entries: [
        { path: "one.txt", edits: 1, insertedBytes: 3, deletedBytes: 3 },
        { path: "two.txt", edits: 1, insertedBytes: 3, deletedBytes: 3 },
      ],
      truncated: false,
    });
  });

  test("bounds a structured patch summary while retaining complete aggregate totals", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "many"));
    const files = Array.from({ length: 64 }, (_, index) => {
      const path = `many/file-${index.toString().padStart(2, "0")}.txt`;
      writeFileSync(join(value.repository, path), "a");
      return {
        path,
        expected: { exists: true },
        edits: [{ start: 0, end: 1, bytesBase64: Buffer.from("b").toString("base64") }],
      };
    });
    const result = (await request(value.environment, {
      action: "file-execute",
      version: 1,
      remoteMarker: `moira-op-${"1c".repeat(16)}`,
      repositoryFullName: "owner/repository",
      request: { action: "apply_patch", summaryMaxBytes: 512, files },
    })) as {
      value: {
        summary: {
          filesChanged: number;
          editsApplied: number;
          insertedBytes: number;
          deletedBytes: number;
          entries: unknown[];
          truncated: boolean;
        };
      };
    };
    expect(result.value.summary).toMatchObject({
      filesChanged: 64,
      editsApplied: 64,
      insertedBytes: 64,
      deletedBytes: 64,
      truncated: true,
    });
    expect(result.value.summary.entries.length).toBeLessThan(64);
    expect(Buffer.byteLength(JSON.stringify(result.value.summary))).toBeLessThanOrEqual(512);
    for (const file of files)
      expect(readFileSync(join(value.repository, file.path), "utf8")).toBe("b");
  });

  test("recovers a crashed file commit from its exact marker journal before replay", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2a".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    const target = join(value.repository, "recover.txt");
    const backup = join(value.repository, `.moira-${remoteMarker}-backup.bak`);
    const temporary = join(value.repository, `.moira-${remoteMarker}-staged.tmp`);
    const original = Buffer.from("original");
    const desired = Buffer.from("desired");
    writeFileSync(target, desired);
    writeFileSync(backup, original);
    const requestValue = {
      action: "write",
      path: "recover.txt",
      bytesBase64: desired.toString("base64"),
      expected: {
        exists: true,
        size: original.length,
        sha256: createHash("sha256").update(original).digest("hex"),
      },
    };
    writeFileSync(
      join(operationDirectory, "file-intent.json"),
      JSON.stringify({
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: requestValue,
      }),
    );
    writeFileSync(
      join(operationDirectory, "file-transaction.json"),
      JSON.stringify([
        {
          target: "recover.txt",
          ...parentIdentity(value.repository),
          temporaryName: temporary.split("/").at(-1),
          backup: backup.split("/").at(-1),
          hadOriginal: true,
          originalSha256: createHash("sha256").update(original).digest("hex"),
          desiredSha256: createHash("sha256").update(desired).digest("hex"),
        },
      ]),
    );

    const result = (await request(value.environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker,
    })) as { state: string; value: { action: string } };
    expect(result).toMatchObject({ state: "succeeded", value: { action: "write" } });
    expect(readFileSync(target)).toEqual(desired);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(join(operationDirectory, "file-transaction.json"))).toBe(false);
  });

  test("fails crash recovery closed when an absent target parent was substituted", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2c".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    const parent = join(value.repository, "empty");
    const movedParent = join(value.repository, "empty-moved");
    mkdirSync(operationDirectory, { recursive: true });
    mkdirSync(parent);
    const identity = parentIdentity(parent);
    const temporaryName = `.moira-${remoteMarker}-staged.tmp`;
    const desired = Buffer.from("desired");
    writeFileSync(join(parent, temporaryName), desired);
    const requestValue = {
      action: "write",
      path: "empty/new.txt",
      bytesBase64: desired.toString("base64"),
      expected: { exists: false },
    };
    writeFileSync(
      join(operationDirectory, "file-intent.json"),
      JSON.stringify({
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: requestValue,
      }),
    );
    writeFileSync(
      join(operationDirectory, "file-transaction.json"),
      JSON.stringify([
        {
          target: "empty/new.txt",
          ...identity,
          temporaryName,
          backup: null,
          hadOriginal: false,
          originalSha256: null,
          desiredSha256: createHash("sha256").update(desired).digest("hex"),
        },
      ]),
    );
    renameSync(parent, movedParent);
    mkdirSync(parent);

    await expect(
      request(value.environment, { action: "file-inspect", version: 1, remoteMarker }),
    ).rejects.toThrow();
    expect(existsSync(join(parent, "new.txt"))).toBe(false);
    expect(existsSync(join(movedParent, "new.txt"))).toBe(false);
    expect(readFileSync(join(movedParent, temporaryName))).toEqual(desired);
  });

  test("rolls a partially committed multi-file journal back before coherent replay", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"2b".repeat(16)}`;
    const operationDirectory = join(value.stateRoot, remoteMarker);
    mkdirSync(operationDirectory, { recursive: true });
    const originalOne = Buffer.from("one");
    const originalTwo = Buffer.from("two");
    const desiredOne = Buffer.from("ONE");
    const desiredTwo = Buffer.from("TWO");
    const targetOne = join(value.repository, "one.txt");
    const targetTwo = join(value.repository, "two.txt");
    const backupOne = join(value.repository, `.moira-${remoteMarker}-one.bak`);
    const backupTwo = join(value.repository, `.moira-${remoteMarker}-two.bak`);
    const temporaryOne = join(value.repository, `.moira-${remoteMarker}-one.tmp`);
    const temporaryTwo = join(value.repository, `.moira-${remoteMarker}-two.tmp`);
    writeFileSync(targetOne, desiredOne);
    writeFileSync(backupOne, originalOne);
    writeFileSync(targetTwo, originalTwo);
    writeFileSync(temporaryTwo, desiredTwo);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const patchRequest = {
      action: "apply_patch",
      summaryMaxBytes: 4096,
      files: [
        {
          path: "one.txt",
          expected: { exists: true, size: 3, sha256: digest(originalOne) },
          edits: [{ start: 0, end: 3, bytesBase64: desiredOne.toString("base64") }],
        },
        {
          path: "two.txt",
          expected: { exists: true, size: 3, sha256: digest(originalTwo) },
          edits: [{ start: 0, end: 3, bytesBase64: desiredTwo.toString("base64") }],
        },
      ],
    };
    writeFileSync(
      join(operationDirectory, "file-intent.json"),
      JSON.stringify({
        action: "file-execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        request: patchRequest,
      }),
    );
    writeFileSync(
      join(operationDirectory, "file-transaction.json"),
      JSON.stringify([
        {
          target: "one.txt",
          ...parentIdentity(value.repository),
          temporaryName: temporaryOne.split("/").at(-1),
          backup: backupOne.split("/").at(-1),
          hadOriginal: true,
          originalSha256: digest(originalOne),
          desiredSha256: digest(desiredOne),
        },
        {
          target: "two.txt",
          ...parentIdentity(value.repository),
          temporaryName: temporaryTwo.split("/").at(-1),
          backup: backupTwo.split("/").at(-1),
          hadOriginal: true,
          originalSha256: digest(originalTwo),
          desiredSha256: digest(desiredTwo),
        },
      ]),
    );

    const result = (await request(value.environment, {
      action: "file-inspect",
      version: 1,
      remoteMarker,
    })) as { state: string; value: { action: string; files: unknown[] } };
    expect(result).toMatchObject({
      state: "succeeded",
      value: { action: "apply_patch", files: expect.arrayContaining([expect.any(Object)]) },
    });
    expect(readFileSync(targetOne)).toEqual(desiredOne);
    expect(readFileSync(targetTwo)).toEqual(desiredTwo);
    for (const path of [backupOne, backupTwo, temporaryOne, temporaryTwo]) {
      expect(existsSync(path)).toBe(false);
    }
  });

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
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    const terminal = {
      state,
      stdout: "argument with spaces;$(false)|native stdin",
      stderr: "err",
      exitCode,
      stdoutBytes: "argument with spaces;$(false)|native stdin".length,
      stderrBytes: 3,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
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

  test("publishes the result of a command that exits before its stdin is written", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"6".repeat(32)}`;
    // /bin/echo exits without reading stdin, so a large payload reaches a closed pipe while
    // the runner is still recording the child's identity.
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "fast"],
        cwd: ".",
        stdin: Buffer.from("x".repeat(256 * 1024)).toString("base64"),
        timeoutMs: 5_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toEqual({
      state: "succeeded",
      stdout: "fast\n",
      stderr: "",
      exitCode: 0,
      stdoutBytes: 5,
      stderrBytes: 0,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
    });
  });

  test("keeps a noisy command's own outcome and every byte it printed", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"7".repeat(32)}`;
    // Far more than the response payload may carry, ending with a marker that only a reader of
    // the last bytes can see, and then an exit code and standard error of the command's own.
    const script =
      "for(let i=0;i<200;i++)process.stdout.write('x'.repeat(1024));" +
      "process.stdout.write('TAIL');process.stderr.write('real failure');process.exitCode=7";
    await request(value.environment, {
      action: "execute",
      version: 1,
      remoteMarker,
      repositoryFullName: "owner/repository",
      argv: [process.execPath, "-e", script],
      cwd: ".",
      stdin: "",
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      maxRetainedBytes: 1024 * 1024,
    });
    const terminal = (await inspectUntilTerminal(value.environment, remoteMarker)) as Record<
      string,
      unknown
    >;
    const totalStdout = 200 * 1024 + 4;
    expect(terminal).toMatchObject({
      state: "failed",
      exitCode: 7,
      stderr: "real failure",
      stdoutBytes: totalStdout,
      outputLimitExceeded: false,
    });
    // The payload is a bounded prefix of the real stream, not a replacement for it.
    expect(Buffer.byteLength(terminal.stdout as string)).toBe(4096);

    const tail = (await request(value.environment, {
      action: "output",
      version: 1,
      remoteMarker,
      stream: "stdout",
      offset: totalStdout - 4,
      length: 64,
    })) as { totalBytes: number; bytesBase64: string; offset: number; stream: string };
    expect(tail).toMatchObject({
      stream: "stdout",
      offset: totalStdout - 4,
      totalBytes: totalStdout,
    });
    expect(Buffer.from(tail.bytesBase64, "base64").toString("utf8")).toBe("TAIL");

    const middle = (await request(value.environment, {
      action: "output",
      version: 1,
      remoteMarker,
      stream: "stdout",
      offset: 4096,
      length: 8,
    })) as { bytesBase64: string };
    expect(Buffer.from(middle.bytesBase64, "base64").toString("utf8")).toBe("x".repeat(8));

    // A read that starts at the end answers with no bytes and the current size, so a caller can
    // find the end of a stream without provoking an error.
    for (const offset of [12, 4096]) {
      const past = (await request(value.environment, {
        action: "output",
        version: 1,
        remoteMarker,
        stream: "stderr",
        offset,
        length: 64,
      })) as { totalBytes: number; bytesBase64: string };
      expect(past).toMatchObject({ totalBytes: 12, bytesBase64: "" });
    }

    await expect(
      request(value.environment, { action: "finalize", version: 1, remoteMarker }),
    ).resolves.toEqual({ state: "absent" });
    // Cleanup removes the retained streams with the result they belong to.
    await expect(
      request(value.environment, {
        action: "output",
        version: 1,
        remoteMarker,
        stream: "stdout",
        offset: 0,
        length: 8,
      }),
    ).resolves.toEqual({ state: "absent" });
  });

  test("accepts a command whose own timer outlives any request", async () => {
    const value = fixture();
    const remoteMarker = `moira-op-${"8".repeat(32)}`;
    // Three hours is far past the bound a single request could wait for; the command itself is
    // short, so the test observes admission and collection rather than elapsed time.
    await expect(
      request(value.environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "long"],
        cwd: ".",
        stdin: "",
        timeoutMs: 3 * 60 * 60_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
      }),
    ).resolves.toEqual({ state: "running" });
    await expect(inspectUntilTerminal(value.environment, remoteMarker)).resolves.toMatchObject({
      state: "succeeded",
      stdout: "long\n",
      exitCode: 0,
    });
  });

  test("carries a session's directory and variables and refuses one from an earlier life", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "packages"), { recursive: true });
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const observe = [
      process.execPath,
      "-e",
      "process.stdout.write(process.cwd()+'|'+(process.env.SESSION_VARIABLE??'none'))",
    ];
    const run = async (remoteMarker: string, extra: Record<string, unknown>) => {
      await request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        ...extra,
      });
      return inspectUntilTerminal(environment, remoteMarker);
    };
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;

    // The opening call establishes the context its command runs in.
    const opened = (await run(marker("a"), {
      session: "build",
      sessionStart: true,
      cwd: "packages",
      env: { SESSION_VARIABLE: "carried" },
    })) as Record<string, string>;
    expect(opened.stdout).toBe(`${realpathSync(join(value.repository, "packages"))}|carried`);

    // A later command in the same session names neither and observes both.
    const continued = (await run(marker("b"), { session: "build" })) as Record<string, string>;
    expect(continued.stdout).toBe(`${realpathSync(join(value.repository, "packages"))}|carried`);

    // A command outside the session observes neither, and a second session is independent.
    const outside = (await run(marker("c"), {})) as Record<string, string>;
    expect(outside.stdout).toBe(`${realpathSync(value.repository)}|none`);
    const other = (await run(marker("d"), { session: "other", sessionStart: true })) as Record<
      string,
      string
    >;
    expect(other.stdout).toBe(`${realpathSync(value.repository)}|none`);

    // The stored context belongs to the life of the environment that opened it: one written by an
    // earlier life is refused, and a session that was never opened is refused too.
    storeForeignLife(join(value.stateRoot, "sessions", "build.json"));
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker("e"),
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "build",
      }),
    ).resolves.toEqual({ state: "session_unavailable" });
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker("f"),
        repositoryFullName: "owner/repository",
        argv: observe,
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "never-opened",
      }),
    ).resolves.toEqual({ state: "session_unavailable" });
  });

  test("carries what a script leaves behind and refuses a context that would not fit", async () => {
    const value = fixture();
    mkdirSync(join(value.repository, "service"), { recursive: true });
    const environment: Record<string, string> = {
      ...value.environment,
      MOIRA_ENVIRONMENT_ID: "life-one",
      INHERITED_TOOL: "old",
      REMOVE_ME: "present",
    };
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;
    const send = (remoteMarker: string, extra: Record<string, unknown>) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 20_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        ...extra,
      });
    const observe = [
      process.execPath,
      "-e",
      "process.stdout.write([require('node:path').basename(process.cwd()),process.env.TOOL_HOME??'none',process.env.INHERITED_TOOL??'gone',process.env.REMOVE_ME??'gone',process.env.PATH.split(':')[0]].join('|'))",
    ];

    // A script activates something: it changes directory, adds a variable, changes an inherited one
    // and removes another.
    await send(marker("1"), {
      session: "build",
      sessionStart: true,
      script:
        "cd service\nexport TOOL_HOME=/opt/tool\nexport INHERITED_TOOL=new\nexport PATH=/opt/tool/bin:$PATH\nunset REMOVE_ME\n",
    });
    expect(await inspectUntilTerminal(environment, marker("1"))).toMatchObject({
      state: "succeeded",
      sessionCaptureDropped: false,
    });

    // An ordinary argv command in that session sees every one of those changes and nothing else.
    await send(marker("2"), { session: "build", argv: observe });
    const continued = (await inspectUntilTerminal(environment, marker("2"))) as Record<
      string,
      string
    >;
    expect(continued.stdout).toBe("service|/opt/tool|new|gone|/opt/tool/bin");

    // A command outside the session is untouched by all of it.
    await send(marker("3"), { argv: observe });
    const outside = (await inspectUntilTerminal(environment, marker("3"))) as Record<
      string,
      string
    >;
    expect(outside.stdout).toBe(
      "repository|none|old|present|/opt/tool/bin".replace(
        "/opt/tool/bin",
        environment.PATH!.split(":")[0],
      ),
    );

    // A call whose declared context would not fit the stored-context ceiling is refused, and the
    // session it names still works afterwards.
    const oversized = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`BIG_${index}`, "x".repeat(4000)]),
    );
    await expect(
      send(marker("4"), { session: "build", argv: observe, env: oversized }),
    ).resolves.toEqual({ state: "session_limit", limit: "context" });
    await send(marker("5"), { session: "build", argv: observe });
    expect(
      ((await inspectUntilTerminal(environment, marker("5"))) as Record<string, string>).stdout,
    ).toBe("service|/opt/tool|new|gone|/opt/tool/bin");

    // The stored context holds only what the script touched: an inherited variable it never named
    // is absent from the file, which is what keeps the workspace's own environment out of it.
    const storedSession = JSON.parse(
      readFileSync(join(value.stateRoot, "sessions", "build.json"), "utf8"),
    ) as { env: Record<string, string | null> };
    expect(Object.keys(storedSession.env).sort()).toEqual([
      "INHERITED_TOOL",
      "PATH",
      "REMOVE_ME",
      "TOOL_HOME",
    ]);
    expect(JSON.stringify(storedSession)).not.toContain("MOIRA_ENVIRONMENT_ID");

    // A script that fails still leaves its end state behind, while one that ends the shell itself
    // cannot report an end state at all and the answer says its capture was dropped.
    await send(marker("8"), {
      session: "build",
      script: "export AFTER_FAILURE=kept\nfalse\n",
    });
    expect(await inspectUntilTerminal(environment, marker("8"))).toMatchObject({
      state: "failed",
      exitCode: 1,
      sessionCaptureDropped: false,
    });
    await send(marker("c"), { session: "build", script: "export NEVER_SEEN=x\nexit 3\n" });
    expect(await inspectUntilTerminal(environment, marker("c"))).toMatchObject({
      state: "failed",
      exitCode: 3,
      sessionCaptureDropped: true,
    });
    await send(marker("9"), {
      session: "build",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.AFTER_FAILURE??'lost')"],
    });
    expect(
      ((await inspectUntilTerminal(environment, marker("9"))) as Record<string, string>).stdout,
    ).toBe("kept");

    await send(marker("a"), {
      session: "build",
      script: `export TOO_LONG=${"x".repeat(5000)}\n`,
    });
    expect(await inspectUntilTerminal(environment, marker("a"))).toMatchObject({
      state: "succeeded",
      sessionCaptureDropped: true,
    });
    // The session still works, with the context it had before that script.
    await send(marker("b"), {
      session: "build",
      argv: [process.execPath, "-e", "process.stdout.write(process.env.TOOL_HOME??'none')"],
    });
    expect(
      ((await inspectUntilTerminal(environment, marker("b"))) as Record<string, string>).stdout,
    ).toBe("/opt/tool");

    // Ending the session frees its slot and removes the stored context, so naming it is refused.
    await expect(send(marker("6"), { session: "build", sessionEnd: true })).resolves.toEqual({
      state: "session_ended",
    });
    await expect(send(marker("7"), { session: "build", argv: observe })).resolves.toEqual({
      state: "session_unavailable",
    });
  });

  test("names a command whose workspace restarted under it, and not one that failed inside this life", async () => {
    const value = fixture();
    const marker = (character: string) => `moira-op-${character.repeat(32)}`;
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const start = (remoteMarker: string) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: [process.execPath, "-e", "setTimeout(() => {}, 300000)"],
        stdin: "",
        timeoutMs: 300_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxRetainedBytes: 1024 * 1024,
      });

    await expect(start(marker("d"))).resolves.toEqual({ state: "running" });
    // A restart leaves the operation's files and identity behind and takes every process with it.
    const directory = join(value.stateRoot, marker("d"));
    const identity = JSON.parse(readFileSync(join(directory, "pid"), "utf8")) as { pid: number };
    const runner = JSON.parse(readFileSync(join(directory, "runner-pid"), "utf8")) as {
      pid: number;
    };
    for (const pid of [identity.pid, runner.pid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));

    // The required state: the same absence of a result means one thing when the operation belongs to
    // this life and another when it belongs to an earlier one. The recorded life is what separates
    // them, so it is asked about first as it stands and then as a restart would have left it.
    await expect(
      request(environment, { action: "inspect", version: 1, remoteMarker: marker("d") }),
    ).resolves.toMatchObject({
      state: "failed",
      stderr: "operation supervisor exited without a result",
    });
    storeForeignLife(join(directory, "environment"));
    await expect(
      request(environment, { action: "inspect", version: 1, remoteMarker: marker("d") }),
    ).resolves.toEqual({ state: "interrupted" });
  });

  test("counts only the sessions this life can use and lets a dead one free its slot", async () => {
    const value = fixture();
    const environment = { ...value.environment, MOIRA_ENVIRONMENT_ID: "life-one" };
    const marker = (index: number) => `moira-op-${index.toString(16).padStart(32, "0")}`;
    const open = (environment: NodeJS.ProcessEnv, session: string, remoteMarker: string) =>
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker,
        repositoryFullName: "owner/repository",
        argv: ["/bin/echo", "open"],
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session,
        sessionStart: true,
      });

    // Fill the workspace's sessions in one life of the environment.
    for (let index = 0; index < 16; index++) {
      await expect(open(environment, `session-${index}`, marker(index))).resolves.toEqual({
        state: "running",
      });
    }
    await expect(open(environment, "one-too-many", marker(100))).resolves.toEqual({
      state: "session_limit",
      limit: "sessions",
    });

    // A restart leaves every one of those files behind, written by a life that has ended. None of
    // them can be used any more, so none of them holds a slot either.
    for (let index = 0; index < 16; index++) {
      storeForeignLife(join(value.stateRoot, "sessions", `session-${index}.json`));
    }
    await expect(open(environment, "fresh", marker(101))).resolves.toEqual({ state: "running" });

    // A session left by an earlier life is removed by the call that ends it, rather than lingering.
    await expect(
      request(environment, {
        action: "execute",
        version: 1,
        remoteMarker: marker(102),
        repositoryFullName: "owner/repository",
        stdin: "",
        timeoutMs: 10_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 4096,
        maxRetainedBytes: 1024 * 1024,
        session: "session-0",
        sessionEnd: true,
      }),
    ).resolves.toEqual({ state: "session_ended" });
    expect(existsSync(join(value.stateRoot, "sessions", "session-0.json"))).toBe(false);
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
      maxRetainedBytes: 1024 * 1024,
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
      stdoutBytes: 0,
      stderrBytes: 0,
      outputLimitExceeded: false,
      sessionCaptureDropped: false,
    });
  });

  test.each([
    [
      "retained output",
      "setInterval(()=>process.stdout.write('x'.repeat(1024)),0)",
      5_000,
      16 * 1024,
      "failed",
    ],
    ["timeout", "setInterval(()=>{},1000)", 50, 1024 * 1024, "timed_out"],
  ] as const)(
    "enforces the %s bound on the remote foreground group",
    async (_name, script, timeoutMs, retainedLimitBytes, expectedState) => {
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
        maxStdoutBytes: 64,
        maxStderrBytes: 64,
        maxRetainedBytes: retainedLimitBytes,
      });
      const result = await inspectUntilTerminal(value.environment, remoteMarker);
      expect(result.state).toBe(expectedState);
      // Only the retained ceiling stops a command for its volume, and it says so instead of
      // presenting itself as the command's own failure.
      expect(result.outputLimitExceeded).toBe(expectedState === "failed");
      if (expectedState === "failed") {
        expect(result.stdoutBytes).toBe(retainedLimitBytes);
      }
    },
  );
});
