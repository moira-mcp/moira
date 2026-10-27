import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import {
  LocalResourceRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  createWorkspaceRequestId,
  localRepositoryTargetId,
} from "@mcp-moira/shared";
import { LocalCodespaceProvider } from "../../packages/web-backend/src/services/local-codespace-provider.js";
import { LocalCodespaceResourceService } from "../../packages/web-backend/src/services/local-codespace-resource-service.js";
import { controllerFixture } from "../fixtures/local-controller.js";
import { createLocalDeviceRoutes } from "../../packages/web-backend/src/routes/local-devices.js";
import { LocalRefusal } from "../../packages/local/src/policy.js";
import { createCodespaceManagementRoutes } from "../../packages/web-backend/src/routes/codespace-management.js";
import { createLocalCodespaceServices } from "../../packages/web-backend/src/services/local-codespace-services.js";
import { createWorkspaceSemanticServices } from "../../packages/web-backend/src/services/workspace-semantic-service.js";
import { encodeReference, decodeReference } from "@mcp-moira/shared/workspace-references";

let db: Database.Database,
  directory: string,
  devices: LocalDeviceService,
  resource: LocalCodespaceResourceService;
let owner: Awaited<ReturnType<typeof controllerFixture>> | undefined;
let deviceId: string, target: string, lostReply: boolean, credential: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp("/tmp/moira-local-facade-"));
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(drizzle(db), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of ["owner", "other"])
    db.prepare(
      "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'before','before','approved',1)",
    ).run(id, id + "@example.test", id);
  owner = undefined;
  lostReply = false;
  deviceId = randomUUID();
  devices = new LocalDeviceService(new LocalDeviceRepository(db), Date.now, {
    async json(user, id, input) {
      if (!owner)
        throw Object.assign(new Error("Controlled owner unavailable"), { code: "ECONNREFUSED" });
      const value = await owner.client.json(user, id, input);
      if (lostReply && input.method === "POST") {
        lostReply = false;
        throw new Error("Controlled reply lost after effect");
      }
      return value;
    },
  });
  const pair = devices.beginEnrollment("owner");
  credential = randomBytes(32).toString("base64url");
  devices.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    deviceId,
    label: "Fixture owner",
  });
  await devices.confirmEnrollment("owner", pair.pairingId, 2);
  owner = await controllerFixture(join(directory, "owner"), devices.authenticateDevice(credential));
  const repository = new LocalResourceRepository(db);
  resource = new LocalCodespaceResourceService(
    repository,
    devices,
    new LocalCodespaceProvider(devices, repository, "https://moira.example/settings"),
    db,
  );
  target = localRepositoryTargetId(deviceId, owner.policy.repositories[0].id);
});
afterEach(async () => {
  await owner?.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});
async function create(requestId = createWorkspaceRequestId()) {
  return resource.create("owner", target, "main", requestId);
}

describe("Local cloud facade routes to the authoritative owner", () => {
  test("collecting a lost create and an older stop projects the real receipt while inventory and fresh observation are unavailable", async () => {
    const requestId = createWorkspaceRequestId();
    lostReply = true;
    await expect(create(requestId)).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    const retained = await devices.getOperation("owner", deviceId, requestId);
    const local = {
      ...createLocalCodespaceServices({ sqlite: db, controller: owner!.client }),
      resource,
      provider: "local-sandboxes" as const,
      guidance: () => ({
        provider: "local-sandboxes",
        situation: "ready" as const,
        instruction: null,
        links: [],
      }),
    };
    const semantic = createWorkspaceSemanticServices({
      providers: [local],
      select: () => local,
      devices,
      workspace: owner!.client,
      controller: owner!.client,
      repositories: {} as never,
      repositoryCreation: {} as never,
    });
    const operation = (id: string) =>
      encodeReference("operation", {
        owner: {
          kind: "controller",
          deviceId,
          connectionId: devices.getDeviceIdentity("owner", deviceId).connectionId,
        },
        requestId: id,
        kind: "lifecycle",
      });
    const snapshot = owner!.manager.snapshot.bind(owner!.manager);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    owner!.manager.snapshot = async (...args) => {
      if (args[0] === undefined) {
        entered();
        await held;
      } else throw new LocalRefusal("LOCAL_RUNTIME_UNAVAILABLE", "Controlled exact read failure");
      return snapshot(...args);
    };
    const inventory = resource.listResources("owner");
    await started;
    try {
      const collected = await semantic.invoke("owner", "operation_get", {
        reference: operation(requestId),
      });
      expect(collected).toMatchObject({
        operation: operation(requestId),
        state: "completed",
        outcome: {
          ok: true,
          result: {
            workspace: expect.any(String),
            state: "usable",
            observed_at: retained.outcome?.ok
              ? (retained.outcome.result as { observedAt: number }).observedAt
              : null,
          },
        },
      });
      expect(await devices.getOperation("owner", deviceId, requestId)).toEqual(retained);
      await expect(resource.getCodespace("owner", requestId.slice(4))).rejects.toBeDefined();
      owner!.manager.snapshot = snapshot;
      const stopId = createWorkspaceRequestId();
      await resource.stopCodespace("owner", requestId.slice(4), stopId, 1);
      const stopReceipt = await devices.getOperation("owner", deviceId, stopId);
      await resource.startCodespace("owner", requestId.slice(4), createWorkspaceRequestId(), 2);
      owner!.manager.snapshot = async () => {
        throw new Error("No observation while collecting history");
      };
      const stopped = await semantic.invoke("owner", "operation_get", {
        reference: operation(stopId),
      });
      expect(stopped).toMatchObject({
        state: "completed",
        outcome: {
          ok: true,
          result: {
            state: "stopped",
            workspace: expect.any(String),
            observed_at: stopReceipt.outcome?.ok
              ? (stopReceipt.outcome.result as { observedAt: number }).observedAt
              : null,
          },
        },
      });
      const result = (stopped as { outcome: { result: { workspace: string } } }).outcome.result;
      expect(decodeReference(result.workspace, "workspace").generation).toBe(2);
      expect(await devices.getOperation("owner", deviceId, stopId)).toEqual(stopReceipt);
      expect(await owner!.records.list()).toHaveLength(2);
      owner!.manager.snapshot = snapshot;
      await resource.deleteCodespace("owner", requestId.slice(4), 3, {
        requestId: createWorkspaceRequestId(),
        ownerConfirmed: true,
      });
      expect(
        await semantic.invoke("owner", "operation_get", { reference: operation(stopId) }),
      ).toMatchObject({
        state: "completed",
        outcome: { ok: true, result: null },
        observation_error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" },
      });
      expect(await devices.getOperation("owner", deviceId, stopId)).toEqual(stopReceipt);
    } finally {
      owner!.manager.snapshot = snapshot;
      release();
      await inventory;
    }
  });
  test("a malformed device projection does not discard a healthy peer or hide account refusal", async () => {
    const badDevice = randomUUID(),
      pair = devices.beginEnrollment("owner");
    devices.approveLocalEnrollment({
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential: randomBytes(32).toString("base64url"),
      deviceId: badDevice,
      label: "Malformed peer",
    });
    await devices.confirmEnrollment("owner", pair.pairingId, 2);
    const original = owner!.client.json;
    owner!.client.json = async (...args) => (args[1] === badDevice ? {} : original(...args));
    const listed = await devices.listOwned("owner");
    expect(listed.devices.find((device) => device.deviceId === deviceId)?.owner.state).toBe(
      "available",
    );
    expect(listed.devices.find((device) => device.deviceId === badDevice)?.owner).toEqual({
      state: "unavailable",
      code: "LOCAL_PROTOCOL_INVALID",
    });
    expect(await resource.listRepositories("owner")).toEqual([
      { id: target, fullName: owner!.policy.repositories[0].fullName, private: false },
    ]);
    db.prepare("UPDATE user SET blocked=1 WHERE id='owner'").run();
    await expect(devices.listOwned("owner")).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
  });
  test("pending native inventory cannot block management or exact Git authority in the same request", async () => {
    const created = await create(),
      observation = devices.createObservation("owner"),
      snapshot = owner!.manager.snapshot.bind(owner!.manager);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    owner!.manager.snapshot = async (...args) => {
      if (args[0] === undefined) {
        entered();
        await held;
      }
      return snapshot(...args);
    };
    const native = observation.localSnapshot(deviceId);
    await started;
    try {
      expect(await resource.getCodespace("owner", created.codespace_id)).toMatchObject({
        state: "usable",
        generation: created.generation,
      });
      const second = await create();
      expect(second.state).toBe("usable");
      const stopped = await resource.stopCodespace(
        "owner",
        second.codespace_id,
        createWorkspaceRequestId(),
        second.generation,
      );
      expect(stopped).toMatchObject({ state: "stopped", generation: second.generation + 1 });
      const metadata = await observation.snapshot(deviceId);
      expect(metadata.local).not.toHaveProperty("resources");
      expect(metadata.local).not.toHaveProperty("resourceObservation");
      expect((await observation.listOwned()).devices[0].owner.state).toBe("available");
      await owner!.state.remove("web-control.json");
      expect(
        await devices.authorizeOwnedGitHubOperation("owner", created.codespace_id, "fetch"),
      ).toMatchObject({ resourceId: created.codespace_id, resourceGeneration: 1 });
      const policy = await owner!.records.policy();
      policy.enabled = false;
      await owner!.state.write("policy.json", policy);
      await expect(
        devices.authorizeOwnedGitHubOperation("owner", created.codespace_id, "fetch"),
      ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    } finally {
      release();
      await native;
    }
  });
  test.each(["/v1/controller/management", "/v1/controller/workspaces/resolve"])(
    "Git refuses route retirement during %s without adopting another owner resource",
    async (path) => {
      const created = await create(),
        original = owner!.client.json;
      const calls: Array<{ method: string; path: string; body?: unknown; headers?: unknown }> = [];
      owner!.client.json = async (...args) => {
        calls.push(args[2]);
        const result = await original(...args);
        if (args[2].path === path)
          db.prepare("UPDATE codespaceLocalResourceBinding SET revokedAt=1 WHERE resourceId=?").run(
            created.codespace_id,
          );
        return result;
      };
      await expect(
        devices.authorizeOwnedGitHubOperation("owner", created.codespace_id, "fetch"),
      ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
      const identity = devices.getDeviceIdentity("owner", deviceId);
      const metadataCall = {
        method: "GET",
        path: "/v1/controller/management",
        headers: {
          "x-moira-device-id": deviceId,
          "x-moira-device-generation": String(identity.deviceGeneration),
          "x-moira-connection-id": identity.connectionId,
        },
      };
      expect(calls).toEqual(
        path === "/v1/controller/management"
          ? [metadataCall]
          : [
              metadataCall,
              {
                method: "POST",
                path: "/v1/controller/workspaces/resolve",
                body: { deviceId, resourceId: created.codespace_id },
                headers: {
                  "x-moira-device-id": deviceId,
                  "x-moira-device-generation": String(identity.deviceGeneration),
                  "x-moira-connection-id": identity.connectionId,
                },
              },
            ],
      );
    },
  );
  test("Git refuses a replaced registration after its exact resolver reply", async () => {
    const created = await create(),
      original = owner!.client.json;
    owner!.client.json = async (...args) => {
      const result = await original(...args);
      if (args[2].path === "/v1/controller/workspaces/resolve")
        db.prepare("UPDATE codespaceLocalDevice SET generation=generation+1 WHERE id=?").run(
          deviceId,
        );
      return result;
    };
    await expect(
      devices.authorizeOwnedGitHubOperation("owner", created.codespace_id, "fetch"),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
  });
  test("one discovery observation shares exact device evidence while individual get and lifecycle remain fresh", async () => {
    const first = await create(),
      second = await create(),
      observation = devices.createObservation("owner"),
      before = await observation.localSnapshot(deviceId),
      metadata = await observation.snapshot(deviceId);
    await resource.stopCodespace(
      "owner",
      second.codespace_id,
      createWorkspaceRequestId(),
      second.generation,
    );
    const [listed, repositories, owned] = await Promise.all([
      resource.listResources("owner", { observation }),
      resource.listRepositories("owner", { observation }),
      observation.listOwned(),
    ]);
    expect(listed.codespaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ codespace_id: first.codespace_id, state: "usable" }),
        expect.objectContaining({ codespace_id: second.codespace_id, state: "usable" }),
      ]),
    );
    expect(listed.codespaces).toHaveLength(2);
    expect(repositories.map((repository) => repository.id)).toContain(target);
    expect(owned.devices[0].owner).toMatchObject({
      state: "available",
      observedAt: metadata.observedAt,
    });
    expect(await observation.localSnapshot(deviceId)).toEqual(before);
    const fresh = await resource.getCodespace("owner", second.codespace_id);
    expect(fresh).toMatchObject({ state: "stopped", generation: second.generation + 1 });
    await expect(
      resource.startCodespace(
        "owner",
        second.codespace_id,
        createWorkspaceRequestId(),
        second.generation,
      ),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    expect((await resource.getCodespace("owner", second.codespace_id)).state).toBe("stopped");
    await expect(resource.listResources("other", { observation })).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
  });
  test("cached and in-flight request observations refuse a changed registration rather than adopting its response", async () => {
    const observation = devices.createObservation("owner");
    await observation.snapshot(deviceId);
    const original = owner!.client.json;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    owner!.client.json = async (...args) => {
      const response = await original(...args);
      if (args[2].path === "/v1/controller/management") {
        entered();
        await held;
      }
      return response;
    };
    const pending = devices.createObservation("owner").snapshot(deviceId);
    await started;
    db.prepare("UPDATE codespaceLocalDevice SET generation=generation+1 WHERE id=?").run(deviceId);
    release();
    await expect(pending).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    await expect(observation.snapshot(deviceId)).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
    await expect(observation.localSnapshot(deviceId)).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
    expect((await observation.listOwned()).devices[0].owner).toMatchObject({
      state: "unavailable",
      code: "LOCAL_UNAUTHORIZED",
    });
    db.prepare("UPDATE user SET blocked=1 WHERE id='owner'").run();
    await expect(observation.listOwned()).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
  });
  test("actionable setup, unknown diagnostics and proven retirement stay separate without changing original records", async () => {
    const healthy = await create(),
      incomplete = await create(),
      retired = await create(),
      binding = (await owner!.controller.state.binding(incomplete.codespace_id, owner!.identity))!,
      space = (await owner!.records.get(binding.localSpaceId!))!;
    await owner!.records.put({
      ...space,
      phase: "failed",
      failure: "LOCAL_SETUP_INCOMPLETE",
      lastStartedAt: null,
    });
    await resource.deleteCodespace("owner", retired.codespace_id, retired.generation, {
      requestId: createWorkspaceRequestId(),
      ownerConfirmed: true,
    });
    const unknownId = createWorkspaceRequestId(),
      originalCreate = owner!.manager.create;
    owner!.manager.create = async () => {
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Controlled unknown");
    };
    await expect(create(unknownId)).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    owner!.manager.create = originalCreate;
    const identities = resource.repository.listOwned("owner"),
      original = await devices.getOperation("owner", deviceId, unknownId),
      actionable = await resource.listResources("owner"),
      diagnostics = await resource.listResources("owner", { view: "diagnostics" }),
      history = await resource.listResources("owner", { view: "history" });
    expect(actionable.codespaces.map((row) => row.codespace_id).sort()).toEqual(
      [healthy.codespace_id, incomplete.codespace_id].sort(),
    );
    expect(actionable.unavailable).toEqual([]);
    expect(actionable.has_diagnostics).toBe(true);
    expect(diagnostics.codespaces).toEqual([]);
    expect(diagnostics.unavailable).toEqual([
      expect.objectContaining({ codespace_id: unknownId.slice(4) }),
    ]);
    expect(diagnostics.unavailable[0]).not.toHaveProperty("generation");
    expect(diagnostics.unavailable[0]).not.toHaveProperty("state");
    expect(history.codespaces).toEqual([
      expect.objectContaining({ codespace_id: retired.codespace_id, state: "deleted" }),
    ]);
    await expect(resource.getCodespace("other", healthy.codespace_id)).rejects.toMatchObject({
      code: "CODESPACE_NOT_FOUND",
    });
    expect(resource.repository.listOwned("owner")).toEqual(identities);
    expect(await devices.getOperation("owner", deviceId, unknownId)).toEqual(original);
  });
  test("setup recovery addresses the same known VM and preserves the failed original create receipt", async () => {
    const createId = createWorkspaceRequestId(),
      originalCreate = owner!.manager.create;
    let creations = 0,
      recoveries = 0;
    owner!.manager.create = async (...args) => {
      creations++;
      const space = await originalCreate(...args);
      space.phase = "failed";
      space.failure = "LOCAL_SETUP_INCOMPLETE";
      space.setupFailure = "prerequisite_unavailable";
      space.lastStartedAt = null;
      await owner!.records.put(space);
      throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", "Controlled preparation interruption");
    };
    await expect(create(createId)).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
    });
    const original = await devices.getOperation("owner", deviceId, createId),
      incomplete = await resource.getCodespace("owner", createId.slice(4)),
      binding = (await owner!.controller.state.binding(incomplete.codespace_id, owner!.identity))!,
      before = (await owner!.records.get(binding.localSpaceId!))!;
    expect(incomplete.lifecycle_error).toBe("CODESPACE_LOCAL_SETUP_INCOMPLETE");
    expect(incomplete.setup_failure).toBe("prerequisite_unavailable");
    owner!.manager.resumeSetup = async (id, onAdmitted) => {
      recoveries++;
      const space = await owner!.records.get(id);
      if (!space?.runtimeId) throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "No known VM");
      space.generation++;
      await owner!.records.put(space);
      await onAdmitted?.();
      space.phase = "usable";
      space.failure = null;
      delete space.setupFailure;
      space.remote = { state: "enrollment_unavailable" };
      space.lastStartedAt = Date.now();
      await owner!.records.put(space);
      return space;
    };
    await expect(
      resource.resumeSetup(
        "other",
        incomplete.codespace_id,
        createWorkspaceRequestId(),
        incomplete.generation,
      ),
    ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
    const app = express();
    app.use(express.json(), (req, _res, next) => {
      Object.assign(req, { userId: "owner" });
      next();
    });
    const local = {
      ...createLocalCodespaceServices({ sqlite: db, controller: owner!.client }),
      resource,
      provider: "local-sandboxes" as const,
      guidance: () => ({
        provider: "local-sandboxes",
        situation: "ready" as const,
        instruction: null,
        links: [],
      }),
    };
    const semantic = createWorkspaceSemanticServices({
      providers: [local],
      select: () => local,
      devices,
      workspace: owner!.client,
      controller: owner!.client,
      repositories: {} as never,
      repositoryCreation: {} as never,
    });
    app.use(
      createCodespaceManagementRoutes({
        ...local,
        semantic,
        provider: "local-sandboxes",
        resource,
      }),
    );
    const response = await request(app)
      .post("/operations/workspace_lifecycle")
      .send({
        workspace: encodeReference("workspace", {
          resourceId: incomplete.codespace_id,
          provider: "local-sandboxes",
          deviceId,
          generation: incomplete.generation,
        }),
        action: "resume_setup",
      });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ state: "completed", outcome: { ok: true } });
    const recovered = response.body.data.outcome.result;
    expect(recovered).toMatchObject({
      codespace_id: incomplete.codespace_id,
      state: "usable",
      lifecycle_error: null,
    });
    expect(decodeReference(recovered.workspace, "workspace").generation).toBe(
      incomplete.generation + 1,
    );
    expect(recovered).not.toHaveProperty("generation");
    expect(recovered.remote).toEqual({ state: "enrollment_unavailable" });
    expect(recovered).not.toHaveProperty("setup_failure");
    expect(await owner!.records.get(before.id)).toMatchObject({
      id: before.id,
      runtimeId: before.runtimeId,
      operationMarker: before.operationMarker,
      repositoryId: before.repositoryId,
    });
    expect(await devices.getOperation("owner", deviceId, createId)).toEqual(original);
    await expect(
      resource.resumeSetup(
        "owner",
        incomplete.codespace_id,
        createWorkspaceRequestId(),
        incomplete.generation,
      ),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    expect(creations).toBe(1);
    expect(recoveries).toBe(1);
  });
  test("a closed create without a native space remains discoverable without hiding usable peers or inventing lifecycle authority", async () => {
    const healthy = await create(),
      failedRequest = createWorkspaceRequestId(),
      originalCreate = owner!.manager.create;
    let attempts = 0;
    owner!.manager.create = async () => {
      attempts++;
      throw new LocalRefusal("LOCAL_RUNTIME_UNAVAILABLE", "private-create-diagnostic");
    };
    await expect(create(failedRequest)).rejects.toBeDefined();
    owner!.manager.create = originalCreate;
    const failedId = failedRequest.slice(4),
      identities = resource.repository.listOwned("owner"),
      journals = await owner!.state.keys("controller-operation-");
    expect(await owner!.controller.state.binding(failedId, owner!.identity)).toMatchObject({
      localSpaceId: null,
      creationClosed: true,
    });
    const view = await resource.listResources("owner");
    expect(view.codespaces).toEqual([
      expect.objectContaining({
        codespace_id: healthy.codespace_id,
        state: "usable",
        generation: healthy.generation,
      }),
    ]);
    expect(view.unavailable).toEqual([]);
    expect(view.has_diagnostics).toBe(true);
    expect((await resource.listResources("owner", { view: "diagnostics" })).unavailable).toEqual([
      {
        codespace_id: failedId,
        provider: "local-sandboxes",
        repository_id: target,
        repository: owner!.policy.repositories[0].fullName,
        requested_ref: "main",
        created_at: identities.find((entry) => entry.id === failedId)!.createdAt,
        device_id: deviceId,
        pending_request_ids: [],
        error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("private-create-diagnostic");
    expect(await resource.listResources("other")).toMatchObject({
      codespaces: [],
      unavailable: [],
    });
    expect(resource.repository.listOwned("owner")).toEqual(identities);
    expect(await owner!.state.keys("controller-operation-")).toEqual(journals);
    expect(attempts).toBe(1);
    await expect(resource.getCodespace("owner", failedId)).rejects.toMatchObject({
      code: "CODESPACE_PROVIDER_UNAVAILABLE",
    });
  });
  test("paired-device registration API reserves only a checked route, idempotently, before native work", async () => {
    const app = express();
    app.use(
      createLocalDeviceRoutes(devices, "https://moira.example", (auth, input) =>
        resource.registerRoute(auth.userId, auth.deviceId, input),
      ),
    );
    const input = {
      resourceId: randomUUID(),
      resourceGeneration: 1,
      repositoryId: owner!.policy.repositories[0].id,
      operationMarker: "moira-" + "c".repeat(24),
      ref: "main",
    };
    const registered = await request(app)
      .post("/resources/register")
      .set("Authorization", "Bearer " + credential)
      .send(input);
    expect(registered.status).toBe(200);
    expect(registered.body.data).toEqual({
      resourceId: input.resourceId,
      repositoryId: input.repositoryId,
      resourceGeneration: 1,
    });
    expect(
      (
        await request(app)
          .post("/resources/register")
          .set("Authorization", "Bearer " + credential)
          .send(input)
      ).body.data,
    ).toEqual(registered.body.data);
    expect(
      (
        await request(app)
          .post("/resources/register")
          .send({ ...input, resourceId: randomUUID() })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/resources/register")
          .set("Authorization", "Bearer " + credential)
          .send({ ...input, resourceId: randomUUID(), repositoryId: randomUUID() })
      ).status,
    ).toBe(403);
    expect(db.prepare("SELECT count(*) count FROM localResourceIdentity").get()).toEqual({
      count: 1,
    });
    await expect(resource.getCodespace("owner", input.resourceId)).rejects.toMatchObject({
      code: "CODESPACE_PROVIDER_UNAVAILABLE",
    });
    expect(await owner!.records.list()).toHaveLength(1);
    expect(await owner!.state.keys("controller-operation-")).toEqual([]);
  });
  test("create uses caller identity, no cloud claim/relay/mutation, and repeated collect preserves one native creation", async () => {
    const requestId = createWorkspaceRequestId(),
      created = await create(requestId);
    expect(created).toMatchObject({
      codespace_id: requestId.slice(4),
      state: "usable",
      generation: 1,
    });
    expect(await owner!.records.list()).toHaveLength(2);
    const repeated = await create(requestId);
    expect(repeated.codespace_id).toBe(created.codespace_id);
    expect(await owner!.records.list()).toHaveLength(2);
    expect(await owner!.state.keys("controller-operation-")).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codespaceLocalRelay','codespaceProviderMutation','codespaceResource')",
        )
        .all(),
    ).toEqual([]);
  });
  test("lost create reply collects original receipt and live owner without replaying any native operation", async () => {
    const requestId = createWorkspaceRequestId();
    lostReply = true;
    await expect(create(requestId)).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_CREATION_UNKNOWN",
    });
    expect(await devices.getOperation("owner", deviceId, requestId)).toMatchObject({
      requestId,
      state: "completed",
      outcome: { ok: true },
    });
    expect((await resource.getCodespace("owner", requestId.slice(4))).state).toBe("usable");
    expect(await owner!.records.list()).toHaveLength(2);
    expect(await owner!.state.keys("controller-operation-")).toHaveLength(1);
  });
  test("repeated creation preserves a retained uncertain owner receipt instead of claiming a confirmed refusal", async () => {
    const requestId = createWorkspaceRequestId();
    let nativeCreations = 0;
    owner!.manager.create = async () => {
      nativeCreations++;
      throw new LocalRefusal(
        "WORKSPACE_OUTCOME_UNCONFIRMED",
        "Controlled native creation outcome unavailable",
      );
    };
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(create(requestId)).rejects.toMatchObject({
        code: "CODESPACE_LOCAL_CREATION_UNKNOWN",
        requestId,
        deviceId,
        resourceId: requestId.slice(4),
      });
    expect(nativeCreations).toBe(1);
    expect(await devices.getOperation("owner", deviceId, requestId)).toMatchObject({
      requestId,
      state: "completed",
      outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    });
  });
  test("owner generation fences stale actions while stable route generation keeps Git authority valid", async () => {
    const created = await create(),
      stopId = createWorkspaceRequestId();
    const stopped = await resource.stopCodespace(
      "owner",
      created.codespace_id,
      stopId,
      created.generation,
    );
    expect(stopped).toMatchObject({ state: "stopped", desired_state: "stopped", generation: 2 });
    expect(
      db
        .prepare("SELECT routeGeneration FROM localResourceIdentity WHERE id=?")
        .get(stopped.codespace_id),
    ).toEqual({ routeGeneration: 1 });
    const staleStartId = createWorkspaceRequestId();
    await expect(
      resource.startCodespace("owner", stopped.codespace_id, staleStartId, 1),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    await expect(
      resource.stopCodespace("owner", stopped.codespace_id, createWorkspaceRequestId(), 1),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    await expect(
      resource.deleteCodespace("owner", stopped.codespace_id, 1, {
        requestId: createWorkspaceRequestId(),
        ownerConfirmed: true,
      }),
    ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
    expect(await resource.getCodespace("owner", stopped.codespace_id)).toMatchObject({
      state: "stopped",
      generation: 2,
    });
    expect(await devices.getOperation("owner", deviceId, staleStartId)).toMatchObject({
      state: "completed",
      outcome: { ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } },
    });
    const auth = devices.getBinding("owner", stopped.codespace_id)!;
    expect(
      await devices.authorizeGitHubOperation(auth, stopped.codespace_id, 1, "fetch"),
    ).toMatchObject({
      repository: { id: owner!.policy.repositories[0].id },
      resourceId: stopped.codespace_id,
      resourceGeneration: 1,
      ownerResourceGeneration: 2,
    });
    expect(await devices.getOperation("owner", deviceId, stopId)).toMatchObject({
      state: "completed",
      outcome: { ok: true, result: { resourceGeneration: 2 } },
    });
    const started = await resource.startCodespace(
      "owner",
      stopped.codespace_id,
      createWorkspaceRequestId(),
      stopped.generation,
    );
    expect(started).toMatchObject({ state: "usable", generation: 3 });
  });
  test.each(["push", "pull_request"] as const)(
    "one %s decision retains a coherent owner witness and the next phase observes changed rights",
    async (action) => {
      const created = await create(),
        policy = await owner!.records.policy();
      policy.repositories[0].allowPush = true;
      policy.repositories[0].allowPullRequests = true;
      await owner!.state.write("policy.json", policy);
      const snapshot = await devices.localSnapshot("owner", deviceId);
      const original = owner!.client.json;
      let changed = false;
      owner!.client.json = async (...args) => {
        const result = await original(...args);
        if (!changed && args[2].path === "/v1/controller/management") {
          changed = true;
          await owner!.state.write("policy.json", {
            ...policy,
            repositories: policy.repositories.map((repository) => ({
              ...repository,
              allowPush: false,
              allowPullRequests: false,
            })),
          });
        }
        return result;
      };
      const decision = await devices.authorizeOwnedGitHubOperation(
        "owner",
        created.codespace_id,
        action,
      );
      const binding = devices.getBinding("owner", created.codespace_id)!;
      expect(decision).toMatchObject({
        auth: {
          userId: "owner",
          deviceId,
          deviceGeneration: binding.deviceGeneration,
          connectionId: binding.connectionId,
        },
        resourceId: created.codespace_id,
        resourceGeneration: 1,
        ownerResourceGeneration: 1,
        appliedRevision: snapshot.control.appliedRevision,
        useUntil: null,
        repository: { ...policy.repositories[0], allowPush: true, allowPullRequests: true },
      });
      await expect(
        devices.authorizeOwnedGitHubOperation("owner", created.codespace_id, action),
      ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    },
  );
  test("changing next defaults does not report an existing admitted VM as resized", async () => {
    const first = await create(),
      policy = await owner!.records.policy();
    const identity = db
      .prepare("SELECT * FROM localResourceIdentity WHERE id=?")
      .get(first.codespace_id);
    await owner!.state.write("policy.json", {
      ...policy,
      runtime: { ...policy.runtime, cpuCores: 2, memoryBytes: 2 * 1024 ** 3 },
    });
    expect((await resource.getCodespace("owner", first.codespace_id)).machine).toMatchObject({
      cpu_cores: 1,
      memory_bytes: 1024 ** 3,
    });
    const second = await create();
    expect(second.machine).toMatchObject({ cpu_cores: 2, memory_bytes: 2 * 1024 ** 3 });
    expect((await resource.getCodespace("owner", first.codespace_id)).machine?.cpu_cores).toBe(1);
    expect(
      db.prepare("SELECT * FROM localResourceIdentity WHERE id=?").get(first.codespace_id),
    ).toEqual(identity);
  });
  test("offline owner does not certify stale SQL state and missing caller identities/CAS cannot dispatch", async () => {
    const created = await create(),
      journal = await owner!.state.keys("controller-operation-");
    await expect(
      resource.stopCodespace("owner", created.codespace_id, undefined, 1),
    ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
    await expect(
      resource.stopCodespace("owner", created.codespace_id, createWorkspaceRequestId()),
    ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
    expect(await owner!.state.keys("controller-operation-")).toEqual(journal);
    await owner!.close();
    owner = undefined;
    await expect(resource.getCodespace("owner", created.codespace_id)).rejects.toMatchObject({
      code: "CODESPACE_PROVIDER_UNAVAILABLE",
    });
    expect(await resource.listResources("owner", { view: "diagnostics" })).toMatchObject({
      codespaces: [],
      unavailable: [
        {
          codespace_id: created.codespace_id,
          provider: "local-sandboxes",
          repository_id: target,
          repository: created.repository,
          requested_ref: "main",
          created_at: created.created_at,
          device_id: deviceId,
          error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
        },
      ],
    });
    await expect(
      resource.stopCodespace("owner", created.codespace_id, createWorkspaceRequestId(), 1),
    ).rejects.toMatchObject({ code: "CODESPACE_PROVIDER_UNAVAILABLE" });
  });
  test("confirmed deletion revokes guest route authority and preserves the healthy peer and original owner receipt", async () => {
    const first = await create(),
      peer = await create(),
      requestId = createWorkspaceRequestId();
    const removed = await resource.deleteCodespace("owner", first.codespace_id, first.generation, {
      requestId,
      ownerConfirmed: true,
    });
    expect(removed.state).toBe("deleted");
    expect(devices.getBinding("owner", first.codespace_id)).toBeNull();
    expect(
      db
        .prepare("SELECT revokedAt FROM codespaceLocalResourceBinding WHERE resourceId=?")
        .get(first.codespace_id),
    ).toMatchObject({ revokedAt: expect.any(Number) });
    expect((await resource.getCodespace("owner", peer.codespace_id)).state).toBe("usable");
    expect(await devices.getOperation("owner", deviceId, requestId)).toMatchObject({
      state: "completed",
      outcome: { ok: true },
    });
  });
  test("registration is idempotent, tenant-isolated, and owner-only pending journal pointers survive a missing binding", async () => {
    const requestId = createWorkspaceRequestId(),
      resourceId = requestId.slice(4);
    const input = {
      resourceId,
      repositoryId: owner!.policy.repositories[0].id,
      resourceGeneration: 1 as const,
      operationMarker: "moira-" + "f".repeat(24),
      ref: "main",
    };
    expect(await resource.registerRoute("owner", deviceId, input)).toEqual(
      await resource.registerRoute("owner", deviceId, input),
    );
    await expect(resource.registerRoute("other", deviceId, input)).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
    const write = owner!.state.write.bind(owner!.state);
    owner!.state.write = async (key, value) => {
      if (
        key.startsWith("controller-operation-") &&
        value &&
        typeof value === "object" &&
        "state" in value &&
        value.state === "completed"
      )
        throw new Error("Controlled completion fsync failure");
      return write(key, value);
    };
    expect(
      await owner!.controller.state.run(
        requestId,
        owner!.identity,
        { resourceId, action: "create" },
        async () => ({ accepted: true }),
      ),
    ).toMatchObject({ state: "unconfirmed" });
    await expect(resource.getCodespace("owner", resourceId)).rejects.toMatchObject({
      code: "CODESPACE_LOCAL_CREATION_UNKNOWN",
      requestId,
      deviceId,
    });
    expect((await devices.localSnapshot("owner", deviceId)).pendingResourceOperations).toEqual([
      { resourceId, requestIds: [requestId] },
    ]);
    expect((await resource.listResources("owner", { view: "diagnostics" })).unavailable).toEqual([
      expect.objectContaining({
        codespace_id: resourceId,
        device_id: deviceId,
        pending_request_ids: [requestId],
        error: { code: "CODESPACE_LOCAL_CREATION_UNKNOWN" },
      }),
    ]);
    const nextDevice = randomUUID(),
      pairing = devices.beginEnrollment("owner");
    devices.approveLocalEnrollment({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      credential: randomBytes(32).toString("base64url"),
      deviceId: nextDevice,
      label: "Changed binding",
    });
    await devices.confirmEnrollment("owner", pairing.pairingId, 2);
    const observe = owner!.client.json;
    owner!.client.json = async (...args) => {
      const result = await observe(...args);
      if (args[2].path === "/v1/controller") {
        db.prepare(
          "UPDATE codespaceLocalResourceBinding SET deviceId=? WHERE resourceId=? AND userId='owner'",
        ).run(nextDevice, resourceId);
      }
      return result;
    };
    const raced = await resource.listResources("owner", { view: "diagnostics" });
    expect(devices.getBinding("owner", resourceId)?.deviceId).toBe(nextDevice);
    expect(raced.unavailable).toEqual([
      expect.objectContaining({
        codespace_id: resourceId,
        device_id: deviceId,
        pending_request_ids: [requestId],
      }),
    ]);
  });
});
