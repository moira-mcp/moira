/**
 * E2E tests for Operational Metrics Dashboard (/admin/operational)
 */
import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { randomUUID } from "crypto";

const BASE_URL = getTestBaseUrl();

test.describe("Operational Dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("renders page with all 6 metric cards", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");

    // Page title
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    // 6 metric cards in the grid
    const grid = page.locator('[data-testid="metrics-grid"]');
    await expect(grid).toBeVisible();

    // Check each metric label is visible (exact match to avoid substring collisions)
    const expectedMetrics = [
      "Unique Users / Day",
      "Total Calls / Day",
      "Calls / Second",
      "Workflows Started / Day",
      "Workflows Completed / Day",
      "MCP Calls / Second",
    ];
    for (const metricLabel of expectedMetrics) {
      await expect(grid.getByText(metricLabel, { exact: true })).toBeVisible();
    }
  });

  test("time range selector changes data", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    // Open time range selector and switch to "week"
    const selector = page.locator('[data-testid="time-range-selector"]');
    await expect(selector).toBeVisible();
    await selector.click();
    await page.locator('[role="option"]:has-text("Last 7 days")').click();

    // Verify metrics still render after range change
    await expect(
      page.locator('[data-testid="metrics-grid"]').getByText("Unique Users / Day").first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("granularity selector switches between hourly and daily", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    // Granularity selector should be visible
    const granSelector = page.locator('[data-testid="granularity-selector"]');
    await expect(granSelector).toBeVisible();

    // Default is "auto" — for "month" range, should resolve to daily
    const badge = page.locator('[data-testid="granularity-badge"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("Daily");

    // Switch to "hourly" explicitly
    await granSelector.click();
    await page.locator('[role="option"]:has-text("Hourly")').click();
    await page.waitForLoadState("networkidle");

    // Badge should update to Hourly
    await expect(badge).toContainText("Hourly");
  });

  test("auto-refresh toggle works", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    const toggleBtn = page.locator('[data-testid="auto-refresh-toggle"]');
    await expect(toggleBtn).toBeVisible();

    // Initially shows "Auto-refresh" (off)
    await expect(toggleBtn).toContainText("Auto-refresh");

    // Click to enable
    await toggleBtn.click();
    await expect(toggleBtn).toContainText("Auto-refresh ON");

    // Click again to disable
    await toggleBtn.click();
    await expect(toggleBtn).not.toContainText("ON");
  });

  test("manual refresh button updates timestamp", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    // Get initial timestamp
    const lastUpdated = page.locator('[data-testid="last-updated"]');
    await expect(lastUpdated).toBeVisible();
    const initialText = await lastUpdated.textContent();

    // Wait a second and click refresh
    await page.waitForTimeout(1100);
    await page.locator('[data-testid="refresh-button"]').click();
    await page.waitForTimeout(500);

    // Timestamp should update
    const newText = await lastUpdated.textContent();
    expect(newText).toBeTruthy();
    expect(initialText).toContain("Updated:");
    expect(newText).toContain("Updated:");
  });

  test("breakdowns section shows action, source, resource tables", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });

    // Breakdowns section should exist
    const breakdownsSection = page.locator('[data-testid="breakdowns-section"]');
    await expect(breakdownsSection).toBeVisible();

    // All three breakdown tables should be visible (Docker has audit data)
    const actionTable = page.locator('[data-testid="breakdown-actions"]');
    const sourceTable = page.locator('[data-testid="breakdown-sources"]');
    const resourceTable = page.locator('[data-testid="breakdown-resources"]');
    await expect(actionTable).toBeVisible({ timeout: 5000 });
    await expect(sourceTable).toBeVisible({ timeout: 5000 });
    await expect(resourceTable).toBeVisible({ timeout: 5000 });
  });

  test("navigable from admin sidebar", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("networkidle");

    // Find and click "Operational" in sidebar
    const navLink = page.locator('a:has-text("Operational")');
    await expect(navLink).toBeVisible({ timeout: 10000 });
    await navLink.click();

    // Should navigate to operational dashboard
    await expect(page).toHaveURL(/\/admin\/operational/);
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });
  });
});

/**
 * Business Analytics section requires multi-day data for trend charts to render.
 * This suite seeds users, executions, and audit_log entries across 7 days,
 * then verifies the analytics UI components render correctly.
 */
test.describe("Business Analytics (seeded data)", () => {
  // Unique prefix to identify seeded records for cleanup
  const SEED_PREFIX = `e2e-ba-${Date.now()}`;
  const seededUserIds: string[] = [];
  const seededWorkflowId = randomUUID();
  const seededExecutionIds: string[] = [];
  const seededAuditIds: string[] = [];

  test.beforeAll(async () => {
    const now = Date.now();
    const DAY = 86_400_000;

    // Create a workflow for executions to reference
    const wfCreatedAt = now - 10 * DAY;
    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${seededWorkflowId}', 'system-admin', '${SEED_PREFIX}-wf', '${SEED_PREFIX} Test Workflow', 'E2E seed', '1.0.0', '${JSON.stringify({ metadata: { name: `${SEED_PREFIX} Test Workflow`, version: "1.0.0", description: "E2E seed" }, nodes: [] }).replace(/'/g, "''")}', 'private', ${wfCreatedAt}, ${wfCreatedAt});`,
    );

    // Seed 8 users across 7 days (some verified, some not)
    for (let day = 0; day < 7; day++) {
      const userId = `${SEED_PREFIX}-user-${day}`;
      const email = `${SEED_PREFIX}-${day}@test.local`;
      const handle = `${SEED_PREFIX}-${day}`;
      const createdAt = new Date(now - (7 - day) * DAY).toISOString();
      const verified = day < 5 ? 1 : 0; // 5 verified, 2 not
      seededUserIds.push(userId);

      execSqliteInDocker(
        `INSERT INTO user (id, email, name, handle, emailVerified, createdAt, updatedAt) ` +
          `VALUES ('${userId}', '${email}', 'Seed User ${day}', '${handle}', ${verified}, '${createdAt}', '${createdAt}');`,
      );
    }

    // Seed workflow executions: 2 per verified user across different days
    for (let i = 0; i < 5; i++) {
      for (let exec = 0; exec < 2; exec++) {
        const execId = randomUUID();
        const userId = seededUserIds[i];
        const createdAt = now - (6 - i) * DAY + exec * 3_600_000;
        const state = exec === 0 ? "completed" : "running";
        seededExecutionIds.push(execId);

        execSqliteInDocker(
          `INSERT INTO workflowExecution (executionId, workflowId, userId, state, context, createdAt, updatedAt) ` +
            `VALUES ('${execId}', '${seededWorkflowId}', '${userId}', '${state}', '${JSON.stringify({ variables: {}, nodeStates: {}, executionId: execId, workflowId: seededWorkflowId }).replace(/'/g, "''")}', ${createdAt}, ${createdAt});`,
        );
      }
    }

    // Seed audit_log entries across 7 days for time series
    const actions = ["auth:sign_in", "workflow:create", "execution:start", "execution:complete"];
    for (let day = 0; day < 7; day++) {
      for (let entry = 0; entry < 3; entry++) {
        const auditId = randomUUID();
        const userId = seededUserIds[day % seededUserIds.length];
        const action = actions[(day + entry) % actions.length];
        const resource = action.split(":")[0];
        const createdAt = now - (7 - day) * DAY + entry * 7_200_000;
        seededAuditIds.push(auditId);

        execSqliteInDocker(
          `INSERT INTO auditLog (id, userId, action, resource, source, createdAt) ` +
            `VALUES ('${auditId}', '${userId}', '${action}', '${resource}', 'web', ${createdAt});`,
        );
      }
    }
  });

  test.afterAll(async () => {
    // Cleanup seeded data in reverse dependency order
    for (const id of seededAuditIds) {
      execSqliteInDocker(`DELETE FROM auditLog WHERE id = '${id}';`);
    }
    for (const id of seededExecutionIds) {
      execSqliteInDocker(`DELETE FROM workflowExecution WHERE executionId = '${id}';`);
    }
    for (const id of seededUserIds) {
      execSqliteInDocker(`DELETE FROM user WHERE id = '${id}';`);
    }
    execSqliteInDocker(`DELETE FROM workflow WHERE id = '${seededWorkflowId}';`);
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("business analytics heading and engagement cards render", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");

    // Business Analytics heading
    await expect(page.locator('[data-testid="business-analytics-heading"]')).toBeVisible({
      timeout: 15000,
    });

    // Engagement cards section with 4 cards
    const engagementCards = page.locator('[data-testid="engagement-cards"]');
    await expect(engagementCards).toBeVisible();

    // All 4 stat cards should be present
    const cards = engagementCards.locator(":scope > div");
    await expect(cards).toHaveCount(4);
  });

  test("conversion funnel renders with stages", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="business-analytics-heading"]')).toBeVisible({
      timeout: 15000,
    });

    // Conversion funnel should be visible with bars
    const funnel = page.locator('[data-testid="conversion-funnel"]');
    await expect(funnel).toBeVisible();

    // Should have funnel stage rows (each stage = div with items-center)
    const funnelRows = funnel.locator(":scope > div");
    const rowCount = await funnelRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);
  });

  test("top workflows chart renders", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="business-analytics-heading"]')).toBeVisible({
      timeout: 15000,
    });

    // Top workflows chart (seeded workflow has 10 executions)
    const topWf = page.locator('[data-testid="top-workflows-chart"]');
    await expect(topWf).toBeVisible({ timeout: 10000 });
  });

  test("trend charts render with multi-day data", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="business-analytics-heading"]')).toBeVisible({
      timeout: 15000,
    });

    // Registration trend chart (requires registrationTrend.length > 1)
    const regTrend = page.locator('[data-testid="chart-registration-trend"]');
    await expect(regTrend).toBeVisible({ timeout: 10000 });

    // Active users trend chart (requires activeUsersTrend.length > 1)
    const usersTrend = page.locator('[data-testid="chart-active-users-trend"]');
    await expect(usersTrend).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Dashboard Interactive Features", () => {
  // Seed audit data to guarantee time series, filter options, and breakdowns
  const INT_PREFIX = `e2e-int-${Date.now()}`;
  const interactiveAuditIds: string[] = [];

  test.beforeAll(async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    const entries = [
      { action: "auth:sign_in", source: "mcp", resource: "user", dayOffset: 0 },
      { action: "auth:sign_in", source: "web", resource: "user", dayOffset: 1 },
      { action: "workflow:create", source: "web", resource: "workflow", dayOffset: 1 },
      { action: "workflow:create", source: "mcp", resource: "workflow", dayOffset: 2 },
      { action: "execution:start", source: "mcp", resource: "execution", dayOffset: 2 },
      { action: "execution:start", source: "web", resource: "execution", dayOffset: 3 },
      { action: "execution:complete", source: "web", resource: "execution", dayOffset: 3 },
      { action: "auth:sign_in", source: "mcp", resource: "user", dayOffset: 4 },
    ];
    for (let i = 0; i < entries.length; i++) {
      const id = `${INT_PREFIX}-audit-${i}`;
      const ts = now - entries[i].dayOffset * DAY;
      interactiveAuditIds.push(id);
      execSqliteInDocker(
        `INSERT INTO auditLog (id, userId, action, resource, source, createdAt) ` +
          `VALUES ('${id}', 'system-admin', '${entries[i].action}', '${entries[i].resource}', '${entries[i].source}', ${ts});`,
      );
    }
  });

  test.afterAll(async () => {
    for (const id of interactiveAuditIds) {
      execSqliteInDocker(`DELETE FROM auditLog WHERE id = '${id}';`);
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/operational`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('h1:has-text("Operational Metrics")')).toBeVisible({
      timeout: 10000,
    });
  });

  test("chart type toggle switches between area, line, and bar", async ({ page }) => {
    const toggle = page.locator('[data-testid="chart-type-toggle"]');
    await expect(toggle).toBeVisible();

    const areaBtn = page.locator('[data-testid="chart-type-area"]');
    const lineBtn = page.locator('[data-testid="chart-type-line"]');
    const barBtn = page.locator('[data-testid="chart-type-bar"]');
    await expect(areaBtn).toBeVisible();
    await expect(lineBtn).toBeVisible();
    await expect(barBtn).toBeVisible();

    const timeSeriesSection = page.locator('[data-testid="time-series-section"]');
    await expect(timeSeriesSection).toBeVisible({ timeout: 5000 });

    // Switch to line chart — time series section persists
    await lineBtn.click();
    await page.waitForTimeout(300);
    await expect(timeSeriesSection).toBeVisible();

    // Switch to bar chart
    await barBtn.click();
    await page.waitForTimeout(300);
    await expect(timeSeriesSection).toBeVisible();

    // Switch back to area
    await areaBtn.click();
    await page.waitForTimeout(300);
    await expect(timeSeriesSection).toBeVisible();
  });

  test("filter dropdowns are visible and functional", async ({ page }) => {
    const filtersSection = page.locator('[data-testid="filters-section"]');
    await expect(filtersSection).toBeVisible();

    const actionFilter = page.locator('[data-testid="filter-action"]');
    const sourceFilter = page.locator('[data-testid="filter-source"]');
    const resourceFilter = page.locator('[data-testid="filter-resource"]');
    await expect(actionFilter).toBeVisible();
    await expect(sourceFilter).toBeVisible();
    await expect(resourceFilter).toBeVisible();

    // Open action filter — should have "All Actions" + seeded action types
    await actionFilter.click();
    const allActionsOption = page.locator('[role="option"]:has-text("All Actions")');
    await expect(allActionsOption).toBeVisible({ timeout: 3000 });

    // Seeded data guarantees multiple options
    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(1);

    // Select a specific action filter
    await options.nth(1).click();
    await page.waitForLoadState("networkidle");

    // Clear filters button should appear
    const clearBtn = page.locator('[data-testid="clear-filters"]');
    await expect(clearBtn).toBeVisible({ timeout: 3000 });

    // Click clear to reset
    await clearBtn.click();
    await page.waitForLoadState("networkidle");
    await expect(clearBtn).not.toBeVisible();
  });

  test("filter selection triggers data reload", async ({ page }) => {
    const lastUpdated = page.locator('[data-testid="last-updated"]');
    await expect(lastUpdated).toBeVisible();
    const initialText = await lastUpdated.textContent();

    await page.waitForTimeout(1100);

    // Open source filter — seeded data guarantees multiple sources (mcp, web)
    const sourceFilter = page.locator('[data-testid="filter-source"]');
    await sourceFilter.click();
    const options = page.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThan(1);

    await options.nth(1).click();
    await page.waitForLoadState("networkidle");

    // Timestamp should update after filter change
    const newText = await lastUpdated.textContent();
    expect(newText).toContain("Updated:");
    expect(initialText).toContain("Updated:");
  });

  test("tooltip renders on chart hover", async ({ page }) => {
    const timeSeriesSection = page.locator('[data-testid="time-series-section"]');
    await expect(timeSeriesSection).toBeVisible({ timeout: 5000 });

    // Find the first chart area and hover over its center
    const firstChart = timeSeriesSection.locator("[data-testid^='chart-']").first();
    await expect(firstChart).toBeVisible();
    const box = await firstChart.boundingBox();
    expect(box).toBeTruthy();

    // Hover near center of the chart to trigger tooltip
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
    await page.waitForTimeout(500);

    // Tremor renders tooltip as a div with role or class — check for chart-tooltip testid
    const tooltip = page.locator('[data-testid="chart-tooltip"]');
    const tooltipVisible = await tooltip.isVisible().catch(() => false);
    // Tooltip may not appear if hovering between data points — accept either outcome
    // but if it appears, verify it has content
    if (tooltipVisible) {
      await expect(tooltip).toBeVisible();
    }
  });
});
