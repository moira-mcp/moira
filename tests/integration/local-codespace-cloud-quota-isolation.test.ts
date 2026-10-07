import { afterEach, beforeEach, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import {
  CODESPACE_PROVIDER_GITHUB,
  CODESPACE_PROVIDER_LOCAL,
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CodespaceOperationRepository,
  CodespaceProviderRegistry,
  CodespaceResourceRepository,
  CodespaceResourceService,
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceProviderAdapter,
} from "@mcp-moira/shared";

let sqlite: Database.Database;
const now = 1_788_750_000_000;
const policy = {
  ...evaluateCodespaceResourcePolicy(() => undefined),
  enabled: true,
  maxActivePerUser: 1,
  maxActiveGlobal: 1,
  maxConcurrentOperationsPerUser: 1,
  maxConcurrentOperationsGlobal: 1,
};
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  migrate(drizzle(sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  sqlite
    .prepare(
      `INSERT INTO user(id,email,handle,createdAt,updatedAt)
    VALUES ('owner','owner@example.test','owner','now','now')`,
    )
    .run();
  for (const provider of [CODESPACE_PROVIDER_LOCAL, CODESPACE_PROVIDER_GITHUB]) {
    sqlite
      .prepare(
        `INSERT INTO codespaceConnection
      (id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt)
      VALUES (?, 'owner', ?, '101', 'owner', 'connected', 1, ?, ?)`,
      )
      .run(provider, provider, now, now);
    sqlite
      .prepare(
        `INSERT INTO codespaceConnectionRepository
      (connectionId,externalInstallationId,externalRepositoryId,fullName,private,createdAt)
      VALUES (?, '201', '301', 'owner/repo', 1, ?)`,
      )
      .run(provider, now);
  }
});
afterEach(() => {
  sqlite.close();
});

function reserveSpace(provider: string) {
  return new CodespaceResourceRepository(sqlite).reserveCreate({
    userId: "owner",
    provider,
    connectionId: provider,
    authorizationGeneration: 1,
    externalAccountId: "101",
    repository: { id: "301", fullName: "owner/repo", private: true },
    requestedRef: "main",
    machine: {
      name: "local",
      displayName: "Local",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 4 * 1024 ** 3,
      storageBytes: 8 * 1024 ** 3,
    },
    policy,
    now,
  });
}
function runningSpace(provider: string) {
  const reserved = reserveSpace(provider);
  if (reserved.outcome !== "reserved") throw new Error("Expected reservation");
  sqlite
    .prepare(
      `UPDATE codespaceResource SET state='usable', providerResourceName=?,
    externalOwnerId='101', observedState='running' WHERE id=?`,
    )
    .run(reserved.resource.id, reserved.resource.id);
  return reserved.resource.id;
}
function operation(resourceId: string, kind: "exec" | "write" = "exec") {
  return new CodespaceOperationRepository(sqlite).reserve({
    userId: "owner",
    resourceId,
    inputBytes: 0,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
    deadlineAt: now + 60_000,
    policy,
    now,
    kind,
  });
}

test("local VM reservations ignore cloud ceilings and throttle, cloud reservations still enforce them", () => {
  for (let index = 0; index < 6; index++)
    expect(reserveSpace(CODESPACE_PROVIDER_LOCAL).outcome).toBe("reserved");
  expect(reserveSpace(CODESPACE_PROVIDER_GITHUB).outcome).toBe("reserved");
  expect(reserveSpace(CODESPACE_PROVIDER_GITHUB).outcome).toBe("limit");
});

test("local jobs do not consume cloud concurrency and cooperating writes remain serialized", () => {
  const local = runningSpace(CODESPACE_PROVIDER_LOCAL);
  for (let index = 0; index < 10; index++) expect(operation(local).outcome).toBe("reserved");
  const cloud = runningSpace(CODESPACE_PROVIDER_GITHUB);
  expect(operation(cloud).outcome).toBe("reserved");
  expect(operation(cloud).outcome).toBe("busy");
  expect(operation(local, "write").outcome).toBe("reserved");
  expect(operation(local, "write").outcome).toBe("busy");
  expect(operation(local).outcome).toBe("reserved");
});

test("local limits report absence of count quotas instead of cloud values", () => {
  const input = {
    policy,
    held: 10,
    instanceHeld: 10,
    activeOperations: 10,
    transfers: { objects: 0, bytes: 0, inflightBytes: 0 },
    idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
    providerIdleMaxMinutes: 240,
  };
  const local = projectCodespaceLimits({ ...input, provider: CODESPACE_PROVIDER_LOCAL });
  expect(local.codespaces.max_per_user).toBeNull();
  expect(local.codespaces.max_instance).toBeNull();
  expect(local.codespaces.create_throttle_seconds).toBeNull();
  expect(local.operations.max_concurrent_per_user).toBeNull();
  expect(local.machine_ceiling).toBeNull();
  expect(
    projectCodespaceLimits({ ...input, provider: CODESPACE_PROVIDER_GITHUB }).codespaces
      .max_per_user,
  ).toBe(1);
});

test("an owner-approved local machine above cloud ceilings is selected and verified unchanged", async () => {
  const machine = {
    name: "owner-approved",
    displayName: "Owner approved",
    operatingSystem: "linux",
    cpuCores: 8,
    memoryBytes: 16 * 1024 ** 3,
    storageBytes: 128 * 1024 ** 3,
  };
  const registry = new CodespaceProviderRegistry();
  const provider: CodespaceProviderAdapter = {
    id: CODESPACE_PROVIDER_LOCAL,
    contractVersion: CODESPACE_PROVIDER_CONTRACT_VERSION,
    capabilities: {
      disposable: false,
      persistent: true,
      exactLifecycle: true,
      personalBillingOnly: true,
      connector: "local",
    },
    health: async () => ({ state: "available", reason: null }),
    getIdentity: async () => ({ id: "101", login: "owner" }),
    listMachines: async () => [machine],
    preflightCreate: async () => ({ billableOwnerId: "101" }),
    create: async (_credential, input) => ({
      outcome: "accepted",
      resource: {
        name: "local-exact",
        displayName: input.operationMarker,
        ownerId: "101",
        billableOwnerId: "101",
        repositoryId: input.repository.id,
        repositoryFullName: input.repository.fullName,
        ref: input.ref,
        state: "available",
        lastUsedAt: null,
        machine: input.machine,
        createdAt: now,
      },
    }),
    listOwned: async () => [],
    getExact: async () => null,
    startExact: async () => "accepted",
    stopExact: async () => "accepted",
    deleteExact: async () => "accepted",
    probeConnector: async () => undefined,
    guidance: () => ({ links: [], instructions: {} }),
  };
  registry.register(provider);
  const repository = new CodespaceResourceRepository(sqlite);
  const service = new CodespaceResourceService({
    repository,
    repositories: repository,
    registry,
    credentials: { getCredential: async () => "local-owner" },
    providerId: CODESPACE_PROVIDER_LOCAL,
    requiredCapabilities: { persistent: true, exactLifecycle: true, personalBillingOnly: true },
    policy: () => policy,
    now: () => now,
  });
  const result = await service.create("owner", "301", "main");
  expect(result.resource.state).toBe("usable");
  expect(result.resource.machine).toEqual(machine);
});
