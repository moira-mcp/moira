import { afterEach, beforeEach, describe, expect, test, jest } from "@jest/globals";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRelay, relayOrigin } from "../../../packages/local/src/relay.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalController } from "../../../packages/local/src/controller.js";
import { createWorkspaceRequestId } from "../../../packages/shared/src/codespaces/workspace-request-id.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { RuntimeDeviceOwner } from "../../../packages/local/src/runtime-device-owner.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { DeviceRuntimeControl } from "../../../packages/local/src/runtime-control.js";
import { publicPolicy, LocalRefusal } from "../../../packages/local/src/policy.js";
import { localFixture } from "./fixtures.js";
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ml-owner-boundary-")));
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const json = (data: unknown) => Response.json({ success: true, data });
async function fixture() {
  const state = await PrivateState.open(directory),
    local = await localFixture(state);
  return { ...local, state, manager: new LocalManager(local.records) };
}
describe("Native owner boundaries and device authority", () => {
  test.each([404, 503, "network"] as const)(
    "device authority distinguishes confirmed refusal from unavailability (%s)",
    async (failure) => {
      const local = await fixture();
      await local.state.write("connection.json", {
        origin: "https://moira.example",
        credential: randomBytes(32).toString("base64url"),
        deviceId: local.policy.deviceId,
        userId: "owner",
        deviceGeneration: 1,
        connectionId: randomUUID(),
        pairingId: randomUUID(),
      });
      const relay = new LocalRelay(local.records, async () => {
        if (failure === "network") throw new TypeError("Controlled transport loss");
        return new Response(null, { status: failure });
      });
      const outcome = await relay.confirmed().catch((error: unknown) => error);
      expect(outcome).toMatchObject({
        code: failure === 404 ? "LOCAL_RELAY_REFUSED" : "LOCAL_RELAY_UNAVAILABLE",
      });
      expect(relay.isUnavailable(outcome)).toBe(failure !== 404);
    },
  );
  test("legacy stopped record without first usability timestamp refuses work but retains exact cleanup", async () => {
    const local = await fixture();
    Object.assign(local.space, {
      generation: 2,
      desiredState: "stopped",
      phase: "stopped",
      failure: null,
      lastStartedAt: null,
    });
    await local.records.put(local.space);
    local.manager.dependencies.storage = async () => {};
    const protect = jest.fn(async () => {});
    const owner = new RuntimeOwner(local.records, local.space.id, protect, async () => {});
    await expect(owner.admit(true)).rejects.toMatchObject({ code: "LOCAL_SETUP_INCOMPLETE" });
    await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
      code: "LOCAL_SETUP_INCOMPLETE",
    });
    expect(protect).not.toHaveBeenCalled();
    expect(await local.records.get(local.space.id)).toMatchObject({
      generation: 2,
      desiredState: "stopped",
      phase: "stopped",
      lastStartedAt: null,
    });
  });
  test.each(["manager-read", "owner-ready"] as const)(
    "stop expected generation remains fenced at native admission after %s changes it",
    async (boundary) => {
      const local = await fixture();
      local.space.generation = 2;
      await local.records.put(local.space);
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {
          throw new Error("No stale native effect may reach custody");
        },
        async () => {},
      );
      const retire = jest.fn(async (_id: string, generation: number) =>
        owner.manage(generation, false),
      );
      const actualGet = local.records.get.bind(local.records);
      let reads = 0;
      jest.spyOn(local.records, "get").mockImplementation(async (id) => {
        if (boundary === "manager-read" && ++reads === 1) {
          const space = (await actualGet(id))!;
          space.generation = 3;
          await local.records.put(space);
        }
        return actualGet(id);
      });
      local.manager.dependencies.guard = async () => {
        if (boundary === "owner-ready") {
          const space = (await actualGet(local.space.id))!;
          space.generation = 3;
          await local.records.put(space);
        }
        return {
          active: true,
          stop: async () => {},
          observe: async () => [],
          remove: async () => {},
          retire,
          space: async () => {
            throw new Error("Stop must not admit guest work");
          },
        };
      };
      await expect(local.manager.stop(local.space.id, 2)).rejects.toMatchObject({
        code: "LOCAL_GENERATION_CONFLICT",
      });
      expect(await actualGet(local.space.id)).toMatchObject({
        generation: 3,
        desiredState: "running",
        phase: "usable",
      });
      if (boundary === "manager-read") expect(retire).not.toHaveBeenCalled();
      else expect(retire).toHaveBeenCalledWith(local.space.id, 2);
    },
  );
  test.each([null, "LOCAL_NETWORK_CHANGED"] as const)(
    "injected runtime closure preserves creating-origin readiness and failure (%s)",
    async (failure) => {
      const local = await fixture();
      Object.assign(local.space, { phase: "creating", lastStartedAt: null, failure });
      await local.records.put(local.space);
      class ClosedRuntime extends SbxRuntime {
        override async stop() {}
        override async exact(identity: { name: string; runtimeId: string }) {
          return {
            id: identity.runtimeId,
            name: identity.name,
            agent: "shell",
            status: "stopped" as const,
          };
        }
      }
      local.manager.dependencies.runtime = (policy) => adaptSbxRuntime(new ClosedRuntime(policy));
      expect(await local.manager.stop(local.space.id)).toMatchObject({
        phase: "failed",
        desiredState: "stopped",
        generation: 2,
        failure: failure ?? "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
        code: "LOCAL_SETUP_INCOMPLETE",
      });
    },
  );
  test.each([null, "LOCAL_NETWORK_CHANGED"] as const)(
    "creating-origin confirmed stop preserves incomplete guest readiness and original failure (%s)",
    async (failure) => {
      const local = await fixture();
      Object.assign(local.space, { phase: "creating", lastStartedAt: null, failure });
      await local.records.put(local.space);
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      await owner.admit();
      await owner.quiesce();
      // This isolated boundary substitutes physical completion, not bootstrap readiness.
      await owner.confirmStopped();
      const stopped = (await local.records.get(local.space.id))!;
      expect(stopped).toMatchObject({
        desiredState: "stopped",
        phase: "failed",
        generation: 2,
        lastStartedAt: null,
        failure: failure ?? "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
        code: "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(
        new RuntimeOwner(
          local.records,
          local.space.id,
          async () => {},
          async () => {},
        ).admit(true),
      ).rejects.toMatchObject({ code: "LOCAL_SETUP_INCOMPLETE" });
      expect(stopped.recoveryGeneration).toBeUndefined();
    },
  );
  test("held peer Engine metadata does not serialize healthy protection or scoped observation", async () => {
    const local = await fixture();
    local.space.runtimeId = randomUUID();
    await local.records.put(local.space);
    const peer = {
      ...local.space,
      id: randomUUID(),
      name: `moira-${randomUUID().replaceAll("-", "")}`,
      runtimeId: randomUUID(),
    };
    await local.records.put(peer);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    const native = jest
      .spyOn(DeviceRuntimeControl.prototype, "protect")
      .mockResolvedValue(undefined);
    jest.spyOn(DeviceRuntimeControl.prototype, "assertDockerHeld").mockResolvedValue(undefined);
    jest.spyOn(DeviceRuntimeControl.prototype, "holdsWorker").mockReturnValue(true);
    jest.spyOn(DeviceRuntimeControl.prototype, "hasUnindexedWorkers").mockReturnValue(false);
    jest.spyOn(SbxRuntime.prototype, "list").mockResolvedValue([
      { id: local.space.runtimeId!, name: local.space.name, status: "running", agent: "shell" },
      { id: peer.runtimeId!, name: peer.name, status: "running", agent: "shell" },
    ]);
    jest.spyOn(SbxRuntime.prototype, "verifySettings").mockResolvedValue(undefined);
    jest.spyOn(SbxRuntime.prototype, "verifyGlobalNetworkPolicy").mockResolvedValue(undefined);
    jest.spyOn(SbxRuntime.prototype, "containerIdentity").mockImplementation(async (name) => {
      if (name === peer.name) {
        entered();
        await held;
      }
      return {
        name,
        containerId: createHash("sha256").update(name).digest("hex"),
        state: "running",
      };
    });
    const owner = new RuntimeDeviceOwner(local.records, local.policy);
    const bad = owner.observe(peer.id);
    try {
      await Promise.race([
        waiting,
        bad.then(() => {
          throw new Error("Peer observation unexpectedly completed before barrier");
        }),
      ]);
      await owner.protect(local.space.id);
      const healthy = await owner.observe(local.space.id);
      expect(healthy).toEqual([
        { id: local.space.runtimeId, name: local.space.name, status: "running" },
      ]);
      expect(native).toHaveBeenCalled();
    } finally {
      release();
      await bad;
    }
  });
  test("an admitted native create does not block another VM's work or the short repository-policy append", async () => {
    const local = await fixture();
    let entered!: () => void, cancel!: () => void;
    const preparing = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      cancel = done;
    });
    let creatingId = "";
    const manager = new LocalManager(local.records, {
      storage: async () => {},
      brokerPorts: { http: 0, tunnel: 0 },
      guard: async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        remove: async () => {},
        retire: async (id, generation) => {
          const space = await local.records.get(id);
          await local.records.put({
            ...space!,
            generation: generation + 1,
            desiredState: "stopped",
            phase: "stopped",
          });
          cancel();
        },
        space: async (id) => ({
          active: true,
          validate: async () => {},
          stop: async () => {},
          prepare: async () => {
            creatingId = id;
            entered();
            await held;
            throw new LocalRefusal("LOCAL_CANCELLED", "Own creation interrupted");
          },
        }),
      }),
    });
    await manager.open();
    const create = manager
      .create(local.space.repositoryId, "main", `moira-${"d".repeat(24)}`)
      .catch((error: unknown) => error);
    try {
      await preparing;
      expect((await manager.snapshot(local.space.id)).spaces).toHaveLength(1);
      const next = {
        ...local.policy,
        repositories: [
          ...local.policy.repositories,
          { ...local.policy.repositories[0], id: randomUUID(), fullName: "owner/another" },
        ],
      };
      await manager.applyLivePolicy(local.policy, next);
      expect((await local.records.policy()).repositories).toEqual(next.repositories);
      expect(await manager.stop(creatingId)).toMatchObject({
        desiredState: "stopped",
        phase: "stopped",
      });
      expect(await create).toMatchObject({ code: "LOCAL_CANCELLED" });
      expect(await local.records.get(local.space.id)).toMatchObject({
        desiredState: "running",
        generation: 1,
      });
    } finally {
      cancel();
      await create;
      await manager.close();
    }
  });
  test("controller stop retires an admitted native start before held preparation finishes; late completion cannot overwrite newer CAS", async () => {
    const local = await fixture();
    local.space.phase = "stopped";
    local.space.desiredState = "stopped";
    await local.records.put(local.space);
    const identity = {
      userId: "owner",
      deviceId: local.policy.deviceId,
      deviceGeneration: 1,
      connectionId: randomUUID(),
    };
    await local.state.write("connection.json", { ...identity, origin: "https://moira.example" });
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retire = jest.fn(async (id: string, generation: number) => {
      const space = (await local.records.get(id))!;
      if (space.generation !== generation)
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Native retirement must address its exact admitted generation.",
        );
      await local.records.put({
        ...space,
        generation: generation + 1,
        desiredState: "stopped",
        phase: "stopped",
      });
    });
    const manager = new LocalManager(local.records, {
      storage: async () => {},
      brokerPorts: { http: 0, tunnel: 0 },
      guard: async () => ({
        active: true,
        stop: async () => {},
        remove: async () => {},
        retire,
        observe: async () =>
          (await local.records.list()).map((space) => ({
            id: space.runtimeId!,
            name: space.name,
            status: space.desiredState === "running" ? "running" : "stopped",
          })),
        space: async (id) => {
          const space = (await local.records.get(id))!;
          await local.records.put({
            ...space,
            generation: space.generation + 1,
            desiredState: "running",
            phase: "usable",
          });
          return {
            active: true,
            validate: async () => {},
            stop: async () => {},
            prepare: async () => {
              entered();
              await held;
            },
          };
        },
      }),
    });
    await manager.open();
    const controller = new LocalController(manager, identity),
      resourceId = randomUUID();
    await controller.initialize();
    await controller.state.putBinding({
      ...identity,
      resourceId,
      repositoryId: local.space.repositoryId,
      resourceGeneration: 3,
      routeGeneration: 3,
      operationMarker: local.space.operationMarker,
      localSpaceId: local.space.id,
      localGeneration: 1,
      creationClosed: false,
    });
    const startId = createWorkspaceRequestId();
    const start = controller.lifecycle(
      resourceId,
      { requestId: startId, expectedGeneration: 3, action: "start" },
      true,
    );
    try {
      await preparing;
      expect(await controller.state.binding(resourceId, identity)).toMatchObject({
        resourceGeneration: 4,
        localGeneration: 2,
      });
      const stopped = await controller.lifecycle(
        resourceId,
        { requestId: createWorkspaceRequestId(), expectedGeneration: 4, action: "stop" },
        true,
      );
      expect(stopped).toMatchObject({
        outcome: {
          ok: true,
          result: { resourceGeneration: 5, spaces: [{ desiredState: "stopped" }] },
        },
      });
      expect(retire).toHaveBeenCalledWith(local.space.id, 2);
      expect(await controller.state.inspect(startId, identity)).toMatchObject({
        state: "accepted",
      });
      const binding = await controller.state.binding(resourceId, identity);
      expect(binding).toMatchObject({
        resourceGeneration: 5,
        routeGeneration: 3,
        localGeneration: 3,
      });
      release();
      const original = await start;
      expect(original).toMatchObject({
        outcome: { ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } },
      });
      expect(await controller.state.binding(resourceId, identity)).toEqual(binding);
      expect(await controller.state.inspect(startId, identity)).toEqual(original);
      expect(
        await controller.lifecycle(
          resourceId,
          { requestId: startId, expectedGeneration: 3, action: "start" },
          true,
        ),
      ).toEqual(original);
    } finally {
      release();
      await start;
      await controller.state.drain();
      await manager.close();
    }
  });
  test.each(["absent", "occupied", "inventory-error"] as const)(
    "pending manifest deletion handles %s without name adoption or effects on peers",
    async (observation) => {
      const local = await fixture();
      Object.assign(local.space, { runtimeId: null, phase: "creating", networkPolicy: null });
      await local.records.put(local.space);
      local.policy.repositories[0].allowDelete = true;
      await local.state.write("policy.json", local.policy);
      const peer = {
        id: randomUUID(),
        name: `moira-${"e".repeat(32)}`,
        status: "running" as const,
        agent: "shell" as const,
        workspaces: [],
        ports: [],
      };
      const inventory =
        observation === "occupied"
          ? [peer, { ...peer, id: randomUUID(), name: local.space.name }]
          : [peer];
      jest.spyOn(SbxRuntime.prototype, "list").mockImplementation(async () => {
        if (observation === "inventory-error")
          throw new LocalRefusal("LOCAL_COMMAND_TIMEOUT", "Controlled inventory failure");
        return inventory;
      });
      jest.spyOn(SbxRuntime.prototype, "stop").mockImplementation(async () => {
        throw new Error("No UUID: never stop by name");
      });
      jest.spyOn(SbxRuntime.prototype, "remove").mockImplementation(async () => {
        throw new Error("No UUID: never delete by name");
      });
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      if (observation === "absent") {
        await owner.manage(1, true);
        const deleted = await local.records.get(local.space.id);
        expect(deleted).toMatchObject({
          runtimeId: null,
          desiredState: "deleted",
          phase: "deleted",
        });
        await owner.manage(deleted!.generation, true);
        expect(await local.records.get(local.space.id)).toEqual(deleted);
      } else {
        await expect(owner.manage(1, true)).rejects.toMatchObject({
          code: observation === "occupied" ? "LOCAL_CREATE_UNKNOWN" : "LOCAL_COMMAND_TIMEOUT",
        });
        expect(await local.records.get(local.space.id)).toMatchObject({
          runtimeId: null,
          phase: "failed",
        });
      }
      expect(inventory[0]).toEqual(peer);
    },
  );
  test.each(["running", "stopped", "changed-network"])(
    "an active guard verifies the actual VM before accepting a %s start",
    async (state) => {
      const local = await fixture();
      let preparations = 0;
      local.manager.dependencies.storage = async () => {};
      local.manager.dependencies.brokerPorts = { http: 0, tunnel: 0 };
      const guard = {
        active: true,
        prepare: async () => {
          preparations++;
        },
        validate: async () => {
          if (state !== "running")
            throw new LocalRefusal(
              state === "stopped" ? "LOCAL_NOT_RUNNING" : "LOCAL_NETWORK_CHANGED",
              "Controlled observation",
            );
        },
        stop: async () => {},
      };
      local.manager.dependencies.guard = async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async () => guard,
      });
      await local.manager.open();
      try {
        await local.manager.start(local.space.id);
        if (state === "changed-network")
          await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
            code: "LOCAL_NETWORK_CHANGED",
          });
        else
          await expect(local.manager.start(local.space.id)).resolves.toMatchObject({
            runtimeId: local.space.runtimeId,
          });
        expect(preparations).toBe(state === "changed-network" ? 1 : 2);
      } finally {
        await local.manager.close();
      }
    },
  );
  test("an unsupported production worker platform refuses before any SDK home or VM startup", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const owner = new RuntimeDeviceOwner(local.records, local.policy);
      await expect(owner.open()).rejects.toMatchObject({
        code: "LOCAL_RUNTIME_WORKER_UNSUPPORTED",
      });
      await owner.stop();
      await expect(stat(owner.runtime.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await local.records.get(local.space.id)).toEqual(local.space);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
  test("refuses credentials, query strings and non-HTTPS origins before transport", () => {
    for (const url of [
      "http://moira.example",
      "https://token@moira.example",
      "https://moira.example?token=x",
    ])
      expect(() => relayOrigin(url)).toThrow();
    expect(relayOrigin("https://moira.example/prefix/")).toBe("https://moira.example/prefix");
  });
  test("a lost enrollment response reuses the private credential and never sends local host paths", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    const requests: Array<Record<string, unknown>> = [];
    const relay = new LocalRelay(local.records, async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      if (requests.length === 1) throw new Error("Controlled lost enrollment response");
      return json({
        deviceId: local.policy.deviceId,
        userId: "fixture-owner",
        deviceGeneration: 1,
        connectionId: randomUUID(),
        status: "pending",
        policy: publicPolicy(local.policy),
      });
    });
    const pairing = randomUUID();
    const pairingToken = randomBytes(32).toString("base64url");
    await expect(relay.enroll("https://moira.example", pairing, pairingToken)).rejects.toThrow(
      "Device authority service is unavailable.",
    );
    await expect(
      relay.enroll("https://moira.example", pairing, pairingToken),
    ).resolves.toMatchObject({ status: "pending" });
    expect(requests[0].credential).toBe(requests[1].credential);
    expect(JSON.stringify(requests)).not.toContain(local.policy.runtime.binary);
    expect(JSON.stringify(requests)).not.toContain(local.policy.runtime.storageRoot);
    expect((await stat(join(directory, "connection.json"))).mode & 0o077).toBe(0);
  });
  test("read-only snapshot never adopts an SDK UUID by the name of a pending creation manifest", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    local.space.runtimeId = null;
    local.space.phase = "creating";
    await local.records.put(local.space);
    class ExternalInventory extends SbxRuntime {
      override async list() {
        return [
          {
            id: randomUUID(),
            name: local.space.name,
            agent: "shell" as const,
            status: "running" as const,
            workspaces: [],
            ports: [],
          },
        ];
      }
    }
    const manager = new LocalManager(local.records, {
      runtime: (policy) => adaptSbxRuntime(new ExternalInventory(policy)),
    });
    expect((await manager.snapshot()).spaces).toEqual([
      expect.objectContaining({
        id: local.space.id,
        state: "unknown",
        phase: "creating",
        nativeStopConfirmed: false,
      }),
    ]);
    expect((await local.records.get(local.space.id))?.runtimeId).toBeNull();
    await expect(
      manager.create(local.space.repositoryId, "different-ref", local.space.operationMarker),
    ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
  });
});
