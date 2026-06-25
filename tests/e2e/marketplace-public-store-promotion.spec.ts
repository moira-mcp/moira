/**
 * E2E: public-store promotion gate (Step 15). Two ORTHOGONAL gates:
 *
 *   - the LOCAL marketplace feature (publish / library / local catalog) — the
 *     `marketplace` flag, off by default in self-host;
 *   - PROMOTION of the public hosted store — `publicStore.promotionEnabled`,
 *     gated only by deployment topology (this instance's origin != the store's).
 *
 * The promotion links (a "Public store" nav item + the workflows-home catalog
 * link) must show on every self-host instance in BOTH marketplace-flag states,
 * and must be SUPPRESSED on the canonical store itself. The local catalog routes
 * are gracefully absent when the local feature is off, independent of promotion.
 *
 * The live container reports the real gate (it is not the canonical store, so
 * promotion is on); the flag matrix (local-off, canonical-store) is exercised by
 * mocking GET /api/features and reloading so the FeaturesProvider re-reads it.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";
import type { FeaturesResponse } from "../../packages/web-frontend/src/types/api-types";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();
const stamp = Date.now();

const USER = {
  email: `e2e-promo-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Promo User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const MOCK_STORE_URL = "https://store.example.test";

async function adminCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  return res.headers.get("set-cookie") || "";
}

test.beforeAll(async () => {
  const cookie = await adminCookie();
  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(USER),
  });
  const data = (await signUp.json()) as { user?: { id: string } };
  await fetch(`${BASE_URL}/api/admin/users/${data.user?.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
});

/** Install a GET /api/features mock derived from the real response with overrides. */
async function mockFeatures(
  page: import("@playwright/test").Page,
  override: (real: FeaturesResponse) => FeaturesResponse,
): Promise<void> {
  const realRes = await page.request.get(`${BASE_URL}/api/features`);
  const realBody = (await realRes.json()) as { data: FeaturesResponse; success: boolean };
  const patched = override(realBody.data);
  await page.route("**/api/features", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: patched, timestamp: new Date().toISOString() }),
    });
  });
}

test.describe("Public-store promotion gate", () => {
  test("the live /api/features reports promotion ON for this (non-store) instance", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE_URL}/api/features`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: FeaturesResponse };
    expect(body.data.publicStore.promotionEnabled).toBe(true);
    expect(body.data.publicStore.url).toMatch(/^https?:\/\/.+/);
  });

  test("nav shows the 'Public store' promotion link pointing at the store URL", async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);
    await page.goto(`${BASE_URL}/workflows`);

    const realRes = await page.request.get(`${BASE_URL}/api/features`);
    const storeUrl = ((await realRes.json()) as { data: FeaturesResponse }).data.publicStore.url;

    const navLink = page.getByRole("link", { name: "Public store" });
    await expect(navLink).toBeVisible({ timeout: 10000 });
    expect(await navLink.getAttribute("href")).toBe(storeUrl);
    expect(await navLink.getAttribute("target")).toBe("_blank");
  });

  test("promotion links render with the LOCAL marketplace feature OFF; local catalog absent", async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);
    // Promotion ON but the local marketplace feature OFF (the orthogonal case).
    await mockFeatures(page, (real) => ({
      ...real,
      features: { ...real.features, marketplace: false },
      publicStore: { promotionEnabled: true, url: MOCK_STORE_URL },
    }));
    await page.goto(`${BASE_URL}/workflows`);

    // Public-store promotion link present → the store URL (external).
    const navLink = page.getByRole("link", { name: "Public store" });
    await expect(navLink).toBeVisible({ timeout: 10000 });
    expect(await navLink.getAttribute("href")).toBe(MOCK_STORE_URL);

    // Local marketplace nav item is gone (feature off) — local catalog gracefully absent.
    await expect(page.getByRole("link", { name: "Marketplace" })).toHaveCount(0);

    // The home catalog link is the promo affordance → the store, opened externally.
    const browse = page.getByTestId("browse-catalog-link");
    await expect(browse).toBeVisible();
    expect(await browse.getAttribute("href")).toBe(MOCK_STORE_URL);
    expect(await browse.getAttribute("target")).toBe("_blank");
  });

  test("on the canonical store, promotion links are suppressed and the catalog stays local", async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);
    // The instance IS the store → promotion suppressed, local marketplace on.
    await mockFeatures(page, (real) => ({
      ...real,
      features: { ...real.features, marketplace: true },
      publicStore: { promotionEnabled: false, url: MOCK_STORE_URL },
    }));
    await page.goto(`${BASE_URL}/workflows`);

    // No self-promotion nav link.
    await expect(page.getByRole("link", { name: "Public store" })).toHaveCount(0);

    // The home catalog link falls back to the LOCAL root catalog path.
    const browse = page.getByTestId("browse-catalog-link");
    await expect(browse).toBeVisible();
    expect(await browse.getAttribute("href")).toBe("/explore");
    expect(await browse.getAttribute("target")).toBeNull();
  });
});
