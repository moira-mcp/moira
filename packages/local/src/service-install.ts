import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { PrivateState } from "./private-state.js";
import { LocalRefusal } from "./policy.js";

export const LOCAL_SERVICE_PROTOCOL = 1;
const execute = promisify(execFile);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const releasePattern = /^[a-f0-9]{64}$/;
const manifestSchema = z
  .object({
    version: z.literal(1),
    platform: z.enum(["darwin", "linux"]),
    architecture: z.enum(["arm64", "x64"]),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(releasePattern),
          executable: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
const requiredFiles = [
  "node",
  "cli.js",
  "guard.js",
  "runtime-api.js",
  "config.js",
  "github-provisioner.js",
  "process-group-helper",
  "runtime-control-helper",
];
const requiredDirectories = ["workspace-payload", "github-toolchain", "owner-runtime"];
const unsafe = () =>
  new LocalRefusal(
    "LOCAL_SERVICE_INSTALL_UNSAFE",
    "The owner executable installation is incomplete or unsafe; preserve its existing selection.",
  );
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function directory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { mode: 0o700 });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.mode & 0o022 ||
    metadata.uid !== process.getuid?.() ||
    (await realpath(path)) !== path
  )
    throw unsafe();
}
async function bytes(path: string, privateFile = false): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & (privateFile ? 0o077 : 0o022) ||
      (before.uid !== process.getuid?.() && (privateFile || before.uid !== 0))
    )
      throw unsafe();
    const value = await handle.readFile();
    const after = await handle.stat();
    if (
      value.length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw unsafe();
    return value;
  } finally {
    await handle.close();
  }
}
async function publish(path: string, value: Uint8Array | string, mode: number): Promise<void> {
  const temporary = join(dirname(path), `.install-${randomUUID()}`);
  const handle = await open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}
async function layout(state: PrivateState) {
  await directory(state.root);
  const install = join(state.root, "service-install"),
    releases = join(state.root, "service-releases");
  for (const path of [install, releases]) {
    if (!(await exists(path)))
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    await directory(path);
    if ((await lstat(path)).mode & 0o077) throw unsafe();
  }
  await syncDirectory(state.root);
  return { install, releases, launcher: join(install, "launch") };
}
async function selection(
  install: string,
  releases: string,
  name: "active" | "staged",
): Promise<string | null> {
  const path = join(install, name);
  if (!(await exists(path))) return null;
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw unsafe();
  const target = await readlink(path),
    release = target.split("/").at(-1)!;
  if (!releasePattern.test(release) || target !== join(releases, release)) throw unsafe();
  await directory(target);
  return release;
}
async function select(
  install: string,
  releases: string,
  name: "active" | "staged",
  release: string,
) {
  await selection(install, releases, name);
  const temporary = join(install, `.select-${randomUUID()}`);
  try {
    await symlink(join(releases, release), temporary);
    await rename(temporary, join(install, name));
    await syncDirectory(install);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
async function inventory(
  root: string,
  prefix = "",
  sealed = false,
): Promise<z.infer<typeof manifestSchema>["files"]> {
  const files: z.infer<typeof manifestSchema>["files"] = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!prefix && name === "service-release.json") continue;
    const path = join(root, relative),
      metadata = await lstat(path);
    if (sealed && (metadata.mode & 0o222 || metadata.uid !== process.getuid?.())) throw unsafe();
    if (metadata.isDirectory()) {
      await directory(path);
      files.push(...(await inventory(root, relative, sealed)));
    } else
      files.push({
        path: relative,
        sha256: digest(await bytes(path)),
        executable: Boolean(metadata.mode & 0o111),
      });
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}
async function directoryModes(path: string, mode: number) {
  if (mode === 0o700) await chmod(path, mode);
  for (const name of await readdir(path)) {
    const child = join(path, name);
    if ((await lstat(child)).isDirectory()) await directoryModes(child, mode);
  }
  if (mode === 0o500) {
    await chmod(path, mode);
    // Persist every intermediate directory after its children, not only file parents.
    await syncDirectory(path);
  }
}
function assertClosure(files: z.infer<typeof manifestSchema>["files"], platform: string) {
  for (const name of [...requiredFiles, ...(platform === "darwin" ? ["keychain-helper"] : [])])
    if (!files.some((file) => file.path === name)) throw unsafe();
  for (const name of requiredDirectories)
    if (!files.some((file) => file.path.startsWith(`${name}/`))) throw unsafe();
  if (!files.find((file) => file.path === "node")?.executable) throw unsafe();
}
export async function serviceBundleIdentity(releaseDirectory: string) {
  await directory(releaseDirectory);
  if ((await lstat(releaseDirectory)).mode & 0o222) throw unsafe();
  if ((await lstat(join(releaseDirectory, "service-release.json"))).mode & 0o222) throw unsafe();
  const manifest = manifestSchema.parse(
    JSON.parse(
      (await bytes(join(releaseDirectory, "service-release.json"), true)).toString("utf8"),
    ),
  );
  const actual = await inventory(releaseDirectory, "", true);
  assertClosure(actual, manifest.platform);
  if (
    JSON.stringify(actual) !== JSON.stringify(manifest.files) ||
    manifest.platform !== process.platform ||
    manifest.architecture !== process.arch
  )
    throw unsafe();
  const release = digest(JSON.stringify(manifest));
  if (
    releaseDirectory !== resolve(releaseDirectory) ||
    releaseDirectory.split("/").at(-1) !== release
  )
    throw unsafe();
  return {
    release,
    releaseDirectory,
    platform: manifest.platform,
    architecture: manifest.architecture,
  };
}
export async function serviceSocketPath(state: PrivateState) {
  return join((await state.ipcDirectory()).root, "service.sock");
}
export async function serviceInstallation(state: PrivateState) {
  const paths = await layout(state);
  return {
    active: await selection(paths.install, paths.releases, "active"),
    staged: await selection(paths.install, paths.releases, "staged"),
    launcher: paths.launcher,
  };
}
/** Stage a complete executable closure; never replace the active owner or reload launchd. */
export async function stageLocalService(state: PrivateState, sourceDirectory: string) {
  const paths = await layout(state),
    gate = await PrivateState.open(paths.install),
    unlock = await gate.lock({ recoverStale: true });
  let temporary: string | undefined;
  try {
    await directory(sourceDirectory);
    const roots = [
      ...requiredFiles,
      ...(process.platform === "darwin" ? ["keychain-helper"] : []),
      ...requiredDirectories,
    ];
    const sourceFiles: z.infer<typeof manifestSchema>["files"] = [];
    for (const name of roots) {
      const path = join(sourceDirectory, name),
        metadata = await lstat(path);
      if (requiredDirectories.includes(name)) {
        await directory(path);
        sourceFiles.push(...(await inventory(sourceDirectory, name)));
      } else
        sourceFiles.push({
          path: name,
          sha256: digest(await bytes(path)),
          executable: name === "node" || !name.endsWith(".js") || Boolean(metadata.mode & 0o111),
        });
    }
    sourceFiles.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    assertClosure(sourceFiles, process.platform);
    const manifest = manifestSchema.parse({
      version: 1,
      platform: process.platform,
      architecture: process.arch,
      files: sourceFiles,
    });
    const release = digest(JSON.stringify(manifest)),
      releaseDirectory = join(paths.releases, release);
    if (!(await exists(releaseDirectory))) {
      temporary = join(paths.releases, `.stage-${randomUUID()}`);
      await mkdir(temporary, { mode: 0o700 });
      for (const file of sourceFiles) {
        const value = await bytes(join(sourceDirectory, file.path));
        if (digest(value) !== file.sha256) throw unsafe();
        await mkdir(dirname(join(temporary, file.path)), { recursive: true, mode: 0o700 });
        await publish(join(temporary, file.path), value, file.executable ? 0o500 : 0o400);
      }
      await publish(join(temporary, "service-release.json"), JSON.stringify(manifest), 0o400);
      await directoryModes(temporary, 0o500);
      await rename(temporary, releaseDirectory);
      temporary = undefined;
    }
    // A selection must never become durable ahead of its release's directory entry.
    await syncDirectory(paths.releases);
    await serviceBundleIdentity(releaseDirectory);
    const launch = `#!/bin/sh\nset -eu\nrelease=$(CDPATH= cd -- ${quote(join(paths.install, "active"))} && pwd -P)\nexec "$release/node" "$release/cli.js" service --state ${quote(state.root)}\n`;
    if (await exists(paths.launcher)) {
      if (!(await bytes(paths.launcher, true)).equals(Buffer.from(launch))) throw unsafe();
    } else await publish(paths.launcher, launch, 0o700);
    await select(paths.install, paths.releases, "staged", release);
    return { release, releaseDirectory };
  } finally {
    try {
      if (temporary) {
        await directoryModes(temporary, 0o700);
        await rm(temporary, { recursive: true, force: true });
      }
    } finally {
      await unlock();
    }
  }
}
/** The physical service caller must establish settlement before promoting an existing active release. */
export async function promoteLocalService(state: PrivateState, release: string): Promise<void> {
  if (!releasePattern.test(release)) throw unsafe();
  const paths = await layout(state),
    gate = await PrivateState.open(paths.install),
    unlock = await gate.lock({ recoverStale: true });
  try {
    await serviceBundleIdentity(join(paths.releases, release));
    await select(paths.install, paths.releases, "active", release);
    if ((await selection(paths.install, paths.releases, "staged")) === release) {
      await unlink(join(paths.install, "staged"));
      await syncDirectory(paths.install);
    }
  } finally {
    await unlock();
  }
}

export interface ServiceLaunchDependencies {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  launchctl?: (arguments_: string[]) => Promise<{ stdout: string }>;
}
/** First registration only. Routine client installation never bootouts or kickstarts an owner. */
export async function ensureLocalServiceStarted(
  state: PrivateState,
  dependencies: ServiceLaunchDependencies = {},
) {
  if ((dependencies.platform ?? process.platform) !== "darwin")
    throw new LocalRefusal(
      "LOCAL_SERVICE_PLATFORM",
      "The persistent physical owner requires macOS launchd.",
    );
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined) throw unsafe();
  const label = `com.moira.local.owner.${digest(state.root).slice(0, 24)}`;
  const launchctl =
    dependencies.launchctl ??
    (async (arguments_) =>
      execute("/bin/launchctl", arguments_, {
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        maxBuffer: 64 * 1024,
      }));
  const target = `gui/${uid}/${label}`;
  const registered = async () => {
    try {
      const result = await launchctl(["print", target]);
      const installation = await serviceInstallation(state);
      if (!result.stdout.includes(installation.launcher)) throw unsafe();
      return true;
    } catch (error) {
      if (error instanceof LocalRefusal) throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === 113))
        throw error;
      return false;
    }
  };
  if (await registered()) return;
  const recovery = () =>
    new LocalRefusal(
      "LOCAL_SERVICE_RECOVERY_REQUIRED",
      "An unregistered or legacy owner marker remains; complete explicit owner settlement and cutover before registering another owner. Preserve its lock, endpoints and unresolved receipts.",
    );
  // Share the physical runner gate, with no stale-marker recovery or owner adoption.
  const unlock = await state.lock().catch((error: unknown) => {
    if (error instanceof LocalRefusal && error.code === "LOCAL_ALREADY_RUNNING") throw recovery();
    throw error;
  });
  let path: string;
  try {
    if (await registered()) return;
    let installation = await serviceInstallation(state);
    const endpoint = await serviceSocketPath(state);
    const retainedOwner = [
      join(state.root, "controller.sock"),
      join(dirname(endpoint), "controller.sock"),
      endpoint,
    ];
    if ((await Promise.all(retainedOwner.map(exists))).some(Boolean)) throw recovery();
    if (!installation.active) {
      if (!installation.staged)
        throw new LocalRefusal(
          "LOCAL_SERVICE_NOT_INSTALLED",
          "Stage the complete Local service before starting it.",
        );
      await promoteLocalService(state, installation.staged);
      installation = await serviceInstallation(state);
    }
    const home = dependencies.home ?? userInfo().homedir;
    if (!home || home !== resolve(home)) throw unsafe();
    await mkdir(home, { recursive: true, mode: 0o700 });
    await directory(home);
    const launchAgents = join(home, "Library", "LaunchAgents");
    await mkdir(launchAgents, { recursive: true, mode: 0o700 });
    await directory(launchAgents);
    const xml = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    // launchd creates a dedicated security session before any owner/SDK child
    // starts. ProcessType alone only changes scheduling and still inherits Aqua.
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(installation.launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>SessionCreate</key><true/><key>ProcessType</key><string>Background</string></dict></plist>\n`;
    path = join(launchAgents, `${label}.plist`);
    if (await exists(path)) {
      if (!(await bytes(path, true)).equals(Buffer.from(plist))) throw unsafe();
    } else await publish(path, plist, 0o600);
  } finally {
    // The launchd child acquires this same gate during owner startup.
    await unlock();
  }
  await launchctl(["bootstrap", `gui/${uid}`, path]);
}
