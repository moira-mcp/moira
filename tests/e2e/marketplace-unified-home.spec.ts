/**
 * E2E: the unified Workflows home (Step 20). The standalone "Workflows" management view
 * and the marketplace "My Library" are merged into ONE filterable "Your library" surface
 * at /workflows. The old origin TABS (Mine/Added/Shared/Core) are replaced by filter
 * CHIPS (All / Official / Added / Mine / Shared, ?filter=...). This exercises:
 *
 *   - one library surface with a `library-filter-chips` row whose chips scope the list;
 *   - official flows (the seeded base flows) carry an `official-badge` and appear under
 *     the Official filter;
 *   - the MCP-first run hint is present and shows no start()/developer code;
 *   - the Mine filter empty state offers the import + browse-catalog adoption affordances;
 *   - publish-from-an-own-card: a Mine card's Publish action opens the publish form
 *     PRE-FILLED, publishing creates a listing, and the card then offers a "View on
 *     marketplace" link that resolves to the PUBLIC /w/:handle/:slug page;
 *   - an Added entry links to its public source listing (`added-source-link`);
 *   - the old /marketplace/library route redirects into the home (?filter=added).
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

const stamp = Date.now();
// PUBLISHED flow (publisher publishes it in setup; the consumer adds it by reference).
const PUBLISHED_FLOW = `E2E Home Published ${stamp}`;
// DRAFT flow (unpublished) — published THROUGH the Mine card's Publish action in the test.
const DRAFT_FLOW = `E2E Home Draft ${stamp}`;

const PUBLISHER = {
  email: `e2e-home-pub-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Home Publisher",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};
const CONSUMER = {
  email: `e2e-home-con-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Home Consumer",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

// The published flow's public reference "handle/slug" and the publisher handle.
let publishedRef = "";
let publisherHandle = "";

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

async function createWorkflow(cookie: string, name: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name, version: "1.0.0", description: "E2E unified home flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const data = (await res.json()) as { data?: { workflowId?: string } };
  return data.data?.workflowId ?? "";
}

test.beforeAll(async () => {
  const cookie = await adminCookie();
  await registerVerified(PUBLISHER, cookie);
  await registerVerified(CONSUMER, cookie);

  const pubCookie = await signIn(PUBLISHER);

  // Publisher owns a published flow (added by the consumer) and a draft flow (published
  // through the UI in the test below).
  const publishedWorkflowId = await createWorkflow(pubCookie, PUBLISHED_FLOW);
  await createWorkflow(pubCookie, DRAFT_FLOW);

  const publishRes = await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: pubCookie },
    body: JSON.stringify({ workflowId: publishedWorkflowId, category: "development" }),
  });
  const publishData = (await publishRes.json()) as {
    data?: { listing?: { id?: string }; startRef?: string; ownerHandle?: string };
  };
  publishedRef = publishData.data?.startRef ?? "";
  publisherHandle = publishData.data?.ownerHandle ?? "";
  const listingId = publishData.data?.listing?.id ?? "";

  // The consumer ADDS the published flow by reference → it lands in their "added" source.
  const conCookie = await signIn(CONSUMER);
  await fetch(`${BASE_URL}/api/marketplace/listings/${listingId}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: conCookie },
    body: "{}",
  });
});

test.describe("Unified Workflows home (Your library)", () => {
  // Suppress the beta-agreement modal deterministically: without it the modal can race
  // the second navigation (login → goto /workflows) and intercept the surface, so an
  // assertion catches a transitional re-render. Set the accept cookie before each test.
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

  test("one library surface with filter chips; chips scope the list", async ({ page }) => {
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows`);

    // The single surface: chip row, no origin tabs.
    const chips = page.getByTestId("library-filter-chips");
    await expect(chips).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("origin-tab-mine")).toHaveCount(0);
    for (const key of ["all", "official", "added", "mine", "shared"]) {
      await expect(page.getByTestId(`library-chip-${key}`)).toBeVisible();
    }

    // Default filter is "all": the publisher's own draft flow is listed. Use .first() on the
    // presence locators: the library renders each flow exactly once (verified via the API +
    // repeated DOM loads), but under heavy parallel e2e load a brief route-transition overlap
    // can momentarily yield two matches, which strict mode would reject on a pure presence check.
    await expect(page.getByTestId("library-chip-all")).toHaveAttribute("aria-pressed", "true");
    const draftCard = page.getByTestId("flow-card").filter({ hasText: DRAFT_FLOW }).first();
    await expect(draftCard).toBeVisible({ timeout: 10000 });

    // Switch to "Mine": own flows remain; the URL reflects the filter.
    await page.getByTestId("library-chip-mine").click();
    await expect(page).toHaveURL(/\/workflows\?filter=mine$/);
    await expect(draftCard).toBeVisible();

    // Switch to "Shared": the publisher has nothing shared with them → the own draft
    // flow is filtered out.
    await page.getByTestId("library-chip-shared").click();
    await expect(page).toHaveURL(/\/workflows\?filter=shared$/);
    await expect(page.getByTestId("flow-card").filter({ hasText: DRAFT_FLOW })).toHaveCount(0);
  });

  test("official base flows carry an Official badge and appear under the Official filter", async ({
    page,
  }) => {
    // The consumer was seeded the official base flows on signup (origin added, official).
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/workflows?filter=official`);

    await expect(page.getByTestId("library-chip-official")).toHaveAttribute("aria-pressed", "true");
    // Every card under the Official filter is official → shows the Official badge.
    const cards = page.getByTestId("flow-card");
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    await expect(page.getByTestId("official-badge").first()).toBeVisible();
    expect(await page.getByTestId("official-badge").count()).toBe(count);

    // MCP-first: the run hint is present and shows no start()/developer code.
    const runHint = page.getByTestId("run-hint").first();
    await expect(runHint).toBeVisible();
    const hintText = (await runHint.textContent()) ?? "";
    expect(hintText).not.toContain("start(");
    expect(hintText).not.toContain("mcp__");
  });

  test("Mine filter empty state offers import + browse-catalog adoption affordances", async ({
    page,
  }) => {
    // A brand-new verified user owns no workflows → the Mine filter is empty (the rest of
    // their library is the seeded base flows under Added/Official).
    const stampE = Date.now();
    const fresh = {
      email: `e2e-home-fresh-${stampE}@example.com`,
      password: "TestPass123!",
      name: "E2E Home Fresh",
      acceptedTermsAt: new Date().toISOString(),
      acceptedNotRussianResidentAt: new Date().toISOString(),
    };
    await registerVerified(fresh, await adminCookie());

    await login(page, fresh.email, fresh.password);
    await page.goto(`${BASE_URL}/workflows?filter=mine`);

    const empty = page.getByTestId("empty-state");
    await expect(empty).toBeVisible({ timeout: 10000 });
    // The first-run adoption paths: import-from-file + browse the public catalog.
    await expect(empty.getByRole("button", { name: "Import from file" })).toBeVisible();
    await expect(empty.getByRole("link", { name: /Browse the public catalog/ })).toBeVisible();
  });

  test("publish-from-card: Mine card → prefilled form → listing → View on marketplace", async ({
    page,
  }) => {
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows?filter=mine`);

    const draftCard = page.getByTestId("flow-card").filter({ hasText: DRAFT_FLOW }).first();
    await expect(draftCard).toBeVisible({ timeout: 10000 });

    // Publish the draft flow from its card → the publish form opens PRE-FILLED.
    await draftCard.getByTestId("publish-workflow").click();
    await expect(page).toHaveURL(/\/marketplace\/publish\?workflowId=/);
    await expect(page.getByRole("heading", { name: "Publish a workflow" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Workflow" })).toContainText(DRAFT_FLOW);

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    // Lands on the in-app detail page for the new listing.
    await expect(page.getByRole("heading", { name: DRAFT_FLOW })).toBeVisible({ timeout: 10000 });

    // Back on the home, the now-listed draft card shows the Listed badge + a "View on
    // marketplace" link → the public page.
    await page.goto(`${BASE_URL}/workflows?filter=mine`);
    const listedCard = page.getByTestId("flow-card").filter({ hasText: DRAFT_FLOW }).first();
    await expect(listedCard.getByTestId("listed-badge")).toBeVisible({ timeout: 10000 });
    const viewLink = listedCard.getByTestId("view-on-marketplace");
    const href = await viewLink.getAttribute("href");
    // ROOT public path — NOT app-prefixed.
    expect(href).toMatch(/^\/w\/[^/]+\/[^/]+$/);

    const res = await page.goto(`${BASE_URL}${href}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText(DRAFT_FLOW);
  });

  test("own flow shows under Mine; added reference shows under Added with a public source link", async ({
    page,
  }) => {
    // Publisher sees their published flow under Mine (with a Listed badge).
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows?filter=mine`);
    const ownCard = page.getByTestId("flow-card").filter({ hasText: PUBLISHED_FLOW }).first();
    await expect(ownCard).toBeVisible({ timeout: 10000 });
    await expect(ownCard.getByTestId("listed-badge")).toBeVisible();
    // The publisher is a regular user, so their OWN flow is NOT official (provenance-based
    // badge, D-N6) — no Official badge on an own card.
    await expect(ownCard.getByTestId("official-badge")).toHaveCount(0);
    // The card shows a version/updated identity meta line (with the actual version) so
    // duplicates are distinguishable (D-N1/D-N7).
    await expect(ownCard.getByTestId("flow-card-meta")).toContainText("v1.0.0");

    // Consumer sees the SAME flow under Added, with a link to its public source listing.
    // clearCookies() also drops the beta-accepted cookie from beforeEach, so re-add it
    // before the consumer navigates (otherwise the beta modal can race the next assertion).
    await page.context().clearCookies();
    await page.context().addCookies([
      {
        name: "moira-beta-accepted",
        value: "true",
        domain: new URL(BASE_URL).hostname,
        path: "/",
      },
    ]);
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/workflows?filter=added`);

    const addedCard = page.getByTestId("flow-card").filter({ hasText: PUBLISHED_FLOW }).first();
    await expect(
      addedCard.getByTestId("flow-card-name").filter({ hasText: PUBLISHED_FLOW }),
    ).toBeVisible({
      timeout: 10000,
    });

    // The Added filter also contains the seeded official base flows, so scope the source
    // link to THIS published flow by its href instead of taking the first.
    const sourceLink = page.locator(`[data-testid="added-source-link"][href="/w/${publishedRef}"]`);
    await expect(sourceLink).toHaveCount(1);
    const sourceHref = await sourceLink.getAttribute("href");
    expect(sourceHref).toBe(`/w/${publishedRef}`);
    expect(sourceHref).toBe(`/w/${publisherHandle}/${publishedRef.split("/")[1]}`);

    // The link resolves to the public detail page (served by the backend, not the SPA).
    const res = await page.goto(`${BASE_URL}${sourceHref}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText(PUBLISHED_FLOW);
  });

  test("old /marketplace/library route redirects into the unified home (filter=added)", async ({
    page,
  }) => {
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/marketplace/library`);
    await expect(page).toHaveURL(/\/workflows\?filter=added$/);
    await expect(page.getByTestId("library-chip-added")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("flow-card").first()).toBeVisible({ timeout: 10000 });
  });

  test("the home 'Browse the public catalog' link resolves to the promoted store", async ({
    page,
  }) => {
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows`);

    // This instance is not the canonical store, so the home catalog link is the promo
    // affordance → the public store URL reported by /api/features (external).
    const realRes = await page.request.get(`${BASE_URL}/api/features`);
    const store = (
      (await realRes.json()) as {
        data: { publicStore: { promotionEnabled: boolean; url: string } };
      }
    ).data.publicStore;
    expect(store.promotionEnabled).toBe(true);

    const browse = page.getByTestId("browse-catalog-link");
    await expect(browse).toBeVisible();
    expect(await browse.getAttribute("href")).toBe(store.url);
    expect(await browse.getAttribute("target")).toBe("_blank");
  });
});
