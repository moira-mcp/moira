/**
 * E2E: the built Starlight documentation site is served at /docs by the image.
 *
 * Guards BUG 2 of the self-host work: before, /docs fell through to the Web UI
 * SPA catch-all (HTTP 200 but the wrong page). Now the image builds the docs
 * site and nginx serves it at /docs (+ /ru/docs), while the Web UI stays at /.
 * A missing doc must 404 (not silently render the SPA).
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("Docs site served at /docs", () => {
  test("/docs serves the Starlight documentation, not the Web UI SPA", async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/docs/getting-started/quickstart/`);
    expect(res?.status()).toBe(200);
    // Starlight page title — distinct from the Web UI's "MCP Moira Workflow Visualizer".
    await expect(page).toHaveTitle(/Moira Documentation/);
    // The Starlight docs shell renders a navigation sidebar.
    await expect(page.locator("body")).toContainText("Quick Start");
  });

  test("/ru/docs serves the Russian documentation", async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/ru/docs/getting-started/quickstart/`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Moira Documentation/);
  });

  test("/ still serves the Web UI SPA", async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/MCP Moira Workflow Visualizer/);
  });

  test("a missing doc page 404s instead of falling through to the SPA", async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/docs/this-page-does-not-exist/`);
    expect(res?.status()).toBe(404);
  });
});
