import { afterEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
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
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CodespaceTransferRepository,
  CodespaceTransferService,
  type CodespaceResourcePolicy,
} from "@mcp-moira/shared";

const migrations = resolve(process.cwd(), "packages/web-backend/drizzle");
const roots: string[] = [];

function processStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
}
const basePolicy: CodespaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8,
  maxStorageBytes: 32,
  maxActivePerUser: 1,
  maxActiveGlobal: 4,
  createThrottleMs: 1,
  createDeadlineMs: 1,
  cleanupDeadlineMs: 1,
  claimLeaseMs: 30_000,
  reconcileIntervalMs: 1,
  startWaitMs: 60_000,
  transferTtlMs: 60_000,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Partial<CodespaceResourcePolicy> = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(`INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES
    ('user-1', 'one@example.test', 'user-one', 'now', 'now'),
    ('user-2', 'two@example.test', 'user-two', 'now', 'now')`);
  const root = mkdtempSync(join(tmpdir(), "moira-codespace-transfer-"));
  roots.push(root);
  let now = 1_800_000_000_000;
  const repository = new CodespaceTransferRepository(sqlite);
  const service = new CodespaceTransferService({
    repository,
    root,
    policy: () => ({ ...basePolicy, ...overrides }),
    now: () => now,
  });
  return { sqlite, repository, service, root, advance: (value: number) => (now += value) };
}

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

describe("private published attachments", () => {
  test("cleanup preserves a ready object released after its inspection observed a claim", async () => {
    const value = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const inspecting = new Promise<void>((resolve) => (entered = resolve));
    const internal = value.service as unknown as {
      openVerified: (
        record: ReturnType<typeof value.repository.listLive>[number],
      ) => ReturnType<typeof open>;
      openStream: (
        record: ReturnType<typeof value.repository.listLive>[number],
      ) => Promise<import("@mcp-moira/shared").CodespaceVerifiedByteStream>;
    };
    const originalOpen = internal.openVerified.bind(value.service);
    const inspection = jest
      .spyOn(internal, "openVerified")
      .mockImplementationOnce(async (record) => {
        const descriptor = await originalOpen(record);
        entered();
        await held;
        return descriptor;
      });
    const originalStream = internal.openStream.bind(value.service);
    const delivery = jest.spyOn(internal, "openStream").mockImplementationOnce(async (record) => {
      try {
        return await originalStream(record);
      } catch (error) {
        value.service.release(value.repository.getOwned("user-1", record.id)!);
        throw error;
      }
    });
    let download: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | undefined;
    try {
      const bytes = Buffer.from("released successor bytes");
      const handle = await value.service.createDownload("user-1", {
        fileName: "keep.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      const snapshot = value.repository.listLive()[0];
      const cleaning = value.service.cleanup();
      await inspecting;
      download = await value.service.claimDownload(handle.referenceId);
      resume();
      await cleaning;
      expect(value.repository.getOwned("user-1", snapshot.id)).toEqual(snapshot);
      const { source } = await value.service.getOwnedSource("user-1", handle.referenceId);
      const received: Uint8Array[] = [];
      for await (const chunk of await source.open()) received.push(chunk);
      expect(Buffer.concat(received)).toEqual(bytes);
    } finally {
      resume();
      download?.stream.destroy();
      inspection.mockRestore();
      delivery.mockRestore();
      value.sqlite.close();
    }
  });

  test("cleanup inspection cannot delete an object claimed after its ready snapshot", async () => {
    const value = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const inspecting = new Promise<void>((resolve) => (entered = resolve));
    const internal = value.service as unknown as {
      openVerified: (
        record: ReturnType<typeof value.repository.listLive>[number],
      ) => ReturnType<typeof open>;
    };
    const original = internal.openVerified.bind(value.service);
    const inspection = jest
      .spyOn(internal, "openVerified")
      .mockImplementationOnce(async (record) => {
        const descriptor = await original(record);
        entered();
        await held;
        return descriptor;
      });
    let download: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | undefined;
    try {
      const bytes = Buffer.from("claimed successor bytes");
      const handle = await value.service.createDownload("user-1", {
        fileName: "keep.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      const cleaning = value.service.cleanup();
      await inspecting;
      download = await value.service.claimDownload(handle.referenceId);
      const current = value.repository.getOwned("user-1", download.record.id);
      resume();
      await cleaning;
      expect(value.repository.getOwned("user-1", download.record.id)).toEqual(current);
      const received: Buffer[] = [];
      for await (const chunk of download.stream) received.push(chunk as Buffer);
      expect(Buffer.concat(received)).toEqual(bytes);
      await value.service.consume(download.record);
      expect(value.repository.listLive()).toEqual([]);
    } finally {
      resume();
      download?.stream.destroy();
      inspection.mockRestore();
      value.sqlite.close();
    }
  });

  test("failed stale claim validation cannot invalidate a released and reclaimed object", async () => {
    const value = fixture();
    let resume!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => (resume = resolve));
    const inspecting = new Promise<void>((resolve) => (entered = resolve));
    const internal = value.service as unknown as {
      openVerified: (
        record: ReturnType<typeof value.repository.listLive>[number],
      ) => ReturnType<typeof open>;
    };
    const original = internal.openVerified.bind(value.service);
    const inspection = jest
      .spyOn(internal, "openVerified")
      .mockImplementationOnce(async (record) => {
        const descriptor = await original(record);
        entered();
        await held;
        return descriptor;
      });
    let successor: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | undefined;
    try {
      const bytes = Buffer.from("reclaimed retained bytes");
      const handle = await value.service.createDownload("user-1", {
        fileName: "keep.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      const pending = value.service.claimDownload(handle.referenceId);
      const refused = expect(pending).rejects.toThrow(/changed/);
      await inspecting;
      const predecessor = value.repository.listLive()[0];
      value.service.release(predecessor);
      successor = await value.service.claimDownload(handle.referenceId);
      const current = value.repository.getOwned("user-1", successor.record.id);
      await expect(value.service.consume(predecessor)).rejects.toThrow(/no longer current/);
      await value.service.consume(predecessor, { ignoreLostClaim: true });
      expect(value.repository.getOwned("user-1", successor.record.id)).toEqual(current);
      resume();
      await refused;
      expect(value.repository.getOwned("user-1", successor.record.id)).toEqual(current);
      const received: Buffer[] = [];
      for await (const chunk of successor.stream) received.push(chunk as Buffer);
      expect(Buffer.concat(received)).toEqual(bytes);
    } finally {
      resume();
      successor?.stream.destroy();
      inspection.mockRestore();
      value.sqlite.close();
    }
  });

  test("an expired cleanup snapshot cannot discard a claim renewed before deletion", async () => {
    const value = fixture({ transferTtlMs: 600_000 });
    let download: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | undefined;
    try {
      const bytes = Buffer.from("renewed bytes");
      const handle = await value.service.createDownload("user-1", {
        fileName: "keep.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      download = await value.service.claimDownload(handle.referenceId);
      const snapshot = value.repository.getOwned("user-1", download.record.id)!;
      value.advance(30_000);
      expect(
        value.repository.renewClaim(
          snapshot.id,
          snapshot.claimId!,
          snapshot.createdAt + 30_000,
          snapshot.createdAt + 90_000,
        ),
      ).toBe(true);
      value.advance(30_000);
      const current = value.repository.getOwned("user-1", snapshot.id);
      await value.service.discard(snapshot);
      expect(value.repository.getOwned("user-1", snapshot.id)).toEqual(current);
      const received: Buffer[] = [];
      for await (const chunk of download.stream) received.push(chunk as Buffer);
      expect(Buffer.concat(received)).toEqual(bytes);
    } finally {
      download?.stream.destroy();
      value.sqlite.close();
    }
  });

  test("streaming migration preserves an existing ready object's identity, native reference and bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "moira-transfer-migration-"));
    roots.push(root);
    const beforeFolder = join(root, "before-streaming");
    cpSync(migrations, beforeFolder, { recursive: true });
    const journalPath = join(beforeFolder, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const cutoff = journal.entries.findIndex(
      (entry) => entry.tag === "0059_codespace_transfer_streaming",
    );
    expect(cutoff).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, cutoff);
    writeFileSync(journalPath, JSON.stringify(journal));
    const sqlite = new Database(":memory:");
    const bytes = Buffer.from("historical retained bytes");
    const token = "a".repeat(43);
    const objectKey = "b".repeat(48);
    const now = 1_800_000_000_000;
    try {
      migrate(drizzle(sqlite), { migrationsFolder: beforeFolder });
      sqlite.exec(
        "INSERT INTO user (id,email,handle,createdAt,updatedAt) VALUES ('user-1','old@example.test','old','now','now')",
      );
      sqlite
        .prepare(
          `INSERT INTO codespaceTransfer (id, tokenDigest, userId, purpose, state, fileName, mimeType,
        declaredSize, observedSize, sha256, objectKey, ownerPid, ownerStartTime, expiresAt, createdAt, updatedAt)
        VALUES ('historical-transfer', ?, 'user-1', 'codespace_download', 'ready', 'old.bin', 'application/octet-stream', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          createHash("sha256").update(token).digest("hex"),
          bytes.length,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
          objectKey,
          process.pid,
          now + 600_000,
          now,
          now,
        );
      writeFileSync(join(root, objectKey), bytes);
      const old = sqlite
        .prepare("SELECT * FROM codespaceTransfer WHERE id = 'historical-transfer'")
        .get();
      migrate(drizzle(sqlite), { migrationsFolder: migrations });
      const repository = new CodespaceTransferRepository(sqlite);
      const record = repository.getByToken("user-1", token)!;
      const {
        requestId,
        requestDigest,
        direction,
        resourceId,
        provider,
        resourceGeneration,
        authorizationGeneration,
        environmentIdentity,
        expectedSha256,
        uploadedBytes,
        ...unchanged
      } = record;
      expect(unchanged).toEqual(old);
      expect([
        requestId,
        requestDigest,
        direction,
        resourceId,
        provider,
        resourceGeneration,
        authorizationGeneration,
        environmentIdentity,
        expectedSha256,
      ]).toEqual(Array(9).fill(null));
      expect(uploadedBytes).toBe(bytes.length);
      const service = new CodespaceTransferService({
        repository,
        root,
        policy: () => basePolicy,
        now: () => now,
      });
      const { source } = await service.getOwnedSource("user-1", `codespace-file://${token}`);
      const opened = await source.open();
      const parts: Uint8Array[] = [];
      for await (const part of opened) parts.push(part);
      expect(Buffer.concat(parts)).toEqual(bytes);
      expect(repository.getOwned("user-1", record.id)).toEqual(record);
    } finally {
      sqlite.close();
    }
  });

  test("validates streamed JSON syntax and UTF8 before publishing without assembling values", async () => {
    const value = fixture();
    try {
      const valid = Buffer.from('{"name":"é","items":[1,true,null]}');
      const body = (bytes: Buffer) =>
        (async function* () {
          for (const byte of bytes) yield Buffer.from([byte]);
        })();
      const handle = await value.service.ingestStream("user-1", {
        fileName: "data.json",
        mimeType: "application/json",
        size: valid.length,
        body: body(valid),
      });
      const { source } = await value.service.getOwnedSource("user-1", handle.referenceId);
      const opened = await source.open();
      const received: Uint8Array[] = [];
      for await (const bytes of opened) received.push(bytes);
      expect(Buffer.concat(received)).toEqual(valid);
      await value.service.discard(value.repository.listLive()[0]);
      for (const invalid of [Buffer.from('{"x":1,}'), Buffer.from([0x22, 0xff, 0x22])]) {
        await expect(
          value.service.ingestStream("user-1", {
            fileName: "bad.json",
            mimeType: "application/json",
            size: invalid.length,
            body: body(invalid),
          }),
        ).rejects.toThrow(/MIME/);
        expect(value.repository.listLive()).toHaveLength(0);
      }
    } finally {
      value.sqlite.close();
    }
  });

  test("a checked public download emits bounded chunks instead of a complete retained Buffer", async () => {
    const value = fixture();
    try {
      const bytes = Buffer.alloc(1024 * 1024, 0x63);
      const handle = await value.service.createDownload("user-1", {
        fileName: "result.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      const claimed = await value.service.claimDownload(handle.referenceId);
      let received = 0;
      const digest = createHash("sha256");
      for await (const chunk of claimed.stream) {
        expect(chunk.length).toBeLessThanOrEqual(256 * 1024);
        received += chunk.length;
        digest.update(chunk);
      }
      expect(received).toBe(bytes.length);
      expect(digest.digest("hex")).toBe(handle.sha256);
      await value.service.consume(claimed.record);
    } finally {
      value.sqlite.close();
    }
  });

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
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
          count: 0,
        });
        expect(readdirSync(value.root)).toEqual([]);
      } finally {
        value.sqlite.close();
      }
    },
  );

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

  test("startup reconciliation invalidates missing, linked, changed-size and changed-digest objects", async () => {
    const value = fixture();
    const objectPaths: string[] = [];
    const reserve = (name: string) => {
      const reserved = value.repository.reserve({
        userId: "user-1",
        purpose: "codespace_download",
        fileName: name,
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: process.pid,
        ownerStartTime: processStartTime(process.pid),
        policy: basePolicy,
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
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
      for (const objectPath of objectPaths) expect(existsSync(objectPath)).toBe(false);
      expect(readFileSync(symlinkTarget, "utf8")).toBe("abc");
      expect(readFileSync(hardLinkSource, "utf8")).toBe("abc");
    } finally {
      value.sqlite.close();
    }
  });

  test("streams above the old file quota and publishes only after exact size validation", async () => {
    const value = fixture();
    const size = 20 * 1024 * 1024 + 31;
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    try {
      const handle = await value.service.ingestStream("user-1", {
        fileName: "large.bin",
        mimeType: "application/octet-stream",
        size,
        body: (async function* () {
          for (let n = 0; n < size; n += chunk.length) {
            value.advance(1000);
            yield chunk.subarray(0, Math.min(chunk.length, size - n));
          }
        })(),
      });
      expect(handle.size).toBe(size);
      const claimed = await value.service.claimDownload(handle.referenceId);
      let received = 0;
      for await (const bytes of claimed.stream) {
        received += bytes.length;
      }
      expect(received).toBe(size);
      await value.service.consume(claimed.record);
      await expect(
        value.service.ingestStream("user-1", {
          fileName: "short.bin",
          mimeType: "application/octet-stream",
          size: 2,
          body: (async function* () {
            yield Buffer.from([1]);
          })(),
        }),
      ).rejects.toThrow(/size mismatch/);
      expect(value.repository.listLive()).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("retains historical workspace payload records and bytes during cleanup", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserve({
        userId: "user-1",
        purpose: "codespace_download",
        fileName: "archive.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: 2147483647,
        ownerStartTime: null,
        policy: basePolicy,
        now: 1_800_000_000_000,
      });
      value.sqlite
        .prepare(
          "UPDATE codespaceTransfer SET purpose='operation_result',requestId='old-unknown-request' WHERE id=?",
        )
        .run(reserved.record.id);
      const path = join(value.root, reserved.record.objectKey);
      writeFileSync(path, "old");
      const before = value.repository.getOwned("user-1", reserved.record.id);
      value.advance(600_000);
      await value.service.cleanup(true);
      expect(value.repository.getOwned("user-1", reserved.record.id)).toEqual(before);
      expect(readFileSync(path, "utf8")).toBe("old");
      await expect(
        value.service.claimDownload(`codespace-file://${reserved.token}`),
      ).rejects.toThrow(/unavailable/);
    } finally {
      value.sqlite.close();
    }
  });
});
