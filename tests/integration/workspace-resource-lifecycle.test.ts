import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  WORKSPACE_PROVIDER_CONTRACT_VERSION,
  WORKSPACE_PROVIDER_GITHUB,
  WorkspaceProviderRegistry,
  WorkspaceResourceError,
  WorkspaceResourceRepository,
  WorkspaceResourceService,
  type WorkspaceCreateProviderResult,
  type WorkspaceMachine,
  type WorkspaceProviderAdapter,
  type WorkspaceProviderResource,
  type WorkspaceResourcePolicy,
  type WorkspaceResourceAuditEvent,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_750_000_000;
const machine: WorkspaceMachine = {
  name: "basicLinux32gb",
  displayName: "Basic Linux",
  operatingSystem: "linux",
  cpuCores: 2,
  memoryBytes: 8 * 1024 ** 3,
  storageBytes: 32 * 1024 ** 3,
};
const policy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 1,
  maxActiveGlobal: 2,
  maxOperationsPerDay: 1,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
};

class FakeProvider implements WorkspaceProviderAdapter {
  readonly contractVersion = WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities: WorkspaceProviderAdapter["capabilities"];
  resource: WorkspaceProviderResource | null = null;
  loseCreateResponse = false;
  createObservation: (() => void) | null = null;
  machineObservation: (() => void) | null = null;
  createGate: Promise<void> | null = null;
  returnedMachine: WorkspaceMachine = machine;
  returnedBillableOwnerId = "101";
  returnedState: WorkspaceProviderResource["state"] = "available";
  ownedResources: WorkspaceProviderResource[] | null = null;
  connectorAvailable = true;
  healthAvailable = true;
  createOutcome: "accepted" | "background" | "rejected" = "accepted";
  readonly healthCalls = jest.fn();
  readonly machineCalls = jest.fn();
  readonly createCalls = jest.fn();
  readonly connectorCalls = jest.fn();
  readonly stopCalls = jest.fn();
  readonly deleteCalls = jest.fn();

  constructor(
    readonly id = WORKSPACE_PROVIDER_GITHUB,
    personalBillingOnly = true,
  ) {
    this.capabilities = {
      disposable: true,
      exactLifecycle: true,
      personalBillingOnly,
      connector: id === WORKSPACE_PROVIDER_GITHUB ? "github-cli-ssh" : "managed-connector",
    };
  }

  async health() {
    this.healthCalls();
    return this.healthAvailable
      ? { state: "available" as const, reason: null }
      : { state: "unavailable" as const, reason: "tooling unavailable" };
  }
  async getIdentity() {
    return { id: "101", login: "owner" };
  }
  async listMachines() {
    this.machineCalls();
    this.machineObservation?.();
    return [machine];
  }
  async create(
    _token: string,
    input: Parameters<WorkspaceProviderAdapter["create"]>[1],
  ): Promise<WorkspaceCreateProviderResult> {
    this.createCalls();
    this.createObservation?.();
    this.resource = {
      name: "silver-space-123",
      displayName: input.operationMarker,
      ownerId: "101",
      billableOwnerId: this.returnedBillableOwnerId,
      repositoryId: input.repository.id,
      repositoryFullName: input.repository.fullName,
      ref: input.ref,
      state: this.returnedState,
      machine: this.returnedMachine,
      createdAt: now,
    };
    if (this.createGate) await this.createGate;
    if (this.loseCreateResponse) throw new Error("connection reset after submit");
    if (this.createOutcome === "rejected") {
      this.resource = null;
      return { outcome: "rejected", reason: "provider_policy" };
    }
    if (this.createOutcome === "background") return { outcome: "accepted", resource: null };
    return { outcome: "accepted", resource: this.resource };
  }
  async listOwned() {
    return this.ownedResources ?? (this.resource ? [this.resource] : []);
  }
  async getExact(_token: string, name: string) {
    return this.resource?.name === name ? this.resource : null;
  }
  async stopExact() {
    this.stopCalls();
    return "accepted" as const;
  }
  async deleteExact() {
    this.deleteCalls();
    this.resource = null;
    return "accepted" as const;
  }
  async probeConnector() {
    this.connectorCalls();
    if (!this.connectorAvailable) throw new Error("remote ssh unavailable");
  }
}

function fixture(policyOverrides: Partial<WorkspaceResourcePolicy> = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite
    .prepare(
      `INSERT INTO user (id, email, handle, createdAt, updatedAt)
     VALUES ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
            ('user-2', 'two@example.test', 'user-two', 'now', 'now')`,
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
  sqlite
    .prepare(
      `INSERT INTO workspaceConnection
       (id, userId, provider, externalAccountId, externalLogin, status,
        credentialGeneration, createdAt, updatedAt)
       VALUES ('connection-2', 'user-2', ?, '101', 'owner', 'connected', 1, ?, ?)`,
    )
    .run(WORKSPACE_PROVIDER_GITHUB, now, now);
  sqlite
    .prepare(
      `INSERT INTO workspaceConnectionRepository
       (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
       VALUES ('connection-2', '202', '302', 'owner/second', 1, ?)`,
    )
    .run(now);
  const repository = new WorkspaceResourceRepository(sqlite);
  const provider = new FakeProvider();
  const registry = new WorkspaceProviderRegistry();
  registry.register(provider);
  const tokenCalls = jest.fn<() => Promise<string>>().mockResolvedValue("ghu_access");
  const audits: WorkspaceResourceAuditEvent[] = [];
  let currentTime = now;
  const effectivePolicy = { ...policy, ...policyOverrides };
  const createService = () =>
    new WorkspaceResourceService({
      repository,
      repositories: repository,
      registry,
      credentials: { getCredential: tokenCalls },
      providerId: WORKSPACE_PROVIDER_GITHUB,
      requiredCapabilities: {
        disposable: true,
        exactLifecycle: true,
        personalBillingOnly: true,
      },
      policy: () => effectivePolicy,
      now: () => currentTime,
      audit: (event) => {
        audits.push(event);
      },
    });
  const service = createService();
  return {
    sqlite,
    repository,
    provider,
    service,
    createService,
    tokenCalls,
    advance: (milliseconds: number) => {
      currentTime += milliseconds;
    },
    policy: effectivePolicy,
    audits,
  };
}

describe("durable disposable workspace lifecycle", () => {
  test("binds the same core lifecycle to a non-GitHub provider without installation concepts", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      value.sqlite.prepare("UPDATE workspaceConnection SET provider = 'managed-cloud'").run();
      value.sqlite
        .prepare("UPDATE workspaceConnectionRepository SET externalRepositoryId = 'project-alpha'")
        .run();
      const provider = new FakeProvider("managed-cloud", false);
      provider.returnedBillableOwnerId = "moira-billing-account";
      const registry = new WorkspaceProviderRegistry();
      registry.register(provider);
      const service = new WorkspaceResourceService({
        repository: value.repository,
        repositories: value.repository,
        registry,
        providerId: "managed-cloud",
        requiredCapabilities: { disposable: true, exactLifecycle: true },
        credentials: {
          getCredential: async (userId, providerId) => `${userId}:${providerId}:opaque`,
        },
        policy: () => value.policy,
        now: () => now,
      });

      expect(service.listRepositories("user-1")).toEqual([
        { id: "project-alpha", fullName: "owner/repository", private: true },
      ]);
      await expect(
        service.create("user-1", "project-alpha", "refs/heads/main"),
      ).resolves.toMatchObject({
        resource: { provider: "managed-cloud", state: "usable" },
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("serializes competing reservations from separate services and SQLite connections", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moira-resource-concurrency-"));
    const filename = path.join(directory, "moira.db");
    const first = new Database(filename);
    const second = new Database(filename);
    for (const sqlite of [first, second]) {
      sqlite.pragma("foreign_keys = ON");
      sqlite.pragma("busy_timeout = 5000");
    }
    try {
      migrate(drizzle(first), { migrationsFolder: migrations });
      first
        .prepare(
          `INSERT INTO user (id, email, handle, createdAt, updatedAt)
           VALUES ('user-1', 'one@example.test', 'user-one', 'now', 'now')`,
        )
        .run();
      first
        .prepare(
          `INSERT INTO workspaceConnection
           (id, userId, provider, externalAccountId, externalLogin, status,
            credentialGeneration, createdAt, updatedAt)
           VALUES ('connection-1', 'user-1', ?, '101', 'owner', 'connected', 1, ?, ?)`,
        )
        .run(WORKSPACE_PROVIDER_GITHUB, now, now);
      first
        .prepare(
          `INSERT INTO workspaceConnectionRepository
           (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
           VALUES ('connection-1', '201', '301', 'owner/repository', 1, ?)`,
        )
        .run(now);
      const concurrentPolicy = {
        ...policy,
        maxOperationsPerDay: 10,
        createThrottleMs: 0,
      };
      const makeService = (sqlite: Database.Database) => {
        const provider = new FakeProvider();
        const registry = new WorkspaceProviderRegistry();
        registry.register(provider);
        return new WorkspaceResourceService({
          repository: new WorkspaceResourceRepository(sqlite),
          repositories: new WorkspaceResourceRepository(sqlite),
          registry,
          credentials: { getCredential: async () => "ghu_access" },
          providerId: WORKSPACE_PROVIDER_GITHUB,
          requiredCapabilities: {
            disposable: true,
            exactLifecycle: true,
            personalBillingOnly: true,
          },
          policy: () => concurrentPolicy,
          now: () => now,
        });
      };
      const results = await Promise.allSettled([
        makeService(first).create("user-1", "301", "refs/heads/main"),
        makeService(second).create("user-1", "301", "refs/heads/main"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        first.prepare("SELECT COUNT(*) count FROM workspaceResource WHERE state = 'usable'").get(),
      ).toEqual({ count: 1 });
    } finally {
      second.close();
      first.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a repository grant generation replaced before durable reservation", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      value.provider.machineObservation = () => {
        value.sqlite
          .prepare(
            `UPDATE workspaceConnection
             SET credentialGeneration = credentialGeneration + 1, updatedAt = updatedAt + 1
             WHERE id = 'connection-1'`,
          )
          .run();
        value.sqlite
          .prepare("DELETE FROM workspaceConnectionRepository WHERE connectionId = 'connection-1'")
          .run();
      };

      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "REPOSITORY_NOT_ALLOWED",
      });
      expect(value.provider.createCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("persists intent, quota and only a capability digest before provider mutation", async () => {
    const value = fixture();
    try {
      value.provider.createObservation = () => {
        expect(value.sqlite.prepare("SELECT state FROM workspaceResource").get()).toEqual({
          state: "create_submitted",
        });
        expect(
          value.sqlite.prepare("SELECT submittedOperations FROM workspacePolicyUsage").get(),
        ).toEqual({
          submittedOperations: 1,
        });
        const capability = value.sqlite
          .prepare("SELECT capabilityHash FROM workspaceLifecycleCapability")
          .get() as { capabilityHash: string };
        expect(capability.capabilityHash).toMatch(/^[a-f0-9]{64}$/);
      };
      expect(value.service.listRepositories("user-1")).toEqual([
        {
          id: "301",
          fullName: "owner/repository",
          private: true,
        },
      ]);
      expect(value.service.listRepositories("user-2")).toEqual([
        {
          id: "302",
          fullName: "owner/second",
          private: true,
        },
      ]);
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      expect(created.resource.state).toBe("usable");
      expect(created.lifecycleCapability).not.toMatch(/^[a-f0-9]{64}$/);
      expect(value.repository.getByCapability("user-2", created.lifecycleCapability)).toBeNull();
      expect(value.repository.getByCapability("user-1", created.lifecycleCapability)?.id).toBe(
        created.resource.id,
      );
      expect(() => value.sqlite.prepare("DELETE FROM user WHERE id = 'user-1'").run()).toThrow(
        /FOREIGN KEY/,
      );
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");

      await value.service.release("user-1", created.resource.id, created.lifecycleCapability);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
      expect(
        value.sqlite
          .prepare(
            "SELECT submittedOperations, requiredCleanupOperations FROM workspacePolicyUsage",
          )
          .get(),
      ).toEqual({ submittedOperations: 3, requiredCleanupOperations: 2 });
      expect(
        value.sqlite
          .prepare("SELECT kind FROM workspaceProviderMutation ORDER BY createdAt, kind")
          .all(),
      ).toEqual([{ kind: "create" }, { kind: "delete" }, { kind: "stop" }]);
      expect(
        value.audits.map(({ action, state, outcome }) => ({ action, state, outcome })),
      ).toEqual([
        { action: "create", state: "usable", outcome: "verified_usable" },
        { action: "cleanup", state: "deleted", outcome: "verified_absent" },
      ]);
      for (const event of value.audits) {
        expect(Object.keys(event).sort()).toEqual([
          "action",
          "machine",
          "outcome",
          "provider",
          "resourceId",
          "state",
          "userId",
        ]);
        expect(Object.keys(event.machine).sort()).toEqual([
          "cpuCores",
          "memoryBytes",
          "name",
          "storageBytes",
        ]);
      }
      expect(JSON.stringify(value.audits)).not.toMatch(
        /ghu_|refresh|operationMarker|repositoryFullName|ProxyCommand|provider echoed/i,
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("recovers an accepted create after response loss without creating a duplicate", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      expect(pending.resource.state).toBe("create_submitted");
      expect(value.audits.at(-1)).toMatchObject({
        action: "create_pending",
        state: "create_submitted",
        outcome: "provider_outcome_unknown",
      });
      value.provider.loseCreateResponse = false;

      const restartedService = value.createService();
      await restartedService.reconcileOnce();
      expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe("usable");
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps accepted-background creation pending and reconciles it after visibility", async () => {
    const value = fixture();
    try {
      value.provider.createOutcome = "background";
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      expect(pending.resource).toMatchObject({ state: "create_submitted", claimId: null });
      value.provider.createOutcome = "accepted";
      await value.createService().reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe("usable");
    } finally {
      value.sqlite.close();
    }
  });

  test("makes definitive provider rejection terminal without a cleanup mutation", async () => {
    const value = fixture();
    try {
      value.provider.createOutcome = "rejected";
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_CREATE_REJECTED",
      });
      expect(
        value.sqlite.prepare("SELECT state, lastOutcome FROM workspaceResource").get(),
      ).toEqual({
        state: "rejected",
        lastOutcome: "provider_policy",
      });
      expect(value.audits).toEqual([
        expect.objectContaining({
          action: "create_rejected",
          state: "rejected",
          outcome: "provider_policy",
        }),
      ]);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("expires a usable remote TTL through exact cleanup on a restarted service", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.advance(policy.remoteTtlMs);
      const restartedService = value.createService();
      await restartedService.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe(
        "cleanup_pending",
      );
      await restartedService.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
    } finally {
      value.sqlite.close();
    }
  });

  test("does not reconcile a create while its provider submission lease is live", async () => {
    const value = fixture();
    try {
      let releaseCreate!: () => void;
      let observeCreate!: () => void;
      const enteredCreate = new Promise<void>((resolve) => {
        observeCreate = resolve;
      });
      value.provider.createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      value.provider.createObservation = observeCreate;

      const creating = value.service.create("user-1", "301", "refs/heads/main");
      await enteredCreate;
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(false);
      releaseCreate();
      await expect(creating).resolves.toMatchObject({ resource: { state: "usable" } });
    } finally {
      value.sqlite.close();
    }
  });

  test("reclaims an expired claim once across competing reconcilers", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.sqlite
        .prepare("UPDATE workspaceResource SET claimId = 'stale', claimExpiresAt = ? WHERE id = ?")
        .run(now - 1, pending.resource.id);
      value.provider.loseCreateResponse = false;
      const outcomes = await Promise.all([
        value.createService().reconcileOnce("user-1"),
        value.createService().reconcileOnce("user-1"),
      ]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe("usable");
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("enforces durable budgets and a kill switch before credential or provider contact", async () => {
    const value = fixture();
    try {
      await value.service.create("user-1", "301", "refs/heads/main");
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_POLICY_LIMIT",
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);

      value.repository.setControl({
        scope: "global",
        disabled: true,
        reason: "incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });
      const tokenCount = value.tokenCalls.mock.calls.length;
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toBeInstanceOf(
        WorkspaceResourceError,
      );
      expect(value.tokenCalls).toHaveBeenCalledTimes(tokenCount);
      expect(value.sqlite.prepare("SELECT state FROM workspaceResource").get()).toEqual({
        state: "cleanup_pending",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("provider-scoped disablement blocks create before health, credential, machine or mutation", async () => {
    const value = fixture();
    try {
      value.repository.setControl({
        scope: `provider:${WORKSPACE_PROVIDER_GITHUB}`,
        disabled: true,
        reason: "provider incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });

      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_PROVIDER_DISABLED",
      });
      expect(value.provider.healthCalls).not.toHaveBeenCalled();
      expect(value.tokenCalls).not.toHaveBeenCalled();
      expect(value.provider.machineCalls).not.toHaveBeenCalled();
      expect(value.provider.createCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects unavailable connector health before resolving a credential", async () => {
    const value = fixture();
    try {
      value.provider.healthAvailable = false;
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_PROVIDER_UNAVAILABLE",
      });
      expect(value.tokenCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps required cleanup non-deniable and blocks later create on the daily operation budget", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.release("user-1", created.resource.id, created.lifecycleCapability);
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_POLICY_LIMIT",
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
    } finally {
      value.sqlite.close();
    }
  });

  test("distinguishes create throttle, per-user concurrency and global concurrency", async () => {
    const throttled = fixture({
      maxOperationsPerDay: 10,
      maxActivePerUser: 2,
      createThrottleMs: 60_000,
    });
    try {
      throttled.provider.createOutcome = "rejected";
      await expect(
        throttled.service.create("user-1", "301", "refs/heads/main"),
      ).rejects.toMatchObject({ code: "WORKSPACE_CREATE_REJECTED" });
      throttled.provider.createOutcome = "accepted";
      await expect(
        throttled.service.create("user-1", "301", "refs/heads/main"),
      ).rejects.toMatchObject({ code: "WORKSPACE_POLICY_LIMIT" });
    } finally {
      throttled.sqlite.close();
    }

    const perUser = fixture({ maxOperationsPerDay: 10 });
    try {
      await perUser.service.create("user-1", "301", "refs/heads/main");
      await expect(
        perUser.service.create("user-1", "301", "refs/heads/other"),
      ).rejects.toMatchObject({ code: "WORKSPACE_POLICY_LIMIT" });
    } finally {
      perUser.sqlite.close();
    }

    const global = fixture({
      maxOperationsPerDay: 10,
      maxActivePerUser: 2,
      maxActiveGlobal: 1,
    });
    try {
      await global.service.create("user-1", "301", "refs/heads/main");
      await expect(global.service.create("user-2", "302", "refs/heads/main")).rejects.toMatchObject(
        { code: "WORKSPACE_POLICY_LIMIT" },
      );
    } finally {
      global.sqlite.close();
    }
  });

  test("a kill switch racing an accepted create retains exact cleanup authority", async () => {
    const value = fixture();
    try {
      value.provider.createObservation = () => {
        value.repository.setControl({
          scope: "global",
          disabled: true,
          reason: "incident",
          updatedBy: null,
          now,
          cleanupDeadlineAt: now + 30_000,
        });
      };
      const result = await value.service.create("user-1", "301", "refs/heads/main");
      expect(result.resource).toMatchObject({
        state: "cleanup_pending",
        providerResourceName: "silver-space-123",
      });

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", result.resource.id)?.state).toBe("deleted");
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("competing cleanup reconcilers submit one exact stop/delete sequence", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      expect(
        value.repository.requestCleanup(
          "user-1",
          created.resource.id,
          created.lifecycleCapability,
          now + 30_000,
          now,
        ),
      ).toBe(true);
      const outcomes = await Promise.all([
        value.createService().reconcileOnce("user-1"),
        value.createService().reconcileOnce("user-1"),
      ]);
      expect(outcomes.sort()).toEqual([false, true]);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("cleans every exact resource before connection revocation may continue", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.createService().cleanupBeforeDisconnect("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("a kill switch recovers and deletes an accepted create whose response was lost", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const result = await value.service.create("user-1", "301", "refs/heads/main");
      expect(result.resource.providerResourceName).toBeNull();
      value.repository.setControl({
        scope: `provider:${WORKSPACE_PROVIDER_GITHUB}`,
        disabled: true,
        reason: "incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", result.resource.id)).toMatchObject({
        state: "deleted",
        providerResourceName: "silver-space-123",
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("refuses to delete an exact name whose immutable identity no longer matches", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, ownerId: "999" };
      await value.service.release("user-1", created.resource.id, created.lifecycleCapability);
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe(
        "cleanup_pending",
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects a returned machine that differs from the explicitly selected machine", async () => {
    const value = fixture();
    try {
      value.provider.returnedMachine = { ...machine, memoryBytes: 4 * 1024 ** 3 };
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_RESOURCE_INVALID",
      });
      expect(value.sqlite.prepare("SELECT state FROM workspaceResource").get()).toEqual({
        state: "cleanup_pending",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("makes a verified Codespace unusable when its SSH connector capability is unavailable", async () => {
    const value = fixture();
    try {
      value.provider.connectorAvailable = false;
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_RESOURCE_INVALID",
      });
      expect(
        value.sqlite.prepare("SELECT state, lastOutcome FROM workspaceResource").get(),
      ).toEqual({
        state: "cleanup_pending",
        lastOutcome: "connector_unavailable",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("makes a personal-billing mismatch unusable before connector transport", async () => {
    const value = fixture();
    try {
      value.provider.returnedBillableOwnerId = "organization-202";
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "WORKSPACE_RESOURCE_INVALID",
      });
      expect(value.repository.listOwned("user-1", WORKSPACE_PROVIDER_GITHUB)[0]).toMatchObject({
        state: "cleanup_pending",
        lastOutcome: "verification_failed",
      });
      expect(value.provider.connectorCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a transitional returned resource pending without connector transport", async () => {
    const value = fixture();
    try {
      value.provider.returnedState = "provisioning";
      await expect(value.service.create("user-1", "301", "refs/heads/main")).resolves.toMatchObject({
        resource: {
          state: "create_submitted",
          providerResourceName: "silver-space-123",
          lastOutcome: "provisioning",
        },
      });
      expect(value.provider.connectorCalls).not.toHaveBeenCalled();
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("records multiple exact discovery matches as ambiguous without broad cleanup", async () => {
    const value = fixture({ maxOperationsPerDay: 10 });
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.loseCreateResponse = false;
      value.provider.ownedResources = [
        value.provider.resource!,
        { ...value.provider.resource!, name: "silver-space-duplicate" },
      ];

      await value.createService().reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", pending.resource.id)).toMatchObject({
        state: "ambiguous",
        lastOutcome: "multiple_exact_matches",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("makes an invisible create terminal only after its durable deadline", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = null;
      await value.createService().reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", pending.resource.id)).toMatchObject({
        state: "create_submitted",
        lastOutcome: "creation_not_visible",
      });

      value.advance(policy.createDeadlineMs);
      await value.createService().reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", pending.resource.id)).toMatchObject({
        state: "rejected",
        lastOutcome: "verified_no_created_resource",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});
