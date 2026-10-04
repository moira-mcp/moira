import { chmod, lstat, mkdir, realpath, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { GiB, LocalRefusal, type LocalPolicy } from "./policy.js";
import { PrivateState } from "./private-state.js";
import { runProcess, type RunProcess } from "./process.js";

const ownerSchema = z.object({ deviceId: z.string().uuid(), capacityBytes: z.number().int().positive() }).strict();

/** A runtime filesystem must have its own finite capacity, not merely an application counter. */
export async function admitStorage(policy: LocalPolicy): Promise<void> {
  const root = policy.runtime.storageRoot;
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(root) !== root ||
    (metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) {
    throw new LocalRefusal("LOCAL_STORAGE_UNSAFE", "Use a private, canonical, owned storage mount.");
  }
  if (metadata.dev === (await stat(dirname(root))).dev) {
    throw new LocalRefusal("LOCAL_STORAGE_NOT_MOUNTED", "The bounded local storage volume is not mounted.");
  }
  const filesystem = await statfs(root, { bigint: true });
  const capacity = filesystem.blocks * filesystem.bsize;
  if (capacity <= 0n || capacity > BigInt(policy.runtime.maxStorageBytes)) {
    throw new LocalRefusal("LOCAL_STORAGE_UNBOUNDED", "The storage filesystem exceeds the locally approved capacity.");
  }
  const storage = await PrivateState.open(root);
  const owner = await storage.read("storage-owner.json", ownerSchema.parse);
  if (owner?.deviceId !== policy.deviceId || owner.capacityBytes !== policy.runtime.maxStorageBytes) {
    throw new LocalRefusal("LOCAL_STORAGE_OWNER", "This storage volume does not belong to this local device.");
  }
  if (filesystem.bavail * filesystem.bsize < BigInt(GiB)) {
    throw new LocalRefusal("LOCAL_STORAGE_FULL", "Local storage needs at least one GiB of free space before new work.");
  }
}

export async function initializeStorage(
  state: PrivateState,
  deviceId: string,
  capacityBytes: number,
  suppliedMount?: string,
  run: RunProcess = runProcess,
): Promise<string> {
  z.string().uuid().parse(deviceId);
  if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 8 * GiB || capacityBytes > 1024 * GiB || capacityBytes % GiB !== 0) {
    throw new LocalRefusal("LOCAL_STORAGE_SIZE", "Choose an integral storage size between 8 and 1024 GiB.");
  }
  const root = suppliedMount ?? join(state.root, "storage");
  if (!suppliedMount) {
    if (process.platform !== "darwin") {
      throw new LocalRefusal("LOCAL_STORAGE_REQUIRED", "On Linux, supply a newly mounted private bounded filesystem with --storage-root.");
    }
    const image = join(state.root, "storage.sparsebundle");
    const existing = await lstat(image).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing) throw new LocalRefusal("LOCAL_STORAGE_EXISTS", "An image already exists; remount it instead of overwriting it.");
    const filesystem = await statfs(state.root, { bigint: true });
    if (filesystem.bavail * filesystem.bsize < BigInt(capacityBytes + 4 * GiB)) {
      throw new LocalRefusal("LOCAL_HOST_STORAGE_LOW", "Choose a smaller volume and leave four GiB of host storage free.");
    }
    await mkdir(root, { mode: 0o700 });
    for (const argv of [
      ["create", "-size", `${capacityBytes / GiB}g`, "-type", "SPARSEBUNDLE", "-fs", "APFS", "-volname", `Moira-${deviceId.slice(0, 8)}`, image],
      ["attach", "-nobrowse", "-mountpoint", root, image],
    ]) {
      const result = await run({ binary: "/usr/bin/hdiutil", argv, cwd: state.root, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: 120_000, maxBytes: 64 * 1024 });
      if (result.exitCode !== 0) throw new LocalRefusal("LOCAL_STORAGE_SETUP_FAILED", "Could not create or attach the local storage image.");
    }
    await chmod(root, 0o700);
  }
  const storage = await PrivateState.open(root);
  const previous = await storage.read("storage-owner.json", ownerSchema.parse);
  if (previous) throw new LocalRefusal("LOCAL_STORAGE_EXISTS", "This volume already belongs to a local device.");
  await storage.write("storage-owner.json", { deviceId, capacityBytes });
  return root;
}
