import { execFile } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
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
        join(output, name),
      ],
      { maxBuffer: 64 * 1024 },
    );
    await chmod(join(output, name), 0o755);
  }
}
