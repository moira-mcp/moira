import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import { astroExpressiveCode } from "@astrojs/starlight/expressive-code";
import { defineConfig } from "astro/config";

const docsSource = fileURLToPath(new URL("../../../packages/docs/src", import.meta.url));

export default defineConfig({
  integrations: [astroExpressiveCode()],
  markdown: { processor: unified({}) },
  cacheDir:
    process.env.MOIRA_ASTRO_TEST_CACHE_DIR ??
    fileURLToPath(new URL("./node_modules/.vite/", import.meta.url)),
  vite: {
    resolve: {
      alias: { "~": docsSource },
    },
  },
});
