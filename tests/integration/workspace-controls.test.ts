import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {
  WORKSPACE_PROVIDER_CONTRACT_VERSION,
  WORKSPACE_PROVIDER_GITHUB,
  WorkspaceObservabilityService,
  WorkspaceOperationRepository,
  WorkspaceProviderRegistry,
  WorkspaceResourceError,
  WorkspaceResourceRepository,
  WorkspaceResourceService,
  WorkspaceTransferRepository,
  type WorkspaceControlAuditEvent,
  type WorkspaceGitHubConfigStatus,
  type WorkspaceProviderAdapter,
  type WorkspaceProviderResource,
  type WorkspaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_750_000_000;
const policy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 2,
  maxActiveGlobal: 4,
  maxOperationsPerDay: 10,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  maxConcurrentOperationsGlobal: 20,
};
const config: WorkspaceGitHubConfigStatus = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "fixture-client-secret-not-a-real-credential",
  callbackUrl: "https://moira.example/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example/settings#integrations-github",
};

class Provider implements WorkspaceProviderAdapter {
  readonly id = WORKSPACE_PROVIDER_GITHUB;
  readonly contractVersion = WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = {
    disposable: true,
    persistent: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "github-cli-ssh",
  };
  resource: WorkspaceProviderResource | null = null;
  readonly createCalls = jest.fn();
  readonly stopCalls = jest.fn();
  readonly deleteCalls = jest.fn();
  readonly machine = {
    name: "basicLinux32gb",
    displayName: "Basic Linux",
    operatingSystem: "linux",
    cpuCores: 2,
    memoryBytes: 8 * 1024 ** 3,
    storageBytes: 32 * 1024 ** 3,
  };
  async health() {
    return { state: "available" as const, reason: null };
  }
  async getIdentity() {
    return { id: "101", login: "owner" };
  }
  async listMachines() {
    return [this.machine];
  }
  async create(_token: string, input: Parameters<WorkspaceProviderAdapter["create"]>[1]) {
    this.createCalls();
    this.resource = {
      name: "silver-space",
      displayName: input.operationMarker,
      ownerId: "101",
      billableOwnerId: "101",
      repositoryId: input.repository.id,
      repositoryFullName: input.repository.fullName,
      ref: input.ref,
      state: "available",
      machine: input.machine,
      createdAt: now,
    };
    return { outcome: "accepted" as const, resource: this.resource };
  }
  async listOwned() {
    return this.resource ? [this.resource] : [];
  }
  async getExact(_token: string, name: string) {
    return this.resource?.name === name ? this.resource : null;
  }
  async startExact() {
    return "accepted" as const;
  }
  async stopExact() {
    this.stopCalls();
    if (this.resource) this.resource = { ...this.resource, state: "shutdown" };
    return "accepted" as const;
  }
  async deleteExact() {
    this.deleteCalls();
    this.resource = null;
    return "accepted" as const;
  }
  async probeConnector() {}
}

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite
    .prepare(
      `INSERT INTO user (id, email, handle, createdAt, updatedAt)
       VALUES ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
              ('admin-1', 'admin@example.test', 'admin-one', 'now', 'now')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO workspaceConnection
       (id, userId, provider, externalAccountId, externalLogin, status,
        credentialGeneration, createdAt, updatedAt)
       VALUES ('connection-1', 'user-1', ?, '101', 'owner', 'connected', 1, ?, ?)`,
    )
    .run(WORKSPACE_PROVIDER_GITHUB, now, now);
  sqlite
    .prepare(
      `INSERT INTO workspaceConnectionRepository
       (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
       VALUES ('connection-1', '201', '301', 'owner/repository', 1, ?)`,
    )
    .run(now);
  const repository = new WorkspaceResourceRepository(sqlite);
  const provider = new Provider();
  const registry = new WorkspaceProviderRegistry();
  registry.register(provider);
  const controlAudits: WorkspaceControlAuditEvent[] = [];
  let currentTime = now;
  const service = new WorkspaceResourceService({
    repository,
    repositories: repository,
    registry,
    credentials: { getCredential: async () => "ghu_access" },
    providerId: WORKSPACE_PROVIDER_GITHUB,
    requiredCapabilities: { exactLifecycle: true, personalBillingOnly: true },
    policy: () => policy,
    now: () => currentTime,
    controlAudit: (event) => {
      controlAudits.push(event);
    },
  });
  let connectorOk = true;
  const observability = new WorkspaceObservabilityService({
    providerId: WORKSPACE_PROVIDER_GITHUB,
    config: () => config,
    policy: () => policy,
    resources: repository,
    operations: new WorkspaceOperationRepository(sqlite),
    transfers: new WorkspaceTransferRepository(sqlite),
    transport: { health: async () => ({ ok: connectorOk, reason: connectorOk ? null : "down" }) },
    now: () => currentTime,
  });
  return {
    sqlite,
    provider,
    service,
    observability,
    controlAudits,
    setConnector: (ok: boolean) => {
      connectorOk = ok;
    },
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
}

describe("workspace kill switches and shared readiness over real SQLite", () => {
  test("a global control refuses new work, stops persistent workspaces, audits and never deletes", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "main");
      expect(created.resource.state).toBe("usable");
      await expect(value.observability.readiness()).resolves.toMatchObject({
        state: "ready",
        usage: { active_resources: 1 },
      });

      const controls = await value.service.setControl({
        scope: "global",
        disabled: true,
        reason: "incident",
        updatedBy: "admin-1",
      });
      expect(controls).toEqual([
        expect.objectContaining({ scope: "global", disabled: true, reason: "incident" }),
        expect.objectContaining({ scope: "provider:github-codespaces", disabled: false }),
      ]);
      expect(value.controlAudits).toEqual([
        expect.objectContaining({
          action: "control_update",
          userId: "admin-1",
          scope: "global",
          disabled: true,
          stoppedPersistentWorkspaces: 1,
        }),
      ]);

      value.advance(9_000);
      await expect(value.observability.readiness()).resolves.toMatchObject({
        state: "control_disabled",
        reason: "global",
        reconciliation: { due_resources: 1, due_operations: 0, oldest_due_age_ms: 9_000 },
      });

      await expect(value.service.create("user-1", "301", "main")).rejects.toMatchObject({
        code: "WORKSPACE_PROVIDER_DISABLED",
      } satisfies Partial<WorkspaceResourceError>);
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);

      await value.service.reconcileOnce();
      const stored = value.service.getWorkspace("user-1", created.resource.id);
      expect(stored.state).toBe("stopped");
      expect(stored.desiredState).toBe("stopped");
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
      expect(value.provider.resource).not.toBeNull();

      await value.service.setControl({
        scope: "global",
        disabled: false,
        reason: null,
        updatedBy: "admin-1",
      });
      await expect(value.observability.readiness()).resolves.toMatchObject({ state: "ready" });
      expect(value.controlAudits).toHaveLength(2);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects a control scope for another provider and reports connector loss", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.setControl({
          scope: "provider:other-cloud",
          disabled: true,
          reason: null,
          updatedBy: "admin-1",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_RESOURCE_INVALID" });
      expect(value.controlAudits).toHaveLength(0);

      value.setConnector(false);
      await expect(value.observability.readiness()).resolves.toMatchObject({
        state: "connector_unavailable",
        reason: "down",
        connector: { state: "unavailable" },
      });
    } finally {
      value.sqlite.close();
    }
  });
});
