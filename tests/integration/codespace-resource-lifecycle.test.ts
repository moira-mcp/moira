import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CODESPACE_PROVIDER_GITHUB,
  CodespaceObservabilityService,
  CodespaceOperationRepository,
  CodespaceProviderRegistry,
  CodespaceResourceError,
  CodespaceResourceRepository,
  CodespaceResourceService,
  CodespaceTransferRepository,
  evaluateCodespaceResourcePolicy,
  projectCodespaceSummary,
  type CodespaceCreateProviderResult,
  type CodespaceMachine,
  type CodespaceProviderAdapter,
  type CodespaceProviderResource,
  type CodespaceResourcePolicy,
  type CodespaceResourceAuditEvent,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_750_000_000;
const machine: CodespaceMachine = {
  name: "basicLinux32gb",
  displayName: "Basic Linux",
  operatingSystem: "linux",
  cpuCores: 2,
  memoryBytes: 8 * 1024 ** 3,
  storageBytes: 32 * 1024 ** 3,
};
const policy: CodespaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 1,
  maxActiveGlobal: 2,
  createThrottleMs: 0,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  startWaitMs: 60_000,
};

class FakeProvider implements CodespaceProviderAdapter {
  readonly contractVersion = CODESPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities: CodespaceProviderAdapter["capabilities"];
  resource: CodespaceProviderResource | null = null;
  loseCreateResponse = false;
  createObservation: (() => void) | null = null;
  machineObservation: (() => void) | null = null;
  createGate: Promise<void> | null = null;
  startGate: Promise<void> | null = null;
  startObservation: (() => void) | null = null;
  returnedMachine: CodespaceMachine = machine;
  returnedBillableOwnerId = "101";
  returnedState: CodespaceProviderResource["state"] = "available";
  ownedResources: CodespaceProviderResource[] | null = null;
  connectorAvailable = true;
  healthAvailable = true;
  createOutcome: "accepted" | "background" | "rejected" = "accepted";
  /** What the provider said about a refusal, as the real adapter attaches it. */
  createRejectionDetail: string | null = null;
  /** A refusal raised the way the real client raises one: an error carrying a status and a reason. */
  startRefusal: { status: number; providerMessage?: string } | null = null;
  /** A real provider names each resource uniquely; tests that create twice set this. */
  resourceName = "silver-space-123";
  /** Other codespaces the provider holds, so several users' records can coexist in one test. */
  others: CodespaceProviderResource[] = [];
  /** The ref the provider reports for a created codespace; `undefined` echoes the request. */
  returnedRef: string | null | undefined = undefined;
  /**
   * A stop refused the way the real client refuses: an error with a status. `carriedOut` models a
   * provider that answered with an error but shut the codespace down anyway.
   */
  stopRefusal: { status: number; carriedOut?: boolean } | null = null;
  readonly healthCalls = jest.fn();
  readonly machineCalls = jest.fn();
  readonly createCalls = jest.fn();
  readonly connectorCalls = jest.fn();
  readonly startCalls = jest.fn();
  readonly stopCalls = jest.fn();
  readonly deleteCalls = jest.fn();
  /** Every provider observation, so a test can bound how often one tick looks at the provider. */
  readonly identityCalls = jest.fn();
  readonly listCalls = jest.fn();
  readonly exactCalls = jest.fn();

  constructor(
    // A provider id the registry has never seen is a case this suite exercises, so the parameter is
    // the adapter's id type widened to a string rather than the one built-in constant.
    readonly id: string = CODESPACE_PROVIDER_GITHUB,
    personalBillingOnly = true,
  ) {
    this.capabilities = {
      disposable: true,
      persistent: true,
      exactLifecycle: true,
      personalBillingOnly,
      connector: id === CODESPACE_PROVIDER_GITHUB ? "github-cli-ssh" : "managed-connector",
    };
  }

  async health() {
    this.healthCalls();
    return this.healthAvailable
      ? { state: "available" as const, reason: null }
      : { state: "unavailable" as const, reason: "tooling unavailable" };
  }
  async getIdentity() {
    this.identityCalls();
    return { id: "101", login: "owner" };
  }
  async listMachines(
    _credential: string,
    repository: Parameters<CodespaceProviderAdapter["listMachines"]>[1],
    ref: string,
  ) {
    this.machineCalls(repository, ref);
    this.machineObservation?.();
    return [machine];
  }
  guidance() {
    return {
      links: [
        {
          id: "provider_console" as const,
          url: `https://${this.id}.example/codespaces`,
          label: `${this.id} console`,
        },
      ],
      instructions: { ready: `${this.id} is ready` },
    };
  }
  async create(
    _token: string,
    input: Parameters<CodespaceProviderAdapter["create"]>[1],
  ): Promise<CodespaceCreateProviderResult> {
    this.createCalls(input);
    this.createObservation?.();
    this.resource = {
      name: this.resourceName,
      displayName: input.operationMarker,
      ownerId: "101",
      billableOwnerId: this.returnedBillableOwnerId,
      repositoryId: input.repository.id,
      repositoryFullName: input.repository.fullName,
      ref: this.returnedRef === undefined ? input.ref : this.returnedRef,
      state: this.returnedState,
      lastUsedAt: null,
      machine: this.returnedMachine,
      createdAt: now,
    };
    if (this.createGate) await this.createGate;
    if (this.loseCreateResponse) throw new Error("connection reset after submit");
    if (this.createOutcome === "rejected") {
      this.resource = null;
      return {
        outcome: "rejected",
        reason: "provider_policy",
        ...(this.createRejectionDetail ? { detail: this.createRejectionDetail } : {}),
      };
    }
    if (this.createOutcome === "background") return { outcome: "accepted", resource: null };
    return { outcome: "accepted", resource: this.resource };
  }
  async listOwned() {
    this.listCalls();
    return this.ownedResources ?? [...(this.resource ? [this.resource] : []), ...this.others];
  }
  async getExact(_token: string, name: string) {
    this.exactCalls(name);
    if (this.resource?.name === name) return this.resource;
    return this.others.find((other) => other.name === name) ?? null;
  }
  /** Moves the current codespace aside so the next create gets a fresh one. */
  park(nextName: string) {
    if (this.resource) this.others.push(this.resource);
    this.resource = null;
    this.resourceName = nextName;
  }
  private update(name: string, change: Partial<CodespaceProviderResource> | null) {
    if (this.resource?.name === name) {
      this.resource = change ? { ...this.resource, ...change } : null;
      return;
    }
    this.others = this.others.flatMap((other) =>
      other.name !== name ? [other] : change ? [{ ...other, ...change }] : [],
    );
  }
  /** Like GitHub, a codespace the provider is already moving refuses start and stop. */
  private refuseWhileTransitional(name: string) {
    const state = this.others.find((other) => other.name === name)?.state ?? this.resource?.state;
    if (state === "starting" || state === "stopping" || state === "provisioning") {
      throw Object.assign(new Error("GitHub API request failed"), { status: 409 });
    }
  }
  /** Like GitHub, a failed codespace cannot be stopped. */
  private refuseStopWhileFailed(name: string) {
    const state = this.others.find((other) => other.name === name)?.state ?? this.resource?.state;
    if (state === "failed") {
      throw Object.assign(new Error("GitHub API request failed"), { status: 409 });
    }
  }
  async stopExact(_token: string, name: string) {
    this.stopCalls(name);
    this.refuseWhileTransitional(name);
    this.refuseStopWhileFailed(name);
    if (this.stopRefusal) {
      if (this.stopRefusal.carriedOut) this.update(name, { state: "shutdown" });
      throw Object.assign(new Error("GitHub API request failed"), {
        status: this.stopRefusal.status,
      });
    }
    this.update(name, { state: "shutdown" });
    return "accepted" as const;
  }
  /** A provider that accepts a start without the codespace becoming available yet. */
  startStaysPending = false;
  async startExact(_token: string, name: string) {
    this.startCalls(name);
    this.refuseWhileTransitional(name);
    if (this.startRefusal) {
      throw Object.assign(new Error("GitHub API request failed"), this.startRefusal);
    }
    if (!this.startStaysPending) this.update(name, { state: "available" });
    this.startObservation?.();
    if (this.startGate) await this.startGate;
    return "accepted" as const;
  }
  async deleteExact(_token: string, name: string) {
    this.deleteCalls(name);
    this.update(name, null);
    return "accepted" as const;
  }
  async probeConnector() {
    this.connectorCalls();
    if (!this.connectorAvailable) throw new Error("remote ssh unavailable");
  }
}

function fixture(policyOverrides: Partial<CodespaceResourcePolicy> = {}) {
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
      `INSERT INTO codespaceConnection
     (id, userId, provider, externalAccountId, externalLogin, status,
      credentialGeneration, createdAt, updatedAt)
     VALUES ('connection-1', 'user-1', ?, '101', 'owner', 'connected', 1, ?, ?)`,
    )
    .run(CODESPACE_PROVIDER_GITHUB, now, now);
  sqlite
    .prepare(
      `INSERT INTO codespaceConnectionRepository
     (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
     VALUES ('connection-1', '201', '301', 'owner/repository', 1, ?)`,
    )
    .run(now);
  sqlite
    .prepare(
      `INSERT INTO codespaceConnection
       (id, userId, provider, externalAccountId, externalLogin, status,
        credentialGeneration, createdAt, updatedAt)
       VALUES ('connection-2', 'user-2', ?, '101', 'owner', 'connected', 1, ?, ?)`,
    )
    .run(CODESPACE_PROVIDER_GITHUB, now, now);
  sqlite
    .prepare(
      `INSERT INTO codespaceConnectionRepository
       (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
       VALUES ('connection-2', '202', '302', 'owner/second', 1, ?)`,
    )
    .run(now);
  const repository = new CodespaceResourceRepository(sqlite);
  const provider = new FakeProvider();
  const registry = new CodespaceProviderRegistry();
  registry.register(provider);
  const tokenCalls = jest.fn<() => Promise<string>>().mockResolvedValue("ghu_access");
  const audits: CodespaceResourceAuditEvent[] = [];
  const auditDedupeKeys = new Set<string>();
  let currentTime = now;
  const effectivePolicy = { ...policy, ...policyOverrides };
  const createService = () =>
    new CodespaceResourceService({
      repository,
      repositories: repository,
      registry,
      credentials: { getCredential: tokenCalls },
      providerId: CODESPACE_PROVIDER_GITHUB,
      requiredCapabilities: {
        exactLifecycle: true,
        personalBillingOnly: true,
      },
      policy: () => effectivePolicy,
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds;
      },
      audit: (event) => {
        if (event.dedupeKey !== undefined) {
          if (auditDedupeKeys.has(event.dedupeKey)) return;
          auditDedupeKeys.add(event.dedupeKey);
        }
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
    clock: () => currentTime,
    policy: effectivePolicy,
    audits,
  };
}

describe("durable persistent codespace lifecycle", () => {
  test("forwards the requested ref when selecting a provider machine", async () => {
    const value = fixture();
    try {
      await value.service.create("user-1", "301", "refs/heads/feature/current-machines");
      expect(value.provider.machineCalls).toHaveBeenCalledWith(
        expect.objectContaining({ id: "301", fullName: "owner/repository" }),
        "refs/heads/feature/current-machines",
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps start, stop and delete usable after the provider repository is renamed", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = {
        ...value.provider.resource!,
        repositoryFullName: "owner/renamed-repository",
      };

      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({
        state: "stopped",
      });
      expect(value.repository.getOwned("user-1", created.resource.id)?.repositoryFullName).toBe(
        "owner/renamed-repository",
      );
      await expect(
        value.service.startCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({
        state: "usable",
      });
      const current = value.service.getCodespace("user-1", created.resource.id);
      await expect(
        value.service.deleteCodespace("user-1", created.resource.id, current.generation),
      ).resolves.toMatchObject({ state: "deleted" });
    } finally {
      value.sqlite.close();
    }
  });

  test("still refuses lifecycle access when the provider repository id changes", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, repositoryId: "different-id" };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_RESOURCE_INVALID",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("reports instance-disabled setup before repository and capacity checks", () => {
    const value = fixture({ enabled: false });
    try {
      expect(value.service.setupSituation("user-1", "301")).toBe("instance_disabled");
    } finally {
      value.sqlite.close();
    }
  });

  test("distinguishes an approved repository from a missing or mismatched one", () => {
    const value = fixture();
    try {
      expect(value.service.setupSituation("user-1", "301")).toBe("ready");
      expect(value.service.setupSituation("user-1", "different-repository")).toBe(
        "repository_not_approved",
      );
      value.sqlite
        .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = 'connection-1'")
        .run();
      expect(value.service.setupSituation("user-1")).toBe("repository_not_approved");
    } finally {
      value.sqlite.close();
    }
  });

  test("reports the creation ceiling after an approved repository reaches capacity", async () => {
    const value = fixture();
    try {
      await value.service.create("user-1", "301", "refs/heads/main");
      expect(value.service.setupSituation("user-1", "301")).toBe("ceiling_reached");
    } finally {
      value.sqlite.close();
    }
  });

  test("binds the same core lifecycle to a non-GitHub provider without installation concepts", async () => {
    const value = fixture();
    try {
      value.sqlite.prepare("UPDATE codespaceConnection SET provider = 'managed-cloud'").run();
      value.sqlite
        .prepare("UPDATE codespaceConnectionRepository SET externalRepositoryId = 'project-alpha'")
        .run();
      const provider = new FakeProvider("managed-cloud", false);
      provider.returnedBillableOwnerId = "moira-billing-account";
      const registry = new CodespaceProviderRegistry();
      registry.register(provider);
      const service = new CodespaceResourceService({
        repository: value.repository,
        repositories: value.repository,
        registry,
        providerId: "managed-cloud",
        requiredCapabilities: { exactLifecycle: true },
        credentials: {
          getCredential: async (userId, providerId) => `${userId}:${providerId}:opaque`,
        },
        policy: () => value.policy,
        now: () => now,
      });
      expect(service.setupGuidance("ready")).toEqual({
        provider: "managed-cloud",
        situation: "ready",
        instruction: "managed-cloud is ready",
        links: [
          {
            id: "provider_console",
            url: "https://managed-cloud.example/codespaces",
            label: "managed-cloud console",
          },
        ],
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
          `INSERT INTO codespaceConnection
           (id, userId, provider, externalAccountId, externalLogin, status,
            credentialGeneration, createdAt, updatedAt)
           VALUES ('connection-1', 'user-1', ?, '101', 'owner', 'connected', 1, ?, ?)`,
        )
        .run(CODESPACE_PROVIDER_GITHUB, now, now);
      first
        .prepare(
          `INSERT INTO codespaceConnectionRepository
           (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
           VALUES ('connection-1', '201', '301', 'owner/repository', 1, ?)`,
        )
        .run(now);
      const concurrentPolicy = {
        ...policy,
        createThrottleMs: 0,
      };
      const makeService = (sqlite: Database.Database) => {
        const provider = new FakeProvider();
        const registry = new CodespaceProviderRegistry();
        registry.register(provider);
        return new CodespaceResourceService({
          repository: new CodespaceResourceRepository(sqlite),
          repositories: new CodespaceResourceRepository(sqlite),
          registry,
          credentials: { getCredential: async () => "ghu_access" },
          providerId: CODESPACE_PROVIDER_GITHUB,
          requiredCapabilities: {
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
        first.prepare("SELECT COUNT(*) count FROM codespaceResource WHERE state = 'usable'").get(),
      ).toEqual({ count: 1 });
    } finally {
      second.close();
      first.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a repository grant generation replaced before durable reservation", async () => {
    const value = fixture();
    try {
      value.provider.machineObservation = () => {
        value.sqlite
          .prepare(
            `UPDATE codespaceConnection
             SET credentialGeneration = credentialGeneration + 1, updatedAt = updatedAt + 1
             WHERE id = 'connection-1'`,
          )
          .run();
        value.sqlite
          .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = 'connection-1'")
          .run();
      };

      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "REPOSITORY_NOT_ALLOWED",
      });
      expect(value.provider.createCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    [403, "CODESPACE_AUTHORIZATION_REQUIRED"],
    [404, "CODESPACE_RESOURCE_INVALID"],
    [502, "CODESPACE_PROVIDER_UNAVAILABLE"],
  ])(
    "maps a provider HTTP %s before reservation to the typed %s error without an internal failure",
    async (status, code) => {
      const value = fixture();
      try {
        value.provider.machineObservation = () => {
          throw Object.assign(new Error(`GitHub API request failed (HTTP ${status})`), { status });
        };

        await expect(
          value.service.create("user-1", "301", "refs/heads/main"),
        ).rejects.toMatchObject({
          name: "CodespaceResourceError",
          code,
        });
        expect(value.provider.createCalls).not.toHaveBeenCalled();
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceResource").get()).toEqual({
          count: 0,
        });
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("rejects a repository grant removed before durable reservation", async () => {
    const value = fixture();
    try {
      value.provider.machineObservation = () => {
        value.sqlite
          .prepare("DELETE FROM codespaceConnectionRepository WHERE connectionId = 'connection-1'")
          .run();
      };

      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "REPOSITORY_NOT_ALLOWED",
      });
      expect(value.provider.createCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("cancels an unsubmitted persistent create before disconnect", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserveCreate({
        userId: "user-1",
        provider: CODESPACE_PROVIDER_GITHUB,
        connectionId: "connection-1",
        authorizationGeneration: 1,
        repository: { id: "301", fullName: "owner/repository", private: true },
        requestedRef: "refs/heads/main",
        machine,
        externalAccountId: "101",
        policy: value.policy,
        now,
      });
      expect(reserved.outcome).toBe("reserved");

      await expect(value.service.cleanupBeforeDisconnect("user-1")).resolves.toBeUndefined();
      // A finished codespace leaves the caller-facing listing but keeps its stored record.
      expect(value.service.listResources("user-1")).toEqual([]);
      expect(value.repository.listOwned("user-1", CODESPACE_PROVIDER_GITHUB)[0]).toMatchObject({
        state: "rejected",
        desiredState: "deleted",
        observedState: "absent",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("lets stop win while a submitted create has not returned its provider identity", async () => {
    const value = fixture();
    try {
      let releaseCreate!: () => void;
      let observeCreate!: () => void;
      const enteredCreate = new Promise<void>((resolve) => {
        observeCreate = resolve;
      });
      value.provider.createObservation = observeCreate;
      value.provider.createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });

      const creating = value.service.create("user-1", "301", "refs/heads/main");
      await enteredCreate;
      const codespaceId = value.service.listResources("user-1")[0].id;
      const stopping = value.createService().stopCodespace("user-1", codespaceId);
      await expect(stopping).resolves.toMatchObject({
        state: "stopped",
        desiredState: "stopped",
        observedState: "stopped",
      });
      releaseCreate();
      await expect(creating).resolves.toMatchObject({
        resource: { state: "stopped", desiredState: "stopped" },
      });
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("records a provider-deleted persistent codespace as absent instead of retrying stop", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = null;
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({
        state: "deleted",
        desiredState: "deleted",
        observedState: "absent",
        lastOutcome: "verified_externally_absent",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("does not advance lifecycle generation for repeated pending start or delete intent", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);

      const firstStart = value.repository.requestStart("user-1", created.resource.id, now + 1);
      if (!firstStart || typeof firstStart === "string") throw new Error("start was not reserved");
      expect(firstStart).toMatchObject({ state: "start_pending" });
      const repeatedStart = value.repository.requestStart("user-1", created.resource.id, now + 2);
      if (!repeatedStart || typeof repeatedStart === "string")
        throw new Error("pending start disappeared");
      expect(repeatedStart).toMatchObject({ generation: firstStart.generation });

      const firstDelete = value.repository.requestDelete(
        "user-1",
        created.resource.id,
        repeatedStart.generation,
        now + 3,
      );
      if (!firstDelete || typeof firstDelete === "string")
        throw new Error("delete was not reserved");
      expect(firstDelete).toMatchObject({ state: "delete_pending" });
      const repeatedDelete = value.repository.requestDelete(
        "user-1",
        created.resource.id,
        firstDelete.generation,
        now + 4,
      );
      if (!repeatedDelete || typeof repeatedDelete === "string")
        throw new Error("pending delete disappeared");
      expect(repeatedDelete).toMatchObject({ generation: firstDelete.generation });
      expect(
        value.sqlite
          .prepare("SELECT kind, COUNT(*) count FROM codespaceProviderMutation GROUP BY kind")
          .all(),
      ).toEqual(
        expect.arrayContaining([
          { kind: "start", count: 1 },
          { kind: "delete", count: 1 },
        ]),
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("persists codespace data across stop/start and deletes only on an explicit delete", async () => {
    const value = fixture();
    try {
      value.provider.createObservation = () => {
        expect(value.sqlite.prepare("SELECT state FROM codespaceResource").get()).toEqual({
          state: "create_submitted",
        });
        expect(value.sqlite.prepare("SELECT * FROM codespacePolicyUsage").all()).toEqual([]);
        const capability = value.sqlite
          .prepare("SELECT capabilityHash FROM codespaceLifecycleCapability")
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
      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        state: "stopped",
        retentionPolicy: "persistent",
        desiredState: "stopped",
        observedState: "stopped",
      });
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();

      await value.service.startCodespace("user-1", created.resource.id);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");
      expect(value.provider.startCalls).toHaveBeenCalledTimes(1);

      const deletable = value.service.getCodespace("user-1", created.resource.id);
      await expect(
        value.service.deleteCodespace("user-1", created.resource.id, deletable.generation - 1),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
      await value.service.deleteCodespace("user-1", created.resource.id, deletable.generation);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
      expect(
        value.sqlite.prepare("SELECT requiredCleanupOperations FROM codespacePolicyUsage").get(),
      ).toEqual({ requiredCleanupOperations: 0 });
      expect(
        value.sqlite
          .prepare("SELECT kind FROM codespaceProviderMutation ORDER BY createdAt, kind")
          .all(),
      ).toEqual([{ kind: "create" }, { kind: "delete" }, { kind: "start" }, { kind: "stop" }]);
      expect(
        value.audits.map(({ action, state, outcome }) => ({ action, state, outcome })),
      ).toEqual([
        { action: "create", state: "usable", outcome: "verified_usable" },
        { action: "stop", state: "stopped", outcome: "verified_stopped" },
        { action: "start", state: "usable", outcome: "verified_running" },
        { action: "delete", state: "deleted", outcome: "verified_absent" },
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
        code: "CODESPACE_CREATE_REJECTED",
      });
      expect(
        value.sqlite.prepare("SELECT state, lastOutcome FROM codespaceResource").get(),
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

  test("carries the provider's own reason for a refused creation to the record and the audit", async () => {
    const value = fixture();
    try {
      value.provider.createOutcome = "rejected";
      value.provider.createRejectionDetail = "retention_period_minutes exceeds the maximum";
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "CODESPACE_CREATE_REJECTED",
        detail: "retention_period_minutes exceeds the maximum",
      });
      // The audit entry is the record that survives a container swap; a reason that lives only in a
      // container log is gone the moment the container is recreated, which is how the production
      // refusals became undiagnosable.
      expect(value.audits.at(-1)).toMatchObject({
        action: "create_rejected",
        outcome: "provider_policy",
        reason: "retention_period_minutes exceeds the maximum",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    [400, "CODESPACE_RESOURCE_INVALID", "Machine type is unavailable for this repository"],
    [403, "CODESPACE_AUTHORIZATION_REQUIRED", "Codespaces are disabled for this repository"],
    [409, "CODESPACE_RESOURCE_INVALID", "The codespace is already starting"],
    [500, "CODESPACE_PROVIDER_UNAVAILABLE", "We are having trouble"],
  ])(
    "a start refused with HTTP %i is classified as %s and keeps the provider's reason",
    async (status, code, providerMessage) => {
      // Before this, a refused start left the client as an unclassified error and the caller was
      // told only that something failed internally — with neither the status nor the reason.
      const value = fixture();
      try {
        const created = await value.service.create("user-1", "301", "refs/heads/main");
        await value.service.stopCodespace("user-1", created.resource.id);
        value.provider.startRefusal = { status, providerMessage };
        await expect(
          value.service.startCodespace("user-1", created.resource.id),
        ).rejects.toMatchObject({ code, detail: providerMessage });
        // The thrown error dies with the request and the connector log dies with the container, so
        // the audit entry is the only record of a refused start that outlives the next deploy.
        expect(value.audits.at(-1)).toMatchObject({
          action: "start",
          outcome: `provider_refused_${status}`,
          reason: providerMessage,
        });
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("a refused delete is audited as a delete", async () => {
    // The third branch of the same mapping: a delete request is the one whose record is already
    // marked for deletion, so it must not be filed under the stop that a deletion also implies.
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      const deletable = value.service.getCodespace("user-1", created.resource.id);
      value.provider.deleteExact = async () => {
        throw Object.assign(new Error("GitHub API request failed"), {
          status: 500,
          providerMessage: "We are having trouble",
        });
      };
      await expect(
        value.service.deleteCodespace("user-1", created.resource.id, deletable.generation),
      ).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
        detail: "We are having trouble",
      });
      expect(value.audits.at(-1)).toMatchObject({
        action: "delete",
        outcome: "provider_refused_500",
        reason: "We are having trouble",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("a refused stop is audited as a stop, not as the start that preceded it", async () => {
    // One funnel serves start, stop and delete, so the audited action has to come from what the
    // record was actually doing; otherwise every refusal would be filed under the same heading.
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.stopExact = async () => {
        throw Object.assign(new Error("GitHub API request failed"), {
          status: 409,
          providerMessage: "The codespace is being deleted",
        });
      };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_RESOURCE_INVALID",
        detail: "The codespace is being deleted",
      });
      expect(value.audits.at(-1)).toMatchObject({
        action: "stop",
        outcome: "provider_refused_409",
        reason: "The codespace is being deleted",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("collapses an identical lifecycle refusal across fresh and concurrent reconcilers", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      value.provider.startRefusal = {
        status: 403,
        providerMessage: "Codespaces are disabled for this repository",
      };
      await expect(
        value.service.startCodespace("user-1", created.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_AUTHORIZATION_REQUIRED",
      });
      const refusalCount = () =>
        value.audits.filter((event) => event.outcome === "provider_refused_403").length;
      expect(refusalCount()).toBe(1);
      expect(value.audits.at(-1)?.dedupeKey).toMatch(/^codespace-refusal:[0-9a-f]{64}$/);

      await Promise.allSettled([
        value.createService().reconcileOnce("user-1"),
        value.createService().reconcileOnce("user-1"),
      ]);
      expect(refusalCount()).toBe(1);

      value.provider.startRefusal = {
        status: 403,
        providerMessage: "Repository policy changed",
      };
      // The failed pass deferred the record by one reconcile interval before it is due again.
      value.advance(value.policy.reconcileIntervalMs);
      await value.createService().reconcileOnce("user-1");
      expect(refusalCount()).toBe(2);
      expect(value.audits.at(-1)).toMatchObject({ reason: "Repository policy changed" });
    } finally {
      value.sqlite.close();
    }
  });

  test("a failure that is not a provider refusal stays an internal failure", async () => {
    // The classification must be narrow: catching everything would dress a genuine internal fault
    // as "the provider refused", which is worse than the silence it replaces.
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      // No status at all: this is what a bug inside Moira looks like, not a provider refusal.
      value.provider.startRefusal = { status: undefined as unknown as number };
      const refusal = await value.service
        .startCodespace("user-1", created.resource.id)
        .then(() => null)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as { code?: string }).code).toBeUndefined();
      // And it is not filed as the provider's answer either: an audit entry saying the provider
      // refused would send an operator to GitHub for a fault that lives in Moira.
      expect(value.audits.map((event) => event.outcome)).not.toContainEqual(
        expect.stringContaining("provider_refused"),
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("does not delete a persistent codespace when the legacy remote TTL expires", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      // Its stored remote expiry is its creation time, already past: only the persistent retention
      // keeps it out of expiry.
      value.advance(60_000);
      const restartedService = value.createService();
      await expect(restartedService.reconcileOnce("user-1")).resolves.toBe(false);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a legacy disposable codespace still expires at the time stamped when it was created", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.sqlite
        .prepare(
          "UPDATE codespaceResource SET retentionPolicy = 'legacy_disposable', remoteExpiresAt = ? WHERE id = ?",
        )
        .run(now + 60_000, created.resource.id);

      await expect(value.createService().reconcileOnce("user-1")).resolves.toBe(false);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");

      value.advance(60_000);
      await expect(value.createService().reconcileOnce("user-1")).resolves.toBe(true);
      const expired = value.repository.getOwned("user-1", created.resource.id);
      expect(expired?.state).toBe("cleanup_pending");
      expect(expired?.lastOutcome).toBe("remote_ttl_expired");
    } finally {
      value.sqlite.close();
    }
  });

  test("prevents another tenant from listing, getting, stopping or deleting a codespace", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      expect(value.service.listResources("user-2")).toEqual([]);
      expect(() => value.service.getCodespace("user-2", created.resource.id)).toThrow(
        CodespaceResourceError,
      );
      await expect(
        value.service.stopCodespace("user-2", created.resource.id),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
      await expect(
        value.service.deleteCodespace("user-2", created.resource.id, created.resource.generation),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    ["same account and grant", false, false, 1],
    ["different account", true, false, 0],
    ["revoked repository grant", false, true, 0],
  ] as const)(
    "reauthorization rebinds only after exact verification for %s, whatever branch is checked out",
    async (_name, changeAccount, removeGrant, expectedRebound) => {
      const value = fixture();
      try {
        const created = await value.service.create("user-1", "301", "refs/heads/main");
        value.provider.resource = { ...value.provider.resource!, ref: "feature" };
        value.sqlite
          .prepare(
            `UPDATE codespaceConnection SET credentialGeneration = 2,
             externalAccountId = ?, updatedAt = updatedAt + 1 WHERE id = 'connection-1'`,
          )
          .run(changeAccount ? "999" : "101");
        if (removeGrant) {
          value.sqlite
            .prepare(
              "DELETE FROM codespaceConnectionRepository WHERE connectionId = 'connection-1'",
            )
            .run();
        }

        await expect(value.service.rebindAfterAuthorization("user-1")).resolves.toBe(
          expectedRebound,
        );
        expect(
          value.repository.getOwned("user-1", created.resource.id)?.authorizationGeneration,
        ).toBe(expectedRebound === 1 ? 2 : 1);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("lets a concurrent stop generation win over an in-flight start", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      let releaseStart!: () => void;
      let observeStart!: () => void;
      const enteredStart = new Promise<void>((resolve) => {
        observeStart = resolve;
      });
      value.provider.startObservation = observeStart;
      value.provider.startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
      });

      const starting = value.service.startCodespace("user-1", created.resource.id);
      await enteredStart;
      await value.createService().stopCodespace("user-1", created.resource.id);
      releaseStart();
      await starting;

      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        state: "stopped",
        desiredState: "stopped",
        observedState: "stopped",
      });
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
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
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.sqlite
        .prepare("UPDATE codespaceResource SET claimId = 'stale', claimExpiresAt = ? WHERE id = ?")
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
        code: "CODESPACE_POLICY_LIMIT",
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
      expect(value.tokenCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.healthCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.machineCalls).toHaveBeenCalledTimes(1);

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
        CodespaceResourceError,
      );
      expect(value.tokenCalls).toHaveBeenCalledTimes(tokenCount);
      expect(value.sqlite.prepare("SELECT state FROM codespaceResource").get()).toEqual({
        state: "stop_pending",
      });
      expect(
        value.sqlite.prepare("SELECT requiredCleanupOperations FROM codespacePolicyUsage").get(),
      ).toEqual({ requiredCleanupOperations: 1 });
    } finally {
      value.sqlite.close();
    }
  });

  test("provider-scoped disablement blocks create before health, credential, machine or mutation", async () => {
    const value = fixture();
    try {
      value.repository.setControl({
        scope: `provider:${CODESPACE_PROVIDER_GITHUB}`,
        disabled: true,
        reason: "provider incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });

      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_DISABLED",
      });
      expect(value.provider.healthCalls).not.toHaveBeenCalled();
      expect(value.tokenCalls).not.toHaveBeenCalled();
      expect(value.provider.machineCalls).not.toHaveBeenCalled();
      expect(value.provider.createCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceResource").get()).toEqual({
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
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      expect(value.tokenCalls).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceResource").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("lists only codespaces a caller can still act on", async () => {
    const value = fixture({ createThrottleMs: 0, maxActivePerUser: 4, maxActiveGlobal: 4 });
    try {
      const deleted = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.deleteCodespace(
        "user-1",
        deleted.resource.id,
        deleted.resource.generation,
      );

      value.provider.resourceName = "silver-space-456";
      const stopped = await value.service.create("user-1", "301", "refs/heads/other");
      await value.service.stopCodespace("user-1", stopped.resource.id);

      value.provider.resourceName = "silver-space-789";
      value.provider.createOutcome = "rejected";
      await expect(value.service.create("user-1", "301", "refs/heads/third")).rejects.toMatchObject(
        {
          code: "CODESPACE_CREATE_REJECTED",
        },
      );
      value.provider.createOutcome = "accepted";

      value.provider.resourceName = "silver-space-101";
      value.provider.createOutcome = "background";
      const pending = await value.service.create("user-1", "301", "refs/heads/fourth");
      expect(pending.resource.state).toBe("create_submitted");

      const stored = value.repository.listOwned("user-1", CODESPACE_PROVIDER_GITHUB);
      expect(stored.map((resource) => resource.state).sort()).toEqual([
        "create_submitted",
        "deleted",
        "rejected",
        "stopped",
      ]);
      // Only the codespace that can still be started, used or deleted is offered to a caller.
      expect(
        value.service
          .listResources("user-1")
          .map((resource) => ({ id: resource.id, state: resource.state }))
          .sort((left, right) => left.state.localeCompare(right.state)),
      ).toEqual([
        { id: pending.resource.id, state: "create_submitted" },
        { id: stopped.resource.id, state: "stopped" },
      ]);
      // A finished codespace stays reachable by its own identifier.
      expect(value.service.getCodespace("user-1", deleted.resource.id)).toMatchObject({
        id: deleted.resource.id,
        state: "deleted",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("admits a later create on the same day as a delete", async () => {
    const value = fixture({ createThrottleMs: 0 });
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.deleteCodespace(
        "user-1",
        created.resource.id,
        created.resource.generation,
      );
      value.provider.resourceName = "silver-space-456";
      const again = await value.service.create("user-1", "301", "refs/heads/main");
      expect(again.resource.state).toBe("usable");
      expect(value.provider.createCalls).toHaveBeenCalledTimes(2);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      // The day's row survives for cleanup accounting; a confirmed delete requires none.
      expect(
        value.sqlite.prepare("SELECT requiredCleanupOperations FROM codespacePolicyUsage").get(),
      ).toEqual({ requiredCleanupOperations: 0 });
    } finally {
      value.sqlite.close();
    }
  });

  test("lets one user hold several codespaces under the shipped ceilings", async () => {
    // The shipped ceilings are the subject: a value that was merely raised but still refuses the
    // second codespace, or a refusal that repeats the generic quota sentence, fails here.
    const shipped = evaluateCodespaceResourcePolicy(() => undefined);
    const value = fixture({
      maxActivePerUser: shipped.maxActivePerUser,
      maxActiveGlobal: shipped.maxActiveGlobal,
      createThrottleMs: 0,
    });
    try {
      expect(shipped.maxActivePerUser).toBeGreaterThan(1);
      for (let index = 0; index < shipped.maxActivePerUser; index += 1) {
        value.provider.resourceName = `silver-space-${index}`;
        const created = await value.service.create("user-1", "301", `refs/heads/task-${index}`);
        expect(created.resource.state).toBe("usable");
      }
      expect(value.service.listResources("user-1")).toHaveLength(shipped.maxActivePerUser);

      value.provider.resourceName = "silver-space-over";
      await expect(
        value.service.create("user-1", "301", "refs/heads/one-too-many"),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining(String(shipped.maxActivePerUser)),
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(shipped.maxActivePerUser);
    } finally {
      value.sqlite.close();
    }
  });

  test("distinguishes create throttle, per-user concurrency and global concurrency", async () => {
    const throttled = fixture({
      maxActivePerUser: 2,
      createThrottleMs: 60_000,
    });
    try {
      throttled.provider.createOutcome = "rejected";
      await expect(
        throttled.service.create("user-1", "301", "refs/heads/main"),
      ).rejects.toMatchObject({ code: "CODESPACE_CREATE_REJECTED" });
      throttled.provider.createOutcome = "accepted";
      await expect(
        throttled.service.create("user-1", "301", "refs/heads/main"),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("throttled"),
      });
    } finally {
      throttled.sqlite.close();
    }

    const perUser = fixture();
    try {
      await perUser.service.create("user-1", "301", "refs/heads/main");
      await expect(
        perUser.service.create("user-1", "301", "refs/heads/other"),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("per-user ceiling"),
      });
    } finally {
      perUser.sqlite.close();
    }

    const global = fixture({
      maxActivePerUser: 2,
      maxActiveGlobal: 1,
    });
    try {
      await global.service.create("user-1", "301", "refs/heads/main");
      const instanceRefusal = await global.service.create("user-2", "302", "refs/heads/main").then(
        () => null,
        (error: CodespaceResourceError) => error,
      );
      expect(instanceRefusal).toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("instance"),
      });
      // The refused caller learns that the instance is full, never who occupies it.
      expect(instanceRefusal?.detail).not.toMatch(/user-1|301|owner\/repository/);
    } finally {
      global.sqlite.close();
    }
  });

  test("a kill switch racing an accepted create retains exact stop authority", async () => {
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
        state: "stop_pending",
        providerResourceName: "silver-space-123",
      });

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", result.resource.id)?.state).toBe("stopped");
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("competing cleanup reconcilers submit one exact delete and no stop before it", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.sqlite
        .prepare("UPDATE codespaceResource SET retentionPolicy = 'legacy_disposable' WHERE id = ?")
        .run(created.resource.id);
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
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("stops every persistent codespace before connection revocation may continue", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.createService().cleanupBeforeDisconnect("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("stopped");
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a kill switch recovers and stops an accepted create whose response was lost", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const result = await value.service.create("user-1", "301", "refs/heads/main");
      expect(result.resource.providerResourceName).toBeNull();
      value.repository.setControl({
        scope: `provider:${CODESPACE_PROVIDER_GITHUB}`,
        disabled: true,
        reason: "incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", result.resource.id)).toMatchObject({
        state: "stopped",
        providerResourceName: "silver-space-123",
      });
      expect(value.provider.createCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("refuses to stop an exact name whose immutable identity no longer matches", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, ownerId: "999" };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("stop_pending");
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects a returned machine that differs from the explicitly selected machine", async () => {
    const value = fixture();
    try {
      value.provider.returnedMachine = { ...machine, memoryBytes: 4 * 1024 ** 3 };
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "CODESPACE_RESOURCE_INVALID",
      });
      expect(value.sqlite.prepare("SELECT state FROM codespaceResource").get()).toEqual({
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
        code: "CODESPACE_RESOURCE_INVALID",
      });
      expect(
        value.sqlite.prepare("SELECT state, lastOutcome FROM codespaceResource").get(),
      ).toEqual({
        state: "cleanup_pending",
        lastOutcome: "connector_unavailable",
      });
      // The rejection audit carries the bounded probe failure so operators can tell a
      // connector outage from a verification mismatch; usable creations carry no reason.
      expect(value.audits.find((event) => event.action === "create_rejected")).toMatchObject({
        outcome: "connector_unavailable",
        reason: "remote ssh unavailable",
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
        code: "CODESPACE_RESOURCE_INVALID",
      });
      expect(value.repository.listOwned("user-1", CODESPACE_PROVIDER_GITHUB)[0]).toMatchObject({
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
      await expect(value.service.create("user-1", "301", "refs/heads/main")).resolves.toMatchObject(
        {
          resource: {
            state: "create_submitted",
            providerResourceName: "silver-space-123",
            lastOutcome: "provisioning",
          },
        },
      );
      expect(value.provider.connectorCalls).not.toHaveBeenCalled();
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("records multiple exact discovery matches as ambiguous without broad cleanup", async () => {
    const value = fixture();
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

  test("wakes a stopped codespace for the work that needs it and refuses one that cannot wake", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      // The required state is that the command's own call woke the codespace. The wrong state that
      // looks the same is a codespace that happened to be awake already, so the stopped state is
      // observed immediately before the call and the provider's start is counted.
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("stopped");
      const startsBefore = value.provider.startCalls.mock.calls.length;

      const running = await value.service.ensureRunning("user-1", created.resource.id);

      expect(running).toMatchObject({ state: "usable", desiredState: "running" });
      expect(value.provider.startCalls.mock.calls.length).toBe(startsBefore + 1);

      // A codespace that is already usable is not started again.
      await value.service.ensureRunning("user-1", created.resource.id);
      expect(value.provider.startCalls.mock.calls.length).toBe(startsBefore + 1);

      await value.service.deleteCodespace(
        "user-1",
        created.resource.id,
        value.repository.getOwned("user-1", created.resource.id)!.generation,
      );
      const startsAfterDelete = value.provider.startCalls.mock.calls.length;
      await expect(
        value.service.ensureRunning("user-1", created.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_NOT_RUNNING",
        detail: expect.stringContaining("deleted"),
      });
      expect(value.provider.startCalls.mock.calls.length).toBe(startsAfterDelete);
    } finally {
      value.sqlite.close();
    }
  });

  test("refuses by the wait it exhausted when a started codespace never becomes usable", async () => {
    const value = fixture({ startWaitMs: 120_000, reconcileIntervalMs: 30_000 });
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      value.provider.startStaysPending = true;

      await expect(
        value.service.ensureRunning("user-1", created.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_START_TIMEOUT",
        detail: expect.stringContaining("120 seconds"),
      });

      // The wait is bounded by time, and so is what it costs the provider: convergence re-asserts
      // the start each interval, and four intervals of thirty seconds fit inside two minutes while
      // the fifth does not, so one caller cannot turn one command into unbounded provider traffic.
      expect(value.provider.startCalls.mock.calls.length).toBe(5);
      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        desiredState: "running",
        state: "start_pending",
      });
    } finally {
      value.sqlite.close();
    }
  });
});

type Fixture = ReturnType<typeof fixture>;

/** What an agent's operation needs from a codespace before it may reserve work on it. */
function reserveOperation(value: Fixture, codespaceId: string) {
  return new CodespaceOperationRepository(value.sqlite).reserve({
    userId: "user-1",
    resourceId: codespaceId,
    inputBytes: 0,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 512,
    deadlineAt: now + 60_000,
    policy: value.policy,
    now,
  }).outcome;
}

/** A re-authorization as completeConnection records it: a new connection generation, no migration. */
function reauthorize(value: Fixture, connectionId: string, accountId = "101") {
  value.sqlite
    .prepare(
      `UPDATE codespaceConnection SET credentialGeneration = credentialGeneration + 1,
       externalAccountId = ?, updatedAt = updatedAt + 1 WHERE id = ?`,
    )
    .run(accountId, connectionId);
}

function resourceRow(value: Fixture, codespaceId: string) {
  return value.sqlite
    .prepare(
      `SELECT state, desiredState, claimExpiresAt, reconcileFailures, authorizationGeneration,
       lastOutcome FROM codespaceResource WHERE id = ?`,
    )
    .get(codespaceId) as {
    state: string;
    desiredState: string;
    claimExpiresAt: number | null;
    reconcileFailures: number;
    authorizationGeneration: number;
    lastOutcome: string | null;
  };
}

describe("codespace identity is not the checked-out branch", () => {
  test("stop, start, rebind, operation reservation and delete keep working after the agent switches branch", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      const id = created.resource.id;
      value.provider.resource = { ...value.provider.resource!, ref: "feature" };

      await expect(value.service.stopCodespace("user-1", id)).resolves.toMatchObject({
        state: "stopped",
      });
      await expect(value.service.startCodespace("user-1", id)).resolves.toMatchObject({
        state: "usable",
      });
      expect(reserveOperation(value, id)).toBe("reserved");

      reauthorize(value, "connection-1");
      expect(value.repository.hasCurrentAuthorization("user-1", id)).toBe(false);
      await expect(value.service.rebindAfterAuthorization("user-1")).resolves.toBe(1);
      expect(value.repository.hasCurrentAuthorization("user-1", id)).toBe(true);

      const current = value.service.getCodespace("user-1", id);
      await expect(
        value.service.deleteCodespace("user-1", id, current.generation),
      ).resolves.toMatchObject({ state: "deleted" });
      expect(value.provider.resource).toBeNull();
    } finally {
      value.sqlite.close();
    }
  });

  test("reports the branch the provider observed separately from the requested ref", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      expect(projectCodespaceSummary(created.resource)).toMatchObject({
        requested_ref: "refs/heads/main",
        current_ref: "refs/heads/main",
      });

      value.provider.resource = { ...value.provider.resource!, ref: "feature" };
      const stopped = await value.service.stopCodespace("user-1", created.resource.id);
      expect(projectCodespaceSummary(stopped)).toMatchObject({
        requested_ref: "refs/heads/main",
        current_ref: "feature",
      });

      // A detached HEAD reports no ref; it is working state, not a broken codespace.
      value.provider.resource = { ...value.provider.resource!, ref: null };
      const started = await value.service.startCodespace("user-1", created.resource.id);
      expect(started).toMatchObject({ state: "usable", observedRef: null });
    } finally {
      value.sqlite.close();
    }
  });

  test("lifecycle discovery binds a lost-response codespace whose branch already changed", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, ref: "feature" };
      value.repository.setControl({
        scope: "global",
        disabled: true,
        reason: "incident",
        updatedBy: null,
        now,
        cleanupDeadlineAt: now + 30_000,
      });

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", pending.resource.id)).toMatchObject({
        state: "stopped",
        providerResourceName: "silver-space-123",
        observedRef: "feature",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("cleanup deletes a disposable codespace whose branch changed", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.sqlite
        .prepare("UPDATE codespaceResource SET retentionPolicy = 'legacy_disposable' WHERE id = ?")
        .run(created.resource.id);
      value.provider.resource = { ...value.provider.resource!, ref: "feature" };
      value.repository.requestCleanup(
        "user-1",
        created.resource.id,
        created.lifecycleCapability,
        now + 30_000,
        now,
      );

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("deleted");
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    ["the short name of the requested branch", "usable", "main"],
    ["no ref yet", "usable", null],
    ["a different branch", "cleanup_pending", "other"],
  ] as const)(
    "adoption compares the requested ref by branch name: a codespace reporting %s becomes %s",
    async (_name, state, returnedRef) => {
      const value = fixture();
      try {
        value.provider.returnedRef = returnedRef;
        const result = await value.service
          .create("user-1", "301", "refs/heads/main")
          .then((created) => created.resource.state)
          .catch((error: CodespaceResourceError) => error.code);
        expect(result).toBe(state === "usable" ? "usable" : "CODESPACE_RESOURCE_INVALID");
        expect(value.repository.listOwned("user-1", CODESPACE_PROVIDER_GITHUB)[0]?.state).toBe(
          state,
        );
      } finally {
        value.sqlite.close();
      }
    },
  );
});

describe("lifecycle looks at the provider before acting", () => {
  test("a codespace the provider already shut down completes a pending stop without a stop call", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.repository.requestStop("user-1", created.resource.id, now);
      value.provider.resource = { ...value.provider.resource!, state: "shutdown" };

      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        state: "stopped",
        observedState: "stopped",
        lastOutcome: "verified_stopped",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a codespace that is still shutting down waits, then completes once shut down", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, state: "stopping" };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({ state: "stop_pending", lastOutcome: "provider_stopping" });

      value.provider.resource = { ...value.provider.resource!, state: "shutdown" };
      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("stopped");
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a start requested while the codespace is still stopping waits instead of failing", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      value.provider.resource = { ...value.provider.resource!, state: "stopping" };

      await expect(
        value.service.startCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({ state: "start_pending", lastOutcome: "provider_stopping" });
      expect(value.provider.startCalls).not.toHaveBeenCalled();

      value.provider.resource = { ...value.provider.resource!, state: "shutdown" };
      await value.service.reconcileOnce("user-1");
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");
      expect(value.provider.startCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("deleting a running codespace deletes it directly without stopping it first", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await expect(
        value.service.deleteCodespace("user-1", created.resource.id, created.resource.generation),
      ).resolves.toMatchObject({ state: "deleted" });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
      expect(value.provider.deleteCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("a refused stop the provider carried out anyway settles as stopped", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.stopRefusal = { status: 502, carriedOut: true };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({ state: "stopped" });
    } finally {
      value.sqlite.close();
    }
  });

  test("a failing stop backs off exponentially up to its cap while another user's record is reconciled", async () => {
    const value = fixture();
    try {
      const first = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.park("silver-space-456");
      const second = await value.service.create("user-2", "302", "refs/heads/main");
      await value.service.stopCodespace("user-2", second.resource.id);
      value.repository.requestStart("user-2", second.resource.id, now);
      // A pending stop outranks a pending start in the claim order, so without a backoff the
      // failing stop would be claimed on every pass and the start would never be reached.
      value.repository.requestStop("user-1", first.resource.id, now);
      value.provider.stopRefusal = { status: 503 };

      await value.service.reconcileOnce();
      await value.service.reconcileOnce();
      expect(value.repository.getOwned("user-2", second.resource.id)?.state).toBe("usable");
      expect(resourceRow(value, first.resource.id)).toMatchObject({
        state: "stop_pending",
        reconcileFailures: 1,
        claimExpiresAt: now + policy.reconcileIntervalMs,
      });

      // Each retry happens exactly when the previous backoff ends; the next one is measured from it.
      let clock = now;
      const delays: number[] = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        const due = resourceRow(value, first.resource.id).claimExpiresAt!;
        await expect(value.service.reconcileOnce("user-1")).resolves.toBe(false);
        value.advance(due - clock);
        clock = due;
        await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
        delays.push(resourceRow(value, first.resource.id).claimExpiresAt! - clock);
      }
      expect(resourceRow(value, first.resource.id)).toMatchObject({ state: "stop_pending" });
      expect(delays.slice(0, 4)).toEqual([2, 4, 8, 16].map((factor) => factor * 60_000));
      expect(delays.at(-1)).toBe(30 * 60_000);
    } finally {
      value.sqlite.close();
    }
  });
});

describe("re-authorization rebinds codespaces and fencing stays fair", () => {
  test("a same-account re-authorization rebinds a codespace on another branch and lifecycle and reservation work", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      const id = created.resource.id;
      value.provider.resource = { ...value.provider.resource!, ref: "feature" };
      reauthorize(value, "connection-1");
      // Fenced until the reconciler re-verifies it: the look-alike that stays here is the defect.
      await expect(value.service.stopCodespace("user-1", id)).rejects.toMatchObject({
        code: "CODESPACE_RESOURCE_INVALID",
        message: expect.stringContaining("Reconnect"),
      });

      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(resourceRow(value, id).authorizationGeneration).toBe(2);
      expect(reserveOperation(value, id)).toBe("reserved");
      await expect(value.service.stopCodespace("user-1", id)).resolves.toMatchObject({
        state: "stopped",
      });
      await expect(value.service.ensureRunning("user-1", id)).resolves.toMatchObject({
        state: "usable",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    ["a different provider account", (value: Fixture) => reauthorize(value, "connection-1", "999")],
    [
      "a disconnect",
      (value: Fixture) =>
        value.sqlite
          .prepare(
            "UPDATE codespaceConnection SET status = 'disconnected' WHERE id = 'connection-1'",
          )
          .run(),
    ],
  ])("%s keeps the codespace fenced", async (_name, change) => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      change(value);
      await value.service.reconcileOnce("user-1");
      expect(value.repository.hasCurrentAuthorization("user-1", created.resource.id)).toBe(false);
      await expect(
        value.service.startCodespace("user-1", created.resource.id),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
    } finally {
      value.sqlite.close();
    }
  });

  test("one record that can never be rebound does not hold another user's rebind back", async () => {
    const value = fixture();
    try {
      const unrebindable = await value.service.create("user-1", "301", "refs/heads/main");
      // Same name, another owner: the provider resource is no longer this record's.
      value.provider.resource = { ...value.provider.resource!, ownerId: "999" };
      value.provider.park("silver-space-456");
      value.advance(1);
      const rebindable = await value.service.create("user-2", "302", "refs/heads/main");
      reauthorize(value, "connection-1");
      reauthorize(value, "connection-2");

      // Two scheduled ticks, one reconcile interval apart, the first after the re-authorizations.
      value.advance(value.policy.reconcileIntervalMs);
      await value.service.reconcileOnce();
      value.advance(value.policy.reconcileIntervalMs);
      await value.service.reconcileOnce();
      expect(resourceRow(value, rebindable.resource.id).authorizationGeneration).toBe(2);
      expect(resourceRow(value, unrebindable.resource.id).authorizationGeneration).toBe(1);
    } finally {
      value.sqlite.close();
    }
  });
});

describe("a stuck production-shaped codespace converges by ordinary reconciliation", () => {
  test.each([
    ["shut down", "stop_pending", "shutdown", "stopped"],
    ["running", "stop_pending", "available", "stopped"],
    ["shut down", "start_pending", "shutdown", "usable"],
    ["running", "start_pending", "available", "usable"],
  ] as const)(
    "a codespace the provider reports %s, recorded %s on a switched branch with a stale authorization",
    async (_name, recordState, providerState, settled) => {
      const value = fixture();
      try {
        const created = await value.service.create("user-1", "301", "refs/heads/main");
        const id = created.resource.id;
        value.provider.resource = {
          ...value.provider.resource!,
          ref: "fix/production-branch",
          state: providerState,
        };
        // The record as production held it: pending after repeated refusals, still bound to the
        // authorization generation that was current before the user re-authorized.
        value.sqlite
          .prepare(
            `UPDATE codespaceResource SET state = ?, desiredState = ?, generation = generation + 5,
             lastOutcome = 'lifecycle_reconcile_required', reconcileFailures = 3
             WHERE id = ?`,
          )
          .run(recordState, recordState === "stop_pending" ? "stopped" : "running", id);
        reauthorize(value, "connection-1");

        for (let tick = 0; tick < 3; tick++) {
          await value.service.reconcileOnce();
          value.advance(value.policy.reconcileIntervalMs);
        }
        expect(resourceRow(value, id)).toMatchObject({
          state: settled,
          authorizationGeneration: 2,
          reconcileFailures: 0,
        });
        expect(value.provider.stopCalls.mock.calls.length).toBe(
          recordState === "stop_pending" && providerState === "available" ? 1 : 0,
        );

        await expect(value.service.ensureRunning("user-1", id)).resolves.toMatchObject({
          state: "usable",
        });
        expect(reserveOperation(value, id)).toBe("reserved");
        expect(value.service.getCodespace("user-1", id).observedRef).toBe("fix/production-branch");
      } finally {
        value.sqlite.close();
      }
    },
  );
});

describe("starting a codespace Moira has not bound to a provider resource", () => {
  test("an ambiguous codespace refuses start as not startable rather than not found", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.loseCreateResponse = false;
      value.provider.ownedResources = [
        value.provider.resource!,
        { ...value.provider.resource!, name: "silver-space-duplicate" },
      ];
      await value.service.reconcileOnce("user-1");
      expect(value.service.getCodespace("user-1", pending.resource.id).state).toBe("ambiguous");

      await expect(
        value.service.startCodespace("user-1", pending.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_NOT_RUNNING",
        detail: expect.stringContaining("ambiguous"),
      });
      expect(value.provider.startCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a codespace still being identified refuses start as pending rather than not found", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = null;
      await expect(
        value.service.stopCodespace("user-1", pending.resource.id),
      ).resolves.toMatchObject({ state: "stop_pending", providerResourceName: null });

      await expect(
        value.service.startCodespace("user-1", pending.resource.id),
      ).rejects.toMatchObject({
        code: "CODESPACE_CREATE_PENDING",
        detail: expect.stringContaining("stop_pending"),
      });
    } finally {
      value.sqlite.close();
    }
  });
});

describe("one scheduled tick looks at each codespace at most once", () => {
  const observations = (value: Fixture) =>
    value.provider.identityCalls.mock.calls.length +
    value.provider.listCalls.mock.calls.length +
    value.provider.exactCalls.mock.calls.length;

  test.each([
    [
      "a create the provider is still provisioning",
      (value: Fixture) => {
        value.provider.returnedState = "provisioning";
      },
      (_value: Fixture) => {},
    ],
    [
      "a background-accepted create the provider does not list yet",
      (value: Fixture) => {
        value.provider.createOutcome = "background";
      },
      (value: Fixture) => {
        value.provider.resource = null;
      },
    ],
  ])(
    "%s is reconciled once per tick and still meets its create deadline",
    async (_name, arrange, afterCreate) => {
      const value = fixture();
      try {
        arrange(value);
        const pending = await value.service.create("user-1", "301", "refs/heads/main");
        afterCreate(value);
        expect(pending.resource.state).toBe("create_submitted");
        value.provider.identityCalls.mockClear();
        value.provider.listCalls.mockClear();
        value.provider.exactCalls.mockClear();
        const auditsBefore = value.audits.length;

        await value.service.reconcileTick();
        // One pass: the identity plus one exact read or one listing, never a pass per batch slot.
        expect(observations(value)).toBeLessThanOrEqual(2);
        expect(value.audits.length - auditsBefore).toBeLessThanOrEqual(1);

        // A second tick in the same instant finds nothing due: the record waits for the next one.
        await value.service.reconcileTick();
        expect(observations(value)).toBeLessThanOrEqual(2);

        // The deferral never outlives the create deadline, so an unfinished create still ends there.
        value.provider.resource = null;
        value.advance(value.policy.createDeadlineMs);
        await value.service.reconcileTick();
        expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe("rejected");
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("a disposable cleanup whose resource is not visible yet is reconciled once per tick", async () => {
    const value = fixture();
    try {
      value.provider.loseCreateResponse = true;
      const pending = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = null;
      value.sqlite
        .prepare(
          `UPDATE codespaceResource SET retentionPolicy = 'legacy_disposable',
           state = 'cleanup_pending', desiredState = 'deleted', claimId = NULL,
           claimExpiresAt = NULL WHERE id = ?`,
        )
        .run(pending.resource.id);
      value.provider.identityCalls.mockClear();
      value.provider.listCalls.mockClear();

      await value.service.reconcileTick();
      expect(observations(value)).toBeLessThanOrEqual(2);
      expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe(
        "cleanup_pending",
      );

      value.advance(value.policy.createDeadlineMs);
      await value.service.reconcileTick();
      expect(value.repository.getOwned("user-1", pending.resource.id)?.state).toBe("deleted");
    } finally {
      value.sqlite.close();
    }
  });
});

describe("codespaces that are gone or failed at the provider still converge", () => {
  test("a codespace deleted on the provider before a re-authorization is rebound, then deletes and frees its slot", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = null;
      reauthorize(value, "connection-1");

      await value.service.reconcileOnce("user-1");
      expect(resourceRow(value, created.resource.id).authorizationGeneration).toBe(2);
      const current = value.service.getCodespace("user-1", created.resource.id);
      await expect(
        value.service.deleteCodespace("user-1", created.resource.id, current.generation),
      ).resolves.toMatchObject({ state: "deleted", observedState: "absent" });

      value.provider.resourceName = "silver-space-456";
      await expect(value.service.create("user-1", "301", "refs/heads/main")).resolves.toMatchObject(
        { resource: { state: "usable" } },
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("a stop of a codespace the provider reports failed completes without a refused stop call", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.resource = { ...value.provider.resource!, state: "failed" };
      await expect(
        value.service.stopCodespace("user-1", created.resource.id),
      ).resolves.toMatchObject({ state: "stopped", observedState: "failed" });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});

/** Stores a user's value for one of the codespace idle settings, as the settings screen would. */
function setPreference(value: Fixture, userId: string, key: string, stored: string) {
  value.sqlite
    .prepare(
      `INSERT OR IGNORE INTO settingDefinition
       (key, type, category, label, createdAt, updatedAt) VALUES (?, 'string', 'codespaces', ?, 0, 0)`,
    )
    .run(key, key);
  value.sqlite
    .prepare(
      `INSERT INTO userSettingValue (userId, settingKey, value, encrypted, updatedAt)
       VALUES (?, ?, ?, 0, 0)
       ON CONFLICT DO UPDATE SET value = excluded.value`,
    )
    .run(userId, key, stored);
}

const MINUTE = 60_000;

describe("idle codespaces pause on their own", () => {
  // GitHub's own idle timer ignores silent background commands, so any provider timeout shorter
  // than its maximum could stop a codespace under a long agent command. The owner's timeout is
  // Moira's to enforce; the provider always gets its maximum.
  test.each([
    ["the default settings", null, null],
    ["a chosen 45-minute timeout", "true", "45"],
    ["auto-pause turned off", "false", "45"],
  ] as const)(
    "creation asks the provider for its maximum 240-minute idle timeout with %s",
    async (_name, autoStop, timeout) => {
      const value = fixture();
      try {
        if (autoStop !== null)
          setPreference(value, "user-1", "codespaces.auto_stop_enabled", autoStop);
        if (timeout !== null)
          setPreference(value, "user-1", "codespaces.idle_timeout_minutes", timeout);
        await value.service.create("user-1", "301", "refs/heads/main");
        expect(value.provider.createCalls).toHaveBeenCalledWith(
          expect.objectContaining({ idleTimeoutMinutes: 240 }),
        );
      } finally {
        value.sqlite.close();
      }
    },
  );

  /**
   * A codespace created at `now`, then 31 minutes of simulated time in two scheduled ticks: the
   * first observes the provider (a record observed in a tick is judged in the next), the second
   * decides. Returns the record afterwards.
   */
  async function afterIdleWindow(value: Fixture, arrange: (id: string) => void = () => {}) {
    const created = await value.service.create("user-1", "301", "refs/heads/main");
    value.advance(31 * MINUTE);
    arrange(created.resource.id);
    await value.service.reconcileTick();
    value.advance(value.policy.reconcileIntervalMs);
    await value.service.reconcileTick();
    return value.repository.getOwned("user-1", created.resource.id)!;
  }

  test("a codespace idle past its owner's 30 minutes is stopped with an idle outcome", async () => {
    const value = fixture();
    try {
      const record = await afterIdleWindow(value);
      expect(record).toMatchObject({ state: "stopped", desiredState: "stopped" });
      expect(value.audits).toContainEqual(
        expect.objectContaining({ action: "stop", outcome: "idle_stop_requested" }),
      );
      expect(value.provider.stopCalls).toHaveBeenCalledTimes(1);

      // The next command still works: start-on-use wakes it.
      await expect(value.service.ensureRunning("user-1", record.id)).resolves.toMatchObject({
        state: "usable",
      });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    [
      "auto-pause is turned off",
      (value: Fixture) => setPreference(value, "user-1", "codespaces.auto_stop_enabled", "false"),
    ],
    [
      "Moira used it a minute ago",
      (value: Fixture, id: string) =>
        value.sqlite
          .prepare("UPDATE codespaceResource SET lastActivityAt = ? WHERE id = ?")
          .run(value.clock() - MINUTE, id),
    ],
    [
      "a background command is still running in it",
      (value: Fixture, id: string) => {
        expect(reserveOperation(value, id)).toBe("reserved");
        // Old enough that only its running state, not its last change, keeps the codespace awake.
        value.sqlite
          .prepare(
            "UPDATE codespaceOperation SET state = 'running', updatedAt = ? WHERE resourceId = ?",
          )
          .run(now, id);
        value.sqlite
          .prepare("UPDATE codespaceResource SET lastActivityAt = ? WHERE id = ?")
          .run(now, id);
      },
    ],
  ])("a codespace is not stopped when %s", async (_name, arrange) => {
    const value = fixture();
    try {
      const record = await afterIdleWindow(value, (id) => arrange(value, id));
      expect(record).toMatchObject({ state: "usable", desiredState: "running" });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("a recent provider last start does not prevent the idle stop", async () => {
    // GitHub's `last_used_at` is the codespace's last start, not a sign of use; only agent activity
    // through Moira keeps a codespace awake.
    const value = fixture();
    try {
      const record = await afterIdleWindow(value, () => {
        value.provider.resource = {
          ...value.provider.resource!,
          lastUsedAt: value.clock() - MINUTE,
        };
      });
      expect(record).toMatchObject({
        state: "stopped",
        desiredState: "stopped",
        providerLastUsedAt: expect.any(Number),
      });
      expect(value.audits).toContainEqual(
        expect.objectContaining({ action: "stop", outcome: "idle_stop_requested" }),
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("an operation reserved while the idle stop is being decided proceeds and nothing stops", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      value.advance(31 * MINUTE);
      await value.service.reconcileTick();
      value.advance(value.policy.reconcileIntervalMs);
      // The reservation lands between the idle scan and the stop it would lead to.
      const scan = value.repository.listIdleStopCandidates.bind(value.repository);
      let operationId: string | null = null;
      value.repository.listIdleStopCandidates = (...args) => {
        const candidates = scan(...args);
        const reservation = new CodespaceOperationRepository(value.sqlite).reserve({
          userId: "user-1",
          resourceId: created.resource.id,
          inputBytes: 0,
          stdoutLimitBytes: 1024,
          stderrLimitBytes: 512,
          deadlineAt: value.clock() + MINUTE,
          policy: value.policy,
          now: value.clock(),
        });
        operationId = reservation.operation?.id ?? null;
        return candidates;
      };
      await value.service.reconcileTick();

      expect(operationId).not.toBeNull();
      expect(
        value.sqlite.prepare("SELECT state FROM codespaceOperation WHERE id = ?").get(operationId),
      ).toEqual({ state: "reserved" });
      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        state: "usable",
        desiredState: "running",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});

describe("the provider's own view of running codespaces is observed periodically", () => {
  test("a codespace the provider stopped on its own is recorded stopped with its last start time, listing once per interval", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      const interval = value.policy.reconcileIntervalMs * 10;
      value.provider.listCalls.mockClear();

      await value.service.reconcileTick();
      expect(value.provider.listCalls).toHaveBeenCalledTimes(1);

      const lastUsedAt = value.clock() + 2 * MINUTE;
      value.provider.resource = { ...value.provider.resource!, state: "shutdown", lastUsedAt };
      value.advance(interval - 1);
      await value.service.reconcileTick();
      expect(value.provider.listCalls).toHaveBeenCalledTimes(1);
      expect(value.repository.getOwned("user-1", created.resource.id)?.state).toBe("usable");

      value.advance(1);
      await value.service.reconcileTick();
      expect(value.provider.listCalls).toHaveBeenCalledTimes(2);
      expect(value.repository.getOwned("user-1", created.resource.id)).toMatchObject({
        state: "stopped",
        desiredState: "stopped",
        observedState: "stopped",
        providerLastUsedAt: lastUsedAt,
        lastOutcome: "provider_observed_stopped",
      });
      expect(value.provider.stopCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});

describe("each user sees their own codespace limits beside their use", () => {
  function limitsOf(value: Fixture, userId: string) {
    return new CodespaceObservabilityService({
      providerId: CODESPACE_PROVIDER_GITHUB,
      config: () => ({ state: "absent" }) as never,
      policy: () => value.policy,
      resources: value.repository,
      operations: new CodespaceOperationRepository(value.sqlite),
      transfers: new CodespaceTransferRepository(value.sqlite),
      transport: null,
      now: value.clock,
    }).limits(userId);
  }

  test("a user holding a running and a stopped codespace sees both held against the configured ceiling", async () => {
    // Values that are nobody's default, so a number that comes from anywhere but the policy fails.
    const value = fixture({
      maxActivePerUser: 7,
      maxActiveGlobal: 9,
      createThrottleMs: 0,
      maxConcurrentOperationsPerUser: 3,
      maxTransferObjectsPerUser: 6,
      maxTransferBytesPerUser: 5 * 1024 * 1024,
      maxTransferInflightBytesPerUser: 3 * 1024 * 1024,
      persistentRetentionMs: 12 * 24 * 60 * 60_000,
    });
    try {
      const running = await value.service.create("user-1", "301", "refs/heads/main");
      value.provider.park("silver-space-456");
      const stopped = await value.service.create("user-1", "301", "refs/heads/other");
      await value.service.stopCodespace("user-1", stopped.resource.id);
      value.provider.park("silver-space-789");
      await value.service.create("user-2", "302", "refs/heads/main");
      expect(reserveOperation(value, running.resource.id)).toBe("reserved");
      const transfers = new CodespaceTransferRepository(value.sqlite);
      const reserveTransfer = (declaredSize: number) =>
        transfers.reserve({
          userId: "user-1",
          purpose: "codespace_download",
          fileName: "result.txt",
          mimeType: "text/plain",
          declaredSize,
          ownerPid: 1,
          ownerStartTime: null,
          policy: value.policy,
          now: value.clock(),
        })!;
      // One transfer still in flight, and one already stored: only the first counts as in flight.
      reserveTransfer(2048);
      const stored = reserveTransfer(1024);
      value.sqlite
        .prepare("UPDATE codespaceTransfer SET state = 'ready' WHERE id = ?")
        .run(stored.record.id);

      const limits = limitsOf(value, "user-1");
      expect(limits.codespaces).toEqual({
        held: 2,
        max_per_user: 7,
        instance_held: 3,
        max_instance: 9,
        create_throttle_seconds: 0,
      });
      expect(limits.operations).toMatchObject({ active: 1, max_concurrent_per_user: 3 });
      expect(limits.transfers).toMatchObject({
        used_bytes: 3072,
        objects: 2,
        inflight_bytes: 2048,
        max_bytes_per_user: 5 * 1024 * 1024,
        max_inflight_bytes_per_user: 3 * 1024 * 1024,
        max_objects_per_user: 6,
      });
      expect(limits.lifecycle).toMatchObject({ retention_days: 12, start_wait_seconds: 60 });
      expect(limits.machine_ceiling).toEqual({
        cpu_cores: value.policy.maxCpuCores,
        memory_bytes: value.policy.maxMemoryBytes,
        storage_bytes: value.policy.maxStorageBytes,
      });
      // Nothing the provider did not say is presented as a number.
      expect(limits.provider).toEqual({ billing: "unavailable" });
      // Another user's view counts only their own codespace.
      expect(limitsOf(value, "user-2").codespaces).toMatchObject({ held: 1, instance_held: 3 });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    ["never changed", null, null, { auto_stop_enabled: true, timeout_minutes: 30 }],
    ["turned off", "false", null, { auto_stop_enabled: false, timeout_minutes: 30 }],
    ["set to 45 minutes", "true", "45", { auto_stop_enabled: true, timeout_minutes: 45 }],
  ] as const)(
    "the idle block reports auto-pause %s, with GitHub's own 240-minute maximum",
    (_name, autoStop, timeout, expected) => {
      const value = fixture();
      try {
        if (autoStop !== null)
          setPreference(value, "user-1", "codespaces.auto_stop_enabled", autoStop);
        if (timeout !== null)
          setPreference(value, "user-1", "codespaces.idle_timeout_minutes", timeout);
        expect(limitsOf(value, "user-1").lifecycle.idle).toEqual({
          ...expected,
          provider_max_minutes: 240,
        });
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("the per-user refusal says stopped codespaces are held and deleting one frees a slot", async () => {
    const value = fixture();
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      value.provider.park("silver-space-456");
      await expect(value.service.create("user-1", "301", "refs/heads/main")).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        message: "Codespace per-user held limit reached",
        detail: expect.stringMatching(
          /hold 1 codespaces.*Stopped codespaces count too.*delete one/,
        ),
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("the instance refusal says stopped codespaces are held too", async () => {
    const value = fixture({ maxActivePerUser: 2, maxActiveGlobal: 1 });
    try {
      const created = await value.service.create("user-1", "301", "refs/heads/main");
      await value.service.stopCodespace("user-1", created.resource.id);
      value.provider.park("silver-space-456");
      await expect(value.service.create("user-2", "302", "refs/heads/main")).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        message: "Codespace instance held limit reached",
        detail: expect.stringMatching(/ceiling of 1 held codespaces.*stopped ones count/),
      });
    } finally {
      value.sqlite.close();
    }
  });
});
