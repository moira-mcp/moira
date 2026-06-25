/**
 * E2E: the unified Workflows home (Step 14). The standalone "Workflows" management view
 * and the marketplace "My Library" are merged into ONE origin-organized home at
 * /workflows with tabs Mine / Added / Shared / Core (?origin=...). This exercises:
 *
 *   - publish-from-management: a Mine row's Publish action opens the publish form
 *     PRE-FILLED with that workflow, publishing creates a listing, and the row then
 *     offers a "View on marketplace" link that resolves to the PUBLIC /w/:handle/:slug page;
 *   - an owned workflow shows in Mine and an added-by-reference flow shows in Added with a
 *     link to its public source listing;
 *   - the old /marketplace/library route redirects into the home (?origin=added);
 *   - the app→catalog cross-links are ROOT /w/... and /explore paths (NOT app-prefixed),
 *     because the public SSR catalog is mounted at the root regardless of APP_BASE_PATH.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

const stamp = Date.now();
// PUBLISHED flow (publisher publishes it in setup; the consumer adds it by reference).
const PUBLISHED_FLOW = `E2E Home Published ${stamp}`;
// DRAFT flow (unpublished) — published THROUGH the Mine row's Publish action in the test.
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

  // The consumer ADDS the published flow by reference → it lands in their "Added" origin.
  const conCookie = await signIn(CONSUMER);
  await fetch(`${BASE_URL}/api/marketplace/listings/${listingId}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: conCookie },
    body: "{}",
  });
});

test.describe("Unified Workflows home", () => {
  test("publish-from-management: Mine row → prefilled form → listing → View on marketplace", async ({
    page,
  }) => {
    await login(page, PUBLISHER.email, PUBLISHER.password);

    // The Mine tab is the default origin and lists the publisher's own workflows.
    await page.goto(`${BASE_URL}/workflows`);
    await expect(page.getByTestId("origin-tab-mine")).toBeVisible();
    const draftRow = page.getByTestId("workflow-card").filter({ hasText: DRAFT_FLOW });
    await expect(draftRow).toBeVisible({ timeout: 10000 });

    // Publish the draft flow from its row → the publish form opens PRE-FILLED.
    await draftRow.getByTestId("publish-workflow").click();
    await expect(page).toHaveURL(/\/marketplace\/publish\?workflowId=/);
    await expect(page.getByRole("heading", { name: "Publish a workflow" })).toBeVisible();
    // The workflow select already shows the draft flow (prefilled from ?workflowId).
    await expect(page.getByRole("combobox", { name: "Workflow" })).toContainText(DRAFT_FLOW);

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    // Lands on the in-app detail page for the new listing.
    await expect(page.getByRole("heading", { name: DRAFT_FLOW })).toBeVisible({ timeout: 10000 });

    // Back on the home, the now-listed draft row offers "View on marketplace" → public page.
    await page.goto(`${BASE_URL}/workflows`);
    const listedRow = page.getByTestId("workflow-card").filter({ hasText: DRAFT_FLOW });
    await expect(listedRow.getByTestId("listed-badge")).toBeVisible({ timeout: 10000 });
    const viewLink = listedRow.getByTestId("view-on-marketplace");
    const href = await viewLink.getAttribute("href");
    // ROOT public path — NOT app-prefixed.
    expect(href).toMatch(/^\/w\/[^/]+\/[^/]+$/);

    const res = await page.goto(`${BASE_URL}${href}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText(DRAFT_FLOW);
  });

  test("owned flow shows in Mine; added reference shows in Added with a public source link", async ({
    page,
  }) => {
    // Publisher sees their published flow under Mine (with a Listed badge).
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows?origin=mine`);
    const ownRow = page.getByTestId("workflow-card").filter({ hasText: PUBLISHED_FLOW });
    await expect(ownRow).toBeVisible({ timeout: 10000 });
    await expect(ownRow.getByTestId("listed-badge")).toBeVisible();

    // Consumer sees the SAME flow under Added, with a link to its public source listing.
    await page.context().clearCookies();
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/workflows?origin=added`);

    const addedList = page.getByTestId("origin-list-added");
    await expect(addedList).toBeVisible({ timeout: 10000 });
    // The flow name appears in both the row title and the human run hint
    // ("Ask your agent: run \"<name>\""); assert on the title specifically.
    await expect(
      addedList.getByTestId("library-item-name").filter({ hasText: PUBLISHED_FLOW }),
    ).toBeVisible();

    const sourceLink = addedList.getByTestId("added-source-link").first();
    const sourceHref = await sourceLink.getAttribute("href");
    expect(sourceHref).toBe(`/w/${publishedRef}`);
    expect(sourceHref).toBe(`/w/${publisherHandle}/${publishedRef.split("/")[1]}`);

    // The link resolves to the public detail page (served by the backend, not the SPA).
    const res = await page.goto(`${BASE_URL}${sourceHref}`);
    expect(res?.status()).toBe(200);
    await expect(page.locator("h1")).toContainText(PUBLISHED_FLOW);
  });

  test("old /marketplace/library route redirects into the unified home (origin=added)", async ({
    page,
  }) => {
    await login(page, CONSUMER.email, CONSUMER.password);
    await page.goto(`${BASE_URL}/marketplace/library`);
    await expect(page).toHaveURL(/\/workflows\?origin=added$/);
    await expect(page.getByTestId("origin-list-added")).toBeVisible({ timeout: 10000 });
  });

  test("the home top-level 'Browse the public catalog' link is a ROOT /explore path", async ({
    page,
  }) => {
    await login(page, PUBLISHER.email, PUBLISHER.password);
    await page.goto(`${BASE_URL}/workflows`);
    const browse = page.getByRole("link", { name: /Browse the public catalog/ });
    await expect(browse).toBeVisible();
    expect(await browse.getAttribute("href")).toBe("/explore");
  });
});
