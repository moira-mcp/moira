import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { resolveTestUrls } from "../utils/remote-url-resolver.js";
import "../setup-origin-fetch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../..");

const resolved = resolveTestUrls();
const isRemote = process.env.PLAYWRIGHT_REMOTE === "true";
const isCi = process.env.CI === "true";
// These specs need services `npm run docker:restart` does not start: the MCP Inspector
// (docker-compose.inspector.yml) and a second container in self-host mode; the visual
// regression snapshots are platform-bound. CI skips them; locally they run only on request
// (PLAYWRIGHT_INCLUDE_EXTERNAL=true with those services up), so a plain full run finishes.
const externalServiceIgnores =
  isCi || process.env.PLAYWRIGHT_INCLUDE_EXTERNAL !== "true"
    ? [
        "**/inspector-mcp-tools.spec.ts",
        "**/inspector-oauth-registration.spec.ts",
        "**/self-host-account-approval.spec.ts",
        "**/visual-regression.spec.ts",
      ]
    : [];

export default defineConfig({
  testDir: join(projectRoot, "tests/e2e"),
  testMatch: "**/*.spec.ts",
  testIgnore: ["**/auth-mvp/**", "**/packages/**", ...externalServiceIgnores],
  // Per test: the slowest test measured alone takes about 2 s and about 10 s under four
  // parallel workers; 30 s leaves headroom without hiding a hung page. Remote browsers add
  // transfer latency to every step.
  timeout: isRemote ? 60000 : 30000,
  // Whole run: a full local run of the suite measured about six minutes with four workers;
  // fifteen minutes is the same budget CI uses and keeps a slow machine from being cut off
  // mid-run, which is what the earlier five-minute budget did.
  globalTimeout: isRemote ? 1800000 : 900000,
  retries: 1,
  // Four workers measured faster overall than five on a developer machine that also runs the
  // Docker container (about six minutes against seven), with the slowest test at 10 s instead
  // of 27 s and one first-attempt failure instead of six: five browsers plus the container
  // contend for the same CPU.
  workers: 4,
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
