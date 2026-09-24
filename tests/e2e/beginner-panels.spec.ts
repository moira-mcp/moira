/**
 * E2E: the beginner panels can be hidden for good — from the panel itself, in one click — and
 * brought back in Settings. Hidden is the account's choice: it survives a reload and a sign-in from
 * a new browser, which is what tells a server-side store apart from one kept in the browser. The flow
 * list's fold is the browser's own and is not the same thing as hiding.
 *
 * Every test signs in as a fresh user, so no other spec sees a panel it expects hidden.
 */

import { test, expect, type Browser, type Locator, type Page } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const PASSWORD = "TestPass123!";

async function freshUser(label: string): Promise<string> {
  const email = `beginner-panels-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const created = await createTestUser(email, PASSWORD, `Panels ${label}`);
  expect(created.success).toBe(true);
  return email;
}

/** A second browser, signed in as the same user: nothing of the first browser's storage. */
async function inNewBrowser(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, PASSWORD);
  return page;
}

/**
 * A hide or show is on screen at once and saved in the background; leaving the page before the save
 * lands would lose it. Click, then wait for the settings save it triggers.
 */
async function clickAndSave(page: Page, target: Locator): Promise<void> {
  const save = page.waitForResponse(
    (response) => response.url().endsWith("/api/settings") && response.request().method() === "PUT",
  );
  await target.click();
  expect((await save).ok()).toBe(true);
}

const panel = (page: Page, id: string) =>
  page.locator(`[data-testid="hide-panel"][data-panel="${id}"]`);

test.describe("Beginner panels", () => {
  test("each home panel hides from the panel and stays hidden after a reload and in a new browser", async ({
    page,
    browser,
  }) => {
    const email = await freshUser("home");
    await login(page, email, PASSWORD);

    await expect(page.getByTestId("home-how-it-works")).toBeVisible();
    await expect(page.getByTestId("quick-start-card")).toBeVisible();
    await expect(page.getByTestId("recommended-flows")).toBeVisible();

    await clickAndSave(page, panel(page, "home-intro"));
    await expect(page.getByTestId("home-how-it-works")).toHaveCount(0);
    await clickAndSave(page, panel(page, "quick-start"));
    await expect(page.getByTestId("quick-start-card")).toHaveCount(0);
    await clickAndSave(page, panel(page, "home-recommended"));
    await expect(page.getByTestId("recommended-flows")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("work-area")).toBeVisible();
    await expect(page.getByTestId("home-how-it-works")).toHaveCount(0);
    await expect(page.getByTestId("quick-start-card")).toHaveCount(0);
    await expect(page.getByTestId("recommended-flows")).toHaveCount(0);

    const other = await inNewBrowser(browser, email);
    await expect(other.getByTestId("work-area")).toBeVisible();
    await expect(other.getByTestId("home-how-it-works")).toHaveCount(0);
    await expect(other.getByTestId("quick-start-card")).toHaveCount(0);
    await other.context().close();
  });

  test("the notice after hiding brings the panel back", async ({ page }) => {
    const email = await freshUser("undo");
    await login(page, email, PASSWORD);

    await clickAndSave(page, panel(page, "home-intro"));
    await expect(page.getByTestId("home-how-it-works")).toHaveCount(0);
    await clickAndSave(page, page.locator("[data-sonner-toast] [data-button]"));
    await expect(page.getByTestId("home-how-it-works")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("home-how-it-works")).toBeVisible();
  });

  test("Settings lists the panels and shows a hidden one again", async ({ page }) => {
    const email = await freshUser("settings");
    await login(page, email, PASSWORD);
    await clickAndSave(page, panel(page, "quick-start"));
    await expect(page.getByTestId("quick-start-card")).toHaveCount(0);

    await page.goto(`${BASE_URL}/settings#preferences`);
    const group = page.getByTestId("preferences-beginner-panels");
    const switches = group.getByTestId("beginner-panel-switch");
    await expect(switches).toHaveCount(6);
    await expect(group.locator('[data-panel="quick-start"]')).toHaveAttribute(
      "data-state",
      "unchecked",
    );
    await expect(group.locator('[data-panel="home-intro"]')).toHaveAttribute(
      "data-state",
      "checked",
    );

    await clickAndSave(page, group.locator('[data-panel="quick-start"]'));
    await expect(group.locator('[data-panel="quick-start"]')).toHaveAttribute(
      "data-state",
      "checked",
    );

    await page.goto(`${BASE_URL}/`);
    await expect(page.getByTestId("quick-start-card")).toBeVisible();
  });

  test("the flow page's variables hint hides for the account from its close button", async ({
    page,
  }) => {
    const email = await freshUser("registry");
    await login(page, email, PASSWORD);
    const openVariables = async () => {
      await page.goto(`${BASE_URL}/workflows/moira/quick-task`);
      await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
      await expect(page.getByTestId("registry-panel")).toBeVisible();
    };

    await openVariables();
    await expect(page.getByTestId("guidance-registry")).toBeVisible();
    await clickAndSave(page, panel(page, "registry-guide"));
    await expect(page.getByTestId("guidance-registry")).toHaveCount(0);

    await openVariables();
    await expect(page.getByTestId("guidance-registry")).toHaveCount(0);
  });

  test("on the flow list the fold is this browser's and the hide is the account's", async ({
    page,
    browser,
  }) => {
    const email = await freshUser("workflows");
    await login(page, email, PASSWORD);
    await page.goto(`${BASE_URL}/workflows`);
    const section = page.getByTestId("recommended-flows");
    await expect(section).toHaveAttribute("data-state", "open");

    await section.getByTestId("recommended-toggle").click();
    await expect(section).toHaveAttribute("data-state", "closed");
    const folded = await inNewBrowser(browser, email);
    await folded.goto(`${BASE_URL}/workflows`);
    await expect(folded.getByTestId("recommended-flows")).toHaveAttribute("data-state", "open");
    await folded.context().close();

    await clickAndSave(page, panel(page, "workflows-recommended"));
    await expect(page.getByTestId("recommended-flows")).toHaveCount(0);
    const hidden = await inNewBrowser(browser, email);
    await hidden.goto(`${BASE_URL}/workflows`);
    await expect(hidden.getByTestId("workflow-card").first()).toBeVisible();
    await expect(hidden.getByTestId("recommended-flows")).toHaveCount(0);
    await hidden.context().close();
  });
});
