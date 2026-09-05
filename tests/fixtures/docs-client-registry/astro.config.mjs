import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const docsSource = fileURLToPath(new URL("../../../packages/docs/src", import.meta.url));

export default defineConfig({
  integrations: [starlight({ title: "Client registry fixture" })],
  cacheDir:
    process.env.MOIRA_ASTRO_TEST_CACHE_DIR ??
    fileURLToPath(new URL("./node_modules/.vite/", import.meta.url)),
  vite: {
    resolve: {
      alias: { "~": docsSource },
    },
  },
});
