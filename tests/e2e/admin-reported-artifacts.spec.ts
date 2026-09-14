/**
 * Admin Reported Artifacts E2E Tests
 * Verifies the abuse-review admin page: a reported artifact appears, and an
 * admin can take it down through the UI, after which it stops being served.
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser, getSessionCookieHeader } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

async function createArtifact(
  cookie: string,
  name: string,
): Promise<{ uuid: string; origin: string }> {
  const res = await fetch(`${FETCH_URL}/api/artifacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name,
      content: `<!DOCTYPE html><html><body><h1>${name}</h1></body></html>`,
    }),
  });
  if (!res.ok) throw new Error(`create artifact failed: ${res.status}`);
  const data = (await res.json()).data as { uuid: string; url: string };
  // Artifacts serve in subdomain-isolation mode; the API returns the per-artifact origin.
  return { uuid: data.uuid, origin: data.url.replace(/\/$/, "") };
}

test.describe("Admin Reported Artifacts Page", () => {
  const password = "ReportedTest123!";
  let email: string;
  let cookie: string;
  let uuid: string;
  let origin: string;

  test.beforeAll(async () => {
    email = `reported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const created = await createTestUser(email, password, "Reported Owner", true);
    if (!created.success) throw new Error(`user create failed: ${created.error}`);
    cookie = await getSessionCookieHeader(email, password);
    ({ uuid, origin } = await createArtifact(cookie, "abuse-ui.html"));
    // File a report so the artifact appears in the reported list (POST — the
    // report endpoint rejects GET to prevent report-bombing via prefetch/img).
    const r = await fetch(`${origin}/__report/${uuid}`, { method: "POST" });
    if (r.status !== 200) throw new Error(`report failed: ${r.status}`);
  });

  test.afterAll(async () => {
    await fetch(`${FETCH_URL}/api/artifacts/${uuid}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    }).catch(() => undefined);
  });

  test("admin sees reported artifact and can take it down via UI", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/artifacts/reported`);

    // The reported artifact card is visible
    const card = page.locator(`[data-testid="reported-artifact-${uuid}"]`);
    await expect(card).toBeVisible();

    // Servable on its own subdomain origin before takedown
    expect((await fetch(`${origin}/?ack=1`)).status).toBe(200);

    // Click takedown, confirm in dialog
    await page.locator(`[data-testid="takedown-${uuid}"]`).click();
    // ConfirmDialog confirm button
    await page.getByRole("button", { name: /take down/i }).click();

    // After takedown, the artifact stops being served on its subdomain
    await expect
      .poll(async () => (await fetch(`${origin}/?ack=1`)).status, {
        timeout: 10000,
      })
      .toBe(404);
  });
});
