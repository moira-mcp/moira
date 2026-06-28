/**
 * E2E (Step 9): the SSR storefront's no-results empty-state, total-vs-filtered count,
 * partition-aware filter chips (All / Official / Community with counts), and mobile-safe
 * cards. Anonymous (crawler/signed-out) view — these are public pages.
 *
 *   D-N11 — a no-match search shows search-specific copy + a clear link + "N results"
 *           (NOT the "No published workflows yet." catalog-empty copy / "N published").
 *   D-N8  — three chips that partition the catalog (All = Official + Community) with counts.
 *   D-N10 — cards are legible on a narrow phone with no horizontal overflow.
 *
 * The container seeds 32 official flows at startup, so the catalog is never empty here —
 * a no-results state is therefore unambiguously a no-MATCH state.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

// A community (non-official) listing so the Community partition is non-empty.
const COMMUNITY_FLOW = `E2E Community Flow ${Date.now()}`;
// A search term that matches no title/summary in the catalog.
const NO_MATCH = `zzznomatch${Date.now()}`;

test.beforeAll(async () => {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const user = {
    email: `e2e-partition-${Date.now()}@example.com`,
    password: "TestPass123!",
    name: "E2E Partition",
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  };
  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const signUpData = (await signUp.json()) as { user?: { id: string } };
  await fetch(`${BASE_URL}/api/admin/users/${signUpData.user?.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const userCookie = login.headers.get("set-cookie") || "";

  const createRes = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: COMMUNITY_FLOW, version: "1.0.0", description: "E2E community flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const createData = (await createRes.json()) as { data?: { workflowId?: string } };
  await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ workflowId: createData.data?.workflowId, category: "development" }),
  });
});

test.describe("SSR storefront partition + empty-state (Step 9)", () => {
  test("a no-match search shows the search-specific empty state, clear link, and 'results' count", async ({
    page,
  }) => {
    const res = await page.goto(`${BASE_URL}/explore?search=${NO_MATCH}`);
    expect(res?.status()).toBe(200);

    // Search-specific empty state, NOT the catalog-empty copy.
    await expect(page.locator('[data-mp="empty-search"]')).toBeVisible();
    await expect(page.locator('[data-mp="empty"]')).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("No published workflows yet.");

    // The count uses the "results" wording, not "published".
    const total = (await page.locator('[data-mp="total"]').textContent())?.trim() ?? "";
    expect(total).toMatch(/0 results/);
    expect(total).not.toMatch(/published/);

    // The clear link returns to the unfiltered catalog (which is NOT empty).
    await page.locator('[data-mp="clear-search"]').click();
    await expect(page).toHaveURL(new RegExp(`/explore$`));
    await expect(page.locator('[data-mp="card-list"]')).toBeVisible();
  });

  test("renders three partition chips (All / Official / Community) with counts that sum", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/explore`);
    const all = page.locator('[data-mp="chip-all"] [data-mp="chip-count"]');
    const official = page.locator('[data-mp="chip-official"] [data-mp="chip-count"]');
    const community = page.locator('[data-mp="chip-community"] [data-mp="chip-count"]');
    await expect(all).toBeVisible();
    await expect(official).toBeVisible();
    await expect(community).toBeVisible();

    const allN = Number((await all.textContent())?.trim());
    const officialN = Number((await official.textContent())?.trim());
    const communityN = Number((await community.textContent())?.trim());
    // Official ⊎ Community = All (a real partition, not redundant chips).
    expect(officialN + communityN).toBe(allN);
    expect(communityN).toBeGreaterThanOrEqual(1); // the community flow published in setup
  });

  test("the Community chip filters to the community partition", async ({ page }) => {
    await page.goto(`${BASE_URL}/explore`);
    await page.locator('[data-mp="chip-community"]').click();
    await expect(page).toHaveURL(/community=true/);
    await expect(page.locator('[data-mp="chip-community"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("body")).toContainText(COMMUNITY_FLOW);
  });

  test("cards are mobile-safe: no horizontal overflow at 360px and titles are not clipped", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${BASE_URL}/explore`);
    await expect(page.locator('[data-mp="card-list"]')).toBeVisible();

    // No horizontal scroll on a narrow phone (the grid drops to a single column).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // The first card's title is fully within the viewport (not cut off horizontally).
    const titleBox = await page.locator('[data-mp="listing-card"] .mp-card-title').first().boundingBox();
    expect(titleBox).not.toBeNull();
    if (titleBox) {
      expect(titleBox.x).toBeGreaterThanOrEqual(0);
      expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(360 + 1);
    }
  });
});
