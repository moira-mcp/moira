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
      id: owner!.policy.repositories[0].id,
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
  });
});
