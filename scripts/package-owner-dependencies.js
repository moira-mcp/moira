import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, readdir, lstat, writeFile, copyFile, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, posix, resolve } from "node:path";
import { acquirePinnedArchive } from "./acquire-pinned-archive.js";

const execute = promisify(execFile);
const FONT_ARCHIVE_SHA256 = "fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7";
const FONT_ARCHIVE_URL =
  "https://downloads.sourceforge.net/project/dejavu/dejavu/2.37/dejavu-fonts-ttf-2.37.tar.bz2";

/** Use the same native process custody primitive for provisioning and binary extensions. */
export async function packageOwnerSupervisor(directory, architecture) {
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Unsupported owner architecture");
  const source = resolve("packages/local/src/process-group-helper.c");
  const output = resolve(directory, "process-group-helper");
  await mkdir(directory, { recursive: true });
  const arguments_ = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static"];
  if (process.platform === "linux" && process.arch === architecture) {
    await execute("cc", [...arguments_, source, "-o", output]);
  } else {
    // The existing native dependency-build stage supplies a static Linux compiler.
    // It is a build input only; no compiler or application image enters the payload.
    const image = `moira-owner-toolchain:${architecture}`;
    const platform = `linux/${architecture === "x64" ? "amd64" : "arm64"}`;
    let installed;
    try {
      installed = await execute("docker", [
        "image",
        "inspect",
        image,
        "--format",
        "{{.Os}}/{{.Architecture}}",
      ]);
    } catch (error) {
      if (error.code !== 1 || !/No such image|No such object/.test(error.stderr ?? "")) throw error;
    }
    if (installed && installed.stdout.trim() !== platform)
      throw new Error("Owner compiler image has the wrong platform");
    if (!installed)
      await execute(
        "docker",
        [
          "build",
          "--platform",
          platform,
          "--target",
          "dependency-build",
          "--tag",
          image,
          "--file",
          "config/Dockerfile",
          ".",
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      );
    const temporary = resolve(
      "node_modules/.cache/moira-owner-runtime",
      `compiler-${randomUUID()}`,
    );
    await mkdir(temporary, { recursive: true });
    try {
      await execute("docker", [
        "run",
        "--rm",
        "--network",
        "none",
        "--platform",
        platform,
        "--mount",
        `type=bind,source=${source},target=/input.c,readonly`,
        "--mount",
        `type=bind,source=${temporary},target=/output`,
        "--entrypoint",
        "cc",
        image,
        ...arguments_,
        "/input.c",
        "-o",
        "/output/process-group-helper",
      ]);
      await copyFile(join(temporary, "process-group-helper"), output);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await chmod(output, 0o755);
}

async function digest(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest(encoding);
}

async function acquire(cache, url, integrity) {
  const match = /^(sha256|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
  if (!match || new URL(url).protocol !== "https:")
    throw new Error("Owner dependency requires a pinned HTTPS archive");
  const [, algorithm, expected] = match;
  return acquirePinnedArchive({
    url,
    target: join(cache, createHash("sha256").update(integrity).digest("hex")),
    algorithm,
    expected,
    encoding: "base64",
  });
}

async function extract(archive, destination, prefix, selected) {
  const { stdout: names } = await execute("tar", ["-tf", archive], { maxBuffer: 4 * 1024 * 1024 });
  for (const name of names.trimEnd().split("\n")) {
    const clean = name.replace(/\/$/, "");
    if (
      (!clean.startsWith(`${prefix}/`) && clean !== prefix) ||
      clean.split("/").some((part) => part === "." || part === ".." || part === "") ||
      /[\0\r\\]/.test(clean)
    )
      throw new Error("Unsafe owner dependency archive member");
  }
  const { stdout: listing } = await execute("tar", ["-tvf", archive], {
    maxBuffer: 4 * 1024 * 1024,
  });
  if (
    listing
      .trimEnd()
      .split("\n")
      .some((line) => !["-", "d"].includes(line[0]))
  )
    throw new Error("Owner dependencies cannot contain links or special files");
  await mkdir(destination, { recursive: true });
  await execute("tar", [
    "-xf",
    archive,
    "--strip-components=1",
    "-C",
    destination,
    ...(selected ? selected.map((name) => `${prefix}/${name}`) : []),
  ]);
}

/** Ship the locked owner dependencies, independent of the repository's runtime modules. */
export async function packageOwnerDependencies({ directory, platform, architecture }) {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(architecture))
    throw new Error("Unsupported owner rendering platform");
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const cache = resolve("node_modules/.cache/moira-owner-runtime");
  await mkdir(cache, { recursive: true });
  const installed = new Set();
  const install = async (key) => {
    if (installed.has(key)) return;
    const entry = lock.packages[key];
    if (!entry?.resolved || !entry.integrity || entry.link)
      throw new Error(`Missing locked owner dependency: ${key}`);
    installed.add(key);
    const archive = await acquire(cache, entry.resolved, entry.integrity);
    await extract(archive, join(directory, key), "package");
    for (const name of Object.keys(entry.dependencies ?? {})) {
      let parent = key;
      let dependency;
      while (parent) {
        const candidate = `${parent}/node_modules/${name}`;
        if (lock.packages[candidate]) {
          dependency = candidate;
          break;
        }
        const separator = parent.lastIndexOf("/node_modules/");
        parent = separator < 0 ? "" : parent.slice(0, separator);
      }
      dependency ??= `node_modules/${name}`;
      await install(dependency);
    }
  };
  await install("node_modules/sharp");
  await install("node_modules/tar-stream");
  await install(`node_modules/@img/sharp-${platform}-${architecture}`);
  await install(`node_modules/@img/sharp-libvips-${platform}-${architecture}`);
  const fonts = join(directory, "fonts");
  const fontArchive = await acquire(
    cache,
    FONT_ARCHIVE_URL,
    `sha256-${Buffer.from(FONT_ARCHIVE_SHA256, "hex").toString("base64")}`,
  );
  await extract(fontArchive, fonts, "dejavu-fonts-ttf-2.37", [
    "ttf/DejaVuSans.ttf",
    "ttf/DejaVuSans-Bold.ttf",
    "LICENSE",
  ]);
  // Fontconfig resolves this directory relative to this configuration, never the project cwd.
  await writeFile(
    join(fonts, "fonts.conf"),
    '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir prefix="relative">ttf</dir><cachedir prefix="xdg">moira-fontconfig</cachedir></fontconfig>\n',
    { mode: 0o644 },
  );
}

/** Every shipped regular asset participates in the existing release manifest. */
export async function ownerAssetDigests(directory, prefix = "") {
  const assets = {};
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const metadata = await lstat(path);
    const relative = posix.join(prefix, name);
    if (metadata.isDirectory()) Object.assign(assets, await ownerAssetDigests(path, relative));
    else if (metadata.isFile() && metadata.nlink === 1)
      assets[relative] = await digest(path, "sha256", "hex");
    else throw new Error("Owner release assets must be regular files without links");
  }
  return assets;
}
