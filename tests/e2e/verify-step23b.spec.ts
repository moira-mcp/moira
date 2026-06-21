/**
 * Step 23b Verification: Registry Migration for Remaining Endpoints
 * Tests all 11 functions from functionality_list
 */
import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

async function apiGet(page: any, path: string) {
  const baseUrl = getTestFetchUrl();
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  const res = await page.request.get(`${baseUrl}${path}`, {
    headers: { Cookie: cookieHeader },
  });
  return res;
}

// 1. UserRepository.listAdmin() — server-side user listing
test("Admin users API returns paginated results with total", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/users?limit=5&offset=0");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.users).toBeDefined();
  expect(body.data.total).toBeGreaterThanOrEqual(1);
  expect(body.data.users.length).toBeLessThanOrEqual(5);
});

// 2. UserRepository.listAdmin() — search works server-side
test("Admin users API search filters results", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/users?search=admin");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.users.length).toBeGreaterThanOrEqual(1);
});

// 3. UserRepository.listAdmin() — sort works
test("Admin users API supports sort parameter", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/users?sort=email&sortOrder=asc");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.users).toBeDefined();
});

// 4. UserRepository.listAdmin() — includes workflowsCount
test("Admin users API includes workflowsCount", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/users?limit=5");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.data.users[0]).toHaveProperty("workflowsCount");
  expect(typeof body.data.users[0].workflowsCount).toBe("number");
});

// 5. Deleted workflows API returns paginated results
test("Deleted workflows API returns paginated results", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/workflows/deleted?limit=5&offset=0");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.workflows).toBeDefined();
  expect(typeof body.data.total).toBe("number");
});

// 6. Deleted workflows API search
test("Deleted workflows API search works", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/workflows/deleted?search=nonexistent-xyz-999");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.total).toBe(0);
  expect(body.data.workflows).toEqual([]);
});

// 7. GET /api/admin/users/:id — dependent route still works
test("Admin user detail endpoint still works", async ({ page }) => {
  await loginAsAdmin(page);
  // Get first user ID
  const listRes = await apiGet(page, "/api/admin/users?limit=1");
  const listBody = await listRes.json();
  const userId = listBody.data.users[0].id;

  const res = await apiGet(page, `/api/admin/users/${userId}`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
});

// 8. Admin panel UI loads users page
test("Admin panel users page loads correctly", async ({ page }) => {
  await loginAsAdmin(page);
  const baseUrl = getTestBaseUrl();
  await page.goto(`${baseUrl}/admin/users`);
  // Should show user management content (uses cards, not tables)
  await page.waitForLoadState("networkidle");
  // The API returns data (verified by other tests), page should render user entries
  await expect(page.getByText("User Management")).toBeVisible({ timeout: 10000 });
});

// 9. Admin panel deleted workflows page loads
test("Admin panel deleted workflows page loads", async ({ page }) => {
  await loginAsAdmin(page);
  const baseUrl = getTestBaseUrl();
  await page.goto(`${baseUrl}/admin/workflows/deleted`);
  // Page should load without errors (even if no deleted workflows exist)
  await page.waitForLoadState("networkidle");
  // No error toasts
  const errorToast = page.locator('[data-sonner-toast][data-type="error"]');
  await expect(errorToast).toHaveCount(0, { timeout: 3000 });
});

// 10. Admin executions endpoint still works (dependent)
test("Admin executions endpoint still works", async ({ page }) => {
  await loginAsAdmin(page);
  const res = await apiGet(page, "/api/admin/executions?limit=5");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.success).toBe(true);
  expect(body.data.executions).toBeDefined();
});

// 11. Workflow restore endpoint still accessible
test("Workflow restore endpoint is accessible", async ({ page }) => {
  await loginAsAdmin(page);
  // POST to restore a non-existent workflow should return 404, not 500
  const baseUrl = getTestFetchUrl();
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  const res = await page.request.post(`${baseUrl}/api/admin/workflows/nonexistent-id/restore`, {
    headers: { Cookie: cookieHeader },
  });
  // Should be 404 or similar, not 500 server error
  expect(res.status()).not.toBe(500);
});
