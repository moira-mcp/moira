import { LocalManager } from "../../packages/local/src/manager.js";
import { PrivateState } from "../../packages/local/src/private-state.js";
import { LocalController, startLocalController } from "../../packages/local/src/controller.js";
import { LocalWebControl } from "../../packages/local/src/web-control.js";
import { policyForSpace } from "../../packages/local/src/space-record.js";
import { requireLocalGrant, GiB, publicPolicy } from "../../packages/local/src/policy.js";
import type { ControllerIdentity } from "../../packages/shared/src/codespaces/local-controller-protocol.js";
import { createWorkspaceClient } from "../../packages/web-backend/src/services/workspace-client.js";
import { jsonResponse } from "../../packages/web-backend/src/services/workspace-router.js";
import { localFixture } from "../integration/local/fixtures.js";
import { randomUUID } from "node:crypto";

/** Actual owner records/settings/journal/HTTP; only physical VM operations are controlled. */
export async function controllerFixture(directory: string, identity: ControllerIdentity) {
  const state = await PrivateState.open(directory),
    local = await localFixture(state);
  local.policy.deviceId = identity.deviceId;
  await state.write("policy.json", local.policy);
  await state.write("connection.json", { ...identity, origin: "https://moira.example" });
  const manager = new LocalManager(local.records);
  manager.open = async () => undefined;
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
          machine: publicPolicy(policyForSpace(policy, space)).machine,
          createdAt: space.createdAt,
          lastStartedAt: space.lastStartedAt,
          generation: space.generation,
          phase: space.phase,
          failure: space.failure,
          ...(space.remote ? { remote: space.remote } : {}),
          ...(space.setupFailure ? { setupFailure: space.setupFailure } : {}),
          desiredState: space.desiredState,
          state:
            space.phase === "deleted"
              ? "absent"
              : space.desiredState === "running"
                ? "running"
                : "stopped",
          nativeStopConfirmed: space.desiredState === "stopped" || space.phase === "deleted",
        })),
    } as Awaited<ReturnType<LocalManager["snapshot"]>>;
  };
  manager.stop = async (id) => {
    const space = await local.records.get(id);
    if (!space) throw new Error("Controlled native space is absent");
    space.desiredState = "stopped";
    space.phase = "stopped";
    space.generation++;
    await local.records.put(space);
    return space;
  };
  manager.stopWork = async () => {
    for (const space of await local.records.list())
      if (space.phase !== "deleted" && space.desiredState === "running")
        await manager.stop(space.id);
  };
  manager.start = async (id, onAdmitted) => {
    const space = await local.records.get(id);
    if (!space) throw new Error("Controlled native space is absent");
    requireLocalGrant(await local.records.policy(), space.repositoryId);
    space.desiredState = "running";
    space.phase = "stopped";
    space.generation++;
    await local.records.put(space);
    await onAdmitted?.();
    space.phase = "usable";
    space.lastStartedAt = Date.now();
    await local.records.put(space);
    return space;
  };
  manager.remove = async (id) => {
    const space = await local.records.get(id);
    if (!space) throw new Error("Controlled native space is absent");
    space.desiredState = "deleted";
    space.phase = "deleted";
    space.generation++;
    await local.records.put(space);
  };
  manager.create = async (repositoryId, ref, operationMarker, onAdmitted) => {
    const policy = await local.records.policy();
    requireLocalGrant(policy, repositoryId);
    const id = randomUUID(),
      space = {
        ...local.space,
        id,
        name: "moira-" + id.replaceAll("-", ""),
        admittedMachine: {
          cpuCores: policy.runtime.cpuCores,
          memoryBytes: policy.runtime.memoryBytes,
          dockerBytes: policy.runtime.dockerBytes,
        },
        runtimeId: null,
        repositoryId,
        ref,
        operationMarker,
        phase: "creating" as const,
        lastStartedAt: null,
      };
    await local.records.put(space);
    await onAdmitted?.();
    const ready = {
      ...space,
      runtimeId: "controlled-native-" + id,
      phase: "usable" as const,
      lastStartedAt: Date.now(),
    };
    await local.records.put(ready);
    return ready;
  };
  const control = new LocalWebControl(local.records, {
    replacePolicy: async (records, next) => {
      await records.state.write("policy.json", next);
    },
  });
  await control.optIn(
    { ...identity, origin: "https://moira.example" },
    {
      cpuCores: 4,
      memoryBytes: 8 * GiB,
      storageBytes: 64 * GiB,
      dockerBytes: 8 * GiB,
    },
    true,
  );
  const controller = new LocalController(manager, identity, control),
    endpoint = await startLocalController(controller);
  const wire = createWorkspaceClient(endpoint.socketPath);
  const client = {
    async json(
      userId: string,
      deviceId: string,
      input: { method: string; path: string; body?: unknown },
    ) {
      const bytes = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
      return jsonResponse(
        await wire.request(userId, deviceId, {
          method: input.method,
          path: input.path,
          headers: {
            "x-moira-device-id": deviceId,
            "x-moira-device-generation": String(identity.deviceGeneration),
            "x-moira-connection-id": identity.connectionId,
            "content-type": "application/json",
          },
          body: bytes,
        }),
      );
    },
  };
  return {
    ...local,
    state,
    manager,
    control,
    controller,
    endpoint,
    client,
    identity,
    close: async () => {
      await endpoint.close();
      await manager.close();
    },
  };
}
