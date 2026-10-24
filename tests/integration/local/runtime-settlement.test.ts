import { expect, test } from "@jest/globals";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { readRuntimeSettlement, settleRuntimeOwner } from "../../../packages/local/src/guard.js";
import { LocalRefusal, localRuntimeProfileHash } from "../../../packages/local/src/policy.js";
import { localFixture } from "./fixtures.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-runtime-settlement-")));
  const state = await PrivateState.open(root);
  const local = await localFixture(state);
  const unlock = await state.lock({ recoverStale: true });
  const receipt = {
    owner: randomUUID(),
    profile: localRuntimeProfileHash(local.policy),
    settled: false,
    released: true as const,
  };
  await state.write("runtime-owner.json", receipt);
  const original = await readFile(join(root, "runtime-owner.json"));
  return {
    ...local,
    state,
    receipt,
    original,
    async close() {
      await unlock();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("explicit maintenance settles the captured profile and replaces released custody only after its former owner exited", async () => {
  const f = await fixture();
  const formerOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(formerOwner, "exit");
  await f.state.write("runtime-owner.json", { ...f.receipt, ownerPID: formerOwner.pid });
  try {
    await settleRuntimeOwner(f.records, async (policy) => {
      expect(policy).toEqual(f.policy);
      expect(await readRuntimeSettlement(f.records)).toMatchObject({
        settled: false,
        released: true,
      });
    });
    const settled = await readRuntimeSettlement(f.records);
    expect(settled).toEqual({
      owner: expect.any(String),
      profile: f.receipt.profile,
      settled: true,
    });
    expect(settled?.owner).not.toBe(f.receipt.owner);
    expect(await f.records.get(f.space.id)).toEqual(f.space);
    expect(await f.records.policy()).toEqual(f.policy);
  } finally {
    await f.close();
  }
});

test.each(["live owner", "different profile"])(
  "explicit settlement refuses %s before kernel effects and preserves the original receipt",
  async (obstruction) => {
    const f = await fixture();
    try {
      await f.state.write("runtime-owner.json", {
        ...f.receipt,
        ...(obstruction === "live owner" ? { ownerPID: process.pid } : { profile: "c".repeat(64) }),
      });
      const original = await readFile(join(f.state.root, "runtime-owner.json"));
      await expect(
        settleRuntimeOwner(f.records, async () => {
          throw new Error("A refused owner must not enter kernel settlement");
        }),
      ).rejects.toMatchObject({
        code: obstruction === "live owner" ? "LOCAL_OWNER_ACTIVE" : "LOCAL_RUNTIME_CHANGED",
      });
      expect(await readFile(join(f.state.root, "runtime-owner.json"))).toEqual(original);
      expect(await f.records.get(f.space.id)).toEqual(f.space);
    } finally {
      await f.close();
    }
  },
);

test("unconfirmed kernel shutdown cannot publish a settled owner", async () => {
  const f = await fixture();
  try {
    await expect(
      settleRuntimeOwner(f.records, async () => {
        throw new LocalRefusal("LOCAL_CUSTODY_UNCONFIRMED", "Controlled kernel observation loss");
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CUSTODY_UNCONFIRMED" });
    expect(await readFile(join(f.state.root, "runtime-owner.json"))).toEqual(f.original);
    expect(await f.records.get(f.space.id)).toEqual(f.space);
  } finally {
    await f.close();
  }
});

test.each(["policy", "receipt"])(
  "a changed %s during shutdown refuses settlement without overwriting the changed state",
  async (changed) => {
    const f = await fixture();
    const policy = { ...f.policy, enabled: false };
    const receipt = { ...f.receipt, owner: randomUUID() };
    try {
      await expect(
        settleRuntimeOwner(f.records, async () => {
          if (changed === "policy") await f.state.write("policy.json", policy);
          else await f.state.write("runtime-owner.json", receipt);
        }),
      ).rejects.toMatchObject({ code: "LOCAL_RUNTIME_CHANGED" });
      expect(await f.records.policy()).toEqual(changed === "policy" ? policy : f.policy);
      expect(await readRuntimeSettlement(f.records)).toEqual(
        changed === "receipt" ? receipt : f.receipt,
      );
      expect(await f.records.get(f.space.id)).toEqual(f.space);
    } finally {
      await f.close();
    }
  },
);
