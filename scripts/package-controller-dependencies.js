import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, chmod, open } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const CONTROLLER_GH_VERSION = "2.102.0";
// Official https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt
const archives = {
  "darwin-x64": [
    "macOS",
    "amd64",
    "zip",
    "b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3",
  ],
  "darwin-arm64": [
    "macOS",
    "arm64",
    "zip",
    "da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e",
  ],
  "linux-x64": [
    "linux",
    "amd64",
    "tar.gz",
    "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
  ],
  "linux-arm64": [
    "linux",
    "arm64",
    "tar.gz",
    "7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484",
  ],
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function packageControllerDependencies(output) {
  const choice = archives[`${process.platform}-${process.arch}`];
  if (!choice) throw new Error("Controller provisioning supports macOS/Linux x64/arm64");
  const [platform, architecture, extension, archiveSha256] = choice;
  const name = `gh_${CONTROLLER_GH_VERSION}_${platform}_${architecture}`;
  await mkdir(output, { recursive: true });
  const cache = "node_modules/.cache/moira-controller";
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `${name}.${extension}`);
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes || digest(bytes) !== archiveSha256) {
    const response = await fetch(
      `https://github.com/cli/cli/releases/download/v${CONTROLLER_GH_VERSION}/${name}.${extension}`,
    );
    if (!response.ok) throw new Error("Official gh archive unavailable");
    bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== archiveSha256) throw new Error("Official gh archive digest mismatch");
    // A concurrent build may have populated the cache after our read. Publish only
    // verified bytes atomically; an invalid previous archive survives download failure.
    const candidate = join(cache, `.gh-${randomUUID()}.${extension}`);
    const handle = await open(candidate, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(candidate, archive);
      const directory = await open(cache, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(candidate, { force: true });
    }
  }
  if (digest(bytes) !== archiveSha256) throw new Error("Cached gh archive digest mismatch");
  const temporary = join(output, `.gh-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    if (extension === "zip")
      await execute("/usr/bin/unzip", ["-q", archive, `${name}/bin/gh`, "-d", temporary]);
    else await execute("/usr/bin/tar", ["-xzf", archive, "-C", temporary, `${name}/bin/gh`]);
    const binary = join(temporary, name, "bin", "gh");
    await chmod(binary, 0o755);
    const measured = await execute(binary, ["--version"], {
      env: { PATH: "/usr/bin:/bin", HOME: temporary, GH_CONFIG_DIR: temporary },
      maxBuffer: 65536,
    });
    if (!measured.stdout.startsWith(`gh version ${CONTROLLER_GH_VERSION} `))
      throw new Error("Packaged gh version mismatch");
    const sha256 = digest(await readFile(binary));
    await rename(binary, join(output, "gh"));
    await writeFile(
      join(output, "gh.json"),
      JSON.stringify({
        version: 1,
        platform: process.platform,
        architecture: process.arch,
        ghVersion: CONTROLLER_GH_VERSION,
        archiveSha256,
        sha256,
      }),
      { mode: 0o644 },
    );
    await rm(join(output, `${name}.${extension}`), { force: true });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
