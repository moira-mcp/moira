import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test("deleted workflow dates reset a later page and preserve accepted rows and focus through a failed read", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const features = (await (await page.request.get(`${BASE_URL}/api/features`)).json()).data
    .features;
  if (!features.multiUserAdmin) {
    await page.goto(`${BASE_URL}/admin/deleted-workflows?lang=en`);
    await expect(page).toHaveURL(/\/admin(?:\?[^#]*)?$/);
    return;
  }
  await page.setViewportSize({ width: 1100, height: 600 });
  const prefix = `Region deleted ${Date.now()}-${test.info().workerIndex}`;
  const ids: string[] = [];
  try {
    for (let index = 0; index < 12; index++) {
      const copied = await page.request.post(`${BASE_URL}/api/workflows/moira/quick-task/copy`, {
        data: { newName: `${prefix} ${index}` },
      });
      expect(copied.status()).toBe(200);
      const id = (await copied.json()).data.workflowId as string;
      ids.push(id);
      expect((await page.request.delete(`${BASE_URL}/api/workflows/${id}`)).status()).toBe(200);
    }
    await page.goto(`${BASE_URL}/admin/deleted-workflows?lang=en`);
    await page.getByTestId("deleted-workflows-search").fill(prefix);
    const pagination = page.getByTestId("data-list-pagination");
    await expect(pagination).toContainText(/of 12/);
    await expect(page.getByTestId("pagination-next")).toBeEnabled();
    const next = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/admin/workflows/deleted" &&
        Number(url.searchParams.get("offset")) > 0
      );
    });
    await page.getByTestId("pagination-next").click();
    expect((await (await next).json()).data.total).toBe(12);
    await expect(pagination).toContainText(/2 \/ \d+/);
    const accepted = await page.getByTestId("deleted-workflow-card").first().elementHandle();
    const from = page.getByLabel("From", { exact: true });
    const date = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pattern = "**/api/admin/workflows/deleted?**";
    await page.route(pattern, async (route) => {
      if (new URL(route.request().url()).searchParams.has("fromDate")) {
        started();
        await gate;
        await route.abort("failed");
      } else await route.continue();
    });
    try {
      await from.fill(date);
      await from.focus();
      await begun;
      await expect(from).toBeFocused();
      await expect(from).toHaveValue(date);
      await expect(pagination).toContainText(/2 \/ \d+/);
      expect(
        await page
          .getByTestId("deleted-workflow-card")
          .first()
          .evaluate((node, previous) => node === previous, accepted),
      ).toBe(true);
      release();
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(from).toBeFocused();
    } finally {
      release();
      await page.unroute(pattern);
    }
    const retried = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/admin/workflows/deleted" && url.searchParams.has("fromDate");
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    const response = await retried;
    const url = new URL(response.url());
    const acceptedPage = (await response.json()).data;
    expect(acceptedPage.offset).toBe(0);
    expect(Number(url.searchParams.get("fromDate"))).toBe(
      await page.evaluate((day) => new Date(`${day}T00:00:00`).getTime(), date),
    );
    expect(acceptedPage.total).toBe(12);
    await expect(pagination).toContainText(/1 \/ \d+/);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  } finally {
    for (const id of ids) {
      await page.request.delete(`${BASE_URL}/api/admin/workflows/${id}/hard-delete`);
    }
  }
});

test("operational filtering leaves business sources alone and a failed business refresh retries locally", async ({
  page,
}) => {
  await loginAsAdmin(page);
  const features = (await (await page.request.get(`${BASE_URL}/api/features`)).json()).data
    .features;
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/admin/analytics/")) requests.push(url.pathname);
  });
  await page.goto(`${BASE_URL}/admin/operational?lang=en`);
  if (!features.adminOperations) {
    await expect(page).toHaveURL(/\/admin(?:\?[^#]*)?$/);
    expect(requests).toEqual([]);
    return;
  }
  await expect(page.getByTestId("operational-region")).toHaveAttribute("aria-busy", "false");
  if (features.adminAnalytics) {
    for (const id of ["conversion-region", "engagement-region", "top-workflows-region"])
      await expect(page.getByTestId(id)).toHaveAttribute("aria-busy", "false");
  }
  const business = () => requests.filter((path) => !path.endsWith("/operational"));
  const beforeFilter = business().length;
  const filtered = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith("/analytics/operational") && Boolean(url.searchParams.get("source"))
    );
  });
  await page.getByTestId("filter-source").click();
  // Choose a source from the server's real breakdown, after the unfiltered choice.
  const source = page.getByRole("option").nth(1);
  await expect(source).toBeVisible();
  const sourceLabel = (await source.textContent())!.trim();
  await source.click();
  expect((await filtered).status()).toBe(200);
  await expect(page.getByTestId("operational-region")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("filter-source")).toContainText(sourceLabel);
  expect(business()).toHaveLength(beforeFilter);
  const beforeChart = requests.length;
  await page.getByTestId("chart-type-bar").click();
  await expect(page.getByTestId("chart-type-bar")).toHaveClass(/bg-primary/);
  expect(requests).toHaveLength(beforeChart);
  if (!features.adminAnalytics) return;
  let fail = true;
  const pattern = "**/api/admin/analytics/conversion-funnel?**";
  await page.route(pattern, (route) => (fail ? route.abort("failed") : route.continue()));
  try {
    const region = page.getByTestId("conversion-region");
    const retained = await region.elementHandle();
    await page.getByTestId("refresh-button").click();
    await expect(region.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    expect(await region.evaluate((node, previous) => node === previous, retained)).toBe(true);
    await expect(page.getByTestId("operational-region")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("engagement-region")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByTestId("top-workflows-region")).toHaveAttribute("aria-busy", "false");
    const beforeRetry = requests.length;
    fail = false;
    await region.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(region.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(requests.slice(beforeRetry)).toEqual(["/api/admin/analytics/conversion-funnel"]);
  } finally {
    await page.unroute(pattern);
  }
});
