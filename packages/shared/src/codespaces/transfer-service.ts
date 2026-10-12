import { createHash } from "node:crypto";
import {
  constants,
  readFileSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  readSync,
  lstatSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import verifier from "stream-json/utils/verifier.js";
import { z } from "zod";
import { isSafeAttachmentFilename } from "../validation/attachment-filename.js";
import type {
  CodespaceNativeFileReference,
  CodespaceResourcePolicy,
  CodespaceTransferRecord,
  CodespaceVerifiedByteSource,
  CodespaceVerifiedByteStream,
  CodespaceTransferAuthority,
  CodespaceTransferStatus,
} from "./resource-types.js";
import { effectiveCodespaceLimits } from "./resource-policy.js";
import { CodespaceResourceError } from "./resource-types.js";
import { CodespaceTransferRepository } from "./transfer-repository.js";
import {
  LOCAL_RELAY_MAX_PARTS,
  localRelayPayloadReferenceSchema,
  type LocalRelayPayloadReference,
} from "./local-device-types.js";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const OBJECT = /^[a-f0-9]{48}$/;
const FILE_ID = /^(?:sediment:\/\/)?file_[A-Za-z0-9]+$/;
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

  async ingest(
    userId: string,
    reference: CodespaceNativeFileReference,
    fetcher: CodespaceNativeReferenceFetcher,
    maxBytes?: number,
    identity?: {
      requestId: string;
      requestDigest: string;
      authority: CodespaceTransferAuthority;
      direction: "server_to_guest";
      beforePublish?: (transferId: string) => Promise<void>;
    },
  ): Promise<CodespaceTransferHandle> {
    const maximumBytes = effectiveCodespaceLimits(this.dependencies.policy()).transfers
      .maxFileBytes;
    if (
      maxBytes !== undefined &&
      (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > maximumBytes)
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid native file bound");
    }
    const bound = maxBytes ?? maximumBytes;
    const fileName = reference.fileName ?? "attachment.bin";
    const reservedMime = reference.mimeType ?? "application/octet-stream";
    this.validateReference(reference);
    const reservedBytes = reference.declaredSize ?? bound;
    if (reservedBytes > bound) {
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Native file exceeds its limit");
    }
    let recovered: CodespaceTransferReservation | undefined;
    if (identity) {
      this.validateIdentity(identity.requestId, identity.requestDigest, identity.authority);
      const existing = this.getByRequest(userId, identity.requestId);
      if (existing) {
        this.checkAuthority(existing, identity.authority);
        if (
          existing.requestDigest !== identity.requestDigest ||
          existing.direction !== identity.direction ||
          existing.purpose !== "codespace_input" ||
          existing.fileName !== fileName ||
          (reference.mimeType !== undefined && existing.mimeType !== reservedMime) ||
          existing.declaredSize > bound ||
          (reference.declaredSize !== undefined && existing.declaredSize !== reference.declaredSize)
        ) {
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Transfer identity conflict",
          );
        }
        if (existing.state === "reserved") {
          this.dependencies.repository.mutate(userId, existing.id, (current) => {
            this.checkAuthority(current, identity.authority);
            if (current.state !== "reserved" || transferOwnerAlive(current)) {
              throw new CodespaceResourceError(
                "CODESPACE_RESOURCE_INVALID",
                "Native ingestion is pending",
              );
            }
            this.dependencies.repository.replaceIngestionOwner(
              current.id,
              this.ownerPid,
              this.ownerStartTime,
              this.now(),
            );
          });
          recovered = {
            record: this.dependencies.repository.getOwned(userId, existing.id)!,
            token: await this.receiptToken(existing),
          };
          await rm(this.path(existing.objectKey, ".partial"), { force: true });
        } else {
          const opened = await this.source(existing).open();
          await opened.close();
          await identity.beforePublish?.(existing.id);
          return this.handle(await this.receiptToken(existing), existing, existing.sha256!);
        }
      }
    }
    if (identity) await mkdir(this.root, { recursive: true, mode: 0o700 });
    const reserved =
      recovered ??
      (identity
        ? this.dependencies.repository.reserve({
            userId,
            purpose: "codespace_input",
            fileName,
            mimeType: reservedMime,
            declaredSize: reservedBytes,
            ownerPid: this.ownerPid,
            ownerStartTime: this.ownerStartTime,
            policy: this.dependencies.policy(),
            now: this.now(),
            binding: {
              ...identity.authority,
              requestId: identity.requestId.toLowerCase(),
              requestDigest: identity.requestDigest,
              direction: identity.direction,
              expectedSha256: null,
            },
            persist: (token, record) => this.persistReceipt(token, record),
          })
        : this.reserve(userId, "codespace_input", fileName, reservedMime, reservedBytes));
    if (!reserved)
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Transfer quota exceeded");
    if (identity && !reserved.token)
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Native ingestion is pending");
    let response: CodespaceNativeReferenceResponse | undefined;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      response = await fetcher.fetch(reference);
      const responseMime = response.mimeType.toLowerCase().split(";", 1)[0].trim();
      const mimeType = reference.mimeType ?? responseMime;
      if (
        !supportedCodespaceTransferMime(responseMime) ||
        (reference.mimeType !== undefined && responseMime !== reference.mimeType) ||
        (response.contentLength !== null &&
          (!Number.isSafeInteger(response.contentLength) ||
            response.contentLength < 0 ||
            (reference.declaredSize !== undefined &&
              response.contentLength !== reference.declaredSize)))
      ) {
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Native file metadata mismatch",
        );
      }
      if (response.contentLength !== null && response.contentLength > reservedBytes) {
        throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Native file exceeds its limit");
      }
      return await this.publishStream(
        reserved,
        response.body,
        mimeType,
        reference.declaredSize ?? response.contentLength ?? undefined,
        undefined,
        identity?.beforePublish,
      );
    } catch (error) {
      await this.discard(reserved.record);
      throw error;
    } finally {
      response?.cancel?.();
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
          if (this.now() >= reserved.record.expiresAt)
            throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Transfer fetch expired");
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
        )
      ) {
        throw new Error("Transfer expired before publication");
      }
      return this.handle(
        reserved.token,
        { ...reserved.record, declaredSize: size, mimeType },
        sha256,
      );
    } catch (error) {
      await this.discard(reserved.record);
      throw error;
    } finally {
      validator.destroy();
    }
  }

  getOwnedTransfer(userId: string, id: string): CodespaceTransferRecord | null {
    return id.startsWith("codespace-file://")
      ? this.dependencies.repository.getByToken(userId, this.token(id))
      : this.dependencies.repository.getOwned(userId, id);
  }

  getByRequest(userId: string, requestId: string): CodespaceTransferRecord | null {
    return this.dependencies.repository.getByRequest(userId, requestId.toLowerCase());
  }

  async openOwnedSource(
    userId: string,
    id: string,
    authority?: CodespaceTransferAuthority,
  ): Promise<CodespaceVerifiedByteSource> {
    const record = this.getOwnedTransfer(userId, id);
    if (!record || !["ready", "claimed"].includes(record.state) || record.expiresAt <= this.now()) {
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer is unavailable");
    }
    if (authority) this.checkAuthority(record, authority);
    return this.source(record);
  }

  async reserveResumable(
    userId: string,
    input: {
      requestId: string;
      requestDigest: string;
      purpose: "codespace_input" | "codespace_download";
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
      authority: CodespaceTransferAuthority;
    },
  ): Promise<CodespaceTransferStatus> {
    this.validateFileMetadata(input.fileName, input.mimeType, input.size);
    if (!["codespace_input", "codespace_download"].includes(input.purpose)) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer purpose");
    }
    this.validateIdentity(input.requestId, input.requestDigest, input.authority);
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer identity");
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const reserved = this.dependencies.repository.reserve({
      userId,
      purpose: input.purpose,
      fileName: input.fileName,
      mimeType: input.mimeType,
      declaredSize: input.size,
      ownerPid: this.ownerPid,
      ownerStartTime: this.ownerStartTime,
      policy: this.dependencies.policy(),
      now: this.now(),
      binding: {
        ...input.authority,
        requestId: input.requestId.toLowerCase(),
        requestDigest: input.requestDigest,
        direction: input.purpose === "codespace_download" ? "guest_to_server" : "server_to_guest",
        expectedSha256: input.sha256,
      },
      persist: (token, record) => this.persistReceipt(token, record),
    });
    if (!reserved)
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Transfer quota exceeded");
    const record = reserved.record;
    this.checkAuthority(record, input.authority);
    if (
      record.requestDigest !== input.requestDigest ||
      record.purpose !== input.purpose ||
      record.fileName !== input.fileName ||
      record.mimeType !== input.mimeType ||
      record.declaredSize !== input.size ||
      record.expectedSha256 !== input.sha256
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Transfer identity conflict");
    }
    return this.status(record);
  }

  async getTransferStatus(
    userId: string,
    id: string,
    authority: CodespaceTransferAuthority,
  ): Promise<CodespaceTransferStatus> {
    return this.status(this.requireTransfer(userId, id, authority));
  }

  async writeTransferChunk(
    userId: string,
    id: string,
    authority: CodespaceTransferAuthority,
    input: { offset: number; bytes: Uint8Array; sha256: string },
  ): Promise<CodespaceTransferStatus> {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.bytes.byteLength > 256 * 1024 ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer chunk");
    }
    this.dependencies.repository.mutate(userId, id, (record) => {
      this.checkAuthority(record, authority);
      const offset = record.uploadedBytes ?? 0;
      if (input.offset > offset || input.offset + input.bytes.byteLength > record.declaredSize) {
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Transfer chunk offset conflict",
        );
      }
      const fd = openSync(
        this.path(record.objectKey, record.state === "reserved" ? ".partial" : ""),
        record.state === "reserved"
          ? constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW
          : constants.O_RDONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < offset)
          throw new Error("Transfer partial changed");
        if (input.offset < offset || record.state !== "reserved") {
          if (input.offset + input.bytes.byteLength > offset)
            throw new Error("Transfer chunk overlap");
          const previous = Buffer.alloc(Math.min(256 * 1024, input.bytes.length));
          if (
            readSync(fd, previous, 0, previous.length, input.offset) !== previous.length ||
            createHash("sha256").update(previous).digest("hex") !== input.sha256
          )
            throw new Error("Transfer chunk replay conflict");
          const after = fstatSync(fd);
          const path = lstatSync(
            this.path(record.objectKey, record.state === "reserved" ? ".partial" : ""),
          );
          if (
            path.dev !== after.dev ||
            path.ino !== after.ino ||
            after.nlink !== 1 ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          ) {
            throw new Error("Transfer chunk changed during replay");
          }
          return;
        }
        if (stat.size !== offset) ftruncateSync(fd, offset);
        let written = 0;
        while (written < input.bytes.byteLength) {
          const count = writeSync(
            fd,
            input.bytes,
            written,
            input.bytes.byteLength - written,
            offset + written,
          );
          if (!count) throw new Error("Transfer write made no progress");
          written += count;
        }
        fsyncSync(fd);
        const after = fstatSync(fd);
        const path = lstatSync(this.path(record.objectKey, ".partial"));
        if (path.dev !== after.dev || path.ino !== after.ino || after.nlink !== 1)
          throw new Error("Transfer partial changed");
        this.dependencies.repository.checkpoint(id, offset + written, this.now());
      } finally {
        closeSync(fd);
      }
    });
    return this.status(this.requireTransfer(userId, id, authority));
  }

  async finalizeTransfer(
    userId: string,
    id: string,
    authority: CodespaceTransferAuthority,
    authorize?: () => Promise<void>,
  ): Promise<CodespaceTransferHandle> {
    let record = this.requireTransfer(userId, id, authority);
    if (record.state !== "reserved") {
      const source = await this.source(record).open();
      await source.close();
      return this.handle(await this.receiptToken(record), record, record.sha256!);
    }
    if ((record.uploadedBytes ?? 0) !== record.declaredSize)
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Transfer is incomplete");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let filePath = this.path(record.objectKey, ".partial");
    let file;
    try {
      file = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        filePath = this.path(record.objectKey);
        file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (missing) {
        if (record.declaredSize !== 0 || (missing as NodeJS.ErrnoException).code !== "ENOENT")
          throw missing;
        filePath = this.path(record.objectKey, ".partial");
        file = await open(filePath, "wx", 0o600);
      }
    }
    const validator = new TransferMimeValidator(record.mimeType);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(record.declaredSize))
        throw new Error("Transfer object changed");
      const hash = createHash("sha256");
      for (let offset = 0; offset < record.declaredSize;) {
        const bytes = Buffer.alloc(Math.min(256 * 1024, record.declaredSize - offset));
        const read = await file.read(bytes, 0, bytes.length, offset);
        if (!read.bytesRead) throw new Error("Transfer object changed");
        const chunk = bytes.subarray(0, read.bytesRead);
        hash.update(chunk);
        await validator.write(chunk);
        offset += read.bytesRead;
      }
      await validator.finish();
      const sha256 = hash.digest("hex");
      if (sha256 !== record.expectedSha256)
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Transfer digest mismatch");
      await file.sync();
      await authorize?.();
      this.dependencies.repository.mutate(userId, id, (current) => {
        this.checkAuthority(current, authority);
        if (current.state !== "reserved") return;
        if (
          (current.uploadedBytes ?? 0) !== current.declaredSize ||
          current.expectedSha256 !== sha256
        )
          throw new Error("Transfer checkpoint changed");
        const after = fstatSync(file.fd, { bigint: true });
        const path = lstatSync(filePath, { bigint: true });
        if (
          after.nlink !== 1n ||
          path.nlink !== 1n ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          path.dev !== before.dev ||
          path.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs ||
          path.mtimeNs !== before.mtimeNs ||
          path.ctimeNs !== before.ctimeNs
        )
          throw new Error("Transfer object changed during publication");
        if (filePath !== this.path(current.objectKey))
          renameSync(filePath, this.path(current.objectKey));
        const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
        if (!this.dependencies.repository.markReady(id, current.declaredSize, sha256, this.now()))
          throw new Error("Transfer publication lost authority");
      });
    } finally {
      validator.destroy();
      await file.close();
    }
    record = this.requireTransfer(userId, id, authority);
    return this.handle(await this.receiptToken(record), record, record.sha256!);
  }

  async readTransferRange(
    userId: string,
    id: string,
    authority: CodespaceTransferAuthority,
    input: { offset: number; length: number },
  ): Promise<{ bytes: Buffer; sha256: string }> {
    const record = this.requireTransfer(userId, id, authority);
    if (
      record.state === "reserved" ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > record.declaredSize ||
      !Number.isSafeInteger(input.length) ||
      input.length < 0 ||
      input.length > 256 * 1024
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer byte range");
    }
    const opened = await this.openStream(record, undefined, input);
    try {
      const wanted = Math.min(input.length, record.declaredSize - input.offset);
      const bytes = Buffer.alloc(wanted);
      let copied = 0;
      for await (const chunk of opened) {
        bytes.set(chunk, copied);
        copied += chunk.byteLength;
      }
      if (copied !== wanted) throw new Error("Transfer range changed");
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await opened.close();
    }
  }

  private checkAuthority(
    record: CodespaceTransferRecord,
    authority: CodespaceTransferAuthority,
  ): void {
    if (
      record.expiresAt <= this.now() ||
      record.state === "consumed" ||
      record.resourceId !== authority.resourceId ||
      record.provider !== authority.provider ||
      record.resourceGeneration !== authority.resourceGeneration ||
      record.authorizationGeneration !== authority.authorizationGeneration ||
      record.environmentIdentity !== authority.environmentIdentity
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer authority is unavailable",
      );
    }
  }

  private validateIdentity(
    requestId: string,
    requestDigest: string,
    authority: CodespaceTransferAuthority,
  ): void {
    if (
      !z.string().uuid().safeParse(requestId).success ||
      !/^[a-f0-9]{64}$/.test(requestDigest) ||
      !authority.resourceId ||
      !authority.provider ||
      !authority.environmentIdentity ||
      !Number.isSafeInteger(authority.resourceGeneration) ||
      authority.resourceGeneration < 0 ||
      !Number.isSafeInteger(authority.authorizationGeneration) ||
      authority.authorizationGeneration < 0
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid transfer identity");
    }
  }

  private requireTransfer(
    userId: string,
    id: string,
    authority: CodespaceTransferAuthority,
  ): CodespaceTransferRecord {
    const record = this.dependencies.repository.getOwned(userId, id);
    if (!record || !record.requestId || !record.expectedSha256)
      throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Transfer is unavailable");
    this.checkAuthority(record, authority);
    return record;
  }

  private async status(record: CodespaceTransferRecord): Promise<CodespaceTransferStatus> {
    if (
      !record.requestId ||
      !record.requestDigest ||
      !record.direction ||
      !record.expectedSha256 ||
      record.state === "consumed"
    ) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Transfer status is unavailable",
      );
    }
    const result = {
      transferId: record.id,
      requestId: record.requestId,
      requestDigest: record.requestDigest,
      direction: record.direction,
      offset: record.uploadedBytes ?? 0,
      size: record.declaredSize,
      sha256: record.expectedSha256,
      expiresAt: record.expiresAt,
    };
    return record.state === "reserved"
      ? { ...result, state: "reserved" }
      : {
          ...result,
          state: record.state,
          handle: this.handle(await this.receiptToken(record), record, record.sha256!),
        };
  }

  private persistReceipt(token: string, record: CodespaceTransferRecord): void {
    const fd = openSync(
      this.path(record.objectKey, ".receipt"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const bytes = Buffer.from(JSON.stringify({ token, id: record.id }));
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!count) throw new Error("Transfer receipt write made no progress");
        offset += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  private async receiptToken(record: CodespaceTransferRecord): Promise<string> {
    const handle = await open(
      this.path(record.objectKey, ".receipt"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512)
        throw new Error("Transfer receipt is invalid");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error("Transfer receipt changed");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      const path = await lstat(this.path(record.objectKey, ".receipt"));
      if (
        after.nlink !== 1 ||
        path.nlink !== 1 ||
        after.size !== stat.size ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        path.dev !== stat.dev ||
        path.ino !== stat.ino ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("Transfer receipt changed");
      const receipt = JSON.parse(bytes.toString("utf8")) as { token: string; id: string };
      const owned = this.dependencies.repository.getByToken(record.userId, receipt.token);
      if (receipt.id !== record.id || !TOKEN.test(receipt.token) || owned?.id !== record.id)
        throw new Error("Transfer receipt is invalid");
      return receipt.token;
    } finally {
      await handle.close();
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

  /** Internal relay objects are never published as downloadable bearer references. */
  relayPartLimit(): number {
    return effectiveCodespaceLimits(this.dependencies.policy()).relayTransfers.maxFileBytes;
  }

  async retainRelayPart(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    bytes: Uint8Array,
    expiresAt?: number,
  ): Promise<LocalRelayPayloadReference["parts"][number]> {
    if (
      !["local_relay_input", "local_relay_output", "operation_input", "operation_result"].includes(
        purpose,
      )
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid relay purpose");
    }
    const reserved = this.reserve(
      userId,
      purpose,
      "relay.bin",
      "application/octet-stream",
      bytes.byteLength,
      expiresAt,
    );
    const handle = await this.publishObject(reserved, bytes);
    return { transferId: reserved.record.id, sha256: handle.sha256, size: handle.size };
  }

  async retainRelayPayload(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    input: Uint8Array,
    expiresAt?: number,
  ): Promise<LocalRelayPayloadReference> {
    if (input.byteLength > 24 * 1024 * 1024) {
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Relay payload exceeds its limit");
    }
    const bytes = Buffer.from(input);
    const partSize = this.relayPartLimit();
    const reference: LocalRelayPayloadReference = {
      parts: [],
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    try {
      for (
        let offset = 0;
        offset < bytes.length || reference.parts.length === 0;
        offset += partSize
      ) {
        if (reference.parts.length >= LOCAL_RELAY_MAX_PARTS) {
          throw new CodespaceResourceError(
            "CODESPACE_POLICY_LIMIT",
            "Relay payload has too many parts",
          );
        }
        reference.parts.push(
          await this.retainRelayPart(
            userId,
            purpose,
            bytes.subarray(offset, offset + partSize),
            expiresAt,
          ),
        );
      }
      return localRelayPayloadReferenceSchema.parse(reference);
    } catch (error) {
      await this.discardRelayPayload(userId, purpose, reference);
      throw error;
    }
  }

  async readRelayChunk(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    reference: LocalRelayPayloadReference,
    partIndex: number,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const valid = localRelayPayloadReferenceSchema.parse(reference);
    if (
      !Number.isSafeInteger(partIndex) ||
      partIndex < 0 ||
      partIndex >= valid.parts.length ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 256 * 1024
    ) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid relay byte range");
    }
    const part = valid.parts[partIndex];
    const record = this.relayPart(userId, purpose, part);
    if (offset > part.size) {
      throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Invalid relay byte range");
    }
    const bytes = await this.readVerified(record);
    return bytes.subarray(offset, Math.min(part.size, offset + length));
  }

  async readRelayPayload(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    reference: LocalRelayPayloadReference,
  ): Promise<Buffer> {
    const valid = localRelayPayloadReferenceSchema.parse(reference);
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    for (const part of valid.parts) {
      const bytes = await this.readVerified(this.relayPart(userId, purpose, part));
      hash.update(bytes);
      chunks.push(bytes);
    }
    if (hash.digest("hex") !== valid.sha256) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Relay payload digest mismatch",
      );
    }
    return Buffer.concat(chunks, valid.size);
  }

  async discardRelayPayload(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    reference: LocalRelayPayloadReference,
  ): Promise<void> {
    for (const part of reference.parts) {
      const record = this.dependencies.repository.getReadyOwned(
        part.transferId,
        userId,
        purpose,
        this.now(),
      );
      if (record && record.sha256 === part.sha256 && record.observedSize === part.size)
        await this.discard(record);
    }
  }

  private relayPart(
    userId: string,
    purpose: "local_relay_input" | "local_relay_output" | "operation_input" | "operation_result",
    part: LocalRelayPayloadReference["parts"][number],
  ): CodespaceTransferRecord {
    const record = this.dependencies.repository.getReadyOwned(
      part.transferId,
      userId,
      purpose,
      this.now(),
    );
    if (!record || record.sha256 !== part.sha256 || record.observedSize !== part.size) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Relay payload is unavailable",
      );
    }
    return record;
  }

  async claimInput(
    userId: string,
    referenceId: string,
  ): Promise<{ record: CodespaceTransferRecord; bytes: Buffer }> {
    const token = this.token(referenceId);
    const now = this.now();
    const record = this.dependencies.repository.claim(
      token,
      "codespace_input",
      now,
      Math.min(now + 60_000, now + (this.dependencies.policy().claimLeaseMs ?? 30_000)),
      this.dependencies.policy(),
      userId,
    );
    if (!record) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Native file reference is unavailable",
      );
    }
    if ((record.observedSize ?? 0) > 4 * 1024 * 1024) {
      this.release(record);
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Bounded input exceeds its limit");
    }
    try {
      const bytes = await this.readVerified(record);
      return { record, bytes };
    } catch (error) {
      await this.invalidate(record);
      throw error;
    }
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
      if (
        record.state === "reserved" &&
        record.expiresAt > this.now() &&
        (record.requestId || transferOwnerAlive(record))
      )
        continue;
      await this.discard(record);
    }
    for (const record of this.dependencies.repository.listLive()) {
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
    expiresAt?: number,
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
      expiresAt,
    });
    if (!value)
      throw new CodespaceResourceError("CODESPACE_POLICY_LIMIT", "Transfer quota exceeded");
    return value;
  }

  private validateReference(reference: CodespaceNativeFileReference): void {
    if (!FILE_ID.test(reference.fileId) || reference.fileId.length > 256) {
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Invalid native file identifier",
      );
    }
    this.validateFileMetadata(
      reference.fileName ?? "attachment.bin",
      reference.mimeType ?? "application/octet-stream",
      reference.declaredSize ?? 0,
    );
  }

  private validateFileMetadata(fileName: string, mimeType: string, size: number): void {
    if (
      !isSafeAttachmentFilename(fileName) ||
      !supportedCodespaceTransferMime(mimeType) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > effectiveCodespaceLimits(this.dependencies.policy()).transfers.maxFileBytes
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

  private async readVerified(record: CodespaceTransferRecord): Promise<Buffer> {
    if ((record.observedSize ?? 0) > 4 * 1024 * 1024) {
      throw new CodespaceResourceError(
        "CODESPACE_POLICY_LIMIT",
        "Bounded control object exceeds its limit",
      );
    }
    const stream = await this.source(record).open();
    try {
      const bytes = Buffer.alloc(record.observedSize!);
      let offset = 0;
      for await (const chunk of stream) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== bytes.length) throw new Error("Codespace transfer object changed");
      return bytes;
    } finally {
      await stream.close();
    }
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
      !["codespace_input", "codespace_download"].includes(record.purpose) ||
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
        stored.expiresAt <= this.now() ||
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
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const close = () => {
      if (!closePromise) {
        closed = true;
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
            const leaseMs =
              record.purpose === "codespace_download"
                ? 60_000
                : Math.min(60_000, this.dependencies.policy().claimLeaseMs ?? 30_000);
            const now = this.now();
            if (
              !this.dependencies.repository.renewClaim(
                record.id,
                record.claimId,
                now,
                Math.min(record.expiresAt, now + leaseMs),
              )
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
