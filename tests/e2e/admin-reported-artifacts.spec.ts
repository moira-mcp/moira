/**
 * Admin Reported Artifacts E2E Tests
 * Verifies the abuse-review admin page: a reported artifact appears, and an
 * admin can take it down through the UI, after which it stops being served.
 */

import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin, createTestUser, getSessionCookieHeader } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

/** The initial inventory can shrink once the list measures its real rows. */
async function reportedPage(page: Page) {
  const list = page.getByTestId("data-list-items");
  const region = list.locator("..");
  await expect(region).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      list.evaluate((element) => {
        const cards = element.querySelectorAll('[data-testid^="reported-artifact-"]');
        const last = cards.item(cards.length - 1);
        return (
          last !== null &&
          last.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1
        );
      }),
    )
    .toBe(true);
  await expect(region).toHaveAttribute("aria-busy", "false");
  const indicator = page.getByTestId("data-list-pagination").getByText(/^\d+ \/ \d+$/);
  const current = (await indicator.count())
    ? Number((await indicator.innerText()).split("/")[0])
    : 1;
  return { list, current };
}

async function nextReportedPage(page: Page, current: number) {
  await expect(page.getByTestId("pagination-next")).toBeEnabled();
  const response = page.waitForResponse((result) => {
    const url = new URL(result.url());
    return (
      url.pathname === "/api/admin/artifacts/reported" && Number(url.searchParams.get("offset")) > 0
    );
  });
  await page.getByTestId("pagination-next").click();
  const next = await response;
  expect(next.status()).toBe(200);
  await expect(
    page.getByTestId("data-list-pagination").getByText(new RegExp(`^${current + 1} / \\d+$`)),
  ).toBeVisible();
  return (await next.json()).data as {
    artifacts: Array<{ uuid: string; takenDown: boolean }>;
    total: number;
  };
}

/** Search only the fixture's exact identities through the application's own pagination. */
async function findReportedArtifact(page: Page, ownUuids: string[], minimumPage = 1) {
  for (;;) {
    const { list, current } = await reportedPage(page);
    if (current >= minimumPage) {
      for (const uuid of ownUuids) {
        const card = list.getByTestId(`reported-artifact-${uuid}`);
        if ((await card.count()) && (await card.getByTestId(`takedown-${uuid}`).isEnabled())) {
          await expect(card).toBeVisible();
          return { uuid, current };
        }
      }
    }
    const data = await nextReportedPage(page, current);
    expect(data.total).toBeGreaterThanOrEqual(12);
  }
}

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

    await findReportedArtifact(page, [uuid]);
    // The exact reported artifact is visible on its actual measured page.
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
    const target = await findReportedArtifact(
      page,
      artifacts.map((artifact) => artifact.uuid),
      2,
    );
    const artifact = artifacts.find((row) => row.uuid === target.uuid)!;
    const card = page.getByTestId(`reported-artifact-${artifact.uuid}`);
    await expect(card).toBeVisible();
    const count = await page.getByTestId("reported-count").textContent();
    const pagination = page.getByTestId("data-list-pagination");
    const pageIndicator = pagination.getByText(new RegExp(`^${target.current} / \\d+$`));
    await expect(pageIndicator).toBeVisible();
    expect((await fetch(`${artifact.origin}/?ack=1`)).status).toBe(200);
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
      await expect(pageIndicator).toBeVisible();
      await expect(page.getByTestId("reported-count")).toHaveText(count!);
      await expect(card).toBeVisible();
      expect((await fetch(`${artifact.origin}/?ack=1`)).status).toBe(200);
    } finally {
      await page.unroute(pattern);
    }
    await dialog.getByRole("button", { name: "Take down", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
    await expect(pageIndicator).toBeVisible();
    await expect.poll(async () => (await fetch(`${artifact.origin}/?ack=1`)).status).toBe(404);
  });
});
