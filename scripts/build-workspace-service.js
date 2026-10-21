import { build } from "esbuild";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** The image, provider installers and CLI consume these same complete programs. */
export async function buildWorkspaceService(output = "packages/workspace-service/dist") {
  await mkdir(output, { recursive: true });
  const entries = {
    daemon: "packages/workspace-service/src/daemon.mjs",
    cli: "packages/workspace-service/src/cli.mjs",
    "local-bootstrap": "packages/workspace-service/src/local-bootstrap.mjs",
    "guest-proxy": "packages/local/src/guest-proxy.ts",
    "owner-renderer": "packages/workspace-service/src/owner-renderer.mjs",
    "extension-handler-host": "packages/extension-runner/src/binary-handler-host.mjs",
    "request-retirement": "packages/workspace-service/src/request-retirement.mjs",
  };
  for (const [entry, entryPoint] of Object.entries(entries)) {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      write: false,
      sourcemap: false,
      legalComments: "none",
      external: ["sharp", "tar-stream"],
      outfile: `${output}/${entry}.mjs`,
    });
    const target = `${output}/${entry}.mjs`;
    const temporary = `${target}.next-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o644);
    try {
      try {
        await handle.writeFile(result.outputFiles[0].contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await buildWorkspaceService();
