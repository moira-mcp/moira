import { build } from "esbuild";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** The image, provider installers and CLI consume these same complete programs. */
export async function buildWorkspaceService(output = "packages/workspace-service/dist") {
  await mkdir(output, { recursive: true });
  for (const entry of ["daemon", "cli", "local-bootstrap", "guest-proxy"]) {
    const result = await build({
      entryPoints: [
        entry === "guest-proxy"
          ? "packages/local/src/guest-proxy.ts"
          : `packages/workspace-service/src/${entry}.mjs`,
      ],
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      write: false,
      sourcemap: false,
      legalComments: "none",
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
