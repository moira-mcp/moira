import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodespaceFileService,
  CodespaceOperationRepository,
  CodespaceOperationService,
  CodespaceResourceRepository,
  CodespaceResourceError,
  CodespaceTransferRepository,
  CodespaceTransferService,
  type CodespaceFileResult,
  type CodespaceFileTransport,
  type CodespaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_900_000_000;
const policy: CodespaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 2,
  maxActiveGlobal: 10,
  createThrottleMs: 0,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  startWaitMs: 60_000,
  maxConcurrentOperationsPerUser: 2,
  maxConcurrentOperationsGlobal: 4,
  maxOperationMs: 60_000,
  maxTransferFileBytes: 1024,
};

class FakeFileTransport implements CodespaceFileTransport {
  available = true;
  async health() {
    return { ok: this.available, reason: null };
  }
  result: CodespaceFileResult = {
    action: "write",
    path: "src/file.bin",
    previous: null,
    current: { size: 3, sha256: "a".repeat(64), modifiedAt: now },
  };
  throwExecute = false;
  executeCalls = jest.fn();
  inspectCalls = jest.fn();
  lastRequest: Parameters<CodespaceFileTransport["executeFile"]>[3] | null = null;

  async executeFile(
    _credential: string,
    _codespace: Parameters<CodespaceFileTransport["executeFile"]>[1],
    _operation: Parameters<CodespaceFileTransport["executeFile"]>[2],
    request: Parameters<CodespaceFileTransport["executeFile"]>[3],
  ) {
    this.executeCalls();
    this.lastRequest = request;
    if (this.throwExecute) throw new Error("response lost");
    return this.result;
  }

  /** Overridden per test; by default it answers with whatever `result` the fake is carrying. */
  inspectFile: CodespaceFileTransport["inspectFile"] = async () => {
    this.inspectCalls();
    return this.result;
  };
}

function fixture(advanceOnDelay = false) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(`
    INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES
      ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
      ('user-2', 'two@example.test', 'user-two', 'now', 'now');
    INSERT INTO codespaceConnection
      (id, userId, provider, externalAccountId, externalLogin, status,
       credentialGeneration, createdAt, updatedAt)
      VALUES ('connection-1', 'user-1', 'github-codespaces', '101', 'owner',
              'connected', 1, ${now}, ${now});
    INSERT INTO codespaceConnectionRepository
      (connectionId, externalInstallationId, externalRepositoryId, fullName, private, createdAt)
      VALUES ('connection-1', '201', '301', 'owner/repository', 1, ${now});
    INSERT INTO codespaceResource
      (id, userId, connectionId, authorizationGeneration, provider, repositoryId,
       repositoryFullName, requestedRef, operationMarker, providerResourceName,
       externalOwnerId, billableOwnerId, machineName, machineDisplayName,
       machineOperatingSystem, machineCpuCores, machineMemoryBytes, machineStorageBytes,
       state, retentionPolicy, desiredState, observedState, generation,
       createDeadlineAt, remoteExpiresAt, createdAt, updatedAt)
      VALUES ('codespace-1', 'user-1', 'connection-1', 1, 'github-codespaces', '301',
       'owner/repository', 'refs/heads/main', 'moira-codespace', 'silver-space', '101', '101',
       'basic', 'Basic', 'linux', 2, 8589934592, 34359738368,
       'usable', 'persistent', 'running', 'running', 1, ${now + 30_000},
       ${now + 60_000}, ${now}, ${now});
  `);
  const repository = new CodespaceOperationRepository(sqlite);
  const transport = new FakeFileTransport();
  const credentials = { getCredential: jest.fn(async () => "ghu_access") };
  // The settle window is exercised for its attempts, not for real elapsed time.
  const settleDelays: number[] = [];
  let currentNow = now;
  const delay = async (milliseconds: number) => {
    settleDelays.push(milliseconds);
    if (advanceOnDelay) currentNow += milliseconds;
  };
  const service = new CodespaceFileService({
    repository,
    transport,
    credentials,
    policy: () => policy,
    now: () => currentNow,
    delay,
  });
  return {
    sqlite,
    repository,
    settleDelays,
    transport,
    credentials,
    service,
    delay,
    now: () => currentNow,
  };
}

describe("observed local file-operation completion", () => {
  function pendingLocal() {
    const value = fixture();
    value.sqlite.exec(`
      UPDATE codespaceConnection SET provider = 'local-sandboxes';
      UPDATE codespaceResource SET provider = 'local-sandboxes';
    `);
    const reserved = value.repository.reserve({
      userId: "user-1",
      resourceId: "codespace-1",
      kind: "stat",
      inputBytes: 0,
      stdoutLimitBytes: 0,
      stderrLimitBytes: 0,
      deadlineAt: now + 30_000,
      policy,
      now,
    });
    expect(reserved.outcome).toBe("reserved");
    const operation = reserved.operation!;
    expect(value.repository.beginDispatch("user-1", operation.id, "claim", now + 5_000, now)).toBe(
      true,
    );
    return { ...value, operation };
  }

  test.each([1, 3])(
    "releases observed file capacity at lifecycle generation %s without changing its generation",
    (generation) => {
      const value = pendingLocal();
      try {
        value.sqlite.prepare("UPDATE codespaceResource SET generation = ?").run(generation);
        expect(
          value.repository.completeMetadata(
            "user-1",
            value.operation.id,
            0,
            now + 30_000,
            now,
            "failed",
          ),
        ).toBe(true);
        expect(value.repository.getOwned("user-1", value.operation.id)).toMatchObject({
          state: "failed",
          resourceGeneration: 1,
          outputBytes: 0,
          claimId: null,
        });
        expect(value.repository.countActiveForUser("user-1")).toBe(0);
        expect(
          value.repository.reserve({
            userId: "user-1",
            resourceId: "codespace-1",
            kind: "stat",
            inputBytes: 0,
            stdoutLimitBytes: 0,
            stderrLimitBytes: 0,
            deadlineAt: now + 30_000,
            policy,
            now,
          }).outcome,
        ).toBe("reserved");
        expect(value.repository.canDispatch("user-1", value.operation.id, now)).toBe(false);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each([
    [
      "sandbox identity changed",
      "UPDATE codespaceResource SET providerResourceName = 'replacement'",
    ],
    ["provider changed", "UPDATE codespaceResource SET provider = 'github-codespaces'"],
    ["owner changed", "UPDATE codespaceResource SET userId = 'user-2'"],
    ["authorization changed", "UPDATE codespaceResource SET authorizationGeneration = 2"],
    [
      "operation identity changed",
      "UPDATE codespaceOperation SET providerResourceName = 'replacement'",
    ],
    ["operation provider changed", "UPDATE codespaceOperation SET provider = 'github-codespaces'"],
    [
      "operation authorization changed",
      "UPDATE codespaceOperation SET authorizationGeneration = 2",
    ],
    ["credential changed", "UPDATE codespaceConnection SET credentialGeneration = 2"],
    ["connection revoked", "UPDATE codespaceConnection SET status = 'revoked'"],
    ["repository grant revoked", "DELETE FROM codespaceConnectionRepository"],
    ["exec operation", "UPDATE codespaceOperation SET kind = 'exec'"],
    ["undispatched reservation", "UPDATE codespaceOperation SET state = 'reserved'"],
  ])("preserves pending capacity when %s", (_name, mutation) => {
    const value = pendingLocal();
    try {
      value.sqlite.exec("UPDATE codespaceResource SET generation = 3");
      value.sqlite.exec(mutation);
      expect(
        value.repository.completeMetadata(
          "user-1",
          value.operation.id,
          0,
          now + 30_000,
          now,
          "failed",
        ),
      ).toBe(false);
      expect(value.repository.countActiveForUser("user-1")).toBe(1);
    } finally {
      value.sqlite.close();
    }
  });

  test.each(["global", "provider:local-sandboxes"])(
    "completes observed work under disabled %s control while refusing new reservations",
    (scope) => {
      const value = pendingLocal();
      try {
        value.sqlite.exec("UPDATE codespaceResource SET generation = 3");
        value.sqlite
          .prepare(
            "INSERT INTO codespaceProviderControl(scope, disabled, reason, updatedAt) VALUES (?, 1, 'incident', ?)",
          )
          .run(scope, now);
        expect(
          value.repository.completeMetadata(
            "user-1",
            value.operation.id,
            0,
            now + 30_000,
            now,
            "failed",
          ),
        ).toBe(true);
        expect(value.repository.countActiveForUser("user-1")).toBe(0);
        expect(
          value.repository.reserve({
            userId: "user-1",
            resourceId: "codespace-1",
            kind: "stat",
            inputBytes: 0,
            stdoutLimitBytes: 0,
            stderrLimitBytes: 0,
            deadlineAt: now + 30_000,
            policy,
            now,
          }).outcome,
        ).toBe("disabled");
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("completes and reads an earlier lifecycle operation without rewriting its identity", () => {
    const value = pendingLocal();
    try {
      value.sqlite.exec("UPDATE codespaceResource SET generation = 3");
      expect(
        value.repository.completeMetadata(
          "user-1",
          value.operation.id,
          0,
          now + 30_000,
          now,
          "failed",
        ),
      ).toBe(true);
      expect(
        value.repository.requireResultContext("user-1", value.operation.id, policy, now).operation,
      ).toMatchObject({ id: value.operation.id, state: "failed", resourceGeneration: 1 });
      expect(value.repository.canDispatch("user-1", value.operation.id, now)).toBe(false);
      expect(value.repository.countActiveForUser("user-1")).toBe(0);
    } finally {
      value.sqlite.close();
    }
  });
});

describe("durable codespace file operations", () => {
  test("an uncertain typed file failure exposes the accepted operation for inspection without replay", async () => {
    const value = fixture();
    let executions = 0;
    try {
      value.transport.executeFile = async () => {
        executions++;
        throw new CodespaceResourceError(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "Controlled lost response after admission",
        );
      };
      const failure = await value.service
        .execute("user-1", "codespace-1", {
          action: "write",
          path: "file.txt",
          bytes: Buffer.from("new"),
          expected: { exists: false },
        })
        .then(
          () => null,
          (error: unknown) => error as CodespaceResourceError,
        );
      expect(failure).toBeInstanceOf(CodespaceResourceError);
      expect(failure).toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
        operationId: expect.any(String),
      });
      expect(value.repository.getOwned("user-1", failure!.operationId!)).toMatchObject({
        state: "reconcile_pending",
      });
      await expect(value.service.reconcile("user-1", failure!.operationId!)).resolves.toMatchObject(
        { operation: { state: "succeeded" }, result: { action: "write" } },
      );
      expect(executions).toBe(1);
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test.each(["execution", "inspection"] as const)(
    "returns the exact file result after a lifecycle change during %s without redispatch",
    async (boundary) => {
      const value = fixture();
      const terminal = value.transport.result;
      try {
        const advanceLifecycle = () =>
          value.sqlite.exec("UPDATE codespaceResource SET generation=generation+1");
        if (boundary === "execution") {
          const execute = value.transport.executeFile.bind(value.transport);
          value.transport.executeFile = async (...args) => {
            await Promise.resolve();
            advanceLifecycle();
            return execute(...args);
          };
        } else {
          value.transport.result = { state: "running" } as unknown as CodespaceFileResult;
          value.transport.inspectFile = async () => {
            await Promise.resolve();
            advanceLifecycle();
            return terminal;
          };
        }
        await expect(
          value.service.execute("user-1", "codespace-1", {
            action: "write",
            path: "src/file.bin",
            bytes: Buffer.from("abc"),
            expected: { exists: false },
          }),
        ).resolves.toMatchObject({ operation: { state: "succeeded" }, result: terminal });
        expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
        expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("a lost patch response does not block a new write or replay the unknown patch", async () => {
    const value = fixture();
    try {
      value.sqlite.exec(
        "UPDATE codespaceConnection SET provider='local-sandboxes'; UPDATE codespaceResource SET provider='local-sandboxes'",
      );
      value.transport.throwExecute = true;
      const old = await value.service.execute("user-1", "codespace-1", {
        action: "apply_patch",
        files: [
          {
            path: "old.txt",
            expected: { exists: false },
            edits: [{ start: 0, end: 0, bytes: Buffer.from("old") }],
          },
        ],
      });
      expect(old.operation.state).toBe("reconcile_pending");
      value.transport.throwExecute = false;
      const fresh = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "new.txt",
        bytes: Buffer.from("new"),
        expected: { exists: false },
      });
      expect(fresh).toMatchObject({
        operation: { state: "succeeded" },
        result: { action: "write" },
      });
      expect(value.transport.lastRequest).toEqual({
        action: "write",
        path: "new.txt",
        bytes: Buffer.from("new"),
        expected: { exists: false },
      });
      expect(value.repository.getOwned("user-1", old.operation.id)).toEqual(old.operation);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(2);
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("synchronous file waiting rechecks authority after an awaited terminal file result", async () => {
    const value = fixture(true);
    try {
      const terminal = value.transport.result;
      value.transport.result = { state: "running" } as unknown as typeof terminal;
      const accepted = await value.service.execute("user-1", "codespace-1", {
        action: "stat",
        path: "private.txt",
      });
      value.transport.inspectFile = async () => {
        await Promise.resolve();
        value.sqlite.prepare("DELETE FROM codespaceConnectionRepository").run();
        return terminal;
      };
      await expect(
        value.service.waitForResult("user-1", accepted.operation.id),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("synchronous file waiting refuses an unconfirmed deadline without redispatch or false completion", async () => {
    const value = fixture(true);
    try {
      value.transport.result = { state: "running" } as unknown as CodespaceFileResult;
      const accepted = await value.service.execute("user-1", "codespace-1", {
        action: "stat",
        path: "file.txt",
      });
      await expect(
        value.service.waitForResult("user-1", accepted.operation.id),
      ).rejects.toMatchObject({ code: "CODESPACE_PROVIDER_UNAVAILABLE" });
      expect(value.repository.getOwned("user-1", accepted.operation.id)).toMatchObject({
        state: "running",
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("opt-in synchronous file waiting retains the short Web response and returns the eventual exact file version", async () => {
    const value = fixture(true);
    try {
      const terminal = value.transport.result;
      value.transport.result = { state: "running" } as unknown as typeof terminal;
      value.transport.inspectFile = async () => {
        value.transport.inspectCalls();
        return value.now() - now >= 3000 ? terminal : { state: "running" };
      };
      const accepted = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("abc"),
        expected: { exists: false },
      });
      expect(accepted).toMatchObject({ operation: { state: "running" }, result: null });
      const completed = await value.service.waitForResult("user-1", accepted.operation.id);
      expect(completed).toMatchObject({
        operation: { id: accepted.operation.id, state: "succeeded" },
        result: terminal,
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("synchronous native download waits for retained bytes with quota reserved before inspection and no redispatch", async () => {
    const value = fixture(true);
    const root = mkdtempSync(join(tmpdir(), "moira-wait-download-"));
    const transfers = new CodespaceTransferService({
      repository: new CodespaceTransferRepository(value.sqlite),
      root,
      policy: () => policy,
      now: value.now,
    });
    const service = new CodespaceFileService({
      repository: value.repository,
      transport: value.transport,
      credentials: value.credentials,
      policy: () => policy,
      now: value.now,
      delay: value.delay,
      transfers,
    });
    const bytes = Buffer.from([0, 255, 1, 128]);
    try {
      value.transport.result = { state: "running" } as unknown as CodespaceFileResult;
      value.transport.inspectFile = async () => {
        expect(
          value.sqlite.prepare("SELECT state,declaredSize FROM codespaceTransfer").all(),
        ).toEqual([{ state: "reserved", declaredSize: 16 }]);
        return value.now() - now >= 3000
          ? {
              action: "download",
              path: "result.bin",
              offset: 0,
              totalSize: bytes.length,
              bytes,
              sha256: "a".repeat(64),
            }
          : { state: "running" };
      };
      const accepted = await service.downloadReference("user-1", "codespace-1", {
        path: "result.bin",
        maxBytes: 16,
        fileName: "result.bin",
        mimeType: "application/octet-stream",
      });
      expect(accepted).toMatchObject({ operation: { state: "running" }, transfer: null });
      const completed = await service.waitForDownloadReference("user-1", accepted.operation.id, {
        fileName: "result.bin",
        mimeType: "application/octet-stream",
      });
      const claimed = await transfers.claimDownload(completed.transfer!.referenceId);
      const chunks: Buffer[] = [];
      for await (const chunk of claimed.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      await transfers.consume(claimed.record);
      expect(completed.operation).toMatchObject({ id: accepted.operation.id, state: "succeeded" });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("returns a file result that lands during the settle window", async () => {
    const value = fixture();
    try {
      const terminal = value.transport.result;
      // A file supervisor that answers "running" leaves its outcome for the next inspection.
      value.transport.result = { state: "running" } as unknown as typeof terminal;
      value.transport.inspectFile = async () => {
        value.transport.inspectCalls();
        return terminal;
      };
      const dispatched = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("abc"),
        expected: { exists: false },
      });

      expect(dispatched.operation.state).toBe("succeeded");
      expect(dispatched.result).toEqual(terminal);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.settleDelays).toEqual([150]);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects unavailable connector before credentials on file dispatch and result recovery", async () => {
    const value = fixture();
    const request = {
      action: "write" as const,
      path: "src/file.bin",
      bytes: Buffer.from("new"),
      expected: { exists: false },
    };
    try {
      const started = await value.service.execute("user-1", "codespace-1", request);
      value.transport.available = false;
      value.credentials.getCredential.mockClear();
      value.transport.executeCalls.mockClear();
      await expect(value.service.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      await expect(value.service.execute("user-1", "codespace-1", request)).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
      expect(value.repository.listOwned("user-1", "codespace-1")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: "cancelled",
            remoteCleanupPending: 0,
            lastOutcome: "connector_unavailable_before_dispatch",
          }),
        ]),
      );
    } finally {
      value.sqlite.close();
    }
  });
  test("recovers a response-lost download by exact operation without redispatch and reserves private bytes before inspection", async () => {
    const value = fixture();
    const root = mkdtempSync(join(tmpdir(), "moira-download-recovery-"));
    let transferPolicy = policy;
    const transfers = new CodespaceTransferService({
      repository: new CodespaceTransferRepository(value.sqlite),
      root,
      policy: () => transferPolicy,
      now: () => now,
    });
    const service = new CodespaceFileService({
      repository: value.repository,
      transport: value.transport,
      credentials: value.credentials,
      policy: () => policy,
      now: () => now,
      transfers,
    });
    const bytes = Buffer.from([0, 255, 17, 128]);
    try {
      value.transport.throwExecute = true;
      const pending = await service.downloadReference("user-1", "codespace-1", {
        path: "result.bin",
        maxBytes: 16,
        fileName: "result.bin",
        mimeType: "application/octet-stream",
      });
      expect(pending).toMatchObject({
        operation: { kind: "download", state: "reconcile_pending" },
        transfer: null,
      });
      expect(readdirSync(root)).toEqual([]);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
      value.credentials.getCredential.mockClear();
      transferPolicy = { ...policy, maxTransferBytesPerUser: 1 };
      await expect(
        service.reconcileDownloadReference("user-1", pending.operation.id, {
          fileName: "result.bin",
          mimeType: "application/octet-stream",
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_POLICY_LIMIT" });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
      transferPolicy = policy;
      const inspectFile = value.transport.inspectFile.bind(value.transport);
      value.transport.inspectFile = async (...args) => {
        expect(
          value.sqlite.prepare("SELECT state, declaredSize FROM codespaceTransfer").all(),
        ).toEqual([{ state: "reserved", declaredSize: 16 }]);
        return inspectFile(...args);
      };
      value.transport.result = {
        action: "download",
        path: "result.bin",
        offset: 0,
        totalSize: bytes.length,
        bytes,
        sha256: "a".repeat(64),
      };
      const recovered = await service.reconcileDownloadReference("user-1", pending.operation.id, {
        fileName: "result.bin",
        mimeType: "application/octet-stream",
      });
      expect(recovered.operation).toMatchObject({
        id: pending.operation.id,
        state: "succeeded",
        outputBytes: 4,
      });
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      const download = await transfers.claimDownload(recovered.transfer!.referenceId);
      const chunks: Buffer[] = [];
      for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      await transfers.consume(download.record);
      value.credentials.getCredential.mockClear();
      value.transport.inspectCalls.mockClear();
      value.sqlite.exec("UPDATE codespaceResource SET generation = 2");
      const afterLifecycleChange = await service.reconcileDownloadReference(
        "user-1",
        pending.operation.id,
        {
          fileName: "result.bin",
          mimeType: "application/octet-stream",
        },
      );
      expect(afterLifecycleChange.operation).toMatchObject({
        id: pending.operation.id,
        state: "succeeded",
      });
      const retained = await transfers.claimDownload(afterLifecycleChange.transfer!.referenceId);
      const retainedChunks: Buffer[] = [];
      for await (const chunk of retained.stream) retainedChunks.push(Buffer.from(chunk));
      expect(Buffer.concat(retainedChunks)).toEqual(bytes);
      await transfers.consume(retained.record);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not expose file bytes when authorization changes during result inspection", async () => {
    const value = fixture();
    try {
      const started = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("new"),
        expected: { exists: false },
      });
      const inspectFile = value.transport.inspectFile.bind(value.transport);
      value.transport.inspectFile = async (...args) => {
        value.sqlite.exec("DELETE FROM codespaceConnectionRepository");
        return inspectFile(...args);
      };
      await expect(value.service.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_AUTHORIZATION_REQUIRED",
      });
      expect(value.repository.getOwned("user-1", started.operation.id)).toMatchObject({
        state: "succeeded",
        outputBytes: started.operation.outputBytes,
      });
    } finally {
      value.sqlite.close();
    }
  });
  test.each([true, false])(
    "moves native upload with metadata=%s and download bytes through private single-use storage",
    async (includeMetadata) => {
      const value = fixture();
      const root = mkdtempSync(join(tmpdir(), "moira-file-lifecycle-transfer-"));
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(value.sqlite),
        root,
        policy: () => ({
          ...policy,
          maxTransferFileBytes: 1024,
          maxTransferBytesPerUser: 2048,
          maxTransferBytesGlobal: 4096,
          maxTransferObjectsPerUser: 4,
          maxTransferObjectsGlobal: 8,
          maxTransferInflightBytesPerUser: 2048,
          maxTransferInflightBytesGlobal: 4096,
          transferTtlMs: 60_000,
        }),
        now: () => now,
      });
      const bytes = Buffer.from([0, 255, 4, 5]);
      const service = new CodespaceFileService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
        transfers,
        nativeFetcher: {
          fetch: async () => {
            const reservedBytes = includeMetadata ? bytes.length : policy.maxTransferFileBytes;
            expect(
              value.sqlite.prepare("SELECT state, inputBytes FROM codespaceOperation").all(),
            ).toEqual([{ state: "reserved", inputBytes: reservedBytes }]);
            expect(
              value.sqlite.prepare("SELECT state, declaredSize FROM codespaceTransfer").all(),
            ).toEqual([{ state: "reserved", declaredSize: reservedBytes }]);
            return {
              contentLength: bytes.length,
              mimeType: "application/octet-stream",
              body: (async function* () {
                yield bytes;
              })(),
            };
          },
        },
      });
      const executeFile = value.transport.executeFile.bind(value.transport);
      value.transport.executeFile = async (...args) => {
        const transferState = value.sqlite
          .prepare("SELECT purpose, state, declaredSize FROM codespaceTransfer")
          .all();
        expect(transferState).toEqual(
          args[3].action === "download"
            ? [{ purpose: "codespace_download", state: "reserved", declaredSize: 1024 }]
            : [],
        );
        return executeFile(...args);
      };
      try {
        value.transport.result = {
          action: "upload",
          path: "input.bin",
          previous: null,
          current: { size: bytes.length, sha256: "a".repeat(64), modifiedAt: now },
        };
        const uploaded = await service.uploadReference("user-1", "codespace-1", {
          path: "input.bin",
          expected: { exists: false },
          reference: {
            fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
            downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=secret",
            ...(includeMetadata
              ? {
                  fileName: "input.bin",
                  mimeType: "application/octet-stream",
                  declaredSize: bytes.length,
                }
              : {}),
          },
        });
        expect(uploaded.operation.inputBytes).toBe(bytes.length);
        expect(value.transport.lastRequest).toMatchObject({ action: "upload", path: "input.bin" });
        expect((value.transport.lastRequest as { bytes: Uint8Array }).bytes).toEqual(bytes);
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
          count: 0,
        });

        value.transport.result = {
          action: "download",
          path: "output.bin",
          offset: 0,
          totalSize: bytes.length,
          bytes,
          sha256: "b".repeat(64),
        };
        const download = await service.downloadReference("user-1", "codespace-1", {
          path: "output.bin",
          maxBytes: 1024,
          fileName: "output.bin",
          mimeType: "application/octet-stream",
        });
        const claimed = await transfers.claimDownload(download.transfer!.referenceId);
        const chunks: Buffer[] = [];
        for await (const chunk of claimed.stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(bytes);
        await transfers.consume(claimed.record);
      } finally {
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    [
      "unavailable connector",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>): void => {
        value.transport.available = false;
      },
      "input.bin",
    ],
    [
      "invalid path",
      "user-1",
      "codespace-1",
      (_value: ReturnType<typeof fixture>): void => undefined,
      "../input.bin",
    ],
    [
      "foreign",
      "user-2",
      "codespace-1",
      (_value: ReturnType<typeof fixture>): void => undefined,
      "input.bin",
    ],
    [
      "missing",
      "user-1",
      "codespace-missing",
      (_value: ReturnType<typeof fixture>): void => undefined,
      "input.bin",
    ],
    [
      "stopped",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>): void => {
        value.sqlite
          .prepare(
            "UPDATE codespaceResource SET state = 'stopped', desiredState = 'stopped' WHERE id = 'codespace-1'",
          )
          .run();
      },
      "input.bin",
    ],
    [
      "disabled",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>): void => {
        new CodespaceResourceRepository(value.sqlite).setControl({
          scope: "global",
          disabled: true,
          reason: "incident",
          updatedBy: null,
          now,
          cleanupDeadlineAt: now + 30_000,
        });
      },
      "input.bin",
    ],
    [
      "busy",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>): void => {
        for (let index = 0; index < policy.maxConcurrentOperationsPerUser!; index++) {
          expect(
            value.repository.reserve({
              userId: "user-1",
              resourceId: "codespace-1",
              kind: "exec",
              inputBytes: 0,
              stdoutLimitBytes: 16,
              stderrLimitBytes: 16,
              deadlineAt: now + 30_000,
              policy,
              now,
            }).outcome,
          ).toBe("reserved");
        }
      },
      "input.bin",
    ],
  ] as const)(
    "rejects a %s upload before native fetch or downstream contact",
    async (_caseName, userId, codespaceId, arrange, uploadPath) => {
      const value = fixture();
      const root = mkdtempSync(join(tmpdir(), "moira-file-upload-authority-"));
      const nativeFetch = jest.fn(async () => ({
        contentLength: 1,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from([1]);
        })(),
      }));
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(value.sqlite),
        root,
        policy: () => policy,
        now: () => now,
      });
      const service = new CodespaceFileService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
        transfers,
        nativeFetcher: { fetch: nativeFetch },
      });
      try {
        arrange(value);
        await expect(
          service.uploadReference(userId, codespaceId, {
            path: uploadPath,
            expected: { exists: false },
            reference: {
              fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
              downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
              fileName: "input.bin",
              mimeType: "application/octet-stream",
              declaredSize: 1,
            },
          }),
        ).rejects.toBeInstanceOf(Error);
        expect(nativeFetch).not.toHaveBeenCalled();
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
          count: 0,
        });
        expect(value.credentials.getCredential).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
      } finally {
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "resource-stopped",
    "reservation-expiry",
    "authority-revoked",
    "credential-failure",
  ] as const)("removes native upload bytes after %s before provider dispatch", async (failure) => {
    const value = fixture();
    const root = mkdtempSync(join(tmpdir(), "moira-file-upload-cancel-"));
    let currentNow = now;
    const bytes = Buffer.from([1, 2, 3]);
    const credentials = {
      getCredential: jest.fn(async () => {
        if (failure === "credential-failure") throw new Error("credential unavailable");
        if (failure === "authority-revoked") {
          value.sqlite.prepare("DELETE FROM codespaceConnectionRepository").run();
        }
        return "ghu_access";
      }),
    };
    const transfers = new CodespaceTransferService({
      repository: new CodespaceTransferRepository(value.sqlite),
      root,
      policy: () => ({ ...policy, transferTtlMs: 120_000 }),
      now: () => currentNow,
    });
    const service = new CodespaceFileService({
      repository: value.repository,
      transport: value.transport,
      credentials,
      policy: () => policy,
      now: () => currentNow,
      transfers,
      nativeFetcher: {
        fetch: async () => {
          if (failure === "resource-stopped") {
            value.sqlite
              .prepare(
                "UPDATE codespaceResource SET desiredState = 'stopped' WHERE id = 'codespace-1'",
              )
              .run();
          } else if (failure === "reservation-expiry") {
            currentNow += policy.maxOperationMs! + 1;
          }
          return {
            contentLength: bytes.length,
            mimeType: "application/octet-stream",
            body: (async function* () {
              yield bytes;
            })(),
          };
        },
      },
    });
    try {
      const outcome = await service
        .uploadReference("user-1", "codespace-1", {
          path: "input.bin",
          expected: { exists: false },
          reference: {
            fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
            downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
            fileName: "input.bin",
            mimeType: "application/octet-stream",
            declaredSize: bytes.length,
          },
        })
        .then(
          (value) => ({ state: value.operation.state }),
          (error: unknown) => ({ code: (error as { code: string }).code }),
        );
      expect(outcome).toEqual(
        failure === "credential-failure"
          ? { state: "cancelled" }
          : {
              code:
                failure === "authority-revoked"
                  ? "CODESPACE_AUTHORIZATION_REQUIRED"
                  : failure === "reservation-expiry"
                    ? "CODESPACE_PROVIDER_UNAVAILABLE"
                    : "CODESPACE_NOT_RUNNING",
            },
      );
      expect(value.repository.listOwned("user-1", "codespace-1")).toEqual([
        expect.objectContaining({ state: "cancelled", remoteCleanupPending: 0 }),
      ]);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
      expect(readdirSync(root)).toEqual([]);
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completes a truncated search whose full envelope fits the byte budget", async () => {
    const value = fixture();
    const maxBytes = Buffer.byteLength(
      JSON.stringify({ action: "search", matches: [], truncated: false }),
    );
    const resultBytes = Buffer.byteLength(
      JSON.stringify({ action: "search", matches: [], truncated: true }),
    );
    try {
      value.transport.result = { action: "search", matches: [], truncated: true };
      await expect(
        value.service.execute("user-1", "codespace-1", {
          action: "search",
          path: ".",
          query: "needle",
          mode: "literal",
          maxMatches: 10,
          maxBytes,
        }),
      ).resolves.toMatchObject({
        operation: { state: "succeeded", outputBytes: resultBytes },
        result: { action: "search", matches: [], truncated: true },
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("completes a content-free read failure independently of the payload byte budget", async () => {
    const value = fixture();
    try {
      value.transport.result = {
        action: "read",
        state: "failed",
        code: "CODESPACE_FILE_REJECTED",
      };
      await expect(
        value.service.execute("user-1", "codespace-1", {
          action: "read",
          path: "missing.bin",
          offset: 0,
          length: 1,
        }),
      ).resolves.toMatchObject({
        operation: { state: "failed", outputBytes: 0 },
        result: { action: "read", state: "failed", code: "CODESPACE_FILE_REJECTED" },
      });
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    ["per-user object", "user-1", { maxTransferObjectsPerUser: 1 }],
    ["global object", "user-2", { maxTransferObjectsGlobal: 1 }],
    ["per-user aggregate bytes", "user-1", { maxTransferBytesPerUser: 7 }],
    ["global aggregate bytes", "user-2", { maxTransferBytesGlobal: 7 }],
    ["per-user in-flight bytes", "user-1", { maxTransferInflightBytesPerUser: 7 }],
    ["global in-flight bytes", "user-2", { maxTransferInflightBytesGlobal: 7 }],
  ] as const)(
    "rejects exhausted %s quota before credential or remote file contact",
    async (_caseName, reservationUser, override) => {
      const value = fixture();
      const root = mkdtempSync(join(tmpdir(), "moira-file-download-quota-"));
      const transferPolicy: CodespaceResourcePolicy = {
        ...policy,
        maxTransferFileBytes: 1024,
        maxTransferObjectsPerUser: 10,
        maxTransferObjectsGlobal: 10,
        maxTransferBytesPerUser: 1024,
        maxTransferBytesGlobal: 2048,
        maxTransferInflightBytesPerUser: 1024,
        maxTransferInflightBytesGlobal: 2048,
        transferTtlMs: 60_000,
        ...override,
      };
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(value.sqlite),
        root,
        policy: () => transferPolicy,
        now: () => now,
      });
      transfers.reserveDownload(reservationUser, {
        fileName: "existing.bin",
        mimeType: "application/octet-stream",
        maxBytes: 4,
      });
      const service = new CodespaceFileService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
        transfers,
      });
      try {
        await expect(
          service.downloadReference("user-1", "codespace-1", {
            path: "output.bin",
            maxBytes: 4,
            fileName: "output.bin",
            mimeType: "application/octet-stream",
          }),
        ).rejects.toMatchObject({ code: "CODESPACE_POLICY_LIMIT" });
        expect(value.credentials.getCredential).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
        expect(value.repository.listOwned("user-1", "codespace-1")).toEqual([
          expect.objectContaining({
            kind: "download",
            state: "cancelled",
            lastOutcome: "transfer_quota_unavailable_before_dispatch",
          }),
        ]);
      } finally {
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("writes through the exact codespace generation without persisting path or bytes", async () => {
    const value = fixture();
    try {
      const result = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from([0, 255, 1]),
        expected: { exists: false },
      });
      expect(result).toMatchObject({
        operation: { kind: "write", state: "succeeded", inputBytes: 3 },
        result: { action: "write", path: "src/file.bin" },
      });
      const stored = value.sqlite.prepare("SELECT * FROM codespaceOperation").get() as object;
      expect(JSON.stringify(stored)).not.toContain("src/file.bin");
      expect(JSON.stringify(stored)).not.toContain("AP8B");
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a response-lost mutation pending until exact-marker inspection returns its result", async () => {
    const value = fixture();
    try {
      value.transport.throwExecute = true;
      const pending = await value.service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("new"),
        expected: { exists: false },
      });
      expect(pending).toMatchObject({ operation: { state: "reconcile_pending" }, result: null });
      value.transport.throwExecute = false;
      const restarted = new CodespaceFileService({
        repository: new CodespaceOperationRepository(value.sqlite),
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
      });
      const reconciled = await restarted.reconcile("user-1", pending.operation.id);
      expect(reconciled).toMatchObject({
        operation: { state: "succeeded" },
        result: { action: "write", path: "src/file.bin" },
      });
      expect(value.transport.inspectCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a pending file operation reconcile-pending when the connector fails during inspection", async () => {
    const value = fixture();
    try {
      value.transport.throwExecute = true;
      const pending = await value.service.execute("user-1", "codespace-1", {
        action: "stat",
        path: "src/file.bin",
      });
      expect(pending).toMatchObject({ operation: { state: "reconcile_pending" }, result: null });
      value.transport.throwExecute = false;
      value.transport.inspectFile = async () => {
        throw new Error("Connector sidecar is unavailable");
      };
      // A connector failure is not a result: no throw, capacity stays reserved and the
      // operation waits for a later exact inspection instead of surfacing an internal error.
      await expect(value.service.reconcile("user-1", pending.operation.id)).resolves.toMatchObject({
        operation: { state: "reconcile_pending", lastOutcome: "remote_inspection_required" },
        result: null,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("finalizes a pending file operation as failed when exact inspection proves it absent", async () => {
    const value = fixture();
    try {
      value.transport.throwExecute = true;
      const pending = await value.service.execute("user-1", "codespace-1", {
        action: "stat",
        path: "src/file.bin",
      });
      expect(pending).toMatchObject({ operation: { state: "reconcile_pending" }, result: null });
      value.transport.throwExecute = false;
      value.transport.inspectFile = async () => ({ state: "absent" as const });
      await expect(value.service.reconcile("user-1", pending.operation.id)).resolves.toMatchObject({
        operation: { state: "failed", outputBytes: 0 },
        result: null,
      });
      // Capacity is released: the same codespace accepts new work again.
      value.transport.result = {
        action: "stat",
        stat: {
          path: "src/file.bin",
          type: "file",
          size: 0,
          mode: 0o644,
          modifiedAt: now,
          version: null,
        },
      };
      const next = await value.service.execute("user-1", "codespace-1", {
        action: "stat",
        path: "src/file.bin",
      });
      expect(next.operation.state).toBe("succeeded");
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects traversal and cross-tenant replay before credential or transport contact", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-1", "codespace-1", { action: "stat", path: "../secret" }),
      ).rejects.toThrow(/path/);
      await expect(
        value.service.execute("user-2", "codespace-1", { action: "stat", path: "src" }),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test.each(
    (["github-codespaces", "local-sandboxes"] as const).flatMap((provider) =>
      (["reserved", "running", "cancel_pending", "reconcile_pending"] as const).map(
        (state) => [provider, state] as const,
      ),
    ),
  )("admits independent file writes with %s journal work left %s", (provider, state) => {
    const value = fixture();
    const reserve = (kind: "write" | "upload" | "apply_patch" | "read" | "exec" | "stat") =>
      value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
        kind,
        inputBytes: 0,
        stdoutLimitBytes: 0,
        stderrLimitBytes: 0,
        deadlineAt: now + 30_000,
        policy: {
          ...policy,
          maxConcurrentOperationsPerUser: 20,
          maxConcurrentOperationsGlobal: 20,
        },
        now,
      });
    try {
      value.sqlite.prepare("UPDATE codespaceConnection SET provider=?").run(provider);
      value.sqlite.prepare("UPDATE codespaceResource SET provider=?").run(provider);
      const active = reserve("apply_patch");
      expect(active.outcome).toBe("reserved");
      value.sqlite
        .prepare("UPDATE codespaceOperation SET state=? WHERE id=?")
        .run(state, active.operation!.id);
      const before = value.repository.getOwned("user-1", active.operation!.id);
      for (const nextKind of ["write", "upload", "apply_patch"] as const) {
        expect(reserve(nextKind).outcome).toBe("reserved");
      }
      expect(reserve("read").outcome).toBe("reserved");
      expect(reserve("exec").outcome).toBe("reserved");
      expect(reserve("stat").outcome).toBe("reserved");
      expect(value.repository.getOwned("user-1", active.operation!.id)).toEqual(before);
      expect(value.repository.countActiveForUser("user-1")).toBe(7);
    } finally {
      value.sqlite.close();
    }
  });

  test.each(["write", "upload", "apply_patch"] as const)(
    "admits %s beside a background command while retaining file preconditions and shared ceilings",
    async (action) => {
      const value = fixture();
      try {
        const operations = new CodespaceOperationService({
          repository: value.repository,
          credentials: value.credentials,
          policy: () => policy,
          now: () => now,
          transport: {
            health: async () => ({ ok: true, reason: null }),
            execute: async () => ({ state: "running" }),
            inspect: async () => ({ state: "running" }),
            cancel: async () => ({ state: "running" }),
            finalize: async () => {},
            readOutput: async () => ({ state: "absent" }),
          },
        });
        const background = await operations.execute("user-1", "codespace-1", {
          argv: ["npm", "run", "dev"],
          background: true,
          stdin: { kind: "inline", bytes: new Uint8Array() },
        });
        expect(background.operation.state).toBe("running");
        const expected = { exists: true, size: 3, sha256: "a".repeat(64) };
        const current = { size: 3, sha256: "b".repeat(64), modifiedAt: now };
        const request =
          action === "apply_patch"
            ? {
                action,
                files: [
                  {
                    path: "file.txt",
                    expected,
                    edits: [{ start: 0, end: 3, bytes: Buffer.from("new") }],
                  },
                ],
              }
            : { action, path: "file.txt", bytes: Buffer.from("new"), expected };
        value.transport.executeFile = async (...args) => {
          expect(value.repository.countActiveForUser("user-1")).toBe(2);
          expect(
            value.repository.reserve({
              userId: "user-1",
              resourceId: "codespace-1",
              kind: "stat",
              inputBytes: 0,
              stdoutLimitBytes: 0,
              stderrLimitBytes: 0,
              deadlineAt: now + 30_000,
              policy,
              now,
            }).outcome,
          ).toBe("busy");
          expect(args[3]).toEqual(request);
          return action === "apply_patch"
            ? {
                action,
                files: [{ path: "file.txt", previous: current, current }],
                summary: {
                  filesChanged: 1,
                  editsApplied: 1,
                  insertedBytes: 3,
                  deletedBytes: 3,
                  entries: [],
                  truncated: false,
                },
              }
            : { action, path: "file.txt", previous: current, current };
        };
        const result = await value.service.execute("user-1", "codespace-1", request);
        expect(result.operation.state).toBe("succeeded");
        expect(operations.get("user-1", background.operation.id)?.state).toBe("running");
        expect(value.repository.countActiveForUser("user-1")).toBe(1);
        value.transport.result = { action, state: "failed", code: "CODESPACE_FILE_REJECTED" };
        value.transport.executeFile = FakeFileTransport.prototype.executeFile;
        const stale = await value.service.execute("user-1", "codespace-1", request);
        expect(stale.operation.state).toBe("failed");
        expect(stale.result).toEqual({ action, state: "failed", code: "CODESPACE_FILE_REJECTED" });
        expect(value.transport.lastRequest).toEqual(request);
        expect(value.repository.countActiveForUser("user-1")).toBe(1);
      } finally {
        value.sqlite.close();
      }
    },
  );
});
