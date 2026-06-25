/**
 * E2E: the polished, session-aware PUBLIC marketplace pages (/explore, /w/:handle/:slug)
 * served by the web-backend (not the SPA). Covers the anonymous chrome (topbar, theme
 * toggle, EN/RU switch, sign-in control + gated sign-in CTA on detail), the JS-free
 * language toggle (an anchor → ?lang=ru → RU chrome), the hydrated theme toggle
 * (light→dark→system, persisted to localStorage), and the signed-in variant (account
 * chip + sign-out, the owner's own-pill, and sign-out → reload back to anonymous).
 *
 * The anonymous cases need no JS; the theme + sign-out cases assert post-hydration
 * behavior (the marketplace-hydrate.js bundle wires them). Uses web-first Playwright
 * assertions throughout.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl, getAdminCredentials } from "../utils/test-config.js";
import path from "path";
import fs from "fs";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const ADMIN = getAdminCredentials();

const SHOT_DIR = path.resolve("moira-ws/marketplace-20260623-2152/step-13/iteration-1/screenshots");

const stamp = Date.now();
const FLOW_NAME = `E2E Public Page Flow ${stamp}`;
// The email is (re)seeded uniquely at the start of every beforeAll run so a retried
// setup provisions a BRAND-NEW user instead of colliding with the prior attempt's email
// (422 USER_ALREADY_EXISTS). password/name are stable.
const USER = {
  email: "",
  password: "TestPass123!",
  name: "E2E Public Page",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

let startRef = ""; // "handle/slug" of the seeded listing
let userHandle = ""; // the @handle the account chip renders
/** The browser cookie name for the Better Auth session token (env-dependent). */
let sessionCookieName = "";
/** A long-lived session token for the seeded user (used by read-only signed-in tests). */
let sessionCookieValue = "";

/**
 * Sign up a user, returning their id. Bounded-retries the auth endpoint: the e2e suite
 * runs many auth-heavy specs in parallel and the sign-up route is rate-limited, so a
 * single attempt can transiently fail under load. Surfaces the real status/body if every
 * attempt fails (so a genuine break is diagnosable, not hidden behind "signup failed").
 */
async function signUpUser(user: typeof USER): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });
    const body = (await res.json().catch(() => ({}))) as { user?: { id: string } };
    if (body.user?.id) return body.user.id;
    last = `status=${res.status} body=${JSON.stringify(body)}`;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`signup failed after retries: ${last}`);
}

/** Sign in the seeded user, returning their Set-Cookie header (bounded-retry under load). */
async function signInUser(): Promise<string> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const login = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: USER.email, password: USER.password }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    if (/(?:__Secure-)?better-auth\.session_token=/.test(setCookie)) return setCookie;
    last = `status=${login.status}`;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`sign-in failed after retries: ${last}`);
}

/** Mint a FRESH session token for the seeded user (a new sign-in → new token). */
async function freshSessionToken(): Promise<string> {
  const setCookie = await signInUser();
  const match = setCookie.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("could not extract session cookie");
  return match[1];
}

test.beforeAll(async () => {
  // Fresh unique email per setup run (survives a retried beforeAll without colliding).
  USER.email = `e2e-public-page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  const adminLogin = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const uid = await signUpUser(USER);
  await fetch(`${FETCH_URL}/api/admin/users/${uid}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  const setCookie = await signInUser();
  const userCookie = setCookie;
  const match = setCookie.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) throw new Error("could not extract session cookie");
  sessionCookieName = FETCH_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  sessionCookieValue = match[1];

  const created = await fetch(`${FETCH_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "E2E public page flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const workflowId = ((await created.json()) as { data?: { workflowId?: string } }).data
    ?.workflowId;
  if (!workflowId) throw new Error("create workflow failed");

  const publish = await fetch(`${FETCH_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
  startRef = ((await publish.json()) as { data?: { startRef?: string } }).data?.startRef ?? "";
  if (!startRef) throw new Error("publish failed");
  userHandle = startRef.split("/")[0];

  fs.mkdirSync(SHOT_DIR, { recursive: true });
});

/**
 * Add a Better Auth session cookie to a page's context. Defaults to the long-lived
 * seeded token; pass a token to use a throwaway session (e.g. the sign-out test, which
 * revokes its token server-side and must not poison the shared one).
 */
async function signIn(
  page: import("@playwright/test").Page,
  token: string = sessionCookieValue,
): Promise<void> {
  const url = new URL(BASE_URL);
  await page.context().addCookies([
    {
      name: sessionCookieName,
      value: token,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: BASE_URL.startsWith("https://"),
      sameSite: "Lax",
    },
  ]);
}

test.describe("Public marketplace pages — anonymous chrome", () => {
  test("/explore shows topbar, theme toggle, EN/RU switch and a sign-in control", async ({
    page,
  }) => {
    const res = await page.goto(`${BASE_URL}/explore`);
    expect(res?.status()).toBe(200);

    await expect(page.locator('[data-mp="topbar"]')).toBeVisible();
    await expect(page.locator('[data-mp="brand"]')).toBeVisible();
    await expect(page.locator('[data-mp="theme-toggle"]')).toBeVisible();
    await expect(page.locator('[data-mp="lang-en"]')).toBeVisible();
    await expect(page.locator('[data-mp="lang-ru"]')).toBeVisible();
    await expect(page.locator('[data-mp="footer"]')).toBeVisible();

    // Anonymous: a sign-in control, no account chip / sign-out.
    await expect(page.locator('[data-mp="sign-in"]')).toBeVisible();
    await expect(page.locator('[data-mp="sign-out"]')).toHaveCount(0);
    await expect(page.locator('[data-mp="account"]')).toHaveCount(0);

    await page.screenshot({ path: path.join(SHOT_DIR, "01-explore-anon.png"), fullPage: true });
  });

  test("/w/:ref detail: the primary action is the gated sign-in CTA → login", async ({ page }) => {
    await page.goto(`${BASE_URL}/w/${startRef}`);
    const cta = page.locator('[data-mp="signin-cta"]');
    await expect(cta).toBeVisible();
    // Gated: the CTA links to the login route.
    await expect(cta).toHaveAttribute("href", /\/login/);
    // Anonymous detail shows neither viewer pill.
    await expect(page.locator('[data-mp="own-pill"]')).toHaveCount(0);
    await expect(page.locator('[data-mp="library-pill"]')).toHaveCount(0);

    await page.screenshot({ path: path.join(SHOT_DIR, "02-detail-anon.png"), fullPage: true });
  });
});

test.describe("Public marketplace pages — language toggle (no JS)", () => {
  test("clicking RU navigates to ?lang=ru and shows RU chrome", async ({ page }) => {
    await page.goto(`${BASE_URL}/explore`);
    // The language switch is a plain anchor → navigation, no hydration needed.
    await page.locator('[data-mp="lang-ru"]').click();
    await page.waitForLoadState("domcontentloaded");
    await expect(page).toHaveURL(/lang=ru/);
    // RU chrome: html lang, the RU sign-in label in the topbar, the RU explore title body.
    await expect(page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(page.locator('[data-mp="topbar"]')).toContainText("Войти");
    await expect(page.locator('[data-mp="explore"] h1')).toContainText("Каталог");
    // The RU switch is the active one.
    await expect(page.locator('[data-mp="lang-ru"]')).toHaveAttribute("aria-current", "true");
  });
});

test.describe("Public marketplace pages — theme toggle (hydrated)", () => {
  test("toggling theme reaches dark and persists localStorage theme", async ({ page }) => {
    await page.goto(`${BASE_URL}/explore`);
    // Start from a known state: light. The no-flash script + hydration both read this.
    await page.evaluate(() => localStorage.setItem("theme", "light"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/light/);

    // Wait for the deferred hydration bundle to actually run + wire the toggle. We can't
    // observe the listener directly, so poll until a click takes effect — then assert the
    // FINAL state. (Polling reads localStorage rather than re-clicking, so the theme cycle
    // light→dark→system is never accidentally over-advanced.)
    await expect(page.locator('script[src*="marketplace-hydrate.js"]')).toHaveCount(1);
    const toggle = page.locator('[data-mp="theme-toggle"]');
    await expect
      .poll(
        async () => {
          if ((await page.evaluate(() => localStorage.getItem("theme"))) === "light") {
            await toggle.click(); // first effective click: light → dark
          }
          return page.evaluate(() => localStorage.getItem("theme"));
        },
        { timeout: 10000 },
      )
      .toBe("dark");

    // The class on <html> reflects the persisted choice.
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("Public marketplace pages — signed in", () => {
  test("/explore shows the account chip + sign-out; sign-out returns to anonymous", async ({
    page,
  }) => {
    // Sign-out REVOKES the session token server-side, so use a throwaway token here to
    // avoid invalidating the shared long-lived token the other signed-in tests rely on.
    await signIn(page, await freshSessionToken());
    await page.goto(`${BASE_URL}/explore`);

    await expect(page.locator('[data-mp="account"]')).toBeVisible();
    await expect(page.locator('[data-mp="account-handle"]')).toHaveText(`@${userHandle}`);
    await expect(page.locator('[data-mp="sign-out"]')).toBeVisible();
    await expect(page.locator('[data-mp="sign-in"]')).toHaveCount(0);

    await page.screenshot({ path: path.join(SHOT_DIR, "03-explore-signedin.png"), fullPage: true });

    // Sign out (hydrated: signOut() then reload) → back to the anonymous header.
    await expect(page.locator('script[src*="marketplace-hydrate.js"]')).toHaveCount(1);
    await expect(async () => {
      await page.locator('[data-mp="sign-out"]').click();
      await page.waitForLoadState("networkidle");
      await expect(page.locator('[data-mp="sign-in"]')).toBeVisible();
    }).toPass({ timeout: 15000 });
    await expect(page.locator('[data-mp="account"]')).toHaveCount(0);
  });

  test("the owner sees the own-pill on their listing's detail page", async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE_URL}/w/${startRef}`);
    await expect(page.locator('[data-mp="own-pill"]')).toBeVisible();
    await expect(page.locator('[data-mp="library-pill"]')).toHaveCount(0);
    // Signed-in owner: no anonymous sign-in CTA on the action area.
    await expect(page.locator('[data-mp="signin-cta"]')).toHaveCount(0);
  });
});
