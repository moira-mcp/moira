import { execFile } from "node:child_process";
import { mkdir, chmod, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = fileURLToPath(new URL("../packages/local/src/", import.meta.url));
const defaultOutput = fileURLToPath(new URL("../packages/local/dist/", import.meta.url));

/** Host-native custody primitives, without downloading or building guest payloads. */
export async function buildLocalNativeHelpers(directory = defaultOutput) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Local native ownership helpers require macOS or Linux");
  const output = resolve(directory);
  await mkdir(output, { recursive: true });
  for (const name of ["process-group-helper", "runtime-control-helper"]) {
    const target = join(output, name);
    const temporary = `${target}.next-${randomUUID()}`;
    try {
      await execute(
        process.platform === "darwin" ? "/usr/bin/clang" : "cc",
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          join(source, `${name}.c`),
          ...(name === "runtime-control-helper" && process.platform === "darwin" ? ["-lbsm"] : []),
          "-o",
          temporary,
        ],
        { maxBuffer: 64 * 1024 },
      );
      await chmod(temporary, 0o755);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
