import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  WorkspaceNativeFileReference,
  WorkspaceResourcePolicy,
  WorkspaceTransferRecord,
} from "./resource-types.js";
import { WorkspaceResourceError } from "./resource-types.js";
import { WorkspaceTransferRepository } from "./transfer-repository.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT = /^[a-f0-9]{48}$/;
const FILE_ID = /^sediment:\/\/file_[A-Za-z0-9]+$/;
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
]);

export function supportedWorkspaceTransferMime(mimeType: string): boolean {
  return MIME.test(mimeType) && (mimeType.startsWith("text/") || BINARY_MIME_TYPES.has(mimeType));
}

function safeTransferFileName(fileName: string): boolean {
  return ![...fileName].some((value) => {
    const code = value.charCodeAt(0);
    return code <= 31 || code === 127 || value === "/" || value === "\\";
  });
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

function transferOwnerAlive(record: WorkspaceTransferRecord): boolean {
  try {
    process.kill(record.ownerPid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  return (
    process.platform !== "linux" || linuxProcessStartTime(record.ownerPid) === record.ownerStartTime
  );
}

export interface WorkspaceNativeReferenceResponse {
  contentLength: number | null;
  mimeType: string;
  body: AsyncIterable<Uint8Array>;
}

export interface WorkspaceNativeReferenceFetcher {
  fetch(reference: WorkspaceNativeFileReference): Promise<WorkspaceNativeReferenceResponse>;
}

export interface WorkspaceTransferHandle {
  referenceId: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  expiresAt: number;
}

export interface WorkspaceTransferReservation {
  token: string;
  record: WorkspaceTransferRecord;
}

function validateMimeSignature(mimeType: string, bytes: Buffer): void {
  let valid = true;
  if (mimeType.startsWith("text/")) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      valid = false;
    }
  } else if (mimeType === "application/json") {
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      valid = false;
    }
  } else if (mimeType === "application/pdf") {
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
  }
  if (!valid) {
    throw new WorkspaceResourceError(
      "WORKSPACE_RESOURCE_INVALID",
      "Transfer content does not match its MIME type",
    );
  }
}

export class WorkspaceTransferService {
  private readonly root: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly ownerPid = process.pid;
  private readonly ownerStartTime = linuxProcessStartTime(process.pid);

  constructor(
    private readonly dependencies: {
      repository: WorkspaceTransferRepository;
      policy: () => WorkspaceResourcePolicy;
      root: string;
      now?: () => number;
      onCleanupError?: (error: unknown) => void;
    },
  ) {
    this.root = resolve(dependencies.root);
    if (process.platform === "linux" && !this.ownerStartTime) {
      throw new Error("Workspace transfer process identity is unavailable");
    }
  }

  async ingest(
    userId: string,
    reference: WorkspaceNativeFileReference,
    fetcher: WorkspaceNativeReferenceFetcher,
  ): Promise<WorkspaceTransferHandle> {
    this.validateReference(reference);
    const reserved = this.reserve(
      userId,
      "workspace_input",
      reference.fileName,
      reference.mimeType,
      reference.declaredSize,
    );
    const partial = this.path(reserved.record.objectKey, ".partial");
    const target = this.path(reserved.record.objectKey);
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const response = await fetcher.fetch(reference);
      if (
        response.mimeType.toLowerCase().split(";", 1)[0].trim() !== reference.mimeType ||
        (response.contentLength !== null && response.contentLength !== reference.declaredSize)
      ) {
        throw new WorkspaceResourceError(
          "WORKSPACE_RESOURCE_INVALID",
          "Native file metadata mismatch",
        );
      }
      const handle = await open(partial, "wx", 0o600);
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      let received = 0;
      let position = 0;
      try {
        for await (const chunk of response.body) {
          if (this.now() >= reserved.record.expiresAt) {
            throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Native file fetch expired");
          }
          const bytes = Buffer.from(chunk);
          received += bytes.length;
          if (received > reference.declaredSize) {
            throw new WorkspaceResourceError(
              "WORKSPACE_POLICY_LIMIT",
              "Native file exceeds its limit",
            );
          }
          hash.update(bytes);
          chunks.push(bytes);
          position = await this.writeAll(handle, bytes, position);
        }
        if (received !== reference.declaredSize) {
          throw new WorkspaceResourceError(
            "WORKSPACE_RESOURCE_INVALID",
            "Native file size mismatch",
          );
        }
        validateMimeSignature(reference.mimeType, Buffer.concat(chunks, received));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sha256 = hash.digest("hex");
      await rename(partial, target);
      await this.syncRoot();
      if (
        !this.dependencies.repository.markReady(reserved.record.id, received, sha256, this.now())
      ) {
        throw new Error("Workspace transfer reservation expired before publication");
      }
      return this.handle(reserved.token, reserved.record, sha256);
    } catch (error) {
      await this.discard(reserved.record);
      throw error;
    }
  }

  async createDownload(
    userId: string,
    input: { fileName: string; mimeType: string; bytes: Uint8Array },
  ): Promise<WorkspaceTransferHandle> {
    const reserved = this.reserveDownload(userId, {
      fileName: input.fileName,
      mimeType: input.mimeType,
      maxBytes: input.bytes.byteLength,
    });
    return this.publishDownload(reserved, input.bytes);
  }

  reserveDownload(
    userId: string,
    input: { fileName: string; mimeType: string; maxBytes: number },
  ): WorkspaceTransferReservation {
    return this.reserve(
      userId,
      "workspace_download",
      input.fileName,
      input.mimeType,
      input.maxBytes,
    );
  }

  async publishDownload(
    reserved: WorkspaceTransferReservation,
    input: Uint8Array,
  ): Promise<WorkspaceTransferHandle> {
    const bytes = Buffer.from(input);
    const partial = this.path(reserved.record.objectKey, ".partial");
    const target = this.path(reserved.record.objectKey);
    try {
      if (
        reserved.record.purpose !== "workspace_download" ||
        reserved.record.state !== "reserved" ||
        bytes.byteLength > reserved.record.declaredSize
      ) {
        throw new WorkspaceResourceError(
          "WORKSPACE_RESOURCE_INVALID",
          "Invalid download reservation",
        );
      }
      validateMimeSignature(reserved.record.mimeType, bytes);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(partial, "wx", 0o600);
      try {
        await this.writeAll(handle, bytes, 0);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await rename(partial, target);
      await this.syncRoot();
      if (
        !this.dependencies.repository.markReady(
          reserved.record.id,
          bytes.byteLength,
          sha256,
          this.now(),
        )
      ) {
        throw new Error("Workspace transfer reservation expired before publication");
      }
      return this.handle(
        reserved.token,
        { ...reserved.record, declaredSize: bytes.length },
        sha256,
      );
    } catch (error) {
      await this.discard(reserved.record);
      throw error;
    }
  }

  async claimInput(
    userId: string,
    referenceId: string,
  ): Promise<{ record: WorkspaceTransferRecord; bytes: Buffer }> {
    const token = this.token(referenceId);
    const now = this.now();
    const record = this.dependencies.repository.claim(
      token,
      "workspace_input",
      now,
      Math.min(now + 60_000, now + (this.dependencies.policy().claimLeaseMs ?? 30_000)),
      userId,
    );
    if (!record) {
      throw new WorkspaceResourceError(
        "WORKSPACE_RESOURCE_INVALID",
        "Native file reference is unavailable",
      );
    }
    try {
      const bytes = await this.readVerified(record);
      return { record, bytes };
    } catch (error) {
      await this.invalidate(record);
      throw error;
    }
  }

  release(record: WorkspaceTransferRecord): void {
    if (record.claimId) this.dependencies.repository.release(record.id, record.claimId, this.now());
  }

  async consume(record: WorkspaceTransferRecord): Promise<void> {
    if (
      !record.claimId ||
      !this.dependencies.repository.consume(record.id, record.claimId, this.now())
    ) {
      throw new Error("Workspace transfer claim is no longer current");
    }
    await rm(this.path(record.objectKey), { force: true });
    await this.syncRoot();
    this.dependencies.repository.remove(record.id);
  }

  async claimDownload(
    referenceId: string,
  ): Promise<{ record: WorkspaceTransferRecord; stream: Readable }> {
    const now = this.now();
    const record = this.dependencies.repository.claim(
      this.token(referenceId),
      "workspace_download",
      now,
      now + 60_000,
    );
    if (!record) throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "Download is unavailable");
    try {
      const bytes = await this.readVerified(record);
      return { record, stream: Readable.from([bytes]) };
    } catch (error) {
      await this.invalidate(record);
      throw error;
    }
  }

  async cleanup(includeReserved = false): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const record of this.dependencies.repository.listCleanup(this.now(), includeReserved)) {
      if (record.state === "reserved" && transferOwnerAlive(record)) continue;
      await this.discard(record);
    }
    for (const record of this.dependencies.repository.listLive()) {
      if (record.state === "reserved") continue;
      try {
        await this.readVerified(record);
      } catch {
        await this.discard(record);
      }
    }
    const live = new Map(
      this.dependencies.repository.listLive().map((record) => [record.objectKey, record.state]),
    );
    for (const entry of await readdir(this.root)) {
      const key = entry.endsWith(".partial") ? entry.slice(0, -8) : entry;
      const state = live.get(key);
      const keep = entry.endsWith(".partial") ? state === "reserved" : state !== undefined;
      if (OBJECT.test(key) && !keep) {
        await rm(join(this.root, entry), { force: true });
        await this.syncRoot();
      }
    }
  }

  async discard(record: WorkspaceTransferRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rm(this.path(record.objectKey), { force: true });
    await rm(this.path(record.objectKey, ".partial"), { force: true });
    await this.syncRoot();
    this.dependencies.repository.remove(record.id);
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
    purpose: WorkspaceTransferRecord["purpose"],
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
    if (!value)
      throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "Transfer quota exceeded");
    return value;
  }

  private validateReference(reference: WorkspaceNativeFileReference): void {
    if (!FILE_ID.test(reference.fileId) || reference.fileId.length > 256) {
      throw new WorkspaceResourceError(
        "WORKSPACE_RESOURCE_INVALID",
        "Invalid native file identifier",
      );
    }
    this.validateFileMetadata(reference.fileName, reference.mimeType, reference.declaredSize);
  }

  private validateFileMetadata(fileName: string, mimeType: string, size: number): void {
    if (
      basename(fileName) !== fileName ||
      !fileName ||
      fileName === "." ||
      fileName === ".." ||
      !safeTransferFileName(fileName) ||
      Buffer.byteLength(fileName) > 255 ||
      !supportedWorkspaceTransferMime(mimeType) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > (this.dependencies.policy().maxTransferFileBytes ?? 4 * 1024 * 1024)
    ) {
      throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid transfer metadata");
    }
  }

  private token(referenceId: string): string {
    const prefix = "workspace-file://";
    if (!referenceId.startsWith(prefix))
      throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid transfer reference");
    const token = referenceId.slice(prefix.length);
    if (!TOKEN.test(token))
      throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "Invalid transfer reference");
    return token;
  }

  private path(objectKey: string, suffix = ""): string {
    if (!OBJECT.test(objectKey)) throw new Error("Invalid workspace transfer object key");
    return join(this.root, `${objectKey}${suffix}`);
  }

  private async readVerified(record: WorkspaceTransferRecord): Promise<Buffer> {
    const handle = await this.openVerified(record);
    try {
      const bytes = Buffer.alloc(record.observedSize!);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) throw new Error("Workspace transfer object changed");
        offset += result.bytesRead;
      }
      if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
        throw new Error("Workspace transfer object digest mismatch");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  private async openVerified(record: WorkspaceTransferRecord) {
    const inspected = await lstat(this.path(record.objectKey));
    if (
      !inspected.isFile() ||
      inspected.isSymbolicLink() ||
      inspected.nlink !== 1 ||
      inspected.size !== record.observedSize ||
      record.observedSize !== record.declaredSize ||
      !record.sha256
    ) {
      throw new Error("Workspace transfer object is invalid");
    }
    const handle = await open(
      this.path(record.objectKey),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== inspected.dev ||
      current.ino !== inspected.ino ||
      current.size !== inspected.size
    ) {
      await handle.close();
      throw new Error("Workspace transfer object changed during validation");
    }
    return handle;
  }

  private async invalidate(record: WorkspaceTransferRecord): Promise<void> {
    if (record.claimId) {
      this.dependencies.repository.consume(record.id, record.claimId, this.now());
    }
    await this.discard(record);
  }

  private handle(
    token: string,
    record: WorkspaceTransferRecord,
    sha256: string,
  ): WorkspaceTransferHandle {
    return {
      referenceId: `workspace-file://${token}`,
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
      if (result.bytesWritten === 0) throw new Error("Workspace transfer write made no progress");
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
