import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceFileService,
  WorkspaceOperationRepository,
  WorkspaceResourceRepository,
  WorkspaceTransferRepository,
  WorkspaceTransferService,
  type WorkspaceFileResult,
  type WorkspaceFileTransport,
  type WorkspaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = resolve(process.cwd(), "packages/web-backend/drizzle");
const now = 1_788_900_000_000;
const policy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 2,
  maxActiveGlobal: 10,
  maxOperationsPerDay: 20,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  maxConcurrentOperationsPerUser: 2,
  maxConcurrentOperationsGlobal: 4,
  maxOperationMs: 60_000,
  maxTransferFileBytes: 1024,
};

class FakeFileTransport implements WorkspaceFileTransport {
  result: WorkspaceFileResult = {
    action: "write",
    path: "src/file.bin",
    previous: null,
    current: { size: 3, sha256: "a".repeat(64), modifiedAt: now },
  };
  throwExecute = false;
  executeCalls = jest.fn();
  inspectCalls = jest.fn();
  lastRequest: Parameters<WorkspaceFileTransport["executeFile"]>[3] | null = null;

  async executeFile(
    _credential: string,
    _workspace: Parameters<WorkspaceFileTransport["executeFile"]>[1],
    _operation: Parameters<WorkspaceFileTransport["executeFile"]>[2],
    request: Parameters<WorkspaceFileTransport["executeFile"]>[3],
  ) {
    this.executeCalls();
    this.lastRequest = request;
    if (this.throwExecute) throw new Error("response lost");
    return this.result;
  }

  async inspectFile() {
    this.inspectCalls();
    return this.result;
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
  const transport = new FakeFileTransport();
  const credentials = { getCredential: jest.fn(async () => "ghu_access") };
  const service = new WorkspaceFileService({
    repository,
    transport,
    credentials,
    policy: () => policy,
    now: () => now,
  });
  return { sqlite, repository, transport, credentials, service };
}

describe("durable workspace file operations", () => {
  test("moves native upload and download bytes through private single-use storage", async () => {
    const value = fixture();
    const root = mkdtempSync(join(tmpdir(), "moira-file-lifecycle-transfer-"));
    const transfers = new WorkspaceTransferService({
      repository: new WorkspaceTransferRepository(value.sqlite),
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
    const service = new WorkspaceFileService({
      repository: value.repository,
      transport: value.transport,
      credentials: value.credentials,
      policy: () => policy,
      now: () => now,
      transfers,
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
    const executeFile = value.transport.executeFile.bind(value.transport);
    value.transport.executeFile = async (...args) => {
      const transferState = value.sqlite
        .prepare("SELECT purpose, state, declaredSize FROM workspaceTransfer")
        .all();
      expect(transferState).toEqual(
        args[3].action === "download"
          ? [{ purpose: "workspace_download", state: "reserved", declaredSize: 1024 }]
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
      await service.uploadReference("user-1", "workspace-1", {
        path: "input.bin",
        expected: { exists: false },
        reference: {
          fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
          downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=secret",
          fileName: "input.bin",
          mimeType: "application/octet-stream",
          declaredSize: bytes.length,
        },
      });
      expect(value.transport.lastRequest).toMatchObject({ action: "upload", path: "input.bin" });
      expect((value.transport.lastRequest as { bytes: Uint8Array }).bytes).toEqual(bytes);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
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
      const download = await service.downloadReference("user-1", "workspace-1", {
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
  });

  test.each([
    [
      "invalid path",
      "user-1",
      "workspace-1",
      (_value: ReturnType<typeof fixture>) => undefined,
      "../input.bin",
    ],
    [
      "foreign",
      "user-2",
      "workspace-1",
      (_value: ReturnType<typeof fixture>) => undefined,
      "input.bin",
    ],
    [
      "missing",
      "user-1",
      "workspace-missing",
      (_value: ReturnType<typeof fixture>) => undefined,
      "input.bin",
    ],
    [
      "stopped",
      "user-1",
      "workspace-1",
      (value: ReturnType<typeof fixture>) => {
        value.sqlite
          .prepare(
            "UPDATE workspaceResource SET state = 'stopped', desiredState = 'stopped' WHERE id = 'workspace-1'",
          )
          .run();
      },
      "input.bin",
    ],
    [
      "disabled",
      "user-1",
      "workspace-1",
      (value: ReturnType<typeof fixture>) => {
        new WorkspaceResourceRepository(value.sqlite).setControl({
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
      "workspace-1",
      (value: ReturnType<typeof fixture>) => {
        value.repository.reserve({
          userId: "user-1",
          resourceId: "workspace-1",
          kind: "exec",
          inputBytes: 0,
          stdoutLimitBytes: 16,
          stderrLimitBytes: 16,
          deadlineAt: now + 30_000,
          policy,
          now,
        });
      },
      "input.bin",
    ],
  ] as const)(
    "rejects a %s upload before native fetch or downstream contact",
    async (_caseName, userId, workspaceId, arrange, uploadPath) => {
      const value = fixture();
      const root = mkdtempSync(join(tmpdir(), "moira-file-upload-authority-"));
      const nativeFetch = jest.fn(async () => ({
        contentLength: 1,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from([1]);
        })(),
      }));
      const transfers = new WorkspaceTransferService({
        repository: new WorkspaceTransferRepository(value.sqlite),
        root,
        policy: () => policy,
        now: () => now,
      });
      const service = new WorkspaceFileService({
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
          service.uploadReference(userId, workspaceId, {
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
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
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
    "generation-change",
    "reservation-expiry",
    "begin-dispatch-rejection",
    "credential-failure",
  ] as const)("removes native upload bytes after %s before provider dispatch", async (failure) => {
    const value = fixture();
    const root = mkdtempSync(join(tmpdir(), "moira-file-upload-cancel-"));
    let currentNow = now;
    const bytes = Buffer.from([1, 2, 3]);
    const credentials = {
      getCredential: jest.fn(async () => {
        if (failure === "credential-failure") throw new Error("credential unavailable");
        if (failure === "begin-dispatch-rejection") {
          value.sqlite
            .prepare("UPDATE workspaceResource SET generation = 2 WHERE id = 'workspace-1'")
            .run();
        }
        return "ghu_access";
      }),
    };
    const transfers = new WorkspaceTransferService({
      repository: new WorkspaceTransferRepository(value.sqlite),
      root,
      policy: () => ({ ...policy, transferTtlMs: 120_000 }),
      now: () => currentNow,
    });
    const service = new WorkspaceFileService({
      repository: value.repository,
      transport: value.transport,
      credentials,
      policy: () => policy,
      now: () => currentNow,
      transfers,
      nativeFetcher: {
        fetch: async () => {
          if (failure === "generation-change") {
            value.sqlite
              .prepare(
                "UPDATE workspaceResource SET desiredState = 'stopped' WHERE id = 'workspace-1'",
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
      await expect(
        service.uploadReference("user-1", "workspace-1", {
          path: "input.bin",
          expected: { exists: false },
          reference: {
            fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
            downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=private",
            fileName: "input.bin",
            mimeType: "application/octet-stream",
            declaredSize: bytes.length,
          },
        }),
      ).resolves.toMatchObject({ operation: { state: "cancelled" }, result: null });
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
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
        value.service.execute("user-1", "workspace-1", {
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
        code: "WORKSPACE_FILE_REJECTED",
      };
      await expect(
        value.service.execute("user-1", "workspace-1", {
          action: "read",
          path: "missing.bin",
          offset: 0,
          length: 1,
        }),
      ).resolves.toMatchObject({
        operation: { state: "failed", outputBytes: 0 },
        result: { action: "read", state: "failed", code: "WORKSPACE_FILE_REJECTED" },
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
      const transferPolicy: WorkspaceResourcePolicy = {
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
      const transfers = new WorkspaceTransferService({
        repository: new WorkspaceTransferRepository(value.sqlite),
        root,
        policy: () => transferPolicy,
        now: () => now,
      });
      transfers.reserveDownload(reservationUser, {
        fileName: "existing.bin",
        mimeType: "application/octet-stream",
        maxBytes: 4,
      });
      const service = new WorkspaceFileService({
        repository: value.repository,
        transport: value.transport,
        credentials: value.credentials,
        policy: () => policy,
        now: () => now,
        transfers,
      });
      try {
        await expect(
          service.downloadReference("user-1", "workspace-1", {
            path: "output.bin",
            maxBytes: 4,
            fileName: "output.bin",
            mimeType: "application/octet-stream",
          }),
        ).rejects.toMatchObject({ code: "WORKSPACE_POLICY_LIMIT" });
        expect(value.credentials.getCredential).not.toHaveBeenCalled();
        expect(value.transport.executeCalls).not.toHaveBeenCalled();
        expect(value.repository.listOwned("user-1", "workspace-1")).toEqual([
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

  test("writes through the exact workspace generation without persisting path or bytes", async () => {
    const value = fixture();
    try {
      const result = await value.service.execute("user-1", "workspace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from([0, 255, 1]),
        expected: { exists: false },
      });
      expect(result).toMatchObject({
        operation: { kind: "write", state: "succeeded", inputBytes: 3 },
        result: { action: "write", path: "src/file.bin" },
      });
      const stored = value.sqlite.prepare("SELECT * FROM workspaceOperation").get() as object;
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
      const pending = await value.service.execute("user-1", "workspace-1", {
        action: "write",
        path: "src/file.bin",
        bytes: Buffer.from("new"),
        expected: { exists: false },
      });
      expect(pending).toMatchObject({ operation: { state: "reconcile_pending" }, result: null });
      value.transport.throwExecute = false;
      const restarted = new WorkspaceFileService({
        repository: new WorkspaceOperationRepository(value.sqlite),
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

  test("rejects traversal and cross-tenant replay before credential or transport contact", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.execute("user-1", "workspace-1", { action: "stat", path: "../secret" }),
      ).rejects.toThrow(/path/);
      await expect(
        value.service.execute("user-2", "workspace-1", { action: "stat", path: "src" }),
      ).rejects.toThrow(/cannot be started/);
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects a mutating file operation while the same workspace has active work", async () => {
    const value = fixture();
    try {
      value.repository.reserve({
        userId: "user-1",
        resourceId: "workspace-1",
        kind: "exec",
        inputBytes: 0,
        stdoutLimitBytes: 10,
        stderrLimitBytes: 10,
        deadlineAt: now + 10_000,
        policy,
        now,
      });
      await expect(
        value.service.execute("user-1", "workspace-1", {
          action: "write",
          path: "file.txt",
          bytes: Buffer.from("new"),
          expected: { exists: false },
        }),
      ).rejects.toThrow(/cannot be started/);
      expect(value.credentials.getCredential).not.toHaveBeenCalled();
      expect(value.transport.executeCalls).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
});
