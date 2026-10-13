import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import httpRequest from "supertest";
import {
  LocalDeviceRepository,
  LocalDeviceService,
  localRepositoryTargetId,
  CodespaceResourceRepository,
  CodespaceResourceService,
  CodespaceProviderRegistry,
  canonicalJson,
  LOCAL_REQUEST_MAX_WINDOW_MS,
  getFeatureResolver,
  setFeatureResolver,
  ModeFeatureResolver,
  type LocalPublicPolicy,
  type LocalDeviceView,
  type LocalLifecycleEnvelope,
  type LocalRelayRequest,
  type CodespaceResourcePolicy,
} from "@mcp-moira/shared";
import {
  createLocalDeviceManagementRoutes,
  createLocalDeviceRoutes,
} from "../../packages/web-backend/src/routes/local-devices.js";
import { LocalCodespaceRelay } from "../../packages/web-backend/src/services/local-codespace-relay.js";

let sqlite: Database.Database, service: LocalDeviceService, now: number;
const repositoryId = "b4ba0360-a0bf-4b80-a739-8a62671c403a";
const serverPolicy: CodespaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 16 * 1024 ** 3,
  maxActivePerUser: 8,
  maxActiveGlobal: 16,
  createThrottleMs: 0,
  startWaitMs: 60_000,
  createDeadlineMs: 60_000,
  cleanupDeadlineMs: 60_000,
  claimLeaseMs: 30_000,
  reconcileIntervalMs: 30_000,
};
function policy(deviceId = randomUUID()): LocalPublicPolicy {
  return {
    version: 1,
    deviceId,
    label: "My computer",
    enabled: true,
    leaseUntil: now + 3600_000,
    repositories: [
      {
        id: repositoryId,
        fullName: "owner/project",
        private: true,
        allowPush: false,
        allowDelete: false,
      },
    ],
    machine: {
      name: "local-approved",
      displayName: "My computer",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 8 * 1024 ** 3,
    },
  };
}
function enroll(userId = "user-a", input = policy()) {
  const pair = service.beginEnrollment(userId),
    credential = randomBytes(32).toString("base64url");
  const device = service.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    policy: input,
  });
  const pending = service.pairingStatus({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
  });
  const active = service.confirmEnrollment(userId, pair.pairingId, pending.pairing.revision);
  return { device: active, credential, pair, pending: device };
}
function bind(device: LocalDeviceView) {
  const resourceId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO codespaceResource(id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,
    operationMarker,machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,
    state,generation,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
    VALUES(?,?,?,1,'local-sandboxes',?,'owner/project','main',?,'local-approved','My computer','linux',2,?,?, 'usable',1,?,?,?,?)`,
    )
    .run(
      resourceId,
      device.userId,
      device.connectionId,
      localRepositoryTargetId(device.deviceId, repositoryId),
      `moira-${randomBytes(12).toString("hex")}`,
      4 * 1024 ** 3,
      8 * 1024 ** 3,
      now + 60_000,
      now + 3600_000,
      now,
      now,
    );
  service.bindResource({ ...device, resourceId, repositoryId, profileId: "local-approved" });
  return resourceId;
}
function payload(): LocalLifecycleEnvelope {
  return {
    version: 1,
    id: randomUUID(),
    expiresAt: now + 300_000,
    request: { action: "snapshot" },
  };
}
function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function newRequest(
  original: LocalRelayRequest,
  deadlineAt = original.deadlineAt,
): LocalRelayRequest {
  const envelope = { ...original.payload, id: randomUUID(), expiresAt: deadlineAt };
  return {
    ...original,
    requestId: envelope.id,
    deadlineAt,
    payload: envelope,
    digest: digestOf(envelope),
  };
}
function queue(device: LocalDeviceView, resourceId: string, envelope = payload()) {
  const request = {
    userId: device.userId,
    deviceId: device.deviceId,
    deviceGeneration: device.deviceGeneration,
    connectionId: device.connectionId,
    requestId: envelope.id,
    resourceId,
    resourceGeneration: 1,
    digest: digestOf(envelope),
    payload: envelope,
    deadlineAt: envelope.expiresAt,
  };
  service.enqueue(request);
  return request;
}
function githubResource(localResourceId: string): string {
  sqlite
    .prepare(
      `INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
    VALUES('github','user-a','github-codespaces','github-owner','owner','connected',1,1,1)`,
    )
    .run();
  const resourceId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO codespaceResource(id,userId,connectionId,authorizationGeneration,provider,repositoryId,repositoryFullName,requestedRef,
    operationMarker,machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,
    state,generation,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt)
    SELECT ?,userId,'github',authorizationGeneration,'github-codespaces','100',repositoryFullName,requestedRef,
    ?,machineName,machineDisplayName,machineOperatingSystem,machineCpuCores,machineMemoryBytes,machineStorageBytes,
    'create_pending',generation,createDeadlineAt,remoteExpiresAt,createdAt,updatedAt+1 FROM codespaceResource WHERE id=?`,
    )
    .run(resourceId, `marker-${resourceId}`, localResourceId);
  sqlite
    .prepare("UPDATE codespaceResource SET state='create_pending' WHERE id=?")
    .run(localResourceId);
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

describe("Durable local device enrollment and relay", () => {
  test("enrollment and settings retain the exact owner budget without Moira hardware ceilings", () => {
    const approved = policy();
    approved.machine = {
      ...approved.machine,
      cpuCores: 64,
      memoryBytes: 128 * 1024 ** 3,
      storageBytes: 2 * 1024 ** 4,
    };
    const { device, credential } = enroll("user-a", approved);
    expect(device.policy.machine).toEqual(approved.machine);
    expect(service.getActiveDevice("user-a", device.deviceId).policy.machine).toEqual(
      approved.machine,
    );
    const settings = {
      label: approved.label,
      enabled: approved.enabled,
      leaseUntil: approved.leaseUntil,
      cpuCores: approved.machine.cpuCores,
      memoryBytes: approved.machine.memoryBytes,
      storageBytes: approved.machine.storageBytes,
      dockerBytes: 256 * 1024 ** 3,
      repositories: approved.repositories,
      gitAuthor: null,
      agentRepositoryManagement: null,
    };
    const ceiling = {
      cpuCores: 64,
      memoryBytes: 256 * 1024 ** 3,
      storageBytes: 3 * 1024 ** 4,
      dockerBytes: 512 * 1024 ** 3,
      maxLeaseMs: 3600_000,
    };
    service.heartbeat(service.authenticateDevice(credential), approved, {
      settings,
      ceiling,
      appliedRevision: 0,
    });
    const next = { ...settings, cpuCores: 48, memoryBytes: 192 * 1024 ** 3 + 512 * 1024 ** 2 };
    const accepted = service.requestSettings("user-a", device.deviceId, {
      expectedGeneration: device.deviceGeneration,
      expectedRevision: 0,
      settings: next,
    });
    expect(accepted.control).toMatchObject({
      revision: 1,
      status: "pending",
      settings: next,
      ceiling,
    });
    expect(accepted.policy).toEqual(approved);
    expect(() =>
      service.requestSettings("user-a", device.deviceId, {
        expectedGeneration: device.deviceGeneration,
        expectedRevision: 1,
        settings: { ...next, cpuCores: ceiling.cpuCores + 1 },
      }),
    ).toThrow("locally approved envelope");
    expect(service.getActiveDevice("user-a", device.deviceId)).toEqual(accepted);
  });
  test("legacy private-part relay archives are neither replayed nor pruned by inline lifecycle", () => {
    const { device, credential } = enroll();
    const resourceId = bind(device);
    const current = queue(device, resourceId);
    const archivedId = randomUUID();
    const archive = {
      parts: [{ transferId: randomUUID(), sha256: "a".repeat(64), size: 7 }],
      size: 7,
      sha256: "a".repeat(64),
    };
    sqlite
      .prepare(
        `INSERT INTO codespaceLocalRelay(requestId,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,digest,inputReference,status,deadlineAt,createdAt,updatedAt)
      SELECT ?,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,digest,?,'queued',?,?,? FROM codespaceLocalRelay WHERE requestId=?`,
      )
      .run(
        archivedId,
        canonicalJson(archive),
        now - 1,
        now - 7200_000,
        now - 7200_000,
        current.requestId,
      );
    const before = sqlite
      .prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?")
      .get(archivedId);
    service.listOwned("user-a");
    expect(
      service.claim(service.authenticateDevice(credential), 8).map((entry) => entry.requestId),
    ).toEqual([current.requestId]);
    expect(service.getRequest("user-a", archivedId)).toBeNull();
    expect(
      sqlite.prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?").get(archivedId),
    ).toEqual(before);
  });
  test("an accepted lifecycle receipt settles after160 seconds without restoring expired work authority", async () => {
    const { device, credential } = enroll();
    const resourceId = bind(device);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "moira-late-append-receipt-"));
    const request = queue(device, resourceId, { ...payload(), expiresAt: now + 150_000 });
    const auth = service.authenticateDevice(credential);
    const claim = service.claim(auth, 2).find((entry) => entry.requestId === request.requestId)!;
    const effect = path.join(root, "actual-append.txt");
    fs.appendFileSync(effect, "one actual effect\n");
    const receipt = { ok: true as const, result: { observation: fs.readFileSync(effect, "utf8") } };
    const app = express();
    app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
    try {
      now += 160_000;
      service.listOwned("user-a");
      expect(service.getResult("user-a", request.requestId)?.status).toBe("expired");
      expect(() => service.renewClaim(auth, request.requestId, claim.claimId)).toThrow();
      const ack = {
        requestId: request.requestId,
        claimId: claim.claimId,
        digest: request.digest,
        status: "completed",
        outcome: receipt,
      };
      const response = await httpRequest(app)
        .post("/api/local-devices/relay/ack")
        .set("Authorization", `Bearer ${credential}`)
        .send(ack);
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe("completed");
      expect(service.getResult("user-a", request.requestId)?.outcome).toEqual(receipt);
      expect(fs.readFileSync(effect, "utf8")).toBe("one actual effect\n");
      expect(() => service.authorizePayload(auth, request.requestId, claim.claimId)).toThrow();
      const terminalRow = sqlite
        .prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?")
        .get(request.requestId);
      expect(service.renewClaim(auth, request.requestId, claim.claimId)).toMatchObject({
        claimId: claim.claimId,
        claimExpiresAt: claim.claimExpiresAt,
        deadlineAt: claim.deadlineAt,
      });
      expect(
        sqlite
          .prepare("SELECT * FROM codespaceLocalRelay WHERE requestId=?")
          .get(request.requestId),
      ).toEqual(terminalRow);
      const duplicate = await httpRequest(app)
        .post("/api/local-devices/relay/ack")
        .set("Authorization", `Bearer ${credential}`)
        .send(ack);
      expect(duplicate.status).toBe(200);
      const changed = await httpRequest(app)
        .post("/api/local-devices/relay/ack")
        .set("Authorization", `Bearer ${credential}`)
        .send({ ...ack, status: "refused" });
      expect(changed.status).toBe(409);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an expired never-claimed request has no result-only settlement authority", () => {
    const { device, credential } = enroll();
    const request = queue(device, bind(device));
    now = request.deadlineAt + 1;
    service.listOwned("user-a");
    expect(() =>
      service.authorizeResult(
        service.authenticateDevice(credential),
        request.requestId,
        randomUUID(),
      ),
    ).toThrow();
  });
  test.each(["create", "snapshot"] as const)(
    "reserves clock headroom for a fresh full-window %s without changing retained identity",
    async (action) => {
      const { device } = enroll(),
        resourceId = bind(device);
      sqlite
        .prepare("UPDATE codespaceResource SET createDeadlineAt=? WHERE id=?")
        .run(now + LOCAL_REQUEST_MAX_WINDOW_MS, resourceId);
      const resource = new CodespaceResourceRepository(sqlite).getOwned("user-a", resourceId)!;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-relay-clock-window-"));
      try {
        const relay = new LocalCodespaceRelay(service, () => now);
        const input =
          action === "create"
            ? { action, repositoryId, ref: "main", operationMarker: resource.operationMarker }
            : { action };
        const options = { mutation: true, waitMs: LOCAL_REQUEST_MAX_WINDOW_MS };
        const queued = await relay.retain(resource, input, options);
        expect(queued.payload.expiresAt).toBe(now + 870_000);
        now += 5000;
        const repeated = await relay.retain(resource, input, options);
        expect(repeated).toEqual(queued);
        expect(repeated.payload).toEqual(queued.payload);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test.each(["short request", "resource deadline", "device lease"] as const)(
    "clock headroom preserves the tighter %s boundary",
    async (boundary) => {
      const approved = policy();
      if (boundary === "device lease") approved.leaseUntil = now + 20_000;
      const { device } = enroll("user-a", approved),
        resourceId = bind(device);
      const createDeadline = now + (boundary === "resource deadline" ? 15_000 : 900_000);
      sqlite
        .prepare("UPDATE codespaceResource SET createDeadlineAt=? WHERE id=?")
        .run(createDeadline, resourceId);
      const resource = new CodespaceResourceRepository(sqlite).getOwned("user-a", resourceId)!;
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-relay-short-window-"));
      try {
        const input =
          boundary === "resource deadline"
            ? {
                action: "create",
                repositoryId,
                ref: "main",
                operationMarker: resource.operationMarker,
              }
            : { action: "snapshot" };
        const queued = await new LocalCodespaceRelay(service, () => now).retain(resource, input, {
          waitMs: boundary === "short request" ? 2000 : LOCAL_REQUEST_MAX_WINDOW_MS,
        });
        const expectedDeadline =
          boundary === "short request"
            ? now + 2000
            : boundary === "resource deadline"
              ? createDeadline
              : approved.leaseUntil;
        expect(queued.payload.expiresAt).toBe(expectedDeadline);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test.each(["snapshot-only", "accepted-delete"] as const)(
    "owner recovery distinguishes %s from an unknown destructive dispatch",
    async (scope) => {
      const { device, credential } = enroll(),
        resourceId = bind(device);
      const repository = new CodespaceResourceRepository(sqlite);
      const pending = repository.requestDelete("user-a", resourceId, 1, now);
      if (!pending || typeof pending === "string") throw new Error("Expected pending deletion");
      repository.recordLifecycleFailure(
        resourceId,
        pending.generation,
        "CODESPACE_RESOURCE_INVALID",
        now,
      );
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-owner-recovery-"));
      try {
        const relay = new LocalCodespaceRelay(service, () => now);
        const queued = await relay.retain(
          pending,
          scope === "snapshot-only"
            ? { action: "snapshot" }
            : { action: "delete", spaceId: pending.id, generation: pending.generation },
          { mutation: scope === "accepted-delete", waitMs: LOCAL_REQUEST_MAX_WINDOW_MS },
        );
        if (scope === "snapshot-only") {
          const output = { ok: true, result: { observation: "saved scoped observation" } };
          sqlite
            .prepare(
              "UPDATE codespaceLocalRelay SET status='completed',outputReference=? WHERE requestId=?",
            )
            .run(canonicalJson(output), queued.requestId);
        } else
          expect(service.claim(service.authenticateDevice(credential))[0].requestId).toBe(
            queued.requestId,
          );
        const settings = {
          label: device.label,
          enabled: true,
          leaseUntil: device.policy.leaseUntil,
          cpuCores: 2,
          memoryBytes: 4 * 1024 ** 3,
          storageBytes: 8 * 1024 ** 3,
          dockerBytes: 2 * 1024 ** 3,
          repositories: device.policy.repositories,
          gitAuthor: null,
          agentRepositoryManagement: null,
        };
        sqlite.prepare("UPDATE codespaceLocalDevice SET control=? WHERE id=?").run(
          canonicalJson({
            optedIn: true,
            revision: 1,
            appliedRevision: 1,
            status: "applied",
            settings,
            ceiling: null,
            error: null,
          }),
          device.deviceId,
        );
        const recovered = repository.requestDelete(
          "user-a",
          resourceId,
          pending.generation,
          now,
          true,
        );
        expect(recovered).toMatchObject({
          generation: pending.generation + (scope === "snapshot-only" ? 1 : 0),
          state: "delete_pending",
        });
        if (!recovered || typeof recovered === "string")
          throw new Error("Expected retained resource");
        expect(repository.isOwnerDeleteIntent("user-a", resourceId, recovered.generation)).toBe(
          scope === "snapshot-only",
        );
        const cleanup = await relay.retain(
          recovered,
          { action: "delete", spaceId: recovered.id, generation: recovered.generation },
          { mutation: true, waitMs: LOCAL_REQUEST_MAX_WINDOW_MS },
        );
        expect(cleanup.payload.expiresAt).toBe(now + 870_000);
        expect(cleanup.authority).toBe(scope === "snapshot-only" ? "owner-delete" : undefined);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test.each([
    ["self-host", "approved", 0, 0, true],
    ["saas", null, 1, 0, true],
    ["saas", null, 0, 0, false],
    ["self-host", "approved", 1, 1, false],
  ] as const)(
    "atomic owner cleanup respects %s account admission with approved=%s email=%s blocked=%s",
    (mode, approvedAt, emailVerified, blocked, admitted) => {
      const { device } = enroll(),
        resourceId = bind(device);
      const settings = {
        label: device.label,
        enabled: true,
        leaseUntil: device.policy.leaseUntil,
        cpuCores: 2,
        memoryBytes: 4 * 1024 ** 3,
        storageBytes: 8 * 1024 ** 3,
        dockerBytes: 2 * 1024 ** 3,
        repositories: device.policy.repositories,
        gitAuthor: null,
        agentRepositoryManagement: null,
      };
      sqlite.prepare("UPDATE codespaceLocalDevice SET control=? WHERE id=?").run(
        JSON.stringify({
          optedIn: true,
          revision: 1,
          appliedRevision: 1,
          status: "applied",
          settings,
          ceiling: null,
          error: null,
        }),
        device.deviceId,
      );
      sqlite
        .prepare("UPDATE user SET approvedAt=?,emailVerified=?,blocked=? WHERE id='user-a'")
        .run(approvedAt, emailVerified, blocked);
      const previousMode = process.env.DEPLOYMENT_MODE,
        resolver = getFeatureResolver();
      try {
        process.env.DEPLOYMENT_MODE = mode;
        setFeatureResolver(new ModeFeatureResolver());
        const result = new CodespaceResourceRepository(sqlite).requestDelete(
          "user-a",
          resourceId,
          1,
          now,
          true,
        );
        if (admitted) expect(result).toMatchObject({ generation: 2, state: "delete_pending" });
        else expect(result).toBe("unauthorized");
      } finally {
        if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = previousMode;
        setFeatureResolver(resolver);
      }
    },
  );
  test("owner deletion authority survives an expired work lease without widening agent grants", () => {
    const { device, credential } = enroll(),
      resourceId = bind(device);
    const originalPolicy = JSON.stringify(device.policy);
    const repository = new CodespaceResourceRepository(sqlite);
    expect(repository.requestDelete("user-a", resourceId, 1, now, true)).toBe("unauthorized");
    expect(repository.getOwned("user-a", resourceId)).toMatchObject({
      generation: 1,
      state: "usable",
    });
    const ordinary = queue(device, resourceId);
    expect(() => service.enqueue({ ...newRequest(ordinary), authority: "owner-delete" })).toThrow(
      "Relay authority does not match its mutation",
    );
    expect(service.getRequest("user-a", ordinary.requestId)).not.toHaveProperty("authority");
    const settings = {
      label: device.label,
      enabled: false,
      leaseUntil: now - 1,
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 8 * 1024 ** 3,
      dockerBytes: 2 * 1024 ** 3,
      repositories: device.policy.repositories,
      gitAuthor: null,
      agentRepositoryManagement: null,
    };
    sqlite.prepare("UPDATE codespaceLocalDevice SET control=? WHERE id=?").run(
      JSON.stringify({
        optedIn: true,
        revision: 1,
        appliedRevision: 1,
        status: "applied",
        settings,
        ceiling: null,
        error: null,
      }),
      device.deviceId,
    );
    const requested = repository.requestDelete("user-a", resourceId, 1, now, true);
    expect(requested).toMatchObject({ generation: 2, state: "delete_pending" });
    now = device.policy.leaseUntil + 1;
    expect(service.claim(service.authenticateDevice(credential))).toEqual([]);
    const reference: LocalLifecycleEnvelope = {
      ...payload(),
      expiresAt: now + 120_000,
      authority: "owner-delete",
      request: { action: "delete", spaceId: resourceId, generation: 2 },
    };
    const request = {
      userId: device.userId,
      deviceId: device.deviceId,
      deviceGeneration: device.deviceGeneration,
      connectionId: device.connectionId,
      requestId: reference.id,
      resourceId,
      resourceGeneration: 2,
      authority: "owner-delete" as const,
      digest: digestOf(reference),
      payload: reference,
      deadlineAt: reference.expiresAt,
    };
    service.enqueue(request);
    service = new LocalDeviceService(new LocalDeviceRepository(sqlite), () => now);
    expect(service.getRequest("user-a", request.requestId)?.authority).toBe("owner-delete");
    const auth = service.authenticateDevice(credential);
    const claim = service.claim(auth)[0];
    expect(claim.authority).toBe("owner-delete");
    expect(service.authorizePayload(auth, request.requestId, claim.claimId).authority).toBe(
      "owner-delete",
    );
    expect(service.renewClaim(auth, request.requestId, claim.claimId).claimExpiresAt).toBe(
      now + 30_000,
    );
    const output = { ok: true as const, result: { removed: resourceId } };
    const ack = {
      requestId: request.requestId,
      digest: request.digest,
      claimId: claim.claimId,
      status: "completed" as const,
      outcome: output,
    };
    expect(service.acknowledge(auth, ack).status).toBe("completed");
    now = request.deadlineAt + 1;
    expect(service.acknowledge(auth, ack).status).toBe("completed");
    expect(JSON.stringify(service.getActiveDevice("user-a", device.deviceId).policy)).toBe(
      originalPolicy,
    );
    expect(() =>
      service.enqueue({ ...request, requestId: randomUUID(), authority: undefined }),
    ).toThrow();
    sqlite.prepare("UPDATE codespaceLocalDevice SET control=NULL WHERE id=?").run(device.deviceId);
    expect(() => service.acknowledge(auth, ack)).toThrow();
  });
  test("requires local approval and a fresh owner confirmation; persists only credential digests", () => {
    const pair = service.beginEnrollment("user-a"),
      credential = randomBytes(32).toString("base64url");
    expect(() => service.confirmEnrollment("user-a", pair.pairingId, 1)).toThrow(
      "Read the current device",
    );
    const input = {
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential,
      policy: policy(),
    };
    const device = service.approveLocalEnrollment(input);
    expect(device.status).toBe("pending");
    expect(() => service.authenticateDevice(credential)).toThrow("Device access denied");
    expect(() => service.confirmEnrollment("user-b", pair.pairingId, 2)).toThrow("Pairing expired");
    expect(() => service.confirmEnrollment("user-a", pair.pairingId, 1)).toThrow(
      "Read the current device",
    );
    service.confirmEnrollment("user-a", pair.pairingId, 2);
    expect(service.authenticateDevice(credential).deviceId).toBe(device.deviceId);
    expect(service.approveLocalEnrollment(input).status).toBe("active");
    const stored = sqlite.serialize();
    expect(stored.includes(Buffer.from(credential))).toBe(false);
    expect(stored.includes(Buffer.from(pair.pairingToken))).toBe(false);
  });
  test("qualifies repository targets per device and revokes one without invalidating its sibling", () => {
    const first = enroll(),
      second = enroll();
    expect(first.device.connectionId).toBe(second.device.connectionId);
    const grants = sqlite
      .prepare(
        "SELECT externalRepositoryId,externalInstallationId FROM codespaceConnectionRepository ORDER BY externalRepositoryId",
      )
      .all() as { externalRepositoryId: string; externalInstallationId: string }[];
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.externalInstallationId).sort()).toEqual(
      [first.device.deviceId, second.device.deviceId].sort(),
    );
    const resource = bind(first.device),
      request = queue(first.device, resource);
    service.revokeOwned("user-a", first.device.deviceId, 1);
    expect(service.getResult("user-a", request.requestId)?.status).toBe("revoked");
    expect(() => service.authenticateDevice(first.credential)).toThrow();
    expect(service.authenticateDevice(second.credential).deviceGeneration).toBe(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) count FROM codespaceConnectionRepository").get(),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare("SELECT credentialGeneration FROM codespaceConnection WHERE id=?")
        .get(second.device.connectionId),
    ).toEqual({ credentialGeneration: 1 });
  });
  test("rejects resource rebinding and cross-user lifecycle requests before inserting a request", () => {
    const first = enroll(),
      second = enroll(),
      resource = bind(first.device);
    expect(() =>
      service.bindResource({
        userId: "user-a",
        deviceId: second.device.deviceId,
        deviceGeneration: 1,
        connectionId: second.device.connectionId,
        resourceId: resource,
        repositoryId,
        profileId: "local-approved",
      }),
    ).toThrow();
    expect(() => queue(enroll("user-b").device, resource)).toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelay").get()).toEqual({
      count: 0,
    });
  });
  test("replays exact persisted identity after receipt loss and refuses changed input", () => {
    const { device } = enroll(),
      resource = bind(device),
      request = queue(device, resource);
    expect(service.enqueue(request).status).toBe("queued");
    expect(service.getRequest("user-a", request.requestId)).toEqual(request);
    expect(service.getRequest("user-b", request.requestId)).toBeNull();
    const changed = { ...request.payload, request: { action: "stop" as const, spaceId: resource } };
    expect(() =>
      service.enqueue({ ...request, payload: changed, digest: digestOf(changed) }),
    ).toThrow("Relay request identity changed");
    expect(sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelay").get()).toEqual({
      count: 1,
    });
    const columns = (
      sqlite.prepare("PRAGMA table_info(codespaceLocalRelay)").all() as { name: string }[]
    ).map((r) => r.name);
    expect(columns).not.toEqual(
      expect.arrayContaining(["argv", "stdin", "payload", "stdout", "credential"]),
    );
  });
  test("renews one claim and fences stale acknowledgements after redelivery", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      request = queue(device, resource),
      auth = service.authenticateDevice(credential);
    const first = service.claim(auth)[0];
    expect(first.requestId).toBe(request.requestId);
    now += 20_000;
    expect(service.renewClaim(auth, request.requestId, first.claimId).claimExpiresAt).toBe(
      now + 30_000,
    );
    now += 31_000;
    const second = service.claim(auth)[0];
    expect(second.claimId).not.toBe(first.claimId);
    const output = { ok: true as const, result: { observed: true } };
    expect(() =>
      service.acknowledge(auth, {
        requestId: request.requestId,
        digest: request.digest,
        claimId: first.claimId,
        status: "completed",
        outcome: output,
      }),
    ).toThrow("acknowledgement changed");
    const ack = {
      requestId: request.requestId,
      digest: request.digest,
      claimId: second.claimId,
      status: "completed" as const,
      outcome: output,
    };
    expect(service.acknowledge(auth, ack).status).toBe("completed");
    expect(service.acknowledge(auth, ack).outcome).toEqual(output);
    expect(service.claim(auth)).toEqual([]);
  });
  test("rejects another request's digest and stops a revoked in-flight acknowledgement", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      auth = service.authenticateDevice(credential);
    const first = queue(device, resource),
      second = queue(device, resource),
      claims = service.claim(auth, 2);
    const firstClaim = claims.find((c) => c.requestId === first.requestId)!,
      secondClaim = claims.find((c) => c.requestId === second.requestId)!;
    const output = { ok: true as const, result: { observed: true } };
    expect(() =>
      service.acknowledge(auth, {
        requestId: second.requestId,
        digest: first.digest,
        claimId: secondClaim.claimId,
        status: "completed",
        outcome: output,
      }),
    ).toThrow();
    service.revokeOwned("user-a", device.deviceId, 1);
    expect(() =>
      service.acknowledge(auth, {
        requestId: first.requestId,
        digest: first.digest,
        claimId: firstClaim.claimId,
        status: "completed",
        outcome: output,
      }),
    ).toThrow("generation is no longer active");
    expect(service.getResult("user-a", first.requestId)?.status).toBe("revoked");
  });
  test("admits work across lifecycle changes while enforcing local lease and owner blocking", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      auth = service.authenticateDevice(credential),
      request = queue(device, resource);
    sqlite.prepare("UPDATE codespaceResource SET generation=2 WHERE id=?").run(resource);
    const claim = service.claim(auth)[0];
    expect(claim.requestId).toBe(request.requestId);
    expect(service.authorizePayload(auth, request.requestId, claim.claimId)).toMatchObject({
      resourceId: resource,
    });
    sqlite.prepare("UPDATE codespaceResource SET generation=3 WHERE id=?").run(resource);
    expect(service.authorizeResult(auth, request.requestId, claim.claimId)).toMatchObject({
      resourceId: resource,
    });
    now = device.policy.leaseUntil;
    expect(() => service.claim(auth)).toThrow("Renew the device work lease");
    sqlite.prepare("UPDATE user SET blocked=1 WHERE id='user-a'").run();
    expect(() => service.authenticateDevice(credential)).toThrow("Account access");
  });
  test.each(["repository grant", "device"] as const)(
    "lifecycle changes never bypass revoked %s access to accepted input or output",
    (revocation) => {
      const { device, credential } = enroll();
      const resource = bind(device),
        auth = service.authenticateDevice(credential);
      const request = queue(device, resource),
        claim = service.claim(auth)[0];
      sqlite.prepare("UPDATE codespaceResource SET generation=2 WHERE id=?").run(resource);
      expect(service.authorizeResult(auth, request.requestId, claim.claimId)).toMatchObject({
        resourceId: resource,
      });
      if (revocation === "repository grant")
        sqlite
          .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId=?")
          .run(device.connectionId);
      else service.revokeOwned("user-a", device.deviceId, device.deviceGeneration);
      expect(() => service.authorizePayload(auth, request.requestId, claim.claimId)).toThrow(
        expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }),
      );
      expect(() => service.authorizeResult(auth, request.requestId, claim.claimId)).toThrow(
        expect.objectContaining({ code: "LOCAL_UNAUTHORIZED" }),
      );
    },
  );
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
        policy: policy(),
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
      createLocalDeviceManagementRoutes(service, "https://moira.example"),
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
      policy: policy(),
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
    const unauthenticated = await httpRequest(app).post("/api/local-devices/relay/claim").send({});
    expect(unauthenticated.status).toBe(401);
    const authenticated = await httpRequest(app)
      .post("/api/local-devices/relay/claim")
      .set("Authorization", `Bearer ${credential}`)
      .send({});
    expect(authenticated.status).toBe(200);
    expect(authenticated.body.data).toEqual({ requests: [] });
    expect(JSON.stringify(confirmed.body)).not.toContain(credential);
  });
  test("a provider resource reconciler claims only its provider even when another provider is older", async () => {
    const { device } = enroll(),
      localId = bind(device),
      githubId = githubResource(localId);
    const repository = new CodespaceResourceRepository(sqlite);
    const claimed = repository.claimDue(
      "github-claim",
      now,
      now + 30_000,
      undefined,
      "github-codespaces",
    );
    expect(claimed?.id).toBe(githubId);
    expect(repository.getOwned("user-a", localId)?.claimId).toBeNull();
    repository.releaseClaim(githubId, 1, "github-claim", "retry", now);
    const resourceService = new CodespaceResourceService({
      repository,
      registry: new CodespaceProviderRegistry(),
      credentials: { getCredential: async () => "unused" },
      repositories: repository,
      providerId: "github-codespaces",
      requiredCapabilities: {},
      policy: () => serverPolicy,
      now: () => now,
    });
    expect(await resourceService.reconcileOnce()).toBe(true);
    expect(repository.getOwned("user-a", githubId)?.state).toBe("rejected");
    expect(repository.getOwned("user-a", localId)?.state).toBe("create_pending");
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
      const newIndex = journal.entries.findIndex((row) => row.tag === "0054_local_devices_relay");
      expect(newIndex).toBeGreaterThan(0);
      journal.entries = journal.entries.slice(0, newIndex);
      fs.writeFileSync(journalPath, JSON.stringify(journal));
      migrate(drizzle(upgraded), { migrationsFolder: before });
      upgraded
        .prepare(
          "INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES('existing','existing@example.test','existing','before','before')",
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
      migrate(drizzle(upgraded), { migrationsFolder: migrations });
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
        count: 0,
      });
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
  test("HTTP enrollment accepts more than 64 repository grants within its transport envelope", async () => {
    const pair = service.beginEnrollment("user-a"),
      base = policy();
    const full = {
      ...base,
      repositories: Array.from({ length: 65 }, (_, index) => ({
        ...base.repositories[0],
        id: randomUUID(),
        fullName: `owner/project-${index}`,
      })),
    };
    const body = {
      pairingId: pair.pairingId,
      pairingToken: pair.pairingToken,
      credential: randomBytes(32).toString("base64url"),
      policy: full,
    };
    const app = express();
    app.use("/api/local-devices", createLocalDeviceRoutes(service, "https://moira.example"));
    const response = await httpRequest(app).post("/api/local-devices/enroll").send(body);
    expect(response.status).toBe(201);
    expect(response.body.data.policy.repositories).toHaveLength(65);
  });
});
