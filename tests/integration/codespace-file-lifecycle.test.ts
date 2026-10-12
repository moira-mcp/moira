import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import express from "express";
import httpRequest from "supertest";
import { effectiveCodespaceLimits } from "../../packages/shared/src/codespaces/resource-policy.js";
import {
  createCodespaceFileRateLimiter,
  createRateLimiters,
} from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";
import {
  CodespaceFileService,
  CodespaceOperationRepository,
  CodespaceOperationService,
  CodespaceResourceRepository,
  CodespaceResourceError,
  CodespaceTransferRepository,
  CodespaceTransferService,
  CodespaceFileCapabilities,
  CodespaceFileTransferService,
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
    advance: (milliseconds: number) => {
      currentNow += milliseconds;
    },
  };
}

describe("private file transfer authority and original publication", () => {
  async function transferFixture(inputPolicy = policy, provider = "github-codespaces") {
    const value = fixture();
    value.sqlite.prepare("UPDATE codespaceConnection SET provider=?").run(provider);
    value.sqlite.prepare("UPDATE codespaceResource SET provider=?").run(provider);
    const root = mkdtempSync(join(tmpdir(), "moira-transfer-authority-"));
    const transfers = new CodespaceTransferService({
      repository: new CodespaceTransferRepository(value.sqlite),
      root,
      policy: () => inputPolicy,
      now: value.now,
    });
    const anchor = value.repository.reserve({
      userId: "user-1",
      resourceId: "codespace-1",
      kind: "exec",
      sessionKey: "moira-file-client",
      inputBytes: 0,
      stdoutLimitBytes: 0,
      stderrLimitBytes: 0,
      deadlineAt: now + 60000,
      policy: inputPolicy,
      now,
    }).operation!;
    const inputReference = await transfers.retainRelayPayload(
      "user-1",
      "operation_input",
      Buffer.from(
        JSON.stringify({
          version: 1,
          mode: "setup",
          life: "a".repeat(64),
          expiresAt: now + 60000,
          assets: { abi: 1, workerSha256: null, cliSha256: "b".repeat(64) },
          request: {
            argv: [],
            stdinBase64: "",
            timeoutMs: 60000,
            maxStdoutBytes: 16384,
            maxStderrBytes: 4096,
            maxRetainedBytes: 65536,
          },
        }),
      ),
      now + 60000,
    );
    expect(
      value.repository.attachInput("user-1", anchor.id, JSON.stringify(inputReference), now),
    ).toBe(true);
    // This controlled transport observes provider life independently of resource generation.
    value.sqlite
      .prepare(
        "UPDATE codespaceOperation SET state='succeeded', lastOutcome='file_client_provisioned', resultReference='retained', resultExpiresAt=? WHERE id=?",
      )
      .run(now + 60000, anchor.id);
    let life = "a".repeat(64);
    const probe = jest.fn<NonNullable<CodespaceFileTransport["probeFile"]>>(async () => ({
      action: "probe" as const,
      abi: 1,
      environmentIdentity: life,
      workerSha256: null,
      cliSha256: "b".repeat(64),
      command: "/home/controlled/.local/bin/moira-files",
      executableSha256: "b".repeat(64),
    }));
    const capabilities = new CodespaceFileCapabilities(
      "test-file-capability-key-32-bytes-or-more",
      value.now,
    );
    const claims = {
      kind: "bootstrap" as const,
      userId: "user-1",
      resourceId: "codespace-1",
      provider,
      resourceGeneration: 1,
      authorizationGeneration: 1,
      environmentIdentity: life,
      operationId: anchor.id,
      expiresAt: now + 60000,
    };
    const dependencies: ConstructorParameters<typeof CodespaceFileTransferService>[0] = {
      repository: value.repository,
      files: value.service,
      transfers,
      credentials: value.credentials,
      policy: () => inputPolicy,
      origin: "https://files.example.test",
      capabilities,
      requireAccount: () => undefined,
      assets: async () => ({ abi: 1, cliSha256: "b".repeat(64), workerSha256: null }),
      lifeProbe: () => {
        throw new Error("Unexpected provisioning");
      },
      installer: async () => {
        throw new Error("Unexpected installer");
      },
      nativeFetcher: {
        fetch: async () => {
          throw new Error("Unexpected native fetch");
        },
      },
      wake: () => undefined,
      transport: {
        ...value.transport,
        health: () => value.transport.health(),
        executeFile: value.transport.executeFile.bind(value.transport),
        inspectFile: value.transport.inspectFile,
        probeFile: probe,
        execute: async () => {
          throw new Error("Unexpected execution");
        },
        inspect: async () => {
          throw new Error("Unexpected inspection");
        },
      },
      now: value.now,
    };
    const service = new CodespaceFileTransferService(dependencies);
    const commands = new CodespaceOperationService({
      repository: value.repository,
      credentials: value.credentials,
      policy: () => inputPolicy,
      now: value.now,
      transfers,
      transport: {
        ...dependencies.transport,
        cancel: async () => ({ state: "absent" }),
        finalize: async () => undefined,
        readOutput: async () => ({ state: "absent" }),
      },
    });
    return {
      ...value,
      root,
      transfers,
      service,
      commands,
      probe,
      capabilities,
      claims,
      dependencies,
      setLife: (next: string) => {
        life = next;
      },
      close: () => {
        transfers.stop();
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  function referenceStdinTransport(
    value: Awaited<ReturnType<typeof transferFixture>>,
    target: string,
  ) {
    return {
      ...value.dependencies.transport,
      cancel: async () => ({ state: "absent" as const }),
      finalize: async () => undefined,
      readOutput: async () => ({ state: "absent" as const }),
      execute: async (
        _credential: string,
        _codespace: unknown,
        _operation: unknown,
        request: import("@mcp-moira/shared").CodespaceExecRequest,
      ) => {
        if (request.stdin.kind !== "inline")
          throw new Error("Reference stdin was not materialized");
        writeFileSync(target, request.stdin.bytes);
        return {
          state: "succeeded" as const,
          stdout: "",
          stderr: "",
          exitCode: 0,
          stdoutTotalBytes: 0,
          stderrTotalBytes: 0,
          outputLimitExceeded: false,
          sessionCaptureDropped: false,
        };
      },
    };
  }

  test.each(
    ["github-codespaces", "local-sandboxes"].flatMap((provider) =>
      ["upload", "download", "setup", "cli-upload", "cli-download"].flatMap((family) =>
        ["retained", "expired", "missing"].map(
          (retention) => [provider, family, retention] as const,
        ),
      ),
    ),
  )(
    "expired attached %s %s admission settles without execution with %s private preparation",
    async (provider, family, retention) => {
      const admissionPolicy = { ...policy, maxOperationMs: 1000, transferTtlMs: 120_000 };
      const value = await transferFixture(admissionPolicy, provider);
      const target = join(value.root, "unchanged-target.bin");
      const bytes = Buffer.from([0, 255, 17, 128]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(target, bytes);
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "original-source.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      });
      const sourceRecord = value.transfers.getOwnedTransfer("user-1", source.referenceId)!;
      const id = randomUUID();
      const fixed = {
        argv: ["controlled-life"],
        stdin: new Uint8Array(),
        timeoutMs: 1000,
        maxStdoutBytes: 16384,
        maxStderrBytes: 4096,
        maxRetainedBytes: 65536,
      };
      const fetch = jest.fn(async () => {
        throw new Error("Expired work fetched native input");
      });
      const execute = jest.fn<NonNullable<typeof value.dependencies.transport.execute>>(
        async () => {
          const stdout = JSON.stringify({ environmentIdentity: "a".repeat(64) });
          return {
            state: "succeeded",
            stdout,
            stderr: "",
            exitCode: 0,
            stdoutTotalBytes: Buffer.byteLength(stdout),
            stderrTotalBytes: 0,
            outputLimitExceeded: false,
            sessionCaptureDropped: false,
          };
        },
      );
      const service = new CodespaceFileTransferService({
        ...value.dependencies,
        lifeProbe: () => fixed,
        installer: async () => fixed,
        nativeFetcher: { fetch },
        transport: {
          ...value.dependencies.transport,
          execute,
          describeTransfer: async (_credential, _resource, _operation, request) => ({
            action: "describe_transfer",
            path: request.path,
            size: bytes.length,
            sha256,
            environmentIdentity: "a".repeat(64),
          }),
        },
      });
      const begin = value.repository.beginDispatch.bind(value.repository);
      try {
        if (family.startsWith("cli-")) {
          const interrupted = jest
            .spyOn(value.repository, "beginDispatch")
            .mockImplementation((...args) => {
              if (value.repository.getOwned(args[0], args[1])?.requestId === id)
                throw new Error("Controlled interruption after attached private intent");
              return begin(...args);
            });
          const input =
            family === "cli-download"
              ? {
                  requestId: id,
                  direction: "server_to_guest" as const,
                  referenceId: source.referenceId,
                }
              : {
                  requestId: id,
                  direction: "guest_to_server" as const,
                  size: bytes.length,
                  sha256,
                  fileName: "copy.bin",
                  mimeType: "application/octet-stream",
                };
          await expect(service.mint(value.capabilities.issue(value.claims), input)).rejects.toThrow(
            "Controlled interruption after attached private intent",
          );
          interrupted.mockRestore();
        } else if (family === "setup") {
          expect(await service.setup("user-1", "codespace-1", { requestId: id })).toMatchObject({
            provisioned: false,
            command: null,
          });
        } else if (family === "upload") {
          await service.uploadReference("user-1", "codespace-1", {
            requestId: id,
            path: "unchanged-target.bin",
            expected: { exists: false },
            reference: {
              fileId: "file_ORIGINAL",
              downloadUrl: "https://native.test/original",
              fileName: "original.bin",
              mimeType: "application/octet-stream",
              declaredSize: bytes.length,
            },
          });
        } else {
          await service.downloadReference("user-1", "codespace-1", {
            requestId: id,
            path: "unchanged-target.bin",
            maxBytes: bytes.length,
            fileName: "original.bin",
            mimeType: "application/octet-stream",
          });
        }
        const original = value.repository.getByRequest("user-1", id)!;
        expect(original).toMatchObject({ state: "reserved", startedAt: null });
        expect(original.inputReference).not.toBeNull();
        const reference = JSON.parse(original.inputReference!);
        const copy = value.transfers.getByRequest("user-1", id);
        if (retention === "missing") {
          await value.transfers.discardRelayPayload("user-1", "operation_input", reference);
          if (copy) await value.transfers.discard(copy);
        }
        const privateExpiry = (
          value.sqlite.prepare("SELECT MAX(expiresAt) AS expiry FROM codespaceTransfer").get() as {
            expiry: number;
          }
        ).expiry;
        value.advance(
          (retention === "expired"
            ? Math.max(privateExpiry, original.deadlineAt)
            : original.deadlineAt) -
            value.now() +
            1,
        );
        // Other completed preparation work is not a guest cleanup obligation in this fixture.
        value.sqlite
          .prepare("UPDATE codespaceOperation SET remoteCleanupPending=0 WHERE id<>?")
          .run(original.id);
        const beforeTransfers = value.sqlite
          .prepare("SELECT * FROM codespaceTransfer ORDER BY id")
          .all();
        execute.mockClear();
        value.probe.mockClear();
        value.credentials.getCredential.mockClear();
        const retain = jest.spyOn(value.transfers, "retainRelayPayload");
        const audit =
          jest.fn<
            NonNullable<ConstructorParameters<typeof CodespaceOperationService>[0]["audit"]>
          >();
        const scheduler = new CodespaceOperationService({
          repository: value.repository,
          credentials: value.credentials,
          policy: value.dependencies.policy,
          now: value.now,
          transfers: value.transfers,
          audit,
          reconcileFile: (row) => service.recover(row),
          transport: {
            ...value.dependencies.transport,
            execute,
            cancel: async () => ({ state: "absent" }),
            finalize: async () => {
              throw new Error("Never-dispatched work finalized a guest marker");
            },
            readOutput: async () => ({ state: "absent" }),
          },
        });
        expect(await scheduler.reconcileOnce("user-1")).toBe(true);
        expect(value.repository.getByRequest("user-1", id)).toMatchObject({
          id: original.id,
          requestId: id,
          deadlineAt: original.deadlineAt,
          state: "cancelled",
          lastOutcome: expect.stringMatching(
            /^(reservation_expired_before_dispatch|admission_expired_not_started)$/,
          ),
          startedAt: null,
          resultReference: null,
          resultExpiresAt: null,
          remoteCleanupPending: 0,
          claimId: null,
          claimExpiresAt: null,
        });
        expect(value.repository.countActiveForUser("user-1")).toBe(0);
        expect(audit.mock.calls.map(([event]) => event.state)).toEqual(["cancelled"]);
        expect(value.sqlite.prepare("SELECT * FROM codespaceTransfer ORDER BY id").all()).toEqual(
          beforeTransfers,
        );
        expect(readFileSync(target).equals(bytes)).toBe(true);
        expect(readFileSync(join(value.root, sourceRecord.objectKey)).equals(bytes)).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
        expect(value.probe).not.toHaveBeenCalled();
        expect(value.credentials.getCredential).not.toHaveBeenCalled();
        expect(retain).not.toHaveBeenCalled();
        expect(await scheduler.reconcileOnce("user-1")).toBe(false);
        value.advance(180_000);
        await value.transfers.cleanup();
        expect(
          value.sqlite.prepare("SELECT COUNT(*) AS count FROM codespaceTransfer").get(),
        ).toEqual({ count: 0 });
        expect(readFileSync(target).equals(bytes)).toBe(true);
      } finally {
        value.close();
      }
    },
  );

  test("private copy publication cannot replace a successor preparation claim", async () => {
    const value = await transferFixture();
    let release!: () => void;
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const bytes = Buffer.from([0, 255, 17, 128]);
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "source.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      });
      const input = {
        requestId: randomUUID(),
        direction: "server_to_guest" as const,
        referenceId: source.referenceId,
      };
      const retain = value.transfers.retainRelayPayload.bind(value.transfers);
      let held!: () => void;
      const observed = new Promise<void>((resolve) => {
        held = resolve;
      });
      jest.spyOn(value.transfers, "retainRelayPayload").mockImplementation(async (...args) => {
        if (
          args[1] === "operation_input" &&
          JSON.parse(Buffer.from(args[2]).toString("utf8")).transferId
        ) {
          held();
          await allowed;
        }
        return retain(...args);
      });
      const mint = value.service.mint(value.capabilities.issue(value.claims), input);
      const refused = expect(mint).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      await observed;
      const original = value.repository.getByRequest("user-1", input.requestId)!;
      value.advance(policy.claimLeaseMs + 1);
      const successor = value.repository.claimDue(
        randomUUID(),
        value.now(),
        value.now() + policy.claimLeaseMs,
        "user-1",
      )!;
      expect(successor.id).toBe(original.id);
      expect(successor.claimId).not.toBe(original.claimId);
      release();
      await refused;
      expect(value.repository.getByRequest("user-1", input.requestId)).toMatchObject({
        id: original.id,
        claimId: successor.claimId,
        inputReference: original.inputReference,
      });
      const copy = value.transfers.getByRequest("user-1", input.requestId)!;
      expect(copy).toMatchObject({ state: "reserved", sha256: null });
      expect(readFileSync(join(value.root, copy.objectKey + ".partial")).equals(bytes)).toBe(true);
      expect(() => readFileSync(join(value.root, copy.objectKey))).toThrow();
    } finally {
      release();
      value.close();
    }
  });

  test("reclaimed private copy refuses its old publisher then settles the same checkpoint on fresh recovery", async () => {
    const value = await transferFixture();
    let release!: () => void;
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const bytes = Buffer.from([0, 255, 17, 128]);
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "source.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      });
      const input = {
        requestId: randomUUID(),
        direction: "server_to_guest" as const,
        referenceId: source.referenceId,
      };
      const token = value.capabilities.issue(value.claims);
      const write = value.transfers.writeTransferChunk.bind(value.transfers);
      const interrupted = jest
        .spyOn(value.transfers, "writeTransferChunk")
        .mockImplementationOnce(async (...args) => {
          await write(...args);
          throw new Error("Controlled checkpoint reply loss");
        });
      await expect(value.service.mint(token, input)).rejects.toThrow(
        "Controlled checkpoint reply loss",
      );
      interrupted.mockRestore();
      const original = value.transfers.getByRequest("user-1", input.requestId)!;
      const operation = value.repository.getByRequest("user-1", input.requestId)!;
      let held!: () => void;
      const observed = new Promise<void>((resolve) => {
        held = resolve;
      });
      const open = value.transfers.openOwnedSource.bind(value.transfers);
      jest.spyOn(value.transfers, "openOwnedSource").mockImplementationOnce(async (...args) => {
        held();
        await allowed;
        return open(...args);
      });
      const minting = value.service.mint(token, input);
      const refused = expect(minting).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      await observed;
      value.advance(policy.claimLeaseMs + 1);
      let reclaimed!: () => void;
      const claimObserved = new Promise<void>((resolve) => {
        reclaimed = resolve;
      });
      const scheduler = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: value.dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        transport: {
          ...value.dependencies.transport,
          cancel: async () => ({ state: "absent" }),
          finalize: async () => undefined,
          readOutput: async () => ({ state: "absent" }),
        },
        reconcileFile: (row) => {
          reclaimed();
          return value.service.recover(row);
        },
      });
      const recovering = scheduler.reconcileOnce("user-1");
      await claimObserved;
      const successor = value.repository.getByRequest("user-1", input.requestId)!;
      expect(successor.claimId).not.toBe(operation.claimId);
      release();
      await Promise.all([refused, recovering]);
      expect(value.repository.getByRequest("user-1", input.requestId)).toMatchObject({
        id: operation.id,
        state: "reconcile_pending",
        inputReference: operation.inputReference,
      });
      expect(value.transfers.getByRequest("user-1", input.requestId)).toMatchObject({
        id: original.id,
        objectKey: original.objectKey,
        state: "reserved",
        uploadedBytes: bytes.length,
      });
      expect(readFileSync(join(value.root, original.objectKey + ".partial")).equals(bytes)).toBe(
        true,
      );
      expect(() => readFileSync(join(value.root, original.objectKey))).toThrow();
      value.advance(policy.claimLeaseMs + 1);
      await scheduler.reconcileOnce("user-1");
      expect(value.repository.getByRequest("user-1", input.requestId)).toMatchObject({
        id: operation.id,
        state: "succeeded",
      });
      expect(value.transfers.getByRequest("user-1", input.requestId)).toMatchObject({
        id: original.id,
        objectKey: original.objectKey,
        state: "ready",
      });
      expect(readFileSync(join(value.root, original.objectKey)).equals(bytes)).toBe(true);
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      release();
      value.close();
    }
  });

  test("native upload recovery cannot refetch ready input consumed before descriptor attachment", async () => {
    const value = await transferFixture();
    let release!: () => void;
    const allowed = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const bytes = Buffer.from([0, 255, 17, 128]);
      const fetch = jest.fn(async () => ({
        mimeType: "application/octet-stream",
        contentLength: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      }));
      const service = new CodespaceFileTransferService({
        ...value.dependencies,
        nativeFetcher: { fetch },
      });
      const input = {
        requestId: randomUUID(),
        path: "native-target.bin",
        expected: { exists: false },
        reference: {
          fileId: "file_NATIVE",
          downloadUrl: "https://native.test/input",
          fileName: "input.bin",
          mimeType: "application/octet-stream",
          declaredSize: bytes.length,
        },
      };
      const accepted = await service.uploadReference("user-1", "codespace-1", input);
      const target = join(value.root, "native-reference-stdin-effect.bin");
      const transport = referenceStdinTransport(value, target);
      const commands = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: value.dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        transport,
      });
      let recoveryFailure: string | null = null;
      const scheduler = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: value.dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        transport,
        reconcileFile: async (row) => {
          try {
            return await service.recover(row);
          } catch (error) {
            recoveryFailure = error instanceof Error ? error.message : "Unknown recovery failure";
            throw error;
          }
        },
      });
      let held!: () => void;
      const observed = new Promise<void>((resolve) => {
        held = resolve;
      });
      const retain = value.transfers.retainRelayPayload.bind(value.transfers);
      const interrupted = jest
        .spyOn(value.transfers, "retainRelayPayload")
        .mockImplementation(async (...args) => {
          if (
            args[1] === "operation_input" &&
            JSON.parse(Buffer.from(args[2]).toString("utf8")).descriptor
          ) {
            held();
            await allowed;
            throw new Error("Controlled descriptor retention interruption");
          }
          return retain(...args);
        });
      const recovering = scheduler.reconcileOnce("user-1");
      await observed;
      const status = await service.status("user-1", "codespace-1", { requestId: input.requestId });
      expect(status.transfer).toMatchObject({ state: "ready", size: bytes.length });
      const copy = value.transfers.getByRequest("user-1", input.requestId)!;
      const consumed = await commands.execute("user-1", "codespace-1", {
        argv: ["/bin/cat"],
        stdin: {
          kind: "reference",
          referenceId: status.transfer!.handle!.referenceId,
          declaredBytes: bytes.length,
          declaredMimeType: "application/octet-stream",
        },
      });
      expect(consumed.operation.state).toBe("succeeded");
      expect(readFileSync(target).equals(bytes)).toBe(true);
      expect(value.transfers.getByRequest("user-1", input.requestId)).toBeNull();
      release();
      await recovering;
      interrupted.mockRestore();
      expect(recoveryFailure).toBe("Controlled descriptor retention interruption");
      value.advance(policy.claimLeaseMs + 1);
      await scheduler.reconcileOnce("user-1");
      expect({
        fetchCount: fetch.mock.calls.length,
        retainedInput: value.transfers.getByRequest("user-1", input.requestId)?.id ?? null,
      }).toEqual({ fetchCount: 1, retainedInput: null });
      expect(() => readFileSync(join(value.root, copy.objectKey))).toThrow();
      expect(readFileSync(target).equals(bytes)).toBe(true);
      expect(value.repository.getOwned("user-1", consumed.operation.id)).toMatchObject({
        state: "succeeded",
        exitCode: 0,
      });
      expect(value.repository.getOwned("user-1", accepted.operation.id)?.state).not.toBe(
        "succeeded",
      );
    } finally {
      release();
      value.close();
    }
  });

  test("scheduled recovery cannot republish an independent copy already consumed by reference stdin", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.from([0, 255, 17, 128]);
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "source.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      });
      const input = {
        requestId: randomUUID(),
        direction: "server_to_guest" as const,
        referenceId: source.referenceId,
      };
      const token = value.capabilities.issue(value.claims);
      const retain = value.transfers.retainRelayPayload.bind(value.transfers);
      const interrupted = jest
        .spyOn(value.transfers, "retainRelayPayload")
        .mockImplementation(async (...args) => {
          if (args[1] === "operation_result")
            throw new Error("Controlled result retention interruption");
          return retain(...args);
        });
      await expect(value.service.mint(token, input)).rejects.toThrow(
        "Controlled result retention interruption",
      );
      interrupted.mockRestore();
      const copy = value.transfers.getByRequest("user-1", input.requestId)!;
      const ready = await value.service.lookup(token, input.requestId);
      const target = join(value.root, "reference-stdin-effect.bin");
      const transport = referenceStdinTransport(value, target);
      const commands = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: value.dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        transport,
      });
      const consumed = await commands.execute("user-1", "codespace-1", {
        argv: ["/bin/cat"],
        stdin: {
          kind: "reference",
          referenceId: ready.receipt!.referenceId,
          declaredBytes: bytes.length,
          declaredMimeType: "application/octet-stream",
        },
      });
      expect(consumed.operation.state).toBe("succeeded");
      expect(readFileSync(target).equals(bytes)).toBe(true);
      expect(value.transfers.getByRequest("user-1", input.requestId)).toBeNull();
      await expect(value.service.mint(token, input)).rejects.toMatchObject({
        code: "CODESPACE_RESULT_EXPIRED",
      });
      value.advance(policy.claimLeaseMs + 1);
      const scheduler = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: value.dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        transport,
        reconcileFile: (row) => value.service.recover(row),
      });
      await scheduler.reconcileOnce("user-1");
      expect(value.transfers.getByRequest("user-1", input.requestId)).toBeNull();
      expect(() => readFileSync(join(value.root, copy.objectKey))).toThrow();
      expect(readFileSync(target).equals(bytes)).toBe(true);
      expect(value.repository.getOwned("user-1", consumed.operation.id)).toMatchObject({
        state: "succeeded",
        exitCode: 0,
      });
      expect(value.transfers.getOwnedTransfer("user-1", source.referenceId)).not.toBeNull();
    } finally {
      value.close();
    }
  });

  test.each(["mint", "finalize"])(
    "known ready private object %s replay does not require another result quota slot",
    async (replay) => {
      const value = await transferFixture();
      try {
        const bytes = Buffer.from([0, 255, 17, 128]);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const input = {
          requestId: randomUUID(),
          direction: "guest_to_server" as const,
          size: bytes.length,
          sha256,
          fileName: "copy.bin",
          mimeType: "application/octet-stream",
        };
        const token = value.capabilities.issue(value.claims);
        const minted = await value.service.mint(token, input);
        await value.service.writeChunk(minted.descriptor.capability, minted.descriptor.transferId, {
          offset: 0,
          bytes,
          sha256,
        });
        const original = await value.service.finalize(
          minted.descriptor.capability,
          minted.descriptor.transferId,
        );
        const operation = value.repository.getByRequest("user-1", input.requestId)!;
        let filled = false;
        for (
          let index = 0;
          index <= effectiveCodespaceLimits(policy).relayTransfers.maxObjectsPerUser;
          index++
        ) {
          try {
            await value.transfers.retainRelayPart(
              "user-1",
              "local_relay_input",
              Buffer.from([index % 256]),
            );
          } catch (error) {
            expect(error).toMatchObject({ code: "CODESPACE_POLICY_LIMIT" });
            filled = true;
            break;
          }
        }
        expect(filled).toBe(true);
        const before = value.sqlite
          .prepare("SELECT COUNT(*) AS count FROM codespaceTransfer")
          .get();
        const result =
          replay === "mint"
            ? await value.service.mint(token, input)
            : await value.service.finalize(
                minted.descriptor.capability,
                minted.descriptor.transferId,
              );
        if (replay === "mint")
          expect(result).toMatchObject({
            status: { state: "ready", receipt: { referenceId: original.referenceId } },
          });
        else expect(result).toEqual(original);
        expect(value.repository.getByRequest("user-1", input.requestId)).toEqual(operation);
        expect(
          value.sqlite.prepare("SELECT COUNT(*) AS count FROM codespaceTransfer").get(),
        ).toEqual(before);
      } finally {
        value.close();
      }
    },
  );

  test.each(
    ["github-codespaces", "local-sandboxes"].flatMap((provider) =>
      ["mint", "scheduled"].map((recovery) => [provider, recovery] as const),
    ),
  )(
    "ready independent copy for %s settles through %s after its original source is consumed",
    async (provider, recovery) => {
      const value = await transferFixture(policy, provider);
      try {
        const bytes = Buffer.from([0, 255, 17, 128]);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const source = await value.transfers.ingestStream("user-1", {
          fileName: "source.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
          body: (async function* () {
            yield bytes;
          })(),
        });
        const input = {
          requestId: randomUUID(),
          direction: "server_to_guest" as const,
          referenceId: source.referenceId,
        };
        const token = value.capabilities.issue(value.claims);
        const retain = value.transfers.retainRelayPayload.bind(value.transfers);
        const interrupted = jest
          .spyOn(value.transfers, "retainRelayPayload")
          .mockImplementation(async (...args) => {
            if (args[1] === "operation_result")
              throw new Error("Controlled result retention interruption");
            return retain(...args);
          });
        await expect(value.service.mint(token, input)).rejects.toThrow(
          "Controlled result retention interruption",
        );
        interrupted.mockRestore();
        const copy = value.transfers.getByRequest("user-1", input.requestId)!;
        const operation = value.repository.getByRequest("user-1", input.requestId)!;
        expect(copy).toMatchObject({ state: "ready", sha256, observedSize: bytes.length });
        expect(operation.state).not.toBe("succeeded");
        const original = await value.transfers.claimDownload(source.referenceId);
        original.stream.destroy();
        await value.transfers.consume(original.record);
        expect(value.transfers.getOwnedTransfer("user-1", source.referenceId)).toBeNull();
        const reopen = jest
          .spyOn(value.transfers, "openOwnedSource")
          .mockRejectedValue(new Error("No source reopening is permitted"));
        if (recovery === "mint") {
          const response = await value.service.mint(token, input);
          expect(response).toMatchObject({
            descriptor: { transferId: copy.id },
            status: { state: "ready" },
          });
        } else {
          value.advance(policy.claimLeaseMs + 1);
          const scheduler = new CodespaceOperationService({
            repository: value.repository,
            credentials: value.credentials,
            policy: value.dependencies.policy,
            now: value.now,
            transfers: value.transfers,
            reconcileFile: (row) => value.service.recover(row),
            transport: {
              ...value.dependencies.transport,
              cancel: async () => ({ state: "absent" }),
              finalize: async () => undefined,
              readOutput: async () => ({ state: "absent" }),
            },
          });
          await scheduler.reconcileOnce("user-1");
        }
        expect(value.repository.getByRequest("user-1", input.requestId)).toMatchObject({
          id: operation.id,
          state: "succeeded",
          lastOutcome: "private_source_ready",
        });
        expect(value.transfers.getByRequest("user-1", input.requestId)).toMatchObject({
          id: copy.id,
          objectKey: copy.objectKey,
          state: "ready",
          sha256,
        });
        expect(readFileSync(join(value.root, copy.objectKey)).equals(bytes)).toBe(true);
        expect(reopen).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
      } finally {
        value.close();
      }
    },
  );

  test.each(["recovery", "mint"])(
    "matching mint and scheduled private copy recovery with %s first return their own result shapes",
    async (first) => {
      const value = await transferFixture();
      let release!: () => void;
      let releaseRecovery!: () => void;
      const recoveryAllowed = new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
      const allowed = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const bytes = Buffer.from([0, 255, 17, 128]);
        const source = await value.transfers.ingestStream("user-1", {
          fileName: "source.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
          body: (async function* () {
            yield bytes;
          })(),
        });
        const input = {
          requestId: randomUUID(),
          direction: "server_to_guest" as const,
          referenceId: source.referenceId,
        };
        const token = value.capabilities.issue(value.claims);
        const reserve = value.transfers.reserveResumable.bind(value.transfers);
        const interrupted = jest
          .spyOn(value.transfers, "reserveResumable")
          .mockImplementationOnce(async (...args) => {
            await reserve(...args);
            throw new Error("Controlled interrupted source copy");
          });
        await expect(value.service.mint(token, input)).rejects.toThrow("Controlled interrupted");
        interrupted.mockRestore();
        const original = value.transfers.getByRequest("user-1", input.requestId)!;
        const operation = value.repository.getByRequest("user-1", input.requestId)!;
        const open = value.transfers.openOwnedSource.bind(value.transfers);
        let held!: () => void;
        const observed = new Promise<void>((resolve) => {
          held = resolve;
        });
        const opening = jest
          .spyOn(value.transfers, "openOwnedSource")
          .mockImplementationOnce(async (...args) => {
            held();
            await allowed;
            return open(...args);
          });
        let claimed!: () => void;
        const claimObserved = new Promise<void>((resolve) => {
          claimed = resolve;
        });
        const scheduler = new CodespaceOperationService({
          repository: value.repository,
          credentials: value.credentials,
          policy: () => policy,
          now: value.now,
          transfers: value.transfers,
          transport: {
            ...value.dependencies.transport,
            cancel: async () => ({ state: "absent" }),
            finalize: async () => undefined,
            readOutput: async () => ({ state: "absent" }),
          },
          reconcileFile: async (row) => {
            claimed();
            if (first === "mint") await recoveryAllowed;
            return value.service.recover(row);
          },
        });
        value.advance(policy.claimLeaseMs + 1);
        const recovering = scheduler.reconcileOnce("user-1");
        if (first === "mint") await claimObserved;
        else await observed;
        const minting = value.service.mint(token, input);
        await observed;
        releaseRecovery();
        await expect(
          value.service.mint(token, { ...input, referenceId: source.referenceId + "-changed" }),
        ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        const [recovered, minted] = await Promise.all([recovering, minting]);
        expect(recovered).toBe(true);
        expect(minted).toMatchObject({
          descriptor: { transferId: original.id, requestId: input.requestId },
          status: { state: "ready" },
        });
        expect(value.repository.getByRequest("user-1", input.requestId)?.id).toBe(operation.id);
        expect(value.transfers.getByRequest("user-1", input.requestId)?.objectKey).toBe(
          original.objectKey,
        );
        expect(readFileSync(join(value.root, original.objectKey)).equals(bytes)).toBe(true);
        expect(opening).toHaveBeenCalledTimes(1);
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
      } finally {
        release();
        releaseRecovery();
        value.close();
      }
    },
  );

  test.each(
    ["github-codespaces", "local-sandboxes"].flatMap((provider) =>
      ["reservation", "checkpoint"].flatMap((interruption) =>
        ["mint", "scheduled"].map((recovery) => [provider, interruption, recovery] as const),
      ),
    ),
  )(
    "interrupted private source copy for %s after %s resumes through %s under its original identity",
    async (provider, interruption, recovery) => {
      const value = await transferFixture(
        { ...policy, maxTransferFileBytes: 512 * 1024 },
        provider,
      );
      try {
        const bytes = Buffer.alloc(256 * 1024 + 17, 0xa7);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const source = await value.transfers.ingestStream("user-1", {
          fileName: "source.bin",
          mimeType: "application/octet-stream",
          size: bytes.length,
          body: (async function* () {
            yield bytes;
          })(),
        });
        const input = {
          requestId: randomUUID(),
          direction: "server_to_guest" as const,
          referenceId: source.referenceId,
        };
        const token = value.capabilities.issue(value.claims);
        let interrupted = false;
        const interrupt = () => {
          if (!interrupted) {
            interrupted = true;
            throw new Error("Controlled interrupted source copy");
          }
        };
        const reserve = value.transfers.reserveResumable.bind(value.transfers);
        const write = value.transfers.writeTransferChunk.bind(value.transfers);
        const spy =
          interruption === "reservation"
            ? jest
                .spyOn(value.transfers, "reserveResumable")
                .mockImplementation(async (...args) => {
                  const result = await reserve(...args);
                  interrupt();
                  return result;
                })
            : jest
                .spyOn(value.transfers, "writeTransferChunk")
                .mockImplementation(async (...args) => {
                  const result = await write(...args);
                  interrupt();
                  return result;
                });
        await expect(value.service.mint(token, input)).rejects.toThrow(
          "Controlled interrupted source copy",
        );
        spy.mockRestore();
        const operation = value.repository.getByRequest("user-1", input.requestId)!;
        const reserved = value.transfers.getByRequest("user-1", input.requestId)!;
        expect(reserved).toMatchObject({
          state: "reserved",
          uploadedBytes: interruption === "checkpoint" ? 256 * 1024 : 0,
        });
        const reopened = new CodespaceFileTransferService(value.dependencies);
        if (recovery === "mint") await reopened.mint(token, input);
        else {
          // A failed admitted copy leaves its ordinary crash-recovery claim until expiry.
          value.advance(policy.claimLeaseMs + 1);
          const scheduler = new CodespaceOperationService({
            repository: value.repository,
            credentials: value.credentials,
            policy: value.dependencies.policy,
            now: value.now,
            transfers: value.transfers,
            reconcileFile: (row) => reopened.recover(row),
            transport: {
              ...value.dependencies.transport,
              cancel: async () => ({ state: "absent" }),
              finalize: async () => undefined,
              readOutput: async () => ({ state: "absent" }),
            },
          });
          await scheduler.reconcileOnce("user-1");
        }
        const ready = value.transfers.getByRequest("user-1", input.requestId)!;
        expect(ready).toMatchObject({
          id: reserved.id,
          objectKey: reserved.objectKey,
          state: "ready",
          sha256,
          observedSize: bytes.length,
        });
        expect(value.repository.getByRequest("user-1", input.requestId)).toMatchObject({
          id: operation.id,
          state: "succeeded",
        });
        expect(readFileSync(join(value.root, ready.objectKey)).equals(bytes)).toBe(true);
        expect(
          readFileSync(
            join(
              value.root,
              value.transfers.getOwnedTransfer("user-1", source.referenceId)!.objectKey,
            ),
          ).equals(bytes),
        ).toBe(true);
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
      } finally {
        value.close();
      }
    },
  );

  test.each(["github-codespaces", "local-sandboxes"])(
    "completed native and private file work for %s clears expired cleanup without repeating effects",
    async (provider) => {
      const value = await transferFixture({ ...policy, transferTtlMs: 60_000 }, provider);
      const guest = join(value.root, "controlled-guest");
      mkdirSync(guest);
      const finalized: string[] = [],
        executed: string[] = [];
      const fixed = (command: string) => ({
        argv: [command],
        stdin: new Uint8Array(),
        timeoutMs: 60_000,
        maxStdoutBytes: 16384,
        maxStderrBytes: 4096,
        maxRetainedBytes: 65536,
      });
      const bytes = Buffer.from([0, 255, 17, 128]);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const authority = {
        resourceId: "codespace-1",
        provider,
        resourceGeneration: 1,
        authorizationGeneration: 1,
        environmentIdentity: "a".repeat(64),
      };
      const dependencies = {
        ...value.dependencies,
        lifeProbe: () => fixed("controlled-life"),
        installer: async () => fixed("controlled-install"),
        nativeFetcher: {
          fetch: async () => ({
            contentLength: bytes.length,
            mimeType: "application/octet-stream",
            body: (async function* () {
              yield bytes;
            })(),
          }),
        },
        transport: {
          ...value.dependencies.transport,
          execute: async (
            _credential: string,
            _resource: unknown,
            operation: Parameters<CodespaceFileTransport["executeFile"]>[2],
            request: { argv?: readonly string[] },
          ) => {
            executed.push(operation.id);
            writeFileSync(join(guest, operation.remoteMarker), "retained marker");
            const stdout = JSON.stringify(
              request.argv![0] === "controlled-life"
                ? { environmentIdentity: "a".repeat(64) }
                : {
                    abi: 1,
                    environmentIdentity: "a".repeat(64),
                    workerSha256: null,
                    cliSha256: "b".repeat(64),
                    command: "/home/controlled/.local/bin/moira-files",
                    executableSha256: "b".repeat(64),
                  },
            );
            return {
              state: "succeeded" as const,
              stdout,
              stderr: "",
              exitCode: 0,
              stdoutTotalBytes: Buffer.byteLength(stdout),
              stderrTotalBytes: 0,
              outputLimitExceeded: false,
              sessionCaptureDropped: false,
            };
          },
          describeTransfer: async (
            _credential: string,
            _resource: unknown,
            _operation: unknown,
            input: { path: string },
          ) => ({
            action: "describe_transfer" as const,
            path: input.path,
            size: bytes.length,
            sha256,
            environmentIdentity: "a".repeat(64),
          }),
          executeFile: async (
            _credential: string,
            _resource: unknown,
            operation: Parameters<CodespaceFileTransport["executeFile"]>[2],
            request: Parameters<CodespaceFileTransport["executeFile"]>[3],
          ) => {
            executed.push(operation.id);
            writeFileSync(join(guest, operation.remoteMarker), "retained marker");
            if (!(
              (request.action === "upload" || request.action === "download") &&
              request.transfer
            ))
              throw new Error("Unexpected native request");
            const descriptor = request.transfer;
            if (request.action === "upload") {
              const range = await value.transfers.readTransferRange(
                "user-1",
                descriptor.transferId,
                authority,
                { offset: 0, length: bytes.length },
              );
              writeFileSync(join(guest, request.path), range.bytes);
              return {
                action: "upload" as const,
                path: request.path,
                transferId: descriptor.transferId,
                size: bytes.length,
                sha256,
                previous: null,
                current: { size: bytes.length, sha256, modifiedAt: value.now() },
              };
            }
            const physical = readFileSync(join(guest, request.path));
            await value.transfers.writeTransferChunk("user-1", descriptor.transferId, authority, {
              offset: 0,
              bytes: physical,
              sha256,
            });
            const handle = await value.transfers.finalizeTransfer(
              "user-1",
              descriptor.transferId,
              authority,
            );
            return {
              action: "download" as const,
              path: request.path,
              transferId: descriptor.transferId,
              size: physical.length,
              sha256,
              referenceId: handle.referenceId,
            };
          },
        },
      };
      const service = new CodespaceFileTransferService(dependencies);
      const scheduler = new CodespaceOperationService({
        repository: value.repository,
        credentials: value.credentials,
        policy: dependencies.policy,
        now: value.now,
        transfers: value.transfers,
        reconcileFile: (row) => service.recover(row),
        transport: {
          ...dependencies.transport,
          cancel: async () => ({ state: "absent" }),
          readOutput: async () => ({ state: "absent" }),
          finalize: async (_credential, _resource, operation) => {
            finalized.push(operation.id);
            rmSync(join(guest, operation.remoteMarker));
          },
        },
      });
      try {
        // The preinstalled fixture anchor owns no dispatched guest marker.
        value.sqlite
          .prepare("UPDATE codespaceOperation SET remoteCleanupPending=0 WHERE id=?")
          .run(value.claims.operationId);
        const setupId = randomUUID();
        const setup = await service.setup("user-1", "codespace-1", { requestId: setupId });
        await scheduler.reconcileOnce("user-1");
        expect(await service.setup("user-1", "codespace-1", { requestId: setupId })).toMatchObject({
          provisioned: true,
        });
        value.advance(1);
        const upload = await service.uploadReference("user-1", "codespace-1", {
          requestId: randomUUID(),
          path: "input.bin",
          reference: {
            fileId: "file_ABC",
            downloadUrl: "https://example.test/file",
            fileName: "input.bin",
            mimeType: "application/octet-stream",
            declaredSize: bytes.length,
          },
          expected: { exists: false },
        });
        await scheduler.reconcileOnce("user-1");
        expect((await service.collectFile("user-1", upload.operation.id)).result).toMatchObject({
          action: "upload",
          sha256,
        });
        const download = await service.downloadReference("user-1", "codespace-1", {
          requestId: randomUUID(),
          path: "input.bin",
          maxBytes: bytes.length,
          fileName: "output.bin",
          mimeType: "application/octet-stream",
        });
        await scheduler.reconcileOnce("user-1");
        expect(
          (await service.collectDownload("user-1", download.operation.id)).transfer,
        ).toMatchObject({ sha256, size: bytes.length });
        const privateInput = {
          requestId: randomUUID(),
          direction: "guest_to_server" as const,
          size: bytes.length,
          sha256,
          fileName: "private.bin",
          mimeType: "application/octet-stream",
        };
        const bootstrap = value.capabilities.issue({
          ...value.claims,
          operationId: setup.operationId,
        });
        const privateCopy = await service.mint(bootstrap, privateInput);
        await service.writeChunk(
          privateCopy.descriptor.capability,
          privateCopy.descriptor.transferId,
          { offset: 0, bytes, sha256 },
        );
        await service.finalize(
          privateCopy.descriptor.capability,
          privateCopy.descriptor.transferId,
        );
        expect(await service.lookup(bootstrap, privateInput.requestId)).toMatchObject({
          state: "ready",
          receipt: { sha256 },
        });
        const terminal = value.repository
          .listOwned("user-1", "codespace-1")
          .filter((row) => row.id !== value.claims.operationId);
        expect(terminal.every((row) => row.state === "succeeded")).toBe(true);
        const before = [...executed];
        value.advance(
          Math.max(
            ...terminal.map((row) =>
              Math.max(row.resultExpiresAt!, row.deadlineAt + policy.cleanupDeadlineMs),
            ),
          ) -
            value.now() +
            1,
        );
        for (let index = 0; index < terminal.length; index++)
          await scheduler.reconcileOnce("user-1");
        expect(value.repository.getOwned("user-1", upload.operation.id)).toMatchObject({
          remoteCleanupPending: 0,
          state: "succeeded",
        });
        expect(value.repository.getOwned("user-1", download.operation.id)).toMatchObject({
          remoteCleanupPending: 0,
          state: "succeeded",
        });
        expect(value.repository.getOwned("user-1", setup.operationId)).toMatchObject({
          remoteCleanupPending: 0,
          state: "succeeded",
        });
        expect(value.repository.getByRequest("user-1", privateInput.requestId)).toMatchObject({
          remoteCleanupPending: 0,
          state: "succeeded",
        });
        expect(finalized.sort()).toEqual(before.slice().sort());
        expect(readdirSync(guest)).toEqual(["input.bin"]);
        expect(readFileSync(join(guest, "input.bin")).equals(bytes)).toBe(true);
        expect(await scheduler.reconcileOnce("user-1")).toBe(false);
        expect(executed).toEqual(before);
      } finally {
        value.close();
      }
    },
  );

  test("private source copy cannot publish after its original bootstrap authority expires", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.from([0, 255, 17, 128]);
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "source.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        body: (async function* () {
          yield bytes;
        })(),
      });
      const finalize = value.transfers.finalizeTransfer.bind(value.transfers);
      jest.spyOn(value.transfers, "finalizeTransfer").mockImplementationOnce(async (...args) => {
        value.advance(1001);
        return finalize(...args);
      });
      const input = {
        requestId: randomUUID(),
        direction: "server_to_guest" as const,
        referenceId: source.referenceId,
      };
      await expect(
        value.service.mint(
          value.capabilities.issue({ ...value.claims, expiresAt: now + 1000 }),
          input,
        ),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      const partial = value.transfers.getByRequest("user-1", input.requestId)!;
      expect(partial).toMatchObject({
        state: "reserved",
        sha256: null,
        uploadedBytes: bytes.length,
      });
      expect(readFileSync(join(value.root, partial.objectKey + ".partial")).equals(bytes)).toBe(
        true,
      );
      expect(
        readFileSync(
          join(
            value.root,
            value.transfers.getOwnedTransfer("user-1", source.referenceId)!.objectKey,
          ),
        ).equals(bytes),
      ).toBe(true);
    } finally {
      value.close();
    }
  });

  test("chunk and finalize reply loss retain the same private native receipt; status performs no guest work", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.from('{"a":1}');
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const input = {
        requestId: randomUUID(),
        direction: "guest_to_server" as const,
        size: bytes.length,
        sha256,
        fileName: "data.json",
        mimeType: "application/json",
      };
      const minted = await value.service.mint(value.capabilities.issue(value.claims), input);
      const token = minted.descriptor.capability;
      await value.service.writeChunk(token, minted.descriptor.transferId, {
        offset: 0,
        bytes,
        sha256,
      });
      await value.service.writeChunk(token, minted.descriptor.transferId, {
        offset: 0,
        bytes,
        sha256,
      });
      jest.spyOn(value.repository, "completeMetadata").mockReturnValueOnce(false);
      const first = await value.service.finalize(token, minted.descriptor.transferId);
      const pending = value.repository.getByRequest("user-1", input.requestId)!;
      expect(pending.state).toBe("reconcile_pending");
      await value.service.recover(pending);
      expect(value.repository.getByRequest("user-1", input.requestId)?.state).toBe("succeeded");
      expect(await value.service.finalize(token, minted.descriptor.transferId)).toEqual(first);
      const calls = value.probe.mock.calls.length;
      expect(
        await value.service.lookup(value.capabilities.issue(value.claims), input.requestId),
      ).toMatchObject({ scope: "private_object", receipt: { referenceId: first.referenceId } });
      expect(value.probe.mock.calls.length).toBe(calls);
      expect(
        (await value.service.mint(value.capabilities.issue(value.claims), input)).descriptor
          .transferId,
      ).toBe(first.transferId);
      const claimed = await value.transfers.claimDownload(first.referenceId);
      claimed.stream.destroy();
      await value.transfers.consume(claimed.record);
      await expect(
        value.service.mint(value.capabilities.issue(value.claims), input),
      ).rejects.toMatchObject({ code: "CODESPACE_RESULT_EXPIRED" });
    } finally {
      value.close();
    }
  });

  test("changed provider-observed life with unchanged resource generation denies a new chunk; revoked authority denies lookup", async () => {
    const value = await transferFixture();
    try {
      const bytes = Buffer.from('{"a":1}');
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const minted = await value.service.mint(value.capabilities.issue(value.claims), {
        requestId: randomUUID(),
        direction: "guest_to_server",
        size: bytes.length,
        sha256,
        fileName: "data.json",
        mimeType: "application/json",
      });
      value.setLife("c".repeat(64));
      await expect(
        value.service.writeChunk(minted.descriptor.capability, minted.descriptor.transferId, {
          offset: 0,
          bytes,
          sha256,
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(
        value.transfers.getOwnedTransfer("user-1", minted.descriptor.transferId)?.uploadedBytes,
      ).toBe(0);
      value.sqlite.prepare("UPDATE codespaceConnection SET status='disconnected'").run();
      await expect(
        value.service.lookup(value.capabilities.issue(value.claims), minted.descriptor.requestId),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
    } finally {
      value.close();
    }
  });

  test("account revocation during awaited asset verification prevents transfer admission", async () => {
    const value = await transferFixture();
    let access = true;
    const service = new CodespaceFileTransferService({
      ...value.dependencies,
      requireAccount: () => {
        if (!access)
          throw new CodespaceResourceError(
            "CODESPACE_AUTHORIZATION_REQUIRED",
            "Account access is unavailable",
          );
      },
      assets: async () => {
        await Promise.resolve();
        access = false;
        return { abi: 1, cliSha256: "b".repeat(64), workerSha256: null };
      },
    });
    try {
      const requestId = randomUUID();
      await expect(
        service.mint(value.capabilities.issue(value.claims), {
          requestId,
          direction: "guest_to_server",
          size: 0,
          sha256: createHash("sha256").digest("hex"),
          fileName: "empty.bin",
          mimeType: "application/octet-stream",
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_AUTHORIZATION_REQUIRED" });
      expect(value.repository.getByRequest("user-1", requestId)).toBeNull();
      expect(value.transfers.getByRequest("user-1", requestId)).toBeNull();
    } finally {
      value.close();
    }
  });

  test("ready empty CLI source still requires fresh final commit authority and does not report a guest upload", async () => {
    const value = await transferFixture();
    try {
      const source = await value.transfers.ingestStream("user-1", {
        fileName: "empty.bin",
        mimeType: "application/octet-stream",
        size: 0,
        body: {
          async *[Symbol.asyncIterator]() {
            yield* [];
          },
        },
      });
      const requestId = randomUUID();
      const minted = await value.service.mint(value.capabilities.issue(value.claims), {
        requestId,
        direction: "server_to_guest",
        referenceId: source.referenceId,
      });
      expect(minted.status).toMatchObject({ scope: "private_object", state: "ready", size: 0 });
      expect(value.repository.getByRequest("user-1", requestId)).toMatchObject({
        kind: "download",
        state: "succeeded",
        lastOutcome: "private_source_ready",
      });
      value.setLife("c".repeat(64));
      await expect(
        value.service.finalize(minted.descriptor.capability, minted.descriptor.transferId),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(
        await value.service.lookup(value.capabilities.issue(value.claims), requestId),
      ).toMatchObject({ scope: "private_object", state: "ready", size: 0 });
    } finally {
      value.close();
    }
  });

  test("abandoned private transfer expires and releases its operation slot without claiming a guest effect never started", async () => {
    const value = await transferFixture();
    try {
      const requestId = randomUUID();
      const minted = await value.service.mint(value.capabilities.issue(value.claims), {
        requestId,
        direction: "guest_to_server",
        size: 7,
        sha256: "a".repeat(64),
        fileName: "data.json",
        mimeType: "application/json",
      });
      value.sqlite
        .prepare("UPDATE codespaceTransfer SET expiresAt=? WHERE id=?")
        .run(now - 1, minted.descriptor.transferId);
      value.sqlite
        .prepare("UPDATE codespaceOperation SET deadlineAt=? WHERE requestId=?")
        .run(now - 1, requestId);
      await value.service.recover(value.repository.getByRequest("user-1", requestId)!);
      expect(value.repository.getByRequest("user-1", requestId)).toMatchObject({
        state: "failed",
        lastOutcome: "private_transfer_expired",
      });
      expect(value.repository.countActiveForUser("user-1")).toBe(0);
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.close();
    }
  });

  test("dedicated signed-owner HTTP budget admits two default20MiB chunk schedules and keeps invalid/IP and UI budgets separate", async () => {
    const value = await transferFixture({ ...policy, maxTransferFileBytes: 20 * 1024 * 1024 });
    try {
      const minted = await Promise.all(
        [0, 1].map(async () =>
          value.service.mint(value.capabilities.issue(value.claims), {
            requestId: randomUUID(),
            direction: "guest_to_server",
            size: 20 * 1024 * 1024,
            sha256: "a".repeat(64),
            fileName: "data.bin",
            mimeType: "application/octet-stream",
          }),
        ),
      );
      const scope = async (request: express.Request) =>
        value.service.requestRateScope(
          (request.get("authorization") ?? "").replace(/^Bearer /, ""),
          request.method,
          request.path,
        );
      const app = express();
      const files = express.Router();
      files.use(
        createCodespaceFileRateLimiter({ skipLimits: false, whitelist: [], authenticate: scope }),
      );
      // Exercise the actual HTTP limiter/admission boundary; byte I/O is covered separately by native SDK fixtures.
      files.put("/transfers/:id/chunks", async (request, response) => {
        try {
          await scope(request);
          response.sendStatus(204);
        } catch {
          response.sendStatus(403);
        }
      });
      app.use("/files", files);
      const { apiLimiter } = createRateLimiters({ skipLimits: false, whitelist: [] });
      app.get("/ui", apiLimiter, (_request, response) => response.sendStatus(204));
      const accepted = await Promise.all(
        Array.from({ length: 160 }, (_, index) => {
          const item = minted[index % 2].descriptor;
          return httpRequest(app)
            .put(`/files/transfers/${item.transferId}/chunks`)
            .set("Authorization", `Bearer ${item.capability}`);
        }),
      );
      expect(accepted.every((response) => response.status === 204)).toBe(true);
      expect(accepted[0].headers["ratelimit-limit"]).toBe("320");
      const ui = await httpRequest(app).get("/ui");
      expect(ui.status).toBe(204);
      expect(ui.headers["ratelimit-limit"]).toBe("100");
      expect(ui.headers["ratelimit-remaining"]).toBe("99");
      const invalid = await Promise.all(
        Array.from({ length: 101 }, (_, index) =>
          httpRequest(app)
            .put(`/files/transfers/${randomUUID()}/chunks`)
            .set(
              "Authorization",
              `Bearer ${index % 2 ? minted[0].descriptor.capability : "invalid"}`,
            ),
        ),
      );
      expect(invalid.filter((response) => response.status === 403)).toHaveLength(100);
      expect(invalid.filter((response) => response.status === 429)).toHaveLength(1);
      const valid = minted[0].descriptor;
      expect(
        (
          await httpRequest(app)
            .put(`/files/transfers/${valid.transferId}/chunks`)
            .set("Authorization", `Bearer ${valid.capability}`)
        ).status,
      ).toBe(204);
      // Each mint checks fresh authority before admission and after any coalesced wait.
      expect(value.probe.mock.calls).toHaveLength(4);
    } finally {
      value.close();
    }
  });

  test("changed concurrent native request is refused before joining the first unresolved request", async () => {
    const value = await transferFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.probe.mockImplementationOnce(async () => {
      await held;
      throw new Error("Controlled provider remains unavailable");
    });
    try {
      const requestId = randomUUID();
      const first = value.service.uploadReference("user-1", "codespace-1", {
        requestId,
        path: "first.json",
        reference: {
          fileId: "file_ABC",
          downloadUrl: "https://example.test/file",
          fileName: "data.json",
          mimeType: "application/json",
          declaredSize: 7,
        },
        expected: { exists: false },
      });
      const observed = first.catch((error: unknown) => error);
      await expect(
        value.service.uploadReference("user-1", "codespace-1", {
          requestId,
          path: "changed.json",
          reference: {
            fileId: "file_ABC",
            downloadUrl: "https://example.test/file",
            fileName: "data.json",
            mimeType: "application/json",
            declaredSize: 7,
          },
          expected: { exists: false },
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_RESOURCE_INVALID" });
      release();
      expect(await observed).toBeInstanceOf(Error);
    } finally {
      release();
      value.close();
    }
  });

  test("retry after failed private-intent attachment reuses the original native reservation", async () => {
    const value = await transferFixture();
    try {
      const input = {
        requestId: randomUUID(),
        path: "data.json",
        reference: {
          fileId: "file_ABC",
          downloadUrl: "https://example.test/file",
          fileName: "data.json",
          mimeType: "application/json",
          declaredSize: 7,
        },
        expected: { exists: false },
      };
      const attach = jest.spyOn(value.repository, "attachInput").mockReturnValueOnce(false);
      await expect(
        value.service.uploadReference("user-1", "codespace-1", input),
      ).rejects.toMatchObject({ code: "CODESPACE_PROVIDER_UNAVAILABLE" });
      const original = value.repository.getByRequest("user-1", input.requestId)!;
      expect(original.inputReference).toBeNull();
      const retried = await value.service.uploadReference("user-1", "codespace-1", input);
      expect(retried.operation.id).toBe(original.id);
      expect(retried.operation.inputReference).not.toBeNull();
      expect(attach).toHaveBeenCalledTimes(2);
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.close();
    }
  });

  test("legacy running maintenance ACK is collected and installer reservation already contains its immutable intent", async () => {
    const value = await transferFixture();
    const executed = new Map<string, string>();
    const calls: string[] = [];
    const fixed = (command: string) => ({
      argv: [command],
      stdin: new Uint8Array(),
      timeoutMs: 60000,
      maxStdoutBytes: 16384,
      maxStderrBytes: 4096,
      maxRetainedBytes: 65536,
    });
    const service = new CodespaceFileTransferService({
      ...value.dependencies,
      policy: () => ({ ...policy, maxConcurrentOperationsPerUser: 1 }),
      lifeProbe: () => fixed("controlled-life-probe"),
      installer: async () => fixed("controlled-installer"),
      transport: {
        ...value.dependencies.transport,
        execute: async (_credential, _codespace, operation, request) => {
          expect(operation.requestDigest).toBeNull();
          const command = request.argv![0];
          calls.push(command);
          executed.set(operation.id, command);
          return { state: "running" };
        },
        inspect: async (_credential, _codespace, operation) => {
          expect(operation.requestDigest).toBeNull();
          const stdout = JSON.stringify(
            executed.get(operation.id) === "controlled-life-probe"
              ? { environmentIdentity: "a".repeat(64) }
              : {
                  abi: 1,
                  environmentIdentity: "a".repeat(64),
                  workerSha256: null,
                  cliSha256: "b".repeat(64),
                  command: "/home/controlled/.local/bin/moira-files",
                  executableSha256: "b".repeat(64),
                },
          );
          return {
            state: "succeeded",
            stdout,
            stderr: "",
            exitCode: 0,
            stdoutTotalBytes: Buffer.byteLength(stdout),
            stderrTotalBytes: 0,
            outputLimitExceeded: false,
            sessionCaptureDropped: false,
          };
        },
      },
    });
    try {
      const requestId = randomUUID();
      const pending = await service.setup("user-1", "codespace-1", { requestId });
      const accepted = value.repository.getByRequest("user-1", requestId)!;
      expect(pending.provisioned).toBe(false);
      expect(pending.command).toBeNull();
      expect(accepted.state).toBe("reserved");
      expect(accepted.inputReference).not.toBeNull();
      expect(value.repository.countActiveForUser("user-1")).toBe(1);
      const claimed = value.repository.claimDue("setup-claim", now, now + 5000)!;
      expect(claimed.id).toBe(accepted.id);
      await service.recover(claimed);
      const ready = await service.setup("user-1", "codespace-1", { requestId });
      expect(ready).toMatchObject({
        operationId: accepted.id,
        provisioned: true,
        abi: 1,
        command: "/home/controlled/.local/bin/moira-files",
        executableSha256: "b".repeat(64),
      });
      expect(calls).toEqual(["controlled-life-probe", "controlled-installer"]);
      expect(value.repository.countActiveForUser("user-1")).toBe(0);
      value.setLife("c".repeat(64));
      await expect(service.setup("user-1", "codespace-1", { requestId })).rejects.toMatchObject({
        code: "CODESPACE_GENERATION_CONFLICT",
      });
      const newRequest = randomUUID();
      await expect(
        service.uploadReference("user-1", "codespace-1", {
          requestId: newRequest,
          path: "data.json",
          reference: {
            fileId: "file_ABC",
            downloadUrl: "https://example.test/file",
            declaredSize: 7,
          },
          expected: { exists: false },
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(value.repository.getByRequest("user-1", newRequest)).toBeNull();
      expect(await value.commands.reconcile("user-1", accepted.id)).toMatchObject({
        state: "succeeded",
        exitCode: 0,
      });
      expect(calls).toEqual(["controlled-life-probe", "controlled-installer"]);
    } finally {
      value.close();
    }
  });

  test("command cancellation refuses a native file identity without mutating its accepted state", async () => {
    const value = await transferFixture();
    try {
      const requestId = randomUUID();
      await value.service.mint(value.capabilities.issue(value.claims), {
        requestId,
        direction: "guest_to_server",
        size: 7,
        sha256: "a".repeat(64),
        fileName: "data.json",
        mimeType: "application/json",
      });
      const original = value.repository.getByRequest("user-1", requestId)!;
      await expect(value.commands.cancel("user-1", original.id)).rejects.toMatchObject({
        code: "CODESPACE_NOT_FOUND",
      });
      expect(value.repository.getByRequest("user-1", requestId)?.state).toBe(original.state);
    } finally {
      value.close();
    }
  });

  test.each([
    { command: "moira-files", executableSha256: "b".repeat(64) },
    { command: "/home/controlled/.local/bin/moira-files", executableSha256: "c".repeat(64) },
    { command: "/home/controlled/.local/bin/moira-files", executableSha256: null },
  ])(
    "new upload refuses unverified executable even when client.mjs matches: %j",
    async (executable) => {
      const value = await transferFixture();
      try {
        value.probe.mockResolvedValueOnce({
          abi: 1,
          environmentIdentity: "a".repeat(64),
          workerSha256: null,
          cliSha256: "b".repeat(64),
          ...executable,
        });
        const requestId = randomUUID();
        await expect(
          value.service.uploadReference("user-1", "codespace-1", {
            requestId,
            path: "data.json",
            reference: {
              fileId: "file_ABC",
              downloadUrl: "https://example.test/file",
              declaredSize: 7,
            },
            expected: { exists: false },
          }),
        ).rejects.toMatchObject({ code: "CODESPACE_LOCAL_SETUP_INCOMPLETE" });
        expect(value.repository.getByRequest("user-1", requestId)).toBeNull();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
      } finally {
        value.close();
      }
    },
  );
});

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
  test.each(["direct", "scheduled"] as const)(
    "an absent %s inspection overtaking first delivery preserves the eventual actual file effect",
    async (boundary) => {
      const value = fixture(true);
      const root = mkdtempSync(join(tmpdir(), "moira-delayed-first-file-"));
      const admissionPolicy = { ...policy, maxOperationMs: 120_000 };
      const service = new CodespaceFileService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => admissionPolicy,
        now: value.now,
        delay: value.delay,
      });
      const target = join(root, "effect.txt");
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let entered!: (operationId: string) => void;
      const delivered = new Promise<string>((done) => {
        entered = done;
      });
      value.transport.executeFile = async (_credential, _resource, operation) => {
        entered(operation.id);
        await held;
        appendFileSync(target, "one effect\n");
        return value.transport.result;
      };
      value.transport.inspectFile = async () => ({ state: "absent" });
      const pending = service.execute("user-1", "codespace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("abc"),
        expected: { exists: false },
      });
      try {
        const operationId = await delivered;
        if (boundary === "direct") await service.reconcile("user-1", operationId);
        else {
          // The first delivery owns a sixty-second crash-recovery claim. Let it
          // expire so the actual scheduled inspector can overtake that held frame.
          await value.delay(60_001);
          const operations = new CodespaceOperationService({
            repository: value.repository,
            credentials: value.credentials,
            policy: () => admissionPolicy,
            now: value.now,
            transport: Object.assign(value.transport, {
              execute: async () => ({ state: "running" as const }),
              inspect: async () => ({ state: "absent" as const }),
              cancel: async () => ({ state: "absent" as const }),
              finalize: async () => {},
              readOutput: async () => ({ state: "absent" as const }),
            }),
          });
          await operations.reconcileOnce("user-1");
        }
        const observedBeforeEffect = value.repository.getOwned("user-1", operationId)!;
        release();
        const completed = await pending;
        expect(readFileSync(target, "utf8")).toBe("one effect\n");
        expect(observedBeforeEffect.state).toBe("reconcile_pending");
        expect(completed).toMatchObject({
          operation: { id: operationId, state: "succeeded" },
          result: value.transport.result,
        });
      } finally {
        release();
        await pending;
        value.sqlite.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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
    const transferRepository = new CodespaceTransferRepository(value.sqlite);
    const renewClaim = transferRepository.renewClaim.bind(transferRepository);
    jest
      .spyOn(transferRepository, "renewClaim")
      .mockImplementation((id, claimId, at, expiresAt) => {
        currentNow += 1;
        return renewClaim(id, claimId, at + 1, expiresAt + 1);
      });
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
      repository: transferRepository,
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
      expect(transferRepository.renewClaim).toHaveBeenCalled();
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

  test("preserves an absent file outcome while admitting independent work", async () => {
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
        operation: { state: "reconcile_pending", outputBytes: 0 },
        result: null,
      });
      // Missing evidence is not a codespace lock; independent work still fits its quota.
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
