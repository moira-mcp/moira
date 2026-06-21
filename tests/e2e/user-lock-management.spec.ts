/**
 * E2E Tests: User Lock Management UI
 * Tests that regular users can see lock status and submit PIN on their own executions.
 * Uses direct DB seeding via execSqliteInDocker for deterministic test data.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { loginAsAdmin, login, createTestUser } from "./helpers/auth-helper.js";
import { execSqliteInDocker } from "../utils/docker-command.js";
import { randomUUID } from "crypto";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

const SEED_PREFIX = "e2e-lock-mgmt";

test.describe("User Lock Management UI", () => {
  // Seeded data IDs for cleanup
  const seededWorkflowId = `${SEED_PREFIX}-wf-${Date.now()}`;
  const seededExecutionId = randomUUID();
  const seededLockId = randomUUID();
  const seededUserId = randomUUID();
  const seededUserEmail = `${SEED_PREFIX}-${Date.now()}@example.com`;
  const seededUserPassword = "LockTest123!";
  // For regular user test
  let regularUserId: string | undefined;

  test.beforeAll(async () => {
    const now = Date.now();

    // 1. Seed a workflow
    const graph = JSON.stringify({
      metadata: {
        name: `${SEED_PREFIX} Test Workflow`,
        version: "1.0.0",
        description: "E2E lock test",
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ],
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${seededWorkflowId}', 'system-admin', '${SEED_PREFIX}-wf-${now}', '${SEED_PREFIX} Test Workflow', 'E2E lock test', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );

    // 2. Create a test user via API for regular user login tests
    const result = await createTestUser(
      seededUserEmail,
      seededUserPassword,
      "Lock Test User",
      true,
    );
    regularUserId = result.userId;

    // If createTestUser gives us a userId, use it. Otherwise seed manually.
    const ownerUserId = regularUserId || seededUserId;

    // If createTestUser didn't return userId, seed user manually
    if (!regularUserId) {
      execSqliteInDocker(
        `INSERT OR IGNORE INTO user (id, email, name, handle, emailVerified, createdAt, updatedAt) ` +
          `VALUES ('${seededUserId}', '${seededUserEmail}', 'Lock Test User', '${SEED_PREFIX}-user-${now}', 1, '${new Date(now).toISOString()}', '${new Date(now).toISOString()}');`,
      );
    }

    // 3. Seed an execution owned by the test user
    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: seededExecutionId,
      workflowId: seededWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, context, createdAt, updatedAt) ` +
        `VALUES ('${seededExecutionId}', '${seededWorkflowId}', '${ownerUserId}', 'waiting', '${context}', ${now}, ${now});`,
    );

    // 4. Seed an active lock on the execution
    const plainPin = "123456";
    execSqliteInDocker(
      `INSERT INTO executionLock (id, executionId, nodeId, reason, lockedBy, pin, status, createdAt) ` +
        `VALUES ('${seededLockId}', '${seededExecutionId}', 'start', 'E2E test lock', '${ownerUserId}', '${plainPin}', 'active', ${now});`,
    );
  });

  test.afterAll(async () => {
    // Cleanup in reverse dependency order
    try {
      execSqliteInDocker(`DELETE FROM executionLock WHERE id = '${seededLockId}';`);
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(
        `DELETE FROM workflowExecution WHERE executionId = '${seededExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${seededWorkflowId}';`);
    } catch {
      /* ignore */
    }
    // Don't delete user — created via API with sessions, cleanup would be complex
  });

  test("Locks tab is visible on execution inspector for admin", async ({ page }) => {
    await loginAsAdmin(page);

    // Navigate directly to seeded execution
    await page.goto(`${BASE_URL}/admin/executions/${seededExecutionId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for inspector to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Locks tab should be visible
    const locksTab = page.locator('[role="tab"]', { hasText: /Locks|Блокировки/ });
    await expect(locksTab).toBeVisible();

    // Click Locks tab
    await locksTab.click();

    // Should show lock cards (we seeded one active lock)
    const lockCard = page.locator("text=E2E test lock");
    await expect(lockCard).toBeVisible({ timeout: 5000 });
  });

  test("Locks tab shows lock card with active status for admin", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/executions/${seededExecutionId}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click Locks tab
    await page.locator('[role="tab"]', { hasText: /Locks|Блокировки/ }).click();

    // Verify lock card shows active status badge
    const activeBadge = page.locator("text=active");
    await expect(activeBadge).toBeVisible({ timeout: 5000 });

    // Admin should see Unlock button (showOwnerInfo=true in admin route)
    const unlockButton = page.locator("button", { hasText: /Unlock|Разблокировать/ });
    await expect(unlockButton).toBeVisible();
  });

  test("Regular user sees Locks tab and Unlock button (no PIN display) on own execution", async ({
    page,
  }) => {
    // Login as the regular test user
    await login(page, seededUserEmail, seededUserPassword);

    // Navigate to user's own execution
    await page.goto(`${BASE_URL}/executions/${seededExecutionId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for inspector to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Locks tab should be visible for regular users too
    const locksTab = page.locator('[role="tab"]', { hasText: /Locks|Блокировки/ });
    await expect(locksTab).toBeVisible();

    // Click Locks tab
    await locksTab.click();

    // Unlock button should be visible (owner can unlock directly, no PIN needed)
    const unlockButton = page.locator("button", { hasText: /Unlock|Разблокировать/ });
    await expect(unlockButton).toBeVisible({ timeout: 5000 });

    // The stored PIN must NOT be displayed — it is hashed and shown only once at
    // creation. A "PIN:" label here would mean the (now hashed) value leaked.
    await expect(page.locator("text=/PIN:/")).toHaveCount(0);
  });

  test("User lock API endpoint returns locks for own execution", async ({ page }) => {
    await login(page, seededUserEmail, seededUserPassword);

    // Call user lock endpoint (use BASE_URL so browser cookies are sent)
    const locksRes = await page.request.get(
      `${BASE_URL}/api/executions/${seededExecutionId}/locks`,
    );
    expect(locksRes.ok()).toBe(true);

    const locksData = await locksRes.json();
    expect(locksData.success).toBe(true);
    expect(locksData.data).toBeDefined();
    expect(Array.isArray(locksData.data.locks)).toBe(true);
    expect(locksData.data.locks.length).toBeGreaterThanOrEqual(1);
    expect(typeof locksData.data.total).toBe("number");
  });

  test("PIN validation endpoint rejects invalid lock ID", async ({ page }) => {
    await login(page, seededUserEmail, seededUserPassword);

    // Try PIN validation with non-existent lock ID (use BASE_URL so browser cookies are sent)
    const pinRes = await page.request.post(
      `${BASE_URL}/api/executions/${seededExecutionId}/locks/nonexistent-lock-id/validate-pin`,
      {
        data: { pin: "123456" },
      },
    );

    // Should return 404 (lock not found)
    expect(pinRes.status()).toBe(404);
  });
});

test.describe("Web UI Lock Creation", () => {
  const lockCreatePrefix = "e2e-lock-create";
  const lockCreateWorkflowId = `${lockCreatePrefix}-wf-${Date.now()}`;
  const lockCreateExecutionId = randomUUID();
  const lockCreateUserEmail = `${lockCreatePrefix}-${Date.now()}@example.com`;
  const lockCreateUserPassword = "LockCreate123!";
  let lockCreateUserId: string | undefined;

  test.beforeAll(async () => {
    const now = Date.now();

    // 1. Seed a workflow
    const graph = JSON.stringify({
      metadata: {
        name: `${lockCreatePrefix} Test Workflow`,
        version: "1.0.0",
        description: "E2E lock create test",
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "step1" } },
        {
          id: "step1",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${lockCreateWorkflowId}', 'system-admin', '${lockCreatePrefix}-wf-${now}', '${lockCreatePrefix} Test Workflow', 'E2E lock create test', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );

    // 2. Create a test user
    const result = await createTestUser(
      lockCreateUserEmail,
      lockCreateUserPassword,
      "Lock Create User",
      true,
    );
    lockCreateUserId = result.userId;
    const ownerUserId = lockCreateUserId!;

    // 3. Seed a RUNNING execution owned by the test user (no lock)
    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: lockCreateExecutionId,
      workflowId: lockCreateWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${lockCreateExecutionId}', '${lockCreateWorkflowId}', '${ownerUserId}', 'running', 'step1', '${context}', ${now}, ${now});`,
    );
  });

  test.afterAll(async () => {
    try {
      execSqliteInDocker(
        `DELETE FROM executionLock WHERE executionId = '${lockCreateExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(
        `DELETE FROM workflowExecution WHERE executionId = '${lockCreateExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${lockCreateWorkflowId}';`);
    } catch {
      /* ignore */
    }
  });

  test("Lock button visible on running execution and creates lock via dialog", async ({ page }) => {
    await login(page, lockCreateUserEmail, lockCreateUserPassword);

    // Navigate to execution
    await page.goto(`${BASE_URL}/executions/${lockCreateExecutionId}`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for inspector to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Lock button should be visible (yellow Lock icon button in toolbar)
    const lockButton = page
      .locator("button")
      .filter({ has: page.locator("svg.lucide-lock") })
      .first();
    await expect(lockButton).toBeVisible({ timeout: 5000 });

    // Click lock button opens dialog
    await lockButton.click();

    // Dialog should appear with reason input
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Type a reason
    const reasonInput = dialog.locator("input");
    await reasonInput.fill("E2E test lock reason");

    // Click Lock button in dialog
    const confirmButton = dialog.locator("button", { hasText: /Lock|Заблокировать/ }).last();
    await confirmButton.click();

    // Should show success with PIN
    await expect(dialog.getByText("PIN", { exact: true })).toBeVisible({ timeout: 5000 });

    // PIN should be displayed (6-digit code)
    const pinText = dialog.locator(".font-mono.text-2xl");
    await expect(pinText).toBeVisible();
    const pin = await pinText.textContent();
    expect(pin).toBeTruthy();
    expect(pin!.length).toBeGreaterThanOrEqual(4);

    // Close dialog (first() to avoid matching the X close icon)
    await dialog
      .locator("button", { hasText: /Close|Закрыть/ })
      .first()
      .click();

    // Status badge should now show "locked"
    const statusBadge = page.locator("text=locked");
    await expect(statusBadge).toBeVisible({ timeout: 5000 });
  });

  test("Lock creation API endpoint works for owner", async ({ page }) => {
    // Create a separate running execution for API test
    const apiExecId = randomUUID();
    const now = Date.now();
    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: apiExecId,
      workflowId: lockCreateWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${apiExecId}', '${lockCreateWorkflowId}', '${lockCreateUserId}', 'running', 'step1', '${context}', ${now}, ${now});`,
    );

    try {
      await login(page, lockCreateUserEmail, lockCreateUserPassword);

      // Call lock creation endpoint
      const lockRes = await page.request.post(`${BASE_URL}/api/executions/${apiExecId}/lock`, {
        data: { reason: "API test lock" },
      });
      expect(lockRes.ok()).toBe(true);

      const lockData = await lockRes.json();
      expect(lockData.success).toBe(true);
      expect(lockData.data.lockId).toBeTruthy();
      expect(lockData.data.pin).toBeTruthy();
      expect(lockData.data.locked).toBe(true);

      // Verify: trying to lock again should fail (already locked)
      const lockRes2 = await page.request.post(`${BASE_URL}/api/executions/${apiExecId}/lock`, {
        data: { reason: "Second lock attempt" },
      });
      expect(lockRes2.status()).toBe(400);
    } finally {
      try {
        execSqliteInDocker(`DELETE FROM executionLock WHERE executionId = '${apiExecId}';`);
      } catch {
        /* ignore */
      }
      try {
        execSqliteInDocker(`DELETE FROM workflowExecution WHERE executionId = '${apiExecId}';`);
      } catch {
        /* ignore */
      }
    }
  });

  test("Lock creation rejects request without reason", async ({ page }) => {
    const noReasonExecId = randomUUID();
    const now = Date.now();
    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: noReasonExecId,
      workflowId: lockCreateWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${noReasonExecId}', '${lockCreateWorkflowId}', '${lockCreateUserId}', 'running', 'step1', '${context}', ${now}, ${now});`,
    );

    try {
      await login(page, lockCreateUserEmail, lockCreateUserPassword);

      // Try to lock without reason
      const lockRes = await page.request.post(`${BASE_URL}/api/executions/${noReasonExecId}/lock`, {
        data: {},
      });
      expect(lockRes.status()).toBe(400);
    } finally {
      try {
        execSqliteInDocker(
          `DELETE FROM workflowExecution WHERE executionId = '${noReasonExecId}';`,
        );
      } catch {
        /* ignore */
      }
    }
  });

  test("Locked status filter works on executions page", async ({ page }) => {
    await login(page, lockCreateUserEmail, lockCreateUserPassword);

    // Navigate to executions page
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Status filter should be visible
    const statusFilter = page.locator('[data-testid="status-filter"]');
    await expect(statusFilter).toBeVisible({ timeout: 5000 });

    // Click status filter
    await statusFilter.click();

    // "Locked" option should be available
    const lockedOption = page.locator('[role="option"]', { hasText: /Locked|Заблокирован/ });
    await expect(lockedOption).toBeVisible({ timeout: 3000 });
  });
});

test.describe("Unlock Flow", () => {
  const unlockPrefix = "e2e-unlock";
  const unlockWorkflowId = `${unlockPrefix}-wf-${Date.now()}`;
  const unlockExecutionId = randomUUID();
  const unlockLockId = randomUUID();
  const unlockUserEmail = `${unlockPrefix}-${Date.now()}@example.com`;
  const unlockUserPassword = "Unlock123!";
  let unlockUserId: string | undefined;

  test.beforeAll(async () => {
    const now = Date.now();

    const graph = JSON.stringify({
      metadata: { name: `${unlockPrefix} Workflow`, version: "1.0.0", description: "E2E unlock" },
      nodes: [
        { id: "start", type: "start", connections: { default: "step1" } },
        {
          id: "step1",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${unlockWorkflowId}', 'system-admin', '${unlockPrefix}-wf-${now}', '${unlockPrefix} Workflow', 'E2E unlock', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );

    const result = await createTestUser(unlockUserEmail, unlockUserPassword, "Unlock User", true);
    unlockUserId = result.userId;

    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: unlockExecutionId,
      workflowId: unlockWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${unlockExecutionId}', '${unlockWorkflowId}', '${unlockUserId}', 'running', 'step1', '${context}', ${now}, ${now});`,
    );

    // Seed an active lock
    execSqliteInDocker(
      `INSERT INTO executionLock (id, executionId, nodeId, reason, lockedBy, status, pin, createdAt) ` +
        `VALUES ('${unlockLockId}', '${unlockExecutionId}', 'step1', 'E2E unlock test', '${unlockUserId}', 'active', '999888', ${now});`,
    );
  });

  test.afterAll(async () => {
    try {
      execSqliteInDocker(`DELETE FROM executionLock WHERE executionId = '${unlockExecutionId}';`);
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(
        `DELETE FROM workflowExecution WHERE executionId = '${unlockExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${unlockWorkflowId}';`);
    } catch {
      /* ignore */
    }
  });

  test("Owner can unlock execution via Locks tab button", async ({ page }) => {
    await login(page, unlockUserEmail, unlockUserPassword);

    await page.goto(`${BASE_URL}/executions/${unlockExecutionId}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click Locks tab
    const locksTab = page.locator('[role="tab"]', { hasText: /Locks|Блокировки/ });
    await expect(locksTab).toBeVisible();
    await locksTab.click();

    // Should see Unlock button (use exact match to avoid matching username containing "Unlock")
    const unlockButton = page.getByRole("button", { name: /^Unlock$|^Разблокировать$/ });
    await expect(unlockButton).toBeVisible({ timeout: 5000 });

    // Click Unlock
    await unlockButton.click();

    // Lock status badge changes from "active" to "unlocked"
    await expect(page.getByText("unlocked", { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test("Admin can force-unlock execution via admin inspector", async ({ page }) => {
    // Re-seed a lock for admin test (previous test may have resolved it)
    const adminLockId = randomUUID();
    const now = Date.now();
    execSqliteInDocker(
      `DELETE FROM executionLock WHERE executionId = '${unlockExecutionId}' AND status = 'active';`,
    );
    execSqliteInDocker(
      `INSERT INTO executionLock (id, executionId, nodeId, reason, lockedBy, status, pin, createdAt) ` +
        `VALUES ('${adminLockId}', '${unlockExecutionId}', 'step1', 'Admin unlock test', '${unlockUserId}', 'active', '777666', ${now});`,
    );

    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/executions/${unlockExecutionId}`);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click Locks tab
    const locksTab = page.locator('[role="tab"]', { hasText: /Locks|Блокировки/ });
    await expect(locksTab).toBeVisible();
    await locksTab.click();

    // Admin should see Unlock button
    const unlockButton = page.getByRole("button", { name: /^Unlock$|^Разблокировать$/ });
    await expect(unlockButton).toBeVisible({ timeout: 5000 });

    // Click Unlock (admin force-unlock)
    await unlockButton.click();

    // Lock status badge changes from "active" to "unlocked"
    await expect(page.getByText("unlocked", { exact: true })).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Locked Executions Widget", () => {
  const widgetPrefix = "e2e-widget";
  const widgetWorkflowId = `${widgetPrefix}-wf-${Date.now()}`;
  const widgetExecutionId = randomUUID();
  const widgetLockId = randomUUID();
  const widgetUserEmail = `${widgetPrefix}-${Date.now()}@example.com`;
  const widgetUserPassword = "Widget123!";
  let widgetUserId: string | undefined;

  test.beforeAll(async () => {
    const now = Date.now();

    const graph = JSON.stringify({
      metadata: {
        name: `${widgetPrefix} Workflow`,
        version: "1.0.0",
        description: "E2E widget",
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "step1" } },
        {
          id: "step1",
          type: "agent-directive",
          directive: "Do something",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflow (id, userId, slug, name, description, version, graph, visibility, createdAt, updatedAt) ` +
        `VALUES ('${widgetWorkflowId}', 'system-admin', '${widgetPrefix}-wf-${now}', '${widgetPrefix} Workflow', 'E2E widget', '1.0.0', '${graph}', 'public', ${now}, ${now});`,
    );

    const result = await createTestUser(widgetUserEmail, widgetUserPassword, "Widget User", true);
    widgetUserId = result.userId;

    const context = JSON.stringify({
      variables: {},
      nodeStates: {},
      executionId: widgetExecutionId,
      workflowId: widgetWorkflowId,
    }).replace(/'/g, "''");

    execSqliteInDocker(
      `INSERT INTO workflowExecution (executionId, workflowId, userId, state, currentNodeId, context, createdAt, updatedAt) ` +
        `VALUES ('${widgetExecutionId}', '${widgetWorkflowId}', '${widgetUserId}', 'running', 'step1', '${context}', ${now}, ${now});`,
    );

    // Seed an active lock so it shows in widget
    execSqliteInDocker(
      `INSERT INTO executionLock (id, executionId, nodeId, reason, lockedBy, status, pin, createdAt) ` +
        `VALUES ('${widgetLockId}', '${widgetExecutionId}', 'step1', 'Widget test lock', '${widgetUserId}', 'active', '555444', ${now});`,
    );
  });

  test.afterAll(async () => {
    try {
      execSqliteInDocker(`DELETE FROM executionLock WHERE executionId = '${widgetExecutionId}';`);
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(
        `DELETE FROM workflowExecution WHERE executionId = '${widgetExecutionId}';`,
      );
    } catch {
      /* ignore */
    }
    try {
      execSqliteInDocker(`DELETE FROM workflow WHERE id = '${widgetWorkflowId}';`);
    } catch {
      /* ignore */
    }
  });

  test("Locked executions widget shows on user executions page", async ({ page }) => {
    await login(page, widgetUserEmail, widgetUserPassword);

    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Widget should be visible
    const widget = page.locator('[data-testid="locked-executions-widget"]');
    await expect(widget).toBeVisible({ timeout: 10000 });

    // Should show at least one locked execution item
    const lockedItem = widget.locator('[data-testid="locked-execution-item"]');
    await expect(lockedItem.first()).toBeVisible({ timeout: 5000 });
  });

  test("Locked executions widget shows on admin executions page", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Widget should be visible (admin sees all locked)
    const widget = page.locator('[data-testid="locked-executions-widget"]');
    await expect(widget).toBeVisible({ timeout: 10000 });

    // Should show locked items
    const lockedItem = widget.locator('[data-testid="locked-execution-item"]');
    await expect(lockedItem.first()).toBeVisible({ timeout: 5000 });
  });
});
