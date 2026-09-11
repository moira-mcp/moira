import { afterEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WorkspaceTransferRepository,
  WorkspaceTransferService,
  type WorkspaceNativeReferenceFetcher,
  type WorkspaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = resolve(process.cwd(), "packages/web-backend/drizzle");
const roots: string[] = [];

function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
}
const basePolicy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8,
  maxStorageBytes: 32,
  maxActivePerUser: 1,
  maxActiveGlobal: 4,
  maxOperationsPerDay: 10,
  createThrottleMs: 1,
  remoteTtlMs: 1,
  createDeadlineMs: 1,
  cleanupDeadlineMs: 1,
  claimLeaseMs: 30_000,
  reconcileIntervalMs: 1,
  maxTransferFileBytes: 1024,
  maxTransferBytesPerUser: 1024,
  maxTransferBytesGlobal: 2048,
  maxTransferObjectsPerUser: 2,
  maxTransferObjectsGlobal: 4,
  maxTransferInflightBytesPerUser: 1024,
  maxTransferInflightBytesGlobal: 2048,
  transferTtlMs: 60_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Partial<WorkspaceResourcePolicy> = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(`INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES
    ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
    ('user-2', 'two@example.test', 'user-two', 'now', 'now')`);
  const root = mkdtempSync(join(tmpdir(), "moira-workspace-transfer-"));
  roots.push(root);
  let now = 1_800_000_000_000;
  const repository = new WorkspaceTransferRepository(sqlite);
  const service = new WorkspaceTransferService({
    repository,
    root,
    policy: () => ({ ...basePolicy, ...overrides }),
    now: () => now,
  });
  return { sqlite, repository, service, root, advance: (value: number) => (now += value) };
}

const reference = {
  fileId: "sediment://file_000000000b1c8210a7cb1a2d896b2ee4",
  downloadUrl: "https://oaisdmntprdenmarkeast.blob.core.windows.net/container/file?sig=private",
  fileName: "input.bin",
  mimeType: "application/octet-stream",
  declaredSize: 5,
};

const tarBytes = Buffer.alloc(265);
tarBytes.write("ustar", 257, "ascii");
const mimeCases = [
  ["application/octet-stream", Buffer.from([0, 255]), Buffer.from([0, 255])],
  ["text/plain", Buffer.from("hello"), Buffer.from([255])],
  ["application/json", Buffer.from('{"ok":true}'), Buffer.from("not-json")],
  ["application/pdf", Buffer.from("%PDF-1.7\n"), Buffer.from("not-pdf")],
  ["application/zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not-zip")],
  ["application/gzip", Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from("not-gzip")],
  ["application/x-tar", tarBytes, Buffer.alloc(265)],
  [
    "image/png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("not-png"),
  ],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("not-jpeg")],
  ["image/gif", Buffer.from("GIF89a"), Buffer.from("not-gif")],
  ["image/webp", Buffer.from("RIFF0000WEBP"), Buffer.from("not-webp")],
] as const;

function fetcher(bytes = Buffer.from([0, 255, 1, 2, 3])): WorkspaceNativeReferenceFetcher {
  return {
    fetch: jest.fn(async () => ({
      contentLength: bytes.length,
      mimeType: "application/octet-stream",
      body: (async function* () {
        yield bytes.subarray(0, 2);
        yield bytes.subarray(2);
      })(),
    })),
  };
}

describe("private workspace transfer service", () => {
  test("accepts the documented raw file ID without treating it as download authority", async () => {
    const value = fixture();
    const source = fetcher();
    const fileId = "file_000000000b1c8210a7cb1a2d896b2ee4";
    try {
      const handle = await value.service.ingest(
        "user-1",
        { fileId, downloadUrl: reference.downloadUrl },
        source,
      );
      expect(source.fetch).toHaveBeenCalledWith({ fileId, downloadUrl: reference.downloadUrl });
      const claimed = await value.service.claimInput("user-1", handle.referenceId);
      expect(claimed.bytes).toEqual(Buffer.from([0, 255, 1, 2, 3]));
      await value.service.consume(claimed.record);
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    "file_",
    "https://file_123",
    "sediment://other_123",
    "file_../secret",
    `file_${"a".repeat(256)}`,
  ])("rejects invalid native file identifier %s before fetching", async (fileId) => {
    const value = fixture();
    const source = fetcher();
    try {
      await expect(
        value.service.ingest("user-1", { fileId, downloadUrl: reference.downloadUrl }, source),
      ).rejects.toThrow(/identifier/);
      expect(source.fetch).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test.each([null, 9])(
    "reserves unknown native size before fetching and publishes resolved metadata (length %s)",
    async (contentLength) => {
      const value = fixture();
      const bytes = Buffer.from("%PDF-1.7\n");
      const cancel = jest.fn();
      try {
        const handle = await value.service.ingest(
          "user-1",
          {
            fileId: reference.fileId,
            downloadUrl: reference.downloadUrl,
          },
          {
            fetch: async () => {
              expect(
                value.sqlite
                  .prepare("SELECT state, declaredSize, fileName, mimeType FROM workspaceTransfer")
                  .get(),
              ).toEqual({
                state: "reserved",
                declaredSize: 1024,
                fileName: "attachment.bin",
                mimeType: "application/octet-stream",
              });
              return {
                contentLength,
                mimeType: "application/pdf; charset=binary",
                body: (async function* () {
                  yield bytes;
                })(),
                cancel,
              };
            },
          },
        );
        expect(handle).toMatchObject({
          size: 9,
          fileName: "attachment.bin",
          mimeType: "application/pdf",
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        expect(
          value.sqlite
            .prepare("SELECT state, declaredSize, observedSize, mimeType FROM workspaceTransfer")
            .get(),
        ).toEqual({
          state: "ready",
          declaredSize: 9,
          observedSize: 9,
          mimeType: "application/pdf",
        });
        expect(cancel).toHaveBeenCalledTimes(1);
        const claimed = await value.service.claimInput("user-1", handle.referenceId);
        expect(claimed.bytes).toEqual(bytes);
        expect(claimed.record.mimeType).toBe("application/pdf");
        await value.service.consume(claimed.record);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("bounds metadata-free native input by the caller's reserved capacity", async () => {
    const value = fixture();
    try {
      const source = fetcher();
      const fetch = source.fetch;
      source.fetch = async (input) => {
        expect(value.sqlite.prepare("SELECT declaredSize FROM workspaceTransfer").get()).toEqual({
          declaredSize: 8,
        });
        return fetch(input);
      };
      const handle = await value.service.ingest(
        "user-1",
        { fileId: reference.fileId, downloadUrl: reference.downloadUrl },
        source,
        8,
      );
      expect(handle).toMatchObject({
        size: 5,
        mimeType: "application/octet-stream",
        fileName: "attachment.bin",
      });
      const claimed = await value.service.claimInput("user-1", handle.referenceId);
      expect(claimed.bytes).toEqual(Buffer.from([0, 255, 1, 2, 3]));
      await value.service.consume(claimed.record);
      const rejected = fetcher();
      await expect(value.service.ingest("user-1", reference, rejected, 4)).rejects.toThrow(/limit/);
      expect(rejected.fetch).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test.each([
    { maxTransferBytesPerUser: 512 },
    { maxTransferBytesGlobal: 512 },
    { maxTransferInflightBytesPerUser: 512 },
    { maxTransferInflightBytesGlobal: 512 },
  ])(
    "rejects unknown-size input before fetching when highwater reservation exceeds %j",
    async (limits) => {
      const value = fixture(limits);
      const source = fetcher();
      try {
        await expect(
          value.service.ingest(
            "user-1",
            { fileId: reference.fileId, downloadUrl: reference.downloadUrl },
            source,
          ),
        ).rejects.toThrow(/quota/);
        expect(source.fetch).not.toHaveBeenCalled();
        expect(value.repository.listLive()).toEqual([]);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each([
    [1025, 0, "application/octet-stream", "limit", false],
    [null, 1025, "application/octet-stream", "limit", true],
    [3, 4, "application/octet-stream", "size mismatch", true],
    [null, 4, "application/pdf", "MIME type", true],
    [null, 4, "application/x-executable", "metadata mismatch", false],
    [null, 4, "", "metadata mismatch", false],
  ] as const)(
    "rejects invalid unknown-size body (%s/%s/%s) and cancels the source",
    async (contentLength, actualBytes, mimeType, error, consumesBody) => {
      const value = fixture();
      const readBody = jest.fn();
      const cancel = jest.fn();
      try {
        await expect(
          value.service.ingest(
            "user-1",
            { fileId: reference.fileId, downloadUrl: reference.downloadUrl },
            {
              fetch: async () => ({
                contentLength,
                mimeType,
                cancel,
                body: (async function* () {
                  readBody();
                  yield Buffer.alloc(actualBytes);
                })(),
              }),
            },
          ),
        ).rejects.toThrow(error);
        expect(readBody).toHaveBeenCalledTimes(consumesBody ? 1 : 0);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(value.repository.listLive()).toEqual([]);
        expect(readdirSync(value.root)).toEqual([]);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each(mimeCases)(
    "accepts %s only when bytes match its content contract",
    async (mimeType, valid, _invalid) => {
      const value = fixture();
      try {
        const handle = await value.service.createDownload("user-1", {
          fileName: "result.bin",
          mimeType,
          bytes: valid,
        });
        const claimed = await value.service.claimDownload(handle.referenceId);
        const chunks: Buffer[] = [];
        for await (const chunk of claimed.stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(valid);
        await value.service.consume(claimed.record);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each(mimeCases.filter(([mimeType]) => mimeType !== "application/octet-stream"))(
    "rejects %s when bytes do not match its content contract",
    async (mimeType, _valid, invalid) => {
      const value = fixture();
      try {
        await expect(
          value.service.createDownload("user-1", {
            fileName: "result.bin",
            mimeType,
            bytes: invalid,
          }),
        ).rejects.toThrow(/MIME type/);
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
          count: 0,
        });
        expect(readdirSync(value.root)).toEqual([]);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("stores exact native bytes behind a digest-only tenant-bound single-use reference", async () => {
    const value = fixture();
    try {
      const handle = await value.service.ingest("user-1", reference, fetcher());
      const stored = value.sqlite.prepare("SELECT * FROM workspaceTransfer").get() as Record<
        string,
        unknown
      >;
      expect(stored.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(
        handle.referenceId.slice("workspace-file://".length),
      );
      expect(JSON.stringify(stored)).not.toContain(reference.downloadUrl);
      await expect(value.service.claimInput("user-2", handle.referenceId)).rejects.toThrow(
        /unavailable/,
      );
      const claimed = await value.service.claimInput("user-1", handle.referenceId);
      expect(claimed.bytes).toEqual(Buffer.from([0, 255, 1, 2, 3]));
      await value.service.consume(claimed.record);
      await expect(value.service.claimInput("user-1", handle.referenceId)).rejects.toThrow(
        /unavailable/,
      );
      const expiring = await value.service.ingest("user-1", reference, fetcher());
      value.advance(60_001);
      await expect(value.service.claimInput("user-1", expiring.referenceId)).rejects.toThrow(
        /unavailable/,
      );
      await value.service.cleanup();
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("removes partial bytes and reservation on declared-size or MIME mismatch", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.ingest("user-1", reference, {
          fetch: async () => ({
            contentLength: 5,
            mimeType: "application/octet-stream",
            body: (async function* () {
              yield Buffer.from("tiny");
            })(),
          }),
        }),
      ).rejects.toThrow(/size mismatch/);
      await expect(
        value.service.ingest("user-1", reference, {
          fetch: async () => ({
            contentLength: 5,
            mimeType: "text/plain",
            body: (async function* () {
              yield Buffer.alloc(5);
            })(),
          }),
        }),
      ).rejects.toThrow(/metadata mismatch/);
      await expect(
        value.service.ingest(
          "user-1",
          {
            ...reference,
            fileName: "document.pdf",
            mimeType: "application/pdf",
            declaredSize: 7,
          },
          {
            fetch: async () => ({
              contentLength: 7,
              mimeType: "application/pdf",
              body: (async function* () {
                yield Buffer.from("not-pdf");
              })(),
            }),
          },
        ),
      ).rejects.toThrow(/MIME type/);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("expires a slow native body and removes its partial reservation", async () => {
    const value = fixture();
    try {
      await expect(
        value.service.ingest("user-1", reference, {
          fetch: async () => ({
            contentLength: 5,
            mimeType: "application/octet-stream",
            body: (async function* () {
              yield Buffer.from([0, 1]);
              value.advance(60_001);
              yield Buffer.from([2, 3, 4]);
            })(),
          }),
        }),
      ).rejects.toThrow(/expired/);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("rejects aggregate and in-flight quotas before invoking the native fetcher", async () => {
    const value = fixture({ maxTransferInflightBytesPerUser: 4 });
    const source = fetcher();
    try {
      await expect(value.service.ingest("user-1", reference, source)).rejects.toThrow(/quota/);
      expect(source.fetch).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("reserves per-user and global object ceilings before a second source request", async () => {
    const value = fixture({ maxTransferObjectsPerUser: 1, maxTransferObjectsGlobal: 2 });
    try {
      await value.service.ingest("user-1", reference, fetcher());
      const sameUser = fetcher();
      await expect(value.service.ingest("user-1", reference, sameUser)).rejects.toThrow(/quota/);
      expect(sameUser.fetch).not.toHaveBeenCalled();
      await value.service.ingest("user-2", reference, fetcher());
      const global = fetcher();
      await expect(value.service.ingest("user-2", reference, global)).rejects.toThrow(/quota/);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });

  test("enforces user/global aggregate bytes and global in-flight bytes before fetching", async () => {
    const smallReference = { ...reference, declaredSize: 3 };
    const threeBytes = fetcher(Buffer.from([1, 2, 3]));
    const perUser = fixture({
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 5,
      maxTransferBytesGlobal: 20,
      maxTransferInflightBytesPerUser: 20,
      maxTransferInflightBytesGlobal: 20,
    });
    try {
      await perUser.service.ingest("user-1", smallReference, threeBytes);
      const rejected = fetcher(Buffer.from([1, 2, 3]));
      await expect(perUser.service.ingest("user-1", smallReference, rejected)).rejects.toThrow(
        /quota/,
      );
      expect(rejected.fetch).not.toHaveBeenCalled();
    } finally {
      perUser.sqlite.close();
    }

    const global = fixture({
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 10,
      maxTransferBytesGlobal: 5,
      maxTransferInflightBytesPerUser: 20,
      maxTransferInflightBytesGlobal: 20,
    });
    try {
      await global.service.ingest("user-1", smallReference, fetcher(Buffer.from([1, 2, 3])));
      const rejected = fetcher(Buffer.from([1, 2, 3]));
      await expect(global.service.ingest("user-2", smallReference, rejected)).rejects.toThrow(
        /quota/,
      );
      expect(rejected.fetch).not.toHaveBeenCalled();
    } finally {
      global.sqlite.close();
    }

    const inflight = fixture({
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 20,
      maxTransferBytesGlobal: 20,
      maxTransferInflightBytesPerUser: 20,
      maxTransferInflightBytesGlobal: 5,
    });
    let releaseFetch!: (
      value: Awaited<ReturnType<WorkspaceNativeReferenceFetcher["fetch"]>>,
    ) => void;
    const blockedResponse = new Promise<
      Awaited<ReturnType<WorkspaceNativeReferenceFetcher["fetch"]>>
    >((resolveFetch) => {
      releaseFetch = resolveFetch;
    });
    try {
      const first = inflight.service.ingest("user-1", smallReference, {
        fetch: () => blockedResponse,
      });
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      const rejected = fetcher(Buffer.from([1, 2, 3]));
      await expect(inflight.service.ingest("user-2", smallReference, rejected)).rejects.toThrow(
        /quota/,
      );
      expect(rejected.fetch).not.toHaveBeenCalled();
      releaseFetch({
        contentLength: 3,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from([1, 2, 3]);
        })(),
      });
      await first;
    } finally {
      inflight.sqlite.close();
    }
  });

  test("rejects unsupported MIME and unsafe filenames before reserving or fetching", async () => {
    const value = fixture();
    const source = fetcher();
    try {
      await expect(
        value.service.ingest(
          "user-1",
          { ...reference, mimeType: "application/x-executable" },
          source,
        ),
      ).rejects.toThrow(/metadata/);
      await expect(
        value.service.ingest("user-1", { ...reference, fileName: "../secret.bin" }, source),
      ).rejects.toThrow(/metadata/);
      await expect(
        value.service.ingest("user-1", { ...reference, fileName: "" }, source),
      ).rejects.toThrow(/metadata/);
      expect(source.fetch).not.toHaveBeenCalled();
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
    } finally {
      value.sqlite.close();
    }
  });

  test("serves an outbound object once and removes expired objects during restart cleanup", async () => {
    const value = fixture();
    try {
      const first = await value.service.createDownload("user-1", {
        fileName: "result.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.from([9, 8, 7]),
      });
      const claimed = await value.service.claimDownload(first.referenceId);
      const chunks: Buffer[] = [];
      for await (const chunk of claimed.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([9, 8, 7]));
      await value.service.consume(claimed.record);
      await expect(value.service.claimDownload(first.referenceId)).rejects.toThrow(/unavailable/);

      await value.service.createDownload("user-1", {
        fileName: "expired.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.from([1]),
      });
      value.advance(60_001);
      await value.service.cleanup();
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("keeps expired bytes quota-bound until cleanup removes their files", async () => {
    const value = fixture({ maxTransferObjectsPerUser: 1 });
    try {
      await value.service.ingest("user-1", reference, fetcher());
      value.advance(60_001);
      const beforeCleanup = fetcher();
      await expect(value.service.ingest("user-1", reference, beforeCleanup)).rejects.toThrow(
        /quota/,
      );
      expect(beforeCleanup.fetch).not.toHaveBeenCalled();

      await value.service.cleanup();
      const afterCleanup = await value.service.ingest("user-1", reference, fetcher());
      const claimed = await value.service.claimInput("user-1", afterCleanup.referenceId);
      await value.service.consume(claimed.record);
    } finally {
      value.sqlite.close();
    }
  });

  test("startup reconciliation removes reserved partial and renamed unpublished objects", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserve({
        userId: "user-1",
        purpose: "workspace_input",
        fileName: "partial.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: 2_147_483_647,
        ownerStartTime: null,
        policy: basePolicy,
        now: 1_800_000_000_000,
      })!;
      writeFileSync(join(value.root, `${reserved.record.objectKey}.partial`), Buffer.from([1]));
      const renamed = value.repository.reserve({
        userId: "user-1",
        purpose: "workspace_download",
        fileName: "renamed.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: 2_147_483_647,
        ownerStartTime: null,
        policy: basePolicy,
        now: 1_800_000_000_000,
      })!;
      writeFileSync(join(value.root, renamed.record.objectKey), Buffer.from([1, 2, 3]));
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("startup reconciliation invalidates missing, linked, changed-size and changed-digest objects", async () => {
    const value = fixture({ maxTransferObjectsPerUser: 10, maxTransferObjectsGlobal: 10 });
    const objectPaths: string[] = [];
    const reserve = (name: string) => {
      const reserved = value.repository.reserve({
        userId: "user-1",
        purpose: "workspace_download",
        fileName: name,
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: process.pid,
        ownerStartTime: processStartTime(process.pid),
        policy: { ...basePolicy, maxTransferObjectsPerUser: 10, maxTransferObjectsGlobal: 10 },
        now: 1_800_000_000_000,
      })!;
      const objectPath = join(value.root, reserved.record.objectKey);
      objectPaths.push(objectPath);
      return { reserved, objectPath };
    };
    try {
      const missing = reserve("missing.bin");
      expect(
        value.repository.markReady(
          missing.reserved.record.id,
          3,
          createHash("sha256").update("abc").digest("hex"),
          1_800_000_000_000,
        ),
      ).toBe(true);

      const symlink = reserve("symlink.bin");
      const symlinkTarget = join(value.root, "symlink-target.bin");
      writeFileSync(symlinkTarget, "abc");
      symlinkSync(symlinkTarget, symlink.objectPath);
      expect(
        value.repository.markReady(
          symlink.reserved.record.id,
          3,
          createHash("sha256").update("abc").digest("hex"),
          1_800_000_000_000,
        ),
      ).toBe(true);

      const hardLink = reserve("hard-link.bin");
      const hardLinkSource = join(value.root, "hard-link-source.bin");
      writeFileSync(hardLinkSource, "abc");
      linkSync(hardLinkSource, hardLink.objectPath);
      expect(
        value.repository.markReady(
          hardLink.reserved.record.id,
          3,
          createHash("sha256").update("abc").digest("hex"),
          1_800_000_000_000,
        ),
      ).toBe(true);

      const changedSize = reserve("changed-size.bin");
      writeFileSync(changedSize.objectPath, "ab");
      expect(
        value.repository.markReady(
          changedSize.reserved.record.id,
          3,
          createHash("sha256").update("abc").digest("hex"),
          1_800_000_000_000,
        ),
      ).toBe(true);

      const changedDigest = reserve("changed-digest.bin");
      writeFileSync(changedDigest.objectPath, "abc");
      expect(
        value.repository.markReady(
          changedDigest.reserved.record.id,
          3,
          "0".repeat(64),
          1_800_000_000_000,
        ),
      ).toBe(true);

      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
      for (const objectPath of objectPaths) expect(existsSync(objectPath)).toBe(false);
      expect(readFileSync(symlinkTarget, "utf8")).toBe("abc");
      expect(readFileSync(hardLinkSource, "utf8")).toBe("abc");
    } finally {
      value.sqlite.close();
    }
  });

  test("cleanup preserves a reservation owned by a live transfer process", async () => {
    const value = fixture();
    let releaseFetch!: (
      response: Awaited<ReturnType<WorkspaceNativeReferenceFetcher["fetch"]>>,
    ) => void;
    const pendingResponse = new Promise<
      Awaited<ReturnType<WorkspaceNativeReferenceFetcher["fetch"]>>
    >((resolveResponse) => {
      releaseFetch = resolveResponse;
    });
    try {
      const ingest = value.service.ingest("user-1", reference, {
        fetch: () => pendingResponse,
      });
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT state FROM workspaceTransfer").get()).toEqual({
        state: "reserved",
      });
      releaseFetch({
        contentLength: 5,
        mimeType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from([0, 255, 1, 2, 3]);
        })(),
      });
      const handle = await ingest;
      const claimed = await value.service.claimInput("user-1", handle.referenceId);
      await value.service.consume(claimed.record);
    } finally {
      value.sqlite.close();
    }
  });

  test("cleanup preserves another live process reservation and removes it after owner exit", async () => {
    const value = fixture();
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      owner.once("spawn", resolveSpawn);
      owner.once("error", rejectSpawn);
    });
    try {
      value.repository.reserve({
        userId: "user-1",
        purpose: "workspace_input",
        fileName: "owned.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: owner.pid!,
        ownerStartTime: processStartTime(owner.pid!),
        policy: basePolicy,
        now: 1_800_000_000_000,
      });
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT state FROM workspaceTransfer").get()).toEqual({
        state: "reserved",
      });
      const exited = new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
      owner.kill("SIGTERM");
      await exited;
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM workspaceTransfer").get()).toEqual({
        count: 0,
      });
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
      value.sqlite.close();
    }
  });
});
