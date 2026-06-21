/**
 * Artifact Security E2E Tests
 *
 * Tests that verify security protections cannot be bypassed:
 * - XSS via script injection (inline, external, event handlers)
 * - Cookie theft attempts
 * - Data exfiltration via fetch/XHR/WebSocket
 * - Form submission for phishing
 * - Clickjacking protection
 * - Content-Type sniffing attacks
 */

import { test, expect } from "./fixtures.js";
import { createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Store session cookie for API calls
let sessionCookie = "";

/**
 * Login via HTTP and get session cookie
 */
async function loginViaHttp(email: string, password: string): Promise<string> {
  const response = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const setCookieHeader = response.headers.get("set-cookie");
  const match = setCookieHeader?.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  if (!match) {
    throw new Error("No session cookie in sign-in response");
  }
  return match[1];
}

const testUserCredentials = {
  email: "",
  password: "SecurityTest123!",
  name: "Security Test User",
};

test.describe("Artifact Security", () => {
  // Track created artifacts for cleanup
  const createdArtifactIds: string[] = [];

  test.beforeAll(async () => {
    testUserCredentials.email = `artifact-security-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;
    const result = await createTestUser(
      testUserCredentials.email,
      testUserCredentials.password,
      testUserCredentials.name,
      true,
    );
    if (!result.success) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }

    // Get session cookie for API calls
    sessionCookie = await loginViaHttp(testUserCredentials.email, testUserCredentials.password);
  });

  test.afterAll(async () => {
    // Cleanup: delete all created artifacts
    for (const uuid of createdArtifactIds) {
      try {
        await fetch(`${FETCH_URL}/api/artifacts/${uuid}`, {
          method: "DELETE",
          headers: {
            Cookie: `better-auth.session_token=${sessionCookie}`,
          },
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  /**
   * Helper to create an artifact via API and track for cleanup.
   *
   * Artifacts are served in subdomain-isolation mode: each artifact has its own
   * origin `{uuid}.static.localhost:<port>` (HTTP, loopback — no cert). The API
   * returns that subdomain URL. Path access on the bare domain redirects to it.
   * We derive subdomain-relative wrapper/frame/report URLs (root-relative on the
   * subdomain origin) for both browser navigation and fetch.
   */
  async function createArtifact(
    name: string,
    content: string,
  ): Promise<{
    uuid: string;
    /** Subdomain origin, e.g. http://{uuid}.static.localhost:3033 */
    origin: string;
    /** Subdomain wrapper URL (browser goto) */
    wrapperUrl: string;
    /** Subdomain wrapper URL (fetch) */
    wrapperFetchUrl: string;
    /** Subdomain frame URL (fetch) */
    frameFetchUrl: string;
    /** Subdomain report URL (fetch) */
    reportFetchUrl: string;
    /** Bare-domain path URL (used to assert the redirect to the subdomain) */
    pathFetchUrl: string;
  }> {
    const response = await fetch(`${FETCH_URL}/api/artifacts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `better-auth.session_token=${sessionCookie}`,
      },
      body: JSON.stringify({ name, content }),
    });
    if (!response.ok) {
      throw new Error(`Create artifact failed: ${response.status} ${await response.text()}`);
    }
    const json = await response.json();
    const uuid = json.data.uuid as string;
    // API returns the canonical subdomain URL, e.g.
    // http://{uuid}.static.localhost:3033/ — strip the trailing slash to an origin.
    const origin = (json.data.url as string).replace(/\/$/, "");
    createdArtifactIds.push(uuid);
    return {
      uuid,
      origin,
      wrapperUrl: `${origin}/`,
      wrapperFetchUrl: `${origin}/`,
      frameFetchUrl: `${origin}/__frame/${uuid}`,
      reportFetchUrl: `${origin}/__report/${uuid}`,
      pathFetchUrl: `${FETCH_URL}/static/${uuid}.html`,
    };
  }

  test("wrapper shows interstitial on first visit, frame after acknowledgment", async () => {
    const { wrapperFetchUrl } = await createArtifact(
      "interstitial.html",
      "<!DOCTYPE html><html><body><h1>hello</h1></body></html>",
    );

    const first = await fetch(wrapperFetchUrl);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("User-generated content");
    // No real iframe element before acknowledgment
    expect(firstHtml).not.toMatch(/<iframe/);

    const acked = await fetch(`${wrapperFetchUrl}?ack=1`);
    const ackedHtml = await acked.text();
    expect(ackedHtml).toMatch(/<iframe/);
    expect(ackedHtml).toContain("Created with");
  });

  test("artifact frame loads as a real sandboxed iframe under the JS-enabled, no-network CSP", async ({
    page,
  }) => {
    // Behavioral proof that the wrapper actually loads the artifact as a child
    // frame and the browser receives the frame document with the JS-enabled,
    // no-network CSP. (The sandbox itself is an opaque origin the parent cannot
    // introspect — that inaccessibility IS the boundary; we assert the contract
    // at the boundary: a real subframe load + the enforced CSP on that load.)
    const { wrapperUrl, uuid, origin } = await createArtifact(
      "js-sandbox.html",
      '<!DOCTYPE html><html><body><h1 id="t">before</h1><script>document.title="JS_RAN";</script></body></html>',
    );

    await page.goto(`${wrapperUrl}?ack=1`);

    // The browser loaded the artifact as a real subframe of the wrapper.
    await expect
      .poll(() => page.frames().some((f) => f.url().includes(`/__frame/${uuid}`)), {
        timeout: 10000,
      })
      .toBe(true);

    // The frame document is served under the JS-enabled, no-network CSP (allows
    // scripts to run while blocking fetch/XHR/WebSocket egress).
    const direct = await fetch(`${origin}/__frame/${uuid}`, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    const csp = direct.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("connect-src 'none'");
  });

  test("path-based access to artifact content does not exist (origin isolation)", async () => {
    // Artifacts are reachable ONLY on their own subdomain — there is no path-based
    // serving at all. A path request on the shared domain serves NO artifact
    // content (the /:uuid.html route was removed); it does not 200 with content.
    const { uuid, origin } = await createArtifact(
      "path-gone.html",
      "<!DOCTYPE html><html><body><h1>secret-path-content</h1></body></html>",
    );
    const res = await fetch(`${FETCH_URL}/static/${uuid}.html?ack=1`, { redirect: "manual" });
    // No path route → not a 200 serving the artifact. (404 from the app.)
    expect(res.status).not.toBe(200);
    if (res.status === 200) {
      expect(await res.text()).not.toContain("secret-path-content");
    }
    // The artifact IS served on its own subdomain.
    expect((await fetch(`${origin}/?ack=1`)).status).toBe(200);
  });

  test("top-level navigation to the raw frame redirects to the wrapper (no phishing surface)", async ({
    page,
  }) => {
    // B1: the raw frame must never render as a top-level document (no interstitial,
    // no footer). On the artifact subdomain a top-level GET to /__frame redirects
    // to the wrapper "/".
    const { uuid, origin } = await createArtifact(
      "frame-direct.html",
      "<!DOCTYPE html><html><body><h1>raw</h1></body></html>",
    );

    await page.goto(`${origin}/__frame/${uuid}`);
    // Redirected to the wrapper interstitial, not the raw artifact
    await expect(page.locator(".moira-interstitial, .moira-branding-footer").first()).toBeVisible();
    expect(page.url().replace(/\/$/, "")).toBe(origin);
  });

  test("artifact frame is embedded with a script-only sandbox (no same-origin)", async () => {
    // Verify the wrapper embeds the artifact in a sandbox that allows scripts
    // but NOT same-origin (so artifact JS cannot reach the wrapper/footer) and
    // NOT forms/top-navigation/popups.
    const { wrapperFetchUrl, uuid } = await createArtifact(
      "sandbox-attrs.html",
      "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
    );
    const html = await (await fetch(`${wrapperFetchUrl}?ack=1`)).text();
    const iframeTag = html.match(new RegExp(`<iframe[^>]*src="/__frame/${uuid}"[^>]*>`))?.[0] ?? "";
    expect(iframeTag).toContain('sandbox="allow-scripts"');
    expect(iframeTag).not.toContain("allow-same-origin");
    expect(iframeTag).not.toContain("allow-forms");
    expect(iframeTag).not.toContain("allow-top-navigation");
    expect(iframeTag).not.toContain("allow-popups");
  });

  // Frame content is only served to iframe requests (Sec-Fetch-Dest: iframe);
  // top-level requests redirect to the wrapper (B1). Simulate the iframe load.
  const asIframe = { headers: { "Sec-Fetch-Dest": "iframe" } } as const;

  test("frame CSP blocks network egress (connect-src none)", async () => {
    const { frameFetchUrl } = await createArtifact(
      "csp-net.html",
      "<!DOCTYPE html><html><body><h1>net</h1></body></html>",
    );
    const res = await fetch(frameFetchUrl, asIframe);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  test("Moira footer lives in the wrapper, NOT in the artifact frame content", async () => {
    const { wrapperFetchUrl, frameFetchUrl } = await createArtifact(
      "footer-split.html",
      "<!DOCTYPE html><html><body><h1>content</h1></body></html>",
    );

    const wrapper = await (await fetch(`${wrapperFetchUrl}?ack=1`)).text();
    expect(wrapper).toContain("Created with");

    const frame = await (await fetch(frameFetchUrl, asIframe)).text();
    // The artifact content (frame document) must NOT contain Moira branding —
    // two-document split means artifact JS cannot reach/remove the footer.
    expect(frame).not.toContain("Created with Moira");
    expect(frame).not.toContain("moira-branding-footer");
  });

  test("artifact script cannot remove the Moira footer (separate document)", async ({ page }) => {
    const { wrapperUrl } = await createArtifact(
      "footer-attack.html",
      '<!DOCTYPE html><html><body><script>try{top.document.querySelector(".moira-branding-footer")?.remove();}catch(e){}</script></body></html>',
    );

    await page.goto(`${wrapperUrl}?ack=1`);
    // Footer is in the top (wrapper) document and survives the sandboxed frame's
    // attempt (sandbox has no allow-same-origin, so top access throws).
    await expect(page.locator(".moira-branding-footer")).toBeVisible();
    await expect(page.locator(".moira-branding-footer")).toContainText("Created with");
  });

  test("report endpoint records a report via POST and shows confirmation", async () => {
    const { reportFetchUrl } = await createArtifact(
      "reportable.html",
      "<!DOCTYPE html><html><body><h1>report me</h1></body></html>",
    );
    const res = await fetch(reportFetchUrl, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Thanks for the report");
  });

  test("report endpoint rejects GET (state change must be POST)", async () => {
    const { reportFetchUrl } = await createArtifact(
      "report-get.html",
      "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
    );
    const res = await fetch(reportFetchUrl, { method: "GET" });
    // GET is not registered for this route → 404 (Express), never mutates state
    expect(res.status).toBe(404);
  });

  test("admin takedown stops the artifact from being served", async () => {
    const { uuid, wrapperFetchUrl, frameFetchUrl } = await createArtifact(
      "takedown-e2e.html",
      "<!DOCTYPE html><html><body><h1>bad</h1></body></html>",
    );

    // Servable before takedown
    expect((await fetch(`${wrapperFetchUrl}?ack=1`)).status).toBe(200);

    // Admin takes it down via API
    const { DEFAULT_ADMIN_CREDENTIALS } = await import("../utils/mcp-auth.js");
    const adminCookie = await loginViaHttp(
      DEFAULT_ADMIN_CREDENTIALS.email,
      DEFAULT_ADMIN_CREDENTIALS.password,
    );

    const takedown = await fetch(`${FETCH_URL}/api/admin/artifacts/${uuid}/takedown`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `better-auth.session_token=${adminCookie}`,
      },
      body: JSON.stringify({ reason: "e2e abuse test" }),
    });
    expect(takedown.status).toBe(200);

    // Not servable after takedown (wrapper 404; frame 404 even as an iframe load)
    expect((await fetch(`${wrapperFetchUrl}?ack=1`)).status).toBe(404);
    expect((await fetch(frameFetchUrl, { headers: { "Sec-Fetch-Dest": "iframe" } })).status).toBe(
      404,
    );
  });

  test.describe("Wrapper localization (EN/RU)", () => {
    test("wrapper auto-detects Russian from the browser locale", async ({ browser }) => {
      const { wrapperUrl } = await createArtifact(
        "i18n-ru.html",
        "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
      );
      // A browser context with a Russian locale sends Accept-Language: ru.
      const ctx = await browser.newContext({ locale: "ru-RU" });
      const page = await ctx.newPage();
      await page.goto(wrapperUrl);
      // Interstitial shown in Russian
      await expect(page.locator(".moira-interstitial-card h1")).toContainText(
        "Контент создан пользователем",
      );
      // Toggle to switch to English is present (bottom-right)
      await expect(page.locator(".moira-lang-bar .moira-lang-toggle")).toHaveText("EN");
      await ctx.close();
    });

    test("clicking the EN/RU toggle switches and persists the wrapper language", async ({
      browser,
    }) => {
      const { wrapperUrl } = await createArtifact(
        "i18n-toggle.html",
        "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
      );
      // Start English (en-US locale) → interstitial in English, toggle offers RU.
      const ctx = await browser.newContext({ locale: "en-US" });
      const page = await ctx.newPage();
      await page.goto(wrapperUrl);
      await expect(page.locator(".moira-interstitial-card h1")).toContainText(
        "User-generated content",
      );

      // Click the RU toggle → switches to Russian (real in-browser navigation)
      await page.locator(".moira-lang-bar .moira-lang-toggle").click();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.locator(".moira-interstitial-card h1")).toContainText(
        "Контент создан пользователем",
      );

      // The switch set the moira_lang cookie in this browser context (persistence
      // across reloads is covered at the HTTP layer; here we assert the browser
      // received the language cookie from the toggle click).
      const cookies = await ctx.cookies();
      const langCookie = cookies.find((c) => c.name === "moira_lang");
      expect(langCookie?.value).toBe("ru");
      await ctx.close();
    });

    test("acknowledged footer shows a localized Report control and language toggle", async ({
      browser,
    }) => {
      const { wrapperUrl } = await createArtifact(
        "i18n-footer.html",
        "<!DOCTYPE html><html><body><h1>x</h1></body></html>",
      );
      const ctx = await browser.newContext({ locale: "ru-RU" });
      const page = await ctx.newPage();
      await page.goto(`${wrapperUrl}?ack=1`);
      // Footer localized in Russian with Report + toggle
      await expect(page.locator(".moira-branding-footer")).toContainText("Создано с");
      await expect(page.locator(".moira-report-link")).toContainText("Пожаловаться");
      await expect(page.locator(".moira-footer-right .moira-lang-toggle")).toHaveText("EN");
      await ctx.close();
    });
  });
});
