/**
 * E2E: the in-app Marketplace SPA. A user publishes one of their workflows through the
 * publish form, sees it in the gallery, opens the detail page, adds it to their library,
 * and rates it — all through the browser UI. The disabled "coming soon" paid controls
 * are asserted present-but-disabled. Before/after screenshots are captured for the
 * step report.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";
import path from "path";
import fs from "fs";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();

const SHOT_DIR = path.resolve("moira-ws/marketplace-20260623-2152/step-8/iteration-1/screenshots");

const FLOW_NAME = `E2E UI Flow ${Date.now()}`;
const stamp = Date.now();
// Publisher (owns + lists the flow).
const PUBLISHER = {
  email: `e2e-ui-pub-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Publisher",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};
// Consumer (adds + rates — cannot be the owner; self-rating is forbidden).
const CONSUMER = {
  email: `e2e-ui-con-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Consumer",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

async function adminCookieHeader(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  return res.headers.get("set-cookie") || "";
}

async function registerVerified(user: typeof PUBLISHER, adminCookie: string): Promise<void> {
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
}

test.beforeAll(async () => {
  const adminCookie = await adminCookieHeader();
  await registerVerified(PUBLISHER, adminCookie);
  await registerVerified(CONSUMER, adminCookie);

  // Create a workflow the publisher owns, so it can be published through the UI.
  const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PUBLISHER.email, password: PUBLISHER.password }),
  });
  const pubCookie = loginRes.headers.get("set-cookie") || "";
  await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: pubCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "E2E UI publish flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });

  fs.mkdirSync(SHOT_DIR, { recursive: true });
});

test.describe("Marketplace SPA", () => {
  test("publish → appears in gallery → add to library → rate", async ({ page }) => {
    // ---- Publisher: publish a workflow through the UI ----
    await login(page, PUBLISHER.email, PUBLISHER.password);

    // BEFORE: the gallery (the just-created flow is not published yet).
    await page.goto(`${BASE_URL}/marketplace`);
    await expect(page.getByRole("heading", { name: "Marketplace" })).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "01-gallery-before.png"), fullPage: true });

    // Publish through the form.
    await page.goto(`${BASE_URL}/marketplace/publish`);
    await expect(page.getByRole("heading", { name: "Publish a workflow" })).toBeVisible();

    // The paid pricing section is present but disabled ("coming soon").
    const paidCheckbox = page.getByRole("checkbox", { name: "Make this a paid workflow" });
    await expect(paidCheckbox).toBeDisabled();
    await page.screenshot({ path: path.join(SHOT_DIR, "02-publish-form.png"), fullPage: true });

    // Pick the workflow from the select (Radix trigger has role=combobox).
    await page.getByRole("combobox", { name: "Workflow" }).click();
    await page.getByRole("option", { name: FLOW_NAME }).click();
    await page.getByRole("button", { name: "Publish", exact: true }).click();

    // Lands on the detail page for the new listing.
    await expect(page.getByRole("heading", { name: FLOW_NAME })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(`start("`, { exact: false })).toBeVisible();
    await page.screenshot({ path: path.join(SHOT_DIR, "03-detail.png"), fullPage: true });

    // It shows up in the gallery now.
    await page.goto(`${BASE_URL}/marketplace`);
    await page.getByLabel("Search workflows").fill(FLOW_NAME);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("link", { name: FLOW_NAME })).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "04-gallery-after.png"), fullPage: true });

    // The publisher sees it under My Listings.
    await page.goto(`${BASE_URL}/marketplace/my-listings`);
    await expect(page.getByText(FLOW_NAME)).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "05-my-listings.png"), fullPage: true });

    // ---- Consumer: a DIFFERENT user adds it and rates it ----
    // (Self-rating is forbidden, so the rater must not be the owner.)
    await page.context().clearCookies();
    await login(page, CONSUMER.email, CONSUMER.password);

    await page.goto(`${BASE_URL}/marketplace`);
    await page.getByLabel("Search workflows").fill(FLOW_NAME);
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("link", { name: FLOW_NAME }).click();
    await expect(page.getByRole("heading", { name: FLOW_NAME })).toBeVisible();

    await page.getByRole("button", { name: "Add to my library" }).click();
    await expect(page.getByText("Added to your library")).toBeVisible({ timeout: 10000 });

    // Fork → an editable copy in the consumer's own workflows.
    await page.getByRole("button", { name: "Fork" }).click();
    await expect(page.getByText("Forked into your workflows")).toBeVisible({ timeout: 10000 });

    await page.getByLabel("Review text").fill("Solid starter flow.");
    await page.getByRole("button", { name: "Submit review" }).click();
    await expect(page.getByText("Solid starter flow.")).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "06-rated.png"), fullPage: true });

    // The flow now appears in the consumer's library (the added reference plus the
    // forked own-copy, so there can be more than one entry with this name).
    await page.goto(`${BASE_URL}/marketplace/library`);
    await expect(page.getByText(FLOW_NAME).first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, "07-library.png"), fullPage: true });
  });
});
