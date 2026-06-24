/**
 * E2E: the server-rendered public marketplace pages (/explore, /w/:handle/:slug) are
 * served by the web-backend (not the SPA), crawlable, and fresh from the live DB. A
 * flow published in setup appears immediately on both pages. The detail page carries
 * structured data; a missing flow 404s instead of falling through to the SPA.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import path from "path";
import fs from "fs";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

// Screenshots of the rendered pages for the step report.
const SHOT_DIR = path.resolve("moira-ws/marketplace-20260623-2152/step-7/iteration-1/screenshots");

const FLOW_NAME = `E2E SSR Flow ${Date.now()}`;
let startRef = "";

test.beforeAll(async () => {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const user = {
    email: `e2e-pages-${Date.now()}@example.com`,
    password: "TestPass123!",
    name: "E2E Pages",
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
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "E2E SSR page flow" },
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
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
  const publishData = (await publishRes.json()) as { data?: { startRef?: string } };
  startRef = publishData.data?.startRef ?? "";

  fs.mkdirSync(SHOT_DIR, { recursive: true });
});

test.describe("Public marketplace pages (SSR)", () => {
  test("/explore lists the just-published flow and links to its detail page", async ({ page }) => {
    expect(startRef).not.toBe("");
    const res = await page.goto(`${BASE_URL}/explore`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/Explore workflows/);
    await expect(page.locator("body")).toContainText(FLOW_NAME);
    await expect(page.locator(`a[href$="/w/${startRef}"]`)).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "01-explore.png"), fullPage: true });
  });

  test("/w/:handle/:slug renders the detail page (served by the backend, not the SPA)", async ({
    page,
  }) => {
    const res = await page.goto(`${BASE_URL}/w/${startRef}`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(FLOW_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(page.locator("h1")).toContainText(FLOW_NAME);
    // JSON-LD structured data is present in the document head. The render package emits
    // multiple blocks (SoftwareApplication + BreadcrumbList), so assert across all of
    // them that the SoftwareApplication type is present.
    const ldBlocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ldBlocks.length).toBeGreaterThanOrEqual(1);
    expect(ldBlocks.join("")).toContain("SoftwareApplication");
    // The hydration bootstrap (stable bundle ref + initial-data island) is present so
    // the browser upgrades the server-rendered markup.
    await expect(page.locator('script[src*="marketplace-hydrate.js"]')).toHaveCount(1);
    const island = await page.locator("#mp-bootstrap").textContent();
    expect(JSON.parse(island as string).page).toBe("detail");
    await page.screenshot({ path: path.join(SHOT_DIR, "02-detail.png"), fullPage: true });
  });

  test("a missing flow 404s instead of falling through to the SPA", async ({ page }) => {
    const res = await page.goto(`${BASE_URL}/w/nobody/does-not-exist`);
    expect(res?.status()).toBe(404);
    await expect(page).toHaveTitle(/Not found/);
  });
});
