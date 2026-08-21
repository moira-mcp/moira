/**
 * Integration: auth gating by DEPLOYMENT_MODE.
 *
 * The auth layer (packages/shared/src/auth/better-auth-config.ts and
 * packages/web-backend/src/middleware/auth-middleware.ts) gates four SaaS-specific
 * behaviors through getFeatureResolver().isEnabled(<feature>):
 *   - legalConsents            → /sign-up/email terms+residency enforcement
 *   - emailVerificationGate    → OAuth-token issuance + requireVerifiedAuth (/api/tokens, MCP)
 *   - verificationEmailOnSignup→ emailVerification.sendOnSignUp
 *   - openRegistration         → public /sign-up/email allowed
 *   - accountApproval          → product access waits for admin approval
 *
 * This test pins the mixed-mode contract: self-host opens registration and
 * requires administrator approval while leaving SaaS email/legal gates off;
 * SaaS keeps its existing registration and verification behavior. The HTTP-level
 * saas enforcement is covered by the API suite (which runs the container in saas);
 * here we verify the decision source for BOTH modes in-process, since the running
 * container is fixed to a single mode.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const originalMode = process.env.DEPLOYMENT_MODE;
const originalLoadTestAuth = process.env.ENABLE_LOAD_TEST_AUTH;
const originalLoadTestSecret = process.env.LOAD_TEST_SECRET;

async function resolverFor(mode: "self-host" | "saas") {
  process.env.DEPLOYMENT_MODE = mode;
  const { resetFeatureResolver, getFeatureResolver } = await import("@mcp-moira/shared");
  resetFeatureResolver();
  return getFeatureResolver();
}

// The exact features the auth gates consume.
const AUTH_GATE_FEATURES = [
  "legalConsents",
  "emailVerificationGate",
  "verificationEmailOnSignup",
  "openRegistration",
  "accountApproval",
  "socialLogin",
] as const;

describe("auth gating by DEPLOYMENT_MODE", () => {
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (originalLoadTestAuth === undefined) delete process.env.ENABLE_LOAD_TEST_AUTH;
    else process.env.ENABLE_LOAD_TEST_AUTH = originalLoadTestAuth;
    if (originalLoadTestSecret === undefined) delete process.env.LOAD_TEST_SECRET;
    else process.env.LOAD_TEST_SECRET = originalLoadTestSecret;
    const { resetFeatureResolver } = await import("@mcp-moira/shared");
    resetFeatureResolver();
  });

  it("self-host opens registration behind account approval", async () => {
    const resolver = await resolverFor("self-host");
    expect(resolver.isEnabled("openRegistration")).toBe(true);
    expect(resolver.isEnabled("accountApproval")).toBe(true);
    expect(resolver.isEnabled("legalConsents")).toBe(false);
    expect(resolver.isEnabled("emailVerificationGate")).toBe(false);
    expect(resolver.isEnabled("verificationEmailOnSignup")).toBe(false);
    expect(resolver.isEnabled("socialLogin")).toBe(false);
  });

  it("saas preserves existing auth gates without account approval", async () => {
    const resolver = await resolverFor("saas");
    for (const feature of AUTH_GATE_FEATURES.filter((feature) => feature !== "accountApproval")) {
      expect(resolver.isEnabled(feature)).toBe(true);
    }
    expect(resolver.isEnabled("accountApproval")).toBe(false);
  });

  it("self-host lets MCP/API token issuance proceed without email verification", async () => {
    // emailVerificationGate OFF → requireVerifiedAuth and the OAuth-token hook skip
    // the !emailVerified rejection. This is the MCP-client connection blocker fix.
    const resolver = await resolverFor("self-host");
    expect(resolver.isEnabled("emailVerificationGate")).toBe(false);
  });

  it("saas still requires email verification for token issuance", async () => {
    const resolver = await resolverFor("saas");
    expect(resolver.isEnabled("emailVerificationGate")).toBe(true);
  });

  it("self-host registration requires no legal consents; saas does", async () => {
    expect((await resolverFor("self-host")).isEnabled("legalConsents")).toBe(false);
    expect((await resolverFor("saas")).isEnabled("legalConsents")).toBe(true);
  });

  it("self-host disables GitHub/Google social login; saas enables it", async () => {
    // socialLogin OFF → better-auth socialProviders.{github,google}.enabled is false
    // (regardless of GITHUB_CLIENT_ID/GOOGLE_CLIENT_ID), and the frontend omits the
    // social buttons. saas re-enables it (subject to env-var presence in the backend).
    expect((await resolverFor("self-host")).isEnabled("socialLogin")).toBe(false);
    expect((await resolverFor("saas")).isEnabled("socialLogin")).toBe(true);
  });

  it("only authenticated reserved-domain load-test registration bypasses approval", async () => {
    process.env.DEPLOYMENT_MODE = "self-host";
    process.env.ENABLE_LOAD_TEST_AUTH = "true";
    process.env.LOAD_TEST_SECRET = "integration-load-test-secret";

    const { resetFeatureResolver, getDatabase, user } = await import("@mcp-moira/shared");
    const { auth } = await import("../../packages/web-backend/src/auth.js");
    resetFeatureResolver();

    const suffix = randomUUID();
    const validLoadEmail = `loadtest-${suffix}@load-testing-noverify.local`;
    const invalidSecretEmail = `loadtest-invalid-${suffix}@load-testing-noverify.local`;
    const disabledLoadEmail = `loadtest-disabled-${suffix}@load-testing-noverify.local`;
    const ordinaryEmail = `loadtest-ordinary-${suffix}@example.com`;
    const emails = [validLoadEmail, invalidSecretEmail, disabledLoadEmail, ordinaryEmail];

    const register = (email: string, secret: string) =>
      auth.handler(
        new Request("http://localhost/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Load-Test": secret },
          body: JSON.stringify({ email, password: "LoadTest123!", name: "Load Test Boundary" }),
        }),
      );

    try {
      expect((await register(validLoadEmail, process.env.LOAD_TEST_SECRET)).status).toBe(200);
      expect((await register(invalidSecretEmail, "invalid-secret")).status).toBe(200);
      expect((await register(ordinaryEmail, process.env.LOAD_TEST_SECRET)).status).toBe(200);
      process.env.ENABLE_LOAD_TEST_AUTH = "false";
      expect((await register(disabledLoadEmail, process.env.LOAD_TEST_SECRET)).status).toBe(200);
      process.env.ENABLE_LOAD_TEST_AUTH = "true";

      const stored = await getDatabase()
        .select({
          email: user.email,
          emailVerified: user.emailVerified,
          approvedAt: user.approvedAt,
        })
        .from(user)
        .where(inArray(user.email, emails));
      const byEmail = new Map(stored.map((entry) => [entry.email, entry]));

      expect(byEmail.get(validLoadEmail)).toMatchObject({
        emailVerified: true,
        approvedAt: expect.any(String),
      });
      expect(byEmail.get(invalidSecretEmail)).toMatchObject({
        emailVerified: false,
        approvedAt: null,
      });
      expect(byEmail.get(disabledLoadEmail)).toMatchObject({
        emailVerified: false,
        approvedAt: null,
      });
      expect(byEmail.get(ordinaryEmail)).toMatchObject({
        emailVerified: false,
        approvedAt: null,
      });
    } finally {
      await getDatabase().delete(user).where(inArray(user.email, emails));
    }
  });

  it("blocked SaaS sessions cannot use non-public Better Auth operations", async () => {
    await resolverFor("saas");
    const { resetFeatureResolver, getDatabase, user } = await import("@mcp-moira/shared");
    const { auth } = await import("../../packages/web-backend/src/auth.js");
    resetFeatureResolver();

    const email = `blocked-saas-${randomUUID()}@example.com`;
    const db = getDatabase();

    try {
      const signup = await auth.handler(
        new Request("http://localhost/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email,
            password: "BlockedSaas123!",
            name: "Blocked SaaS Boundary",
            acceptedTermsAt: new Date().toISOString(),
            acceptedNotRussianResidentAt: new Date().toISOString(),
          }),
        }),
      );
      expect(signup.status).toBe(200);
      const cookie = (signup.headers.get("set-cookie") || "").split(";")[0];
      expect(cookie).toBeTruthy();

      const beforeBlock = await auth.handler(
        new Request("http://localhost/api/auth/list-sessions", {
          headers: { Cookie: cookie },
        }),
      );
      expect(beforeBlock.status).toBe(200);

      await db.update(user).set({ blocked: true }).where(eq(user.email, email));

      const afterBlock = await auth.handler(
        new Request("http://localhost/api/auth/list-sessions", {
          headers: { Cookie: cookie },
        }),
      );
      expect(afterBlock.status).toBe(403);
      expect(await afterBlock.json()).toMatchObject({ code: "ACCOUNT_BLOCKED" });
    } finally {
      await db.delete(user).where(eq(user.email, email));
    }
  });
});
