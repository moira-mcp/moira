import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The server and companion ship the same fixed Node 22 guest programs. */
export async function buildGuestAssets(output = "packages/web-backend/dist/guest-assets") {
  await mkdir(output, { recursive: true });
  for (const entry of ["guest-worker", "guest-files-cli"]) {
    await build({
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: false,
      legalComments: "none",
      entryPoints: [`packages/local/src/${entry}.ts`],
      outfile: `${output}/${entry}.js`,
      ...(entry === "guest-files-cli" ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await buildGuestAssets();
