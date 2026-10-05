import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { build } from "esbuild";
import {
  mkdtemp,
  rm,
  writeFile,
  chmod,
  symlink,
  readFile,
  realpath,
  copyFile,
  link,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { RequestJournal } from "../../../packages/local/src/journal.js";
import { localFixture } from "./fixtures.js";

const execute = promisify(execFile);

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-state-")));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private local state", () => {
  test("shipping device recovery after a dead real lock owner retains journals and permits a later owner", async () => {
    const local = await localFixture(state);
    local.policy.enabled = false;
    await state.write("policy.json", local.policy);
    const module = join(root, "private-state.mjs");
    await build({
      entryPoints: ["packages/local/src/private-state.ts"],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    await copyFile(
      "packages/local/dist/runtime-control-helper",
      join(root, "runtime-control-helper"),
    );
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {PrivateState} from ${JSON.stringify(`file://${module}`)};
      const state=await PrivateState.open(${JSON.stringify(root)});
      await state.lock();process.stdout.write('ready');process.stdin.resume();
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(owner.stdout, "data"),
        once(owner, "close").then(() => {
          throw Error("Owner failed before ready");
        }),
      ]);
      const closed = once(owner, "close");
      owner.kill("SIGKILL");
      await closed;
      const job = { unknown: true, marker: "own-unknown-job" };
      await state.write("job-unknown.json", job);
      const spaces = await readFile(join(root, `space-${local.space.id}.json`));
      const result = await execute(process.execPath, [
        "packages/local/dist/cli.js",
        "recover",
        "--confirm",
        "--state",
        root,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        recovered: true,
        enabled: false,
        priorJobsRetained: true,
        dataPreserved: true,
      });
      expect(await state.read("job-unknown.json", (value) => value)).toEqual(job);
      expect((await readFile(join(root, `space-${local.space.id}.json`))).equals(spaces)).toBe(
        true,
      );
      expect(await state.read("runtime-owner.json", (value) => value)).toMatchObject({
        settled: true,
      });
      const release = await state.lock();
      await release();
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const closed = once(owner, "close");
        owner.kill("SIGKILL");
        await closed;
      }
    }
  });
  test("explicit marker recovery refuses a live or unknown owner without changing bytes", async () => {
    await writeFile(join(root, "runner.lock"), String(process.pid), { mode: 0o600 });
    await expect(state.lock({ recoverStale: true })).rejects.toThrow("Another companion owns");
    expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
    for (const marker of ["", "0", "no-pid", "2147483648", Buffer.from([0xb1, 0xb2])]) {
      await writeFile(join(root, "runner.lock"), marker, { mode: 0o600 });
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(/Unsafe|Unknown/);
      expect(await readFile(join(root, "runner.lock"))).toEqual(Buffer.from(marker));
    }
  });
  test.each(["symlink", "hardlink", "permissions"] as const)(
    "explicit recovery refuses unsafe %s marker",
    async (kind) => {
      const target = join(root, "outside");
      await writeFile(target, "1", { mode: 0o600 });
      if (kind === "symlink") await symlink(target, join(root, "runner.lock"));
      else if (kind === "hardlink") await link(target, join(root, "runner.lock"));
      else await writeFile(join(root, "runner.lock"), "1", { mode: 0o644 });
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(/Unsafe/);
      expect(await readFile(target, "utf8")).toBe("1");
    },
  );
  test.each(["runner.lock", "runner-gate.lock"])(
    "recovery refuses unsafe FIFO %s without opening a stream",
    async (name) => {
      await execute("/usr/bin/mkfifo", [join(root, name)]);
      await chmod(join(root, name), 0o600);
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(
        /Unsafe|private kernel lock/,
      );
      expect((await lstat(join(root, name))).isFIFO()).toBe(true);
    },
  );
  test("concurrent explicit recovery never displaces the winning owner or changes the gate inode", async () => {
    const dead = spawn(process.execPath, ["-e", ""]);
    await once(dead, "close");
    await writeFile(join(root, "runner.lock"), String(dead.pid), { mode: 0o600 });
    const results = await Promise.allSettled([
      state.lock({ recoverStale: true }),
      state.lock({ recoverStale: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const gate = await lstat(join(root, "runner-gate.lock"));
    expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
    for (const result of results) if (result.status === "fulfilled") await result.value();
    const release = await state.lock();
    const nextGate = await lstat(join(root, "runner-gate.lock"));
    expect([nextGate.dev, nextGate.ino]).toEqual([gate.dev, gate.ino]);
    await release();
  });
  test("explicit recovery reclaims a SIGKILL owner's marker without replaying its unknown job", async () => {
    const module = join(root, "private-state.mjs");
    await build({
      entryPoints: ["packages/local/src/private-state.ts"],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    await copyFile(
      "packages/local/dist/runtime-control-helper",
      join(root, "runtime-control-helper"),
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {PrivateState} from ${JSON.stringify(`file://${module}`)};
      const state=await PrivateState.open(${JSON.stringify(root)});
      await state.lock(); process.stdout.write('ready'); process.stdin.resume();
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "close").then(() => {
          throw new Error("Lock owner exited before readiness");
        }),
      ]);
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
      const job = { unknown: true, digest: "a".repeat(64) };
      await state.write("job-unknown.json", job);
      await expect(state.lock()).rejects.toThrow("Another companion owns");
      const release = await state.lock({ recoverStale: true });
      try {
        expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
        expect(await state.read("job-unknown.json", (value) => value)).toEqual(job);
        await expect(state.lock()).rejects.toThrow("Another companion owns");
      } finally {
        await release();
      }
      const next = await state.lock();
      await release();
      await expect(state.lock()).rejects.toThrow("Another companion owns");
      await next();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
  test("persists complete large documents atomically without following links", async () => {
    const value = { data: "x".repeat(1024 * 1024) };
    await state.write("large.json", value);
    expect(await state.read("large.json", (item) => item)).toEqual(value);
    await writeFile(join(root, "outside"), "host-data", { mode: 0o600 });
    await symlink(join(root, "outside"), join(root, "link.json"));
    await expect(state.read("link.json", (item) => item)).rejects.toThrow();
    await expect(state.write("link.json", {})).rejects.toThrow("Unsafe local state replacement");
    expect(await readFile(join(root, "outside"), "utf8")).toBe("host-data");
    await expect(state.write("../outside.json", {})).rejects.toThrow("Invalid local state key");
  });
  test("refuses broad permissions and a second owner of the runner lock", async () => {
    await state.write("credential.json", { value: "sensitive" });
    await chmod(join(root, "credential.json"), 0o644);
    await expect(state.read("credential.json", (item) => item)).rejects.toThrow(
      "Unsafe local state file",
    );
    const release = await state.lock();
    await expect(state.lock()).rejects.toThrow("Another companion owns");
    await release();
    await (
      await state.lock()
    )();
  });
});

describe("replay and result lifetime", () => {
  test("coalesces concurrent requests and returns the durable result after restart", async () => {
    const journal = new RequestJournal(state, () => 1000);
    const id = randomUUID();
    let performed = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const action = async () => {
      performed++;
      await gate;
      return { ok: true, bytes: "result" };
    };
    const first = journal.run(id, 2000, { action: "write" }, action);
    const duplicate = journal.run(id, 2000, { action: "write" }, action);
    finish();
    expect(await Promise.all([first, duplicate])).toEqual([
      { ok: true, bytes: "result" },
      { ok: true, bytes: "result" },
    ]);
    expect(performed).toBe(1);
    const restarted = new RequestJournal(state, () => 1000);
    expect(await restarted.run(id, 2000, { action: "write" }, action)).toEqual({
      ok: true,
      bytes: "result",
    });
    expect(performed).toBe(1);
    await expect(restarted.run(id, 2000, { action: "delete" }, action)).rejects.toThrow(
      "cannot change its contents",
    );
    await restarted.acknowledge(id);
    await expect(restarted.run(id, 2000, { action: "write" }, action)).rejects.toThrow(
      "acknowledged and removed",
    );
    expect(await state.keys("result-")).toEqual([]);
  });
  test("an accepted request with unknown outcome is never redispatched after a crash", async () => {
    const journal = new RequestJournal(state, () => 1000);
    const id = randomUUID();
    let performed = 0;
    await expect(
      journal.run(id, 2000, {}, async () => {
        performed++;
        throw new Error("crash after effect");
      }),
    ).rejects.toThrow("crash");
    const restarted = new RequestJournal(state, () => 1000);
    await expect(
      restarted.run(id, 2000, {}, async () => {
        performed++;
      }),
    ).rejects.toThrow("may have run");
    expect(performed).toBe(1);
  });
  test("separate concurrent requests retain separate receipts and expire without replay", async () => {
    let now = 1000;
    const journal = new RequestJournal(state, () => now);
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const results = await Promise.all(
      ids.map((id, index) => journal.run(id, 2000, { index }, async () => ({ index }))),
    );
    expect(results).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
    expect(await state.keys("result-")).toHaveLength(4);
    now = 2001;
    await journal.expire();
    expect(await state.keys("result-")).toEqual([]);
    await expect(journal.run(ids[0], 2000, {}, async () => null)).rejects.toThrow("expired");
  });
});
