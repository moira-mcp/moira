import process from "node:process";
import { defineConfig } from "astro/config";
import docsConfig from "../../../packages/docs/astro.config.ts";

if (!docsConfig.markdown?.processor) {
  throw new Error("Production docs config must define a Markdown processor");
}

export default defineConfig({
  cacheDir: process.env.MOIRA_ASTRO_TEST_CACHE_DIR,
  markdown: { processor: docsConfig.markdown.processor },
});
