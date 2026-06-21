/**
 * Admin Monitoring Test Page E2E Tests
 * Tests the monitoring test page functionality
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Admin Monitoring Test Page", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("monitoring test page is accessible from admin nav", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");

    // Verify page title is visible
    await expect(
      page.getByRole("heading", { name: /Monitoring Test|Тест мониторинга/i }),
    ).toBeVisible();
  });

  test("monitoring test page shows frontend error buttons", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // Frontend error buttons should be visible
    await expect(page.locator('[data-testid="trigger-react-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-window-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-promise-error"]')).toBeVisible();
  });

  test("monitoring test page shows backend test buttons", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // Backend test buttons should be visible
    await expect(page.locator('[data-testid="trigger-api-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-slow-request"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-log-levels"]')).toBeVisible();
  });

  test("window error button sends request to /api/logs/client", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // Setup request listener for client logs endpoint
    let clientLogRequest: { body: string } | null = null;
    page.on("request", (request) => {
      if (request.url().includes("/api/logs/client")) {
        clientLogRequest = { body: request.postData() || "" };
      }
    });

    // Click window error button (this triggers setTimeout error)
    await page.click('[data-testid="trigger-window-error"]');

    // Wait for the request to be made (setTimeout delay + network)
    await page.waitForTimeout(1000);

    // Verify request was made to client logs endpoint
    expect(clientLogRequest).not.toBeNull();
    expect(clientLogRequest!.body).toContain("Monitoring Test");
  });

  test("promise error button sends request to /api/logs/client", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // Setup request listener for client logs endpoint
    let clientLogRequest: { body: string } | null = null;
    page.on("request", (request) => {
      if (request.url().includes("/api/logs/client")) {
        clientLogRequest = { body: request.postData() || "" };
      }
    });

    // Click promise error button
    await page.click('[data-testid="trigger-promise-error"]');

    // Wait for the request to be made
    await page.waitForTimeout(500);

    // Verify request was made to client logs endpoint
    expect(clientLogRequest).not.toBeNull();
    expect(clientLogRequest!.body).toContain("Monitoring Test");
  });

  test("react error button triggers error boundary", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // Setup request listener for client logs endpoint
    let clientLogRequest: { body: string } | null = null;
    page.on("request", (request) => {
      if (request.url().includes("/api/logs/client")) {
        clientLogRequest = { body: request.postData() || "" };
      }
    });

    // Click react error button - this triggers an error in React render
    // which is caught by ErrorBoundary
    await page.click('[data-testid="trigger-react-error"]');

    // Wait for error boundary to catch and log
    await page.waitForTimeout(500);

    // Verify request was made to client logs endpoint
    expect(clientLogRequest).not.toBeNull();
    expect(clientLogRequest!.body).toContain("Monitoring Test");
  });

  test("API error button triggers backend 500 error", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for button to be ready before setting up listener
    await expect(page.locator('[data-testid="trigger-api-error"]')).toBeVisible();

    // Setup response listener for monitoring-test/error endpoint
    let errorResponse: { status: number } | null = null;
    page.on("response", (response) => {
      if (response.url().includes("/api/admin/monitoring-test/error")) {
        errorResponse = { status: response.status() };
      }
    });

    // Click API error button
    await page.click('[data-testid="trigger-api-error"]');

    // Wait for the response (use element-based wait instead of fixed timeout)
    await expect(page.locator("text=API error triggered successfully")).toBeVisible({
      timeout: 5000,
    });

    // Verify 500 response was received
    expect(errorResponse).not.toBeNull();
    expect(errorResponse!.status).toBe(500);
  });

  test("log levels button generates backend logs", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for button to be ready
    await expect(page.locator('[data-testid="trigger-log-levels"]')).toBeVisible();

    // Setup response listener for monitoring-test/log-levels endpoint
    let logResponse: { status: number } | null = null;
    page.on("response", (response) => {
      if (response.url().includes("/api/admin/monitoring-test/log-levels")) {
        logResponse = { status: response.status() };
      }
    });

    // Click log levels button
    await page.click('[data-testid="trigger-log-levels"]');

    // Wait for the response (use element-based wait instead of fixed timeout)
    await expect(page.locator("text=Generated 4 log entries")).toBeVisible({ timeout: 5000 });

    // Verify 200 response was received
    expect(logResponse).not.toBeNull();
    expect(logResponse!.status).toBe(200);
  });

  test("workflow test section is visible", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");

    // Workflow section should be visible
    await expect(page.locator('[data-testid="trigger-workflow"]')).toBeVisible();
  });

  test("workflow button triggers workflow simulation", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("networkidle");

    // Click workflow button and wait for response simultaneously
    const [workflowResponse] = await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes("/api/admin/monitoring-test/workflow"),
        { timeout: 10000 },
      ),
      page.click('[data-testid="trigger-workflow"]'),
    ]);

    // Verify 200 response was received
    expect(workflowResponse.status()).toBe(200);

    // Verify success event is shown in history
    await expect(page.locator("text=Workflow start request logged")).toBeVisible({ timeout: 5000 });
  });

  test("MCP test section shows both buttons", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);

    // MCP buttons should be visible
    await expect(page.locator('[data-testid="trigger-mcp-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="trigger-mcp-error"]')).toBeVisible();
  });

  test("MCP success button triggers simulation", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for button to be ready before setting up listener
    await expect(page.locator('[data-testid="trigger-mcp-success"]')).toBeVisible();

    // Setup response listener for monitoring-test/mcp-call endpoint
    let mcpResponse: { status: number } | null = null;
    page.on("response", (response) => {
      if (response.url().includes("/api/admin/monitoring-test/mcp-call")) {
        mcpResponse = { status: response.status() };
      }
    });

    // Click MCP success button
    await page.click('[data-testid="trigger-mcp-success"]');

    // Wait for the response (use element-based wait instead of fixed timeout)
    await expect(page.locator("text=simulated with success status")).toBeVisible({ timeout: 5000 });

    // Verify 200 response was received
    expect(mcpResponse).not.toBeNull();
    expect(mcpResponse!.status).toBe(200);
  });

  test("MCP error button triggers error simulation", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/monitoring-test`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for button to be ready before setting up listener
    await expect(page.locator('[data-testid="trigger-mcp-error"]')).toBeVisible();

    // Setup response listener for monitoring-test/mcp-call endpoint
    let mcpResponse: { status: number } | null = null;
    page.on("response", (response) => {
      if (response.url().includes("/api/admin/monitoring-test/mcp-call")) {
        mcpResponse = { status: response.status() };
      }
    });

    // Click MCP error button
    await page.click('[data-testid="trigger-mcp-error"]');

    // Wait for the response (use element-based wait instead of fixed timeout)
    await expect(page.locator("text=simulated with error status")).toBeVisible({ timeout: 5000 });

    // Verify 200 response was received (endpoint returns 200, logs error internally)
    expect(mcpResponse).not.toBeNull();
    expect(mcpResponse!.status).toBe(200);
  });
});
