import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { buildWorkspaceService } from "./build-workspace-service.js";
import { WORKSPACE_INSTALL_SCRIPT } from "../packages/workspace-service/src/bootstrap.mjs";

const execute = promisify(execFile);
export const WORKSPACE_NODE_VERSION = "24.21.0";
// Verified against nodejs.org/dist/v24.21.0/SHASUMS256.txt. Runtime never uses project PATH.
export const WORKSPACE_NODE_ARCHIVES = Object.freeze({
  x64: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
  arm64: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
});
export const WORKSPACE_RG_VERSION = "15.2.0";
export const WORKSPACE_RG_ARCHIVES = Object.freeze({
  x64: {
    target: "x86_64-unknown-linux-musl",
    sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  },
  arm64: {
    target: "aarch64-unknown-linux-musl",
    sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
  },
});

/** The canonical git-tree-identity CLI emits this exact clean/dirty grammar. */
export function parseWorkspaceSourceIdentity(identity) {
  if (identity === "unknown") return { source: "unknown", sourceDirty: true };
  const parsed =
    typeof identity === "string" && /^([a-f0-9]{40})(-dirty-[a-f0-9]{16})?$/.exec(identity);
  if (!parsed) throw new Error("Invalid workspace source identity");
  return { source: parsed[1], sourceDirty: Boolean(parsed[2]) };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function acquireNode(directory, architecture) {
  const fileName = `node-v${WORKSPACE_NODE_VERSION}-linux-${architecture}.tar.gz`;
  return acquireArchive(
    directory,
    fileName,
    WORKSPACE_NODE_ARCHIVES[architecture],
    `https://nodejs.org/dist/v${WORKSPACE_NODE_VERSION}/${fileName}`,
  );
}

async function acquireArchive(directory, fileName, expected, url) {
  const target = join(directory, fileName);
  try {
    if ((await sha256(target)) === expected) return target;
    throw new Error("Cached official Node archive failed its pinned digest");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.next-${randomUUID()}`;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error("Official Node download failed");
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if ((await sha256(temporary)) !== expected)
      throw new Error("Official Node archive digest mismatch");
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function packageWorkspaceService({
  architecture = process.arch,
  output = "packages/workspace-service/dist",
} = {}) {
  if (!Object.hasOwn(WORKSPACE_NODE_ARCHIVES, architecture))
    throw new Error("Workspace payload supports Linux glibc x64 and arm64");
  output = resolve(output);
  await buildWorkspaceService(output);
  const cache = join(output, "node-archives");
  await mkdir(cache, { recursive: true });
  const nodeArchive = await acquireNode(cache, architecture);
  const rgTarget = WORKSPACE_RG_ARCHIVES[architecture];
  const rgName = `ripgrep-${WORKSPACE_RG_VERSION}-${rgTarget.target}`;
  const rgArchive = await acquireArchive(
    cache,
    `${rgName}.tar.gz`,
    rgTarget.sha256,
    `https://github.com/BurntSushi/ripgrep/releases/download/${WORKSPACE_RG_VERSION}/${rgName}.tar.gz`,
  );
  const staging = join(output, `.payload-${randomUUID()}`);
  await mkdir(join(staging, "runtime"), { recursive: true });
  await mkdir(join(staging, "service"));
  try {
    await execute("tar", [
      "-xzf",
      nodeArchive,
      "--strip-components=1",
      "-C",
      join(staging, "runtime"),
      `node-v${WORKSPACE_NODE_VERSION}-linux-${architecture}/bin/node`,
      `node-v${WORKSPACE_NODE_VERSION}-linux-${architecture}/LICENSE`,
    ]);
    await execute("tar", [
      "-xzf",
      rgArchive,
      "--strip-components=1",
      "-C",
      join(staging, "runtime/bin"),
      `${rgName}/rg`,
    ]);
    await mkdir(join(staging, "runtime/ripgrep"));
    await execute("tar", [
      "-xzf",
      rgArchive,
      "--strip-components=1",
      "-C",
      join(staging, "runtime/ripgrep"),
      `${rgName}/LICENSE-MIT`,
      `${rgName}/UNLICENSE`,
      `${rgName}/COPYING`,
    ]);
    const assets = {};
    for (const name of ["daemon.mjs", "cli.mjs", "local-bootstrap.mjs", "guest-proxy.mjs"]) {
      await copyFile(join(output, name), join(staging, "service", name));
      assets[`service/${name}`] = await sha256(join(staging, "service", name));
    }
    await chmod(join(staging, "runtime/bin/node"), 0o755);
    assets["runtime/bin/node"] = await sha256(join(staging, "runtime/bin/node"));
    assets["runtime/LICENSE"] = await sha256(join(staging, "runtime/LICENSE"));
    await chmod(join(staging, "runtime/bin/rg"), 0o755);
    assets["runtime/bin/rg"] = await sha256(join(staging, "runtime/bin/rg"));
    for (const name of ["LICENSE-MIT", "UNLICENSE", "COPYING"])
      assets[`runtime/ripgrep/${name}`] = await sha256(join(staging, `runtime/ripgrep/${name}`));
    const suppliedIdentity = process.env.WORKSPACE_SOURCE_COMMIT;
    const identity = parseWorkspaceSourceIdentity(
      suppliedIdentity ?? (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
    );
    const source = identity.source;
    const sourceDirty =
      suppliedIdentity !== undefined
        ? identity.sourceDirty
        : (await execute("git", ["status", "--porcelain"])).stdout.length !== 0;
    const manifest = {
      version: 1,
      architecture,
      libc: "glibc",
      nodeVersion: WORKSPACE_NODE_VERSION,
      nodeArchiveSha256: WORKSPACE_NODE_ARCHIVES[architecture],
      ripgrepVersion: WORKSPACE_RG_VERSION,
      ripgrepArchiveSha256: rgTarget.sha256,
      source,
      sourceDirty,
      assets,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const release = createHash("sha256").update(manifestBytes).digest("hex");
    await writeFile(join(staging, "release.json"), manifestBytes, { mode: 0o644, flag: "wx" });
    const fileName = `moira-workspace-linux-${architecture}.tar.gz`;
    const temporary = join(output, `.${fileName}.next-${randomUUID()}`);
    try {
      await execute(
        "tar",
        [
          // BSD tar otherwise writes extended metadata; Linux GNU/BusyBox tar
          // uses ordinary headers for these fixed, short release asset paths.
          ...(process.platform === "darwin" ? ["--format=ustar"] : []),
          "-czf",
          temporary,
          "-C",
          staging,
          "runtime",
          "service",
          "release.json",
        ],
        {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
      );
      const archiveSha256 = await sha256(temporary);
      await rename(temporary, join(output, fileName));
      const receipt = {
        ...manifest,
        release,
        fileName,
        archiveSha256,
        size: (await stat(join(output, fileName))).size,
      };
      await writeFile(
        join(output, `payload-${architecture}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await writeFile(join(output, "install.sh"), WORKSPACE_INSTALL_SCRIPT, { mode: 0o755 });
      await writeFile(
        join(output, `header-${architecture}.txt`),
        `${release} ${archiveSha256} ${architecture} ${receipt.size}\n`,
      );
      return receipt;
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const { values } = parseArgs({
    options: { arch: { type: "string" }, output: { type: "string" } },
  });
  const receipt = await packageWorkspaceService({
    architecture: values.arch,
    output: values.output,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
