import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const MAX_FILE_PATH_BYTES = 4096;
const DESCRIPTOR_ROOT = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

function fail(message) {
  throw new Error(message);
}

export function failFile(reason, message) {
  const error = new Error(message);
  error.fileReason = reason;
  throw error;
}

export async function readStateJson(path) {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) {
    fail("invalid supervisor state file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export function safeRelativePath(value, allowRoot = false) {
  if (allowRoot && value === ".") return ".";
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_FILE_PATH_BYTES ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    failFile("unsafe_access", "invalid codespace path");
  }
  return value.replaceAll("\\", "/");
}

export function descriptorPath(handle, name = "") {
  if (process.platform !== "linux" && handle.moiraPath) {
    return name ? join(handle.moiraPath, name) : handle.moiraPath;
  }
  return name ? `${DESCRIPTOR_ROOT}/${handle.fd}/${name}` : `${DESCRIPTOR_ROOT}/${handle.fd}`;
}

export async function syncDirectory(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform === "linux" || !["EINVAL", "ENOTSUP"].includes(error?.code)) throw error;
  }
}

// File fsync cannot publish a newly created directory's entry in its parent.
// Persist the complete namespace ancestry before its first admitted effect.
export async function persistDirectory(path) {
  let current = resolve(path);
  while (true) {
    const handle = await openDirectory(current);
    try {
      await syncDirectory(handle);
    } finally {
      await handle.close();
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function openDirectory(root, relative = ".") {
  const normalized = safeRelativePath(relative, true);
  const rootPath = typeof root === "string" ? root : root.path;
  const inspectedRoot = await lstat(rootPath);
  const rootHandle = await open(
    rootPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  rootHandle.moiraPath = rootPath;
  let current = rootHandle;
  try {
    const openedRoot = await rootHandle.stat();
    if (
      !openedRoot.isDirectory() ||
      openedRoot.dev !== inspectedRoot.dev ||
      openedRoot.ino !== inspectedRoot.ino ||
      (typeof root !== "string" && (openedRoot.dev !== root.dev || openedRoot.ino !== root.ino))
    ) {
      failFile("concurrent_change", "codespace root changed during validation");
    }
    if (normalized === ".") return current;
    for (const part of normalized.split("/")) {
      const child = await open(
        descriptorPath(current, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      child.moiraPath = join(current.moiraPath, part);
      const value = await child.stat();
      if (!value.isDirectory()) {
        await child.close();
        failFile("unsafe_access", "codespace parent is not a directory");
      }
      if (current !== rootHandle) await current.close();
      current = child;
    }
    if (current !== rootHandle) await rootHandle.close();
    return current;
  } catch (error) {
    if (current !== rootHandle) await current.close().catch(() => undefined);
    await rootHandle.close().catch(() => undefined);
    throw error;
  }
}

export async function inspectPath(root, relative, allowDirectory = false) {
  const normalized = safeRelativePath(relative, allowDirectory);
  if (normalized === ".") {
    const handle = await openDirectory(root);
    return { handle, stat: await handle.stat(), relative: normalized };
  }
  const parts = normalized.split("/");
  const name = parts.pop();
  const parent = await openDirectory(root, parts.length ? parts.join("/") : ".");
  try {
    const handle = await open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handle.moiraPath = join(parent.moiraPath, name);
    const value = await handle.stat();
    if (!(value.isDirectory() && allowDirectory) && (!value.isFile() || value.nlink !== 1)) {
      await handle.close();
      failFile("unsafe_access", "codespace path is not an allowed file type");
    }
    return { handle, stat: value, relative: normalized };
  } finally {
    await parent.close();
  }
}

/** One confined descriptor owns both content access and the final path/identity observation. */
export async function withRegularFile(
  root,
  relative,
  work,
  { keepOpen = false, inspected: opened } = {},
) {
  const inspected = opened ?? (await inspectPath(root, relative));
  const handle = inspected.handle;
  let transferred = false;
  try {
    const current = await handle.stat({ bigint: true });
    if (!current.isFile() || current.nlink !== 1n)
      failFile("unsafe_access", "codespace path is not an allowed regular file");
    if (current.size > BigInt(Number.MAX_SAFE_INTEGER))
      failFile("unsafe_access", "file offsets cannot be represented exactly");
    const result = await work(handle, Number(current.size));
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      after.nlink !== 1n
    ) {
      failFile("concurrent_change", "codespace file changed during read");
    }
    // The held inode can remain linked after its parent is moved out of this path.
    // Resolve the confined path again rather than treating an unchanged descriptor as enough.
    let named;
    try {
      named = await inspectPath(root, inspected.relative);
      if (
        !sameFileIdentity(
          fileIdentity(current),
          fileIdentity(await named.handle.stat({ bigint: true })),
        )
      )
        failFile("concurrent_change", "codespace path changed during read");
    } catch {
      failFile("concurrent_change", "codespace path changed during read");
    } finally {
      await named?.handle.close();
    }
    transferred = keepOpen;
    return {
      ...result,
      stat: {
        size: Number(after.size),
        mode: Number(after.mode),
        mtimeMs: Number(after.mtimeNs / 1_000_000n),
        identity: fileIdentity(after),
      },
      path: inspected.relative,
      // With keepOpen the caller owns this descriptor. While it stays open the inode
      // cannot be recycled, and an unlinked original reports zero links on it.
      handle: keepOpen ? handle : null,
    };
  } finally {
    if (!transferred) await handle.close();
  }
}

export async function hashRegular(handle, size) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(size, 256 * 1024));
  for (let offset = 0; offset < size;) {
    const length = Math.min(chunk.length, size - offset);
    const read = await handle.read(chunk, 0, length, offset);
    if (read.bytesRead === 0)
      failFile("concurrent_change", "codespace file changed during hashing");
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest("hex");
}

export async function writeAll(handle, bytes, position = 0) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (written.bytesWritten === 0) fail("codespace write made no progress");
    offset += written.bytesWritten;
  }
}

export function version(bytes, value) {
  return {
    size: bytes ? bytes.length : value.size,
    sha256: value.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
    modifiedAt: Math.trunc(value.mtimeMs),
  };
}

export function validateExpected(expected, current) {
  if (!expected || typeof expected.exists !== "boolean") fail("invalid file precondition");
  if (expected.exists !== Boolean(current)) failFile("precondition", "file precondition failed");
  if (!current) return;
  const actual = version(current.bytes, current.stat);
  if (expected.size !== undefined && expected.size !== actual.size)
    failFile("precondition", "file size precondition failed");
  if (expected.sha256 !== undefined && expected.sha256 !== actual.sha256)
    failFile("precondition", "file digest precondition failed");
}

/**
 * Identity of a regular file captured from a bigint stat. Device and inode alone are
 * not enough: Linux filesystems recycle a freed inode number immediately, so a file
 * removed and recreated with the same bytes between staging and commit would pass an
 * inode check. Size and nanosecond timestamps distinguish that substitution.
 */
export function fileIdentity(value) {
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    nlink: value.nlink.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
    birthtimeNs: value.birthtimeNs.toString(),
  };
}

/**
 * Compare two file identities. A rename we performed ourselves updates the change
 * time, so the post-rename check keeps every other field and skips ctime.
 */
export function sameFileIdentity(left, right, { afterRename = false } = {}) {
  return Boolean(
    left &&
    right &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.nlink === "1" &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    (!left.birthtimeNs || left.birthtimeNs === right.birthtimeNs) &&
    (afterRename || left.ctimeNs === right.ctimeNs),
  );
}

export async function directoryIdentity(handle) {
  const value = await handle.stat({ bigint: true });
  if (!value.isDirectory()) fail("codespace parent is not a directory");
  return { dev: value.dev.toString(), ino: value.ino.toString() };
}

export function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export async function verifyParentIdentity(root, relative, expected) {
  const location = await parentDirectory(root, relative);
  try {
    const current = await directoryIdentity(location.handle);
    if (!sameDirectoryIdentity(current, expected)) {
      failFile("concurrent_change", "codespace parent identity changed during commit");
    }
  } finally {
    await location.handle.close();
  }
}

export async function verifyEntryIdentity(parentHandle, name, expected) {
  const handle = await open(
    descriptorPath(parentHandle, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const current = await handle.stat({ bigint: true });
    if (
      !current.isFile() ||
      !sameFileIdentity(expected, fileIdentity(current), { afterRename: true })
    ) {
      failFile("concurrent_change", "codespace target identity changed during commit");
    }
  } finally {
    await handle.close();
  }
}

export async function parentDirectory(root, relative) {
  const normalized = safeRelativePath(relative);
  const parts = normalized.split("/");
  const name = parts.pop();
  const handle = await openDirectory(root, parts.length ? parts.join("/") : ".");
  return { handle, name, relative: normalized };
}

export async function currentFile(root, relative, { keepOpen = false } = {}) {
  try {
    const current = await withRegularFile(
      root,
      relative,
      async (handle, size) => ({ sha256: await hashRegular(handle, size) }),
      { keepOpen },
    );
    return { ...current, stat: { ...current.stat, sha256: current.sha256 } };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function cleanupStaged(staged) {
  let cleanupError = null;
  for (const item of staged) {
    if (item.closed) continue;
    try {
      try {
        await verifyEntryIdentity(item.handle, item.temporaryName, item.identity);
        await rm(descriptorPath(item.handle, item.temporaryName));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await syncDirectory(item.handle);
    } catch (error) {
      cleanupError ??= error;
    } finally {
      await item.stagingHandle?.close().catch((error) => {
        cleanupError ??= error;
      });
      if (item.current?.handle) {
        await item.current.handle.close().catch((error) => {
          cleanupError ??= error;
        });
      }
      try {
        await item.handle.close();
      } catch (error) {
        cleanupError ??= error;
      }
      item.closed = true;
    }
  }
  return cleanupError;
}

export async function writeDurableJson(directory, name, value) {
  const parent = await openDirectory(directory);
  const temporaryName = `.${name}.${randomBytes(8).toString("hex")}.tmp`;
  const temporary = descriptorPath(parent, temporaryName);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await writeAll(handle, Buffer.from(JSON.stringify(value)));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, descriptorPath(parent, name));
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
    await parent.close();
  }
}

export async function commitStaged(staged, marker, directory) {
  const entries = staged.map((item) => ({
    target: item.relative,
    parentDev: item.parentIdentity.dev,
    parentIno: item.parentIdentity.ino,
    temporaryName: item.temporaryName,
    backup: item.current ? `.moira-${marker}-${randomBytes(8).toString("hex")}.bak` : null,
    hadOriginal: Boolean(item.current),
    commitAttempted: false,
    originalSha256: item.current ? version(item.current.bytes, item.current.stat).sha256 : null,
    originalIdentity: item.current?.stat.identity ?? null,
    desiredSha256: item.sha256 ?? createHash("sha256").update(item.bytes).digest("hex"),
    ...(item.identity ? { desiredIdentity: item.identity } : {}),
  }));
  await writeDurableJson(directory, "file-transaction.json", entries);
  let commitError = null;
  let cleanupError = null;
  try {
    for (let index = 0; index < staged.length; index++) {
      const item = staged[index];
      const entry = entries[index];
      await verifyParentIdentity(item.root, item.relative, item.parentIdentity);
      {
        if (
          !sameFileIdentity(
            item.identity,
            fileIdentity(await item.stagingHandle.stat({ bigint: true })),
          )
        )
          failFile("concurrent_change", "held staging inode changed before commit");
        const temporary = await open(
          descriptorPath(item.handle, item.temporaryName),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const identity = fileIdentity(await temporary.stat({ bigint: true }));
          if (
            !sameFileIdentity(item.identity, identity) ||
            (await hashRegular(temporary, item.size ?? item.bytes.length)) !== entry.desiredSha256
          )
            failFile("concurrent_change", "staged transfer changed before commit");
        } finally {
          await temporary.close();
        }
      }
      const current = await currentFile(item.root, item.relative, { stream: item.stream });
      validateExpected(
        item.current
          ? {
              exists: true,
              size: item.current.stat.size,
              sha256: version(item.current.bytes, item.current.stat).sha256,
            }
          : { exists: false },
        current,
      );
      if (item.current) {
        // The descriptor held since staging pins the original inode: a removed or
        // replaced original shows zero links there even when the path now resolves to
        // a recreated file with an identical inode number and timestamps.
        const held = fileIdentity(await item.current.handle.stat({ bigint: true }));
        if (
          !sameFileIdentity(item.current.stat.identity, held) ||
          !sameFileIdentity(item.current.stat.identity, current?.stat.identity)
        ) {
          failFile("concurrent_change", "codespace target identity changed during commit");
        }
      }
      const target = descriptorPath(item.handle, item.name);
      const temporary = descriptorPath(item.handle, item.temporaryName);
      const backup = entry.backup ? descriptorPath(item.handle, entry.backup) : null;
      // Persist the possibility of a rename before granting that effect. A staged
      // journal alone does not authorize recovery to touch a changed target.
      entry.commitAttempted = true;
      await writeDurableJson(directory, "file-transaction.json", entries);
      if (item.current) {
        await rename(target, backup);
        await syncDirectory(item.handle);
        await verifyEntryIdentity(item.handle, entry.backup, item.current.stat.identity);
      }
      await verifyEntryIdentity(item.handle, item.temporaryName, item.identity);
      await rename(temporary, target);
      await syncDirectory(item.handle);
      await verifyEntryIdentity(item.handle, item.name, item.identity);
    }
  } catch (error) {
    commitError = error;
    await recoverFileTransaction(directory, staged[0].root);
    throw error;
  } finally {
    cleanupError = await cleanupStaged(staged);
  }
  if (!commitError && cleanupError) throw cleanupError;
}

function validateTransactionEntry(entry, root) {
  if (
    !root ||
    !entry ||
    typeof entry.target !== "string" ||
    safeRelativePath(entry.target) !== entry.target ||
    typeof entry.parentDev !== "string" ||
    !/^[0-9]+$/.test(entry.parentDev) ||
    typeof entry.parentIno !== "string" ||
    !/^[0-9]+$/.test(entry.parentIno) ||
    (entry.commitAttempted !== undefined && typeof entry.commitAttempted !== "boolean") ||
    typeof entry.temporaryName !== "string" ||
    !entry.temporaryName.startsWith(".moira-") ||
    entry.temporaryName.includes("/") ||
    entry.temporaryName.includes("\\") ||
    !(
      entry.backup === null ||
      (typeof entry.backup === "string" &&
        entry.backup.startsWith(".moira-") &&
        !entry.backup.includes("/") &&
        !entry.backup.includes("\\"))
    )
  ) {
    fail("invalid file transaction journal");
  }
}

async function preserveFileTransactionConflict(directory) {
  await rename(
    join(directory, "file-transaction.json"),
    join(directory, "file-transaction.conflicted.json"),
  );
  const stateDirectory = await openDirectory(directory);
  try {
    await syncDirectory(stateDirectory);
  } finally {
    await stateDirectory.close();
  }
}

export async function cleanupFileTransaction(directory, root) {
  try {
    const entries = await readStateJson(join(directory, "file-transaction.json"));
    if (!Array.isArray(entries)) fail("invalid file transaction journal");
    if (
      entries.some(
        (entry) => !entry.desiredIdentity || (entry.hadOriginal && !entry.originalIdentity),
      )
    ) {
      // Historical terminal receipts remain collectible; absent inode proof cannot
      // authorize disposal of their old pathname entries or manufacture new proof.
      await preserveFileTransactionConflict(directory);
      return;
    }
    for (const entry of entries) {
      validateTransactionEntry(entry, root);
      await verifyParentIdentity(root, entry.target, {
        dev: entry.parentDev,
        ino: entry.parentIno,
      });
      const location = await parentDirectory(root, entry.target);
      try {
        const temporary = await ownedTransactionEntry(
          location.handle,
          entry.temporaryName,
          entry.desiredIdentity,
          entry.desiredSha256,
        );
        let backup;
        try {
          backup = entry.backup
            ? await ownedTransactionEntry(
                location.handle,
                entry.backup,
                entry.originalIdentity,
                entry.originalSha256,
              )
            : null;
          if (temporary) {
            await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
            await rm(descriptorPath(location.handle, entry.temporaryName));
          }
          if (backup) {
            await verifyEntryIdentity(location.handle, entry.backup, entry.originalIdentity);
            await rm(descriptorPath(location.handle, entry.backup));
          }
        } finally {
          await temporary?.close();
          await backup?.close();
        }
        await syncDirectory(location.handle);
      } finally {
        await location.handle.close();
      }
    }
    await rm(join(directory, "file-transaction.json"), { force: true });
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
  } catch (error) {
    if (error?.fileReason === "concurrent_change" || ["ELOOP", "ENOTDIR"].includes(error?.code)) {
      await preserveFileTransactionConflict(directory);
      return;
    }
    if (error?.code !== "ENOENT") throw error;
  }
}

async function ownedTransactionEntry(parent, name, expected, sha256) {
  let handle;
  try {
    handle = await open(
      descriptorPath(parent, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const value = await handle.stat({ bigint: true });
    if (
      !value.isFile() ||
      !sameFileIdentity(expected, fileIdentity(value), { afterRename: true }) ||
      (await hashRegular(handle, Number(value.size))) !== sha256
    )
      failFile("concurrent_change", "file transaction entry ownership changed");
    return handle;
  } catch (error) {
    await handle?.close();
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function recoverFileTransaction(directory, root) {
  let entries;
  try {
    entries = await readStateJson(join(directory, "file-transaction.json"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!Array.isArray(entries)) fail("invalid file transaction journal");
  const prepared = [];
  try {
    for (const entry of [...entries].reverse()) {
      validateTransactionEntry(entry, root);
      if (
        typeof entry.hadOriginal !== "boolean" ||
        !(
          entry.originalSha256 === null ||
          (typeof entry.originalSha256 === "string" && /^[a-f0-9]{64}$/.test(entry.originalSha256))
        ) ||
        typeof entry.desiredSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.desiredSha256) ||
        !(entry.backup === null || typeof entry.backup === "string")
      ) {
        fail("invalid file transaction journal");
      }
      try {
        await verifyParentIdentity(root, entry.target, {
          dev: entry.parentDev,
          ino: entry.parentIno,
        });
      } catch (error) {
        if (
          (["concurrent_change", "unsafe_access"].includes(error?.fileReason) ||
            ["ELOOP", "ENOTDIR"].includes(error?.code)) &&
          entries.every((candidate) => candidate.commitAttempted === false)
        ) {
          await preserveFileTransactionConflict(directory);
          return;
        }
        throw error;
      }
      if (!entry.desiredIdentity || (entry.hadOriginal && !entry.originalIdentity))
        failFile("concurrent_change", "file transaction has no retained inode ownership proof");
      const location = await parentDirectory(root, entry.target);
      const item = {
        entry,
        location,
        current: null,
        temporary: null,
        backup: null,
        targetWasDesired: false,
      };
      prepared.push(item);
      if (entry.commitAttempted === false) {
        item.temporary = await ownedTransactionEntry(
          location.handle,
          entry.temporaryName,
          entry.desiredIdentity,
          entry.desiredSha256,
        );
        item.backup = entry.backup
          ? await ownedTransactionEntry(
              location.handle,
              entry.backup,
              entry.originalIdentity,
              entry.originalSha256,
            )
          : null;
        if (item.backup)
          failFile("concurrent_change", "unattempted transaction has an unexpected backup");
        continue;
      }
      item.current = await currentFile(root, entry.target, { stream: true, keepOpen: true });
      if (item.current) {
        const identity = item.current.stat.identity;
        const digest = version(item.current.bytes, item.current.stat).sha256;
        item.targetWasDesired =
          sameFileIdentity(entry.desiredIdentity, identity, { afterRename: true }) &&
          digest === entry.desiredSha256;
        const original =
          entry.hadOriginal &&
          sameFileIdentity(entry.originalIdentity, identity, { afterRename: true }) &&
          digest === entry.originalSha256;
        if (!item.targetWasDesired && !original)
          failFile("concurrent_change", "codespace target ownership changed during recovery");
      }
      item.temporary = await ownedTransactionEntry(
        location.handle,
        entry.temporaryName,
        entry.desiredIdentity,
        entry.desiredSha256,
      );
      item.backup = entry.backup
        ? await ownedTransactionEntry(
            location.handle,
            entry.backup,
            entry.originalIdentity,
            entry.originalSha256,
          )
        : null;
      if (entry.hadOriginal && (!item.current || item.targetWasDesired) && !item.backup)
        fail("codespace backup is missing during recovery");
    }
    // Validate every retained inode before the first rollback effect; a later foreign
    // backup must not cause an earlier owned target to be removed.
    for (const item of prepared) {
      const { entry, location, current, targetWasDesired } = item;
      await verifyParentIdentity(root, entry.target, {
        dev: entry.parentDev,
        ino: entry.parentIno,
      });
      const target = descriptorPath(location.handle, location.name);
      if (entry.commitAttempted === false) {
        if (item.temporary) {
          await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
          await rm(descriptorPath(location.handle, entry.temporaryName));
          await syncDirectory(location.handle);
        }
        continue;
      }
      if (current) {
        const expected = targetWasDesired ? entry.desiredIdentity : entry.originalIdentity;
        if (
          !sameFileIdentity(expected, fileIdentity(await current.handle.stat({ bigint: true })), {
            afterRename: true,
          })
        )
          failFile("concurrent_change", "held recovery target changed");
        await verifyEntryIdentity(location.handle, location.name, expected);
      } else if (await currentFile(root, entry.target, { stream: true })) {
        failFile("concurrent_change", "recovery target appeared");
      }
      if (item.backup)
        await verifyEntryIdentity(location.handle, entry.backup, entry.originalIdentity);
      if (item.temporary)
        await verifyEntryIdentity(location.handle, entry.temporaryName, entry.desiredIdentity);
      if (targetWasDesired) await rm(target);
      if (item.backup) {
        if (!current || targetWasDesired)
          await rename(descriptorPath(location.handle, entry.backup), target);
        else await rm(descriptorPath(location.handle, entry.backup));
      }
      if (item.temporary) await rm(descriptorPath(location.handle, entry.temporaryName));
      await syncDirectory(location.handle);
    }
    await rm(join(directory, "file-transaction.json"), { force: true });
    const stateDirectory = await openDirectory(directory);
    await syncDirectory(stateDirectory);
    await stateDirectory.close();
  } finally {
    for (const item of prepared) {
      await item.current?.handle?.close();
      await item.temporary?.close();
      await item.backup?.close();
      await item.location.handle.close();
    }
  }
}

export async function stageStream(root, path, source, expected, marker) {
  const location = await parentDirectory(root, path);
  let current;
  let stagingHandle;
  let temporaryName;
  try {
    const parentIdentity = await directoryIdentity(location.handle);
    current = await currentFile(root, path, { stream: true, keepOpen: true });
    validateExpected(expected, current);
    temporaryName = `.moira-${marker}-${randomBytes(8).toString("hex")}.tmp`;
    stagingHandle = await open(
      descriptorPath(location.handle, temporaryName),
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      current?.stat.mode ? current.stat.mode & 0o777 : 0o600,
    );
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      await writeAll(stagingHandle, bytes, size);
      hash.update(bytes);
      size += bytes.length;
    }
    await stagingHandle.sync();
    const identity = fileIdentity(await stagingHandle.stat({ bigint: true }));
    await syncDirectory(location.handle);
    return {
      ...location,
      root: root,
      parentIdentity,
      temporaryName,
      current,
      stagingHandle,
      identity,
      size,
      sha256: hash.digest("hex"),
      stream: true,
      closed: false,
    };
  } catch (error) {
    try {
      if (stagingHandle) {
        const identity = fileIdentity(await stagingHandle.stat({ bigint: true }));
        await verifyEntryIdentity(location.handle, temporaryName, identity);
        await rm(descriptorPath(location.handle, temporaryName));
        await syncDirectory(location.handle);
      }
    } finally {
      await stagingHandle?.close();
      try {
        await current?.handle?.close();
      } finally {
        await location.handle.close();
      }
    }
    throw error;
  }
}
