import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { readPrivateOwnerJson as readJson } from "./private-json.mjs";
import {
  descriptorPath,
  directoryIdentity,
  fileIdentity,
  hashRegular,
  openDirectory,
  persistDirectory,
  sameDirectoryIdentity,
  sameFileIdentity,
  syncDirectory,
  verifyEntryIdentity,
  writeDurableJson,
} from "./file-primitives.mjs";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";

const FILE_KINDS = new Set(["write", "native-upload", "patch"]);
const COMMAND_TERMINAL = new Set(["succeeded", "failed", "cancelled", "timed_out", "not_started"]);
function unsafe() {
  throw Object.assign(new Error("UNSAFE_STATE"), { publicCode: "UNSAFE_STATE", status: 409 });
}
async function privateDirectory(path) {
  const handle = await openDirectory(path);
  try {
    const info = await handle.stat();
    if (info.uid !== process.getuid?.() || info.mode & 0o077) unsafe();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function paths(directory) {
  const requestId = directory.slice(dirname(directory).length + 1);
  if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId)) unsafe();
  return { requestId, root: join(dirname(dirname(directory)), "active-requests") };
}
function recoveryOriginal(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (FILE_KINDS.has(value.kind) || (value.kind === "exec" && /^[a-f0-9]{64}$/.test(value.digest))),
  );
}
async function readMembership(index, requestId, directory) {
  const path = descriptorPath(index, `${requestId}.json`);
  try {
    return await readJson(path);
  } catch (error) {
    if (error.publicCode !== "UNSAFE_STATE") throw error;
    const absent = async () => {
      try {
        await lstat(path);
        return false;
      } catch (failure) {
        if (failure.code === "ENOENT") return true;
        throw failure;
      }
    };
    if (!(await absent())) throw error;
    const acquired = typeof directory === "string";
    const request = acquired ? await privateDirectory(directory) : directory;
    try {
      if (!recoveryOriginal(await readJson(descriptorPath(request, "accepted.json")))) throw error;
    } finally {
      if (acquired) await request.close();
    }
    if (!(await absent())) throw error;
    // A physical collector may retire this membership after our guarded open.
    // Absence permits observation only; it never authorizes cleanup or an effect.
    return null;
  }
}
async function member(directory) {
  const { requestId, root } = paths(directory);
  const index = await privateDirectory(root);
  let request;
  try {
    request = await privateDirectory(directory);
    const value = await readMembership(index, requestId, request);
    if (
      value &&
      (value.version !== 1 ||
        value.requestId !== requestId ||
        !sameDirectoryIdentity(value.directory, await directoryIdentity(request)))
    )
      unsafe();
    return { value, index, request, requestId };
  } catch (error) {
    await index.close();
    await request?.close();
    throw error;
  }
}

export async function assertRequestIdentity(directory) {
  const { requestId, root } = paths(directory);
  const index = await privateDirectory(root);
  try {
    if (!(await readMembership(index, requestId, directory))) return;
  } finally {
    await index.close();
  }
  let held;
  try {
    held = await member(directory);
  } catch (error) {
    if (error.code === "ENOENT") unsafe();
    throw error;
  }
  try {
    if (held.value && !(await readJson(descriptorPath(held.request, "accepted.json")))) unsafe();
  } finally {
    await held.request.close();
    await held.index.close();
  }
}

/** Durable recovery membership precedes admission; an orphan is never reusable intent. */
export async function retainActiveRequest(directory) {
  const held = await member(directory);
  try {
    if (held.value) {
      if (!(await readJson(descriptorPath(held.request, "accepted.json")))) unsafe();
      return;
    }
    await writeDurableJson(held.index, `${held.requestId}.json`, {
      version: 1,
      requestId: held.requestId,
      directory: await directoryIdentity(held.request),
    });
  } finally {
    await held.request.close();
    await held.index.close();
  }
}

/** Import legacy recovery-bearing admissions once, under the existing exclusive owner gate. */
export async function initializeActiveRequests(stateRoot, requestsRoot) {
  const root = join(stateRoot, "active-requests");
  const marker = await readJson(join(stateRoot, "active-requests.json"));
  if (marker && marker.version !== 1) unsafe();
  if (!marker)
    await mkdir(root, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  const index = await privateDirectory(root);
  try {
    await persistDirectory(root);
    // Validate existing members even during an interrupted import. Missing admissions
    // cannot be explained away by a later inventory or by creating a fresh request.
    const existing = await readdir(root);
    for (const entry of existing) {
      if (!entry.endsWith(".json") || !WORKSPACE_REQUEST_ID_PATTERN.test(entry.slice(0, -5)))
        unsafe();
      const directory = join(requestsRoot, entry.slice(0, -5));
      const held = await member(directory);
      try {
        if (!(await readJson(descriptorPath(held.request, "accepted.json")))) unsafe();
      } finally {
        await held.request.close();
        await held.index.close();
      }
    }
    if (!marker) {
      for (const requestId of await readdir(requestsRoot)) {
        if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId)) unsafe();
        const directory = join(requestsRoot, requestId);
        const request = await privateDirectory(directory);
        let accepted;
        try {
          accepted = await readJson(descriptorPath(request, "accepted.json"));
        } finally {
          await request.close();
        }
        if (accepted && (accepted.kind === "exec" || FILE_KINDS.has(accepted.kind)))
          await retainActiveRequest(directory);
      }
      await writeDurableJson(stateRoot, "active-requests.json", { version: 1 });
    }
    return (await readdir(root)).map((entry) => {
      if (!entry.endsWith(".json") || !WORKSPACE_REQUEST_ID_PATTERN.test(entry.slice(0, -5)))
        unsafe();
      return entry.slice(0, -5);
    });
  } finally {
    await index.close();
  }
}

/** The owner and detached physical collector share this exact guarded retirement boundary. */
export async function retireRequestInput({ directory, resultDirectory, sourceSettled = false }) {
  const held = await member(directory);
  let input;
  try {
    if (!held.value) return false;
    const accepted = await readJson(descriptorPath(held.request, "accepted.json"));
    if (!accepted) unsafe();
    if (await readJson(descriptorPath(held.request, "file-transaction.conflicted.json")))
      return false;
    if (await readJson(descriptorPath(held.request, "file-transaction.json"))) return false;
    const result = await readJson(join(resultDirectory ?? directory, "result.json"));
    if (accepted.kind === "exec") {
      if (
        !result ||
        !COMMAND_TERMINAL.has(result.state) ||
        result.requestDigest !== accepted.digest
      )
        return false;
    } else if (
      !FILE_KINDS.has(accepted.kind) ||
      !["succeeded", "not_started", "interrupted"].includes(result?.state)
    )
      return false;
    const metadata = await readJson(descriptorPath(held.request, "input.json"));
    const expected = await readJson(descriptorPath(held.request, "input-identity.json"));
    const intent = await readJson(descriptorPath(held.request, "input-retirement.json"));
    const inputPath = descriptorPath(held.request, "input");
    if (metadata || expected) {
      // Only a physical reader or durable no-launch proof can settle staged stdin.
      // Legacy commands with no staged input need no invented reader proof.
      if (accepted.kind === "exec" && !sourceSettled && result.inputSettled !== true) return false;
      // Older dev/inode-only records remain retained: no fabricated timestamp proof.
      if (
        !metadata ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !expected?.mtimeNs ||
        !expected?.ctimeNs
      )
        return false;
      try {
        input = await open(
          inputPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (
          !intent ||
          JSON.stringify(intent.identity) !== JSON.stringify(expected) ||
          intent.sha256 !== metadata.sha256
        )
          return false;
      }
      if (input) {
        const info = await input.stat({ bigint: true });
        if (
          info.uid !== BigInt(process.getuid()) ||
          (info.mode & 0o077n) !== 0n ||
          !sameFileIdentity(expected, fileIdentity(info)) ||
          Number(info.size) !== metadata.size ||
          (await hashRegular(input, metadata.size)) !== metadata.sha256
        )
          return false;
        if (!sameFileIdentity(expected, fileIdentity(await input.stat({ bigint: true }))))
          return false;
        await writeDurableJson(held.request, "input-retirement.json", {
          identity: expected,
          sha256: metadata.sha256,
        });
        try {
          await verifyEntryIdentity(held.request, "input", expected);
          await rm(inputPath);
        } catch (error) {
          // The same durable terminal proof may be collected while its runner is
          // retiring the exact inode. Its matching intent makes absence idempotent.
          if (error.code !== "ENOENT") throw error;
        }
        await syncDirectory(held.request);
      }
    } else {
      try {
        await lstat(inputPath);
        return false;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    // Re-resolve the named request before retiring its membership, rather than
    // deleting from a substituted directory merely because an old FD stayed open.
    const current = await privateDirectory(directory);
    try {
      if (!sameDirectoryIdentity(held.value.directory, await directoryIdentity(current))) unsafe();
    } finally {
      await current.close();
    }
    await rm(descriptorPath(held.index, `${held.requestId}.json`)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(held.index);
    return true;
  } catch (error) {
    // Cleanup is optional after a proved terminal effect. Preserve membership and
    // original collection on storage failure instead of rewriting that outcome.
    if (["EIO", "ENOSPC", "EACCES", "EPERM", "EROFS"].includes(error.code)) return false;
    throw error;
  } finally {
    await input?.close();
    await held.request.close();
    await held.index.close();
  }
}
