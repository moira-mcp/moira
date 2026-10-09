/**
 * E2E Tests: Workflow List Performance
 * Tests that workflow list loads efficiently without duplicate API requests
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Workflow List Performance", () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss beta agreement modal via cookie before any navigation
    const url = new URL(BASE_URL);
    await page.context().addCookies([
      {
        name: "moira-beta-accepted",
        value: "true",
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: BASE_URL.startsWith("https://"),
        sameSite: "Lax",
      },
    ]);
  });

  /**
   * Helper to wait for workflow list to finish loading
   * Waits for the "X of Y" counter which only appears after API response
   */
  async function waitForWorkflowListLoaded(page: import("@playwright/test").Page) {
    // Wait for the "X of Y" text which appears after workflows are loaded
    // This appears in the header: "0 of 0" or "5 of 20" etc.
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        // Match pattern like "0 of 0" or "20 of 42"
        return /\d+\s+of\s+\d+/.test(text);
      },
      { timeout: 15000 },
    );
  }

  test("minimal API requests on page load", async ({ page }) => {
    // Login as admin, and let the home page it lands on finish its own requests (it shows the
    // recommended flows too), so only the flow list's requests are counted below
    await loginAsAdmin(page);
    await page.waitForLoadState("networkidle");

    // Track the explorer's API requests to /api/workflows. The recommended section above the list
    // asks once for its named flows (`slugs=`); that single lookup is counted on its own.
    const workflowRequests: string[] = [];
    const recommendedRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workflows" && request.method() === "GET") {
        (url.searchParams.has("slugs") ? recommendedRequests : workflowRequests).push(url.href);
      }
    });

    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for workflow list to fully load
    await waitForWorkflowListLoaded(page);

    // Wait a bit more to ensure no delayed duplicate requests
    await page.waitForTimeout(1000);

    // Dynamic page size calculates limit from viewport height, which may change
    // during initial layout. Allow up to 3 requests during layout stabilization.
    // The key invariant: no duplicate URLs (same params shouldn't be fetched twice)
    const uniqueRequests = [...new Set(workflowRequests)];
    expect(uniqueRequests.length).toBe(workflowRequests.length);
    expect(uniqueRequests.length).toBeLessThanOrEqual(3);
    // Must have at least 1 request
    expect(uniqueRequests.length).toBeGreaterThanOrEqual(1);
    expect(recommendedRequests).toHaveLength(1);
  });

  test("single API request on search input", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Navigate to workflows page and wait for initial load
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkflowListLoaded(page);
    await page.waitForLoadState("networkidle");

    // Clear request tracking and start fresh
    const searchRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workflows" && request.method() === "GET") {
        searchRequests.push(url.href);
      }
    });

    // Type in search input - find by placeholder
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill("test");

    // Wait for debounce (300ms) + request + response
    await page.waitForTimeout(800);

    // Should have minimal requests with search parameter
    // Dynamic page sizing may cause an extra request if container resizes
    expect(searchRequests.length).toBeGreaterThanOrEqual(1);
    expect(searchRequests.length).toBeLessThanOrEqual(3);
    expect(new Set(searchRequests).size).toBe(searchRequests.length);
    const searchWithParam = searchRequests.find(
      (url) => new URL(url).searchParams.get("search") === "test",
    );
    expect(searchWithParam).toBeTruthy();
  });

  test("single API request on sort change", async ({ page }) => {
    // Login as admin
    await loginAsAdmin(page);

    // Navigate to workflows page and wait for initial load
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await waitForWorkflowListLoaded(page);

    // Clear request tracking
    const sortRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workflows" && request.method() === "GET") {
        sortRequests.push(url.href);
      }
    });

    // Opening filters changes the list's available height. A debounced page-size request
    // can still use the baseline sort before the option click completes.
    await page.getByTestId("filters-toggle").click();
    await page.waitForLoadState("networkidle");
    sortRequests.length = 0;
    const sortTrigger = page.locator('[data-testid="sort-select"]');
    await sortTrigger.click();

    const sortResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/workflows" &&
        response.request().method() === "GET" &&
        url.searchParams.get("sort") === "name" &&
        url.searchParams.get("sortOrder") === "asc"
      );
    });

    // Click "Name ↑" option
    await page.getByRole("option", { name: /Name.*↑/ }).click();
    expect((await sortResponsePromise).status()).toBe(200);

    // Wait for request
    await page.waitForLoadState("networkidle");

    // Should have minimal requests for sort change
    // Dynamic page sizing may cause an extra request if container resizes
    expect(sortRequests.length).toBeGreaterThanOrEqual(1);
    expect(sortRequests.length).toBeLessThanOrEqual(3);
    expect(new Set(sortRequests).size).toBe(sortRequests.length);
    const sortParams = sortRequests.map((url) => new URL(url).searchParams);
    const transitionIndex = sortParams.findIndex(
      (params) => params.get("sort") === "name" && params.get("sortOrder") === "asc",
    );
    expect(transitionIndex).toBeGreaterThanOrEqual(0);
    for (const params of sortParams.slice(0, transitionIndex)) {
      expect(params.get("sort")).toBe("createdAt");
      expect(params.get("sortOrder")).toBe("desc");
    }
    for (const params of sortParams.slice(transitionIndex)) {
      expect(params.get("sort")).toBe("name");
      expect(params.get("sortOrder")).toBe("asc");
    }
  });

  test("no requests when not authenticated", async ({ page }) => {
    // Track API requests to /api/workflows
    const workflowRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/workflows" && request.method() === "GET") {
        workflowRequests.push(url.href);
      }
    });

    // Try to navigate to workflows page without login
    await page.goto(`${BASE_URL}/workflows`);

    // Should redirect to login
    await page.waitForURL((url) => url.toString().includes("/login"), { timeout: 10000 });

    // Should have ZERO requests to workflow API (not authenticated)
    expect(workflowRequests.length).toBe(0);
  });
});
