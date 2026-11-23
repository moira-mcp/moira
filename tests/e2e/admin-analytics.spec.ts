import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { TEST_USERS } from "./fixtures/test-constants.js";
import { randomUUID } from "node:crypto";

const BASE_URL = getTestBaseUrl();

test.describe("Admin analytics", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("moira:analytics-exclusions:")) localStorage.removeItem(key);
      }
    });
    await page.goto(`${BASE_URL}/admin`);
    await expect(page.getByTestId("admin-scope-overview")).toBeVisible();
  });

  test("should redirect /analytics to dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/analytics`);
    await page.waitForURL(`${BASE_URL}/admin`, { timeout: 10000 });
    expect(page.url()).not.toContain("/analytics");
  });

  test("publication links survive reload and can be copied from both language layouts", async ({
    page,
    context,
  }, testInfo) => {
    const campaign = `Demo ${randomUUID().slice(0, 8)}`;
    const card = page.getByTestId("admin-card-publications");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(BASE_URL).origin,
    });
    const links: string[] = [];
    for (const [source, publication] of [
      ["Newsletter", "November digest"],
      ["Forum", "Release notes"],
    ]) {
      await card.getByRole("button", { name: "Create link" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Campaign", { exact: true }).fill(campaign);
      await dialog.getByLabel("Source", { exact: true }).fill(source);
      await dialog.getByLabel("Publication", { exact: true }).fill(publication);
      await dialog.getByRole("button", { name: "Create link" }).click();
      await dialog.getByRole("button", { name: "Copy link" }).click();
      await expect(dialog.getByRole("status")).toHaveText("Link copied");
      const url = new URL(await page.evaluate(() => navigator.clipboard.readText()));
      expect(url.origin).toBe(new URL(BASE_URL).origin);
      expect(url.pathname).toMatch(/^\/api\/public\/publications\/[a-zA-Z0-9_-]+$/);
      expect(url.search).toBe("?lang=en");
      links.push(url.href);
      await dialog.getByRole("button", { name: "Close" }).click();
    }
    expect(new Set(links).size).toBe(2);
    await page.reload();
    await card.getByRole("textbox").fill(campaign);
    await expect(card.getByRole("row")).toHaveCount(4);
    await expect(card.getByRole("row").filter({ hasText: "Newsletter" })).toContainText(
      "November digest",
    );
    await card.screenshot({ path: testInfo.outputPath("publication-desktop-en.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem("i18nextLng", "ru"));
    await page.reload();
    await card.getByRole("textbox").fill(campaign);
    await expect(card.getByRole("row")).toHaveCount(4);
    await card.screenshot({ path: testInfo.outputPath("publication-mobile-ru.png") });
    const forum = card.getByRole("row").filter({ hasText: "Forum" });
    await forum.getByRole("button", { name: "Скопировать ссылку" }).click();
    await expect(forum.getByRole("status")).toHaveText("Ссылка скопирована");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(links[1]);
  });

  test("changing one card's period leaves the other periods unchanged", async ({ page }) => {
    const overviewResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/admin/analytics/overview") &&
        url.searchParams.get("range") === "week"
      );
    });
    await page.getByTestId("admin-period-overview-week").click();
    const overview = await (await overviewResponse).json();
    expect(overview.data.scope.timeRange).toBe("week");
    expect(overview.data.scope.exclusions.mode).toBe("default-admins");
    await expect(page.getByTestId("admin-scope-overview")).toContainText("7 days");
    await expect(page.getByTestId("admin-period-active-30m")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const activeResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/admin/analytics/users") && url.searchParams.get("range") === "hour"
      );
    });
    await page.getByTestId("admin-period-active-hour").click();
    expect((await (await activeResponse).json()).data.scope.timeRange).toBe("hour");
    await expect(page.getByTestId("admin-scope-active")).toContainText("1 hour");
    await expect(page.getByTestId("admin-period-overview-week")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByTestId("admin-period-registrations-week")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("including everyone persists across reload and the default exclusions can be restored", async ({
    page,
  }) => {
    await page.getByTestId("admin-exclusions-open").click();
    await expect(page.getByTestId("admin-exclusions-default")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const included = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/admin/analytics/overview") &&
        url.searchParams.has("excludeUserIds") &&
        url.searchParams.get("excludeUserIds") === ""
      );
    });
    await page.getByTestId("admin-exclusions-all").click();
    expect((await (await included).json()).data.scope.exclusions).toEqual({
      mode: "custom",
      userIds: [],
      effectiveCount: 0,
    });
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(page.getByTestId("admin-scope-overview")).toContainText("0 excluded");
    await page.getByTestId("admin-exclusions-open").click();
    await expect(page.getByTestId("admin-exclusions-custom")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const defaults = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/admin/analytics/overview") &&
        !url.searchParams.has("excludeUserIds")
      );
    });
    await page.getByTestId("admin-exclusions-default").click();
    const scope = (await (await defaults).json()).data.scope;
    expect(scope.exclusions.mode).toBe("default-admins");
    expect(scope.exclusions.effectiveCount).toBeGreaterThan(0);
    await expect(page.getByTestId("admin-exclusions-default")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("individual exclusions affect analytics while user management includes every account", async ({
    page,
  }) => {
    await page.getByTestId("admin-exclusions-open").click();
    await page.getByTestId("admin-exclusions-custom").click();
    await page.getByTestId("admin-exclusions-search").fill(TEST_USERS.ADMIN.email);
    const checkbox = page.getByTestId(`admin-exclude-user-${TEST_USERS.ADMIN.id}`);
    await expect(checkbox).toBeVisible();
    const excluded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith("/admin/analytics/overview") &&
        url.searchParams.get("excludeUserIds") === TEST_USERS.ADMIN.id
      );
    });
    await checkbox.check();
    expect((await (await excluded).json()).data.scope.exclusions).toEqual({
      mode: "custom",
      userIds: [TEST_USERS.ADMIN.id],
      effectiveCount: 1,
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("admin-scope-active")).toContainText("1 excluded");
    await expect(page.getByTestId("admin-scope-registrations")).toContainText("1 excluded");
    await page
      .getByRole("link", { name: /Manage all users/ })
      .first()
      .click();
    await page.waitForURL(`${BASE_URL}/admin/users`);
    await page.getByTestId("user-management-search").fill(TEST_USERS.ADMIN.email);
    await expect(page.getByText(TEST_USERS.ADMIN.email, { exact: true }).first()).toBeVisible();
  });

  test("should not have Analytics link in sidebar", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).not.toContainText("Analytics");
  });

  test("a failed card read can be retried without replacing the other cards", async ({ page }) => {
    const usersRead = /\/api\/admin\/analytics\/users\?/;
    await page.route(usersRead, (route) => route.abort("failed"));
    await page.getByTestId("admin-period-active-hour").click();
    const card = page.getByTestId("admin-card-active");
    const retry = card.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByTestId("admin-scope-overview")).toContainText("30 days");
    await page.unroute(usersRead);
    await retry.click();
    await expect(page.getByTestId("admin-scope-active")).toContainText("1 hour");
    await expect(retry).not.toBeVisible();
  });

  test("mobile exclusions remain readable and usable in Russian", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => localStorage.setItem("i18nextLng", "ru"));
    await page.reload();
    await page.getByTestId("admin-exclusions-open").click();
    const dialog = page.getByTestId("admin-exclusions-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("admin-exclusions-search").fill(TEST_USERS.ADMIN.email);
    await expect(page.getByTestId(`admin-exclude-user-${TEST_USERS.ADMIN.id}`)).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      false,
    );
    await expect(dialog).not.toContainText("common.pagination.");
    await page.getByTestId("admin-exclusions-all").click();
    await expect(page.getByTestId("admin-exclusions-custom")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("admin-scope-overview")).toContainText("исключено 0");
  });
});
