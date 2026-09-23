import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodespaceConnectionRepository,
  CodespaceOperationRepository,
  CodespaceOperationService,
  CodespaceFileService,
  CodespaceResourceRepository,
  CodespaceTransferRepository,
  CodespaceTransferService,
  CodespaceResourceError,
  type CodespaceOperationAuditEvent,
  type CodespaceOperationOutputRequest,
  type CodespaceOperationOutputResult,
  type CodespaceOperationResult,
  type CodespaceOperationTransport,
  type CodespaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = path.resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_850_000_000;
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
  maxConcurrentOperationsPerUser: 1,
  maxConcurrentOperationsGlobal: 2,
  maxOperationInputBytes: 1024,
  maxOperationStdoutBytes: 1024,
  maxOperationStderrBytes: 512,
  maxRetainedOutputBytes: 32 * 1024 * 1024,
  maxOperationMs: 60_000,
  maxBackgroundOperationMs: 4 * 60 * 60_000,
};

/**
 * A terminal exec result as the transport reports it: the payload, plus the complete size of each
 * retained stream. Tests that do not exercise truncation let the payload be the whole stream.
 */
function execResult(value: {
  state: CodespaceOperationResult["state"];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  stdoutTotalBytes?: number;
  stderrTotalBytes?: number;
  outputLimitExceeded?: boolean;
  sessionCaptureDropped?: boolean;
}): CodespaceOperationResult {
  return {
    state: value.state,
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode: value.exitCode,
    stdoutTotalBytes: value.stdoutTotalBytes ?? Buffer.byteLength(value.stdout),
    stderrTotalBytes: value.stderrTotalBytes ?? Buffer.byteLength(value.stderr),
    outputLimitExceeded: value.outputLimitExceeded ?? false,
    sessionCaptureDropped: value.sessionCaptureDropped ?? false,
  };
}

class FakeTransport implements CodespaceOperationTransport {
  available = true;
  async health() {
    return { ok: this.available, reason: null };
  }
  executeResult: Awaited<ReturnType<CodespaceOperationTransport["execute"]>> = execResult({
    state: "succeeded",
    stdout: "ok",
    stderr: "",
    exitCode: 0,
  });
  cancelResult: CodespaceOperationResult | { state: "running" } | { state: "absent" } = {
    state: "running",
  };
  throwExecute = false;
  throwInspect = false;
  throwFinalize = false;
  /** Defaults to the execute outcome; set when a test needs inspect to differ from dispatch. */
  inspectResult: Awaited<ReturnType<CodespaceOperationTransport["inspect"]>> | null = null;
  lastCodespace: Parameters<CodespaceOperationTransport["execute"]>[1] | null = null;
  lastRequest: Parameters<CodespaceOperationTransport["execute"]>[3] | null = null;
  executeGate: Promise<void> | null = null;
  executeObservation: (() => void) | null = null;
  /** Runs inside inspect so a test can interleave a concurrent reconcile. */
  inspectObservation: (() => Promise<unknown>) | null = null;
  lastInspectedOperation: Parameters<CodespaceOperationTransport["inspect"]>[2] | null = null;
  readonly executeCalls = jest.fn();
  readonly inspectCalls = jest.fn();
  readonly cancelCalls = jest.fn();
  readonly finalizeCalls = jest.fn();

  async execute(
    _credential: string,
    codespace: Parameters<CodespaceOperationTransport["execute"]>[1],
    _operation: Parameters<CodespaceOperationTransport["execute"]>[2],
    request: Parameters<CodespaceOperationTransport["execute"]>[3],
  ) {
    this.executeCalls();
    this.lastCodespace = codespace;
    this.lastRequest = request;
    if (this.throwExecute) throw new Error("ssh response lost");
    this.executeObservation?.();
    if (this.executeGate) await this.executeGate;
    return this.executeResult;
  }

  async inspect(
    _credential: string,
    _codespace: Parameters<CodespaceOperationTransport["inspect"]>[1],
    operation: Parameters<CodespaceOperationTransport["inspect"]>[2],
  ) {
    this.inspectCalls();
    this.lastInspectedOperation = operation;
    if (this.throwInspect) throw new Error("ssh response lost");
    if (this.inspectObservation) await this.inspectObservation();
    if (this.inspectResult) return this.inspectResult;
    // An execute answer that inspect cannot give — a session limit is decided at dispatch — never
    // reaches here in practice; reporting it as still running keeps the fake inside its contract.
    return this.executeResult.state === "session_limit" ||
      this.executeResult.state === "session_unavailable"
      ? { state: "running" as const }
      : this.executeResult;
  }

  async cancel() {
    this.cancelCalls();
    return this.cancelResult;
  }

  outputResult: CodespaceOperationOutputResult | { state: "absent" } = {
    stream: "stdout",
    offset: 0,
    totalBytes: 0,
    bytes: Buffer.alloc(0),
  };
  lastOutputOperation: string | null = null;
  lastOutputRequest: CodespaceOperationOutputRequest | null = null;
  readonly readOutputCalls = jest.fn();

  async readOutput(
    _credential: string,
    _codespace: Parameters<CodespaceOperationTransport["readOutput"]>[1],
    operation: Parameters<CodespaceOperationTransport["readOutput"]>[2],
    request: CodespaceOperationOutputRequest,
  ) {
    this.readOutputCalls();
    this.lastOutputOperation = operation.id;
    this.lastOutputRequest = request;
    return this.outputResult;
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
  const transport = new FakeTransport();
  const credentials = { getCredential: jest.fn(async () => "ghu_access") };
  const audits: CodespaceOperationAuditEvent[] = [];
  let currentNow = now;
  // The settle window is exercised for its attempts, not for real elapsed time.
  const settleDelays: number[] = [];
  // The lifecycle authority an operation borrows to wake a sleeping codespace. The fake wakes it by
  // the same state change the real service converges to, and counts what the operation asked for.
  const lifecycle = {
    calls: [] as string[],
    refusal: null as CodespaceResourceError | null,
    ensureRunning: jest.fn(async (userId: string, codespaceId: string) => {
      lifecycle.calls.push(codespaceId);
      if (lifecycle.refusal) throw lifecycle.refusal;
      sqlite
        .prepare(
          `UPDATE codespaceResource SET state = 'usable', desiredState = 'running',
           observedState = 'running' WHERE id = ? AND userId = ?`,
        )
        .run(codespaceId, userId);
      return new CodespaceResourceRepository(sqlite).getOwned(userId, codespaceId)!;
    }),
  };
  const service = new CodespaceOperationService({
    repository,
    transport,
    credentials,
    lifecycle,
    policy: () => policy,
    now: () => currentNow,
    delay: async (milliseconds) => {
      settleDelays.push(milliseconds);
    },
    audit: (event) => {
      audits.push(event);
    },
  });
  return {
    sqlite,
    repository,
    audits,
    settleDelays,
    transport,
    credentials,
    service,
    lifecycle,
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

describe("durable direct codespace operations", () => {
  test("rejects unavailable connector before credentials on dispatch and result recovery", async () => {
    const value = fixture();
    const request = {
      argv: ["true"],
      cwd: ".",
      stdin: { kind: "inline" as const, bytes: new Uint8Array() },
      timeoutMs: 1000,
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
  test.each([
    ["generation", "UPDATE codespaceResource SET generation = 2", "CODESPACE_GENERATION_CONFLICT"],
    [
      "authorization generation",
      "UPDATE codespaceConnection SET credentialGeneration = 2",
      "CODESPACE_GENERATION_CONFLICT",
    ],
    [
      "revoked grant",
      "DELETE FROM codespaceConnectionRepository",
      "CODESPACE_AUTHORIZATION_REQUIRED",
    ],
    [
      "disconnected",
      "UPDATE codespaceConnection SET status = 'disconnected'",
      "CODESPACE_AUTHORIZATION_REQUIRED",
    ],
    ["stopped", "UPDATE codespaceResource SET desiredState = 'stopped'", "CODESPACE_NOT_RUNNING"],
    [
      "disabled",
      "INSERT INTO codespaceProviderControl (scope,disabled,reason,updatedAt) VALUES ('global',1,'test',0)",
      "CODESPACE_PROVIDER_DISABLED",
    ],
  ])(
    "denies %s result access before credentials for exec and file results",
    async (_case, sql, code) => {
      for (const kind of ["exec", "stat"] as const) {
        const value = fixture();
        try {
          const reservation = value.repository.reserve({
            userId: "user-1",
            resourceId: "codespace-1",
            kind,
            inputBytes: 0,
            stdoutLimitBytes: 1024,
            stderrLimitBytes: 512,
            deadlineAt: now + 1000,
            policy,
            now,
          });
          value.repository.beginDispatch(
            "user-1",
            reservation.operation!.id,
            1,
            "dispatch",
            now + 1000,
            now,
          );
          value.sqlite.exec(sql);
          const inspectFile = jest.fn(async () => ({ state: "running" as const }));
          const service =
            kind === "exec"
              ? value.service
              : new CodespaceFileService({
                  repository: value.repository,
                  credentials: value.credentials,
                  policy: () => policy,
                  now: () => now,
                  transport: {
                    health: async () => ({ ok: true, reason: null }),
                    inspectFile,
                    executeFile: async () => ({ state: "running" }),
                  },
                });
          await expect(
            service.reconcile("user-1", reservation.operation!.id),
          ).rejects.toMatchObject({ code });
          expect(value.credentials.getCredential).not.toHaveBeenCalled();
          expect(value.transport.inspectCalls).not.toHaveBeenCalled();
          expect(inspectFile).not.toHaveBeenCalled();
        } finally {
          value.sqlite.close();
        }
      }
    },
  );

  test("keeps a background command running past the call and collects it by its own identity", async () => {
    const value = fixture();
    try {
      // The connector answers "running" for a dispatch; a background command is expected to stay
      // that way well past the call that started it.
      value.transport.executeResult = { state: "running" };
      value.transport.inspectResult = { state: "running" };
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["npm", "run", "build"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 2 * 60 * 60_000,
        background: true,
      });
      expect(started.operation.state).toBe("running");
      expect(started.result).toBeNull();
      // The answer is not delayed by a settle window the command cannot satisfy.
      expect(value.settleDelays).toEqual([]);
      expect(value.transport.inspectCalls).toHaveBeenCalledTimes(0);
      // Its deadline is its own lifetime, not a request's, so reconciliation will not cancel it.
      expect(started.operation.deadlineAt).toBe(now + 2 * 60 * 60_000);
      expect(value.transport.lastRequest?.background).toBe(true);

      // It stays observable while it runs, without a second dispatch.
      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toBeNull();
      expect(value.service.get("user-1", started.operation.id)?.state).toBe("running");

      value.transport.inspectResult = execResult({
        state: "succeeded",
        stdout: "built",
        stderr: "",
        exitCode: 0,
      });
      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toMatchObject({
        state: "succeeded",
        stdout: "built",
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("gives a command the duration its mode implies and keeps its result for that long", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      // A caller that names no duration and asks for the background gets the whole ceiling, not
      // the ordinary default that would kill its build minutes in.
      const background = await value.service.execute("user-1", "codespace-1", {
        argv: ["npm", "run", "build"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        background: true,
      });
      expect(value.transport.lastRequest?.timeoutMs).toBe(policy.maxBackgroundOperationMs);
      expect(background.operation.deadlineAt).toBe(now + policy.maxBackgroundOperationMs!);

      // Its result outlives the cleanup window a short command gets, because the command itself
      // was allowed to take far longer than that window.
      value.transport.inspectResult = execResult({
        state: "succeeded",
        stdout: "built",
        stderr: "",
        exitCode: 0,
      });
      await value.service.reconcile("user-1", background.operation.id);
      expect(value.service.get("user-1", background.operation.id)?.resultExpiresAt).toBe(
        now + policy.maxBackgroundOperationMs!,
      );

      // A bounded command keeps the ordinary cleanup window.
      value.transport.executeResult = execResult({
        state: "succeeded",
        stdout: "quick",
        stderr: "",
        exitCode: 0,
      });
      const bounded = await value.service.execute("user-1", "codespace-1", {
        argv: ["echo", "quick"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      expect(value.service.get("user-1", bounded.operation.id)?.resultExpiresAt).toBe(
        now + policy.cleanupDeadlineMs,
      );
      // A long command's lifetime is granted when it starts running, not when it is reserved, so a
      // reservation that never dispatches is reaped on its own short deadline.
      const reservation = value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 1024,
        deadlineAt: now + 15 * 60_000,
        policy,
        now,
      });
      const reservedId = reservation.operation!.id;
      expect(value.repository.getOwned("user-1", reservedId)?.deadlineAt).toBe(now + 15 * 60_000);
      expect(
        value.repository.beginDispatch(
          "user-1",
          reservedId,
          reservation.operation!.resourceGeneration,
          "claim-1",
          now + 60_000,
          now,
          now + policy.maxBackgroundOperationMs!,
        ),
      ).toBe(true);
      expect(value.repository.getOwned("user-1", reservedId)?.deadlineAt).toBe(
        now + policy.maxBackgroundOperationMs!,
      );
    } finally {
      value.sqlite.close();
    }
  });

  test("refuses a session that would exceed its ceiling and keeps the caller's command forms honest", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "session_limit", limit: "context" };
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 5_000,
          session: "build",
          env: { BIG: "x" },
        }),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("stored context"),
      });
      value.transport.executeResult = { state: "session_limit", limit: "sessions" };
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 5_000,
          session: "another",
          sessionStart: true,
        }),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("open sessions"),
      });
      // Both refusals end their operation rather than leaving capacity held, and the stored record
      // says why, so a later audit read does not read them as cancellations the caller asked for.
      expect(
        value.service.list("user-1", "codespace-1").map((operation) => operation.lastOutcome),
      ).toEqual(["session_limit", "session_limit"]);

      // A caller names one kind of work: argv, a script inside a session, or ending a session.
      for (const invalid of [
        { argv: ["true"], script: "echo hello", session: "build" },
        { script: "echo hello" },
        {},
      ]) {
        await expect(
          value.service.execute("user-1", "codespace-1", {
            cwd: ".",
            stdin: { kind: "inline", bytes: new Uint8Array() },
            timeoutMs: 5_000,
            ...invalid,
          }),
        ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      }
    } finally {
      value.sqlite.close();
    }
  });

  test("refuses a command whose session is gone without running it", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "session_unavailable" };
      const before = value.service.list("user-1", "codespace-1").length;
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["npm", "test"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 5_000,
          session: "build",
        }),
      ).rejects.toMatchObject({
        code: "CODESPACE_SESSION_UNAVAILABLE",
        detail: expect.stringContaining("session"),
      });
      // The operation exists and is over; no command ran and no capacity stays held.
      const operations = value.service.list("user-1", "codespace-1");
      expect(operations).toHaveLength(before + 1);
      expect(operations[operations.length - 1]).toMatchObject({
        state: "cancelled",
        exitCode: null,
        outputBytes: 0,
        lastOutcome: "session_unavailable",
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);

      // A malformed session or variable is refused before anything is reserved.
      for (const invalid of [
        { session: "../escape" },
        { env: { "not a name": "x" } },
        { env: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`V${index}`, "x"])) },
      ]) {
        await expect(
          value.service.execute("user-1", "codespace-1", {
            argv: ["true"],
            cwd: ".",
            stdin: { kind: "inline", bytes: new Uint8Array() },
            timeoutMs: 5_000,
            ...invalid,
          }),
        ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      }
      expect(value.service.list("user-1", "codespace-1")).toHaveLength(before + 1);
    } finally {
      value.sqlite.close();
    }
  });

  test("bounds each kind of command by its own ceiling and says which one was met", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["sleep", "3600"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: policy.maxOperationMs! + 1,
        }),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("background"),
      });
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["sleep", "99999"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: policy.maxBackgroundOperationMs! + 1,
          background: true,
        }),
      ).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
        detail: expect.stringContaining("hours"),
      });
      // A duration the bounded command refuses is admitted in the background.
      value.transport.executeResult = { state: "running" };
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["sleep", "3600"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: policy.maxOperationMs! + 1,
        background: true,
      });
      expect(started.operation.state).toBe("running");

      // A background command is stopped the same way any other operation is.
      value.transport.cancelResult = execResult({
        state: "cancelled",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
      const cancelled = await value.service.cancel("user-1", started.operation.id);
      expect(cancelled.operation.state).toBe("cancelled");
      expect(value.transport.cancelCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("reports a truncated payload with its complete size and serves any retained range", async () => {
    const value = fixture();
    try {
      // The command printed far more than one answer may carry, and finished on its own terms.
      value.transport.executeResult = execResult({
        state: "failed",
        stdout: "first bytes",
        stderr: "real failure",
        exitCode: 7,
        stdoutTotalBytes: 900_000,
      });
      const dispatched = await value.service.execute("user-1", "codespace-1", {
        argv: ["build"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      expect(dispatched.result).toMatchObject({
        exitCode: 7,
        stderr: "real failure",
        stdoutTotalBytes: 900_000,
        outputLimitExceeded: false,
      });
      // The recorded size is the whole stream, not the part the answer carried.
      expect(value.service.get("user-1", dispatched.operation.id)?.outputBytes).toBe(
        900_000 + "real failure".length,
      );
      // The retained ceiling travelled with the dispatch; the payload bound did not become one.
      expect(value.transport.lastRequest?.maxRetainedBytes).toBe(policy.maxRetainedOutputBytes);

      value.transport.outputResult = {
        stream: "stdout",
        offset: 899_990,
        totalBytes: 900_000,
        bytes: Buffer.from("last bytes"),
      };
      await expect(
        value.service.readOutput("user-1", dispatched.operation.id, {
          stream: "stdout",
          offset: 899_990,
          length: 64,
        }),
      ).resolves.toMatchObject({ totalBytes: 900_000, bytes: Buffer.from("last bytes") });
      expect(value.transport.lastOutputOperation).toBe(dispatched.operation.id);
      expect(value.transport.readOutputCalls).toHaveBeenCalledTimes(1);

      // An unavailable connector is refused as that, before any credential is fetched.
      value.transport.available = false;
      await expect(
        value.service.readOutput("user-1", dispatched.operation.id, {
          stream: "stdout",
          offset: 0,
          length: 64,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_PROVIDER_UNAVAILABLE" });
      expect(value.transport.readOutputCalls).toHaveBeenCalledTimes(1);
      value.transport.available = true;

      // Another user's operation is not readable, and output that cleanup already removed is
      // reported as expired rather than as an empty stream.
      await expect(
        value.service.readOutput("user-2", dispatched.operation.id, {
          stream: "stdout",
          offset: 0,
          length: 64,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
      value.transport.outputResult = { state: "absent" };
      await expect(
        value.service.readOutput("user-1", dispatched.operation.id, {
          stream: "stdout",
          offset: 0,
          length: 64,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESULT_EXPIRED" });
    } finally {
      value.sqlite.close();
    }
  });

  test("returns the result of a command that finishes during the settle window", async () => {
    const value = fixture();
    try {
      // The connector always answers "running" for an exec; the outcome appears moments later.
      value.transport.executeResult = { state: "running" };
      value.transport.inspectResult = execResult({
        state: "succeeded",
        stdout: "immediate",
        stderr: "",
        exitCode: 0,
      });
      const dispatched = await value.service.execute("user-1", "codespace-1", {
        argv: ["printf", "immediate"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });

      expect(dispatched.operation.state).toBe("succeeded");
      expect(dispatched.result).toEqual(
        execResult({
          state: "succeeded",
          stdout: "immediate",
          stderr: "",
          exitCode: 0,
        }),
      );
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.transport.inspectCalls).toHaveBeenCalledTimes(1);
      expect(value.settleDelays).toEqual([150]);
      expect(
        value.audits.filter((event) => event.action === "terminal" && event.state === "succeeded"),
      ).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a resumable running envelope for a command that outlives the settle window", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      value.transport.inspectResult = { state: "running" };
      const dispatched = await value.service.execute("user-1", "codespace-1", {
        argv: ["sleep", "30"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 60_000,
      });

      expect(dispatched.operation.state).toBe("running");
      expect(dispatched.result).toBeNull();
      // Bounded: the window makes a fixed small number of attempts and then gives up.
      expect(value.settleDelays).toEqual([150, 350, 750]);

      value.transport.inspectResult = execResult({
        state: "succeeded",
        stdout: "late",
        stderr: "",
        exitCode: 0,
      });
      await expect(
        value.service.reconcile("user-1", dispatched.operation.id),
      ).resolves.toMatchObject({ state: "succeeded", stdout: "late" });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("falls back to the running envelope when the settle window itself fails", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      value.transport.throwInspect = true;
      const dispatched = await value.service.execute("user-1", "codespace-1", {
        argv: ["printf", "unknown"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });

      expect(dispatched.result).toBeNull();
      // A failed inspection means the outcome is unknown, not lost: the operation stays
      // resumable and the background reconciler will reach it.
      expect(value.repository.getOwned("user-1", dispatched.operation.id)).toMatchObject({
        state: "reconcile_pending",
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("admits every operation submitted within one day", async () => {
    const value = fixture();
    try {
      for (let submitted = 0; submitted < 40; submitted++) {
        const result = await value.service.execute("user-1", "codespace-1", {
          argv: ["printf", String(submitted)],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1000,
        });
        expect(result.operation.state).toBe("succeeded");
      }
      // Accounting that survives the removed budget counts provider cleanups, not submissions.
      expect(value.sqlite.prepare("SELECT * FROM codespacePolicyUsage").all()).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects result access while the provider is disabled", async () => {
    const value = fixture();
    try {
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      value.credentials.getCredential.mockClear();
      const disabled = new CodespaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => ({ ...policy, enabled: false }),
        now: () => now,
      });
      await expect(disabled.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_DISABLED",
      });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("rechecks result authority after asynchronous credential refresh", async () => {
    const value = fixture();
    try {
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      value.credentials.getCredential.mockImplementationOnce(async () => {
        value.sqlite.exec("UPDATE codespaceResource SET generation = 2");
        return "ghu_access";
      });
      await expect(value.service.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_GENERATION_CONFLICT",
      });
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("denies expired retained output before credentials while background cleanup still finalizes it", async () => {
    const value = fixture();
    try {
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      value.credentials.getCredential.mockClear();
      value.advance(policy.cleanupDeadlineMs);
      await expect(value.service.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_RESULT_EXPIRED",
      });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
      await expect(value.service.reconcileOnce()).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", started.operation.id)?.remoteCleanupPending).toBe(
        0,
      );
    } finally {
      value.sqlite.close();
    }
  });
  test.each([true, false])(
    "ingests a native reference with metadata=%s and dispatches exact bytes through one call",
    async (includeMetadata) => {
      const value = fixture();
      const root = mkdtempSync(path.join(tmpdir(), "moira-native-operation-input-"));
      const bytes = Buffer.from([0, 255, 17, 128, 4]);
      const transfers = new CodespaceTransferService({
        repository: new CodespaceTransferRepository(value.sqlite),
        root,
        policy: () => policy,
        now: () => now,
      });
      const nativeFetch = jest.fn(async () => {
        const reservedBytes = includeMetadata ? bytes.length : policy.maxOperationInputBytes;
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
            yield bytes.subarray(0, 2);
            yield bytes.subarray(2);
          })(),
        };
      });
      const service = new CodespaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        transfers,
        nativeFetcher: { fetch: nativeFetch },
        policy: () => policy,
        now: () => now,
      });
      try {
        const result = await service.executeNativeReference(
          "user-1",
          "codespace-1",
          { argv: ["sha256sum"], cwd: ".", timeoutMs: 5_000 },
          {
            fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
            downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
            ...(includeMetadata
              ? {
                  fileName: "stdin.bin",
                  mimeType: "application/octet-stream",
                  declaredSize: bytes.length,
                }
              : {}),
          },
        );
        expect(result.operation.state).toBe("succeeded");
        expect(result.operation.inputBytes).toBe(bytes.length);
        expect(value.transport.lastRequest?.stdin).toEqual({ kind: "inline", bytes });
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
          count: 0,
        });
        await expect(
          service.executeNativeReference(
            "user-1",
            "codespace-1",
            { argv: ["cat"], cwd: ".", timeoutMs: 5_000 },
            {
              fileId: "sediment://file_oversized",
              downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
              fileName: "oversized.bin",
              mimeType: "application/octet-stream",
              declaredSize: 1025,
            },
          ),
        ).rejects.toThrow(/input exceeds/);
        expect(nativeFetch).toHaveBeenCalledTimes(1);
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
          count: 0,
        });
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceOperation").get()).toEqual(
          {
            count: 1,
          },
        );
      } finally {
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["foreign", "user-2", "codespace-1", (_value: ReturnType<typeof fixture>): void => undefined],
    [
      "unavailable connector",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>) => {
        value.transport.available = false;
      },
    ],
    [
      "missing",
      "user-1",
      "codespace-missing",
      (_value: ReturnType<typeof fixture>): void => undefined,
    ],
    [
      "stopped",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>) => {
        value.sqlite
          .prepare(
            "UPDATE codespaceResource SET state = 'stopped', desiredState = 'stopped' WHERE id = 'codespace-1'",
          )
          .run();
      },
    ],
    [
      "disabled",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>) => {
        new CodespaceResourceRepository(value.sqlite).setControl({
          scope: "global",
          disabled: true,
          reason: "incident",
          updatedBy: null,
          now,
          cleanupDeadlineAt: now + 30_000,
        });
      },
    ],
    [
      "busy",
      "user-1",
      "codespace-1",
      (value: ReturnType<typeof fixture>) => {
        value.repository.reserve({
          userId: "user-1",
          resourceId: "codespace-1",
          inputBytes: 0,
          stdoutLimitBytes: 16,
          stderrLimitBytes: 16,
          deadlineAt: now + 30_000,
          policy,
          now,
        });
      },
    ],
  ] as const)(
    "rejects a %s codespace before native fetch or downstream contact",
    async (_caseName, userId, codespaceId, arrange) => {
      const value = fixture();
      const root = mkdtempSync(path.join(tmpdir(), "moira-native-operation-authority-"));
      const nativeFetch = jest.fn(async () => ({
        contentLength: 1,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from([1]);
        })(),
      }));
      const service = new CodespaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        transfers: new CodespaceTransferService({
          repository: new CodespaceTransferRepository(value.sqlite),
          root,
          policy: () => policy,
          now: () => now,
        }),
        nativeFetcher: { fetch: nativeFetch },
        policy: () => policy,
        now: () => now,
      });
      try {
        arrange(value);
        await expect(
          service.executeNativeReference(
            userId,
            codespaceId,
            { argv: ["cat"], cwd: ".", timeoutMs: 5_000 },
            {
              fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
              downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
              fileName: "stdin.bin",
              mimeType: "application/octet-stream",
              declaredSize: 1,
            },
          ),
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

  test("materializes native-reference stdin as exact binary bytes and consumes it after durable dispatch", async () => {
    const value = fixture();
    const bytes = Buffer.from([0, 255, 1, 2]);
    const record = {
      id: "transfer-1",
      userId: "user-1",
      purpose: "codespace_input",
      state: "claimed",
      fileName: "stdin.bin",
      mimeType: "application/octet-stream",
      declaredSize: bytes.length,
      observedSize: bytes.length,
      sha256: "a".repeat(64),
      objectKey: "b".repeat(48),
      ownerPid: process.pid,
      ownerStartTime: null,
      claimId: "claim-1",
      claimExpiresAt: now + 10_000,
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    } as const;
    // Only the input path is exercised here, so the double carries the three methods this call
    // reaches and says that it is partial rather than claiming to be the transfer service.
    const transfers = {
      claimInput: jest.fn(async () => ({ record, bytes })),
      release: jest.fn(),
      consume: jest.fn(async () => undefined),
    } as unknown as NonNullable<
      ConstructorParameters<typeof CodespaceOperationService>[0]["transfers"]
    >;
    const service = new CodespaceOperationService({
      repository: value.repository,
      transport: value.transport,
      credentials: value.credentials,
      transfers,
      policy: () => policy,
      now: () => now,
    });
    try {
      const result = await service.execute("user-1", "codespace-1", {
        argv: ["sha256sum"],
        cwd: ".",
        stdin: {
          kind: "reference",
          referenceId: "codespace-file://abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
          declaredBytes: bytes.length,
          declaredMimeType: "application/octet-stream",
        },
        timeoutMs: 5_000,
      });
      expect(result.operation.state).toBe("succeeded");
      expect(value.transport.lastRequest?.stdin).toEqual({ kind: "inline", bytes });
      expect(transfers.consume).toHaveBeenCalledWith(record);
      expect(transfers.release).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects unavailable and size-mismatched native stdin before credentials or connector contact", async () => {
    const value = fixture();
    const unavailableTransfers = {
      claimInput: jest.fn(async () => {
        throw new Error("expired, consumed or foreign reference");
      }),
      release: jest.fn(),
      consume: jest.fn(async () => undefined),
    } as unknown as NonNullable<
      ConstructorParameters<typeof CodespaceOperationService>[0]["transfers"]
    >;
    const service = new CodespaceOperationService({
      repository: value.repository,
      transport: value.transport,
      credentials: value.credentials,
      transfers: unavailableTransfers,
      policy: () => policy,
      now: () => now,
    });
    try {
      const unavailable = await service.execute("user-1", "codespace-1", {
        argv: ["cat"],
        cwd: ".",
        stdin: {
          kind: "reference",
          referenceId: "codespace-file://unavailable",
          declaredBytes: 4,
          declaredMimeType: "application/octet-stream",
        },
        timeoutMs: 5_000,
      });
      expect(unavailable).toMatchObject({
        operation: {
          state: "cancelled",
          lastOutcome: "native_input_unavailable_before_dispatch",
          remoteCleanupPending: 0,
        },
        result: null,
      });

      const record = {
        id: "transfer-2",
        userId: "user-1",
        purpose: "codespace_input",
        state: "claimed",
        fileName: "stdin.bin",
        mimeType: "application/octet-stream",
        declaredSize: 4,
        observedSize: 4,
        sha256: "a".repeat(64),
        objectKey: "b".repeat(48),
        ownerPid: process.pid,
        ownerStartTime: null,
        claimId: "claim-2",
        claimExpiresAt: now + 10_000,
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      } as const;
      const mismatchTransfers = {
        claimInput: jest.fn(async () => ({ record, bytes: Buffer.from([1, 2, 3, 4]) })),
        release: jest.fn(),
        consume: jest.fn(async () => undefined),
      } as unknown as NonNullable<
        ConstructorParameters<typeof CodespaceOperationService>[0]["transfers"]
      >;
      const mismatchService = new CodespaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        transfers: mismatchTransfers,
        policy: () => policy,
        now: () => now,
      });
      const mismatch = await mismatchService.execute("user-1", "codespace-1", {
        argv: ["cat"],
        cwd: ".",
        stdin: {
          kind: "reference",
          referenceId: "codespace-file://size-mismatch",
          declaredBytes: 3,
          declaredMimeType: "application/octet-stream",
        },
        timeoutMs: 5_000,
      });
      expect(mismatch).toMatchObject({
        operation: {
          state: "cancelled",
          lastOutcome: "native_input_unavailable_before_dispatch",
          remoteCleanupPending: 0,
        },
        result: null,
      });
      const mimeMismatch = await mismatchService.execute("user-1", "codespace-1", {
        argv: ["cat"],
        cwd: ".",
        stdin: {
          kind: "reference",
          referenceId: "codespace-file://mime-mismatch",
          declaredBytes: 4,
          declaredMimeType: "text/plain",
        },
        timeoutMs: 5_000,
      });
      expect(mimeMismatch).toMatchObject({
        operation: {
          state: "cancelled",
          lastOutcome: "native_input_unavailable_before_dispatch",
          remoteCleanupPending: 0,
        },
        result: null,
      });
      expect(mismatchTransfers.release).toHaveBeenCalledWith(record);
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("preserves argv boundaries and exact exit 23 without persisting command or stdin", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = execResult({
        state: "failed",
        stdout: "partial output",
        stderr: "expected failure",
        exitCode: 23,
      });
      const stdin = new TextEncoder().encode("opaque input");
      const operation = await value.service.execute("user-1", "codespace-1", {
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
      expect(operation.result).toEqual(
        execResult({
          state: "failed",
          stdout: "partial output",
          stderr: "expected failure",
          exitCode: 23,
        }),
      );
      expect(value.transport.lastCodespace?.machine).toEqual({
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
      const stored = value.sqlite.prepare("SELECT * FROM codespaceOperation").get() as object;
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
      const result = await value.service.execute("user-1", "codespace-1", {
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
      const result = await value.service.execute("user-1", "codespace-1", {
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
          "UPDATE codespaceConnection SET credentialGeneration = 2 WHERE id = 'connection-1'",
        )
        .run();
      expect(
        new CodespaceResourceRepository(value.sqlite).rebindAuthorization({
          userId: "user-1",
          resourceId: "codespace-1",
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

  test("returns the observed output when a concurrent reconcile completes the same operation first", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["printf", "result"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      value.transport.executeResult = execResult({
        state: "succeeded",
        stdout: "raced result",
        stderr: "",
        exitCode: 0,
      });

      // The background reconciler stores the identical outcome while this caller is still
      // inspecting, so the caller's own write finds the row already terminal.
      let background: Promise<boolean> | null = null;
      value.transport.inspectObservation = () => {
        value.transport.inspectObservation = null;
        background = value.service.reconcileOnce("user-1");
        return background;
      };

      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toEqual(
        execResult({
          state: "succeeded",
          stdout: "raced result",
          stderr: "",
          exitCode: 0,
        }),
      );
      await expect(background!).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", started.operation.id)).toMatchObject({
        state: "succeeded",
        outputBytes: "raced result".length,
        remoteCleanupPending: 1,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps a background-observed terminal result available until its bounded cleanup deadline", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["printf", "result"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      value.transport.executeResult = execResult({
        state: "succeeded",
        stdout: "background result",
        stderr: "background warning",
        exitCode: 0,
      });

      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", started.operation.id)).toMatchObject({
        state: "succeeded",
        remoteCleanupPending: 1,
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(false);
      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toEqual(
        execResult({
          state: "succeeded",
          stdout: "background result",
          stderr: "background warning",
          exitCode: 0,
        }),
      );
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
        resourceId: "codespace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 1_000,
        policy,
        now,
      });
      expect(reserved.operation).toMatchObject({ state: "reserved" });
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_OPERATION_BUSY" });

      value.advance(1_001);
      await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
      expect(value.repository.getOwned("user-1", reserved.operation!.id)).toMatchObject({
        state: "cancelled",
        lastOutcome: "reservation_expired_before_dispatch",
        remoteCleanupPending: 0,
      });
      const replacement = value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
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
      let observed: ReturnType<CodespaceOperationRepository["getOwned"]> = null;
      value.transport.executeResult = { state: "running" };
      value.transport.executeObservation = () => {
        observed = value.repository.listOwned("user-1", "codespace-1")[0] ?? null;
      };
      const result = await value.service.execute("user-1", "codespace-1", {
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
        resourceId: "codespace-1",
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
      const restarted = new CodespaceOperationService({
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
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects an unbounded codespace-relative cwd before reservation", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          cwd: "a".repeat(4097),
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      expect(value.repository.listOwned("user-1", "codespace-1")).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects cross-tenant codespace access before credential or transport contact", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-2", "codespace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_FOUND" });
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
      const first = await value.service.execute("user-1", "codespace-1", {
        argv: ["long-running-command"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      expect(first.operation.state).toBe("reconcile_pending");
      await expect(
        value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          cwd: ".",
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_OPERATION_BUSY" });

      const resourceRepository = new CodespaceResourceRepository(value.sqlite);
      const stopped = resourceRepository.requestStop("user-1", "codespace-1", now + 1);
      expect(stopped).toMatchObject({ state: "stop_pending", generation: 2 });
      expect(value.repository.getOwned("user-1", first.operation.id)?.state).toBe("cancel_pending");
    } finally {
      value.sqlite.close();
    }
  });

  test("allows the official tunnel to restore an externally stopped codespace only under current running authority", async () => {
    const value = fixture();
    try {
      value.sqlite
        .prepare(
          `UPDATE codespaceResource SET observedState = 'stopped',
           lastOutcome = 'provider_observed_stopped' WHERE id = 'codespace-1'`,
        )
        .run();
      const result = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1_000,
      });
      expect(result.operation.state).toBe("succeeded");
      expect(
        value.sqlite
          .prepare(
            "SELECT observedState, lastOutcome FROM codespaceResource WHERE id = 'codespace-1'",
          )
          .get(),
      ).toEqual({ observedState: "running", lastOutcome: "connector_observed_running" });
    } finally {
      value.sqlite.close();
    }
  });

  test("fences dispatch when the kill switch wins after reservation", async () => {
    const value = fixture();
    try {
      const resourceRepository = new CodespaceResourceRepository(value.sqlite);
      const service = new CodespaceOperationService({
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
        service.execute("user-1", "codespace-1", {
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
      const running = await value.service.execute("user-1", "codespace-1", {
        argv: ["sleep", "30"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 30_000,
      });
      expect(running.operation.state).toBe("running");
      const pending = await value.service.cancel("user-1", running.operation.id);
      expect(pending.operation.state).toBe("cancel_pending");

      value.transport.cancelResult = execResult({
        state: "cancelled",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
      const terminal = await value.service.cancel("user-1", running.operation.id);
      expect(terminal.operation.state).toBe("cancelled");
      expect(terminal.result?.state).toBe("cancelled");
      expect(value.transport.cancelCalls).toHaveBeenCalledTimes(2);
    } finally {
      value.sqlite.close();
    }
  });

  test("fences a successful result when a concurrent stop advances the codespace generation", async () => {
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
      const executing = value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5_000,
      });
      await enteredExecute;
      new CodespaceResourceRepository(value.sqlite).requestStop("user-1", "codespace-1", now + 1);
      releaseExecute();
      await expect(executing).resolves.toMatchObject({
        operation: { state: "cancelled", remoteCleanupPending: 1 },
        result: { state: "cancelled" },
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      await expect(
        value.service.reconcile(
          "user-1",
          value.repository.listOwned("user-1", "codespace-1")[0]!.id,
        ),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(value.transport.inspectCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("starts a sleeping codespace for the command that needs it and refuses when it cannot", async () => {
    const value = fixture();
    const command = {
      argv: ["pwd"],
      cwd: ".",
      stdin: { kind: "inline" as const, bytes: new Uint8Array() },
      timeoutMs: 1000,
    };
    try {
      const sleep = () =>
        value.sqlite
          .prepare("UPDATE codespaceResource SET state = 'stopped', desiredState = 'stopped'")
          .run();

      // Without a lifecycle authority the same sleeping codespace refuses, which is what separates
      // "the command woke it" from "it was awake all along".
      sleep();
      const withoutLifecycle = new CodespaceOperationService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
      });
      await expect(
        withoutLifecycle.execute("user-1", "codespace-1", command),
      ).rejects.toMatchObject({ code: "CODESPACE_NOT_RUNNING" });
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();

      const response = await value.service.execute("user-1", "codespace-1", command);

      expect(response.result).toMatchObject({ state: "succeeded" });
      expect(value.lifecycle.calls).toEqual(["codespace-1"]);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(
        value.sqlite.prepare("SELECT state FROM codespaceResource WHERE id = 'codespace-1'").get(),
      ).toEqual({ state: "usable" });

      // A codespace that is awake is not woken again for the next command.
      await value.service.execute("user-1", "codespace-1", command);
      expect(value.lifecycle.calls).toEqual(["codespace-1"]);

      // A codespace that does not become usable in time refuses with that, and the refusal holds no
      // capacity: no operation row is left behind for it.
      sleep();
      const before = value.repository.listOwned("user-1", "codespace-1").length;
      value.lifecycle.refusal = new CodespaceResourceError(
        "CODESPACE_START_TIMEOUT",
        "Codespace did not become usable in time",
        "The codespace was started but was not usable within 180 seconds",
      );
      await expect(value.service.execute("user-1", "codespace-1", command)).rejects.toMatchObject({
        code: "CODESPACE_START_TIMEOUT",
      });
      expect(value.repository.listOwned("user-1", "codespace-1").length).toBe(before);
    } finally {
      value.sqlite.close();
    }
  });

  test("names a command lost to a codespace restart instead of reporting its own failure", async () => {
    const value = fixture();
    try {
      value.transport.executeResult = { state: "running" };
      const response = await value.service.execute("user-1", "codespace-1", {
        argv: ["sleep", "300"],
        cwd: ".",
        stdin: { kind: "inline" as const, bytes: new Uint8Array() },
        background: true,
      });
      const operationId = response.operation.id;

      // The codespace restarted: the operation's directory survived, its process did not.
      value.transport.inspectResult = { state: "interrupted" };
      const result = await value.service.reconcile("user-1", operationId);

      expect(result).toMatchObject({ state: "failed", exitCode: null });
      const stored = value.service.get("user-1", operationId)!;
      expect(stored.state).toBe("failed");
      // The recorded reason is what a later read uses to tell a restart from a cancellation the
      // caller asked for and from a command that failed on its own.
      expect(stored.lastOutcome).toBe("codespace_restarted");
    } finally {
      value.sqlite.close();
    }
  });

  test("a token refresh between reservation and dispatch keeps the operation dispatchable", async () => {
    // A refresh advances the connection generation while a reservation holds the old one; it must
    // carry the codespace and the reservation along, or the command is cancelled as unauthorized.
    const value = fixture();
    try {
      value.sqlite
        .prepare(
          `INSERT INTO codespaceCredentialVault
           (connectionId, envelopeVersion, keyVersion, iv, authTag, ciphertext, generation, updatedAt)
           VALUES ('connection-1', 2, 'v1', 'iv', 'tag', 'old', 1, ?)`,
        )
        .run(now);
      const connections = new CodespaceConnectionRepository(value.sqlite);
      value.credentials.getCredential.mockImplementationOnce(async () => {
        expect(
          connections.claimRefresh({
            userId: "user-1",
            connectionId: "connection-1",
            expectedGeneration: 1,
            leaseId: "lease-1",
            now,
            leaseExpiresAt: now + 60_000,
          }),
        ).toBe(true);
        expect(
          connections.completeRefresh({
            userId: "user-1",
            connectionId: "connection-1",
            leaseId: "lease-1",
            expectedGeneration: 1,
            envelope: {
              envelopeVersion: 2,
              keyVersion: "v1",
              iv: "iv",
              authTag: "tag",
              ciphertext: "new",
              generation: 2,
            },
            now,
          }),
        ).toBe(true);
        return "ghu_refreshed";
      });

      const response = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(response.operation).toMatchObject({ state: "succeeded", authorizationGeneration: 2 });
    } finally {
      value.sqlite.close();
    }
  });
});
