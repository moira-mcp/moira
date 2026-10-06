import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { replaceStoppedPolicy } from "../../../packages/local/src/guard.js";
import { localFixture } from "./fixtures.js";
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ml-policy-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
test("a stopped policy transition resumes after policy write before owner receipt without reopening unknown work", async () => {
  const f = await localFixture(await PrivateState.open(directory));
  const profile = (runtime: typeof f.policy.runtime) =>
    createHash("sha256")
      .update(JSON.stringify({ deviceId: f.policy.deviceId, runtime }))
      .digest("hex");
  await f.records.state.write("runtime-owner.json", {
    owner: randomUUID(),
    profile: profile(f.policy.runtime),
    settled: true,
  });
  await f.records.state.write("request-retained.json", { state: "unknown", marker: "keep" });
  const next = { ...f.policy, runtime: { ...f.policy.runtime, cpuCores: 2 } };
  const write = f.records.state.write.bind(f.records.state);
  let crash = true;
  f.records.state.write = async (key, value) => {
    if (key === "runtime-owner.json" && crash) {
      crash = false;
      throw new Error("Controlled interruption before owner receipt");
    }
    await write(key, value);
  };
  const release = await f.records.state.lock();
  try {
    await expect(replaceStoppedPolicy(f.records, next)).rejects.toThrow("Controlled interruption");
    expect((await f.records.policy()).runtime.cpuCores).toBe(2);
    f.records.state.write = write;
    await replaceStoppedPolicy(f.records, { ...next, leaseUntil: next.leaseUntil + 1000 });
    expect((await f.records.policy()).runtime.cpuCores).toBe(2);
    expect(await f.records.state.read("runtime-owner.json", (v) => v)).toMatchObject({
      profile: profile(next.runtime),
      settled: true,
    });
    expect(await f.records.state.read("request-retained.json", (v) => v)).toEqual({
      state: "unknown",
      marker: "keep",
    });
  } finally {
    f.records.state.write = write;
    await release();
  }
});
