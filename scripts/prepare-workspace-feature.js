import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { packageWorkspaceService } from "./package-workspace-service.js";

// Publication stages a complete Feature outside the tracked source directory.
const target = resolve("agent_temp_files_local/workspace-feature/workspace-service");
// Capture the clean release before staging untracked publication files.
for (const architecture of ["x64", "arm64"]) await packageWorkspaceService({ architecture });
await mkdir(target, { recursive: true });
for (const file of ["devcontainer-feature.json", "install.sh"])
  await copyFile(`.devcontainer/features/workspace-service/${file}`, `${target}/${file}`);
const version = process.env.WORKSPACE_FEATURE_VERSION;
if (version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error("Invalid Feature release version");
  const manifest = JSON.parse(await readFile(`${target}/devcontainer-feature.json`, "utf8"));
  await writeFile(
    `${target}/devcontainer-feature.json`,
    `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
  );
}
for (const architecture of ["x64", "arm64"]) {
  for (const file of [`header-${architecture}.txt`, `moira-workspace-linux-${architecture}.tar.gz`])
    await copyFile(`packages/workspace-service/dist/${file}`, `${target}/${file}`);
}
await copyFile("packages/workspace-service/dist/install.sh", `${target}/payload-install.sh`);
process.stdout.write(`${target}\n`);
