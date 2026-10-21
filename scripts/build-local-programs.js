import { build } from "esbuild";
import { mkdir, chmod, copyFile, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../packages/local/src/", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../packages/local/dist/", import.meta.url));

/** Host JavaScript programs only; packaged dependencies and guest payloads are separate. */
export async function buildLocalPrograms(directory = defaultOutput) {
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  for (const entry of ["cli", "guard", "runtime-api", "config", "github-provisioner"]) {
    await build({
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      sourcemap: false,
      legalComments: "none",
      entryPoints: [join(source, `${entry}.ts`)],
      outfile: join(output, `${entry}.js`),
      banner: {
        js: [
          ...(entry === "cli" ? ["#!/usr/bin/env node"] : []),
          'import { createRequire as moiraCreateRequire } from "node:module";',
          "const require = moiraCreateRequire(import.meta.url);",
        ].join("\n"),
      },
    });
  }
  await chmod(join(output, "cli.js"), 0o755);
  // A staged physical owner must not depend on the agent's mutable nvm installation.
  // Publish a complete private copy; a held reader never observes a truncated runtime.
  const temporary = join(output, `.node-${randomUUID()}`);
  let copied = false;
  try {
    await copyFile(process.execPath, temporary, constants.COPYFILE_EXCL);
    copied = true;
    await chmod(temporary, 0o755);
    const binary = await open(temporary, "r");
    try {
      await binary.sync();
    } finally {
      await binary.close();
    }
    await rename(temporary, join(output, "node"));
    const parent = await open(output, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    if (copied)
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}
