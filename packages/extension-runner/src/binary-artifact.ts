import { build } from "esbuild";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { canonicalJson } from "@mcp-moira/workflow-engine/extensions";
import type { LoadedBundle } from "./bundle-loader.js";

export interface BinaryExtensionArtifact {
  digest: string;
  bytes: Uint8Array;
  extensionName: string;
  version: string;
  channelIds: string[];
}

/** Compile only installed code. File bytes/settings from a delivery never enter this compiler. */
export async function compileBinaryExtensionArtifact(
  bundle: LoadedBundle,
): Promise<BinaryExtensionArtifact> {
  const root = await realpath(bundle.directory);
  const files: { path: string; data: string }[] = [];
  const readRegular = async (path: string) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error("Bundle input must be a regular file");
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Installed bundle changed during packaging");
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const result = await build({
    entryPoints: [bundle.entrypoint],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error" },
    plugins: [
      {
        name: "regular-installed-inputs",
        setup(builder) {
          builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async ({ path }) => ({
            contents: await readRegular(path),
            resolveDir: dirname(path),
            loader: extname(path) === ".json" ? "json" : /\.tsx?$/.test(path) ? "ts" : "js",
          }));
          builder.onLoad({ filter: /\.node$/ }, () => {
            throw new Error("Native extension dependencies need a portable owner bundle");
          });
        },
      },
    ],
  });
  if (result.warnings.length || result.outputFiles.length !== 1)
    throw new Error("Extension needs a self-contained Node24 owner bundle");
  files.push({
    path: "handler.mjs",
    data: Buffer.from(result.outputFiles[0].contents).toString("base64"),
  });
  const assets = new Set(
    bundle.manifest.communicationChannels?.flatMap(
      (channel) => channel.binaryTransport?.assets ?? [],
    ) ?? [],
  );
  for (const asset of [...assets].sort()) {
    const path = resolve(root, asset),
      canonical = await realpath(path),
      inside = relative(root, canonical);
    if (
      isAbsolute(asset) ||
      asset.split(/[\\/]/).includes("..") ||
      asset === "handler.mjs" ||
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      canonical !== path
    )
      throw new Error("Binary assets must stay inside the installed bundle without symlinks");
    files.push({ path: asset, data: (await readRegular(path)).toString("base64") });
  }
  const bytes = Buffer.from(canonicalJson({ version: 1, manifest: bundle.manifest, files }));
  return {
    digest: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    extensionName: bundle.manifest.name,
    version: bundle.manifest.version,
    channelIds: (bundle.manifest.communicationChannels ?? [])
      .filter((channel) => channel.binaryTransport)
      .map((channel) => channel.id),
  };
}
