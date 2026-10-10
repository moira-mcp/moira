import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import {
  LocalDeviceRepository,
  LocalDeviceService,
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalDeviceSettingsValue,
  type LocalControlCeiling,
  type LocalPublicPolicy,
} from "@mcp-moira/shared";
import { createLocalDeviceManagementRoutes } from "../../packages/web-backend/src/routes/local-devices.js";
import { LocalRepositoryAdmissionService } from "../../packages/web-backend/src/services/local-repository-admission.js";

let db: Database.Database, service: LocalDeviceService;
const now = 1791230400000,
  GiB = 1024 ** 3;
const settings: LocalDeviceSettingsValue = {
  label: "Owned computer",
  enabled: true,
  leaseUntil: now + 3600000,
  cpuCores: 2,
  memoryBytes: 4 * GiB,
  storageBytes: 32 * GiB,
  dockerBytes: 4 * GiB,
  repositories: [],
  gitAuthor: null,
  agentRepositoryManagement: null,
};
const ceiling: LocalControlCeiling = {
  cpuCores: 4,
  memoryBytes: 8 * GiB,
  storageBytes: 64 * GiB,
  dockerBytes: 8 * GiB,
  maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
};
const policy = (deviceId: string, s = settings): LocalPublicPolicy => ({
  version: 1 as const,
  deviceId,
  label: s.label,
  enabled: s.enabled,
  leaseUntil: s.leaseUntil,
  repositories: s.repositories,
  machine: {
    name: "local-approved",
    displayName: s.label,
    operatingSystem: "linux",
    cpuCores: s.cpuCores,
    memoryBytes: s.memoryBytes,
    storageBytes: s.storageBytes,
  },
});
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrate(drizzle(db), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of ["owner", "other"])
    db.prepare(
      "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'before','before','approved',1)",
    ).run(id, `${id}@example.test`, id);
  service = new LocalDeviceService(new LocalDeviceRepository(db), () => now);
});
afterEach(() => {
  db.close();
});
function enrolled() {
  const pair = service.beginEnrollment("owner"),
    credential = randomBytes(32).toString("base64url"),
    deviceId = randomUUID();
  service.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    policy: policy(deviceId),
  });
  service.confirmEnrollment("owner", pair.pairingId, 2);
  return { deviceId, auth: service.authenticateDevice(credential) };
}
describe("Owner settings are requested separately from locally applied authority", () => {
  test("delegated repository admission stays pending until exact companion ACK and replays one grant", async () => {
    const { deviceId, auth } = enrolled();
    const delegated = {
      ...settings,
      agentRepositoryManagement: {
        githubUserId: "42",
        owner: "owner",
        allowExistingPrivate: true,
        allowNewPrivate: false,
        allowPush: true,
      },
    };
    service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 0 });
    service.requestSettings("owner", deviceId, {
      expectedRevision: 0,
      expectedGeneration: 1,
      settings: delegated,
    });
    const admission = new LocalRepositoryAdmissionService({
      devices: service,
      verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
      verifyRepository: async (_user, repositoryId) => ({
        githubUserId: "42",
        owner: "owner",
        repositoryId,
        fullName: "owner/private-project",
        private: true,
        canRead: true,
        canPush: true,
      }),
    });
    const input = { deviceId, repositoryId: "77", requestId: randomUUID() };
    await expect(admission.addExistingRepository("owner", input)).rejects.toThrow(
      "Enable and apply",
    );
    service.heartbeat(auth, policy(deviceId), { ceiling, settings: delegated, appliedRevision: 1 });
    const pending = await admission.addExistingRepository("owner", input);
    expect(pending).toMatchObject({ status: "pending", revision: 2, local_repository_id: null });
    expect(service.getActiveDevice("owner", deviceId).policy.repositories).toEqual([]);
    expect(await admission.addExistingRepository("owner", input)).toEqual(pending);
    await expect(
      admission.addExistingRepository("owner", { ...input, repositoryId: "78" }),
    ).rejects.toThrow("identity changed");
    const requested = service.getActiveDevice("owner", deviceId).control!.settings;
    expect(requested.repositories).toHaveLength(1);
    expect(requested.repositories[0]).toMatchObject({
      fullName: "owner/private-project",
      private: true,
      allowPush: true,
    });
    const beforeReapproval = service.getActiveDevice("owner", deviceId);
    const reapprovedCeiling = { ...ceiling, storageBytes: 96 * GiB };
    const reapproved = service.heartbeat(auth, policy(deviceId), {
      ceiling: reapprovedCeiling,
      settings: delegated,
      appliedRevision: 1,
    });
    expect(reapproved.control).toEqual({
      ...beforeReapproval.control,
      ceiling: reapprovedCeiling,
    });
    expect(reapproved.policy).toEqual(beforeReapproval.policy);
    service.heartbeat(auth, policy(deviceId, requested), {
      ceiling: reapprovedCeiling,
      settings: requested,
      appliedRevision: 2,
    });
    const applied = await admission.addExistingRepository("owner", input);
    expect(applied.status).toBe("applied");
    expect(applied.local_repository_id).toBe(`local:${deviceId}:${requested.repositories[0].id}`);
    expect(service.getActiveDevice("owner", deviceId).deviceGeneration).toBe(1);
    await expect(admission.addExistingRepository("other", input)).rejects.toThrow("denied");
  });
  test.each(["owner", "private", "push", "read"])(
    "fresh GitHub %s denial never adds repository authority",
    async (failure) => {
      const { deviceId, auth } = enrolled();
      const delegated = {
        ...settings,
        agentRepositoryManagement: {
          githubUserId: "42",
          owner: "owner",
          allowExistingPrivate: true,
          allowNewPrivate: false,
          allowPush: true,
        },
      };
      service.heartbeat(auth, policy(deviceId), {
        ceiling,
        settings: delegated,
        appliedRevision: 0,
      });
      const admission = new LocalRepositoryAdmissionService({
        devices: service,
        verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
        verifyRepository: async (_user, repositoryId) => ({
          githubUserId: "42",
          owner: failure === "owner" ? "other" : "owner",
          repositoryId,
          fullName: "owner/private-project",
          private: failure !== "private",
          canRead: failure !== "read",
          canPush: failure !== "push",
        }),
      });
      await expect(
        admission.addExistingRepository("owner", {
          deviceId,
          repositoryId: "77",
          requestId: randomUUID(),
        }),
      ).rejects.toThrow("exceeds");
      expect(service.getActiveDevice("owner", deviceId).policy.repositories).toEqual([]);
      expect(service.getActiveDevice("owner", deviceId).control!.revision).toBe(0);
    },
  );
  test("legacy device stays unsupported; local opt-in permits CAS and a seven-day lease without claiming application", () => {
    const { deviceId, auth } = enrolled();
    expect(() =>
      service.requestSettings("owner", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings,
      }),
    ).toThrow("opt in");
    service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 0 });
    const requested = { ...settings, cpuCores: 4, leaseUntil: now + MAX_LOCAL_WORK_LEASE_MS };
    const pending = service.requestSettings("owner", deviceId, {
      expectedRevision: 0,
      expectedGeneration: 1,
      settings: requested,
    });
    expect(pending.control).toMatchObject({
      revision: 1,
      appliedRevision: 0,
      status: "pending",
      settings: requested,
    });
    expect(pending.policy.machine.cpuCores).toBe(2);
    expect(() =>
      service.requestSettings("owner", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings,
      }),
    ).toThrow("changed");
    expect(() =>
      service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 1 }),
    ).toThrow("requested settings");
    const applied = service.heartbeat(auth, policy(deviceId, requested), {
      ceiling,
      settings: requested,
      appliedRevision: 1,
    });
    expect(applied.control).toMatchObject({ revision: 1, appliedRevision: 1, status: "applied" });
    expect(applied.policy.machine.cpuCores).toBe(4);
  });
  test("expired disabled work can renew but owner, envelope, revision and report remain fenced", () => {
    const { deviceId, auth } = enrolled(),
      disabled = { ...settings, enabled: false, leaseUntil: 0 };
    service.heartbeat(auth, policy(deviceId, disabled), {
      ceiling,
      settings: disabled,
      appliedRevision: 0,
    });
    expect(() =>
      service.requestSettings("other", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings,
      }),
    ).toThrow("denied");
    expect(() =>
      service.requestSettings("owner", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings: { ...settings, cpuCores: 5 },
      }),
    ).toThrow("envelope");
    expect(() =>
      service.requestSettings("owner", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings: { ...settings, leaseUntil: now + MAX_LOCAL_WORK_LEASE_MS + 1 },
      }),
    ).toThrow("finite lease");
    service.requestSettings("owner", deviceId, {
      expectedRevision: 0,
      expectedGeneration: 1,
      settings,
    });
    expect(() =>
      service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 2 }),
    ).toThrow("revision");
    const rejected = service.heartbeat(auth, policy(deviceId, disabled), {
      ceiling,
      settings: disabled,
      appliedRevision: 0,
      rejectedRevision: 1,
      error: { code: "LOCAL_STORAGE_UNSAFE", message: "Owned disk resize did not settle." },
    });
    expect(rejected.control).toMatchObject({ status: "rejected", revision: 1, appliedRevision: 0 });
    expect(rejected.policy.enabled).toBe(false);
  });
  test("local reapproval permits an ordinary 8 to 50 GiB request without claiming a resize before its applied acknowledgement", () => {
    const { deviceId, auth } = enrolled();
    const applied = { ...settings, storageBytes: 8 * GiB };
    const initialCeiling = { ...ceiling, storageBytes: 8 * GiB };
    const largerCeiling = { ...initialCeiling, storageBytes: 50 * GiB };
    const requested = { ...applied, storageBytes: 50 * GiB };
    service.heartbeat(auth, policy(deviceId, applied), {
      ceiling: initialCeiling,
      settings: applied,
      appliedRevision: 0,
    });
    expect(() =>
      service.requestSettings("owner", deviceId, {
        expectedRevision: 0,
        expectedGeneration: 1,
        settings: requested,
      }),
    ).toThrow("envelope");
    const before = service.getActiveDevice("owner", deviceId);
    const report = { ceiling: largerCeiling, settings: applied, appliedRevision: 0 };
    const reapproved = service.heartbeat(auth, policy(deviceId, applied), report);
    expect(reapproved.control).toEqual({ ...before.control, ceiling: largerCeiling });
    expect(reapproved.policy).toEqual(before.policy);
    expect(reapproved.deviceGeneration).toBe(before.deviceGeneration);
    expect(reapproved.connectionId).toBe(before.connectionId);
    expect(service.heartbeat(auth, policy(deviceId, applied), report)).toEqual(reapproved);
    const pending = service.requestSettings("owner", deviceId, {
      expectedRevision: 0,
      expectedGeneration: 1,
      settings: requested,
    });
    expect(pending.control).toMatchObject({
      status: "pending",
      revision: 1,
      appliedRevision: 0,
      settings: requested,
    });
    expect(pending.policy.machine.storageBytes).toBe(8 * GiB);
    expect(service.heartbeat(auth, policy(deviceId, applied), report).control).toEqual(
      pending.control,
    );
    const acknowledged = service.heartbeat(auth, policy(deviceId, requested), {
      ...report,
      settings: requested,
      appliedRevision: 1,
    });
    expect(acknowledged.control).toMatchObject({
      status: "applied",
      revision: 1,
      appliedRevision: 1,
    });
    expect(acknowledged.policy.machine.storageBytes).toBe(50 * GiB);
  });
  test("a lowered local ceiling preserves an outstanding request until the companion reports its ordinary rejection", () => {
    const { deviceId, auth } = enrolled();
    service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 0 });
    const pending = service.requestSettings("owner", deviceId, {
      expectedRevision: 0,
      expectedGeneration: 1,
      settings: { ...settings, storageBytes: 64 * GiB },
    });
    const lowerCeiling = { ...ceiling, storageBytes: 50 * GiB };
    const report = { ceiling: lowerCeiling, settings, appliedRevision: 0 };
    const reapproved = service.heartbeat(auth, policy(deviceId), report);
    expect(reapproved.control).toEqual({ ...pending.control, ceiling: lowerCeiling });
    expect(reapproved.policy).toEqual(pending.policy);
    const error = {
      code: "LOCAL_CONTROL_FAILED",
      message: "Local control ceiling exceeded: storageBytes",
    };
    const rejected = service.heartbeat(auth, policy(deviceId), {
      ...report,
      rejectedRevision: 1,
      error,
    });
    expect(rejected.control).toEqual({ ...reapproved.control, status: "rejected", error });
    expect(rejected.policy.machine.storageBytes).toBe(32 * GiB);
  });
  test("an enabled policy whose lease expired still reports a locally reapproved ceiling for management", () => {
    const { deviceId, auth } = enrolled();
    const expired = { ...settings, leaseUntil: now - 1 };
    service.heartbeat(auth, policy(deviceId, expired), {
      ceiling,
      settings: expired,
      appliedRevision: 0,
    });
    const renewedCeiling = { ...ceiling, storageBytes: 96 * GiB };
    const reported = service.heartbeat(auth, policy(deviceId, expired), {
      ceiling: renewedCeiling,
      settings: expired,
      appliedRevision: 0,
    });
    expect(reported.control?.ceiling).toEqual(renewedCeiling);
    expect(reported.policy).toEqual(policy(deviceId, expired));
    expect(service.claim(auth)).toEqual([]);
  });
  test.each([
    ["cpuCores", 5],
    ["memoryBytes", 9 * GiB],
    ["storageBytes", 65 * GiB],
    ["dockerBytes", 9 * GiB],
  ] as const)(
    "an applied %s value above the reported local ceiling refuses the heartbeat without changing stored authority",
    (key, value) => {
      const { deviceId, auth } = enrolled();
      service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 0 });
      const before = service.getActiveDevice("owner", deviceId);
      const invalid = { ...settings, [key]: value };
      expect(() =>
        service.heartbeat(auth, policy(deviceId, invalid), {
          ceiling,
          settings: invalid,
          appliedRevision: 0,
        }),
      ).toThrow("Applied resources exceed the locally approved envelope");
      expect(service.getActiveDevice("owner", deviceId)).toEqual(before);
    },
  );
  test("settings route requires actual browser session and origin; bearer/MCP cannot write", async () => {
    const { deviceId, auth } = enrolled();
    service.heartbeat(auth, policy(deviceId), { ceiling, settings, appliedRevision: 0 });
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, {
        userId: "owner",
        ...(req.get("X-Fixture-Session") === "yes"
          ? { session: { token: "fixture-session" } }
          : {}),
      });
      next();
    });
    app.use(createLocalDeviceManagementRoutes(service, "https://moira.example"));
    const path = `/devices/${deviceId}/settings`,
      body = { expectedRevision: 0, expectedGeneration: 1, settings };
    expect(
      (await request(app).put(path).set("Origin", "https://moira.example").send(body)).status,
    ).toBe(401);
    expect((await request(app).put(path).set("X-Fixture-Session", "yes").send(body)).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .put(path)
          .set("X-Fixture-Session", "yes")
          .set("Origin", "https://moira.example")
          .set("Authorization", "Bearer fixture")
          .send(body)
      ).status,
    ).toBe(401);
    const saved = await request(app)
      .put(path)
      .set("X-Fixture-Session", "yes")
      .set("Origin", "https://moira.example")
      .send(body);
    expect(saved.status).toBe(200);
    expect(saved.body.data.control.status).toBe("pending");
    const forbiddenCeiling = await request(app)
      .put(path)
      .set("X-Fixture-Session", "yes")
      .set("Origin", "https://moira.example")
      .send({ ...body, ceiling: { ...ceiling, storageBytes: 128 * GiB } });
    expect(forbiddenCeiling.status).toBe(400);
    expect(service.getActiveDevice("owner", deviceId).control).toEqual(saved.body.data.control);
  });
});
