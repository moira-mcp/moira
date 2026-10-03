import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const output = "packages/local/dist";
await mkdir(output, { recursive: true });
for (const entry of ["cli", "guard", "guest-worker", "guest-proxy"]) {
  await build({
    bundle: true,
    platform: "node",
    target: entry.startsWith("guest-") ? "node22" : "node24",
    format: "esm",
    sourcemap: false,
    legalComments: "none",
    entryPoints: [`packages/local/src/${entry}.ts`],
    outfile: `${output}/${entry}.js`,
    banner: entry === "cli" ? { js: "#!/usr/bin/env node" } : undefined,
  });
}
await chmod(`${output}/cli.js`, 0o755);
await execute(process.execPath, [`${output}/cli.js`, "--help"], { maxBuffer: 64 * 1024 });
console.log("Built Moira Local and its isolated guest assets.");
