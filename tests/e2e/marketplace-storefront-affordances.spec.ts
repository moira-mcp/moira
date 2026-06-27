/**
 * E2E: the public SSR storefront and the SPA read as ONE product (Step 21). The
 * storefront (`/explore`, `/w/:handle/:slug`, rendered by `@mcp-moira/marketplace-render`
 * and hydrated by `marketplace-hydrate`) mirrors the SPA's adopt/download/import
 * affordances and offers seamless cross-app navigation. This exercises:
 *
 *   - ADOPT: a signed-in viewer on a detail page clicks "Add to library" (adopt-btn) →
 *     the listing is installed (POST /listings/:id/install via the hydration callback) and
 *     after the reload the in-library pill replaces the button; /me/library confirms it.
 *   - DOWNLOAD: the JS-free Download link points at the public export endpoint and returns
 *     200 JSON (available to anyone; gated server-side).
 *   - OFFICIAL FILTER: the storefront's Official chip scopes /explore to the official
 *     (system-owned) listings — a community flow present under "All" is absent under
 *     Official, and the chip carries its active state.
 *   - CROSS-APP NAV: the header "Back to library" link (open-app) carries the current
 *     ?lang and lands in the SPA in that language (the SPA's i18n picks up ?lang).
 *   - ANONYMOUS: a signed-out visitor sees the Download link + the gated sign-in CTA but
 *     NO adopt button.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

const stamp = Date.now();
// A community (non-official) flow the PUBLISHER lists; the CONSUMER adopts/downloads it.
const COMMUNITY_FLOW = `E2E Storefront Flow ${stamp}`;

const PUBLISHER = {
  email: `e2e-store-pub-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Store Publisher",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};
const CONSUMER = {
  email: `e2e-store-con-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Store Consumer",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

// The community flow's public reference "handle/slug" + the listing id (for assertions).
let communityRef = "";

async function adminCookie(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  return res.headers.get("set-cookie") || "";
}

async function registerVerified(user: typeof PUBLISHER, cookie: string): Promise<void> {
  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
  const data = (await signUp.json()) as { user?: { id: string } };
  await fetch(`${BASE_URL}/api/admin/users/${data.user?.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
}

async function signIn(user: typeof PUBLISHER): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  return res.headers.get("set-cookie") || "";
}

test.beforeAll(async () => {
  const cookie = await adminCookie();
  await registerVerified(PUBLISHER, cookie);
  await registerVerified(CONSUMER, cookie);

  const pubCookie = await signIn(PUBLISHER);
  const createRes = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: pubCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: COMMUNITY_FLOW, version: "1.0.0", description: "E2E storefront flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const createData = (await createRes.json()) as { data?: { workflowId?: string } };
  const workflowId = createData.data?.workflowId;

  const publishRes = await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: pubCookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
  const publishData = (await publishRes.json()) as { data?: { startRef?: string } };
  communityRef = publishData.data?.startRef ?? "";
});

test.describe("Storefront ↔ app affordances (Step 21)", () => {
  // Suppress the beta-agreement modal deterministically for the SPA navigation legs.
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: "moira-beta-accepted",
        value: "true",
        domain: new URL(BASE_URL).hostname,
        path: "/",
      },
    ]);
  });

  test("a signed-in viewer adopts a flow from the detail page → it lands in their library", async ({
    page,
  }) => {
    expect(communityRef).not.toBe("");
    await login(page, CONSUMER.email, CONSUMER.password);

    await page.goto(`${BASE_URL}/w/${communityRef}`);
    // Wait for the hydration bundle to load + run so the adopt callback is attached.
    await page.waitForLoadState("networkidle");

    const adopt = page.locator('[data-mp="adopt-btn"]');
    await expect(adopt).toBeVisible({ timeout: 10000 });
    await adopt.click();

    // onAdopt installs the listing then reloads → the in-library pill replaces the button.
    await expect(page.locator('[data-mp="library-pill"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-mp="adopt-btn"]')).toHaveCount(0);

    // Authoritative check: the flow is now in the consumer's library (same session cookie).
    const lib = await page.request.get(`${BASE_URL}/api/marketplace/me/library`);
    expect(lib.status()).toBe(200);
    const libBody = (await lib.json()) as { data: { items: { name: string }[] } };
    expect(libBody.data.items.some((i) => i.name === COMMUNITY_FLOW)).toBe(true);
  });

  test("the Download link points at the public export endpoint and returns 200 JSON", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/w/${communityRef}`);
    const link = page.locator('[data-mp="download-link"]').first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href).toBe(`${BASE_URL}/api/public/marketplace/listings/${communityRef}/export`);

    const res = await page.request.get(href as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const body = (await res.json()) as { workflow?: { nodes?: unknown[] } };
    expect(Array.isArray(body.workflow?.nodes)).toBe(true);
  });

  test("the Official chip scopes /explore to official listings (the community flow drops out)", async ({
    page,
  }) => {
    // All view: the just-published community flow is present.
    await page.goto(`${BASE_URL}/explore`);
    await expect(page.locator(`a[href$="/w/${communityRef}"]`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-mp="chip-all"]')).toHaveAttribute("aria-pressed", "true");

    // Official view: the community flow is gone; the seeded official listings remain.
    await page.goto(`${BASE_URL}/explore?official=true`);
    await expect(page.locator('[data-mp="chip-official"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`a[href$="/w/${communityRef}"]`)).toHaveCount(0);
    // The official set is non-empty (official flows are published to the gallery on deploy).
    await expect(page.locator('[data-mp="listing-card"]').first()).toBeVisible({ timeout: 10000 });
  });

  test("the cross-app 'Back to library' link carries ?lang and lands in the SPA in that language", async ({
    page,
  }) => {
    await login(page, CONSUMER.email, CONSUMER.password);
    // Visit the storefront in Russian; the header link must carry the active language.
    await page.goto(`${BASE_URL}/explore?lang=ru`);

    const openApp = page.locator('[data-mp="open-app"]');
    await expect(openApp).toBeVisible({ timeout: 10000 });
    const href = await openApp.getAttribute("href");
    expect(href).toMatch(/\/workflows\?lang=ru$/);

    await openApp.click();
    // It lands on the SPA workflows surface (the unified library chips render there).
    await expect(page).toHaveURL(/\/workflows\?lang=ru$/);
    await expect(page.getByTestId("library-filter-chips")).toBeVisible({ timeout: 10000 });
    // The SPA's i18n picked up ?lang=ru (querystring detection → cached to localStorage).
    const lng = await page.evaluate(() => localStorage.getItem("i18nextLng"));
    expect(lng).toBe("ru");
  });

  test("an anonymous visitor sees Download + the sign-in CTA but no adopt button", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/w/${communityRef}`);
    await expect(page.locator('[data-mp="download-link"]').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-mp="signin-cta"]')).toBeVisible();
    await expect(page.locator('[data-mp="adopt-btn"]')).toHaveCount(0);
  });

  test("a signed-in viewer imports a flow from the storefront header → it lands in their library", async ({
    page,
  }) => {
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/explore`);
    // The import control is wired by the hydration bundle (header is enhanced imperatively).
    await page.waitForLoadState("networkidle");

    const importName = `E2E Storefront Import ${Date.now()}`;
    const graph = JSON.stringify({
      metadata: { name: importName, version: "1.0.0", description: "storefront import e2e" },
      nodes: [
        { id: "start", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ],
    });

    // Setting the hidden file input fires the change handler → importWorkflowFile → redirect.
    await page.locator('[data-mp="import-input"]').setInputFiles({
      name: "import.moira.json",
      mimeType: "application/json",
      buffer: Buffer.from(graph),
    });

    // On success the hydration redirects into the SPA library (?filter=mine).
    await expect(page).toHaveURL(/\/workflows\?filter=mine$/, { timeout: 15000 });

    // Authoritative check: the imported flow is now in the viewer's library.
    const lib = await page.request.get(`${BASE_URL}/api/marketplace/me/library`);
    expect(lib.status()).toBe(200);
    const libBody = (await lib.json()) as { data: { items: { name: string }[] } };
    expect(libBody.data.items.some((i) => i.name === importName)).toBe(true);
  });
});
