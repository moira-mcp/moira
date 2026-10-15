import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import httpRequest from "supertest";
import {
  LocalDeviceRepository,
  LocalDeviceService,
  LocalResourceRepository,
  WorkspaceAuthRepository,
  localRepositoryTargetId,
  type LocalDeviceView,
  ScopedCredentialError,
} from "@mcp-moira/shared";
import {
  createLocalDeviceManagementRoutes,
  createLocalDeviceRoutes,
} from "../../packages/web-backend/src/routes/local-devices.js";

let sqlite: Database.Database, service: LocalDeviceService, now: number;
const repositoryId = "b4ba0360-a0bf-4b80-a739-8a62671c403a";
async function enroll(userId = "user-a") {
  const pair = service.beginEnrollment(userId),
    credential = randomBytes(32).toString("base64url");
  const pending = service.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    deviceId: randomUUID(),
    label: "My computer",
  });
  const device = await service.confirmEnrollment(userId, pair.pairingId, 2);
  return { device, credential, pair, pending };
}
function bind(device: LocalDeviceView) {
  const resourceId = randomUUID();
  new LocalResourceRepository(sqlite).reserve({
    id: resourceId,
    userId: device.userId,
    connectionId: device.connectionId,
    authorizationGeneration: 1,
    repositoryId: localRepositoryTargetId(device.deviceId, repositoryId),
    repositoryFullName: "owner/project",
    requestedRef: "main",
    operationMarker: `moira-${randomBytes(12).toString("hex")}`,
    routeGeneration: 1,
    createdAt: now,
    retiredAt: null,
    retiredGeneration: null,
    retiredRequestId: null,
  });
  service.bindResource({ ...device, resourceId, repositoryId, profileId: "local-approved" });
  return resourceId;
}
beforeEach(() => {
  now = 1791000000000;
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  migrate(drizzle(sqlite), { migrationsFolder: path.resolve("packages/web-backend/drizzle") });
  for (const id of ["user-a", "user-b"])
    sqlite
      .prepare(
        `INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified)
    VALUES(?,?,?,'before','before','approved',1)`,
      )
      .run(id, `${id}@example.test`, id);
  service = new LocalDeviceService(new LocalDeviceRepository(sqlite), () => now);
});
afterEach(() => {
  sqlite.close();
});

describe("Local registration, revocation and owner routing", () => {
  test("device revocation fences its bearer before a refused remote child disposal", async () => {
    const first = await enroll(),
      second = await enroll();
    service = new LocalDeviceService(
      new LocalDeviceRepository(sqlite),
      () => now,
      undefined,
      async () => {
        expect(() => service.authenticateDevice(first.credential)).toThrow("Device access denied");
        throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
      },
    );
    await expect(service.revokeOwned("user-a", first.device.deviceId, 1)).rejects.toMatchObject({
      code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
    });
    expect(service.getDeviceIdentity("user-a", first.device.deviceId).status).toBe("revoked");
    expect(service.authenticateDevice(second.credential).deviceId).toBe(second.device.deviceId);
  });
  test("requires local approval and a fresh owner confirmation; persists only credential digests", async () => {
    const pair = service.beginEnrollment("user-a"),
      credential = randomBytes(32).toString("base64url");
    await expect(service.confirmEnrollment("user-a", pair.pairingId, 1)).rejects.toThrow(
      "Read the current device",
    );
    const input = {
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential,
      deviceId: randomUUID(),
      label: "My computer",
    };
    const device = service.approveLocalEnrollment(input);
    expect(device.status).toBe("pending");
    expect(() => service.authenticateDevice(credential)).toThrow("Device access denied");
    await expect(service.confirmEnrollment("user-b", pair.pairingId, 2)).rejects.toThrow(
      "Pairing expired",
    );
    await expect(service.confirmEnrollment("user-a", pair.pairingId, 1)).rejects.toThrow(
      "Read the current device",
    );
    const active = await service.confirmEnrollment("user-a", pair.pairingId, 2);
    expect(active.owner).toEqual({ state: "unavailable" });
    expect(service.authenticateDevice(credential).deviceId).toBe(device.deviceId);
    expect(service.approveLocalEnrollment(input).status).toBe("active");
    const stored = sqlite.serialize();
    expect(stored.includes(Buffer.from(credential))).toBe(false);
    expect(stored.includes(Buffer.from(pair.pairingToken))).toBe(false);
  });
  test("expires an unused pairing and preserves existing GitHub connection data", () => {
    sqlite
      .prepare(
        `INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
      VALUES('github','user-a','github-codespaces','github-owner','owner','connected',7,1,1)`,
      )
      .run();
    const pair = service.beginEnrollment("user-a");
    now = pair.expiresAt;
    expect(() =>
      service.approveLocalEnrollment({
        pairingId: pair.pairingId,
        pairingToken: pair.pairingToken,
        credential: randomBytes(32).toString("base64url"),
        deviceId: randomUUID(),
        label: "My computer",
      }),
    ).toThrow("expired");
    expect(
      sqlite
        .prepare(
          "SELECT externalAccountId,credentialGeneration,status FROM codespaceConnection WHERE id='github'",
        )
        .get(),
    ).toEqual({ externalAccountId: "github-owner", credentialGeneration: 7, status: "connected" });
  });
  test("HTTP enrollment enforces origin, separates browser/device auth, and confirms exact local grants", async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { userId: "user-a" });
      next();
    });
    app.use(
      "/api/integrations/local",
      createLocalDeviceManagementRoutes(service, "https://moira.example", (_req, _res, next) =>
        next(),
      ),
    );
    app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
    const denied = await httpRequest(app)
      .post("/api/integrations/local/pairings")
      .set("Origin", "https://attacker.example")
      .send({});
    expect(denied.status).toBe(403);
    const pairResponse = await httpRequest(app).post("/api/integrations/local/pairings").send({});
    expect(pairResponse.status).toBe(201);
    const pair = pairResponse.body.data,
      credential = randomBytes(32).toString("base64url");
    const enrollResponse = await httpRequest(app).post("/api/local-devices/enroll").send({
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential,
      deviceId: randomUUID(),
      label: "My computer",
    });
    expect(enrollResponse.status).toBe(201);
    expect(enrollResponse.body.data.status).toBe("pending");
    const pending = await httpRequest(app)
      .post("/api/local-devices/pairings/status")
      .send({ pairingId: pair.pairingId, pairingToken: pair.pairingToken });
    expect(pending.body.data.pairing.state).toBe("waiting_confirmation");
    const confirmed = await httpRequest(app)
      .post(`/api/integrations/local/pairings/${pair.pairingId}/confirm`)
      .send({ expectedRevision: pending.body.data.pairing.revision });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe("active");
    const unauthenticated = await httpRequest(app).post("/api/local-devices/heartbeat").send({});
    expect(unauthenticated.status).toBe(401);
    const authenticated = await httpRequest(app)
      .post("/api/local-devices/heartbeat")
      .set("Authorization", `Bearer ${credential}`)
      .send({});
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.data).toMatchObject({
      status: "active",
      deviceId: confirmed.body.data.deviceId,
    });
    expect(authenticated.body.data).not.toHaveProperty("policy");
    expect(authenticated.body.data).not.toHaveProperty("control");
    expect(confirmed.body.data.owner).toEqual({ state: "unavailable" });
    expect(JSON.stringify(confirmed.body)).not.toContain(credential);
  });
  test("authenticated heartbeat preserves an unresolved Local route without restoring cloud lifecycle dispatch", async () => {
    const { device, credential } = await enroll(),
      resourceId = bind(device);
    const before = sqlite.prepare("SELECT * FROM localResourceIdentity WHERE id=?").get(resourceId);
    const app = express();
    app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
    const response = await httpRequest(app)
      .post("/api/local-devices/heartbeat")
      .set("Authorization", `Bearer ${credential}`)
      .send({});
    expect(response.status).toBe(200);
    expect(
      sqlite.prepare("SELECT * FROM localResourceIdentity WHERE id=?").get(resourceId),
    ).toEqual(before);
    expect(service.getBinding("user-a", resourceId)?.deviceId).toBe(device.deviceId);
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codespaceProviderMutation','codespaceOperation','codespacePolicyUsage')",
        )
        .all(),
    ).toEqual([]);
  });
  test("upgrades the actual master journal without changing existing GitHub metadata or credentials", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moira-local-upgrade-")),
      upgraded = new Database(":memory:");
    const migrations = path.resolve("packages/web-backend/drizzle"),
      before = path.join(temp, "before");
    try {
      fs.cpSync(migrations, before, { recursive: true });
      const journalPath = path.join(before, "meta/_journal.json"),
        journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        };
      const newIndex = journal.entries.findIndex(
        (row) => row.tag === "0061_local_controller_authority",
      );
      expect(newIndex).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, newIndex);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      migrate(drizzle(upgraded), { migrationsFolder: before });
      upgraded
        .prepare(
          "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES('existing','existing@example.test','existing','before','before','approved',1)",
        )
        .run();
      upgraded
        .prepare(
          `INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
        VALUES('existing-github','existing','github-codespaces','101','owner','connected',7,1,1)`,
        )
        .run();
      upgraded
        .prepare(
          `INSERT INTO codespaceCredentialVault(connectionId,envelopeVersion,keyVersion,iv,authTag,ciphertext,generation,updatedAt)
        VALUES('existing-github',2,'key','iv','tag','encrypted-existing',7,1)`,
        )
        .run();
      const deviceId = randomUUID(),
        resourceId = randomUUID(),
        githubResourceId = randomUUID(),
        requestId = randomUUID(),
        transferId = randomUUID();
      upgraded
        .prepare(
          `INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
        VALUES('old-local','existing','local-sandboxes','existing','Local devices','connected',1,1,1)`,
        )
        .run();
      upgraded
        .prepare(
          `INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,policy,policyDigest,control,createdAt,updatedAt)
        VALUES(?,'existing','old-local','Historical device',1,'active','old-digest',?,'old-policy-digest',?,1,1)`,
        )
        .run(deviceId, '{"historical":"policy bytes"}', '{"historical":"control bytes"}');
      upgraded
        .prepare(
          `INSERT INTO codespaceConnectionRepository(connectionId,externalInstallationId,externalRepositoryId,fullName,private,createdAt)
        VALUES('old-local',?,?,'owner/old',1,1)`,
        )
        .run(deviceId, "old-repository");
      upgraded
        .prepare(
          `INSERT INTO codespaceResource(id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,operationMarker,
        machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,state,generation,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
        VALUES(?,'existing','old-local',1,'local-sandboxes','old-repository','owner/old','main','moira-old','local-approved','Old','linux',2,4096,8192,'usable',1,1,1,1,1)`,
        )
        .run(resourceId);
      upgraded
        .prepare(
          `INSERT INTO codespaceResource(id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,operationMarker,
        machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,state,generation,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
        SELECT ?,'existing','existing-github',7,'github-codespaces','123','owner/unknown','main','moira-historical-unknown',
        machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,'create_submitted',4,1,1,1,1 FROM codespaceResource WHERE id=?`,
        )
        .run(githubResourceId, resourceId);
      upgraded
        .prepare(
          `INSERT INTO codespaceLocalRelay(requestId,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,digest,inputReference,status,deadlineAt,createdAt,updatedAt)
        VALUES(?,'existing',?,1,'old-local',?,1,'old-digest',?,'claimed',1,1,1)`,
        )
        .run(requestId, deviceId, resourceId, '{"unknown":"never replay"}');
      upgraded
        .prepare(
          `INSERT INTO codespaceTransfer(id,tokenDigest,userId,purpose,state,fileName,mimeType,declaredSize,objectKey,ownerPid,expiresAt,createdAt,updatedAt)
        VALUES(?,'old-transfer-digest','existing','local-relay','ready','old.bin','application/octet-stream',7,'old-object',1,1,1,1)`,
        )
        .run(transferId);
      upgraded
        .prepare(
          "INSERT INTO codespaceLocalRelayPart(transferId,requestId,claimId) VALUES(?,?,'old-claim')",
        )
        .run(transferId, requestId);
      upgraded
        .prepare(
          "INSERT INTO codespaceProviderMutation(id,resourceId,userId,provider,generation,kind,attempt,createdAt) VALUES('old-local-effect',?,'existing','local-sandboxes',1,'delete',1,1)",
        )
        .run(resourceId);
      upgraded
        .prepare(
          "INSERT INTO codespaceProviderMutation(id,resourceId,userId,provider,generation,kind,attempt,createdAt) VALUES('old-github-effect',?,'existing','github-codespaces',7,'start',1,1)",
        )
        .run(resourceId);
      upgraded
        .prepare(
          "INSERT INTO codespacePolicyUsage(userId,provider,utcDay,requiredCleanupOperations,updatedAt) VALUES('existing','local-sandboxes','2026-10-13',9,1),('existing','github-codespaces','2026-10-13',3,1)",
        )
        .run();
      const operationalSources = [
        "codespaceProviderMutation",
        "codespacePolicyUsage",
        "codespaceResource",
      ];
      const localOperational = operationalSources.map((table) =>
        upgraded.prepare("SELECT * FROM " + table + " WHERE provider='local-sandboxes'").all(),
      );
      const githubOperational = operationalSources.map((table) =>
        upgraded.prepare("SELECT * FROM " + table + " WHERE provider='github-codespaces'").all(),
      );
      const sources = [
        "codespaceLocalDevice",
        "codespaceLocalRelay",
        "codespaceLocalRelayPart",
        "codespaceConnectionRepository",
      ];
      const preserved = sources.map((table) => upgraded.prepare("SELECT * FROM " + table).all());
      migrate(drizzle(upgraded), { migrationsFolder: migrations });
      const operationalArchives = [
        "archiveLocalProviderMutation",
        "archiveLocalPolicyUsage",
        "archiveLocalResourceOperational",
      ];
      expect(
        operationalArchives.map((table) => upgraded.prepare("SELECT * FROM " + table).all()),
      ).toEqual(localOperational);
      const githubArchives = [
        "archiveCodespaceProviderMutation",
        "archiveCodespacePolicyUsage",
        "archiveGithubResourceOperational",
      ];
      expect(
        githubArchives.map((table) => upgraded.prepare("SELECT * FROM " + table).all()),
      ).toEqual(githubOperational);
      expect(
        upgraded
          .prepare(
            "SELECT id,generation,authorizationGeneration,providerResourceName,retirement,deviceId FROM githubResourceIdentity WHERE id=?",
          )
          .get(githubResourceId),
      ).toEqual({
        id: githubResourceId,
        generation: 4,
        authorizationGeneration: 7,
        providerResourceName: null,
        retirement: "unknown",
        deviceId: null,
      });
      for (const table of [...operationalArchives, ...githubArchives])
        expect(() => upgraded.prepare("DELETE FROM " + table).run()).toThrow(
          "Read-only historical archive",
        );
      for (const table of operationalSources.slice(0, 2))
        expect(
          upgraded
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .all(table),
        ).toEqual([]);
      expect(
        upgraded.prepare("SELECT name FROM sqlite_master WHERE name='codespaceResource'").get(),
      ).toBeUndefined();
      const archives = [
        "archiveCodespaceLocalDevice",
        "archiveCodespaceLocalRelay",
        "archiveCodespaceLocalRelayPart",
        "archiveLocalConnectionRepository",
      ];
      expect(archives.map((table) => upgraded.prepare("SELECT * FROM " + table).all())).toEqual(
        preserved,
      );
      for (const table of archives) {
        expect(() => upgraded.prepare("DELETE FROM " + table).run()).toThrow(
          "Read-only historical archive",
        );
        expect(upgraded.prepare("SELECT * FROM " + table).all()).toEqual(
          preserved[archives.indexOf(table)],
        );
      }
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('codespaceLocalRelay','codespaceLocalRelayPart')",
          )
          .all(),
      ).toEqual([]);
      expect(
        upgraded
          .prepare("SELECT * FROM codespaceConnectionRepository WHERE connectionId='old-local'")
          .all(),
      ).toEqual([]);
      const upgradedService = new LocalDeviceService(
        new LocalDeviceRepository(upgraded),
        () => now,
      );
      expect(upgradedService.listRegistered("existing").devices).toEqual([
        expect.objectContaining({ deviceId, owner: { state: "unavailable" } }),
      ]);
      expect(
        upgraded
          .prepare(
            "SELECT provider,credentialGeneration,status FROM codespaceConnection WHERE id='existing-github'",
          )
          .get(),
      ).toEqual({ provider: "github-codespaces", credentialGeneration: 7, status: "connected" });
      expect(
        upgraded
          .prepare(
            "SELECT ciphertext,generation FROM codespaceCredentialVault WHERE connectionId='existing-github'",
          )
          .get(),
      ).toEqual({ ciphertext: "encrypted-existing", generation: 7 });
      expect(upgraded.prepare("SELECT COUNT(*) count FROM codespaceLocalDevice").get()).toEqual({
        count: 1,
      });
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  test("minimal Local migration preserves current bindings and guest authority without reviving historical unknown effects", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "moira-local-identity-upgrade-")),
      upgraded = new Database(":memory:"),
      migrations = path.resolve("packages/web-backend/drizzle");
    try {
      upgraded.pragma("foreign_keys=ON");
      fs.cpSync(migrations, temp, { recursive: true });
      const journalPath = path.join(temp, "meta/_journal.json"),
        journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        },
        index = journal.entries.findIndex((entry) => entry.tag === "0064_local_resource_identity");
      expect(index).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, index);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      migrate(drizzle(upgraded), { migrationsFolder: temp });
      upgraded
        .prepare(
          "INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES('existing','existing@example.test','existing','before','before')",
        )
        .run();
      upgraded
        .prepare(
          "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES('local','existing','local-sandboxes','existing','Local','connected',3,1,1)",
        )
        .run();
      const deviceId = randomUUID(),
        localRepository = randomUUID(),
        resourceId = randomUUID();
      upgraded
        .prepare(
          "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES(?,'existing','local','Same device',7,'active','original-digest',1,1)",
        )
        .run(deviceId);
      const insert = upgraded.prepare(`INSERT INTO codespaceResource
        (id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,operationMarker,
         machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,
         state,generation,createDeadlineAt,remoteExpiresAt,lastOutcome,createdAt,updatedAt)
        VALUES(?,'existing','local',3,'local-sandboxes',?,'owner/project','main',?,'local-approved','Old machine','linux',2,4096,8192,?,4,5,6,?,7,8)`);
      for (const [id, state] of [
        [resourceId, "usable"],
        ["revoked", "ambiguous"],
        ["unbound", "create_submitted"],
        ["deleted", "deleted"],
      ])
        insert.run(
          id,
          localRepositoryTargetId(deviceId, localRepository),
          "moira-" + id,
          state,
          state === "create_submitted" ? "UNKNOWN-original" : null,
        );
      const bind = upgraded.prepare(
        "INSERT INTO codespaceLocalResourceBinding(resourceId,userId,deviceId,deviceGeneration,repositoryId,profileId,revokedAt) VALUES(?,'existing',?,7,?,'local-approved',?)",
      );
      bind.run(resourceId, deviceId, localRepository, null);
      bind.run("revoked", deviceId, localRepository, 123);
      const auth = new WorkspaceAuthRepository(upgraded),
        credential = auth.issue(
          {
            userId: "existing",
            resourceId,
            resourceGeneration: 4,
            authorizationGeneration: 3,
            environmentIdentity: "a".repeat(64),
          },
          null,
        );
      const rows = upgraded.prepare("SELECT * FROM codespaceResource ORDER BY id").all(),
        bindings = upgraded
          .prepare("SELECT * FROM codespaceLocalResourceBinding ORDER BY resourceId")
          .all(),
        guest = upgraded.prepare("SELECT * FROM workspaceAgentCredential").all(),
        oldArchive = upgraded.prepare("SELECT * FROM archiveLocalResourceOperational").all();
      migrate(drizzle(upgraded), { migrationsFolder: migrations });
      expect(
        upgraded.prepare("SELECT * FROM archiveLocalResourceLegacyCurrent ORDER BY id").all(),
      ).toEqual(rows);
      expect(
        upgraded
          .prepare("SELECT * FROM archiveLocalResourceBindingLegacyCurrent ORDER BY resourceId")
          .all(),
      ).toEqual(bindings);
      expect(
        upgraded.prepare("SELECT * FROM codespaceLocalResourceBinding ORDER BY resourceId").all(),
      ).toEqual(bindings);
      expect(upgraded.prepare("SELECT * FROM workspaceAgentCredential").all()).toEqual(guest);
      expect(auth.authenticate(credential)).toMatchObject({
        resourceId,
        resourceGeneration: 4,
        authorizationGeneration: 3,
        environmentIdentity: "a".repeat(64),
      });
      expect(upgraded.prepare("SELECT * FROM archiveLocalResourceOperational").all()).toEqual(
        oldArchive,
      );
      expect(
        upgraded.prepare("SELECT name FROM sqlite_master WHERE name='codespaceResource'").get(),
      ).toBeUndefined();
      expect(
        (
          upgraded.prepare("PRAGMA table_info(localResourceIdentity)").all() as { name: string }[]
        ).map((row) => row.name),
      ).toEqual([
        "id",
        "userId",
        "connectionId",
        "authorizationGeneration",
        "repositoryId",
        "repositoryFullName",
        "requestedRef",
        "operationMarker",
        "routeGeneration",
        "createdAt",
        "retiredAt",
        "retiredGeneration",
        "retiredRequestId",
      ]);
      expect(
        upgraded
          .prepare(
            "SELECT id,retiredAt,retiredGeneration,retiredRequestId FROM localResourceIdentity ORDER BY id",
          )
          .all(),
      ).toEqual(
        [resourceId, "revoked", "unbound", "deleted"].sort().map((id) => ({
          id,
          retiredAt: id === "deleted" ? 8 : null,
          retiredGeneration: id === "deleted" ? 4 : null,
          retiredRequestId: null,
        })),
      );
      expect(
        new LocalDeviceService(new LocalDeviceRepository(upgraded), () => now).getBinding(
          "existing",
          resourceId,
        ),
      ).toMatchObject({ deviceId, deviceGeneration: 7, repositoryId: localRepository });
      for (const table of [
        "archiveLocalResourceLegacyCurrent",
        "archiveLocalResourceBindingLegacyCurrent",
      ])
        expect(() => upgraded.prepare("DELETE FROM " + table).run()).toThrow(
          "Read-only historical archive",
        );
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
  test.each([
    ["malformed", '{"credential":"SYNTHETIC_PRIVATE_CANARY', 400],
    [
      "oversized",
      JSON.stringify({ credential: "SYNTHETIC_PRIVATE_CANARY", large: "x".repeat(2049 * 1024) }),
      413,
    ],
  ])(
    "sanitizes %s JSON parser failures before the global error consumer",
    async (_kind, body, status) => {
      const app = express();
      app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
      app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) =>
        res.status(500).json({ forwarded: error }),
      );
      const response = await httpRequest(app)
        .post("/api/local-devices/enroll")
        .set("Content-Type", "application/json")
        .send(body);
      expect(response.status).toBe(status);
      expect(response.body).toEqual({
        success: false,
        error: { code: "LOCAL_INVALID", message: "Invalid local-device request." },
      });
      expect(response.text).not.toContain("SYNTHETIC_PRIVATE_CANARY");
    },
  );
  test("offline registry stores identity only and cannot accept operational settings", async () => {
    const { device } = await enroll();
    expect((await service.listOwned("user-a")).devices).toEqual([device]);
    expect(device.owner).toEqual({ state: "unavailable" });
    const columns = (
      sqlite.prepare("PRAGMA table_info(codespaceLocalDevice)").all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).not.toEqual(expect.arrayContaining(["policy", "policyDigest", "control"]));
    const requestId = "ws1-" + randomUUID();
    await expect(
      service.requestSettings("user-a", device.deviceId, {
        requestId,
        expectedGeneration: 1,
        expectedRevision: 0,
        settings: {
          label: "Draft",
          enabled: true,
          leaseUntil: now + 3600000,
          cpuCores: 2,
          memoryBytes: 4 * 1024 ** 3,
          storageBytes: 8 * 1024 ** 3,
          dockerBytes: 4 * 1024 ** 3,
          repositories: [],
          gitAuthor: null,
          agentRepositoryManagement: null,
        },
      }),
    ).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    expect(service.listRegistered("user-a").devices).toEqual([device]);
    expect(sqlite.prepare("SELECT * FROM codespaceConnectionRepository").all()).toEqual([]);
  });
  test("tenant access and device revocation remain isolated from sibling registration", async () => {
    const first = await enroll(),
      second = await enroll(),
      other = await enroll("user-b");
    expect(first.device.connectionId).toBe(second.device.connectionId);
    expect(service.listRegistered("user-a").devices.map((d) => d.deviceId)).toEqual(
      expect.arrayContaining([first.device.deviceId, second.device.deviceId]),
    );
    expect(service.listRegistered("user-a").devices).toHaveLength(2);
    expect(() => service.getDeviceIdentity("user-b", first.device.deviceId)).toThrow(
      "Device access denied",
    );
    await expect(service.revokeOwned("user-b", first.device.deviceId, 1)).rejects.toThrow(
      "Device access denied",
    );
    await expect(
      service.getOperation("user-b", first.device.deviceId, "ws1-" + randomUUID()),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    await expect(service.revokeOwned("user-a", first.device.deviceId, 2)).rejects.toThrow(
      "Device generation changed",
    );
    const revoked = await service.revokeOwned("user-a", first.device.deviceId, 1);
    expect(revoked).toMatchObject({
      status: "revoked",
      deviceGeneration: 2,
      owner: { state: "unavailable" },
    });
    expect(() => service.authenticateDevice(first.credential)).toThrow("Device access denied");
    expect(service.authenticateDevice(second.credential).deviceGeneration).toBe(1);
    expect(service.authenticateDevice(other.credential).userId).toBe("user-b");
    expect(
      sqlite
        .prepare("SELECT status,credentialGeneration FROM codespaceConnection WHERE id=?")
        .get(second.device.connectionId),
    ).toEqual({ status: "connected", credentialGeneration: 1 });
    sqlite.prepare("UPDATE user SET blocked=1 WHERE id='user-a'").run();
    expect(() => service.authenticateDevice(second.credential)).toThrow("Account access");
  });
  test("resource binding refuses reparenting and tenant crossover", async () => {
    const first = await enroll(),
      second = await enroll(),
      other = await enroll("user-b"),
      resourceId = bind(first.device);
    const original = service.getBinding("user-a", resourceId);
    expect(service.getBinding("user-b", resourceId)).toBeNull();
    for (const device of [second.device, other.device])
      expect(() =>
        service.bindResource({ ...device, resourceId, repositoryId, profileId: "local-approved" }),
      ).toThrow();
    expect(service.getBinding("user-a", resourceId)).toEqual(original);
  });
  test("removed dispatcher routes cannot resurrect a queued lifecycle request", async () => {
    const { credential } = await enroll(),
      app = express();
    app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
    for (const route of ["/relay/claim", "/relay/ack", "/relay/" + randomUUID() + "/renew"]) {
      const response = await httpRequest(app)
        .post("/api/local-devices" + route)
        .set("Authorization", "Bearer " + credential)
        .send({});
      expect(response.status).toBe(404);
    }
  });
});
