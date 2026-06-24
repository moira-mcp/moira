/**
 * E2E: the marketplace SPA renders correct localization. With ?lang=ru the gallery,
 * detail, and My Listings show translated enum labels (category → "Разработка",
 * status → "Опубликован") and grammatically correct Russian CLDR plural counts
 * (install/step declensions), with no raw enum strings leaking through. Guards the
 * Step-9 pluralization/declension utility + locale wiring against regressions.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

const stamp = Date.now();
const FLOW_NAME = `i18n E2E Flow ${stamp}`;
const USER = {
  email: `e2e-i18n-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E i18n",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

test.beforeAll(async () => {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(USER),
  });
  const uid = ((await signUp.json()) as { user?: { id: string } }).user?.id;
  await fetch(`${BASE_URL}/api/admin/users/${uid}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: USER.email, password: USER.password }),
  });
  const cookie = loginRes.headers.get("set-cookie") || "";
  // A 2-node flow published under the "development" category → RU "Разработка" + "2 шага".
  const created = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "i18n e2e flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const workflowId = ((await created.json()) as { data?: { workflowId?: string } }).data
    ?.workflowId;
  await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
});

test.describe("Marketplace i18n (RU)", () => {
  test("renders translated enums and Russian plural declensions, no raw enum strings", async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);

    // RU gallery: localized category + RU install declension, no raw "development".
    await page.goto(`${BASE_URL}/marketplace?lang=ru`);
    await page.getByLabel(/Поиск|Search/).fill(FLOW_NAME);
    await page.getByRole("button", { name: /Найти|Search/ }).click();
    await expect(page.getByRole("link", { name: FLOW_NAME })).toBeVisible({ timeout: 10000 });

    const galleryText = await page.locator("body").innerText();
    expect(galleryText).toContain("Разработка"); // category localized
    expect(galleryText).toMatch(/установок|установк/); // RU install declension
    expect(galleryText).not.toMatch(/\bdevelopment\b/); // no raw enum

    // RU detail: 2-node flow → "2 шага" (RU few-form), category localized.
    await page.getByRole("link", { name: FLOW_NAME }).click();
    await expect(page.getByRole("heading", { name: FLOW_NAME })).toBeVisible({ timeout: 10000 });
    const detailText = await page.locator("body").innerText();
    expect(detailText).toContain("2 шага");
    expect(detailText).toContain("Разработка");

    // RU My Listings: status localized, no raw "listed".
    await page.goto(`${BASE_URL}/marketplace/my-listings?lang=ru`);
    await expect(page.getByText(FLOW_NAME).first()).toBeVisible({ timeout: 10000 });
    const listingsText = await page.locator("body").innerText();
    expect(listingsText).toContain("Опубликован");
    expect(listingsText).not.toMatch(/\blisted\b/);
  });
});
