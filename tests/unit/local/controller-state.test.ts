import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { ControllerState } from "../../../packages/local/src/controller-state.js";
import { createWorkspaceRequestId } from "../../../packages/shared/src/codespaces/workspace-request-id.js";
import { localFixture } from "../../integration/local/fixtures.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";

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
  test("routine pending and custody reads exclude terminal history while originals remain collectable and nonreplayable", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      journal = new ControllerState(records),
      owner = identity(),
      resourceId = randomUUID();
    const terminal = [];
    for (let i = 0; i < 12; i++) {
      const requestId = createWorkspaceRequestId(),
        input = { resourceId, action: "start", i };
      const result = await journal.run(requestId, owner, input, async () => ({ original: i }));
      terminal.push({
        requestId,
        input,
        result,
        bytes: await readFile(join(directory, `controller-operation-${requestId}.json`)),
      });
    }
    const unknown = createWorkspaceRequestId(),
      foreign = createWorkspaceRequestId();
    await journal.run(unknown, owner, { resourceId, action: "create" }, async () => {
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Original creation is unconfirmed.");
    });
    const foreignIdentity = { ...owner, userId: "foreign" };
    await journal.run(foreign, foreignIdentity, { resourceId, action: "create" }, async () => {
      throw new LocalRefusal("WORKSPACE_OUTCOME_UNKNOWN", "Foreign uncertainty.");
    });
    const original = await readFile(join(directory, `controller-operation-${unknown}.json`));
    await journal.pendingResources(owner);
    for (const entry of terminal)
      await writeFile(
        join(directory, `controller-operation-${entry.requestId}.json`),
        "not parsed by routine lookup",
      );
    try {
      const restarted = new ControllerState(records);
      expect((await restarted.pendingResources(owner)).get(resourceId)).toEqual([unknown]);
      expect((await restarted.pendingResources(foreignIdentity)).get(resourceId)).toEqual([
        foreign,
      ]);
      await expect(
        restarted.requireGitHubCustodySettled(resourceId, new Set()),
      ).resolves.toBeUndefined();
      expect(await readFile(join(directory, `controller-operation-${unknown}.json`))).toEqual(
        original,
      );
    } finally {
      for (const entry of terminal)
        await writeFile(
          join(directory, `controller-operation-${entry.requestId}.json`),
          entry.bytes,
        );
    }
    const restarted = new ControllerState(records);
    for (const entry of terminal) {
      expect(await restarted.inspect(entry.requestId, owner)).toEqual(entry.result);
      expect(
        await restarted.run(entry.requestId, owner, entry.input, async () => {
          throw new Error("Do not replay");
        }),
      ).toEqual(entry.result);
      await expect(
        restarted.run(entry.requestId, owner, { ...entry.input, i: -1 }, async () => ({})),
      ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
      expect(
        await readFile(join(directory, `controller-operation-${entry.requestId}.json`)),
      ).toEqual(entry.bytes);
    }
  });
  test("index membership is durable before effects and a failed terminal publication retains original uncertainty", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      journal = new ControllerState(records),
      owner = identity(),
      requestId = createWorkspaceRequestId(),
      resourceId = randomUUID();
    const write = state.write.bind(state);
    state.write = async (key, value) => {
      if (
        key === `controller-operation-${requestId}.json` &&
        value &&
        typeof value === "object" &&
        "state" in value &&
        value.state === "completed"
      )
        throw new Error("Controlled terminal fsync failure");
      return write(key, value);
    };
    let effects = 0;
    const result = await journal.run(requestId, owner, { resourceId, action: "stop" }, async () => {
      expect(await state.read("controller-active-operations.json", (value) => value)).toEqual({
        version: 1,
        requestIds: [requestId],
      });
      effects++;
      return { stopped: true };
    });
    expect(result.state).toBe("unconfirmed");
    const restarted = new ControllerState(records);
    expect((await restarted.pendingResources(owner)).get(resourceId)).toEqual([requestId]);
    expect(
      await restarted.run(requestId, owner, { resourceId, action: "stop" }, async () => {
        effects++;
      }),
    ).toMatchObject({ state: "unconfirmed" });
    expect(effects).toBe(1);
  });
  test("invalid index or missing indexed original fails closed before admitting another effect", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      owner = identity();
    const missing = createWorkspaceRequestId();
    await state.write("controller-active-operations.json", {
      version: 1,
      requestIds: [missing],
    });
    const journal = new ControllerState(records);
    await expect(journal.pendingResources(owner)).rejects.toBeDefined();
    await expect(journal.inspect(missing, owner)).rejects.toMatchObject({
      code: "LOCAL_STATE_UNSAFE",
    });
    let effects = 0;
    await expect(
      journal.run(createWorkspaceRequestId(), owner, { action: "start" }, async () => {
        effects++;
      }),
    ).rejects.toBeDefined();
    await state.write("controller-active-operations.json", { version: 9, requestIds: [] });
    await expect(new ControllerState(records).pendingResources(owner)).rejects.toBeDefined();
    expect(effects).toBe(0);
    expect(await state.keys("controller-operation-")).toEqual([]);
  });
  test("guarded initial inventory preserves legacy proof and foreign uncertainty without rewriting originals", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      owner = identity(),
      foreign = { ...owner, userId: "foreign" },
      resourceId = randomUUID(),
      terminalId = createWorkspaceRequestId(),
      unknownId = createWorkspaceRequestId(),
      foreignId = createWorkspaceRequestId();
    const original = {
      requestId: terminalId,
      identity: owner,
      resourceId,
      digest: "a".repeat(64),
      state: "completed",
      outcome: { ok: true, result: { original: true } },
      preparedCreate: {
        machine: {
          name: "basic",
          displayName: "Basic",
          operatingSystem: "linux",
          cpuCores: 2,
          memoryBytes: 1024,
          storageBytes: 4096,
        },
        idleTimeoutMinutes: 30,
        retentionMinutes: 1440,
      },
      enrollmentProof: {
        requestId: terminalId,
        resourceGeneration: 2,
        authorizationGeneration: 3,
        providerResourceName: "known-vm",
        repositoryId: "123",
        repositoryFullName: "owner/project",
        environmentIdentity: "b".repeat(64),
        root: "/workspaces/project",
        rootDevice: "1",
        rootInode: "2",
        release: "c".repeat(64),
      },
    };
    await state.write(`controller-operation-${terminalId}.json`, original);
    await state.write(`controller-operation-${unknownId}.json`, {
      requestId: unknownId,
      identity: owner,
      resourceId,
      digest: "b".repeat(64),
      state: "completed",
      outcome: {
        ok: false,
        error: { code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING", message: "Original custody remains." },
      },
    });
    await state.write(`controller-operation-${foreignId}.json`, {
      requestId: foreignId,
      identity: foreign,
      resourceId,
      digest: "c".repeat(64),
      state: "accepted",
    });
    const bytes = await Promise.all(
      [terminalId, unknownId, foreignId].map((id) =>
        readFile(join(directory, `controller-operation-${id}.json`)),
      ),
    );
    const journal = new ControllerState(records);
    await journal.importBindings(owner);
    expect(await state.read("controller-active-operations.json", (value) => value)).toEqual({
      version: 1,
      requestIds: [unknownId, foreignId].sort(),
    });
    expect((await journal.pendingResources(owner)).get(resourceId)).toEqual([unknownId]);
    expect((await journal.pendingResources(foreign)).get(resourceId)).toEqual([foreignId]);
    expect(await journal.inspect(terminalId, owner)).toMatchObject({
      state: "completed",
      outcome: original.outcome,
    });
    expect(
      await Promise.all(
        [terminalId, unknownId, foreignId].map((id) =>
          readFile(join(directory, `controller-operation-${id}.json`)),
        ),
      ),
    ).toEqual(bytes);
  });
  test("index publication failure prevents admission while failed retirement keeps a durable terminal original", async () => {
    const state = await PrivateState.open(directory),
      records = new LocalRecords(state),
      owner = identity(),
      requestId = createWorkspaceRequestId(),
      input = { action: "start", resourceId: randomUUID() },
      journal = new ControllerState(records),
      write = state.write.bind(state);
    await journal.pendingResources(owner);
    state.write = async (key, value) => {
      if (key === "controller-active-operations.json")
        throw new Error("Controlled index fsync failure");
      return write(key, value);
    };
    let effects = 0;
    await expect(
      journal.run(requestId, owner, input, async () => {
        effects++;
      }),
    ).rejects.toThrow("Controlled index fsync failure");
    expect(await state.keys("controller-operation-")).toEqual([]);
    state.write = async (key, value) => {
      if (
        key === "controller-active-operations.json" &&
        value &&
        typeof value === "object" &&
        "requestIds" in value &&
        Array.isArray(value.requestIds) &&
        value.requestIds.length === 0
      )
        throw new Error("Controlled retirement fsync failure");
      return write(key, value);
    };
    expect(
      await journal.run(requestId, owner, input, async () => {
        effects++;
        return { started: true };
      }),
    ).toMatchObject({ state: "unconfirmed" });
    const restarted = new ControllerState(records);
    const original = await restarted.inspect(requestId, owner);
    expect(original).toMatchObject({
      state: "completed",
      outcome: { ok: true, result: { started: true } },
    });
    expect(
      await restarted.run(requestId, owner, input, async () => {
        effects++;
      }),
    ).toEqual(original);
    expect(await state.read("controller-active-operations.json", (value) => value)).toEqual({
      version: 1,
      requestIds: [requestId],
    });
    expect((await restarted.pendingResources(owner)).size).toBe(0);
    expect(effects).toBe(1);
  });
  test("historical discovery skips records before its cursor without parsing their archived payload", async () => {
    const records = new LocalRecords(await PrivateState.open(directory)),
      owner = identity(),
      journal = new ControllerState(records),
      ids = [createWorkspaceRequestId(), createWorkspaceRequestId()].sort();
    for (const requestId of ids)
      await journal.run(requestId, owner, { action: "start" }, async () => ({ done: true }));
    const path = join(directory, `controller-operation-${ids[0]}.json`),
      bytes = await readFile(path);
    await writeFile(path, "archived payload must not be parsed before the cursor");
    try {
      expect((await journal.find(owner, { cursor: ids[0] })).operations).toEqual([
        expect.objectContaining({ requestId: ids[1], state: "completed" }),
      ]);
    } finally {
      await writeFile(path, bytes);
    }
  });
  test("discovery reads the safe original admission before its effect completes and retains it after completion", async () => {
    const local = await localFixture(await PrivateState.open(directory)),
      owner = { ...identity(), deviceId: local.policy.deviceId },
      journal = new ControllerState(local.records);
    const requestId = createWorkspaceRequestId();
    let entered!: () => void, finish!: () => void;
    const admitted = new Promise<void>((yes) => {
        entered = yes;
      }),
      held = new Promise<void>((yes) => {
        finish = yes;
      });
    let effects = 0;
    const work = journal.run(
      requestId,
      owner,
      {
        action: "create",
        repositoryId: local.policy.repositories[0].id,
        ref: "main",
        credential: "do-not-copy",
        script: "do-not-index",
      },
      async () => {
        const accepted = JSON.parse(
          await readFile(join(directory, `controller-operation-${requestId}.json`), "utf8"),
        );
        expect(accepted.descriptor).toMatchObject({
          kind: "lifecycle",
          description: "Workspace create owner/project at main",
        });
        expect(JSON.stringify(accepted)).not.toContain("do-not-");
        effects++;
        entered();
        await held;
        return { created: true };
      },
    );
    await admitted;
    try {
      const pending = await journal.find(owner, { query: "owner/project" });
      expect(pending.operations).toEqual([
        expect.objectContaining({ requestId, state: "accepted", kind: "lifecycle" }),
      ]);
      expect((await new ControllerState(local.records).find(owner, {})).operations).toEqual([
        expect.objectContaining({ requestId, state: "unconfirmed" }),
      ]);
      expect((await journal.find({ ...owner, userId: "foreign" }, {})).operations).toEqual([]);
    } finally {
      finish();
      await work;
    }
    const completed = await journal.find(owner, {});
    expect(completed.operations).toEqual([
      expect.objectContaining({
        requestId,
        state: "completed",
        descriptor: expect.objectContaining({
          description: "Workspace create owner/project at main",
        }),
      }),
    ]);
    expect(effects).toBe(1);
  });
  test("descriptor-less unknown receipts remain discoverable without rewriting or admitting them", async () => {
    const records = new LocalRecords(await PrivateState.open(directory)),
      owner = identity(),
      requestId = createWorkspaceRequestId();
    const key = `controller-operation-${requestId}.json`;
    await records.state.write(key, {
      requestId,
      digest: "a".repeat(64),
      identity: owner,
      state: "accepted",
    });
    const bytes = await readFile(join(directory, key));
    expect(
      (await new ControllerState(records).find(owner, { kind: "unknown" })).operations,
    ).toEqual([{ requestId, state: "unconfirmed", kind: "unknown" }]);
    expect(await readFile(join(directory, key))).toEqual(bytes);
  });
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
    await writeFile(join(directory, mappingKey), "archived legacy mapping is not reparsed");
    await journal.importBindings(owner);
    await writeFile(join(directory, mappingKey), original);
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
