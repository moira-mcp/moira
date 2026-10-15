import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { ControllerState } from "../../../packages/local/src/controller-state.js";
import { createWorkspaceRequestId } from "../../../packages/shared/src/codespaces/workspace-request-id.js";
import { localFixture } from "../../integration/local/fixtures.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "moira-controller-state-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const identity = () => ({
  userId: "owner",
  deviceId: randomUUID(),
  deviceGeneration: 1,
  connectionId: randomUUID(),
});

describe("Controller owns lifecycle admission and original result", () => {
  test("response observation loss does not dispatch another mutation, and collection reads its original outcome", async () => {
    const state = await PrivateState.open(directory);
    const records = new LocalRecords(state),
      journal = new ControllerState(records),
      owner = identity();
    const requestId = createWorkspaceRequestId(),
      input = { action: "start", resourceId: randomUUID() };
    let entered!: () => void, complete!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const action = async () => {
      await state.write("effect.json", { original: requestId });
      entered();
      await held;
      return { started: true };
    };
    const first = journal.run(requestId, owner, input, action);
    await admitted;
    expect(await journal.inspect(requestId, owner)).toEqual({ requestId, state: "accepted" });
    const replay = journal.run(requestId, owner, input, async () => {
      throw new Error("A repeat must not execute");
    });
    complete();
    const expected = {
      requestId,
      state: "completed",
      outcome: { ok: true, result: { started: true } },
    };
    expect(await first).toEqual(expected);
    expect(await replay).toEqual(expected);
    expect(await new ControllerState(records).inspect(requestId, owner)).toEqual(expected);
    expect(await state.read("effect.json", (value) => value)).toEqual({ original: requestId });
  });
  test("accepted request after owner restart remains unconfirmed and cannot execute again", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      owner = identity();
    const journal = new ControllerState(records),
      requestId = createWorkspaceRequestId(),
      input = { action: "delete", resourceId: randomUUID() };
    let entered!: () => void, complete!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const first = journal.run(requestId, owner, input, async () => {
      entered();
      await held;
      return { removed: true };
    });
    await admitted;
    const restarted = new ControllerState(records);
    expect((await restarted.pendingResources(owner)).get(input.resourceId)).toEqual([requestId]);
    expect(await restarted.inspect(requestId, owner)).toEqual({ requestId, state: "unconfirmed" });
    expect(
      await restarted.run(requestId, owner, input, async () => {
        throw new Error("Must never redispatch after restart");
      }),
    ).toEqual({ requestId, state: "unconfirmed" });
    await expect(
      restarted.run(requestId, owner, { action: "start" }, async () => ({})),
    ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
    await expect(
      restarted.inspect(requestId, { ...owner, userId: "another" }),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    complete();
    await first;
    expect((await restarted.pendingResources(owner)).has(input.resourceId)).toBe(false);
  });
  test("mapping migration preserves native identity and every archived byte without making old requests runnable", async () => {
    const state = await PrivateState.open(directory),
      local = await localFixture(state);
    const owner = { ...identity(), deviceId: local.policy.deviceId };
    const resourceId = randomUUID(),
      oldRequestId = randomUUID();
    const mappingKey = `relay-space-${resourceId}.json`;
    await state.write(mappingKey, {
      ...owner,
      resourceId,
      serverGeneration: 7,
      repositoryId: local.space.repositoryId,
      createMarker: local.space.operationMarker,
      localSpaceId: local.space.id,
      localGeneration: local.space.generation,
      createRequestId: oldRequestId,
      createDigest: "a".repeat(64),
    });
    await state.write(`lifecycle-request-${oldRequestId}.json`, {
      state: "UNKNOWN",
      requestId: oldRequestId,
    });
    const original = await readFile(join(directory, mappingKey));
    const unknown = await readFile(join(directory, `lifecycle-request-${oldRequestId}.json`));
    const journal = new ControllerState(local.records);
    await journal.importBindings(owner);
    expect(await journal.forSpace(local.space, owner)).toMatchObject({
      resourceId,
      resourceGeneration: 7,
      localSpaceId: local.space.id,
    });
    expect(await readFile(join(directory, mappingKey))).toEqual(original);
    expect(await readFile(join(directory, `lifecycle-request-${oldRequestId}.json`))).toEqual(
      unknown,
    );
    expect(await journal.inspect(`ws1-${oldRequestId}`, owner)).toEqual({
      requestId: `ws1-${oldRequestId}`,
      state: "absent",
    });
    await journal.importBindings(owner);
    expect(await journal.bindings(owner)).toHaveLength(1);
    expect((await local.records.get(local.space.id))?.runtimeId).toBe(local.space.runtimeId);
  });
  test("closed unknown creation mapping cannot select a same-marker native record as its new owner", async () => {
    const state = await PrivateState.open(directory),
      local = await localFixture(state);
    const owner = { ...identity(), deviceId: local.policy.deviceId },
      resourceId = randomUUID();
    await state.write(`relay-space-${resourceId}.json`, {
      ...owner,
      resourceId,
      serverGeneration: 1,
      repositoryId: local.space.repositoryId,
      createMarker: local.space.operationMarker,
      localSpaceId: null,
      localGeneration: null,
    });
    const journal = new ControllerState(local.records);
    await journal.importBindings(owner);
    expect(await journal.binding(resourceId, owner)).toMatchObject({
      creationClosed: true,
      localSpaceId: null,
    });
    await expect(
      journal.forSpace({ ...local.space, phase: "creating" }, owner),
    ).rejects.toMatchObject({ code: "LOCAL_IDENTITY_CHANGED" });
  });
});
