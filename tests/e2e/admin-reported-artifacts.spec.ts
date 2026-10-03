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
  const artifacts: Array<{ uuid: string; origin: string }> = [];
  let available = false;

  test.beforeAll(async () => {
    const features = await fetch(`${FETCH_URL}/api/features`);
    if (!features.ok) throw new Error(`features failed: ${features.status}`);
    available = Boolean((await features.json()).data.features.multiUserAdmin);
    if (!available) return;
    email = `reported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const created = await createTestUser(email, password, "Reported Owner", true);
    if (!created.success) throw new Error(`user create failed: ${created.error}`);
    cookie = await getSessionCookieHeader(email, password);
    for (let index = 0; index < 12; index++) {
      const artifact = await createArtifact(cookie, `abuse-ui-${index}.html`);
      artifacts.push(artifact);
      // File a report so the artifact appears in the reported list (POST — the
      // report endpoint rejects GET to prevent report-bombing via prefetch/img).
      const r = await fetch(`${artifact.origin}/__report/${artifact.uuid}`, { method: "POST" });
      if (r.status !== 200) throw new Error(`report failed: ${r.status}`);
    }
    ({ uuid, origin } = artifacts[artifacts.length - 1]);
  });

  test.afterAll(async () => {
    for (const artifact of artifacts)
      await fetch(`${FETCH_URL}/api/artifacts/${artifact.uuid}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }).catch(() => undefined);
  });

  test("admin sees reported artifact and can take it down via UI", async ({ page }) => {
    await loginAsAdmin(page);
    if (!available) {
      await page.goto(`${BASE_URL}/admin/artifacts/reported?lang=en`);
      await expect(page).toHaveURL(/\/admin(?:\?[^#]*)?$/);
      return;
    }
    await page.goto(`${BASE_URL}/admin/artifacts/reported`);

    // The reported artifact card is visible
    const card = page.locator(`[data-testid="reported-artifact-${uuid}"]`);
    await expect(card).toBeVisible();

    // Servable on its own subdomain origin before takedown
    expect((await fetch(`${origin}/?ack=1`)).status).toBe(200);

    // Click takedown, confirm in dialog
    await page.locator(`[data-testid="takedown-${uuid}"]`).click();
    // ConfirmDialog confirm button
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /take down/i })
      .click();

    // After takedown, the artifact stops being served on its subdomain
    await expect
      .poll(async () => (await fetch(`${origin}/?ack=1`)).status, {
        timeout: 10000,
      })
      .toBe(404);
  });

  test("a later reported page retains its count and confirmation after a failed takedown", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1100, height: 600 });
    await page.goto(`${BASE_URL}/admin/artifacts/reported?lang=en`);
    if (!available) {
      await expect(page).toHaveURL(/\/admin(?:\?[^#]*)?$/);
      return;
    }
    await expect(page.getByTestId("pagination-next")).toBeEnabled();
    const next = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/admin/artifacts/reported" &&
        Number(url.searchParams.get("offset")) > 0
      );
    });
    await page.getByTestId("pagination-next").click();
    const response = await next;
    const data = (await response.json()).data as {
      artifacts: Array<{ uuid: string; takenDown: boolean }>;
      total: number;
    };
    expect(data.total).toBeGreaterThanOrEqual(12);
    const target = data.artifacts.find(
      (row) => !row.takenDown && artifacts.some((artifact) => artifact.uuid === row.uuid),
    );
    expect(target).toBeDefined();
    const artifact = artifacts.find((row) => row.uuid === target!.uuid)!;
    const card = page.getByTestId(`reported-artifact-${artifact.uuid}`);
    await expect(card).toBeVisible();
    const count = await page.getByTestId("reported-count").textContent();
    const pagination = page.getByTestId("data-list-pagination");
    await expect(pagination).toContainText(/2 \/ \d+/);
    const action = page.getByTestId(`takedown-${artifact.uuid}`);
    await action.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    const mountedDialog = await dialog.elementHandle();
    const pattern = `**/api/admin/artifacts/${artifact.uuid}/takedown`;
    await page.route(pattern, (route) => route.abort("failed"));
    try {
      await dialog.getByRole("button", { name: "Take down", exact: true }).click();
      await expect(page.locator('[data-sonner-toast][data-type="error"]').last()).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Take down", exact: true })).toBeEnabled();
      expect(await dialog.evaluate((node, previous) => node === previous, mountedDialog)).toBe(
        true,
      );
      await expect(pagination).toContainText(/2 \/ \d+/);
      await expect(page.getByTestId("reported-count")).toHaveText(count!);
      await expect(card).toBeVisible();
    } finally {
      await page.unroute(pattern);
    }
    await dialog.getByRole("button", { name: "Take down", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
    await expect(pagination).toContainText(/2 \/ \d+/);
    await expect.poll(async () => (await fetch(`${artifact.origin}/?ack=1`)).status).toBe(404);
  });
});
