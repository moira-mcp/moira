/**
 * API tests for the SESSION-AWARE server-rendered public marketplace pages
 * (/explore, /w/:handle/:slug). The pages read the Better Auth session from the request
 * cookie and render two variants:
 *
 *   - Anonymous (no/invalid/expired session) → `viewer = null`, all-false annotations,
 *     a "Sign in" header control, and the CDN-cacheable fast path
 *     (`Cache-Control: public, max-age=60`, `Vary` includes `Accept-Language`+`Cookie`).
 *   - Signed-in → `viewer = {userId, handle}`, real library/own annotations, an account
 *     chip + "Sign out", and `Cache-Control: private, no-store` (`Vary: Cookie`).
 *
 * These tests assert the variant selection, the cache/vary headers, per-viewer library
 * vs ownership pills, the absence of cross-user leakage, graceful degradation of an
 * invalid session to the anonymous variant, and server-side language selection
 * (`?lang=ru`, `Accept-Language`).
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

const stamp = Date.now();

interface SeededUser {
  email: string;
  password: string;
  name: string;
  acceptedTermsAt: string;
  acceptedNotRussianResidentAt: string;
}

function makeUser(label: string): SeededUser {
  return {
    // (Re)seeded uniquely at the start of beforeAll so a retried setup provisions a new
    // user instead of colliding with the prior attempt's email (422 USER_ALREADY_EXISTS).
    email: "",
    password: "TestPass123!",
    name: `MP Session ${label}`,
    acceptedTermsAt: new Date().toISOString(),
    acceptedNotRussianResidentAt: new Date().toISOString(),
  };
}

const USER_A = makeUser("a");
const USER_B = makeUser("b");
const FLOW_NAME = `Session SSR Flow ${stamp}`;

let adminCookie = "";
let userACookie = "";
let userBCookie = "";
let userAHandle = ""; // the @handle the account chip renders for USER_A
let startRef = ""; // "handle/slug" of USER_A's published listing
let listingId = ""; // listing id needed to install (add to library)

/**
 * Sign up + verify + sign in a user, returning their session cookie + id. Bounded-retries
 * the auth endpoints: the api suite runs many auth-heavy specs in parallel and the
 * sign-up/sign-in routes are rate-limited, so a single attempt can transiently fail under
 * load. Surfaces the real status/body if every attempt fails.
 */
async function provisionUser(user: SeededUser): Promise<{ cookie: string; id: string }> {
  let id = "";
  let lastSignUp = "";
  for (let attempt = 0; attempt < 5 && !id; attempt++) {
    const signUp = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });
    const data = (await signUp.json().catch(() => ({}))) as { user?: { id: string } };
    if (data.user?.id) {
      id = data.user.id;
      break;
    }
    lastSignUp = `status=${signUp.status} body=${JSON.stringify(data)}`;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  if (!id) throw new Error(`signup failed after retries: ${lastSignUp}`);

  await fetch(`${BASE_URL}/api/admin/users/${id}/verify-email`, {
    method: "POST",
    headers: { Cookie: adminCookie },
  });

  let cookie = "";
  for (let attempt = 0; attempt < 5 && !cookie; attempt++) {
    const login = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    if (/(?:__Secure-)?better-auth\.session_token=/.test(setCookie)) {
      cookie = setCookie;
      break;
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  if (!cookie) throw new Error("sign-in failed after retries");

  return { cookie, id };
}

/** Parse the `#mp-bootstrap` initial-data island out of a rendered page. */
function bootstrap(html: string): {
  page: string;
  viewer: { userId?: string; handle?: string | null } | null;
} {
  const island = html.match(/<script id="mp-bootstrap"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!island) throw new Error("no #mp-bootstrap island in page");
  return JSON.parse(island) as {
    page: string;
    viewer: { userId?: string; handle?: string | null } | null;
  };
}

beforeAll(async () => {
  // Fresh unique emails per setup run (survives a retried beforeAll without colliding).
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  USER_A.email = `mp-session-a-${uniq}@example.com`;
  USER_B.email = `mp-session-b-${uniq}@example.com`;

  const adminLogin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN_CREDENTIALS),
  });
  adminCookie = adminLogin.headers.get("set-cookie") || "";

  ({ cookie: userACookie } = await provisionUser(USER_A));
  ({ cookie: userBCookie } = await provisionUser(USER_B));

  // USER_A publishes a flow.
  const createRes = await fetch(`${BASE_URL}/api/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userACookie },
    body: JSON.stringify({
      workflow: {
        metadata: { name: FLOW_NAME, version: "1.0.0", description: "Session SSR test flow" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      },
    }),
  });
  const createData = (await createRes.json()) as { data?: { workflowId?: string } };
  const workflowId = createData.data?.workflowId;
  if (!workflowId) throw new Error(`create failed: ${JSON.stringify(createData)}`);

  const publishRes = await fetch(`${BASE_URL}/api/marketplace/listings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userACookie },
    body: JSON.stringify({ workflowId, category: "development" }),
  });
  const publishData = (await publishRes.json()) as {
    data?: { startRef?: string; listing?: { id?: string } };
  };
  startRef = publishData.data?.startRef ?? "";
  listingId = publishData.data?.listing?.id ?? "";
  if (!startRef || !listingId) throw new Error(`publish failed: ${JSON.stringify(publishData)}`);
  // The startRef is `ownerHandle/slug`; the account chip renders `@ownerHandle`.
  userAHandle = startRef.split("/")[0];
  if (!userAHandle) throw new Error("USER_A has no handle");

  // USER_B adds USER_A's listing to USER_B's library (install = add as reference).
  const install = await fetch(`${BASE_URL}/api/marketplace/listings/${listingId}/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: userBCookie },
  });
  if (install.status !== 200) {
    throw new Error(`install failed: ${install.status} ${await install.text()}`);
  }
});

describe("Session-aware public marketplace pages", () => {
  test("anonymous /explore: cacheable fast path, sign-in header, null viewer", async () => {
    const res = await fetch(`${BASE_URL}/explore`);
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=60");
    const vary = res.headers.get("vary") || "";
    expect(vary).toContain("Accept-Language");
    expect(vary).toContain("Cookie");

    const html = await res.text();
    expect(html).toContain('data-mp="sign-in"'); // anonymous header control
    expect(html).not.toContain('data-mp="sign-out"');

    // The bootstrap island carries the anonymous view-model (viewer = null).
    expect(bootstrap(html).viewer).toBeNull();
  });

  test("signed-in /explore (USER_A): private no-store, account chip, viewer set", async () => {
    const res = await fetch(`${BASE_URL}/explore`, { headers: { Cookie: userACookie } });
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).toContain("no-store");
    // Personalized HTML varies by the session cookie.
    expect(res.headers.get("vary") || "").toContain("Cookie");

    const html = await res.text();
    expect(html).toContain('data-mp="sign-out"'); // signed-in header control
    expect(html).not.toContain('data-mp="sign-in"');
    // The account chip renders the viewer's @handle (React splits the static "@" and the
    // dynamic handle with a comment marker, so assert on the handle text + the chip hook).
    expect(html).toContain('data-mp="account-handle"');
    expect(html).toContain(userAHandle);

    const island = bootstrap(html);
    expect(island.viewer).not.toBeNull();
    expect(island.viewer?.userId).toBeTruthy();
    expect(island.viewer?.handle).toBe(userAHandle); // the chip handle, asserted on data
  });

  test("owner sees their own-pill on their listing's detail page", async () => {
    const html = await (
      await fetch(`${BASE_URL}/w/${startRef}`, { headers: { Cookie: userACookie } })
    ).text();
    expect(html).toContain('data-mp="own-pill"');
    expect(html).not.toContain('data-mp="library-pill"'); // owner is not "in library"
  });

  test("no cross-user leakage: library-pill for the adder, own-pill for the owner", async () => {
    // USER_B added USER_A's listing → library-pill, NOT own-pill (USER_B is not the owner).
    const bHtml = await (
      await fetch(`${BASE_URL}/w/${startRef}`, { headers: { Cookie: userBCookie } })
    ).text();
    expect(bHtml).toContain('data-mp="library-pill"');
    expect(bHtml).not.toContain('data-mp="own-pill"');
    // USER_B's page is annotated for USER_B: the account chip is USER_B's handle, never
    // USER_A's. (USER_A's handle still appears as the listing OWNER — that's correct —
    // so assert on the personalized viewer in the island, which must be USER_B.)
    expect(bootstrap(bHtml).viewer?.handle).not.toBe(userAHandle);

    // USER_A (owner) → own-pill, NOT library-pill.
    const aHtml = await (
      await fetch(`${BASE_URL}/w/${startRef}`, { headers: { Cookie: userACookie } })
    ).text();
    expect(aHtml).toContain('data-mp="own-pill"');
    expect(aHtml).not.toContain('data-mp="library-pill"');

    // Anonymous → neither pill (no viewer to annotate).
    const anonHtml = await (await fetch(`${BASE_URL}/w/${startRef}`)).text();
    expect(anonHtml).not.toContain('data-mp="own-pill"');
    expect(anonHtml).not.toContain('data-mp="library-pill"');
    expect(anonHtml).toContain('data-mp="signin-cta"'); // anonymous detail action
  });

  test("degraded session: a bogus session cookie renders the anonymous variant", async () => {
    const res = await fetch(`${BASE_URL}/explore`, {
      headers: { Cookie: "better-auth.session_token=invalid" },
    });
    // Invalid/expired session degrades to anonymous — never an error.
    expect(res.status).toBe(200);
    const cacheControl = res.headers.get("cache-control") || "";
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=60");

    const html = await res.text();
    expect(html).toContain('data-mp="sign-in"');
    expect(html).not.toContain('data-mp="sign-out"');
    expect(bootstrap(html).viewer).toBeNull();
  });

  test("language honored server-side: ?lang=ru renders RU chrome and html lang", async () => {
    const res = await fetch(`${BASE_URL}/explore?lang=ru`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("Каталог"); // RU explore title chrome
  });

  test("language honored server-side: Accept-Language: ru renders RU", async () => {
    const html = await (
      await fetch(`${BASE_URL}/explore`, { headers: { "Accept-Language": "ru" } })
    ).text();
    expect(html).toContain('<html lang="ru">');
    expect(html).toContain("Каталог");
  });

  test("default language is English (no lang query, no Accept-Language)", async () => {
    const html = await (await fetch(`${BASE_URL}/explore`)).text();
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('<html lang="ru">');
  });

  test("RU detail threads ?lang=ru into internal links (breadcrumb/brand)", async () => {
    const res = await fetch(`${BASE_URL}/w/${startRef}?lang=ru`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<html lang="ru">');
    // Internal links carry the language so navigation stays in RU (en links stay clean).
    expect(html).toContain("/explore?lang=ru");
  });
});
