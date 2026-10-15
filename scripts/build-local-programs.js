import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";
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
}
