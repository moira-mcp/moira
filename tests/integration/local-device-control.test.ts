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
  LocalDeviceRepository,
  LocalDeviceService,
  createWorkspaceRequestId,
} from "@mcp-moira/shared";
import { controlSettings } from "../../packages/local/src/web-control.js";
import { createLocalDeviceManagementRoutes } from "../../packages/web-backend/src/routes/local-devices.js";
import { controllerFixture } from "../fixtures/local-controller.js";

let db: Database.Database, directory: string, service: LocalDeviceService;
let owner: Awaited<ReturnType<typeof controllerFixture>> | undefined;
let deviceId: string;
let lostReply = false;
beforeEach(async () => {
  directory = await realpath(await mkdtemp("/tmp/moira-live-settings-"));
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
  service = new LocalDeviceService(new LocalDeviceRepository(db), Date.now, {
    async json(user, id, input) {
      if (!owner)
        throw Object.assign(new Error("Controlled owner connection absent"), {
          code: "ECONNREFUSED",
        });
      const value = await owner.client.json(user, id, input);
      if (lostReply && input.method === "PUT") {
        lostReply = false;
        throw new Error("Controlled reply lost after owner completion");
      }
      return value;
    },
  });
  const pair = service.beginEnrollment("owner"),
    credential = randomBytes(32).toString("base64url");
  service.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    deviceId,
    label: "Fixture owner",
  });
  await service.confirmEnrollment("owner", pair.pairingId, 2);
  const identity = service.authenticateDevice(credential);
  owner = await controllerFixture(join(directory, "owner"), identity);
});
afterEach(async () => {
  await owner?.close();
  db.close();
  await rm(directory, { recursive: true, force: true });
});
function app() {
  const value = express();
  value.use((req, _res, next) => {
    Object.assign(req, {
      userId: "owner",
      ...(req.get("X-Fixture-Session") === "yes" ? { session: { token: "fixture-session" } } : {}),
    });
    next();
  });
  value.use(createLocalDeviceManagementRoutes(service, "https://moira.example"));
  return value;
}
function save(value: ReturnType<typeof app>, body: Record<string, unknown>) {
  return request(value)
    .put("/devices/" + deviceId + "/settings")
    .set("X-Fixture-Session", "yes")
    .set("Origin", "https://moira.example")
    .send(body);
}
describe("Browser-authorized settings reach one live owner", () => {
  test("the owner applies settings and retains the receipt while cloud has no requested policy/control columns", async () => {
    const current = await owner!.records.policy(),
      requestId = createWorkspaceRequestId();
    const body = {
      requestId,
      expectedGeneration: 1,
      expectedRevision: 0,
      settings: { ...controlSettings(current), label: "Applied by the owner" },
    };
    const value = app(),
      saved = await save(value, body);
    expect(saved.status).toBe(200);
    expect(saved.body.data.owner).toMatchObject({
      state: "available",
      local: {
        state: "configured",
        control: { revision: 1, appliedRevision: 1, status: "applied" },
      },
    });
    expect((await owner!.records.policy()).label).toBe(body.settings.label);
    const columns = (
      db.prepare("PRAGMA table_info(codespaceLocalDevice)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).not.toContain("policy");
    expect(columns).not.toContain("control");
    expect(await owner!.state.keys("controller-operation-")).toHaveLength(1);
    const receipt = await request(value).get(
      "/devices/" + deviceId + "/settings/operations/" + requestId,
    );
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toMatchObject({
      requestId,
      state: "completed",
      result: {
        owner: {
          state: "available",
          local: { state: "configured", control: { revision: 1 } },
        },
      },
    });
    const stale = await save(value, {
      ...body,
      requestId: createWorkspaceRequestId(),
      settings: { ...body.settings, label: "Stale settings must not apply" },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("LOCAL_CONFLICT");
    expect((await owner!.records.policy()).label).toBe(body.settings.label);
  });
  test("lost reply collects the original owner receipt without applying settings twice", async () => {
    const settings = { ...controlSettings(await owner!.records.policy()), label: "Exactly once" };
    const requestId = createWorkspaceRequestId(),
      value = app();
    lostReply = true;
    const saved = await save(value, {
      requestId,
      expectedGeneration: 1,
      expectedRevision: 0,
      settings,
    });
    expect(saved.status).toBe(409);
    expect(saved.body.error).toMatchObject({
      code: "LOCAL_OUTCOME_UNCONFIRMED",
      request_id: requestId,
    });
    const collected = await request(value).get(
      "/devices/" + deviceId + "/settings/operations/" + requestId,
    );
    expect(collected.status).toBe(200);
    expect(collected.body.data).toMatchObject({
      state: "completed",
      result: {
        owner: {
          state: "available",
          local: { state: "configured", control: { revision: 1, appliedRevision: 1 } },
        },
      },
    });
    expect((await owner!.records.policy()).label).toBe(settings.label);
    expect(await owner!.state.keys("controller-operation-")).toHaveLength(1);
  });
  test("offline owner is unavailable before admission and does not leave a cloud settings request", async () => {
    await owner!.close();
    owner = undefined;
    const unavailable = await service.listOwned("owner");
    expect(unavailable.devices[0].owner).toEqual({ state: "unavailable" });
    const saved = await save(app(), {
      requestId: createWorkspaceRequestId(),
      expectedGeneration: 1,
      expectedRevision: 0,
      settings: {
        label: "Offline",
        enabled: false,
        leaseUntil: 0,
        cpuCores: 1,
        memoryBytes: 1024 ** 3,
        storageBytes: 32 * 1024 ** 3,
        dockerBytes: 4 * 1024 ** 3,
        repositories: [],
        gitAuthor: null,
        agentRepositoryManagement: null,
      },
    });
    expect(saved.status).toBe(503);
    expect(saved.body.error.code).toBe("LOCAL_UNAVAILABLE");
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codespaceLocalRelay'")
        .get(),
    ).toBeUndefined();
  });
  test("browser session/origin and owner generation fence settings without touching local policy", async () => {
    const before = await owner!.records.policy(),
      value = app();
    const body = {
      requestId: createWorkspaceRequestId(),
      expectedGeneration: 1,
      expectedRevision: 0,
      settings: controlSettings(before),
    };
    expect(
      (
        await request(value)
          .put("/devices/" + deviceId + "/settings")
          .set("Origin", "https://moira.example")
          .send(body)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(value)
          .put("/devices/" + deviceId + "/settings")
          .set("X-Fixture-Session", "yes")
          .send(body)
      ).status,
    ).toBe(401);
    expect(
      (
        await request(value)
          .put("/devices/" + deviceId + "/settings")
          .set("X-Fixture-Session", "yes")
          .set("Origin", "https://moira.example")
          .set("Authorization", "Bearer fixture")
          .send(body)
      ).status,
    ).toBe(401);
    expect((await save(value, { ...body, expectedGeneration: 2 })).status).toBe(409);
    expect(await owner!.records.policy()).toEqual(before);
    expect(await owner!.state.keys("controller-operation-")).toEqual([]);
    await expect(service.getActiveDevice("other", deviceId)).rejects.toMatchObject({
      code: "LOCAL_UNAUTHORIZED",
    });
  });
});
