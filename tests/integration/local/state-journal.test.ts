import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, writeFile, chmod, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { RequestJournal } from "../../../packages/local/src/journal.js";

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moira-local-state-"));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private local state", () => {
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
