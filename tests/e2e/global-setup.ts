/**
 * Global Setup for E2E Tests
 * Runs once before all tests to ensure base workflows exist
 */

import { chromium } from "@playwright/test";
import { loadWorkflowFixture } from "./fixtures/load-workflow.js";
import { TEST_USERS, TEST_WORKFLOWS } from "./fixtures/test-constants.js";
import { createTestUser } from "./helpers/auth-helper.js";
import { resolveTestUrls } from "../utils/remote-url-resolver.js";

const resolved = resolveTestUrls();
const BASE_URL = process.env.TEST_BASE_URL || resolved.baseUrl;

export default async function globalSetup() {
  console.log(`🔧 E2E Global Setup: Creating base workflows and users... [${resolved.mode}]`);

  const browser = resolved.connectOptions
    ? await chromium.connect(resolved.connectOptions.wsEndpoint, { timeout: 15000 })
    : await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE_URL, locale: "en-US" });
  const page = await context.newPage();

  // Log browser console for debugging
  page.on("console", (msg) => console.log(`[Browser ${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.error("[Browser Error]", err.message));

  // Log all network requests
  page.on("request", (request) => {
    console.log(`[Network →] ${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    console.log(`[Network ←] ${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    console.error(`[Network FAILED] ${request.url()} - ${request.failure()?.errorText}`);
  });

  try {
    // Login as admin
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");
    await page.locator('input[name="email"]').fill(TEST_USERS.ADMIN.email);
    await page.locator('input[name="password"]').fill(TEST_USERS.ADMIN.password);
    await page.locator('button[type="submit"]').click();
    // Wait for redirect to app (admin is always verified)
    await page.waitForURL(`${BASE_URL}/`);

    // Create admin workflows (1 private, 1 public)
    await loadWorkflowFixture(page, TEST_WORKFLOWS.REACT_FLOW_THEME.filename, "private");
    await loadWorkflowFixture(page, TEST_WORKFLOWS.PUBLIC_TEST.filename, "public");

    // Logout
    await page.goto(`${BASE_URL}/`);
    const logoutButton = page.locator('button:has-text("Logout")');
    if (await logoutButton.isVisible().catch(() => false)) {
      await logoutButton.click();
      await page.waitForURL((url) => url.toString().includes("/login"));
    }

    // Create MCP tools test user and verify their email using helper
    await createTestUser(
      TEST_USERS.MCP_TOOLS_TEST.email,
      TEST_USERS.MCP_TOOLS_TEST.password,
      TEST_USERS.MCP_TOOLS_TEST.name,
      true, // verify email
    );
    console.log(`✓ Email verified for ${TEST_USERS.MCP_TOOLS_TEST.email}`);

    // Login as MCP tools test user
    await page.goto(`${BASE_URL}/login`);
    await page.locator('input[name="email"]').fill(TEST_USERS.MCP_TOOLS_TEST.email);
    await page.locator('input[name="password"]').fill(TEST_USERS.MCP_TOOLS_TEST.password);
    await page.locator('button[type="submit"]').click();
    // Wait for redirect (MCP tools user is verified in setup above)
    console.log("⏳ Waiting for redirect to / after MCP user login...");
    console.log("📍 Current URL before wait:", page.url());
    await page.waitForURL(`${BASE_URL}/`);
    console.log("✓ Redirected to:", page.url());

    // Create private workflow for MCP tools test user
    await loadWorkflowFixture(page, TEST_WORKFLOWS.MCP_TOOLS_PRIVATE.filename, "private");

    console.log("✅ E2E Global Setup: Complete");
  } catch (error) {
    console.error("❌ E2E Global Setup failed:", error);
    throw error;
  } finally {
    await browser.close();
  }
}
