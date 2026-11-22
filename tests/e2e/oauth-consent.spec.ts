import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import {
  getTestBaseUrl,
  getTestFetchUrl,
  getTestRequestOrigin,
  getAdminCredentials,
} from "../utils/test-config.js";

const callback = "http://127.0.0.1:18765/callback";

async function beginAuthorization(page: Page) {
  const scope = "openid profile email offline_access";
  const registration = await page.request.post(`${getTestFetchUrl()}/api/auth/mcp/register`, {
    headers: { Origin: getTestRequestOrigin() },
    data: {
      client_name: "Consent browser test",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope,
    },
  });
  expect(registration.status()).toBe(201);
  const { client_id: clientId } = await registration.json();
  const state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    scope,
    state,
    code_challenge: createHash("sha256")
      .update(randomBytes(32).toString("base64url"))
      .digest("base64url"),
    code_challenge_method: "S256",
  });
  // Intercept delivery to the client; the application must choose its registered callback.
  await page.route(callback + "**", (route) => route.fulfill({ body: "Callback received" }));
  await page.goto(`${getTestBaseUrl()}/api/auth/mcp/authorize?${params}`);
  return { clientId, state };
}

test.describe("OAuth consent", () => {
  test("shows the registered client and requested permissions and returns the approved authorization code", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const { clientId, state } = await beginAuthorization(page);
    await expect(page.getByText(clientId, { exact: true })).toBeVisible();
    await expect(page.getByText(getAdminCredentials().email, { exact: true })).toBeVisible();
    for (const label of [
      "Verify your identity",
      "Access your profile information",
      "Access your email address",
      "Access your data when you're not using the app",
    ])
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL(callback + "**");
    const query = new URL(page.url()).searchParams;
    expect(query.get("state")).toBe(state);
    expect(query.get("code")).toBeTruthy();
  });

  test("a signed-out user can finish the same authorization request after signing in", async ({
    page,
  }) => {
    const { clientId, state } = await beginAuthorization(page);
    const { email, password } = getAdminCredentials();
    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByText(clientId, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL(callback + "**");
    const query = new URL(page.url()).searchParams;
    expect(query.get("state")).toBe(state);
    expect(query.get("code")).toBeTruthy();
  });

  test("switching accounts restarts login", async ({ page }) => {
    await loginAsAdmin(page);
    await beginAuthorization(page);
    await page.getByRole("button", { name: "Switch" }).click();
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
  });

  test("denial returns the error and original state to the registered callback", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    const { state } = await beginAuthorization(page);
    await page.getByRole("button", { name: "Deny" }).click();
    await page.waitForURL(callback + "**");
    const query = new URL(page.url()).searchParams;
    expect(query.get("error")).toBe("access_denied");
    expect(query.get("state")).toBe(state);
    expect(query.has("code")).toBe(false);
  });
});
