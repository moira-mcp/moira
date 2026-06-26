/**
 * E2E: self-host offline file transfer (Step 16). A flow is EXPORTED to a file from
 * the Mine tab and IMPORTED back through the home "Import from file" control; the
 * imported copy appears in the library. Import/library availability is governed by the
 * local marketplace feature — the import control is gated by the `marketplace` flag,
 * while export (the source side) is always available.
 */

import { readFile } from "fs/promises";
import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { login } from "./helpers/auth-helper.browser.js";
import type { FeaturesResponse } from "../../packages/web-frontend/src/types/api-types";

const BASE_URL = getTestBaseUrl();
const ADMIN = getAdminCredentials();
const stamp = Date.now();

const USER = {
  email: `e2e-xfer-${stamp}@example.com`,
  password: "TestPass123!",
  name: "E2E Transfer User",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};
const FLOW = `E2E Transfer Flow ${stamp}`;

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
  const uid = ((await signUp.json()) as { user?: { id: string } }).user?.id;
  await fetch(`${BASE_URL}/api/admin/users/${uid}/verify-email`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  // Sign in and create the source flow the test exports.
  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: USER.email, password: USER.password }),
  });
  const userCookie = signIn.headers.get("set-cookie") || "";
  await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW, version: "1.0.0", description: "transfer e2e flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
});

test.describe("Self-host file transfer", () => {
  test("export a flow to a file, then import it back into the library", async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto(`${BASE_URL}/workflows`);

    const sourceCard = page.getByTestId("flow-card").filter({ hasText: FLOW });
    await expect(sourceCard).toHaveCount(1, { timeout: 10000 });

    // Export → capture the downloaded file.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      sourceCard.getByTestId("export-workflow").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.moira\.json$/);
    const fileBuffer = await readFile(await download.path());
    const graph = JSON.parse(fileBuffer.toString("utf-8")) as { metadata: { name: string } };
    expect(graph.metadata.name).toBe(FLOW);

    // Import the captured file via the gated "Import from file" control. Wait for the
    // import request to complete so the assertions are deterministic (not racing the
    // ephemeral toast).
    const [importResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/marketplace/import") && r.request().method() === "POST",
      ),
      page.getByTestId("import-workflow-input").setInputFiles({
        name: "flow.moira.json",
        mimeType: "application/json",
        buffer: fileBuffer,
      }),
    ]);
    expect(importResponse.status()).toBe(201);

    // The imported copy now appears alongside the source (same name) — the durable outcome.
    await expect(page.getByTestId("flow-card").filter({ hasText: FLOW })).toHaveCount(2, {
      timeout: 15000,
    });
  });

  test("the import control is gated by the local marketplace feature; export is not", async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);

    // Marketplace feature OFF → no import control; export action stays available.
    const realRes = await page.request.get(`${BASE_URL}/api/features`);
    const realBody = (await realRes.json()) as { data: FeaturesResponse };
    await page.route("**/api/features", async (route) => {
      const patched = {
        ...realBody.data,
        features: { ...realBody.data.features, marketplace: false },
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: patched, timestamp: new Date().toISOString() }),
      });
    });
    await page.goto(`${BASE_URL}/workflows`);

    const sourceCard = page.getByTestId("flow-card").filter({ hasText: FLOW });
    await expect(sourceCard.first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("import-workflow-button")).toHaveCount(0);
    // Export is not gated — it stays on the owned card.
    await expect(sourceCard.first().getByTestId("export-workflow")).toBeVisible();

    // Marketplace feature ON → the import control is present.
    await page.unroute("**/api/features");
    await page.reload();
    await expect(page.getByTestId("import-workflow-button")).toBeVisible({ timeout: 10000 });
  });
});
