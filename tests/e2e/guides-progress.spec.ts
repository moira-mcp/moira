/**
 * E2E: what the guides remember about a reader, as the reader meets it.
 *
 * The first-run prompt appears once for a new account, after the beta agreement where the
 * deployment asks it; "Later" asks again in a new session, "No thanks" holds in a new browser.
 * Closing a guide keeps the place, and "Show me around" resumes there after a reload and from
 * another browser — which only a server-side store can do. A step whose revision rose since the
 * reader saw it raises a dot on "What is this?", and opening it runs exactly that step. "Forget
 * what I have seen" brings the prompt back.
 *
 * Every test signs in as a fresh user, so no other spec meets a prompt or progress it did not make.
 */

import { test, expect, type Browser, type Page } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";
const PROGRESS_KEY = "ui.guide_progress";

async function freshUser(label: string): Promise<string> {
  const email = `guides-progress-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await createTestUser(email, PASSWORD, `Guides ${label}`);
  expect(created.success).toBe(true);
  return email;
}

/** A second browser, signed in as the same user: none of the first browser's storage. */
async function inNewBrowser(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, PASSWORD);
  return page;
}

/** Wait for the progress save a click makes; leaving before it lands would lose it. */
async function clickAndSave(page: Page, testId: string): Promise<void> {
  const save = page.waitForResponse(
    (response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT",
  );
  await page.getByTestId(testId).click();
  expect((await save).ok()).toBe(true);
}

async function storedProgress(page: Page): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${BASE_URL}/api/settings/ui`);
  return ((await response.json()) as { data: Record<string, Record<string, unknown>> }).data[
    PROGRESS_KEY
  ];
}

const prompt = (page: Page) => page.getByTestId("first-run-prompt");

/** The reader's guide progress has been read: an absent prompt is then an answer, not a delay. */
async function progressLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId("show-me-around")).toHaveAttribute("data-progress", "loaded");
}

test.describe("Guide progress", () => {
  test('a new account is asked once; "No thanks" holds after a reload and in a new browser', async ({
    page,
    browser,
  }) => {
    const email = await freshUser("once");
    await login(page, email, PASSWORD);
    await expect(prompt(page)).toBeVisible();

    await clickAndSave(page, "first-run-decline");
    await expect(prompt(page)).toHaveCount(0);
    expect((await storedProgress(page)).firstRun).toBe("declined");

    await page.reload();
    await expect(page.getByTestId("work-area")).toBeVisible();
    await progressLoaded(page);
    await expect(prompt(page)).toHaveCount(0);

    const other = await inNewBrowser(browser, email);
    await expect(other.getByTestId("work-area")).toBeVisible();
    await progressLoaded(other);
    await expect(prompt(other)).toHaveCount(0);
    await other.context().close();
  });

  test("with beta notices on, the prompt waits until the agreement is answered", async ({
    page,
  }) => {
    // The deployment asks the beta agreement when its features say `betaNotices` (saas). Both the
    // agreement and the prompt are decided in the browser from that answer, so serving it here is
    // the saas reader's situation on any deployment.
    await page.route("**/api/features", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { data: { features: Record<string, boolean> } };
      body.data.features.betaNotices = true;
      await route.fulfill({ response, json: body });
    });
    const email = await freshUser("beta");
    await login(page, email, PASSWORD, false);

    const accept = page.getByRole("button", { name: "Accept and Continue" });
    await expect(accept).toBeVisible();
    await expect(page.getByTestId("work-area")).toBeVisible();
    await progressLoaded(page);
    await expect(prompt(page)).toHaveCount(0);

    await accept.click();
    await expect(prompt(page)).toBeVisible();
  });

  test('"Later" asks again in a new session', async ({ page, browser }) => {
    const email = await freshUser("later");
    await login(page, email, PASSWORD);
    await page.getByTestId("first-run-later").click();
    await expect(prompt(page)).toHaveCount(0);
    // The same session: still later.
    await page.reload();
    await expect(page.getByTestId("work-area")).toBeVisible();
    await progressLoaded(page);
    await expect(prompt(page)).toHaveCount(0);
    expect((await storedProgress(page)).firstRun).toBeUndefined();

    const other = await inNewBrowser(browser, email);
    await expect(prompt(other)).toBeVisible();
    await other.context().close();
  });

  test('"Show me around" opens the guides menu', async ({ page }) => {
    const email = await freshUser("accept");
    await login(page, email, PASSWORD);
    await clickAndSave(page, "first-run-accept");
    await expect(page.getByTestId("show-me-around-menu")).toBeInViewport();
    // Home has no screen tour yet; the menu says so rather than offering nothing.
    await expect(page.getByTestId("show-me-around-no-tour")).toBeVisible();
    expect((await storedProgress(page)).firstRun).toBe("accepted");
  });

  test("closing keeps the place; the menu resumes it after a reload and from another browser", async ({
    page,
    browser,
  }) => {
    const email = await freshUser("resume");
    await login(page, email, PASSWORD);
    await page.goto(`${BASE_URL}/settings`);
    await page.getByTestId("guide-open").first().click();
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "nav");
    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "account");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings") && response.request().method() === "PUT",
    );
    await page.getByTestId("guide-next").click();
    await expect(card).toHaveAttribute("data-guide-step", "security");
    await saved;
    await expect
      .poll(async () => (await storedProgress(page)).resume)
      .toEqual({ guide: "settings", step: "security", path: "/settings" });
    await page.getByTestId("guide-close").click();
    await expect(card).toHaveCount(0);

    for (const reader of [page, await inNewBrowser(browser, email)]) {
      await reader.goto(`${BASE_URL}/`);
      await reader.getByTestId("show-me-around").click();
      // Two of eight steps walked: the tour is in progress, not seen.
      await expect(
        reader.locator('[data-testid="show-me-around-screens"] [data-guide-id="settings"]'),
      ).toHaveAttribute("data-status", "started");
      await reader.getByTestId("show-me-around-resume").click();
      await expect(reader).toHaveURL(/\/settings\?guide=settings&step=security/);
      await expect(reader.getByTestId("guide-card")).toHaveAttribute("data-guide-step", "security");
      if (reader !== page) await reader.context().close();
    }
  });

  test("a step whose revision rose shows only the dot, and opening it runs exactly that step", async ({
    page,
  }) => {
    const email = await freshUser("dot");
    await login(page, email, PASSWORD);
    // The reader walked the Settings tour, and saw its security step at an earlier revision: the
    // state a raised revision leaves every reader who saw the step before.
    const steps = [
      "nav",
      "account",
      "security",
      "notifications",
      "github",
      "apps",
      "tokens",
      "preferences",
    ];
    const seen = Object.fromEntries(
      steps.map((id) => [`settings.${id}`, id === "security" ? 0 : 1]),
    );
    const put = await page.request.put(`${BASE_URL}/api/settings`, {
      data: { [PROGRESS_KEY]: { firstRun: "declined", seen } },
    });
    expect(put.ok()).toBe(true);

    await page.goto(`${BASE_URL}/settings`);
    const button = page.getByTestId("guide-open").first();
    await expect(button).toHaveAttribute("data-new-steps", "1");
    await expect(page.getByTestId("guide-new-dot")).toBeVisible();
    // Only the dot: nothing opened by itself.
    await expect(page.getByTestId("guide-card")).toHaveCount(0);

    await button.click();
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "security");
    await expect(card).toContainText("1/1");
    await expect(page.getByTestId("guide-whole-tour")).toBeVisible();
    await page.getByTestId("guide-finish").click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("guide-new-dot")).toHaveCount(0);
  });

  test("a step added to a tour the reader finished raises the dot, and opening it runs that step", async ({
    page,
  }) => {
    const email = await freshUser("added");
    await login(page, email, PASSWORD);
    // The reader walked the Settings tour to its end before its preferences step existed.
    const earlier = ["nav", "account", "security", "notifications", "github", "apps", "tokens"];
    const seen = Object.fromEntries(earlier.map((id) => [`settings.${id}`, 1]));
    const put = await page.request.put(`${BASE_URL}/api/settings`, {
      data: { [PROGRESS_KEY]: { firstRun: "declined", seen, finished: { settings: true } } },
    });
    expect(put.ok()).toBe(true);

    await page.goto(`${BASE_URL}/settings`);
    const button = page.getByTestId("guide-open").first();
    await expect(button).toHaveAttribute("data-new-steps", "1");
    await page.getByTestId("show-me-around").click();
    await expect(
      page.locator('[data-testid="show-me-around-screens"] [data-guide-id="settings"]'),
    ).toHaveAttribute("data-status", "new");
    await page.keyboard.press("Escape");

    await button.click();
    const card = page.getByTestId("guide-card");
    await expect(card).toHaveAttribute("data-guide-step", "preferences");
    await expect(card).toContainText("1/1");
  });

  test('"Forget what I have seen" brings the prompt back', async ({ page }) => {
    const email = await freshUser("forget");
    await login(page, email, PASSWORD);
    await clickAndSave(page, "first-run-decline");
    await expect(prompt(page)).toHaveCount(0);

    await page.goto(`${BASE_URL}/settings#preferences`);
    await clickAndSave(page, "preferences-guides-forget");
    expect((await storedProgress(page)).firstRun).toBeUndefined();

    await page.goto(`${BASE_URL}/`);
    await expect(prompt(page)).toBeVisible();
  });

  test("on a phone the guides menu opens in the sidebar sheet", async ({ page }) => {
    const email = await freshUser("phone");
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, email, PASSWORD);
    await clickAndSave(page, "first-run-accept");
    const sheet = page.locator('[data-mobile="true"]');
    await expect(sheet).toBeVisible();
    // The sheet takes focus as it finishes opening; the menu must still be open once it has.
    await sheet.evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished)),
    );
    const menu = page.getByTestId("show-me-around-menu");
    await expect(menu).toBeInViewport();
    await expect(menu.getByTestId("show-me-around-no-tour")).toBeVisible();
  });
});
