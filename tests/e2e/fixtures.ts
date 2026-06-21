/**
 * E2E Test Fixtures
 * Auto-capture console and network logs for debugging
 *
 * Import this instead of @playwright/test:
 *   import { test, expect } from './fixtures'
 */

import { test as base, expect, chromium } from "@playwright/test";

type AutoLogFixture = {
  autoCaptureLogs: void;
};

export const test = base.extend<AutoLogFixture>({
  autoCaptureLogs: [
    async ({ page }, use, testInfo) => {
      const consoleLogs: string[] = [];
      const networkLogs: string[] = [];

      // Capture all console messages
      page.on("console", (msg) => {
        const log = `[${msg.type()}] ${msg.text()}`;
        consoleLogs.push(log);
      });

      // Capture network requests with body
      page.on("request", (request) => {
        const method = request.method();
        const url = request.url();
        let log = `→ ${method} ${url}`;

        // Add request body for POST/PUT/PATCH
        if (["POST", "PUT", "PATCH"].includes(method)) {
          const postData = request.postData();
          if (postData) {
            try {
              const parsed = JSON.parse(postData);
              // Mask password fields
              if (parsed.password) parsed.password = "***";
              if (parsed.currentPassword) parsed.currentPassword = "***";
              if (parsed.newPassword) parsed.newPassword = "***";
              log += `\n   Body: ${JSON.stringify(parsed)}`;
            } catch {
              log += `\n   Body: ${postData.substring(0, 500)}`;
            }
          }
        }
        networkLogs.push(log);
      });

      // Capture network responses (sync-only to prevent context teardown hangs)
      // NOTE: response.text() is intentionally NOT called here — async Playwright API
      // calls in event handlers block browserContext.close() and cause teardown timeouts.
      page.on("response", (response) => {
        const status = response.status();
        const statusText = status >= 400 ? "❌" : "✓";
        networkLogs.push(`← ${statusText} ${status} ${response.url()}`);
      });

      // Capture failed requests
      page.on("requestfailed", (request) => {
        networkLogs.push(`❌ FAILED: ${request.url()} - ${request.failure()?.errorText}`);
      });

      await use();

      // Navigate away before teardown to prevent context.close() hangs.
      // Admin pages with pending API requests block remote browser context shutdown.
      await page.goto("about:blank").catch(() => {});

      // If test failed, output logs to stdout (will be in JSON result.stdout)
      if (testInfo.status !== "passed") {
        console.log("\n" + "=".repeat(80));
        console.log(`📋 BROWSER CONSOLE (${consoleLogs.length} messages):`);
        console.log("=".repeat(80));
        consoleLogs.forEach((log) => console.log(log));

        console.log("\n" + "=".repeat(80));
        console.log(`🌐 NETWORK (${networkLogs.length} requests):`);
        console.log("=".repeat(80));
        networkLogs.forEach((log) => console.log(log));
        console.log("=".repeat(80) + "\n");
      }
    },
    { auto: true },
  ],
});

export { expect, chromium };
export type { Page, Dialog, BrowserContext } from "@playwright/test";
