/**
 * Test Configuration Utilities
 *
 * CRITICAL: All integration and E2E tests MUST use getTestBaseUrl() for URL configuration
 * NO hardcoded URLs or ports anywhere in tests
 *
 * NOTE: .env.local is loaded by test runner scripts before tests start
 */

import { resolveTestUrls } from "./remote-url-resolver.js";

/**
 * Get base URL for integration/E2E tests
 *
 * Priority: TEST_BASE_URL env var > resolveTestUrls() based on toggles
 */
export function getTestBaseUrl(): string {
  if (process.env.TEST_BASE_URL) {
    return process.env.TEST_BASE_URL;
  }

  if (!process.env.DOCKER_PORT) {
    console.error(
      "[test-config] DOCKER_PORT not found in env. Available vars:",
      Object.keys(process.env).filter((k) => k.includes("DOCKER") || k.includes("PORT")),
    );
    throw new Error("DOCKER_PORT is not set in .env.local file. Required for tests.");
  }

  const resolved = resolveTestUrls();
  console.log(`[test-config] ${resolved.mode}: ${resolved.baseUrl}`);
  return resolved.baseUrl;
}

/**
 * Get fetch URL for direct Node.js HTTP calls (not browser).
 * In remote mode, this returns http://REMOTE_HOST:PORT (reachable from Mac).
 * In local mode, same as baseUrl (localhost).
 *
 * NOTE: Does NOT use TEST_BASE_URL override — fetchUrl must always
 * come from the resolver to correctly distinguish baseUrl (browser)
 * from fetchUrl (Node.js HTTP from Mac).
 */
export function getTestFetchUrl(): string {
  return resolveTestUrls().fetchUrl;
}

/**
 * Get test timeout in milliseconds
 * @returns Timeout value from env or default 30000ms
 */
export function getTestTimeout(): number {
  return parseInt(process.env.TEST_TIMEOUT || "30000", 10);
}

/**
 * Get admin credentials for tests
 * Reads from ADMIN_EMAIL and ADMIN_PASSWORD env vars (loaded from appropriate .env file)
 *
 * IMPORTANT: All tests MUST use this function instead of hardcoding credentials
 */
export function getAdminCredentials(): { email: string; password: string } {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    throw new Error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set. Check that correct .env file is loaded.",
    );
  }

  return {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  };
}

/**
 * Check if tests are running against production/staging (external server)
 */
export function isExternalTarget(): boolean {
  const baseUrl = process.env.TEST_BASE_URL || "";
  // External targets use HTTPS (production/staging), local uses HTTP
  return baseUrl.startsWith("https://");
}

/**
 * Get test environment name
 */
export function getTestEnvironment(): "local" | "production" {
  const baseUrl = process.env.TEST_BASE_URL || "";
  // Local unless an external HTTPS base URL is configured.
  if (!baseUrl.startsWith("https://")) return "local";
  return "production";
}
