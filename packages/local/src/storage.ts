import { chmod, lstat, mkdir, realpath, stat, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { GiB, LocalRefusal, type LocalPolicy } from "./policy.js";
import { PrivateState } from "./private-state.js";
import { runProcess, type RunProcess } from "./process.js";

const ownerSchema = z
  .object({ deviceId: z.string().uuid(), capacityBytes: z.number().int().positive() })
  .strict();

/** Native socket paths must stay short even when the private image is stored under a long path. */
export function defaultStorageMount(
  stateRoot: string,
  deviceId: string,
  platform: NodeJS.Platform,
): string {
  return platform === "darwin"
    ? join("/private/tmp", `ml-${deviceId.replaceAll("-", "").slice(0, 12)}`)
    : join(stateRoot, "storage");
}

/** A runtime filesystem must have its own finite capacity, not merely an application counter. */
export async function admitStorage(policy: LocalPolicy): Promise<void> {
  const root = policy.runtime.storageRoot;
  const metadata = await lstat(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_UNSAFE",
      "Use a private, canonical, owned storage mount.",
    );
  }
  if (metadata.dev === (await stat(dirname(root))).dev) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_NOT_MOUNTED",
      "The bounded local storage volume is not mounted.",
    );
  }
  const filesystem = await statfs(root, { bigint: true });
  const capacity = filesystem.blocks * filesystem.bsize;
  if (capacity <= 0n || capacity > BigInt(policy.runtime.maxStorageBytes)) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_UNBOUNDED",
      "The storage filesystem exceeds the locally approved capacity.",
    );
  }
  const storage = await PrivateState.open(root);
  const owner = await storage.read("storage-owner.json", ownerSchema.parse);
  if (
    owner?.deviceId !== policy.deviceId ||
    owner.capacityBytes !== policy.runtime.maxStorageBytes
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_OWNER",
      "This storage volume does not belong to this local device.",
    );
  }
  if (filesystem.bavail * filesystem.bsize < BigInt(GiB)) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_FULL",
      "Local storage needs at least one GiB of free space before new work.",
    );
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
  if (
    !Number.isSafeInteger(capacityBytes) ||
    capacityBytes < 8 * GiB ||
    capacityBytes > 1024 * GiB ||
    capacityBytes % GiB !== 0
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_SIZE",
      "Choose an integral storage size between 8 and 1024 GiB.",
    );
  }
  const root = suppliedMount ?? defaultStorageMount(state.root, deviceId, process.platform);
  if (!suppliedMount) {
    if (process.platform !== "darwin") {
      throw new LocalRefusal(
        "LOCAL_STORAGE_REQUIRED",
        "On Linux, supply a newly mounted private bounded filesystem with --storage-root.",
      );
    }
    const image = join(state.root, "storage.sparsebundle");
    const existing = await lstat(image).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing)
      throw new LocalRefusal(
        "LOCAL_STORAGE_EXISTS",
        "An image already exists; remount it instead of overwriting it.",
      );
    const filesystem = await statfs(state.root, { bigint: true });
    if (filesystem.bavail * filesystem.bsize < BigInt(capacityBytes + 4 * GiB)) {
      throw new LocalRefusal(
        "LOCAL_HOST_STORAGE_LOW",
        "Choose a smaller volume and leave four GiB of host storage free.",
      );
    }
    await mkdir(root, { mode: 0o700 });
    for (const argv of [
      [
        "create",
        "-size",
        `${capacityBytes / GiB}g`,
        "-type",
        "SPARSEBUNDLE",
        "-fs",
        "APFS",
        "-volname",
        `Moira-${deviceId.slice(0, 8)}`,
        image,
      ],
      ["attach", "-nobrowse", "-mountpoint", root, image],
    ]) {
      const result = await run({
        binary: "/usr/bin/hdiutil",
        argv,
        cwd: state.root,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        timeoutMs: 120_000,
        maxBytes: 64 * 1024,
      });
      if (result.exitCode !== 0)
        throw new LocalRefusal(
          "LOCAL_STORAGE_SETUP_FAILED",
          "Could not create or attach the local storage image.",
        );
    }
    await chmod(root, 0o700);
  }
  const mount = await lstat(root);
  if (
    !mount.isDirectory() ||
    mount.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    mount.dev === (await stat(dirname(root))).dev ||
    (mount.mode & 0o077) !== 0 ||
    (process.getuid && mount.uid !== process.getuid())
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_UNSAFE",
      "Initialization requires a private owned filesystem mount.",
    );
  }
  const filesystem = await statfs(root, { bigint: true });
  if (filesystem.blocks * filesystem.bsize > BigInt(capacityBytes)) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_UNBOUNDED",
      "The mounted filesystem exceeds the requested local capacity.",
    );
  }
  const storage = await PrivateState.open(root);
  const previous = await storage.read("storage-owner.json", ownerSchema.parse);
  if (previous)
    throw new LocalRefusal(
      "LOCAL_STORAGE_EXISTS",
      "This volume already belongs to a local device.",
    );
  await storage.write("storage-owner.json", { deviceId, capacityBytes });
  return root;
}

const resizeSchema = z
  .object({
    deviceId: z.string().uuid(),
    fromBytes: z.number().int().positive(),
    toBytes: z.number().int().positive(),
    volumeUUID: z.string().uuid(),
    overheadBytes: z.number().int().positive().max(GiB),
  })
  .strict();

/** Called only with the runner lock held and the runtime's kernel shutdown confirmed. */
export async function resizeStorage(
  state: PrivateState,
  policy: LocalPolicy,
  requestedBytes: number,
  run: RunProcess = runProcess,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new LocalRefusal(
      "LOCAL_STORAGE_REQUIRED",
      "Resize the locally owned bounded filesystem before changing its approved size.",
    );
  }
  if (
    !Number.isSafeInteger(requestedBytes) ||
    requestedBytes < 8 * GiB ||
    requestedBytes > 1024 * GiB ||
    requestedBytes % GiB !== 0 ||
    requestedBytes < policy.runtime.dockerBytes + GiB
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_SIZE",
      "Choose an integral size of 8–1024 GiB and leave one GiB beyond the Docker budget.",
    );
  }
  const image = join(state.root, "storage.sparsebundle");
  const root = policy.runtime.storageRoot;
  if (root !== defaultStorageMount(state.root, policy.deviceId, "darwin")) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_OWNER",
      "Only this device's owned disk image can be resized remotely.",
    );
  }
  const metadata = await lstat(image);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(image)) !== image ||
    (process.getuid && metadata.uid !== process.getuid())
  ) {
    throw new LocalRefusal("LOCAL_STORAGE_OWNER", "The private disk image identity is invalid.");
  }
  const command = async (binary: string, argv: string[], stdin?: Uint8Array) => {
    const result = await run({
      binary,
      argv,
      stdin,
      cwd: state.root,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      timeoutMs: 120_000,
      maxBytes: 1024 * 1024,
    });
    if (result.exitCode !== 0)
      throw new LocalRefusal(
        "LOCAL_STORAGE_RESIZE_FAILED",
        "The owned volume could not be resized; its pending request can be retried after resolving the native disk error.",
      );
    return result.stdout;
  };
  const plist = async (binary: string, argv: string[]) => {
    const bytes = await command(binary, argv);
    const json = await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], bytes);
    return JSON.parse(json.toString("utf8")) as Record<string, unknown>;
  };
  const binding = async (
    expectedUUID?: string,
  ): Promise<{
    volume: {
      MountPoint: string;
      VolumeUUID: string;
      FilesystemType: "apfs";
      BusProtocol: "Disk Image";
      APFSContainerReference: string;
      APFSContainerSize: number;
      DeviceNode: string;
      WritableVolume: true;
      Locked: false;
    };
    imageBytes: number;
  } | null> => {
    const data = await plist("/usr/bin/hdiutil", ["info", "-plist"]);
    const images = z
      .array(
        z
          .object({
            "image-path": z.string(),
            blockcount: z.number().int().positive(),
            blocksize: z.number().int().positive(),
            "system-entities": z.array(
              z
                .object({
                  "dev-entry": z.string(),
                  "mount-point": z.string().optional(),
                  "content-hint": z.string().optional(),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      )
      .parse(data.images);
    const owned = images.filter((entry) => entry["image-path"] === image);
    if (!owned.length) return null;
    if (owned.length !== 1)
      throw new LocalRefusal(
        "LOCAL_STORAGE_OWNER",
        "The disk image has ambiguous native bindings.",
      );
    const mount = owned[0]["system-entities"].filter((entry) => entry["mount-point"] === root);
    // APFS resize remounts at /Volumes. Only a journal-bound identity may be remounted.
    if (mount.length === 0 && expectedUUID) {
      const volumes = owned[0]["system-entities"].filter(
        (entry) => entry["content-hint"] === "41504653-0000-11AA-AA11-00306543ECAC",
      );
      const whole = owned[0]["system-entities"].filter(
        (entry) =>
          entry["content-hint"] === "GUID_partition_scheme" &&
          /^\/dev\/disk\d+$/.test(entry["dev-entry"]),
      );
      if (volumes.length !== 1 || whole.length !== 1)
        throw new LocalRefusal(
          "LOCAL_STORAGE_OWNER",
          "The pending image has ambiguous APFS identity.",
        );
      const info = await plist("/usr/sbin/diskutil", ["info", "-plist", volumes[0]["dev-entry"]]);
      z.object({
        VolumeUUID: z.literal(expectedUUID),
        DeviceNode: z.literal(volumes[0]["dev-entry"]),
        FilesystemType: z.literal("apfs"),
        BusProtocol: z.literal("Disk Image"),
      })
        .passthrough()
        .parse(info);
      await command("/usr/bin/hdiutil", ["detach", whole[0]["dev-entry"]]);
      await command("/usr/bin/hdiutil", ["attach", "-nobrowse", "-mountpoint", root, image]);
      await chmod(root, 0o700);
      return binding();
    }
    if (mount.length !== 1)
      throw new LocalRefusal(
        "LOCAL_STORAGE_OWNER",
        "The owned disk image is not mounted at its approved location.",
      );
    const info = await plist("/usr/sbin/diskutil", ["info", "-plist", root]);
    const volume = z
      .object({
        MountPoint: z.literal(root),
        VolumeUUID: z.string().uuid(),
        FilesystemType: z.literal("apfs"),
        BusProtocol: z.literal("Disk Image"),
        APFSContainerReference: z.string().regex(/^disk\d+$/),
        APFSContainerSize: z.number().int().positive(),
        DeviceNode: z.literal(mount[0]["dev-entry"]),
        WritableVolume: z.literal(true),
        Locked: z.literal(false),
      })
      .passthrough()
      .parse(info);
    return { volume, imageBytes: owned[0]["blockcount"] * owned[0]["blocksize"] };
  };
  let journal = await state.read("storage-resize.json", resizeSchema.parse);
  if (
    journal &&
    (journal.deviceId !== policy.deviceId ||
      (journal.fromBytes !== policy.runtime.maxStorageBytes &&
        journal.toBytes !== policy.runtime.maxStorageBytes))
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_OWNER",
      "The pending resize belongs to a different device or policy.",
    );
  }
  if (
    journal &&
    journal.toBytes !== requestedBytes &&
    journal.toBytes !== policy.runtime.maxStorageBytes
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_RESIZE_PENDING",
      "Finish the previous storage resize before choosing another size.",
    );
  }
  let current = await binding(journal?.volumeUUID);
  if (!current) {
    if (!journal)
      throw new LocalRefusal(
        "LOCAL_STORAGE_NOT_MOUNTED",
        "Mount the owned volume before requesting a resize.",
      );
    await command("/usr/bin/hdiutil", ["attach", "-nobrowse", "-mountpoint", root, image]);
    await chmod(root, 0o700);
    current = await binding();
  }
  if (!current)
    throw new LocalRefusal("LOCAL_STORAGE_NOT_MOUNTED", "The owned volume did not mount.");
  const storage = await PrivateState.open(root);
  const owner = await storage.read("storage-owner.json", ownerSchema.parse);
  if (
    owner?.deviceId !== policy.deviceId ||
    (owner.capacityBytes !== policy.runtime.maxStorageBytes &&
      owner.capacityBytes !== journal?.toBytes) ||
    (journal && current.volume.VolumeUUID !== journal.volumeUUID)
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_OWNER",
      "The volume ownership or persistent identity changed.",
    );
  }
  if (journal?.toBytes === policy.runtime.maxStorageBytes && journal.toBytes !== requestedBytes) {
    await state.remove("storage-resize.json");
    journal = null;
  }
  const freshResize = !journal;
  if (!journal) {
    const overheadBytes = current.imageBytes - current.volume.APFSContainerSize;
    journal = resizeSchema.parse({
      deviceId: policy.deviceId,
      fromBytes: policy.runtime.maxStorageBytes,
      toBytes: requestedBytes,
      volumeUUID: current.volume.VolumeUUID,
      overheadBytes,
    });
    if (current.imageBytes !== policy.runtime.maxStorageBytes) {
      throw new LocalRefusal(
        "LOCAL_STORAGE_OWNER",
        "The image capacity does not match its local approval.",
      );
    }
  }
  const targetContainer = requestedBytes - journal.overheadBytes;
  if (current.volume.APFSContainerSize > targetContainer) {
    const limits = await plist("/usr/sbin/diskutil", [
      "apfs",
      "resizeContainer",
      current.volume.APFSContainerReference,
      "limits",
      "-plist",
    ]);
    // Native data/snapshot/reserve minimum plus our explicit free-space requirement.
    // The preferred recommendation can equal the current container even when shrink is valid.
    const minimum = z.number().int().positive().parse(limits.MinimumSizeNoGuard);
    const filesystem = await statfs(root, { bigint: true });
    const used = (filesystem.blocks - filesystem.bfree) * filesystem.bsize;
    if (targetContainer < minimum || BigInt(targetContainer) < used + BigInt(GiB)) {
      throw new LocalRefusal(
        "LOCAL_STORAGE_FULL",
        "The smaller volume cannot preserve its data and required free space.",
      );
    }
  }
  if (requestedBytes > current.imageBytes) {
    const host = await statfs(state.root, { bigint: true });
    if (host.bavail * host.bsize < BigInt(requestedBytes - current.imageBytes + 4 * GiB)) {
      throw new LocalRefusal(
        "LOCAL_HOST_STORAGE_LOW",
        "Leave four GiB of host storage free after growing the image.",
      );
    }
  }
  // An infeasible request has not changed the filesystem and must remain correctable.
  if (freshResize) await state.write("storage-resize.json", journal);
  if (current.volume.APFSContainerSize > targetContainer) {
    await command("/usr/sbin/diskutil", [
      "apfs",
      "resizeContainer",
      current.volume.APFSContainerReference,
      `${targetContainer}b`,
    ]);
    current = await binding(journal.volumeUUID);
    if (!current)
      throw new LocalRefusal("LOCAL_STORAGE_NOT_MOUNTED", "The resized container did not remount.");
  }
  if (current.imageBytes !== requestedBytes) {
    await command("/usr/bin/hdiutil", ["detach", root]);
    await command("/usr/bin/hdiutil", [
      "resize",
      "-imageonly",
      "-size",
      `${requestedBytes / GiB}g`,
      image,
    ]);
    await command("/usr/bin/hdiutil", ["attach", "-nobrowse", "-mountpoint", root, image]);
    await chmod(root, 0o700);
    current = await binding(journal.volumeUUID);
  }
  if (!current || current.volume.VolumeUUID !== journal.volumeUUID) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_OWNER",
      "The resized image did not preserve its volume identity.",
    );
  }
  if (current.volume.APFSContainerSize < targetContainer - 4 * 1024 * 1024) {
    await command("/usr/sbin/diskutil", [
      "apfs",
      "resizeContainer",
      current.volume.APFSContainerReference,
      "0",
    ]);
    current = await binding(journal.volumeUUID);
  }
  const filesystem = await statfs(root, { bigint: true });
  const capacity = Number(filesystem.blocks * filesystem.bsize);
  if (
    !current ||
    current.volume.VolumeUUID !== journal.volumeUUID ||
    current.imageBytes !== requestedBytes ||
    Math.abs(current.volume.APFSContainerSize - targetContainer) > 4 * 1024 * 1024 ||
    capacity <= 0 ||
    capacity > requestedBytes ||
    Math.abs(capacity - targetContainer) > 4 * 1024 * 1024
  ) {
    throw new LocalRefusal(
      "LOCAL_STORAGE_RESIZE_FAILED",
      "The actual filesystem has not reached the requested bounded capacity.",
    );
  }
  await storage.write("storage-owner.json", {
    deviceId: policy.deviceId,
    capacityBytes: requestedBytes,
  });
  // Retained until policy commit: a crash between these writes must remain recoverable.
}
