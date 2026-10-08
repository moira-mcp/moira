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
  CodespaceOperationRepository,
  CodespaceOperationService,
  CodespaceFileService,
  CodespaceTransferRepository,
  CodespaceTransferService,
  canonicalJson,
  getFeatureResolver,
  setFeatureResolver,
  ModeFeatureResolver,
  type LocalPublicPolicy,
  type LocalDeviceView,
  type LocalRelayPayloadReference,
  type CodespaceOperationTransport,
  type CodespaceFileTransport,
  type CodespaceResourcePolicy,
  type CodespaceResourceRecord,
  type CodespaceOperationRecord,
  type CodespaceNativeFileReference,
} from "@mcp-moira/shared";
import {
  createLocalDeviceManagementRoutes,
  createLocalDeviceRoutes,
  createLocalDeviceBinaryRoutes,
} from "../../packages/web-backend/src/routes/local-devices.js";
import { LocalCodespaceRelay } from "../../packages/web-backend/src/services/local-codespace-relay.js";

let sqlite: Database.Database, service: LocalDeviceService, now: number;
const repositoryId = "b4ba0360-a0bf-4b80-a739-8a62671c403a";
const digest = "a".repeat(64);
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
      `marker-${resourceId}`,
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
function payload(userId = "user-a", purpose = "local_relay_input"): LocalRelayPayloadReference {
  const transferId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO codespaceTransfer(id,tokenDigest,userId,purpose,state,fileName,mimeType,declaredSize,observedSize,sha256,
    objectKey,ownerPid,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,'ready','relay.bin','application/octet-stream',7,7,?,?,1,?,?,?)`,
    )
    .run(transferId, randomUUID(), userId, purpose, digest, randomUUID(), now + 3600_000, now, now);
  return { parts: [{ transferId, sha256: digest, size: 7 }], sha256: digest, size: 7 };
}
function queue(device: LocalDeviceView, resourceId: string, reference = payload(device.userId)) {
  const request = {
    userId: device.userId,
    deviceId: device.deviceId,
    deviceGeneration: device.deviceGeneration,
    connectionId: device.connectionId,
    requestId: randomUUID(),
    resourceId,
    resourceGeneration: 1,
    digest,
    payloadReference: reference,
    deadlineAt: now + 300_000,
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
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(sqlite),
        root: directory,
        policy: () => serverPolicy,
        now: () => now,
      });
      try {
        const relay = new LocalCodespaceRelay(service, transfers, () => now);
        const queued = await relay.retain(
          pending,
          scope === "snapshot-only"
            ? { action: "snapshot" }
            : { action: "delete", spaceId: pending.id, generation: pending.generation },
          { mutation: scope === "accepted-delete" },
        );
        if (scope === "snapshot-only") {
          const output = await transfers.retainRelayPayload(
            "user-a",
            "local_relay_output",
            Buffer.from("saved scoped observation"),
          );
          sqlite
            .prepare(
              "UPDATE codespaceLocalRelay SET status='completed',outputReference=? WHERE requestId=?",
            )
            .run(canonicalJson(output), queued.requestId);
          await transfers.discardRelayPayload(
            "user-a",
            "local_relay_input",
            queued.payloadReference,
          );
          await transfers.discardRelayPayload("user-a", "local_relay_output", output);
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
        sqlite
          .prepare("UPDATE codespaceLocalDevice SET control=? WHERE id=?")
          .run(
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
    expect(() =>
      service.enqueue({ ...ordinary, requestId: randomUUID(), authority: "owner-delete" }),
    ).toThrow("Relay authority does not match its mutation");
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
    const reference = payload();
    const request = {
      userId: device.userId,
      deviceId: device.deviceId,
      deviceGeneration: device.deviceGeneration,
      connectionId: device.connectionId,
      requestId: randomUUID(),
      resourceId,
      resourceGeneration: 2,
      authority: "owner-delete" as const,
      digest,
      payloadReference: reference,
      deadlineAt: now + 120_000,
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
    const output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, request.requestId, claim.claimId, output.parts[0]);
    const ack = {
      requestId: request.requestId,
      digest,
      claimId: claim.claimId,
      status: "completed" as const,
      outcomeReference: output,
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
  test("rejects resource rebinding and cross-user payload references before inserting a request", () => {
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
    expect(() => queue(first.device, resource, payload("user-b"))).toThrow(
      "Private payload ownership denied",
    );
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
    expect(() => service.enqueue({ ...request, payloadReference: payload() })).toThrow(
      "Relay request identity changed",
    );
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
  test("bounds retained replay metadata without evicting live work or fresh receipts", () => {
    const approved = policy();
    approved.leaseUntil = now + 24 * 60 * 60_000;
    const { device, credential } = enroll("user-a", approved),
      resource = bind(device),
      auth = service.authenticateDevice(credential);
    const receipt = queue(device, resource),
      claim = service.claim(auth)[0],
      output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, receipt.requestId, claim.claimId, output.parts[0]);
    service.acknowledge(auth, {
      requestId: receipt.requestId,
      digest,
      claimId: claim.claimId,
      status: "completed",
      outcomeReference: output,
    });
    const live = { ...receipt, requestId: randomUUID(), deadlineAt: now + 3 * 60 * 60_000 };
    service.enqueue(live);
    const clone =
      sqlite.prepare(`INSERT INTO codespaceLocalRelay(requestId,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,
      digest,inputReference,status,claimId,claimExpiresAt,outputReference,deadlineAt,createdAt,updatedAt)
      SELECT ?,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,digest,inputReference,status,claimId,claimExpiresAt,
      outputReference,deadlineAt,createdAt,updatedAt FROM codespaceLocalRelay WHERE requestId=?`);
    sqlite.transaction(() => {
      for (let index = 0; index < 2046; index++) clone.run(randomUUID(), receipt.requestId);
    })();
    expect(() => service.enqueue({ ...receipt, requestId: randomUUID() })).toThrow(
      "Retained device relay metadata is full",
    );
    expect(service.getResult("user-a", receipt.requestId)?.status).toBe("completed");
    expect(service.getResult("user-a", live.requestId)?.status).toBe("queued");
    now += 65 * 60_000 + 1;
    service.listOwned("user-a");
    expect(service.getRequest("user-a", receipt.requestId)).toBeNull();
    expect(service.getResult("user-a", live.requestId)?.status).toBe("queued");
    expect(sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelay").get()).toEqual({
      count: 1,
    });
    const plan = sqlite
      .prepare(
        "EXPLAIN QUERY PLAN SELECT requestId FROM codespaceLocalRelay WHERE userId=? AND deadlineAt<? AND status NOT IN ('queued','claimed')",
      )
      .all("user-a", now) as { detail: string }[];
    expect(
      plan.some((row) => row.detail.includes("codespace_local_relay_owner_deadline_idx")),
    ).toBe(true);
    const fresh = {
      ...receipt,
      requestId: randomUUID(),
      payloadReference: payload(),
      deadlineAt: now + 300_000,
    };
    service.enqueue(fresh);
    expect(service.getResult("user-a", fresh.requestId)?.status).toBe("queued");
  });
  test("new device identities cannot evade the owner metadata cap or block another owner", () => {
    const first = enroll(),
      resource = bind(first.device),
      auth = service.authenticateDevice(first.credential);
    const receipt = queue(first.device, resource),
      claim = service.claim(auth)[0],
      output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, receipt.requestId, claim.claimId, output.parts[0]);
    service.acknowledge(auth, {
      requestId: receipt.requestId,
      digest,
      claimId: claim.claimId,
      status: "completed",
      outcomeReference: output,
    });
    const devices = [
      { device: first.device, resource },
      ...Array.from({ length: 3 }, () => {
        const { device } = enroll();
        return { device, resource: bind(device) };
      }),
    ];
    const clone =
      sqlite.prepare(`INSERT INTO codespaceLocalRelay(requestId,userId,deviceId,deviceGeneration,connectionId,resourceId,resourceGeneration,
      digest,inputReference,status,claimId,claimExpiresAt,outputReference,deadlineAt,createdAt,updatedAt)
      SELECT ?,userId,?,deviceGeneration,connectionId,?,resourceGeneration,digest,inputReference,status,claimId,claimExpiresAt,
      outputReference,deadlineAt,createdAt,updatedAt FROM codespaceLocalRelay WHERE requestId=?`);
    sqlite.transaction(() => {
      for (const [index, entry] of devices.entries())
        for (let row = 0; row < 2048 - (index === 0 ? 1 : 0); row++)
          clone.run(randomUUID(), entry.device.deviceId, entry.resource, receipt.requestId);
    })();
    const fifth = enroll(),
      fifthResource = bind(fifth.device);
    expect(() => queue(fifth.device, fifthResource)).toThrow(
      "Retained device relay metadata is full",
    );
    expect(
      sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelay WHERE userId='user-a'").get(),
    ).toEqual({ count: 8192 });
    const other = enroll("user-b"),
      otherRequest = queue(other.device, bind(other.device));
    expect(service.getResult("user-b", otherRequest.requestId)?.status).toBe("queued");
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
    const output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, request.requestId, second.claimId, output.parts[0]);
    expect(() =>
      service.acknowledge(auth, {
        requestId: request.requestId,
        digest,
        claimId: first.claimId,
        status: "completed",
        outcomeReference: output,
      }),
    ).toThrow("acknowledgement changed");
    const ack = {
      requestId: request.requestId,
      digest,
      claimId: second.claimId,
      status: "completed" as const,
      outcomeReference: output,
    };
    expect(service.acknowledge(auth, ack).status).toBe("completed");
    expect(service.acknowledge(auth, ack).outcomeReference).toEqual(output);
    expect(service.claim(auth)).toEqual([]);
  });
  test("rejects result parts from another request and stops a revoked in-flight acknowledgement", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      auth = service.authenticateDevice(credential);
    const first = queue(device, resource),
      second = queue(device, resource),
      claims = service.claim(auth, 2);
    const firstClaim = claims.find((c) => c.requestId === first.requestId)!,
      secondClaim = claims.find((c) => c.requestId === second.requestId)!;
    const output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, first.requestId, firstClaim.claimId, output.parts[0]);
    expect(() =>
      service.acknowledge(auth, {
        requestId: second.requestId,
        digest,
        claimId: secondClaim.claimId,
        status: "completed",
        outcomeReference: output,
      }),
    ).toThrow("another relay claim");
    service.revokeOwned("user-a", device.deviceId, 1);
    expect(() =>
      service.acknowledge(auth, {
        requestId: first.requestId,
        digest,
        claimId: firstClaim.claimId,
        status: "completed",
        outcomeReference: output,
      }),
    ).toThrow("generation is no longer active");
    expect(service.getResult("user-a", first.requestId)?.status).toBe("revoked");
  });
  test("enforces local lease, owner blocking and resource generation at each dispatch boundary", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      auth = service.authenticateDevice(credential),
      request = queue(device, resource);
    sqlite.prepare("UPDATE codespaceResource SET generation=2 WHERE id=?").run(resource);
    expect(service.claim(auth)).toEqual([]);
    expect(service.getResult("user-a", request.requestId)?.status).toBe("refused");
    now = device.policy.leaseUntil;
    expect(() => service.claim(auth)).toThrow("Renew the device work lease");
    sqlite.prepare("UPDATE user SET blocked=1 WHERE id='user-a'").run();
    expect(() => service.authenticateDevice(credential)).toThrow("Account access");
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
    app.use(
      "/api/local-devices",
      createLocalDeviceRoutes(
        service,
        { relayPartLimit: () => 4 * 1024 * 1024 } as CodespaceTransferService,
        "https://moira.example",
      ),
    );
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
    expect(authenticated.body.data).toEqual({ requests: [], maxPartBytes: 4 * 1024 * 1024 });
    expect(JSON.stringify(confirmed.body)).not.toContain(credential);
  });
  test("binary relay rejects a sibling device before private reads and binds uploaded output to its claim", async () => {
    const first = enroll(),
      second = enroll(),
      resource = bind(first.device),
      job = queue(first.device, resource);
    const claim = service.claim(service.authenticateDevice(first.credential))[0];
    const bytes = Buffer.from("private");
    const transfers = {
      readRelayChunk: async () => bytes,
      retainRelayPart: async () => payload("user-a", "local_relay_output").parts[0],
      discardRelayPayload: async () => undefined,
    } as unknown as CodespaceTransferService;
    const app = express();
    app.use(
      "/api/local-devices",
      createLocalDeviceBinaryRoutes(service, transfers, "https://moira.example"),
    );
    const url = `/api/local-devices/relay/${job.requestId}/payload/0?offset=0&length=7`;
    const denied = await httpRequest(app)
      .get(url)
      .set("Authorization", `Bearer ${second.credential}`)
      .set("X-Moira-Claim-Id", claim.claimId);
    expect(denied.status).toBe(401);
    expect(denied.text).not.toContain("private");
    const accepted = await httpRequest(app)
      .get(url)
      .set("Authorization", `Bearer ${first.credential}`)
      .set("X-Moira-Claim-Id", claim.claimId);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual(bytes);
    const uploaded = await httpRequest(app)
      .post(`/api/local-devices/relay/${job.requestId}/result-part`)
      .set("Authorization", `Bearer ${first.credential}`)
      .set("X-Moira-Claim-Id", claim.claimId)
      .set("Content-Type", "application/octet-stream")
      .send(bytes);
    expect(uploaded.status).toBe(201);
    expect(
      sqlite
        .prepare("SELECT requestId,claimId FROM codespaceLocalRelayPart WHERE transferId=?")
        .get(uploaded.body.data.transferId),
    ).toEqual({ requestId: job.requestId, claimId: claim.claimId });
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
  test("a provider operation reconciler leaves another provider reservation unclaimed", async () => {
    const { device } = enroll(),
      localId = bind(device),
      githubId = githubResource(localId);
    const operationIds = [randomUUID(), randomUUID()];
    for (const [index, resourceId, provider] of [
      [0, localId, "local-sandboxes"],
      [1, githubId, "github-codespaces"],
    ] as const)
      sqlite
        .prepare(
          `INSERT INTO codespaceOperation(id,userId,resourceId,resourceGeneration,authorizationGeneration,provider,providerResourceName,remoteMarker,kind,state,
        inputBytes,stdoutLimitBytes,stderrLimitBytes,deadlineAt,createdAt,updatedAt)
        VALUES(?,'user-a',?,1,1,?,?,?,'exec','reserved',0,10,10,?,?,?)`,
        )
        .run(
          operationIds[index],
          resourceId,
          provider,
          resourceId,
          `marker-${operationIds[index]}`,
          now - 1,
          now,
          now + index,
        );
    const repository = new CodespaceOperationRepository(sqlite);
    expect(
      repository.claimDue("github-operation", now, now + 30_000, undefined, "github-codespaces")
        ?.id,
    ).toBe(operationIds[1]);
    expect(repository.getOwned("user-a", operationIds[0])?.claimId).toBeNull();
    repository.releaseClaim(operationIds[1], "github-operation", "retry", now);
    const operationService = new CodespaceOperationService({
      repository,
      providerId: "github-codespaces",
      credentials: { getCredential: async () => "unused" },
      transport: {} as CodespaceOperationTransport,
      policy: () => serverPolicy,
      now: () => now,
    });
    expect(await operationService.reconcileOnce()).toBe(true);
    expect(repository.getOwned("user-a", operationIds[1])?.state).toBe("cancelled");
    expect(repository.getOwned("user-a", operationIds[0])?.state).toBe("reserved");
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
  test("private transfer cleanup can delete an expired result part without orphaning its authority", () => {
    const { device, credential } = enroll(),
      resource = bind(device),
      job = queue(device, resource),
      auth = service.authenticateDevice(credential);
    const claim = service.claim(auth)[0],
      output = payload("user-a", "local_relay_output");
    service.registerOutputPart(auth, job.requestId, claim.claimId, output.parts[0]);
    sqlite.prepare("DELETE FROM codespaceTransfer WHERE id=?").run(output.parts[0].transferId);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM codespaceLocalRelayPart").get()).toEqual({
      count: 0,
    });
    expect(() =>
      service.authorizeOutput(auth, {
        requestId: job.requestId,
        digest,
        claimId: claim.claimId,
        status: "completed",
        outcomeReference: output,
      }),
    ).toThrow("Private payload ownership denied");
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
      app.use(
        "/api/local-devices",
        createLocalDeviceRoutes(service, {} as CodespaceTransferService, "https://moira.example"),
      );
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
  test.each(["exec", "upload"] as const)(
    "retains native %s request in private objects before consuming its original input",
    async (mode) => {
      const { device } = enroll(),
        resourceId = bind(device),
        repository = new CodespaceOperationRepository(sqlite);
      sqlite
        .prepare(
          "UPDATE codespaceResource SET externalOwnerId='user-a',billableOwnerId='user-a',providerResourceName=? WHERE id=?",
        )
        .run(randomUUID(), resourceId);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-native-retention-"));
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(sqlite),
        policy: () => serverPolicy,
        root: directory,
        now: () => now,
      });
      const bytes = Buffer.from([0, 255, 65, 10]),
        hash = createHash("sha256").update(bytes).digest("hex");
      const reference: CodespaceNativeFileReference = {
        fileId: "file_nativeRetention",
        downloadUrl: "https://native.example.test/object",
        mimeType: "application/octet-stream",
        declaredSize: bytes.length,
      };
      const nativeFetcher = {
        fetch: async () => ({
          contentLength: bytes.length,
          mimeType: "application/octet-stream",
          body: (async function* () {
            yield bytes;
          })(),
        }),
      };
      let retained: LocalRelayPayloadReference | null = null,
        retainedRequest: unknown = null,
        originalPath = "";
      const retain = async (
        _credential: string,
        _space: CodespaceResourceRecord,
        operation: CodespaceOperationRecord,
        request: unknown,
      ) => {
        expect(repository.getOwned("user-a", operation.id)?.state).toBe("reconcile_pending");
        const original = sqlite
          .prepare("SELECT objectKey,state FROM codespaceTransfer WHERE purpose='codespace_input'")
          .get() as { objectKey: string; state: string };
        expect(original.state).toBe("claimed");
        originalPath = path.join(directory, original.objectKey);
        expect(fs.readFileSync(originalPath)).toEqual(bytes);
        retainedRequest = request;
        retained = await transfers.retainRelayPayload(
          "user-a",
          "local_relay_input",
          Buffer.from(canonicalJson(request)),
        );
        expect(fs.existsSync(originalPath)).toBe(true);
      };
      const observed = async (request: unknown) => {
        expect(request).toBe(retainedRequest);
        expect(
          sqlite
            .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE purpose='codespace_input'")
            .get(),
        ).toEqual({ count: 0 });
        expect(fs.existsSync(originalPath)).toBe(false);
        if (!retained) throw new Error("Native request was not durably retained");
        const stored = await transfers.readRelayPayload("user-a", "local_relay_input", retained);
        expect(stored).toEqual(Buffer.from(canonicalJson(request)));
        expect(sqlite.serialize().includes(Buffer.from("native-retention-canary"))).toBe(false);
      };
      const transport: CodespaceOperationTransport & CodespaceFileTransport = {
        health: async () => ({ ok: true, reason: null }),
        retainExecuteInput: retain,
        retainFileInput: retain,
        execute: async (_credential, _space, _operation, request) => {
          await observed(request);
          expect(request.timeoutMs).toBeGreaterThan(0);
          expect(request.maxRetainedBytes).toBeGreaterThan(0);
          expect(request.stdin.kind).toBe("inline");
          return {
            state: "succeeded",
            stdout: "",
            stderr: "",
            exitCode: 0,
            stdoutTotalBytes: 0,
            stderrTotalBytes: 0,
            outputLimitExceeded: false,
            sessionCaptureDropped: false,
          };
        },
        executeFile: async (_credential, _space, _operation, request) => {
          await observed(request);
          return {
            action: "upload",
            path: "file.bin",
            previous: null,
            current: { size: bytes.length, sha256: hash, modifiedAt: now },
          };
        },
        inspect: async () => ({ state: "absent" }),
        cancel: async () => ({ state: "absent" }),
        finalize: async () => undefined,
        readOutput: async () => ({ state: "absent" }),
        inspectFile: async () => ({ state: "absent" }),
      };
      try {
        const common = {
          repository,
          credentials: { getCredential: async () => "local-test" },
          transport,
          policy: () => serverPolicy,
          now: () => now,
          transfers,
          nativeFetcher,
        };
        const result =
          mode === "exec"
            ? await new CodespaceOperationService(common).executeNativeReference(
                "user-a",
                resourceId,
                { argv: ["cat", "native-retention-canary"] },
                reference,
              )
            : await new CodespaceFileService(common).uploadReference("user-a", resourceId, {
                path: "file.bin",
                reference,
                expected: { exists: false },
              });
        expect(result.operation.state).toBe("succeeded");
        expect(result.result).not.toBeNull();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test.each(["exec", "upload"] as const)(
    "a failed native %s retention keeps original private bytes available for recovery",
    async (mode) => {
      const { device } = enroll(),
        resourceId = bind(device),
        repository = new CodespaceOperationRepository(sqlite);
      sqlite
        .prepare(
          "UPDATE codespaceResource SET externalOwnerId='user-a',billableOwnerId='user-a',providerResourceName=? WHERE id=?",
        )
        .run(randomUUID(), resourceId);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-native-retention-failure-"));
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(sqlite),
        policy: () => serverPolicy,
        root: directory,
        now: () => now,
      });
      const bytes = Buffer.from([0, 255, 65, 10]),
        reference: CodespaceNativeFileReference = {
          fileId: "file_nativeRetention",
          downloadUrl: "https://native.example.test/object",
          mimeType: "application/octet-stream",
          declaredSize: bytes.length,
        };
      const nativeFetcher = {
        fetch: async () => ({
          contentLength: bytes.length,
          mimeType: "application/octet-stream",
          body: (async function* () {
            yield bytes;
          })(),
        }),
      };
      const refuse = async () => {
        throw new Error("Private relay capacity unavailable");
      };
      const transport: CodespaceOperationTransport & CodespaceFileTransport = {
        health: async () => ({ ok: true, reason: null }),
        retainExecuteInput: refuse,
        retainFileInput: refuse,
        execute: async () => ({ state: "running" }),
        executeFile: async () => ({ state: "running" }),
        inspect: async () => ({ state: "absent" }),
        cancel: async () => ({ state: "absent" }),
        finalize: async () => undefined,
        readOutput: async () => ({ state: "absent" }),
        inspectFile: async () => ({ state: "absent" }),
      };
      try {
        const common = {
          repository,
          credentials: { getCredential: async () => "local-test" },
          transport,
          policy: () => serverPolicy,
          now: () => now,
          transfers,
          nativeFetcher,
        };
        const result =
          mode === "exec"
            ? await new CodespaceOperationService(common).executeNativeReference(
                "user-a",
                resourceId,
                { argv: ["cat"] },
                reference,
              )
            : await new CodespaceFileService(common).uploadReference("user-a", resourceId, {
                path: "file.bin",
                reference,
                expected: { exists: false },
              });
        expect(result.operation.state).toBe("reconcile_pending");
        expect(result.result).toBeNull();
        const original = sqlite
          .prepare("SELECT objectKey,state FROM codespaceTransfer WHERE purpose='codespace_input'")
          .get() as { objectKey: string; state: string };
        expect(original.state).toBe("ready");
        expect(fs.readFileSync(path.join(directory, original.objectKey))).toEqual(bytes);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
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
    app.use(
      "/api/local-devices",
      createLocalDeviceRoutes(service, {} as CodespaceTransferService, "https://moira.example"),
    );
    const response = await httpRequest(app).post("/api/local-devices/enroll").send(body);
    expect(response.status).toBe(201);
    expect(response.body.data.policy.repositories).toHaveLength(65);
  });
});
