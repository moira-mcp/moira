import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import {
  LocalController,
  startLocalController,
  controllerRequest,
} from "../../../packages/local/src/controller.js";
import { LocalWebControl, controlSettings } from "../../../packages/local/src/web-control.js";
import { GiB, LocalRefusal, publicPolicy } from "../../../packages/local/src/policy.js";
import { policyForSpace } from "../../../packages/local/src/space-record.js";
import type { ControllerResourceRegistration } from "../../../packages/shared/src/codespaces/local-controller-protocol.js";
import { createWorkspaceRequestId } from "../../../packages/shared/src/codespaces/workspace-request-id.js";
import { localFixture } from "../../integration/local/fixtures.js";

let directory: string;
const endpoints: Array<Awaited<ReturnType<typeof startLocalController>>> = [];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "moira-controller-http-")));
});
afterEach(async () => {
  await Promise.all(endpoints.splice(0).map((endpoint) => endpoint.close()));
  await rm(directory, { recursive: true, force: true });
});
async function fixture(
  registrar?: (input: ControllerResourceRegistration) => Promise<void>,
  effects?: ConstructorParameters<typeof LocalWebControl>[1],
) {
  const state = await PrivateState.open(directory),
    local = await localFixture(state);
  const identity = {
    userId: "owner",
    deviceId: local.policy.deviceId,
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  await state.write("connection.json", { ...identity, origin: "https://moira.example" });
  const manager = new LocalManager(local.records);
  manager.holdRunnerLock = async () => undefined;
  manager.snapshot = async (spaceId?: string) => {
    const policy = await local.records.policy();
    return {
      ...publicPolicy(policy),
      spaces: (await local.records.list())
        .filter((space) => !spaceId || space.id === spaceId)
        .map((space) => ({
          id: space.id,
          name: space.name,
          repositoryId: space.repositoryId,
          operationMarker: space.operationMarker,
          createdAt: space.createdAt,
          lastStartedAt: space.lastStartedAt,
          generation: space.generation,
          desiredState: space.desiredState,
          machine: publicPolicy(policyForSpace(policy, space)).machine,
          state: space.desiredState === "running" ? ("running" as const) : ("stopped" as const),
          nativeStopConfirmed: space.desiredState === "stopped",
          phase: space.phase,
          failure: space.failure,
        })),
    };
  };
  manager.stopWork = async () => {
    for (const space of await local.records.list()) {
      space.desiredState = "stopped";
      space.phase = "stopped";
      await local.records.put(space);
    }
  };
  manager.stop = async (id) => {
    const space = await local.records.get(id);
    space!.desiredState = "stopped";
    space!.phase = "stopped";
    space!.generation++;
    await local.records.put(space!);
    return space!;
  };
  const control = new LocalWebControl(local.records, {
    replacePolicy: async (records, next) => {
      await records.state.write("policy.json", next);
    },
    ...effects,
  });
  const controller = new LocalController(manager, identity, control, registrar);
  const resourceId = randomUUID();
  await controller.state.putBinding({
    ...identity,
    resourceId,
    resourceGeneration: 3,
    repositoryId: local.space.repositoryId,
    operationMarker: local.space.operationMarker,
    localSpaceId: local.space.id,
    localGeneration: local.space.generation,
    creationClosed: false,
  });
  const endpoint = await startLocalController(controller);
  endpoints.push(endpoint);
  return { ...local, state, manager, controller, endpoint, identity, resourceId, control };
}
async function localSnapshot(controller: LocalController) {
  const snapshot = await controller.snapshot();
  if (snapshot.local.state !== "configured")
    throw new Error("Fixture Local capability is unavailable");
  return snapshot.local;
}

describe("One owner HTTP surface for local and remote control", () => {
  test("host-owner create registers its original route before the native effect and repeats only its receipt", async () => {
    const registrations: ControllerResourceRegistration[] = [];
    const f = await fixture(async (input) => {
      registrations.push(input);
    });
    const resourceId = randomUUID(),
      requestId = createWorkspaceRequestId(),
      marker = `moira-${"c".repeat(24)}`;
    let effects = 0;
    f.manager.open = async () => {
      expect(registrations).toHaveLength(1);
    };
    f.manager.create = async (repositoryId, ref, operationMarker) => {
      effects++;
      expect(registrations[0]).toEqual({
        resourceId,
        repositoryId,
        resourceGeneration: 1,
        operationMarker,
        ref,
      });
      const id = randomUUID(),
        space = {
          ...f.space,
          id,
          name: `moira-${id.replaceAll("-", "")}`,
          runtimeId: `new-${id}`,
          repositoryId,
          ref,
          operationMarker,
        };
      await f.records.put(space);
      return space;
    };
    const body = {
      requestId,
      expectedGeneration: 1,
      action: "create",
      repositoryId: f.space.repositoryId,
      ref: "main",
      operationMarker: marker,
    };
    const result = await controllerRequest(
      f.endpoint.socketPath,
      "POST",
      `/v1/resources/${resourceId}/lifecycle`,
      body,
    );
    expect(result).toMatchObject({ requestId, state: "completed", outcome: { ok: true } });
    expect(
      await controllerRequest(
        f.endpoint.socketPath,
        "POST",
        `/v1/resources/${resourceId}/lifecycle`,
        body,
      ),
    ).toEqual(result);
    expect(effects).toBe(1);
    expect(registrations).toHaveLength(1);
  });
  test("a confirmed route-registration refusal cannot become local-only native creation", async () => {
    const f = await fixture(async () => {
      throw new LocalRefusal("LOCAL_RELAY_REFUSED", "Confirmed registration refusal");
    });
    f.manager.open = async () => {
      throw new Error("Native owner must not open after refusal");
    };
    const resourceId = randomUUID(),
      requestId = createWorkspaceRequestId();
    const result = await controllerRequest(
      f.endpoint.socketPath,
      "POST",
      `/v1/resources/${resourceId}/lifecycle`,
      {
        requestId,
        expectedGeneration: 1,
        action: "create",
        repositoryId: f.space.repositoryId,
        ref: "main",
        operationMarker: `moira-${"d".repeat(24)}`,
      },
    );
    expect(result).toMatchObject({
      state: "completed",
      outcome: { ok: false, error: { code: "LOCAL_RELAY_REFUSED" } },
    });
    expect(await f.records.list()).toHaveLength(1);
    expect(await f.controller.state.binding(resourceId, f.identity)).toMatchObject({
      localSpaceId: null,
      creationClosed: true,
    });
  });
  test("starting another endpoint with the same runner does not unlink its live owner", async () => {
    const f = await fixture();
    await expect(startLocalController(f.controller)).rejects.toMatchObject({
      code: "LOCAL_CONTROLLER_RUNNING",
    });
    expect(
      await controllerRequest(f.endpoint.socketPath, "GET", "/v1/controller/health"),
    ).toMatchObject({ connectionId: f.identity.connectionId });
  });
  test("a mismatched authenticated device cannot observe or admit an owner mutation", async () => {
    const f = await fixture();
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const call = request(
        {
          socketPath: f.endpoint.socketPath,
          method: "GET",
          path: "/v1/controller",
          headers: {
            "x-moira-user-id": f.identity.userId,
            "x-moira-device-id": randomUUID(),
            "x-moira-device-generation": "1",
            "x-moira-connection-id": f.identity.connectionId,
          },
        },
        (reply) => {
          let body = "";
          reply.on("data", (bytes) => {
            body += String(bytes);
          });
          reply.once("end", () => resolve({ status: reply.statusCode!, body }));
        },
      );
      call.once("error", reject);
      call.end();
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "LOCAL_UNAUTHORIZED" } });
    expect(await f.state.keys("controller-operation-")).toEqual([]);
    expect((await f.records.get(f.space.id))?.desiredState).toBe("running");
  });
  test("owner IPC stop and remote-style collection address the same original native space and preserve its data identity", async () => {
    const f = await fixture(),
      requestId = createWorkspaceRequestId();
    const result = await controllerRequest(
      f.endpoint.socketPath,
      "POST",
      `/v1/resources/${f.resourceId}/lifecycle`,
      { requestId, expectedGeneration: 3, action: "stop" },
    );
    expect(result).toMatchObject({ requestId, state: "completed", outcome: { ok: true } });
    expect(
      await controllerRequest(
        f.endpoint.socketPath,
        "GET",
        `/v1/controller/operations/${requestId}`,
      ),
    ).toEqual(result);
    expect(
      (await localSnapshot(f.controller)).resources.find(
        (resource) => resource.resourceId === f.resourceId,
      )?.pendingRequestIds,
    ).toEqual([]);
    expect(await f.records.get(f.space.id)).toMatchObject({
      id: f.space.id,
      runtimeId: f.space.runtimeId,
      brokerToken: f.space.brokerToken,
      repositoryId: f.space.repositoryId,
      desiredState: "stopped",
      generation: 2,
    });
    expect(await f.state.keys("lifecycle-request-")).toEqual([]);
  });
  test("an interleaved stale start/delete cannot cross a consumed owner CAS, while fresh snapshot generation succeeds", async () => {
    const f = await fixture(),
      stopId = createWorkspaceRequestId();
    let entered!: () => void, finish!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const stop = f.manager.stop.bind(f.manager);
    f.manager.stop = async (...args) => {
      entered();
      await held;
      return stop(...args);
    };
    const stopping = f.controller.lifecycle(
      f.resourceId,
      { requestId: stopId, expectedGeneration: 3, action: "stop" },
      true,
    );
    await admitted;
    expect(
      (await localSnapshot(f.controller)).resources.find(
        (resource) => resource.resourceId === f.resourceId,
      )?.resourceGeneration,
    ).toBe(4);
    const staleStart = f.controller.lifecycle(
      f.resourceId,
      { requestId: createWorkspaceRequestId(), expectedGeneration: 3, action: "start" },
      true,
    );
    const staleDelete = f.controller.lifecycle(
      f.resourceId,
      {
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 3,
        action: "delete",
        ownerConfirmed: true,
      },
      true,
    );
    finish();
    const original = await stopping;
    expect(await staleStart).toMatchObject({
      outcome: { ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } },
    });
    expect(await staleDelete).toMatchObject({
      outcome: { ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } },
    });
    const fresh = (await localSnapshot(f.controller)).resources.find(
      (resource) => resource.resourceId === f.resourceId,
    )!;
    f.manager.open = async () => undefined;
    f.manager.start = async (id) => {
      const space = (await f.records.get(id))!;
      space.generation++;
      space.phase = "usable";
      space.desiredState = "running";
      await f.records.put(space);
      return space;
    };
    expect(
      await f.controller.lifecycle(
        f.resourceId,
        {
          requestId: createWorkspaceRequestId(),
          expectedGeneration: fresh.resourceGeneration,
          action: "start",
        },
        true,
      ),
    ).toMatchObject({ outcome: { ok: true, result: { resourceGeneration: 5 } } });
    expect(await f.controller.state.inspect(stopId, f.identity)).toEqual(original);
    expect(await f.controller.state.binding(f.resourceId, f.identity)).toMatchObject({
      resourceGeneration: 5,
      routeGeneration: 3,
    });
  });
  test("owner settings CAS applies once; a stale revision refuses without changing applied policy", async () => {
    const f = await fixture();
    await f.control.optIn(
      { ...f.identity, origin: "https://moira.example" },
      {
        cpuCores: 4,
        memoryBytes: 8 * GiB,
        storageBytes: 64 * GiB,
        dockerBytes: 8 * GiB,
      },
      true,
    );
    const requestId = createWorkspaceRequestId(),
      settings = { ...controlSettings(f.policy), label: "Owner applies here" };
    const result = await controllerRequest(
      f.endpoint.socketPath,
      "PUT",
      "/v1/controller/settings",
      {
        requestId,
        expectedGeneration: 1,
        expectedRevision: 0,
        settings,
      },
    );
    expect(result).toMatchObject({
      requestId,
      state: "completed",
      outcome: {
        ok: true,
        result: {
          local: {
            control: { revision: 1, appliedRevision: 1, settings: { label: settings.label } },
          },
        },
      },
    });
    const before = await f.records.policy();
    expect((await f.records.get(f.space.id))?.desiredState).toBe("running");
    const refused = await controllerRequest(
      f.endpoint.socketPath,
      "PUT",
      "/v1/controller/settings",
      {
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 1,
        expectedRevision: 0,
        settings: { ...settings, label: "Stale" },
      },
    );
    expect(refused).toMatchObject({
      state: "completed",
      outcome: { ok: false, error: { code: "LOCAL_CONTROL_CONFLICT" } },
    });
    expect(await f.records.policy()).toEqual(before);
    expect(await f.state.keys("controller-settings-current")).toEqual([
      "controller-settings-current.json",
    ]);
    expect((await localSnapshot(f.controller)).control).not.toHaveProperty("pendingRequestId");
  });
  test("a result publication failure after native stop returns the original uncertain identity and never repeats its effect", async () => {
    const f = await fixture(),
      requestId = createWorkspaceRequestId();
    const write = f.state.write.bind(f.state);
    f.state.write = async (key, value) => {
      if (
        key === `controller-operation-${requestId}.json` &&
        (value as { state?: string }).state === "completed"
      )
        throw new Error("Injected result fsync failure");
      return write(key, value);
    };
    const body = { requestId, expectedGeneration: 3, action: "stop" };
    expect(
      await controllerRequest(
        f.endpoint.socketPath,
        "POST",
        `/v1/resources/${f.resourceId}/lifecycle`,
        body,
      ),
    ).toEqual({ requestId, state: "unconfirmed" });
    expect((await f.records.get(f.space.id))?.generation).toBe(2);
    expect(
      (await localSnapshot(f.controller)).resources.find(
        (resource) => resource.resourceId === f.resourceId,
      )?.pendingRequestIds,
    ).toEqual([requestId]);
    expect(
      await controllerRequest(
        f.endpoint.socketPath,
        "GET",
        `/v1/controller/operations/${requestId}`,
      ),
    ).toEqual({ requestId, state: "unconfirmed" });
    expect(
      await controllerRequest(
        f.endpoint.socketPath,
        "POST",
        `/v1/resources/${f.resourceId}/lifecycle`,
        body,
      ),
    ).toEqual({ requestId, state: "unconfirmed" });
    expect((await f.records.get(f.space.id))?.generation).toBe(2);
    await f.state.remove(`controller-resource-${f.resourceId}.json`);
    expect((await localSnapshot(f.controller)).pendingResourceOperations).toEqual([
      { resourceId: f.resourceId, requestIds: [requestId] },
    ]);
  });
  test("known settings rejection consumes a revision, corrected settings apply at the next revision, and uncertain physical intent still blocks", async () => {
    let uncertain = false;
    const f = await fixture(undefined, {
      replacePolicy: async (records, next) => {
        if (uncertain)
          throw new LocalRefusal(
            "LOCAL_STORAGE_UNSAFE",
            "Physical policy transition did not settle",
          );
        await records.state.write("policy.json", next);
      },
      resize: async () => undefined,
    });
    await f.control.optIn(
      { ...f.identity, origin: "https://moira.example" },
      {
        cpuCores: 4,
        memoryBytes: 8 * GiB,
        storageBytes: 64 * GiB,
        dockerBytes: 8 * GiB,
      },
      true,
    );
    const send = (expectedRevision: number, settings: ReturnType<typeof controlSettings>) =>
      controllerRequest(f.endpoint.socketPath, "PUT", "/v1/controller/settings", {
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 1,
        expectedRevision,
        settings,
      });
    const settings = controlSettings(f.policy);
    expect(await send(0, { ...settings, cpuCores: 5 })).toMatchObject({ outcome: { ok: false } });
    expect((await localSnapshot(f.controller)).control).toMatchObject({
      revision: 1,
      appliedRevision: 0,
      status: "rejected",
    });
    expect(await f.state.read("control-intent.json", (value) => value)).toBeNull();
    expect(await send(1, { ...settings, label: "Corrected", cpuCores: 4 })).toMatchObject({
      outcome: { ok: true, result: { local: { control: { revision: 2, appliedRevision: 2 } } } },
    });
    uncertain = true;
    const applied = controlSettings(await f.records.policy());
    expect(await send(2, { ...applied, storageBytes: 48 * GiB })).toMatchObject({
      outcome: { ok: false, error: { code: "LOCAL_STORAGE_UNSAFE" } },
    });
    const intent = await f.state.read("control-intent.json", (value) => value);
    expect(intent).not.toBeNull();
    expect((await localSnapshot(f.controller)).control).toMatchObject({
      revision: 3,
      appliedRevision: 2,
    });
    expect(await send(3, { ...applied, label: "Cannot bypass uncertainty" })).toMatchObject({
      outcome: { ok: false, error: { code: "LOCAL_CONTROL_PENDING" } },
    });
    expect(await f.state.read("control-intent.json", (value) => value)).toEqual(intent);
    expect((await localSnapshot(f.controller)).control).toMatchObject({
      revision: 3,
      appliedRevision: 2,
    });
  });
});
