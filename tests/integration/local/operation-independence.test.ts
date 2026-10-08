import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import { localFixture } from "./fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "moira-independent-work-")));
  directories.push(path);
  const state = await PrivateState.open(path);
  const local = await localFixture(state);
  local.space.networkPolicy = "a".repeat(64);
  await local.records.put(local.space);
  const owner = new RuntimeOwner(
    local.records,
    local.space.id,
    async () => {},
    async () => {},
  );
  await owner.admit();
  const request = () => ({
    action: "execute",
    remoteMarker: `moira-op-${randomBytes(16).toString("hex")}`,
    repositoryFullName: local.policy.repositories[0].fullName,
    timeoutMs: 1000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    maxRetainedBytes: 2048,
  });
  return { ...local, owner, request };
}

describe("independent native guest contacts", () => {
  test("a pending contact does not queue another command and stop closes new admission", async () => {
    const local = await fixture();
    const held = local.request();
    let accepted!: () => void;
    const entered = new Promise<void>((done) => {
      accepted = done;
    });
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    jest
      .spyOn(SbxRuntime.prototype, "runFixedGuest")
      .mockImplementation(async (_identity, _entry, input) => {
        const request = JSON.parse(Buffer.from(input!).toString()).request;
        if (request.remoteMarker === held.remoteMarker) {
          accepted();
          await barrier;
        }
        return Buffer.from(JSON.stringify({ ok: true, result: { state: "running" } }));
      });
    const first = local.owner.operation(held);
    await entered;
    try {
      await expect(local.owner.operation(local.request())).resolves.toBeInstanceOf(Buffer);
      const stopped = local.owner.quiesce();
      await expect(local.owner.operation(local.request())).rejects.toMatchObject({
        code: "LOCAL_NOT_RUNNING",
      });
      release();
      await first;
      await stopped;
      expect(await local.records.get(local.space.id)).toMatchObject({ desiredState: "stopped" });
    } finally {
      release();
      await first;
    }
  });

  test("a lost operation response leaves its VM available for independent work and inspection", async () => {
    const local = await fixture();
    jest
      .spyOn(SbxRuntime.prototype, "runFixedGuest")
      .mockRejectedValueOnce(
        new LocalRefusal("LOCAL_GUEST_SETTLEMENT_UNKNOWN", "Lost operation response"),
      )
      .mockResolvedValue(Buffer.from(JSON.stringify({ ok: true, result: { state: "running" } })));
    await expect(local.owner.operation(local.request())).rejects.toMatchObject({
      code: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
    });
    expect(local.owner.active).toBe(true);
    await local.records.put({ ...local.space, generation: local.space.generation + 5 });
    await expect(local.owner.operation(local.request())).resolves.toBeInstanceOf(Buffer);
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "running",
      failure: null,
    });
    await local.owner.quiesce();
  });
});
