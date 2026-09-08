import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import {
  WorkspaceOperationRepository,
  WorkspaceOperationService,
  WorkspaceResourceRepository,
  type WorkspaceOperationResult,
  type WorkspaceOperationTransport,
  type WorkspaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_850_000_000;
const policy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 2,
  maxActiveGlobal: 10,
  maxOperationsPerDay: 10,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  maxConcurrentOperationsPerUser: 1,
  maxConcurrentOperationsGlobal: 2,
  maxOperationInputBytes: 1024,
  maxOperationStdoutBytes: 1024,
  maxOperationStderrBytes: 512,
  maxOperationMs: 60_000,
};

class FakeTransport implements WorkspaceOperationTransport {
  executeResult: WorkspaceOperationResult | { state: "running" } = {
    state: "succeeded",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  };
  cancelResult: WorkspaceOperationResult | { state: "running" } | { state: "absent" } = {
    state: "running",
  };
  throwExecute = false;
  throwFinalize = false;
  lastWorkspace: Parameters<WorkspaceOperationTransport["execute"]>[1] | null = null;
  executeGate: Promise<void> | null = null;
  executeObservation: (() => void) | null = null;
  lastInspectedOperation: Parameters<WorkspaceOperationTransport["inspect"]>[2] | null = null;
  readonly executeCalls = jest.fn();
  readonly inspectCalls = jest.fn();
  readonly cancelCalls = jest.fn();
  readonly finalizeCalls = jest.fn();

  async execute(
    _credential: string,
    workspace: Parameters<WorkspaceOperationTransport["execute"]>[1],
  ) {
    this.executeCalls();
    this.lastWorkspace = workspace;
    if (this.throwExecute) throw new Error("ssh response lost");
    this.executeObservation?.();
    if (this.executeGate) await this.executeGate;
    return this.executeResult;
  }

  async inspect(
    _credential: string,
    _workspace: Parameters<WorkspaceOperationTransport["inspect"]>[1],
    operation: Parameters<WorkspaceOperationTransport["inspect"]>[2],
  ) {
    this.inspectCalls();
    this.lastInspectedOperation = operation;
    return this.executeResult;
  }

  async cancel() {
    this.cancelCalls();
    return this.cancelResult;
  }

  async finalize() {
    this.finalizeCalls();
    if (this.throwFinalize) throw new Error("remote cleanup unavailable");
  }
}

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(`
    INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES
      ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
      ('user-2', 'two@example.test', 'user-two', 'now', 'now');
    INSERT INTO workspaceConnection
      (id, userId, provider, externalAccountId, externalLogin, status,
       credentialGeneration, createdAt, updatedAt)
      VALUES ('connection-1', 'user-1', 'github-codespaces', '101', 'owner',
              'connected', 1, ${now}, ${now});
    INSERT INTO workspaceConnectionRepository
      (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
      VALUES ('connection-1', '201', '301', 'owner/repository', 1, ${now});
    INSERT INTO workspaceResource
      (id, userId, connectionId, authorizationGeneration, provider, repositoryId,
       repositoryFullName, requestedRef, operationMarker, providerResourceName,
       externalOwnerId, billableOwnerId, machineName, machineDisplayName,
       machineOperatingSystem, machineCpuCores, machineMemoryBytes, machineStorageBytes,
       state, retentionPolicy, desiredState, observedState, generation,
       createDeadlineAt, remoteExpiresAt, createdAt, updatedAt)
      VALUES ('workspace-1', 'user-1', 'connection-1', 1, 'github-codespaces', '301',
       'owner/repository', 'refs/heads/main', 'moira-workspace', 'silver-space', '101', '101',
       'basic', 'Basic', 'linux', 2, 8589934592, 34359738368,
       'usable', 'persistent', 'running', 'running', 1, ${now + 30_000},
       ${now + 60_000}, ${now}, ${now});
  `);
  const repository = new WorkspaceOperationRepository(sqlite);
  const transport = new FakeTransport();
  const credentials = { getCredential: jest.fn(async () => "ghu_access") };
  let currentNow = now;
  const service = new WorkspaceOperationService({
    repository,
    transport,
    credentials,
    policy: () => policy,
    now: () => currentNow,
  });
  return {
    sqlite,
    repository,
    transport,
    credentials,
    service,
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

describe("durable direct workspace operations", () => {
  test("preserves argv boundaries and exact exit 23 without persisting command or stdin", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = {
        state: "failed",
        stdout: "partial output",
        stderr: "expected failure",
        exitCode: 23,
      };
      const stdin = new TextEncoder().encode("opaque input");
      const operation = await value.service.execute("user-1", "workspace-1", {
        argv: ["printf", "%s", "argument with spaces;$(false)"],
        cwd: "src",
        stdin: { kind: "inline", bytes: stdin },
        timeoutMs: 5_000,
      });
      expect(operation.operation).toMatchObject({
        state: "failed",
        exitCode: 23,
        outputBytes: Buffer.byteLength("partial output") + Buffer.byteLength("expected failure"),
        inputBytes: stdin.byteLength,
      });
      expect(operation.result).toEqual({
        state: "failed",
        stdout: "partial output",
        stderr: "expected failure",
        exitCode: 23,
      });
      expect(value.transport.lastWorkspace?.machine).toEqual({
        name: "basic",
        displayName: "Basic",
        operatingSystem: "linux",
        cpuCores: 2,
        memoryBytes: 8_589_934_592,
        storageBytes: 34_359_738_368,
      });
      expect(operation.operation).toMatchObject({
        remoteCleanupPending: 1,
        resultExpiresAt: now + policy.cleanupDeadlineMs,
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      const stored = value.sqlite.prepare("SELECT * FROM workspaceOperation").get() as object;
      expect(Object.keys(stored).join(" ")).not.toMatch(
        /argv|command|cwd|stdin|token|credential|ssh/i,
      );
      expect(stored).not.toHaveProperty("stdout");
      expect(stored).not.toHaveProperty("stderr");
      expect(JSON.stringify(stored)).not.toContain("argument with spaces");
      expect(JSON.stringify(stored)).not.toContain("opaque input");
      value.advance(policy.cleanupDeadlineMs + 1);
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("releases a reservation when credentials fail before remote dispatch", async () => {
    const value = fixture();
    try {
      value.credentials.getCredential.mockRejectedValueOnce(new Error("refresh failed"));
      const result = await value.service.execute("user-1", "workspace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({
        operation: {
          state: "cancelled",
          lastOutcome: "credential_unavailable_before_dispatch",
          remoteCleanupPending: 0,
        },
        result: null,
      });
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("retries remote finalization without changing a durable terminal result", async () => {
    const value = fixture();
    try {
      value.transport.throwFinalize = true;
      const result = await value.service.execute("user-1", "workspace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1_000,
      });
      expect(result.operation).toMatchObject({ state: "succeeded", remoteCleanupPending: 1 });

      value.advance(policy.cleanupDeadlineMs + 1);
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", result.operation.id)?.remoteCleanupPending).toBe(
        1,
      );
      expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(1);

      value.sqlite
        .prepare(
          "UPDATE workspaceConnection SET credentialGeneration = 2 WHERE id = 'connection-1'",
        )
        .run();
      expect(
        new WorkspaceResourceRepository(value.sqlite).rebindAuthorization({
          userId: "user-1",
          resourceId: "workspace-1",
          resourceGeneration: 1,
          expectedAuthorizationGeneration: 1,
          authorizationGeneration: 2,
          now: now + policy.cleanupDeadlineMs + 2,
        }),
      ).toBe(true);
      expect(
        value.repository.getOwned("user-1", result.operation.id)?.authorizationGeneration,
      ).toBe(2);
      value.transport.throwFinalize = false;
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", result.operation.id)).toMatchObject({
        state: "succeeded",
        remoteCleanupPending: 0,
      });
      expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(2);
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a background-observed terminal result available until its bounded cleanup deadline", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      const started = await value.service.execute("user-1", "workspace-1", {
        argv: ["printf", "result"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      value.transport.executeResult = {
        state: "succeeded",
        stdout: "background result",
        stderr: "background warning",
        exitCode: 0,
      };

      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", started.operation.id)).toMatchObject({
        state: "succeeded",
        remoteCleanupPending: 1,
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(false);
      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toEqual({
        state: "succeeded",
        stdout: "background result",
        stderr: "background warning",
        exitCode: 0,
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();

      value.advance(policy.cleanupDeadlineMs + 1);
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", started.operation.id)?.remoteCleanupPending).toBe(
        0,
      );
      expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("expires a crash-abandoned pre-dispatch reservation without connector contact", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserve({
        userId: "user-1",
        resourceId: "workspace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 1_000,
        policy,
        now,
      });
      expect(reserved.operation).toMatchObject({ state: "reserved" });
      await expect(
        value.service.execute("user-1", "workspace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_POLICY_LIMIT" });

      value.advance(1_001);
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", reserved.operation!.id)).toMatchObject({
        state: "cancelled",
        lastOutcome: "reservation_expired_before_dispatch",
        remoteCleanupPending: 0,
      });
      const replacement = value.repository.reserve({
        userId: "user-1",
        resourceId: "workspace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 2_000,
        policy,
        now: now + 1_001,
      });
      expect(replacement.outcome).toBe("reserved");
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
      expect(value.transport.cancelCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("records durable dispatch intent before the connector can start remote work", async () => {
    const value = fixture();
    try {
      let observed: ReturnType<WorkspaceOperationRepository["getOwned"]> = null;
      value.transport.executeResult = { state: "running" };
      value.transport.executeObservation = () => {
        observed = value.repository.listOwned("user-1", "workspace-1")[0] ?? null;
      };
      const result = await value.service.execute("user-1", "workspace-1", {
        argv: ["sleep", "1"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1_000,
      });
      expect(observed).toMatchObject({
        state: "reconcile_pending",
        lastOutcome: "dispatch_submitted",
        claimId: expect.any(String),
        claimExpiresAt: now + 60_000,
      });
      expect(result.operation).toMatchObject({ state: "running", claimId: null });
    } finally {
      value.sqlite.close();
    }
  });

  test("reconciles the exact dispatch marker after a process crash and claim expiry", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserve({
        userId: "user-1",
        resourceId: "workspace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 30_000,
        policy,
        now,
      });
      expect(reserved.operation).toBeDefined();
      expect(
        value.repository.beginDispatch(
          "user-1",
          reserved.operation!.id,
          reserved.operation!.resourceGeneration,
          "crashed-process-claim",
          now + 5_000,
          now,
        ),
      ).toBe(true);

      let restartedNow = now;
      const restartedTransport = new FakeTransport();
      const restarted = new WorkspaceOperationService({
        repository: value.repository,
        transport: restartedTransport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => restartedNow,
      });
      await expect(restarted.reconcileOnce("user-1")).resolves.toBe(false);
      expect(restartedTransport.inspectCalls).not.toHaveBeenCalled();

      restartedNow = now + 5_001;
      await expect(restarted.reconcileOnce("user-1")).resolves.toBe(true);
      expect(restartedTransport.lastInspectedOperation?.remoteMarker).toBe(
        reserved.operation!.remoteMarker,
      );
      expect(value.repository.getOwned("user-1", reserved.operation!.id)).toMatchObject({
        state: "succeeded",
        outputBytes: Buffer.byteLength("ok"),
        claimId: null,
        claimExpiresAt: null,
        resultExpiresAt: restartedNow + policy.cleanupDeadlineMs,
      });
      expect(value.repository.listOwned("user-1", "workspace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects an unbounded workspace-relative cwd before reservation", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-1", "workspace-1", {
          argv: ["true"],
          cwd: "a".repeat(4097),
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_RESOURCE_INVALID" });
      expect(value.repository.listOwned("user-1", "workspace-1")).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects cross-tenant workspace access before credential or transport contact", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-2", "workspace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps ambiguous remote work charged and fenced until it is inspected or stopped", async () => {
    const value = fixture();
    try {
      value.transport.throwExecute = true;
      const first = await value.service.execute("user-1", "workspace-1", {
        argv: ["long-running-command"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      expect(first.operation.state).toBe("reconcile_pending");
      await expect(
        value.service.execute("user-1", "workspace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_POLICY_LIMIT" });

      const resourceRepository = new WorkspaceResourceRepository(value.sqlite);
      const stopped = resourceRepository.requestStop("user-1", "workspace-1", now + 1);
      expect(stopped).toMatchObject({ state: "stop_pending", generation: 2 });
      expect(value.repository.getOwned("user-1", first.operation.id)?.state).toBe("cancel_pending");
    } finally {
      value.sqlite.close();
    }
  });

  test("allows the official tunnel to restore an externally stopped workspace only under current running authority", async () => {
    const value = fixture();
    try {
      value.sqlite
        .prepare(
          `UPDATE workspaceResource SET observedState = 'stopped',
           lastOutcome = 'provider_observed_stopped' WHERE id = 'workspace-1'`,
        )
        .run();
      const result = await value.service.execute("user-1", "workspace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1_000,
      });
      expect(result.operation.state).toBe("succeeded");
      expect(
        value.sqlite
          .prepare(
            "SELECT observedState, lastOutcome FROM workspaceResource WHERE id = 'workspace-1'",
          )
          .get(),
      ).toEqual({ observedState: "running", lastOutcome: "connector_observed_running" });
    } finally {
      value.sqlite.close();
    }
  });

  test("blocks a desired-stopped workspace before credential or connector contact", async () => {
    const value = fixture();
    try {
      value.sqlite
        .prepare(
          `UPDATE workspaceResource SET state = 'stopped', desiredState = 'stopped',
           observedState = 'stopped' WHERE id = 'workspace-1'`,
        )
        .run();
      await expect(
        value.service.execute("user-1", "workspace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_RUNNING" });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("fences dispatch when the kill switch wins after reservation", async () => {
    const value = fixture();
    try {
      const resourceRepository = new WorkspaceResourceRepository(value.sqlite);
      const service = new WorkspaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
        audit: (event) => {
          if (event.action === "reserve") {
            resourceRepository.setControl({
              scope: "global",
              disabled: true,
              reason: "incident",
              updatedBy: null,
              now,
              cleanupDeadlineAt: now + 30_000,
            });
          }
        },
      });
      await expect(
        service.execute("user-1", "workspace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({ operation: { state: "cancel_pending" }, result: null });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("does not call cancellation terminal until the remote foreground group is absent", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      const running = await value.service.execute("user-1", "workspace-1", {
        argv: ["sleep", "30"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 30_000,
      });
      expect(running.operation.state).toBe("running");
      const pending = await value.service.cancel("user-1", running.operation.id);
      expect(pending.operation.state).toBe("cancel_pending");

      value.transport.cancelResult = {
        state: "cancelled",
        stdout: "",
        stderr: "",
        exitCode: null,
      };
      const terminal = await value.service.cancel("user-1", running.operation.id);
      expect(terminal.operation.state).toBe("cancelled");
      expect(terminal.result?.state).toBe("cancelled");
      expect(value.transport.cancelCalls).toHaveBeenCalledTimes(2);
    } finally {
      value.sqlite.close();
    }
  });

  test("fences a successful result when a concurrent stop advances the workspace generation", async () => {
    const value = fixture();
    try {
      let releaseExecute!: () => void;
      let observeExecute!: () => void;
      const enteredExecute = new Promise<void>((resolve) => {
        observeExecute = resolve;
      });
      value.transport.executeObservation = observeExecute;
      value.transport.executeGate = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      const executing = value.service.execute("user-1", "workspace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      await enteredExecute;
      new WorkspaceResourceRepository(value.sqlite).requestStop("user-1", "workspace-1", now + 1);
      releaseExecute();
      await expect(executing).resolves.toMatchObject({
        operation: { state: "cancelled", remoteCleanupPending: 1 },
        result: { state: "cancelled" },
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      await expect(
        value.service.reconcile(
          "user-1",
          value.repository.listOwned("user-1", "workspace-1")[0]!.id,
        ),
      ).resolves.toBeNull();
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});
