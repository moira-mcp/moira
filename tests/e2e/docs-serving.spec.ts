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

  for (const width of [390, 1440]) {
    test(`client install links keep compact icons at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE_URL}/docs/getting-started/quickstart/`);
      for (const client of ["Cursor", "VS Code", "ChatGPT"]) {
        await page.getByRole("tab", { name: client, exact: true }).click();
        const panel = page.getByRole("tabpanel").filter({
          has: page.getByRole("link", { name: "Official client documentation", exact: true }),
        });
        const link = panel.locator("a[aria-label]");
        await expect(link).toHaveCount(1);
        const geometry = await link.evaluate((element) => {
          const icon = element.querySelector("svg")!;
          return {
            iconWidth: icon.getBoundingClientRect().width,
            iconHeight: icon.getBoundingClientRect().height,
            linkHeight: element.getBoundingClientRect().height,
          };
        });
        expect(geometry.iconWidth).toBeGreaterThanOrEqual(12);
        expect(geometry.iconWidth).toBeLessThanOrEqual(32);
        expect(geometry.iconHeight).toBeLessThanOrEqual(32);
        expect(geometry.linkHeight).toBeLessThanOrEqual(80);
      }
    });
  }

  // Starlight keeps its palette in a cascade layer, so an unlayered site palette must be scoped to
  // the dark theme; otherwise the light theme renders the dark page background.
  for (const { theme, background } of [
    { theme: "light", background: "rgb(255, 255, 255)" },
    { theme: "dark", background: "rgb(23, 24, 28)" },
  ]) {
    test(`the ${theme} theme paints the ${theme} page background`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem("starlight-theme", value), theme);
      await page.goto(`${BASE_URL}/docs/getting-started/quickstart/`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("body")).toHaveCSS("background-color", background);
    });
  }

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
