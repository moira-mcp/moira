import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { resolveTestUrls } from "../utils/remote-url-resolver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");

const resolved = resolveTestUrls();
const isRemote = process.env.PLAYWRIGHT_REMOTE === "true";

export default defineConfig({
  testDir: join(projectRoot, "tests/e2e"),
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/auth-mvp/**", "**/packages/**"],
  timeout: isRemote ? 60000 : 30000,
  globalTimeout: isRemote ? 1800000 : 300000,
  retries: 1,
  workers: isRemote ? 4 : 5,
  fullyParallel: true,
  globalSetup: join(projectRoot, "tests/e2e/global-setup.ts"),
  outputDir: join(projectRoot, "test-results/artifacts/e2e"),
  use: {
    baseURL: process.env.TEST_BASE_URL || resolved.baseUrl,
    locale: "en-US",
    // Remote: trace/video transfer over WebSocket causes teardown timeouts
    trace: isRemote ? "off" : "retain-on-failure",
    screenshot: isRemote ? "off" : "only-on-failure",
    video: isRemote ? "off" : "retain-on-failure",
    ...(resolved.connectOptions && {
      connectOptions: resolved.connectOptions,
    }),
  },
  reporter: [
    ["list", { printSteps: true }],
    ["json", { outputFile: join(projectRoot, "test-results/artifacts/e2e.json") }],
    ["html", { outputFolder: join(projectRoot, "test-results/html-report"), open: "never" }],
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
