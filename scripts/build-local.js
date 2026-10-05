import { build } from "esbuild";
import { mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const output = "packages/local/dist";
await mkdir(output, { recursive: true });
for (const entry of [
  "cli",
  "guard",
  "runtime-api",
  "guest-worker",
  "guest-proxy",
  "guest-bootstrap",
  "config",
]) {
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
if (process.platform === "darwin" || process.platform === "linux") {
  await execute(
    process.platform === "darwin" ? "/usr/bin/clang" : "cc",
    [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "packages/local/src/runtime-control-helper.c",
      ...(process.platform === "darwin" ? ["-lbsm"] : []),
      "-o",
      `${output}/runtime-control-helper`,
    ],
    { maxBuffer: 64 * 1024 },
  );
  await chmod(`${output}/runtime-control-helper`, 0o755);
}
if (process.platform === "darwin") {
  await execute(
    "/usr/bin/clang",
    [
      "-O2",
      "-Wno-deprecated-declarations",
      "-framework",
      "Security",
      "-framework",
      "CoreFoundation",
      "packages/local/src/keychain-helper.c",
      "-o",
      `${output}/keychain-helper`,
    ],
    { maxBuffer: 64 * 1024 },
  );
  await chmod(`${output}/keychain-helper`, 0o755);
}
await execute(process.execPath, [`${output}/cli.js`, "--help"], { maxBuffer: 64 * 1024 });
console.log("Built Moira Local and its isolated guest assets.");
