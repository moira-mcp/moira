import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The server and companion ship the same fixed Node 22 guest programs. */
export async function buildGuestAssets(output = "packages/web-backend/dist/guest-assets") {
  await mkdir(output, { recursive: true });
  for (const entry of ["guest-worker", "guest-files-cli"]) {
    const result = await build({
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: false,
      legalComments: "none",
      entryPoints: [`packages/local/src/${entry}.ts`],
      outfile: `${output}/${entry}.js`,
      write: false,
      ...(entry === "guest-files-cli" ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    });
    const target = `${output}/${entry}.js`;
    const temporary = `${target}.next-${randomUUID()}`;
    const handle = await open(temporary, "wx", 0o644);
    try {
      try {
        await handle.writeFile(result.outputFiles[0].contents);
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildGuestAssets();
