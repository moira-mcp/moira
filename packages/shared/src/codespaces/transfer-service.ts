import { createHash } from "node:crypto";
import { constants, readFileSync, openSync, closeSync, fsyncSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import verifier from "stream-json/utils/verifier.js";
import { isSafeAttachmentFilename } from "../validation/attachment-filename.js";
import type {
  CodespaceNativeFileReference,
  CodespaceResourcePolicy,
  CodespaceTransferRecord,
  CodespaceVerifiedByteSource,
  CodespaceVerifiedByteStream,
} from "./resource-types.js";
import { CodespaceResourceError } from "./resource-types.js";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import { CodespaceTransferRepository } from "./transfer-repository.js";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT = /^[a-f0-9]{48}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const BINARY_MIME_TYPES = new Set([
  "application/octet-stream",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
]);

export function supportedCodespaceTransferMime(mimeType: string): boolean {
  return MIME.test(mimeType) && (mimeType.startsWith("text/") || BINARY_MIME_TYPES.has(mimeType));
}

function linuxProcessStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTime = value.slice(value.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
    return startTime && /^[0-9]+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function transferOwnerAlive(record: CodespaceTransferRecord): boolean {
  try {
    process.kill(record.ownerPid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return (
    process.platform !== "linux" || linuxProcessStartTime(record.ownerPid) === record.ownerStartTime
  );
}

export interface CodespaceNativeReferenceResponse {
  contentLength: number | null;
  mimeType: string;
  body: AsyncIterable<Uint8Array>;
  cancel?: () => void;
}

export interface CodespaceNativeReferenceFetcher {
  fetch(reference: CodespaceNativeFileReference): Promise<CodespaceNativeReferenceResponse>;
}

export interface CodespaceTransferHandle {
  referenceId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: number;
}

export interface CodespaceTransferReservation {
  token: string;
  record: CodespaceTransferRecord;
}

function validateMimeSignature(mimeType: string, bytes: Buffer): void {
  let valid = true;
  if (mimeType === "application/pdf") {
    valid = bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
  } else if (mimeType === "application/zip") {
    const signature = bytes.subarray(0, 4).toString("hex");
    valid = ["504b0304", "504b0506", "504b0708"].includes(signature);
  } else if (mimeType === "application/gzip") {
    valid = bytes.subarray(0, 2).toString("hex") === "1f8b";
  } else if (mimeType === "application/x-tar") {
    valid = bytes.length >= 265 && bytes.subarray(257, 262).toString("ascii") === "ustar";
  } else if (mimeType === "image/png") {
    valid = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
  } else if (mimeType === "image/jpeg") {
    valid = bytes.subarray(0, 3).toString("hex") === "ffd8ff";
  } else if (mimeType === "image/gif") {
    valid = ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  } else if (mimeType === "image/webp") {
    valid =
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  } else if (mimeType === "video/mp4") {
    valid = bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  }
  if (!valid) {
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "Transfer content does not match its MIME type",
    );
  }
}

/** Syntax-only JSON validation never assembles values; signature inspection retains at most 512 bytes. */
class TransferMimeValidator {
  private readonly decoder: TextDecoder | null;
  private readonly json;
  private prefix = Buffer.alloc(0);
  private failure: Error | null = null;

  constructor(private readonly mimeType: string) {
    this.decoder =
      mimeType.startsWith("text/") || mimeType === "application/json"
        ? new TextDecoder("utf-8", { fatal: true })
        : null;
    this.json = mimeType === "application/json" ? verifier.asStream() : null;
    this.json?.on("error", (error: Error) => {
      this.failure = error;
    });
  }

  async write(bytes: Uint8Array): Promise<void> {
    try {
      this.decoder?.decode(bytes, { stream: true });
      if (this.prefix.length < 512) {
        this.prefix = Buffer.concat([
          this.prefix,
          Buffer.from(bytes.subarray(0, 512 - this.prefix.length)),
        ]);
      }
      if (this.failure) throw this.failure;
      if (this.json && !this.json.write(bytes)) await once(this.json, "drain");
      if (this.failure) throw this.failure;
    } catch {
      this.destroy();
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer content does not match its MIME type",
      );
    }
  }

  async finish(): Promise<void> {
    try {
      this.decoder?.decode();
      if (this.failure) throw this.failure;
      if (this.json) {
        const finished = once(this.json, "finish");
        this.json.end();
        await finished;
      } else if (!this.decoder) validateMimeSignature(this.mimeType, this.prefix);
    } catch {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer content does not match its MIME type",
      );
    } finally {
      this.destroy();
    }
  }

  destroy(): void {
    this.json?.destroy();
  }
}

export class CodespaceTransferService {
  private readonly root: string;
  private readonly verifiedIdentities = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly ownerPid = process.pid;
  private readonly ownerStartTime = linuxProcessStartTime(process.pid);

  constructor(
    private readonly dependencies: {
      repository: CodespaceTransferRepository;
      policy: () => CodespaceResourcePolicy;
      root: string;
      now?: () => number;
      onCleanupError?: (error: unknown) => void;
    },
  ) {
    this.root = resolve(dependencies.root);
    if (process.platform === "linux" && !this.ownerStartTime) {
      throw new Error("Codespace transfer process identity is unavailable");
    }
  }

  async createDownload(
    userId: string,
    input: { fileName: string; mimeType: string; bytes: Uint8Array },
  ): Promise<CodespaceTransferHandle> {
    const reserved = this.reserveDownload(userId, {
      fileName: input.fileName,
      mimeType: input.mimeType,
      maxBytes: input.bytes.byteLength,
    });
    return this.publishDownload(reserved, input.bytes);
  }

  async ingestStream(
    userId: string,
    input: {
      fileName: string;
      mimeType: string;
      size: number;
      body: AsyncIterable<Uint8Array>;
      signal?: AbortSignal;
    },
  ): Promise<CodespaceTransferHandle> {
    input.signal?.throwIfAborted();
    const reserved = this.reserveDownload(userId, {
      fileName: input.fileName,
      mimeType: input.mimeType,
      maxBytes: input.size,
    });
    return this.publishStream(reserved, input.body, input.mimeType, input.size, input.signal);
  }

  private async publishStream(
    reserved: CodespaceTransferReservation,
    body: AsyncIterable<Uint8Array>,
    mimeType: string,
    exactSize?: number,
    signal?: AbortSignal,
    beforePublish?: (transferId: string) => Promise<void>,
  ): Promise<CodespaceTransferHandle> {
    const validator = new TransferMimeValidator(mimeType);
    try {
      if (reserved.record.state !== "reserved")
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Invalid transfer reservation",
        );
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = await open(this.path(reserved.record.objectKey, ".partial"), "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of body) {
          signal?.throwIfAborted();
          if (size + chunk.byteLength > reserved.record.declaredSize) {
            throw new CodespaceResourceError(
              "CODESPACE_POLICY_LIMIT",
              "Transfer exceeds its reservation limit",
            );
          }
          for (let offset = 0; offset < chunk.byteLength; offset += 256 * 1024) {
            const bytes = Buffer.from(chunk.subarray(offset, offset + 256 * 1024));
            await validator.write(bytes);
            hash.update(bytes);
            size = await this.writeAll(file, bytes, size);
          }
        }
        signal?.throwIfAborted();
        if (exactSize !== undefined && size !== exactSize)
          throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Transfer size mismatch");
        await validator.finish();
        await file.sync();
      } finally {
        await file.close();
      }
      const sha256 = hash.digest("hex");
      if (reserved.record.expectedSha256 && reserved.record.expectedSha256 !== sha256)
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Transfer digest mismatch");
      await rename(
        this.path(reserved.record.objectKey, ".partial"),
        this.path(reserved.record.objectKey),
      );
      await this.syncRoot();
      await beforePublish?.(reserved.record.id);
      if (
        !this.dependencies.repository.markReady(
          reserved.record.id,
          size,
          sha256,
          this.now(),
          mimeType,
          this.now() + effectiveCodespaceLimits(this.dependencies.policy()).transfers.ttlMs,
        )
      ) {
        throw new Error("Transfer expired before publication");
      }
      const published = this.dependencies.repository.getOwned(
        reserved.record.userId,
        reserved.record.id,
      );
      if (!published) throw new Error("Published attachment record is unavailable");
      return this.handle(reserved.token, published, sha256);
    } catch (error) {
      await this.discard(reserved.record);
      throw error;
    } finally {
      validator.destroy();
    }
  }

  reserveDownload(
    userId: string,
    input: { fileName: string; mimeType: string; maxBytes: number },
  ): CodespaceTransferReservation {
    return this.reserve(
      userId,
      "codespace_download",
      input.fileName,
      input.mimeType,
      input.maxBytes,
    );
  }

  async publishDownload(
    reserved: CodespaceTransferReservation,
    input: Uint8Array,
  ): Promise<CodespaceTransferHandle> {
    if (reserved.record.purpose !== "codespace_download") {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Invalid download reservation",
      );
    }
    return this.publishObject(reserved, input);
  }

  private async publishObject(
    reserved: CodespaceTransferReservation,
    input: Uint8Array,
  ): Promise<CodespaceTransferHandle> {
    return this.publishStream(
      reserved,
      (async function* () {
        yield input;
      })(),
      reserved.record.mimeType,
      input.byteLength,
    );
  }

  release(record: CodespaceTransferRecord): void {
    if (record.claimId) this.dependencies.repository.release(record.id, record.claimId, this.now());
  }

  async consume(
    record: CodespaceTransferRecord,
    options?: { ignoreLostClaim?: boolean },
  ): Promise<void> {
    this.dependencies.repository.mutateByObjectKey(record.objectKey, (current) => {
      if (
        !current ||
        current.id !== record.id ||
        current.userId !== record.userId ||
        !record.claimId ||
        !this.dependencies.repository.consume(record.id, record.claimId, this.now())
      ) {
        if (options?.ignoreLostClaim) return;
        throw new Error("Codespace transfer claim is no longer current");
      }
      this.removeFiles(current);
      this.dependencies.repository.remove(current.id);
    });
  }

  async claimDownload(
    referenceId: string,
  ): Promise<{ record: CodespaceTransferRecord; stream: Readable }> {
    const now = this.now();
    const record = this.dependencies.repository.claim(
      this.token(referenceId),
      "codespace_download",
      now,
      now + 60_000,
      this.dependencies.policy(),
    );
    if (!record) throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Download is unavailable");
    try {
      const opened = await this.source(record).open();
      const stream = Readable.from(opened);
      stream.once("close", () => {
        void opened.close();
      });
      return { record, stream };
    } catch (error) {
      await this.invalidate(record);
      throw error;
    }
  }

  async cleanup(includeReserved = false): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const record of this.dependencies.repository.listCleanup(this.now(), includeReserved)) {
      // Historical workspace inputs/results and bound receipts are archival evidence, never jobs.
      if (record.purpose !== "codespace_download" || record.requestId) continue;
      if (record.state === "reserved" && transferOwnerAlive(record)) continue;
      await this.discard(record);
    }
    for (const record of this.dependencies.repository.listLive()) {
      if (record.purpose !== "codespace_download" || record.requestId) continue;
      if (record.state === "reserved") continue;
      try {
        const opened = await this.source(record).open();
        await opened.close();
      } catch (error) {
        if (!(error instanceof CodespaceResourceError && error.code === "CODESPACE_NOT_FOUND"))
          await this.discard(record);
      }
    }
    for (const entry of await readdir(this.root)) {
      const key =
        entry.endsWith(".partial") || entry.endsWith(".receipt") ? entry.slice(0, -8) : entry;
      if (!OBJECT.test(key)) continue;
      this.dependencies.repository.mutateByObjectKey(key, (current) => {
        if (current && (current.purpose !== "codespace_download" || current.requestId)) return;
        const live = current && ["reserved", "ready", "claimed"].includes(current.state);
        const keep = entry.endsWith(".partial") ? current?.state === "reserved" : live;
        if (!keep) {
          this.unlink(join(this.root, entry));
          this.syncRootImmediately();
        }
      });
    }
  }

  async discard(record: CodespaceTransferRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.dependencies.repository.mutateByObjectKey(record.objectKey, (current) => {
      if (
        !current ||
        Object.entries(record).some(
          ([key, value]) => current[key as keyof CodespaceTransferRecord] !== value,
        )
      )
        return;
      this.removeFiles(current);
      this.dependencies.repository.remove(current.id);
    });
  }

  private removeFiles(record: CodespaceTransferRecord): void {
    this.verifiedIdentities.delete(record.id);
    for (const suffix of ["", ".partial", ".receipt"])
      this.unlink(this.path(record.objectKey, suffix));
    this.syncRootImmediately();
  }

  private unlink(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private syncRootImmediately(): void {
    const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  start(): void {
    if (this.timer) return;
    this.runScheduledCleanup(true);
    this.timer = setInterval(() => this.runScheduledCleanup(true), 60_000);
    this.timer.unref();
  }

  private runScheduledCleanup(includeReserved: boolean): void {
    void this.cleanup(includeReserved).catch((error) => this.dependencies.onCleanupError?.(error));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reserve(
    userId: string,
    purpose: CodespaceTransferRecord["purpose"],
    fileName: string,
    mimeType: string,
    size: number,
  ) {
    this.validateFileMetadata(fileName, mimeType, size);
    const value = this.dependencies.repository.reserve({
      userId,
      purpose,
      fileName,
      mimeType,
      declaredSize: size,
      ownerPid: this.ownerPid,
      ownerStartTime: this.ownerStartTime,
      policy: this.dependencies.policy(),
      now: this.now(),
    });
    return value;
  }

  private validateFileMetadata(fileName: string, mimeType: string, size: number): void {
    if (
      !isSafeAttachmentFilename(fileName) ||
      !supportedCodespaceTransferMime(mimeType) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer metadata");
    }
  }

  private token(referenceId: string): string {
    const prefix = "codespace-file://";
    if (!referenceId.startsWith(prefix))
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer reference");
    const token = referenceId.slice(prefix.length);
    if (!TOKEN.test(token))
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer reference");
    return token;
  }

  private path(objectKey: string, suffix = ""): string {
    if (!OBJECT.test(objectKey)) throw new Error("Invalid codespace transfer object key");
    return join(this.root, `${objectKey}${suffix}`);
  }

  private async openVerified(record: CodespaceTransferRecord) {
    const inspected = await lstat(this.path(record.objectKey));
    if (
      !inspected.isFile() ||
      inspected.isSymbolicLink() ||
      inspected.nlink !== 1 ||
      inspected.size !== record.observedSize ||
      record.observedSize !== record.declaredSize ||
      !record.sha256
    ) {
      throw new Error("Codespace transfer object is invalid");
    }
    const handle = await open(
      this.path(record.objectKey),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const current = await handle.stat();
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== inspected.dev ||
        current.ino !== inspected.ino ||
        current.size !== inspected.size
      ) {
        throw new Error("Codespace transfer object changed during validation");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async getOwnedSource(
    userId: string,
    referenceId: string,
  ): Promise<{ record: CodespaceTransferRecord; source: CodespaceVerifiedByteSource }> {
    const record = this.dependencies.repository.getByToken(userId, this.token(referenceId));
    if (
      !record ||
      record.purpose !== "codespace_download" ||
      !["ready", "claimed"].includes(record.state) ||
      record.expiresAt <= this.now()
    ) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer is unavailable");
    }
    return { record, source: this.source(record) };
  }

  private source(record: CodespaceTransferRecord): CodespaceVerifiedByteSource {
    if (record.observedSize === null || !record.sha256) throw new Error("Transfer is not ready");
    const size = record.observedSize;
    const sha256 = record.sha256;
    return { size, sha256, open: (signal) => this.openStream(record, signal) };
  }

  private async openStream(
    record: CodespaceTransferRecord,
    signal?: AbortSignal,
    range?: { offset: number; length: number },
  ): Promise<CodespaceVerifiedByteStream> {
    if (record.observedSize === null || !record.sha256) throw new Error("Transfer is not ready");
    const size = record.observedSize;
    const sha256 = record.sha256;
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await this.openVerified(record);
    } catch (error) {
      this.verifiedIdentities.delete(record.id);
      throw error;
    }
    let identity;
    try {
      identity = await handle.stat({ bigint: true });
    } catch (error) {
      await handle.close();
      throw error;
    }
    const identityKey = [
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeNs,
      identity.ctimeNs,
      sha256,
    ].join(":");
    const check = async () => {
      signal?.throwIfAborted();
      const current = await handle.stat({ bigint: true });
      const path = await lstat(this.path(record.objectKey), { bigint: true });
      const stored = this.dependencies.repository.getOwned(record.userId, record.id);
      if (
        !stored ||
        (record.state !== "claimed" && stored.expiresAt <= this.now()) ||
        stored.state !== record.state ||
        stored.sha256 !== sha256 ||
        stored.observedSize !== size ||
        (record.state === "claimed" &&
          (stored.claimId !== record.claimId || (stored.claimExpiresAt ?? 0) <= this.now()))
      ) {
        this.verifiedIdentities.delete(record.id);
        throw new CodespaceResourceError(
          "CODESPACE_NOT_FOUND",
          "Codespace transfer object changed",
        );
      }
      if (
        !path.isFile() ||
        path.nlink !== 1n ||
        current.nlink !== 1n ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        path.dev !== identity.dev ||
        path.ino !== identity.ino ||
        current.size !== identity.size ||
        current.mtimeNs !== identity.mtimeNs ||
        current.ctimeNs !== identity.ctimeNs ||
        path.mtimeNs !== identity.mtimeNs ||
        path.ctimeNs !== identity.ctimeNs
      ) {
        this.verifiedIdentities.delete(record.id);
        throw new Error("Codespace transfer object changed");
      }
    };
    let closed = false;
    let closePromise: Promise<void> | null = null;
    // Link expiry controls admission. A live admitted download owns its claim until closure.
    const renewal =
      record.state === "claimed" && record.claimId
        ? setInterval(
            () =>
              this.dependencies.repository.renewClaim(
                record.id,
                record.claimId!,
                this.now(),
                this.now() + 60_000,
              ),
            10_000,
          )
        : undefined;
    renewal?.unref();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const close = () => {
      if (!closePromise) {
        closed = true;
        if (renewal) clearInterval(renewal);
        signal?.removeEventListener("abort", aborted);
        closePromise = handle.close().finally(settle);
      }
      return closePromise;
    };
    const aborted = () => {
      void close().catch(() => {});
    };
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      if (this.verifiedIdentities.get(record.id) !== identityKey) {
        this.verifiedIdentities.delete(record.id);
        const hash = createHash("sha256");
        for (let position = 0; position < size;) {
          signal?.throwIfAborted();
          const bytes = Buffer.alloc(Math.min(256 * 1024, size - position));
          const read = await handle.read(bytes, 0, bytes.length, position);
          if (!read.bytesRead) throw new Error("Codespace transfer object changed");
          hash.update(bytes.subarray(0, read.bytesRead));
          position += read.bytesRead;
        }
        if (hash.digest("hex") !== sha256)
          throw new Error("Codespace transfer object digest mismatch");
      }
      await check();
      this.verifiedIdentities.delete(record.id);
      this.verifiedIdentities.set(record.id, identityKey);
      if (this.verifiedIdentities.size > 64)
        this.verifiedIdentities.delete(this.verifiedIdentities.keys().next().value!);
    } catch (error) {
      this.verifiedIdentities.delete(record.id);
      await close();
      throw error;
    }
    let position = range?.offset ?? 0;
    const end = range ? Math.min(size, range.offset + range.length) : size;
    let iterationStarted = false;
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        if (closed) {
          signal?.throwIfAborted();
          return { done: true, value: undefined };
        }
        try {
          await check();
          if (position === end) {
            await close();
            return { done: true, value: undefined };
          }
          const bytes = Buffer.alloc(Math.min(256 * 1024, end - position));
          const read = await handle.read(bytes, 0, bytes.length, position);
          if (!read.bytesRead) throw new Error("Codespace transfer object changed");
          position += read.bytesRead;
          await check();
          if (record.state === "claimed" && record.claimId) {
            const now = this.now();
            if (
              !this.dependencies.repository.renewClaim(record.id, record.claimId, now, now + 60_000)
            ) {
              throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer claim expired");
            }
          }
          return { done: false, value: bytes.subarray(0, read.bytesRead) };
        } catch (error) {
          await close();
          throw error;
        }
      },
      return: async () => {
        await close();
        return { done: true, value: undefined };
      },
      throw: async (error) => {
        await close();
        throw error;
      },
    };
    const stream: CodespaceVerifiedByteStream = {
      settled,
      close,
      [Symbol.asyncIterator]: () => {
        if (iterationStarted) throw new Error("Transfer stream is single-use");
        iterationStarted = true;
        return iterator;
      },
    };
    if (signal?.aborted) {
      await close();
      signal.throwIfAborted();
    }
    return stream;
  }

  private async invalidate(record: CodespaceTransferRecord): Promise<void> {
    await this.discard(record);
  }

  private handle(
    token: string,
    record: CodespaceTransferRecord,
    sha256: string,
  ): CodespaceTransferHandle {
    return {
      referenceId: `codespace-file://${token}`,
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.declaredSize,
      sha256,
      expiresAt: record.expiresAt,
    };
  }

  private async writeAll(
    handle: Awaited<ReturnType<typeof open>>,
    bytes: Buffer,
    position: number,
  ): Promise<number> {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, position + offset);
      if (result.bytesWritten === 0) throw new Error("Codespace transfer write made no progress");
      offset += result.bytesWritten;
    }
    return position + bytes.length;
  }

  private async syncRoot(): Promise<void> {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private now(): number {
    return (this.dependencies.now ?? Date.now)();
  }
}
