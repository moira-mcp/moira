/**
 * API tests for the server-rendered public marketplace pages (/explore, /w/:handle/:slug,
 * /sitemap.xml). Asserts the pages are crawlable HTML COMPONENT-rendered fresh from the
 * live DB (Step 11 render package, not the interim string templates): a flow published
 * moments earlier appears in the gallery, the detail page, and the sitemap with NO
 * rebuild, the detail page carries JSON-LD structured data, the page is readable with JS
 * disabled, and it ships the hydration bootstrap (bundle ref + an escaped initial-data
 * island that a malicious title cannot break out of).
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const PUBLISHER = {
  email: `mp-pages-${Date.now()}@example.com`,
  password: "TestPass123!",
  name: "MP Pages Publisher",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

const FLOW_NAME = `Pages SSR Flow ${Date.now()}`;
let userCookie = "";
let startRef = ""; // "handle/slug"

beforeAll(async () => {
  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  const adminCookie = adminLogin.headers.get("set-cookie") || "";

  const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(PUBLISHER),
  });
  const signUpData = (await signUp.json()) as { user?: { id: string } };
  if (!signUpData?.user?.id) throw new Error(`signup failed: ${JSON.stringify(signUpData)}`);
  await fetch(`${BASE_URL}/api/admin/users/${signUpData.user.id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });
  const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: PUBLISHER.email, password: PUBLISHER.password }),
  });
  userCookie = login.headers.get("set-cookie") || "";

  // Create + publish a workflow
  const createRes = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "SSR page test flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const createData = (await createRes.json()) as {
    data?: { workflowId?: string; id?: string };
    id?: string;
  };
  const workflowId = createData.data?.workflowId ?? createData.data?.id ?? createData.id;
  if (!workflowId) throw new Error(`create failed: ${JSON.stringify(createData)}`);

  const publishRes = await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userCookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
  const publishData = (await publishRes.json()) as { data?: { startRef?: string } };
  startRef = publishData.data?.startRef ?? "";
  if (!startRef) throw new Error(`publish failed: ${JSON.stringify(publishData)}`);
});

describe("Public marketplace pages (SSR)", () => {
  test("GET /explore renders crawlable HTML listing the just-published flow (no rebuild)", async () => {
    const res = await fetch(`${BASE_URL}/explore`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toContain("max-age=60"); // anon → publicly cacheable
    const html = await res.text();
    expect(html).toContain("<title>Explore workflows");
    expect(html).toContain(FLOW_NAME); // published moments ago → present immediately
    expect(html).toContain(`/w/${startRef}`); // links to the detail page
    // COMPONENT-rendered via the render package (Step 11), NOT the interim string
    // templates: the markup carries the package's semantic component hooks…
    expect(html).toContain('data-mp="explore"');
    expect(html).toContain('<div class="mp-wrap" id="root">');
    // …and the interim string-template markers are gone (migrated, not duplicated).
    expect(html).not.toContain('<ul class="flows">');
    expect(html).not.toContain('<li class="flow">');
  });

  test("GET /explore is readable with JS disabled and ships the hydration bootstrap", async () => {
    const html = await (await fetch(`${BASE_URL}/explore`)).text();
    // Progressive enhancement: the flow content is present in the static HTML (no JS run).
    expect(html).toContain(FLOW_NAME);
    expect(html).toContain(`href="http://localhost`); // real crawlable <a href> to detail
    // Hydration bootstrap: a stable-named bundle ref + the escaped initial-data island.
    expect(html).toMatch(/<script src="\/(app\/)?marketplace-hydrate\.js" defer><\/script>/);
    expect(html).toContain('<script id="mp-bootstrap" type="application/json">');
    // The island carries the exact view-model the server rendered (anonymous viewer).
    const island = html.match(/<script id="mp-bootstrap"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(island).toBeTruthy();
    const data = JSON.parse(island as string) as {
      page: string;
      viewer: unknown;
      gallery?: { items: { title: string }[] };
    };
    expect(data.page).toBe("explore");
    expect(data.viewer).toBeNull(); // Step 11 = anonymous viewer
    expect(data.gallery?.items.some((i) => i.title === FLOW_NAME)).toBe(true);
  });

  test("GET /w/:handle/:slug renders the detail page with JSON-LD structured data", async () => {
    const res = await fetch(`${BASE_URL}/w/${startRef}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain(FLOW_NAME);
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain("application/ld+json");
    expect(html).toContain('"@type":"SoftwareApplication"');
  });

  test("GET /sitemap.xml lists the flow's canonical /w/ URL, fresh from the DB", async () => {
    const res = await fetch(`${BASE_URL}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/xml/);
    const xml = await res.text();
    expect(xml).toContain("/explore</loc>");
    expect(xml).toContain(`/w/${startRef}</loc>`);
  });

  test("GET /w/unknown/unknown returns a 404 page (not the SPA)", async () => {
    const res = await fetch(`${BASE_URL}/w/nobody/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  test("a malicious summary is HTML-escaped and cannot break out of the JSON-LD script", async () => {
    // Publish a flow whose summary contains a script-injection payload.
    const create = await fetch(`${BASE_URL}/api/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        workflow: {
          metadata: { name: `XSS Flow ${Date.now()}`, version: "1.0.0", description: "x" },
          nodes: [
            { id: "start", type: "start", connections: { default: "end" } },
            { id: "end", type: "end" },
          ],
        },
      }),
    });
    const createData = (await create.json()) as { data?: { workflowId?: string } };
    const payload = `</script><script>alert(1)</script><b>pwn</b>`;
    const publish = await fetch(`${BASE_URL}/api/marketplace/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userCookie },
      body: JSON.stringify({
        workflowId: createData.data?.workflowId,
        category: "development",
        summary: payload,
      }),
    });
    const xssRef = ((await publish.json()) as { data?: { startRef?: string } }).data?.startRef;
    expect(xssRef).toBeTruthy();

    const html = await (await fetch(`${BASE_URL}/w/${xssRef}`)).text();
    // The raw payload must NOT appear verbatim anywhere (HTML body, JSON-LD, or the
    // hydration initial-data island).
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>pwn</b>");
    // It must appear in escaped form (HTML body) and <-escaped (JSON-LD + the island).
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("\\u003c/script>");
    // The bootstrap island is present, carries the malicious summary only in <-escaped
    // form, and still parses as JSON (the payload cannot break out of the <script>).
    const island = html.match(/<script id="mp-bootstrap"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    expect(island).toBeTruthy();
    expect(island).toContain("\\u003c/script>"); // </script> in the summary is neutralized
    const parsed = JSON.parse(island as string) as { page: string; detail?: { summary: string } };
    expect(parsed.page).toBe("detail");
    expect(parsed.detail?.summary).toBe(payload); // round-trips intact as DATA, never executed
  });

  test("GET /w/:handle/:slug ships the hydration bootstrap (bundle + detail island)", async () => {
    const html = await (await fetch(`${BASE_URL}/w/${startRef}`)).text();
    // Component-rendered detail (render package), not the interim string template.
    expect(html).toContain('data-mp="detail"');
    expect(html).not.toContain('<div class="detail">'); // interim marker gone
    // Hydration bootstrap present on the detail page too.
    expect(html).toMatch(/<script src="\/(app\/)?marketplace-hydrate\.js" defer><\/script>/);
    const island = html.match(/<script id="mp-bootstrap"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    const data = JSON.parse(island as string) as {
      page: string;
      viewer: unknown;
      detail?: { title: string };
    };
    expect(data.page).toBe("detail");
    expect(data.viewer).toBeNull();
    expect(data.detail?.title).toBe(FLOW_NAME);
  });
});
