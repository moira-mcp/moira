import { mkdir, chmod, copyFile } from "node:fs/promises";
import { packageWorkspaceService } from "./package-workspace-service.js";
import { packageControllerDependencies } from "./package-controller-dependencies.js";
import { buildWorkspaceService } from "./build-workspace-service.js";
import { packageOwnerDependencies } from "./package-owner-dependencies.js";
import { buildLocalNativeHelpers } from "./build-local-native.js";
import { buildLocalPrograms } from "./build-local-programs.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

const output = "packages/local/dist";
await buildLocalPrograms(output);
for (const architecture of ["x64", "arm64"])
  await packageWorkspaceService({ architecture, output: `${output}/workspace-payload` });
await packageControllerDependencies(`${output}/github-toolchain`);
await buildWorkspaceService(`${output}/owner-runtime`);
await packageOwnerDependencies({
  directory: `${output}/owner-runtime`,
  platform: process.platform,
  architecture: process.arch,
});
await mkdir(`${output}/workspace-payload/service`, { recursive: true });
await copyFile(
  `${output}/workspace-payload/guest-proxy.mjs`,
  `${output}/workspace-payload/service/guest-proxy.mjs`,
);
if (process.platform === "darwin" || process.platform === "linux") {
  await buildLocalNativeHelpers(output);
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
