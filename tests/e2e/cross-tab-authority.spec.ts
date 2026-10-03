import { randomUUID } from "node:crypto";
import { test, expect, type Route } from "./fixtures.js";
import { createTestUser, login } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestRequestOrigin } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

for (const outcome of ["conceal private holdings", "preserve the replacement session"] as const) {
  test(`known-owner login in another page must ${outcome}`, async ({ page, context }, testInfo) => {
    const suffix = randomUUID();
    const password = "CrossTabPassword123!";
    const emailA = `cross-a-${suffix}@example.test`;
    const emailB = `cross-b-${suffix}@example.test`;
    const a = await createTestUser(emailA, password, "Cross tab A", true);
    const b = await createTestUser(emailB, password, "Cross tab B", true);
    expect(a.success, a.error).toBe(true);
    expect(b.success, b.error).toBe(true);
    await login(page, emailA, password);
    const key = `private-a-${suffix}`;
    const saved = await context.request.post(`${BASE_URL}/api/notes`, {
      data: { key, value: "Private holding belonging to A" },
    });
    expect(saved.ok()).toBe(true);
    await page.goto(`${BASE_URL}/notes`);
    const holding = page.getByTestId(`note-row-${key}`);
    await expect(holding).toContainText("Private holding belonging to A");

    const second = await context.newPage();
    const knownOwner = second.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/get-session",
    );
    await second.goto(`${BASE_URL}/login`);
    expect((await (await knownOwner).json()).user.id).toBe(a.userId);
    await second.evaluate(() => undefined);
    await page.evaluate(() => undefined);
    await expect(holding).toBeVisible();

    // Keep A's authoritative observation pending: the browser still uses the shared real
    // cookie, while the app must retire A on an actual notification from B's auth operation.
    const sessionRoutes: Route[] = [];
    await page.route("**/api/auth/get-session", (route) => {
      sessionRoutes.push(route);
    });
    let held!: Route;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    await page.route(/\/api\/notes\?/, (route) => {
      if (new URL(route.request().url()).searchParams.get("keySearch") !== "held-private-read") {
        return route.continue();
      }
      held = route;
      requestStarted();
    });
    let notifications = 0;
    page.on("console", (message) => {
      if (message.text() === "Observed provider session notification") notifications++;
    });
    await page.evaluate(() =>
      window.addEventListener("storage", (event) => {
        if (event.key === "better-auth.message")
          console.info("Observed provider session notification");
      }),
    );
    const cleanup: Promise<unknown>[] = [];
    page.on("request", (request) => {
      if (
        ["/api/auth/sign-out", "/api/auth/revoke-session"].includes(new URL(request.url()).pathname)
      ) {
        cleanup.push(request.response().then((response) => response?.finished()));
      }
    });
    try {
      await page.getByTestId("notes-search").fill("held-private-read");
      await started;
      await second.locator('input[name="email"]').fill(emailB);
      await second.locator('input[name="password"]').fill(password);
      await second.locator('button[type="submit"]').click();
      await second.waitForURL(`${BASE_URL}/`);
      const current = await context.request.get(`${BASE_URL}/api/auth/get-session`);
      expect((await current.json()).user.id).toBe(b.userId);

      if (outcome === "conceal private holdings") {
        await expect(holding).not.toBeVisible();
      } else {
        const errorHandled = page.waitForEvent("console", {
          predicate: (message) => message.text().includes("API Response Error:"),
        });
        await held.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: { code: "FORBIDDEN", message: "Earlier A request denied" },
          }),
        });
        await errorHandled;
        // A browser task barrier lets the interceptor dispatch its immediate cleanup; wait
        // for any real cleanup request before observing the authoritative shared cookie.
        await page.evaluate(() => undefined);
        await Promise.all(cleanup);
        const surviving = await context.request.get(`${BASE_URL}/api/auth/get-session`);
        const authority = await surviving.json();
        await testInfo.attach("cross-tab-authority", {
          body: JSON.stringify({
            notifications,
            cleanupRequests: cleanup.length,
            currentUserId: authority?.user?.id ?? null,
          }),
          contentType: "application/json",
        });
        expect(authority?.user?.id).toBe(b.userId);
      }
    } finally {
      await held?.abort().catch(() => {});
      await Promise.all(sessionRoutes.map((route) => route.abort().catch(() => {})));
      await second.close();
    }
  });
}

test("a delayed invalid-session targeted revoke response cannot expire a newer shared cookie", async ({
  page,
  context,
}) => {
  const suffix = randomUUID();
  const password = "CrossTabPassword123!";
  const emailA = `revoke-a-${suffix}@example.test`;
  const emailB = `revoke-b-${suffix}@example.test`;
  const a = await createTestUser(emailA, password, "Revoke A", true);
  const b = await createTestUser(emailB, password, "Revoke B", true);
  expect(a.success, a.error).toBe(true);
  expect(b.success, b.error).toBe(true);
  await login(page, emailA, password);
  const observed = await (await context.request.get(`${BASE_URL}/api/auth/get-session`)).json();
  const second = await context.newPage();
  const initial = second.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/get-session",
  );
  await second.goto(`${BASE_URL}/login`);
  expect((await (await initial).json()).user.id).toBe(a.userId);
  const revoked = await context.request.post(`${BASE_URL}/api/auth/revoke-session`, {
    headers: { Origin: getTestRequestOrigin() },
    data: { token: observed.session.token },
  });
  expect(revoked.status()).toBe(200);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/auth/revoke-session", async (route) => {
    const response = await route.fetch();
    started();
    await held;
    await route.fulfill({ response });
  });
  const cleanup = page.evaluate(async (token) => {
    const response = await fetch("/api/auth/revoke-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.status;
  }, observed.session.token);
  try {
    await responseReady;
    await second.locator('input[name="email"]').fill(emailB);
    await second.locator('input[name="password"]').fill(password);
    await second.locator('button[type="submit"]').click();
    await second.waitForURL(`${BASE_URL}/`);
    expect(
      (await (await context.request.get(`${BASE_URL}/api/auth/get-session`)).json()).user.id,
    ).toBe(b.userId);
    release();
    expect(await cleanup).toBe(401);
    const surviving = await (await context.request.get(`${BASE_URL}/api/auth/get-session`)).json();
    expect(surviving?.user?.id).toBe(b.userId);
  } finally {
    release();
    await cleanup.catch(() => {});
    await second.close();
  }
});
