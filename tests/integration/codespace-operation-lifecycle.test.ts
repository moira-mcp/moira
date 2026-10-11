import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CodespaceJobTransport } from "../../packages/web-backend/src/services/codespace-job-transport.js";
import { effectiveCodespaceLimits } from "../../packages/shared/src/codespaces/resource-policy.js";
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
  type CodespaceResourceRecord,
  type CodespaceOperationRecord,
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

/** Exercise the production job decoder and supervisor in an isolated owned test repository. */
function supervisorTransport(
  root: string,
  loseExecuteReply = false,
  beforeExecute?: () => Promise<void>,
) {
  let lostReply!: () => void;
  const executeReplyLost = new Promise<void>((done) => {
    lostReply = done;
  });
  let executeClosed!: () => void;
  const executeObserved = new Promise<void>((done) => {
    executeClosed = done;
  });
  const repositoryRoot = path.join(root, "repos", "repository");
  mkdirSync(repositoryRoot, { recursive: true });
  execFileSync("git", ["init", "--quiet", repositoryRoot]);
  execFileSync("git", [
    "-C",
    repositoryRoot,
    "remote",
    "add",
    "origin",
    "https://github.com/owner/repository.git",
  ]);
  const supervisor = pathToFileURL(
    path.resolve("packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs"),
  ).href;
  const script = `import {runRequest} from ${JSON.stringify(supervisor)};let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify(await runRequest(JSON.parse(input))));`;
  class TestGuestTransport extends CodespaceJobTransport {
    async health() {
      return { ok: true, reason: null };
    }
    protected async sendJob(
      _credential: string,
      _resource: CodespaceResourceRecord,
      _operation: CodespaceOperationRecord,
      job: Record<string, unknown>,
    ) {
      if (job.action === "execute") await beforeExecute?.();
      const result = await new Promise<Record<string, unknown>>((done, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            MOIRA_OPERATION_STATE_DIR: path.join(root, "state"),
            MOIRA_CODESPACES_ROOT: path.join(root, "repos"),
            MOIRA_ENVIRONMENT_ID: "test-life",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [],
          stderr: Buffer[] = [];
        child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
        child.once("error", reject);
        child.once("close", (code) => {
          if (job.action === "execute") executeClosed();
          if (code !== 0) reject(new Error(Buffer.concat(stderr).toString("utf8")));
          else {
            try {
              done(JSON.parse(Buffer.concat(stdout).toString("utf8")));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.stdin.end(JSON.stringify(job));
      });
      if (loseExecuteReply && job.action === "execute") {
        loseExecuteReply = false;
        lostReply();
        throw new Error("Controlled lost guest acceptance reply");
      }
      return result;
    }
  }
  return { transport: new TestGuestTransport(), repositoryRoot, executeReplyLost, executeObserved };
}

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

  async finalize(
    _credential: string,
    _codespace: CodespaceResourceRecord,
    _operation: CodespaceOperationRecord,
  ) {
    this.finalizeCalls();
    if (this.throwFinalize) throw new Error("remote cleanup unavailable");
  }
}

function fixture(advanceOnDelay = false) {
  const sqlite = new Database(":memory:");
  const transferRoot = mkdtempSync(path.join(tmpdir(), "moira-operation-control-"));
  const close = sqlite.close.bind(sqlite);
  sqlite.close = () => {
    rmSync(transferRoot, { recursive: true, force: true });
    return close();
  };
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
  const transfers = new CodespaceTransferService({
    repository: new CodespaceTransferRepository(sqlite),
    root: transferRoot,
    policy: () => policy,
    now: () => currentNow,
  });
  const service = new CodespaceOperationService({
    repository,
    transport,
    credentials,
    lifecycle,
    policy: () => policy,
    transfers,
    now: () => currentNow,
    delay: async (milliseconds) => {
      settleDelays.push(milliseconds);
      if (advanceOnDelay) currentNow += milliseconds;
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
    transfers,
    transferRoot,
    lifecycle,
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

describe("durable direct codespace operations", () => {
  test("confirmed cancellation before delayed guest execute prevents its effect under the same accepted identity", async () => {
    const value = fixture();
    value.advance(Date.now() - now);
    const root = mkdtempSync(path.join(tmpdir(), "moira-cancel-before-delivery-"));
    let entered!: () => void, release!: () => void;
    const delivering = new Promise<void>((done) => {
      entered = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const guest = supervisorTransport(root, false, async () => {
      entered();
      await gate;
    });
    const service = new CodespaceOperationService({
      repository: value.repository,
      transport: guest.transport,
      credentials: value.credentials,
      policy: () => policy,
      transfers: value.transfers,
      now: Date.now,
    });
    let operationId: string | undefined;
    try {
      const accepted = await service.execute("user-1", "codespace-1", {
        requestId: randomUUID(),
        argv: [
          process.execPath,
          "-e",
          "require('node:fs').appendFileSync('cancelled-effect.txt','x')",
        ],
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      operationId = accepted.operation.id;
      await delivering;
      const cancelled = await service.cancel("user-1", operationId);
      expect(cancelled).toMatchObject({
        operation: {
          id: operationId,
          state: "cancelled",
          startedAt: null,
          lastOutcome: "cancelled_before_start_not_started",
        },
        result: { state: "cancelled", exitCode: null },
      });
      release();
      await guest.executeObserved;
      const current = value.repository.getOwned("user-1", operationId)!;
      const resource = value.repository.getContext("user-1", operationId)!.codespace;
      await expect(guest.transport.inspect("test", resource, current)).resolves.toMatchObject({
        state: "not_started",
        requestDigest: current.requestDigest,
      });
      expect(() => readFileSync(path.join(guest.repositoryRoot, "cancelled-effect.txt"))).toThrow(
        expect.objectContaining({ code: "ENOENT" }),
      );
      await expect(
        service.lookupRequest("user-1", current.resourceId, current.requestId!),
      ).resolves.toMatchObject({ operation: { state: "cancelled", startedAt: null } });
    } finally {
      release();
      if (operationId) {
        await guest.executeObserved;
        const context = value.repository.getContext("user-1", operationId)!;
        await guest.transport.cancel("test", context.codespace, context.operation);
      }
      await new Promise<void>((done) => setImmediate(done));
      service.stop();
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("terminal start metadata refuses a contradictory receipt while exact existing proof remains replayable", () => {
    const value = fixture();
    const reserve = () =>
      value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 60_000,
        requestId: randomUUID(),
        requestDigest: "b".repeat(64),
        runtimeMs: 1000,
        policy,
        now,
      }).operation!;
    try {
      const negative = reserve();
      value.repository.complete(
        "user-1",
        negative.id,
        execResult({ state: "cancelled", stdout: "", stderr: "", exitCode: null }),
        1024,
        512,
        now + 60_000,
        now,
        "admission_expired_not_started",
      );
      const before = value.repository.getOwned("user-1", negative.id);
      expect(
        value.repository.recordStarted(
          "user-1",
          negative.id,
          now,
          1000,
          negative.requestDigest!,
          now + 1,
        ),
      ).toBe(false);
      expect(value.repository.getOwned("user-1", negative.id)).toEqual(before);
      const positive = reserve();
      expect(
        value.repository.recordStarted(
          "user-1",
          positive.id,
          now,
          1000,
          positive.requestDigest!,
          now,
        ),
      ).toBe(true);
      value.repository.complete(
        "user-1",
        positive.id,
        execResult({ state: "succeeded", stdout: "receipt", stderr: "", exitCode: 0 }),
        1024,
        512,
        now + 60_000,
        now,
      );
      expect(
        value.repository.recordStarted(
          "user-1",
          positive.id,
          now,
          1000,
          positive.requestDigest!,
          now + 1,
        ),
      ).toBe(true);
      expect(value.repository.getOwned("user-1", positive.id)).toMatchObject({
        state: "succeeded",
        startedAt: now,
        runtimeMs: 1000,
        deadlineAt: now + 1000,
        outputBytes: 7,
        exitCode: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });
  test("due backlog and dispatch selection agree for durable input blocked by an earlier explicit session", async () => {
    const value = fixture();
    const expanded = {
      ...policy,
      maxConcurrentOperationsPerUser: 3,
      maxConcurrentOperationsGlobal: 4,
    };
    try {
      const operations = [];
      for (let index = 0; index < 2; index++) {
        const reserved = value.repository.reserve({
          userId: "user-1",
          resourceId: "codespace-1",
          inputBytes: 0,
          stdoutLimitBytes: 1024,
          stderrLimitBytes: 512,
          deadlineAt: now + 60_000,
          requestId: randomUUID(),
          requestDigest: "a".repeat(64),
          runtimeMs: 1000,
          sessionKey: "explicit-session",
          policy: expanded,
          now,
        });
        const input = await value.transfers.retainRelayPayload(
          "user-1",
          "operation_input",
          Buffer.from("{}"),
        );
        expect(
          value.repository.attachInput(
            "user-1",
            reserved.operation!.id,
            JSON.stringify(input),
            now,
          ),
        ).toBe(true);
        operations.push(reserved.operation!);
      }
      expect(value.repository.dueSummary(now)).toEqual({ count: 1, oldestUpdatedAt: now });
      expect(value.repository.claimDue("first-owner", now, now + 1000)?.id).toBe(operations[0].id);
      expect(value.repository.claimDue("other-owner", now, now + 1000)).toBeNull();
      value.repository.complete(
        "user-1",
        operations[0].id,
        execResult({ state: "succeeded", stdout: "", stderr: "", exitCode: 0 }),
        1024,
        512,
        now + 60_000,
        now,
      );
      expect(value.repository.dueSummary(now)).toEqual({ count: 1, oldestUpdatedAt: now });
      expect(value.repository.claimDue("second-owner", now, now + 1000)?.id).toBe(operations[1].id);
    } finally {
      value.sqlite.close();
    }
  });
  test("private accepted input uses bounded control quotas independently of native file object counts", async () => {
    const value = fixture();
    const transfers = new CodespaceTransferRepository(value.sqlite);
    const reserve = (purpose: "codespace_input" | "operation_input") =>
      transfers.reserve({
        userId: "user-1",
        purpose,
        fileName: "private.bin",
        mimeType: "application/octet-stream",
        declaredSize: 1,
        ownerPid: process.pid,
        ownerStartTime: null,
        policy,
        now,
      });
    try {
      for (
        let index = 0;
        index < effectiveCodespaceLimits(policy).transfers.maxObjectsPerUser;
        index++
      )
        expect(reserve("codespace_input")).not.toBeNull();
      expect(reserve("codespace_input")).toBeNull();
      const internal = Array.from(
        { length: effectiveCodespaceLimits(policy).relayTransfers.maxObjectsPerUser },
        () => reserve("operation_input"),
      );
      expect(internal.every(Boolean)).toBe(true);
      expect(reserve("operation_input")).toBeNull();
      const request = {
        requestId: randomUUID(),
        argv: ["must-not-run"],
        stdin: { kind: "inline" as const, bytes: new Uint8Array() },
      };
      await expect(value.service.execute("user-1", "codespace-1", request)).rejects.toMatchObject({
        code: "CODESPACE_POLICY_LIMIT",
      });
      expect(value.repository.getByRequest("user-1", request.requestId)).toMatchObject({
        state: "reserved",
        inputReference: null,
      });
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
      expect(
        value.sqlite
          .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE purpose='operation_input'")
          .get(),
      ).toEqual({ count: internal.length });
    } finally {
      value.sqlite.close();
    }
  });

  test("changed caller payload and corrupt durable terminal bytes never repeat the accepted effect", async () => {
    const value = fixture();
    const effect = path.join(value.transferRoot, "effect.txt");
    const request = {
      requestId: randomUUID(),
      argv: ["append"],
      stdin: { kind: "inline" as const, bytes: new Uint8Array() },
    };
    value.transport.execute = async (_credential, _resource, _operation, submitted) => {
      appendFileSync(effect, "one");
      return {
        ...execResult({ state: "succeeded", stdout: "receipt", stderr: "", exitCode: 0 }),
        requestDigest: submitted.requestDigest,
        startedAt: now,
      };
    };
    try {
      const accepted = await value.service.execute("user-1", "codespace-1", request);
      const terminal = await value.service.waitForResult("user-1", accepted.operation.id);
      expect(terminal.result?.stdout).toBe("receipt");
      await expect(
        value.service.execute("user-1", "codespace-1", { ...request, argv: ["changed"] }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      const reference = JSON.parse(terminal.operation.resultReference!);
      const row = value.sqlite
        .prepare("SELECT objectKey FROM codespaceTransfer WHERE id=?")
        .get(reference.parts[0].transferId) as { objectKey: string };
      writeFileSync(
        path.join(value.transferRoot, row.objectKey),
        Buffer.alloc(reference.parts[0].size, 120),
      );
      await expect(
        value.service.lookupRequest("user-1", "codespace-1", request.requestId),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      expect(readFileSync(effect, "utf8")).toBe("one");
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("historical IDs collect real guest output after server upgrade without another execution", async () => {
    const value = fixture();
    value.advance(Date.now() - now);
    const root = mkdtempSync(path.join(tmpdir(), "moira-historical-guest-"));
    const guest = supervisorTransport(root);
    const common = {
      repository: value.repository,
      transport: guest.transport,
      credentials: value.credentials,
      policy: () => policy,
      transfers: value.transfers,
      now: Date.now,
    };
    try {
      const previous = await new CodespaceOperationService(common).execute(
        "user-1",
        "codespace-1",
        {
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').appendFileSync('legacy-effect.txt',String.fromCharCode(111,110,99,101,10));process.stdout.write('historical receipt')",
          ],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 2000,
        },
      );
      // Old rows retain guest bytes, not a newly invented server output reference or caller ID.
      value.sqlite
        .prepare("UPDATE codespaceOperation SET resultReference=NULL WHERE id=?")
        .run(previous.operation.id);
      const upgraded = new CodespaceOperationService(common);
      const collected = await upgraded.reconcile("user-1", previous.operation.id);
      expect(collected).toMatchObject({ stdout: "historical receipt", exitCode: 0 });
      expect(value.repository.getOwned("user-1", previous.operation.id)).toMatchObject({
        requestId: null,
        remoteMarker: previous.operation.remoteMarker,
      });
      expect(readFileSync(path.join(guest.repositoryRoot, "legacy-effect.txt"), "utf8")).toBe(
        "once\n",
      );
    } finally {
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("native stdin remains durable after consumption and lost guest ACK without refetch or duplicate effect", async () => {
    const value = fixture();
    value.advance(Date.now() - now);
    const root = mkdtempSync(path.join(tmpdir(), "moira-durable-native-guest-"));
    const guest = supervisorTransport(root, true);
    const bytes = Buffer.from([0, 255, 128, 17, 0, 65]);
    const common = {
      repository: value.repository,
      transport: guest.transport,
      credentials: value.credentials,
      policy: () => policy,
      transfers: value.transfers,
      now: Date.now,
    };
    const service = new CodespaceOperationService({
      ...common,
      nativeFetcher: {
        fetch: async () => ({
          contentLength: bytes.length,
          mimeType: "application/octet-stream",
          body: (async function* () {
            yield bytes;
          })(),
        }),
      },
    });
    let operationId: string | undefined;
    try {
      const accepted = await service.executeNativeReference(
        "user-1",
        "codespace-1",
        {
          requestId: randomUUID(),
          argv: [
            process.execPath,
            "-e",
            "const fs=require('node:fs');let chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{const bytes=Buffer.concat(chunks);fs.appendFileSync('native-effect.bin',bytes);process.stdout.write(bytes.toString('hex'));const timer=setInterval(()=>{if(fs.existsSync('native-release'))clearInterval(timer)},10)})",
          ],
          timeoutMs: 5000,
        },
        {
          fileId: "file_durableNative",
          downloadUrl: "https://native.example.test/private",
          declaredSize: bytes.length,
          mimeType: "application/octet-stream",
        },
      );
      operationId = accepted.operation.id;
      await guest.executeReplyLost;
      await new Promise<void>((done) => setImmediate(done));
      const recovered = new CodespaceOperationService(common);
      await recovered.reconcile("user-1", accepted.operation.id);
      expect(value.repository.getOwned("user-1", accepted.operation.id)).toMatchObject({
        state: "running",
        startedAt: expect.any(Number),
      });
      writeFileSync(path.join(guest.repositoryRoot, "native-release"), "release");
      const result = await recovered.waitForResult("user-1", accepted.operation.id);
      expect(result.result).toMatchObject({ stdout: bytes.toString("hex"), exitCode: 0 });
      expect(readFileSync(path.join(guest.repositoryRoot, "native-effect.bin"))).toEqual(bytes);
      expect(
        value.sqlite
          .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE purpose='codespace_input'")
          .get(),
      ).toEqual({ count: 0 });
      const current = value.repository.getOwned("user-1", accepted.operation.id)!;
      const persisted = await value.transfers.readRelayPayload(
        "user-1",
        "operation_input",
        JSON.parse(current.inputReference!),
      );
      expect(JSON.parse(persisted.toString("utf8")).request.stdin.bytesBase64).toBe(
        bytes.toString("base64"),
      );
      expect(current.startedAt).toBeGreaterThan(0);
      const resource = value.repository.getContext("user-1", current.id)!.codespace;
      await expect(guest.transport.finalize("test", resource, current)).rejects.toThrow(
        "Remote operation cleanup is incomplete",
      );
      await expect(guest.transport.inspect("test", resource, current)).resolves.toMatchObject({
        state: "outcome_unknown",
        requestDigest: current.requestDigest,
        startedAt: current.startedAt,
      });
      await expect(
        guest.transport.readOutput("test", resource, current, {
          stream: "stdout",
          offset: 0,
          length: 1,
        }),
      ).resolves.toEqual({ state: "absent" });
      // Bytes are gone, while immutable launch authority stays fenced until original admission closes.
      // The bounded cloud reply remains independent of that retained guest marker.
      await expect(
        recovered.lookupRequest("user-1", current.resourceId, current.requestId!),
      ).resolves.toMatchObject({ result: { stdout: bytes.toString("hex") } });
    } finally {
      service.stop();
      if (operationId) {
        const context = value.repository.getContext("user-1", operationId)!;
        await guest.transport.cancel("test", context.codespace, context.operation);
      }
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test.each(["exec", "file", "cleanup"] as const)(
    "held %s recovery across repeated claim expiries leaves independent effects runnable",
    async (kind) => {
      const value = fixture();
      const root = mkdtempSync(path.join(tmpdir(), "moira-fair-operation-recovery-"));
      const effect = path.join(root, "effects.txt");
      const expanded = {
        ...policy,
        maxConcurrentOperationsPerUser: 12,
        maxConcurrentOperationsGlobal: 16,
      };
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let entered!: () => void;
      const inspecting = new Promise<void>((done) => {
        entered = done;
      });
      let effectsDone!: () => void;
      const completedEffects = new Promise<void>((done) => {
        effectsDone = done;
      });
      let effects = 0;
      let clock = now;
      const reserved = value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
        inputBytes: 0,
        stdoutLimitBytes: 1024,
        stderrLimitBytes: 512,
        deadlineAt: now + 60_000,
        kind: kind === "file" ? "stat" : "exec",
        policy: expanded,
        now,
      });
      value.repository.beginDispatch("user-1", reserved.operation!.id, "first", now + 1000, now);
      value.repository.markRunning("user-1", reserved.operation!.id, now);
      if (kind === "cleanup")
        value.repository.complete(
          "user-1",
          reserved.operation!.id,
          execResult({ state: "succeeded", stdout: "", stderr: "", exitCode: 0 }),
          1024,
          512,
          now - 1,
          now,
        );
      value.transport.inspect = async (_credential, _resource, operation) => {
        if (operation.id === reserved.operation!.id) {
          entered();
          await held;
        }
        return {
          state: "running",
          ...(operation.requestDigest
            ? { requestDigest: operation.requestDigest, startedAt: now }
            : {}),
        };
      };
      value.transport.execute = async (_credential, _resource, _operation, request) => {
        appendFileSync(effect, `${request.argv![1]}\n`);
        if (++effects === 6) effectsDone();
        return {
          ...execResult({ state: "succeeded", stdout: "done", stderr: "", exitCode: 0 }),
          startedAt: clock,
          requestDigest: request.requestDigest,
        };
      };
      const transport = Object.assign(value.transport, {
        inspectFile: async () => {
          entered();
          await held;
          return { state: "running" as const };
        },
      });
      transport.finalize = async (_credential, _resource, operation) => {
        if (operation.id === reserved.operation!.id) {
          entered();
          await held;
        }
      };
      const service = new CodespaceOperationService({
        repository: value.repository,
        transport,
        credentials: value.credentials,
        transfers: value.transfers,
        policy: () => expanded,
        now: () => clock,
      });
      const scheduled = jest.spyOn(global, "setInterval");
      try {
        service.start();
        const tick = scheduled.mock.calls[0]![0] as () => void;
        scheduled.mockRestore();
        await inspecting;
        // Run the real scheduled callback after each persisted claim expires while
        // no independent request exists yet. Duplicate contacts can otherwise fill all slots.
        for (let expiry = 0; expiry < 3; expiry++) {
          clock += policy.claimLeaseMs + 1;
          tick();
          await new Promise<void>((done) => setImmediate(done));
        }
        const requests = Array.from({ length: 6 }, (_entry, index) => ({
          requestId: randomUUID(),
          argv: ["append", String(index)],
          stdin: { kind: "inline" as const, bytes: new Uint8Array() },
        }));
        const accepted = await Promise.all(
          requests.map((request) => service.execute("user-1", "codespace-1", request)),
        );
        // Completion must continue without a lookup polling the scheduler or releasing the held job.
        await Promise.race([
          completedEffects,
          new Promise<never>((_done, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Free recovery slots did not drain accepted work")),
              2000,
            );
            completedEffects.then(() => clearTimeout(timer));
          }),
        ]);
        const results = await Promise.all(
          accepted.map((entry) => service.waitForResult("user-1", entry.operation.id)),
        );
        expect(results.every((entry) => entry.result?.exitCode === 0)).toBe(true);
        expect(readFileSync(effect, "utf8").trim().split("\n").sort()).toEqual([
          "0",
          "1",
          "2",
          "3",
          "4",
          "5",
        ]);
        expect(value.repository.getOwned("user-1", reserved.operation!.id)?.state).toBe(
          kind === "cleanup" ? "succeeded" : "running",
        );
      } finally {
        scheduled.mockRestore();
        service.stop();
        release();
        await new Promise<void>((done) => setImmediate(done));
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("collection after runtime expiry does not cause the cancellation effect", async () => {
    const value = fixture();
    const root = mkdtempSync(path.join(tmpdir(), "moira-pure-collection-"));
    const cancelled = path.join(root, "cancelled.txt");
    value.transport.executeResult = { state: "running" };
    value.transport.inspectResult = { state: "running" };
    value.transport.cancel = async () => {
      appendFileSync(cancelled, "cancel-effect\n");
      return execResult({ state: "cancelled", stdout: "", stderr: "", exitCode: null });
    };
    try {
      const accepted = await value.service.execute("user-1", "codespace-1", {
        argv: ["long-command"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      value.advance(2000);
      const collected = await value.service.waitForResult("user-1", accepted.operation.id, 0);
      expect(collected.operation.state).toBe("running");
      expect(value.repository.getOwned("user-1", accepted.operation.id)?.state).toBe("running");
      expect(() => readFileSync(cancelled)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      value.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("bounded collection rejects revoked authority while an inspection remains pending without cancellation", async () => {
    const value = fixture();
    const reserved = value.repository.reserve({
      userId: "user-1",
      resourceId: "codespace-1",
      inputBytes: 0,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 512,
      deadlineAt: now + 60_000,
      policy,
      now,
    });
    value.repository.beginDispatch("user-1", reserved.operation!.id, "original", now + 1000, now);
    value.repository.markRunning("user-1", reserved.operation!.id, now);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const inspecting = new Promise<void>((done) => {
      entered = done;
    });
    value.transport.inspect = async () => {
      entered();
      await gate;
      return { state: "running" };
    };
    try {
      const waiting = value.service.waitForResult("user-1", reserved.operation!.id, 20);
      await inspecting;
      value.sqlite.exec("DELETE FROM codespaceConnectionRepository");
      await expect(waiting).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(value.transport.cancelCalls).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      release();
      await new Promise<void>((done) => setImmediate(done));
      value.sqlite.close();
    }
  });
  test.each(["ABCDEFAB-0000-7000-8000-000000000031", "ABCDEFAB-0000-8000-8000-000000000032"])(
    "concurrent matching UUID submissions and a lost first reply resume one caller-identified effect after service restart (%s)",
    async (requestId) => {
      const value = fixture();
      const root = mkdtempSync(path.join(tmpdir(), "moira-lost-acceptance-"));
      const effect = path.join(root, "effect.txt");
      const request = {
        requestId,
        argv: ["append-once"],
        stdin: { kind: "inline" as const, bytes: new Uint8Array() },
        timeoutMs: 1000,
      };
      value.transport.execute = async (_credential, _resource, _operation, acceptedRequest) => {
        appendFileSync(effect, "accepted-effect\n");
        return {
          ...execResult({ state: "succeeded", stdout: "receipt", stderr: "", exitCode: 0 }),
          startedAt: now,
          requestDigest: acceptedRequest.requestDigest,
        };
      };
      try {
        // The caller receives no first response. A new service has no process-local replay cache.
        const concurrent = new CodespaceOperationService({
          repository: value.repository,
          transport: value.transport,
          credentials: value.credentials,
          policy: () => policy,
          transfers: value.transfers,
          now: () => now,
        });
        const [accepted, matching] = await Promise.all([
          value.service.execute("user-1", "codespace-1", request),
          concurrent.execute("user-1", "codespace-1", {
            ...request,
            requestId: requestId.toLowerCase(),
          }),
        ]);
        expect(matching.operation.id).toBe(accepted.operation.id);
        await value.service.waitForResult("user-1", accepted.operation.id);
        const restarted = new CodespaceOperationService({
          repository: value.repository,
          transport: value.transport,
          credentials: value.credentials,
          policy: () => policy,
          transfers: value.transfers,
          now: () => now,
          delay: async () => {},
        });
        const resumed = await restarted.execute("user-1", "codespace-1", request);
        expect(readFileSync(effect, "utf8")).toBe("accepted-effect\n");
        expect(resumed.result).toMatchObject({ stdout: "receipt", exitCode: 0 });
        await expect(
          restarted.lookupRequest("user-1", "codespace-1", requestId),
        ).resolves.toMatchObject({
          operation: { id: accepted.operation.id, requestId: requestId.toLowerCase() },
          result: { stdout: "receipt" },
        });
        expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
      } finally {
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  test.each(["resolved", "rejected"] as const)(
    "a stale predispatch worker with %s credentials cannot cancel reclaimed accepted work before its one effect",
    async (credentialOutcome) => {
      const value = fixture();
      const effect = path.join(value.transferRoot, "reclaimed-effect.txt");
      let firstEntered!: () => void,
        secondEntered!: () => void,
        releaseFirst!: () => void,
        releaseSecond!: () => void;
      const firstAtCredential = new Promise<void>((done) => {
        firstEntered = done;
      });
      const secondAtCredential = new Promise<void>((done) => {
        secondEntered = done;
      });
      const firstGate = new Promise<void>((done) => {
        releaseFirst = done;
      });
      const secondGate = new Promise<void>((done) => {
        releaseSecond = done;
      });
      let clock = now;
      const common = {
        repository: value.repository,
        transport: value.transport,
        transfers: value.transfers,
        policy: () => policy,
        now: () => clock,
      };
      const first = new CodespaceOperationService({
        ...common,
        credentials: {
          getCredential: async () => {
            firstEntered();
            await firstGate;
            if (credentialOutcome === "rejected")
              throw new Error("Controlled stale credential failure");
            return "test";
          },
        },
      });
      const second = new CodespaceOperationService({
        ...common,
        credentials: {
          getCredential: async () => {
            secondEntered();
            await secondGate;
            return "test";
          },
        },
      });
      value.transport.execute = async (_credential, _resource, _operation, request) => {
        appendFileSync(effect, "one");
        return {
          ...execResult({
            state: "succeeded",
            stdout: "reclaimed receipt",
            stderr: "",
            exitCode: 0,
          }),
          startedAt: clock,
          requestDigest: request.requestDigest,
        };
      };
      let reclaim: Promise<boolean> | undefined;
      try {
        const accepted = await first.execute("user-1", "codespace-1", {
          requestId: randomUUID(),
          argv: ["append"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
        });
        await firstAtCredential;
        expect(value.repository.dueSummary(clock).count).toBe(1);
        clock += policy.claimLeaseMs + 1;
        reclaim = second.reconcileOnce();
        await secondAtCredential;
        releaseFirst();
        await new Promise<void>((done) => setImmediate(done));
        releaseSecond();
        await reclaim;
        expect(readFileSync(effect, "utf8")).toBe("one");
        await expect(
          second.lookupRequest("user-1", "codespace-1", accepted.operation.requestId!),
        ).resolves.toMatchObject({
          operation: { id: accepted.operation.id, state: "succeeded" },
          result: { stdout: "reclaimed receipt" },
        });
      } finally {
        releaseFirst();
        releaseSecond();
        await reclaim;
        await new Promise<void>((done) => setImmediate(done));
        value.sqlite.close();
      }
    },
  );
  test("an uncertain typed command failure exposes its accepted operation and recovers without execution replay", async () => {
    const value = fixture();
    let executions = 0;
    try {
      value.transport.execute = async () => {
        executions++;
        throw new CodespaceResourceError(
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "Controlled lost response after admission",
        );
      };
      const failure = await value.service
        .execute("user-1", "codespace-1", {
          argv: ["command"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1000,
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
        { state: "succeeded", stdout: "ok" },
      );
      expect(executions).toBe(1);
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test.each(["CODESPACE_NOT_RUNNING", "CODESPACE_AUTHORIZATION_REQUIRED"] as const)(
    "returns proven pre-dispatch refusal %s without an ambiguous pending operation or retry",
    async (code) => {
      const value = fixture();
      let attempts = 0;
      try {
        value.transport.execute = async () => {
          attempts++;
          throw new CodespaceResourceError(
            code,
            "Controlled refusal before guest execution",
            undefined,
            true,
          );
        };
        await expect(
          value.service.execute("user-1", "codespace-1", {
            argv: ["command"],
            stdin: { kind: "inline", bytes: new Uint8Array() },
            timeoutMs: 1000,
          }),
        ).rejects.toMatchObject({ code });
        expect(value.repository.listOwned("user-1", "codespace-1")).toEqual([
          expect.objectContaining({
            state: "failed",
            remoteCleanupPending: 0,
            resultExpiresAt: null,
          }),
        ]);
        expect(attempts).toBe(1);
        expect(value.transport.inspectCalls).not.toHaveBeenCalled();
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each([
    "reservation",
    "credential refresh",
    "execution",
    "inspection",
    "retained output",
  ] as const)(
    "ordinary commands preserve their exact result after lifecycle changes during %s",
    async (boundary) => {
      const value = fixture();
      const advanceLifecycle = () =>
        value.sqlite.exec("UPDATE codespaceResource SET generation=generation+1");
      try {
        const service = new CodespaceOperationService({
          repository: value.repository,
          transport: value.transport,
          credentials: value.credentials,
          policy: () => policy,
          now: () => now,
          delay: async () => {},
          audit: (event) => {
            if (boundary === "reservation" && event.action === "reserve") advanceLifecycle();
          },
        });
        if (boundary === "credential refresh")
          value.credentials.getCredential.mockImplementationOnce(async () => {
            advanceLifecycle();
            return "ghu_access";
          });
        if (boundary === "execution") value.transport.executeObservation = advanceLifecycle;
        if (boundary === "inspection") {
          value.transport.executeResult = { state: "running" };
          value.transport.inspectResult = execResult({
            state: "succeeded",
            stdout: "exact result",
            stderr: "",
            exitCode: 0,
          });
          value.transport.inspectObservation = async () => {
            advanceLifecycle();
          };
        } else
          value.transport.executeResult = execResult({
            state: "succeeded",
            stdout: "exact result",
            stderr: "",
            exitCode: 0,
          });
        const completed = await service.execute("user-1", "codespace-1", {
          argv: ["command"],
          timeoutMs: 1000,
          stdin: { kind: "inline", bytes: new Uint8Array() },
        });
        expect(completed).toMatchObject({
          operation: { state: "succeeded" },
          result: { stdout: "exact result", exitCode: 0 },
        });
        if (boundary === "retained output") {
          value.sqlite.exec(
            "UPDATE codespaceResource SET generation=generation+1,state='stopped',desiredState='stopped'",
          );
          value.transport.outputResult = {
            stream: "stdout",
            offset: 0,
            totalBytes: 12,
            bytes: Buffer.from("exact result"),
          };
          await expect(
            service.readOutput("user-1", completed.operation.id, {
              stream: "stdout",
              offset: 0,
              length: 32,
            }),
          ).resolves.toMatchObject({ bytes: Buffer.from("exact result") });
        }
        expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
        expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("retained bounded results survive connector outage while new dispatch is refused before credentials", async () => {
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
      await expect(value.service.reconcile("user-1", started.operation.id)).resolves.toMatchObject({
        stdout: "ok",
        exitCode: 0,
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
    [
      "authorization generation",
      "UPDATE codespaceConnection SET credentialGeneration = 2",
      "CODESPACE_AUTHORIZATION_REQUIRED",
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

  test("expired client collection preserves running work until explicit cancellation is requested", async () => {
    const value = fixture(true);
    try {
      value.transport.executeResult = { state: "running" };
      value.transport.inspectResult = { state: "running" };
      value.transport.cancelResult = execResult({
        state: "cancelled",
        stdout: "partial",
        stderr: "",
        exitCode: null,
      });
      const accepted = await value.service.execute("user-1", "codespace-1", {
        argv: ["long-command"],
        timeoutMs: 5000,
        stdin: { kind: "inline", bytes: new Uint8Array() },
      });
      value.advance(5000);
      const collected = await value.service.waitForResult("user-1", accepted.operation.id, 0);
      expect(collected).toMatchObject({
        operation: { state: "running", id: accepted.operation.id },
        result: null,
      });
      const completed = await value.service.cancel("user-1", accepted.operation.id);
      expect(completed).toMatchObject({
        operation: { state: "cancelled", id: accepted.operation.id },
        result: { state: "cancelled", stdout: "partial" },
      });
      expect(value.transport.cancelCalls).toHaveBeenCalledTimes(1);
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("synchronous command waiting rechecks revoked authority after an awaited terminal inspection", async () => {
    const value = fixture(true);
    try {
      value.transport.executeResult = { state: "running" };
      const accepted = await value.service.execute("user-1", "codespace-1", {
        argv: ["command"],
        timeoutMs: 5000,
        stdin: { kind: "inline", bytes: new Uint8Array() },
      });
      value.transport.inspectResult = execResult({
        state: "succeeded",
        stdout: "private",
        stderr: "",
        exitCode: 0,
      });
      value.transport.inspectObservation = async () => {
        await Promise.resolve();
        value.sqlite.prepare("DELETE FROM codespaceConnectionRepository").run();
      };
      await expect(
        value.service.waitForResult("user-1", accepted.operation.id),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("opt-in synchronous waiting collects a command beyond the short HTTP settle window without another execution", async () => {
    const value = fixture(true);
    try {
      value.transport.executeResult = { state: "running" };
      value.transport.inspectObservation = async () => {
        if (value.settleDelays.reduce((sum, delay) => sum + delay, 0) >= 3000)
          value.transport.inspectResult = execResult({
            state: "succeeded",
            stdout: "late terminal result",
            stderr: "",
            exitCode: 0,
          });
      };
      const accepted = await value.service.execute("user-1", "codespace-1", {
        argv: ["build"],
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 5000,
      });
      expect(accepted).toMatchObject({ operation: { state: "running" }, result: null });
      const result = await value.service.waitForResult("user-1", accepted.operation.id);
      expect(result).toMatchObject({
        operation: { id: accepted.operation.id, state: "succeeded" },
        result: { stdout: "late terminal result", exitCode: 0 },
      });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
      expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test.each(["unknown", "revoked", "expired"] as const)(
    "bounded collection keeps %s outcome addressable and never repeats or cancels execution",
    async (failure) => {
      const value = fixture(true);
      try {
        value.transport.executeResult = { state: "running" };
        const accepted = await value.service.execute("user-1", "codespace-1", {
          argv: ["build"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 5000,
        });
        if (failure === "unknown") value.transport.throwInspect = true;
        if (failure === "revoked") value.sqlite.exec("DELETE FROM codespaceConnectionRepository");
        if (failure === "expired") value.advance(5000);
        const outcome = await value.service.waitForResult("user-1", accepted.operation.id, 0).then(
          (response) => ({ response }),
          (error) => ({ error }),
        );
        expect(outcome).toMatchObject(
          failure === "revoked"
            ? { error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" } }
            : {
                response: {
                  operation: {
                    id: accepted.operation.id,
                    state: failure === "unknown" ? "reconcile_pending" : "running",
                  },
                  result: null,
                },
              },
        );
        expect(value.transport.cancelCalls).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
        expect(value.repository.listOwned("user-1", "codespace-1")).toHaveLength(1);
      } finally {
        value.sqlite.close();
      }
    },
  );

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

  test.each(["private", "historical"] as const)(
    "zero-wait collection keeps terminal state coupled to its asynchronously read %s prefix",
    async (storage) => {
      const value = fixture();
      let release!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      try {
        const started = await value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1000,
        });
        expect(started.operation.state).toBe("succeeded");
        if (storage === "private") {
          const read = value.transfers.readRelayPayload.bind(value.transfers);
          value.transfers.readRelayPayload = async (...args) => {
            await gate;
            return read(...args);
          };
        } else {
          value.sqlite
            .prepare("UPDATE codespaceOperation SET resultReference = NULL WHERE id = ?")
            .run(started.operation.id);
          value.transport.inspectObservation = async () => {
            await gate;
          };
        }
        let settled = false;
        const collection = value.service.waitForResult("user-1", started.operation.id, 0);
        void collection.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        // Registered after collection's zero-wait boundary; any metadata-only response has settled.
        await new Promise<void>((done) => setTimeout(done, 0));
        expect(settled).toBe(false);
        release();
        await expect(collection).resolves.toMatchObject({
          operation: { state: "succeeded", id: started.operation.id },
          result: { stdout: "ok", exitCode: 0 },
        });
        expect(value.transport.cancelCalls).not.toHaveBeenCalled();
        expect(value.transport.inspectCalls).toHaveBeenCalledTimes(
          storage === "historical" ? 1 : 0,
        );
      } finally {
        release();
        value.sqlite.close();
      }
    },
  );

  test("rechecks revoked result authority after asynchronous private receipt read", async () => {
    const value = fixture();
    try {
      const started = await value.service.execute("user-1", "codespace-1", {
        argv: ["true"],
        cwd: ".",
        stdin: { kind: "inline", bytes: new Uint8Array() },
        timeoutMs: 1000,
      });
      const read = value.transfers.readRelayPayload.bind(value.transfers);
      value.transfers.readRelayPayload = async (...args) => {
        const bytes = await read(...args);
        value.sqlite.exec("DELETE FROM codespaceConnectionRepository");
        return bytes;
      };
      await expect(value.service.reconcile("user-1", started.operation.id)).rejects.toMatchObject({
        code: "CODESPACE_AUTHORIZATION_REQUIRED",
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
        expect(
          value.sqlite
            .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE purpose='codespace_input'")
            .get(),
        ).toEqual({
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
        expect(
          value.sqlite
            .prepare("SELECT COUNT(*) count FROM codespaceTransfer WHERE purpose='codespace_input'")
            .get(),
        ).toEqual({
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
      await expect(
        mismatchService.execute("user-1", "codespace-1", {
          argv: ["cat"],
          cwd: ".",
          stdin: {
            kind: "reference",
            referenceId: "codespace-file://size-mismatch",
            declaredBytes: 3,
            declaredMimeType: "application/octet-stream",
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      await expect(
        mismatchService.execute("user-1", "codespace-1", {
          argv: ["cat"],
          cwd: ".",
          stdin: {
            kind: "reference",
            referenceId: "codespace-file://mime-mismatch",
            declaredBytes: 4,
            declaredMimeType: "text/plain",
          },
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      expect(value.repository.listOwned("user-1", "codespace-1")).toEqual(
        Array.from({ length: 3 }, () =>
          expect.objectContaining({
            state: "cancelled",
            lastOutcome: "native_input_unavailable_before_dispatch",
            remoteCleanupPending: 0,
          }),
        ),
      );
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

  test.each(["reserved", "running", "cancel_pending", "reconcile_pending"] as const)(
    "a failed terminal cleanup cannot starve %s work",
    async (state) => {
      const value = fixture();
      try {
        const cleanup = await value.service.execute("user-1", "codespace-1", {
          argv: ["true"],
          stdin: { kind: "inline", bytes: new Uint8Array() },
          timeoutMs: 1000,
        });
        value.advance(1);
        const pending = value.repository.reserve({
          userId: "user-1",
          resourceId: "codespace-1",
          inputBytes: 0,
          stdoutLimitBytes: 1024,
          stderrLimitBytes: 512,
          deadlineAt: now + 1000,
          policy,
          now: now + 1,
        });
        expect(pending.outcome).toBe("reserved");
        if (state !== "reserved") {
          value.sqlite
            .prepare(
              "UPDATE codespaceOperation SET state=?,claimId=NULL,claimExpiresAt=NULL,deadlineAt=? WHERE id=?",
            )
            .run(state, now + 60_000, pending.operation!.id);
        }
        value.transport.throwFinalize = true;
        value.transport.inspectResult = execResult({
          state: "succeeded",
          stdout: "observed",
          stderr: "",
          exitCode: 0,
        });
        value.transport.cancelResult = execResult({
          state: "cancelled",
          stdout: "",
          stderr: "",
          exitCode: null,
        });
        value.advance(policy.cleanupDeadlineMs + 1);
        await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
        expect(value.repository.getOwned("user-1", cleanup.operation.id)).toMatchObject({
          state: "succeeded",
          remoteCleanupPending: 1,
          lastOutcome: "remote_cleanup_required",
        });
        value.advance(1);
        await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
        expect(value.repository.getOwned("user-1", pending.operation!.id)).toMatchObject({
          state: state === "reserved" || state === "cancel_pending" ? "cancelled" : "succeeded",
          claimId: null,
        });
        expect(value.repository.countActiveForUser("user-1")).toBe(0);
        expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(1);
        expect(value.transport.inspectCalls).toHaveBeenCalledTimes(
          state === "running" || state === "reconcile_pending" ? 1 : 0,
        );
        expect(value.transport.cancelCalls).toHaveBeenCalledTimes(
          state === "cancel_pending" ? 1 : 0,
        );
        value.advance(1);
        await expect(value.service.reconcileOnce("user-1")).resolves.toBe(true);
        expect(value.transport.finalizeCalls).toHaveBeenCalledTimes(2);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("a stale claim cannot release or overwrite a replacement reconciliation claim", () => {
    const value = fixture();
    try {
      const pending = value.repository.reserve({
        userId: "user-1",
        resourceId: "codespace-1",
        inputBytes: 0,
        stdoutLimitBytes: 0,
        stderrLimitBytes: 0,
        deadlineAt: now + 1000,
        policy,
        now,
      });
      const first = value.repository.claimDue("old-claim", now + 1000, now + 2000, "user-1");
      expect(first?.id).toBe(pending.operation!.id);
      expect(value.repository.claimDue("other-claim", now + 1001, now + 2001, "user-1")).toBeNull();
      const next = value.repository.claimDue("new-claim", now + 2000, now + 3000, "user-1");
      expect(next?.id).toBe(first!.id);
      expect(value.repository.releaseClaim(first!.id, "old-claim", "stale", now + 2001)).toBe(
        false,
      );
      expect(value.repository.getOwned("user-1", first!.id)).toMatchObject({
        claimId: "new-claim",
        claimExpiresAt: now + 3000,
        updatedAt: now + 2000,
      });
      expect(value.repository.releaseClaim(first!.id, "new-claim", "observed", now + 2002)).toBe(
        true,
      );
      expect(value.repository.getOwned("user-1", first!.id)).toMatchObject({
        claimId: null,
        claimExpiresAt: null,
        lastOutcome: "observed",
      });
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
      ).rejects.toMatchObject({ code: "CODESPACE_PROVIDER_DISABLED" });
      expect(value.repository.listOwned("user-1", "codespace-1")).toEqual([
        expect.objectContaining({ state: "cancelled", remoteCleanupPending: 0 }),
      ]);
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps historical cancellation pending on absence until a terminal receipt is confirmed", async () => {
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

      value.transport.cancelResult = { state: "absent" };
      const unknown = await value.service.cancel("user-1", running.operation.id);
      expect(unknown.operation.state).toBe("cancel_pending");
      expect(unknown.result).toBeNull();
      expect(unknown.operation.startedAt).toBeNull();

      value.transport.cancelResult = execResult({
        state: "cancelled",
        stdout: "",
        stderr: "",
        exitCode: null,
      });
      const terminal = await value.service.cancel("user-1", running.operation.id);
      expect(terminal.operation.state).toBe("cancelled");
      expect(terminal.result?.state).toBe("cancelled");
      expect(value.transport.cancelCalls).toHaveBeenCalledTimes(3);
    } finally {
      value.sqlite.close();
    }
  });

  test("preserves a proven successful result when a concurrent stop advances lifecycle state", async () => {
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
        operation: { state: "succeeded", remoteCleanupPending: 1 },
        result: { state: "succeeded", stdout: "ok", exitCode: 0 },
      });
      expect(value.transport.finalizeCalls).not.toHaveBeenCalled();
      await expect(
        value.service.reconcile(
          "user-1",
          value.repository.listOwned("user-1", "codespace-1")[0]!.id,
        ),
      ).resolves.toMatchObject({ state: "succeeded", stdout: "ok", exitCode: 0 });
      expect(value.transport.executeCalls).toHaveBeenCalledTimes(1);
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
