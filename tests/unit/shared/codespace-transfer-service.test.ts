import { afterEach, describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  createReadStream,
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
  effectiveCodespaceLimits,
  type CodespaceNativeReferenceFetcher,
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

function fetcher(bytes = Buffer.from([0, 255, 1, 2, 3])): CodespaceNativeReferenceFetcher {
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

describe("private codespace transfer service", () => {
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
      expect(value.repository.usageForUser("user-1").bytes).toBe(bytes.length);
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
      expect(value.repository.usageForUser("user-1").inflightBytes).toBe(bytes.length);
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

  test("control claim inflight admission checks both owner and global capacity independently of native claims", async () => {
    const overrides = {
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 20,
      maxTransferBytesGlobal: 32,
      maxTransferObjectsPerUser: 4,
      maxTransferObjectsGlobal: 8,
      maxTransferInflightBytesPerUser: 4,
      maxTransferInflightBytesGlobal: 6,
    };
    const policy = { ...basePolicy, ...overrides };
    const value = fixture(overrides);
    let native: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>> | undefined;
    try {
      const handle = await value.service.createDownload("user-1", {
        fileName: "native.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.alloc(4),
      });
      native = await value.service.claimDownload(handle.referenceId);
      const reserve = (
        userId: string,
        purpose: "operation_input" | "operation_result" | "local_relay_input",
        size: number,
      ) => {
        const reservation = value.repository.reserve({
          userId,
          purpose,
          fileName: "relay.bin",
          mimeType: "application/octet-stream",
          declaredSize: size,
          ownerPid: process.pid,
          ownerStartTime: processStartTime(process.pid),
          policy,
          now: 1_800_000_000_000,
        })!;
        const bytes = Buffer.alloc(size);
        writeFileSync(join(value.root, reservation.record.objectKey), bytes);
        expect(
          value.repository.markReady(
            reservation.record.id,
            size,
            createHash("sha256").update(bytes).digest("hex"),
            1_800_000_000_000,
          ),
        ).toBe(true);
        return reservation;
      };
      const first = reserve("user-1", "operation_input", 4);
      const sameOwner = reserve("user-1", "operation_result", 1);
      const otherOwner = reserve("user-2", "local_relay_input", 3);
      const claim = (reservation: typeof first) =>
        value.repository.claim(
          reservation.token,
          reservation.record.purpose,
          1_800_000_000_000,
          1_800_000_030_000,
          policy,
          reservation.record.userId,
        );
      const active = claim(first)!;
      expect(active.state).toBe("claimed");
      expect(claim(sameOwner)).toBeNull();
      expect(claim(otherOwner)).toBeNull();
      expect(value.repository.getOwned("user-2", otherOwner.record.id)?.state).toBe("ready");
      value.service.release(active);
      expect(claim(otherOwner)?.state).toBe("claimed");
      expect(value.repository.getOwned("user-1", native.record.id)?.state).toBe("claimed");
    } finally {
      native?.stream.destroy();
      value.sqlite.close();
    }
  });

  test("ready native objects must reserve current inflight capacity atomically before download claims", async () => {
    const value = fixture({
      maxTransferFileBytes: 20 * 1024 * 1024,
      maxTransferBytesPerUser: 100 * 1024 * 1024,
      maxTransferBytesGlobal: 1024 * 1024 * 1024,
      maxTransferObjectsPerUser: 10,
      maxTransferObjectsGlobal: 1000,
      maxTransferInflightBytesPerUser: 40 * 1024 * 1024,
      maxTransferInflightBytesGlobal: 256 * 1024 * 1024,
    });
    const active: Awaited<ReturnType<CodespaceTransferService["claimDownload"]>>[] = [];
    try {
      const bytes = Buffer.alloc(20 * 1024 * 1024, 0x61);
      const handles = [];
      for (let index = 0; index < 5; index++)
        handles.push(
          await value.service.createDownload("user-1", {
            fileName: `file-${index}.bin`,
            mimeType: "application/octet-stream",
            bytes,
          }),
        );
      active.push(await value.service.claimDownload(handles[0].referenceId));
      active.push(await value.service.claimDownload(handles[1].referenceId));
      expect(value.repository.usageForUser("user-1").inflightBytes).toBe(40 * 1024 * 1024);
      await expect(value.service.claimDownload(handles[2].referenceId)).rejects.toThrow(
        /unavailable/,
      );
      expect(value.repository.usageForUser("user-1").inflightBytes).toBe(40 * 1024 * 1024);
      active[1].stream.destroy();
      value.service.release(active[1].record);
      const retried = await value.service.claimDownload(handles[2].referenceId);
      active.push(retried);
      expect(value.repository.usageForUser("user-1").inflightBytes).toBe(40 * 1024 * 1024);
      expect(value.repository.listLive()).toHaveLength(5);
    } finally {
      for (const claimed of active) claimed.stream.destroy();
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

  test("checked download progress renews only its live claim within object expiry and no-progress cannot revive it", async () => {
    const value = fixture({
      maxTransferFileBytes: 1024 * 1024,
      maxTransferBytesPerUser: 2 * 1024 * 1024,
      maxTransferBytesGlobal: 4 * 1024 * 1024,
      maxTransferInflightBytesPerUser: 2 * 1024 * 1024,
      maxTransferInflightBytesGlobal: 4 * 1024 * 1024,
      transferTtlMs: 600_000,
    });
    try {
      const bytes = Buffer.alloc(600 * 1024, 0x61);
      const handle = await value.service.createDownload("user-1", {
        fileName: "large.bin",
        mimeType: "application/octet-stream",
        bytes,
      });
      const claimed = await value.service.claimDownload(handle.referenceId);
      const initialDeadline = claimed.record.claimExpiresAt!;
      let received = 0;
      const iterator = claimed.stream[Symbol.asyncIterator]();
      for (let part = 0; part < 3; part++) {
        value.advance(40_000);
        const next = await iterator.next();
        expect(next.done).toBe(false);
        received += (next.value as Buffer).length;
      }
      expect(received).toBe(bytes.length);
      expect(
        value.repository.getOwned("user-1", claimed.record.id)?.claimExpiresAt,
      ).toBeGreaterThan(initialDeadline);
      expect(value.repository.getOwned("user-1", claimed.record.id)?.expiresAt).toBe(
        handle.expiresAt,
      );
      expect((await iterator.next()).done).toBe(true);
      await value.service.consume(claimed.record);
      await expect(value.service.claimDownload(handle.referenceId)).rejects.toThrow(/unavailable/);
      const stalled = await value.service.createDownload("user-1", {
        fileName: "stalled.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.from("stalled"),
      });
      const pending = await value.service.claimDownload(stalled.referenceId);
      const before = value.repository.getOwned("user-1", pending.record.id)!;
      value.advance(60_000);
      await expect(pending.stream[Symbol.asyncIterator]().next()).rejects.toThrow(/changed/);
      expect(value.repository.getOwned("user-1", pending.record.id)?.claimExpiresAt).toBe(
        before.claimExpiresAt,
      );
      expect(
        value.repository.renewClaim(
          pending.record.id,
          pending.record.claimId!,
          before.claimExpiresAt!,
          stalled.expiresAt,
        ),
      ).toBe(false);
    } finally {
      value.sqlite.close();
    }
  });

  test("a final publication authority refusal leaves bytes private and reservation uncommitted", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.from("unpublished");
    try {
      const transfer = await value.service.reserveResumable("user-1", {
        requestId: "00000000-0000-7000-8000-000000000006",
        requestDigest: "f".repeat(64),
        purpose: "codespace_download",
        fileName: "clip.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        authority,
      });
      await value.service.writeTransferChunk("user-1", transfer.transferId, authority, {
        offset: 0,
        bytes,
        sha256: transfer.sha256,
      });
      const authorize = jest.fn(async () => {
        throw new Error("authority revoked");
      });
      await expect(
        value.service.finalizeTransfer("user-1", transfer.transferId, authority, authorize),
      ).rejects.toThrow(/revoked/);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(
        (await value.service.getTransferStatus("user-1", transfer.transferId, authority)).state,
      ).toBe("reserved");
      const record = value.repository.getOwned("user-1", transfer.transferId)!;
      expect(existsSync(join(value.root, record.objectKey))).toBe(false);
      expect(readFileSync(join(value.root, `${record.objectKey}.partial`))).toEqual(bytes);
    } finally {
      value.sqlite.close();
    }
  });

  test("range verification seeks to the requested offset and refuses corruption after a previous verified read", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.from("prefix:retained-tail");
    try {
      const status = await value.service.reserveResumable("user-1", {
        requestId: "00000000-0000-7000-8000-000000000005",
        requestDigest: "f".repeat(64),
        purpose: "codespace_download",
        fileName: "clip.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        authority,
      });
      await value.service.writeTransferChunk("user-1", status.transferId, authority, {
        offset: 0,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      await value.service.finalizeTransfer("user-1", status.transferId, authority);
      expect(
        (
          await value.service.readTransferRange("user-1", status.transferId, authority, {
            offset: 7,
            length: 8,
          })
        ).bytes,
      ).toEqual(bytes.subarray(7, 15));
      const record = value.repository.getOwned("user-1", status.transferId)!;
      const descriptor = await open(join(value.root, record.objectKey), "r");
      const prototype = Object.getPrototypeOf(descriptor) as typeof descriptor;
      await descriptor.close();
      const reads = jest.spyOn(prototype, "read");
      try {
        expect(
          (
            await value.service.readTransferRange("user-1", status.transferId, authority, {
              offset: 7,
              length: 8,
            })
          ).bytes,
        ).toEqual(bytes.subarray(7, 15));
        const calls = reads.mock.calls as unknown as [Uint8Array, number, number, number][];
        expect(calls.map((call) => [call[2], call[3]])).toEqual([[8, 7]]);
      } finally {
        reads.mockRestore();
      }
      expect(
        (
          await value.service.readTransferRange("user-1", status.transferId, authority, {
            offset: bytes.length,
            length: 8,
          })
        ).bytes,
      ).toEqual(Buffer.alloc(0));
      writeFileSync(join(value.root, record.objectKey), Buffer.alloc(bytes.length, 0x7a));
      await expect(
        value.service.readTransferRange("user-1", status.transferId, authority, {
          offset: 7,
          length: 8,
        }),
      ).rejects.toThrow(/digest/);
    } finally {
      value.sqlite.close();
    }
  });

  test("recovers fsynced-but-uncheckpointed tails and rename-before-ready without changing the transfer receipt", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.from("hello world");
    try {
      const status = await value.service.reserveResumable("user-1", {
        requestId: "00000000-0000-7000-8000-000000000004",
        requestDigest: "e".repeat(64),
        purpose: "codespace_download",
        fileName: "clip.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        authority,
      });
      const record = value.repository.getOwned("user-1", status.transferId)!;
      const originalReceipt = JSON.parse(
        readFileSync(join(value.root, `${record.objectKey}.receipt`), "utf8"),
      ) as { token: string };
      const checkpoint = jest.spyOn(value.repository, "checkpoint").mockImplementationOnce(() => {
        throw new Error("checkpoint interrupted");
      });
      const wrong = Buffer.from("wrong");
      await expect(
        value.service.writeTransferChunk("user-1", status.transferId, authority, {
          offset: 0,
          bytes: wrong,
          sha256: createHash("sha256").update(wrong).digest("hex"),
        }),
      ).rejects.toThrow(/interrupted/);
      checkpoint.mockRestore();
      expect(readFileSync(join(value.root, `${record.objectKey}.partial`))).toEqual(wrong);
      expect(
        (await value.service.getTransferStatus("user-1", status.transferId, authority)).offset,
      ).toBe(0);
      await value.service.writeTransferChunk("user-1", status.transferId, authority, {
        offset: 0,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const ready = jest.spyOn(value.repository, "markReady").mockReturnValueOnce(false);
      await expect(
        value.service.finalizeTransfer("user-1", status.transferId, authority),
      ).rejects.toThrow(/publication/);
      ready.mockRestore();
      expect(existsSync(join(value.root, record.objectKey))).toBe(true);
      expect(
        (await value.service.getTransferStatus("user-1", status.transferId, authority)).state,
      ).toBe("reserved");
      const handle = await value.service.finalizeTransfer("user-1", status.transferId, authority);
      expect(handle.referenceId).toBe(`codespace-file://${originalReceipt.token}`);
      expect(readFileSync(join(value.root, record.objectKey))).toEqual(bytes);
      const changed = Buffer.from("HELLO");
      await expect(
        value.service.writeTransferChunk("user-1", status.transferId, authority, {
          offset: 0,
          bytes: changed,
          sha256: createHash("sha256").update(changed).digest("hex"),
        }),
      ).rejects.toThrow(/replay conflict/);
    } finally {
      value.sqlite.close();
    }
  });

  test("resumes durable chunks and returns the original native receipt after service reopen", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.from("immutable chunks");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = {
      requestId: "00000000-0000-7000-8000-000000000001",
      requestDigest: "a".repeat(64),
      purpose: "codespace_download" as const,
      fileName: "clip.bin",
      mimeType: "application/octet-stream",
      size: bytes.length,
      sha256,
      authority,
    };
    try {
      const first = await value.service.reserveResumable("user-1", input);
      const chunk = bytes.subarray(0, 5);
      const request = {
        offset: 0,
        bytes: chunk,
        sha256: createHash("sha256").update(chunk).digest("hex"),
      };
      expect(
        (await value.service.writeTransferChunk("user-1", first.transferId, authority, request))
          .offset,
      ).toBe(5);
      expect(
        (await value.service.writeTransferChunk("user-1", first.transferId, authority, request))
          .offset,
      ).toBe(5);
      await expect(
        value.service.writeTransferChunk("user-1", first.transferId, authority, {
          offset: 6,
          bytes: chunk,
          sha256: request.sha256,
        }),
      ).rejects.toThrow(/offset/);
      await expect(
        value.service.reserveResumable("user-1", { ...input, requestDigest: "b".repeat(64) }),
      ).rejects.toThrow(/conflict/);
      const reopened = new CodespaceTransferService({
        repository: value.repository,
        root: value.root,
        policy: () => basePolicy,
        now: () => first.expiresAt - 1000,
      });
      expect((await reopened.reserveResumable("user-1", input)).transferId).toBe(first.transferId);
      const rest = bytes.subarray(5);
      await reopened.writeTransferChunk("user-1", first.transferId, authority, {
        offset: 5,
        bytes: rest,
        sha256: createHash("sha256").update(rest).digest("hex"),
      });
      const handle = await reopened.finalizeTransfer("user-1", first.transferId, authority);
      expect(
        (await reopened.writeTransferChunk("user-1", first.transferId, authority, request)).offset,
      ).toBe(bytes.length);
      expect(await reopened.finalizeTransfer("user-1", first.transferId, authority)).toEqual(
        handle,
      );
      expect(
        (await reopened.getTransferStatus("user-1", first.transferId, authority)).handle,
      ).toEqual(handle);
      expect(
        (
          await reopened.readTransferRange("user-1", first.transferId, authority, {
            offset: 2,
            length: 4,
          })
        ).bytes,
      ).toEqual(bytes.subarray(2, 6));
      await expect(
        reopened.getTransferStatus("user-2", first.transferId, authority),
      ).rejects.toThrow(/unavailable/);
      await expect(
        reopened.getTransferStatus("user-1", first.transferId, {
          ...authority,
          environmentIdentity: "boot-two",
        }),
      ).rejects.toThrow(/authority/);
      const { source } = await reopened.getOwnedSource("user-1", handle.referenceId);
      const controller = new AbortController();
      const opened = await source.open(controller.signal);
      controller.abort();
      await opened.settled;
      await opened.close();
      expect(value.repository.listLive()).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });

  test("replays an exact maximum chunk and rejects an oversized chunk without changing its larger reservation", async () => {
    const value = fixture({
      maxTransferFileBytes: 1024 * 1024,
      maxTransferBytesPerUser: 1024 * 1024,
      maxTransferBytesGlobal: 2 * 1024 * 1024,
      maxTransferInflightBytesPerUser: 1024 * 1024,
      maxTransferInflightBytesGlobal: 2 * 1024 * 1024,
    });
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.alloc(256 * 1024 + 1, 0x61);
    bytes[bytes.length - 1] = 0xff;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    try {
      const reserved = await value.service.reserveResumable("user-1", {
        requestId: "00000000-0000-7000-8000-000000000007",
        requestDigest: "a".repeat(64),
        purpose: "codespace_download",
        fileName: "boundary.bin",
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256,
        authority,
      });
      const chunk = bytes.subarray(0, 256 * 1024);
      const request = {
        offset: 0,
        bytes: chunk,
        sha256: createHash("sha256").update(chunk).digest("hex"),
      };
      const written = await value.service.writeTransferChunk(
        "user-1",
        reserved.transferId,
        authority,
        request,
      );
      expect(written.offset).toBe(chunk.length);
      const record = value.repository.getOwned("user-1", reserved.transferId)!;
      const partial = join(value.root, `${record.objectKey}.partial`);
      expect(readFileSync(partial)).toEqual(chunk);
      expect(
        await value.service.writeTransferChunk("user-1", reserved.transferId, authority, request),
      ).toEqual(written);
      expect(value.repository.getOwned("user-1", reserved.transferId)).toEqual(record);
      expect(readFileSync(partial)).toEqual(chunk);

      await expect(
        value.service.writeTransferChunk("user-1", reserved.transferId, authority, {
          offset: 0,
          bytes,
          sha256,
        }),
      ).rejects.toThrow("Invalid transfer chunk");
      expect(value.repository.getOwned("user-1", reserved.transferId)).toEqual(record);
      expect(readFileSync(partial)).toEqual(chunk);
    } finally {
      value.sqlite.close();
    }
  });

  test("native caller recovery preserves the original ready object and skips another external fetch", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const identity = {
      requestId: "00000000-0000-8000-8000-000000000002",
      requestDigest: "c".repeat(64),
      authority,
      direction: "server_to_guest" as const,
    };
    const native = fetcher();
    try {
      const handle = await value.service.ingest("user-1", reference, native, undefined, identity);
      const reopened = new CodespaceTransferService({
        repository: value.repository,
        root: value.root,
        policy: () => basePolicy,
        now: () => handle.expiresAt - 1000,
      });
      expect(
        await reopened.ingest(
          "user-1",
          { ...reference, downloadUrl: "https://new-authorized.example/file" },
          native,
          undefined,
          identity,
        ),
      ).toEqual(handle);
      expect(native.fetch).toHaveBeenCalledTimes(1);
      expect(value.repository.listLive()).toHaveLength(1);
      await expect(
        reopened.ingest("user-1", reference, native, undefined, {
          ...identity,
          requestDigest: "d".repeat(64),
        }),
      ).rejects.toThrow(/conflict/);
    } finally {
      value.sqlite.close();
    }
  });

  test("reclaims a dead native ingestion owner while preserving its private reference and refusing a live owner", async () => {
    const value = fixture();
    const authority = {
      resourceId: "space-1",
      provider: "local",
      resourceGeneration: 1,
      authorizationGeneration: 2,
      environmentIdentity: "boot-one",
    };
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    const identity = {
      requestId: "00000000-0000-7000-8000-000000000003",
      requestDigest: "d".repeat(64),
      authority,
      direction: "server_to_guest" as const,
    };
    try {
      const original = await value.service.reserveResumable("user-1", {
        ...identity,
        purpose: "codespace_input",
        fileName: reference.fileName,
        mimeType: reference.mimeType,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const native = fetcher(bytes);
      await expect(
        value.service.ingest("user-1", reference, native, undefined, identity),
      ).rejects.toThrow(/pending/);
      expect(native.fetch).not.toHaveBeenCalled();
      const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await new Promise<void>((resolve, reject) => {
        dead.once("exit", () => resolve());
        dead.once("error", reject);
      });
      value.sqlite
        .prepare("UPDATE codespaceTransfer SET ownerPid = ?, ownerStartTime = NULL WHERE id = ?")
        .run(dead.pid, original.transferId);
      const row = value.repository.getOwned("user-1", original.transferId)!;
      writeFileSync(join(value.root, `${row.objectKey}.partial`), Buffer.from("crash tail"));
      const handle = await value.service.ingest("user-1", reference, native, undefined, identity);
      expect(
        value.repository.getByToken("user-1", handle.referenceId.slice("codespace-file://".length))
          ?.id,
      ).toBe(original.transferId);
      expect(native.fetch).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(value.root, row.objectKey))).toEqual(bytes);
    } finally {
      value.sqlite.close();
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

  test("streams a native binary above four MiB without whole-object accumulation", async () => {
    const size = 5 * 1024 * 1024 + 7;
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    const expected = createHash("sha256");
    for (let offset = 0; offset < size; offset += chunk.length)
      expected.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
    const value = fixture({
      maxTransferFileBytes: 20 * 1024 * 1024,
      maxTransferBytesPerUser: 100 * 1024 * 1024,
      maxTransferBytesGlobal: 1024 * 1024 * 1024,
      maxTransferInflightBytesPerUser: 40 * 1024 * 1024,
      maxTransferInflightBytesGlobal: 256 * 1024 * 1024,
    });
    const concatenate = Buffer.concat;
    const concatenation = jest.spyOn(Buffer, "concat").mockImplementation((chunks, length) => {
      if ((length ?? chunks.reduce((total, bytes) => total + bytes.length, 0)) >= size)
        throw new Error("Whole transfer bytes accumulated");
      return concatenate(chunks, length);
    });
    try {
      const handle = await value.service.ingest(
        "user-1",
        { ...reference, declaredSize: size },
        {
          fetch: async () => ({
            contentLength: size,
            mimeType: "application/octet-stream",
            body: (async function* () {
              for (let offset = 0; offset < size; offset += chunk.length)
                yield chunk.subarray(0, Math.min(chunk.length, size - offset));
            })(),
          }),
        },
      );
      expect(handle).toMatchObject({ size, sha256: expected.digest("hex") });
      const stored = value.repository.listLive()[0];
      let received = 0;
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(join(value.root, stored.objectKey))) {
        received += bytes.length;
        digest.update(bytes);
      }
      expect(received).toBe(size);
      expect(digest.digest("hex")).toBe(handle.sha256);
    } finally {
      concatenation.mockRestore();
      value.sqlite.close();
    }
  });

  test("a checked public download emits bounded chunks instead of a complete retained Buffer", async () => {
    const value = fixture({
      maxTransferFileBytes: 1024 * 1024,
      maxTransferBytesPerUser: 2 * 1024 * 1024,
      maxTransferBytesGlobal: 4 * 1024 * 1024,
      maxTransferInflightBytesPerUser: 2 * 1024 * 1024,
      maxTransferInflightBytesGlobal: 4 * 1024 * 1024,
    });
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

  test.each(["native", "relay"] as const)(
    "a full %s byte budget does not consume the other transfer class",
    async (first) => {
      const value = fixture({
        maxTransferFileBytes: 4,
        maxTransferBytesPerUser: 8,
        maxTransferBytesGlobal: 8,
        maxTransferInflightBytesPerUser: 8,
        maxTransferInflightBytesGlobal: 8,
        maxTransferObjectsPerUser: 2,
        maxTransferObjectsGlobal: 2,
      });
      const native = async () => {
        for (const name of ["one.bin", "two.bin"])
          await value.service.createDownload("user-1", {
            fileName: name,
            mimeType: "application/octet-stream",
            bytes: Buffer.alloc(4),
          });
      };
      const relay = async () => {
        const input = await value.service.retainRelayPayload(
          "user-1",
          "local_relay_input",
          Buffer.from("send"),
        );
        const output = await value.service.retainRelayPayload(
          "user-1",
          "local_relay_output",
          Buffer.from("done"),
        );
        expect(await value.service.readRelayPayload("user-1", "local_relay_input", input)).toEqual(
          Buffer.from("send"),
        );
        expect(
          await value.service.readRelayPayload("user-1", "local_relay_output", output),
        ).toEqual(Buffer.from("done"));
      };
      try {
        await (first === "native" ? native() : relay());
        await (first === "native" ? relay() : native());
        expect(value.repository.usageForUser("user-1")).toEqual({
          objects: 2,
          bytes: 8,
          inflightBytes: 0,
        });
        expect(value.repository.listLive()).toHaveLength(4);
        await expect(
          value.service.createDownload("user-1", {
            fileName: "blocked.bin",
            mimeType: "application/octet-stream",
            bytes: Buffer.from("x"),
          }),
        ).rejects.toThrow(/quota/);
        await expect(
          value.service.retainRelayPayload("user-1", "local_relay_input", Buffer.from("x")),
        ).rejects.toThrow(/quota/);
        value.advance(60_001);
        await value.service.cleanup();
        expect(value.repository.listLive()).toEqual([]);
        expect(readdirSync(value.root)).toEqual([]);
      } finally {
        value.sqlite.close();
      }
    },
  );

  test.each(["local_relay_input", "codespace_input"] as const)(
    "%s reservations enforce their own byte/inflight limits without charging the other class",
    (purpose) => {
      const value = fixture({
        maxTransferFileBytes: 4,
        maxTransferBytesPerUser: 8,
        maxTransferBytesGlobal: 8,
        maxTransferInflightBytesPerUser: 4,
        maxTransferInflightBytesGlobal: 4,
      });
      const reserve = (
        userId: string,
        selected: typeof purpose | "local_relay_input" | "codespace_input",
        size: number,
      ) =>
        value.repository.reserve({
          userId,
          purpose: selected,
          fileName: "payload.bin",
          mimeType: "application/octet-stream",
          declaredSize: size,
          ownerPid: process.pid,
          ownerStartTime: processStartTime(process.pid),
          policy: {
            ...basePolicy,
            maxTransferFileBytes: 4,
            maxTransferBytesPerUser: 8,
            maxTransferBytesGlobal: 8,
            maxTransferInflightBytesPerUser: 4,
            maxTransferInflightBytesGlobal: 4,
          },
          now: 1_800_000_000_000,
        });
      try {
        expect(reserve("user-1", purpose, 4)).not.toBeNull();
        expect(reserve("user-1", purpose, 1)).toBeNull();
        expect(reserve("user-2", purpose, 1)).toBeNull();
        expect(
          reserve(
            "user-2",
            purpose === "codespace_input" ? "local_relay_input" : "codespace_input",
            4,
          ),
        ).not.toBeNull();
        expect(reserve("user-2", purpose, 5)).toBeNull();
      } finally {
        value.sqlite.close();
      }
    },
  );

  test("relay part-count admission scales with supported slots and still has user/global ceilings", () => {
    const selected = {
      ...basePolicy,
      maxConcurrentOperationsPerUser: 1,
      maxConcurrentOperationsGlobal: 1,
      maxActivePerUser: 1,
      maxActiveGlobal: 2,
    };
    const value = fixture(selected);
    const limits = effectiveCodespaceLimits(selected);
    const reserve = (userId: string) =>
      value.repository.reserve({
        userId,
        purpose: "local_relay_input",
        fileName: "relay.bin",
        mimeType: "application/octet-stream",
        declaredSize: 0,
        ownerPid: process.pid,
        ownerStartTime: processStartTime(process.pid),
        policy: selected,
        now: 1_800_000_000_000,
      });
    try {
      expect(limits.relayTransfers.maxObjectsPerUser).toBe(128);
      expect(limits.relayTransfers.maxObjectsGlobal).toBe(192);
      for (let index = 0; index < 128; index++) expect(reserve("user-1")).not.toBeNull();
      expect(reserve("user-1")).toBeNull();
      for (let index = 0; index < 64; index++) expect(reserve("user-2")).not.toBeNull();
      expect(reserve("user-2")).toBeNull();
      expect(value.repository.usageForUser("user-1")).toEqual({
        objects: 0,
        bytes: 0,
        inflightBytes: 0,
      });
      expect(() =>
        value.repository.reserve({
          userId: "user-1",
          purpose: "invalid" as "codespace_input",
          fileName: "bad.bin",
          mimeType: "application/octet-stream",
          declaredSize: 0,
          ownerPid: process.pid,
          ownerStartTime: processStartTime(process.pid),
          policy: selected,
          now: 1_800_000_000_000,
        }),
      ).toThrow(/purpose/);
    } finally {
      value.sqlite.close();
    }
  });

  test("retains a multi-part relay payload across restart without public download authority", async () => {
    const value = fixture({
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 32,
      maxTransferBytesGlobal: 64,
      maxTransferObjectsPerUser: 10,
      maxTransferObjectsGlobal: 20,
      maxTransferInflightBytesPerUser: 32,
    });
    const bytes = Buffer.from([0, 255, 1, 2, 3, 4, 5, 6, 7]);
    try {
      const ref = await value.service.retainRelayPayload("user-1", "local_relay_input", bytes);
      expect(ref.parts.map((part) => part.size)).toEqual([4, 4, 1]);
      const restarted = new CodespaceTransferService({
        repository: value.repository,
        root: value.root,
        policy: () => basePolicy,
        now: () => 1_800_000_000_000,
      });
      expect(await restarted.readRelayPayload("user-1", "local_relay_input", ref)).toEqual(bytes);
      expect(await restarted.readRelayChunk("user-1", "local_relay_input", ref, 1, 1, 2)).toEqual(
        bytes.subarray(5, 7),
      );
      await expect(restarted.readRelayPayload("user-2", "local_relay_input", ref)).rejects.toThrow(
        /unavailable/,
      );
      await expect(restarted.readRelayPayload("user-1", "local_relay_output", ref)).rejects.toThrow(
        /unavailable/,
      );
      expect(value.repository.listLive().map((row) => row.purpose)).toEqual([
        "local_relay_input",
        "local_relay_input",
        "local_relay_input",
      ]);
      expect(JSON.stringify(value.repository.listLive())).not.toContain(bytes.toString("base64"));
      await restarted.discardRelayPayload("user-1", "local_relay_input", ref);
      expect(value.repository.listLive()).toEqual([]);
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

  test("a valid relay token cannot claim a public download or publish through its API", async () => {
    const value = fixture();
    try {
      const reserved = value.repository.reserve({
        userId: "user-1",
        purpose: "local_relay_output",
        fileName: "relay.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: process.pid,
        ownerStartTime: processStartTime(process.pid),
        policy: basePolicy,
        now: 1_800_000_000_000,
      })!;
      await expect(value.service.publishDownload(reserved, Buffer.from("abc"))).rejects.toThrow(
        /reservation/,
      );
      writeFileSync(join(value.root, reserved.record.objectKey), "abc");
      expect(
        value.repository.markReady(
          reserved.record.id,
          3,
          createHash("sha256").update("abc").digest("hex"),
          1_800_000_000_000,
        ),
      ).toBe(true);
      await expect(
        value.service.claimDownload(`codespace-file://${reserved.token}`),
      ).rejects.toThrow(/unavailable/);
      expect(value.repository.listLive()[0].state).toBe("ready");
    } finally {
      value.sqlite.close();
    }
  });

  test("relay quota failure releases earlier parts and preserves existing native objects", async () => {
    const value = fixture({
      maxTransferFileBytes: 4,
      maxTransferBytesPerUser: 8,
      maxTransferObjectsPerUser: 2,
    });
    try {
      const native = await value.service.createDownload("user-1", {
        fileName: "keep.bin",
        mimeType: "application/octet-stream",
        bytes: Buffer.from([9]),
      });
      await expect(
        value.service.retainRelayPayload("user-1", "local_relay_input", Buffer.alloc(9)),
      ).rejects.toThrow(/quota/);
      expect(value.repository.listLive()).toHaveLength(1);
      const claimed = await value.service.claimDownload(native.referenceId);
      const chunks: Buffer[] = [];
      for await (const chunk of claimed.stream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([9]));
    } finally {
      value.sqlite.close();
    }
  });

  test("relay refuses reordered or mutated payloads and expires stored bytes under shared quotas", async () => {
    const value = fixture({ maxTransferFileBytes: 4, maxTransferBytesPerUser: 16 });
    try {
      const ref = await value.service.retainRelayPayload(
        "user-1",
        "local_relay_output",
        Buffer.from("abcdefgh"),
      );
      await expect(
        value.service.readRelayPayload("user-1", "local_relay_output", {
          ...ref,
          parts: [...ref.parts].reverse(),
        }),
      ).rejects.toThrow(/digest/);
      const record = value.repository.listLive()[0];
      writeFileSync(join(value.root, record.objectKey), "evil");
      await expect(
        value.service.readRelayChunk("user-1", "local_relay_output", ref, 0, 0, 4),
      ).rejects.toThrow(/digest/);
      value.advance(60_001);
      await expect(
        value.service.readRelayPayload("user-1", "local_relay_output", ref),
      ).rejects.toThrow(/unavailable/);
      await value.service.cleanup();
      expect(value.repository.listLive()).toEqual([]);
      expect(readdirSync(value.root)).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });

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
                  .prepare("SELECT state, declaredSize, fileName, mimeType FROM codespaceTransfer")
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
            .prepare("SELECT state, declaredSize, observedSize, mimeType FROM codespaceTransfer")
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
        expect(value.sqlite.prepare("SELECT declaredSize FROM codespaceTransfer").get()).toEqual({
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
        expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
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
      const stored = value.sqlite.prepare("SELECT * FROM codespaceTransfer").get() as Record<
        string,
        unknown
      >;
      expect(stored.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(
        handle.referenceId.slice("codespace-file://".length),
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
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
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
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
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
      value: Awaited<ReturnType<CodespaceNativeReferenceFetcher["fetch"]>>,
    ) => void;
    const blockedResponse = new Promise<
      Awaited<ReturnType<CodespaceNativeReferenceFetcher["fetch"]>>
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
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
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
        purpose: "codespace_input",
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
        purpose: "codespace_download",
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
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
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
        purpose: "codespace_download",
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

  test("cleanup preserves a reservation owned by a live transfer process", async () => {
    const value = fixture();
    let releaseFetch!: (
      response: Awaited<ReturnType<CodespaceNativeReferenceFetcher["fetch"]>>,
    ) => void;
    const pendingResponse = new Promise<
      Awaited<ReturnType<CodespaceNativeReferenceFetcher["fetch"]>>
    >((resolveResponse) => {
      releaseFetch = resolveResponse;
    });
    try {
      const ingest = value.service.ingest("user-1", reference, {
        fetch: () => pendingResponse,
      });
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT state FROM codespaceTransfer").get()).toEqual({
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
        purpose: "codespace_input",
        fileName: "owned.bin",
        mimeType: "application/octet-stream",
        declaredSize: 3,
        ownerPid: owner.pid!,
        ownerStartTime: processStartTime(owner.pid!),
        policy: basePolicy,
        now: 1_800_000_000_000,
      });
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT state FROM codespaceTransfer").get()).toEqual({
        state: "reserved",
      });
      const exited = new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
      owner.kill("SIGTERM");
      await exited;
      await value.service.cleanup(true);
      expect(value.sqlite.prepare("SELECT COUNT(*) count FROM codespaceTransfer").get()).toEqual({
        count: 0,
      });
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
      value.sqlite.close();
    }
  });
});
