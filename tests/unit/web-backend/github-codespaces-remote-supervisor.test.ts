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
