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
 *
 * This test pins the contract those gates depend on: in self-host every gate is
 * OFF (enforcement skipped → MCP client can connect without verification, no
 * consents, admin-only registration), in saas every gate is ON. The HTTP-level
 * saas enforcement is covered by the API suite (which runs the container in saas);
 * here we verify the decision source for BOTH modes in-process, since the running
 * container is fixed to a single mode.
 */

import { describe, it, expect, afterEach } from "@jest/globals";

const originalMode = process.env.DEPLOYMENT_MODE;

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
  "socialLogin",
] as const;

describe("auth gating by DEPLOYMENT_MODE", () => {
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    const { resetFeatureResolver } = await import("@mcp-moira/shared");
    resetFeatureResolver();
  });

  it("self-host: every auth gate is OFF (enforcement skipped)", async () => {
    const resolver = await resolverFor("self-host");
    for (const feature of AUTH_GATE_FEATURES) {
      expect(resolver.isEnabled(feature)).toBe(false);
    }
  });

  it("saas: every auth gate is ON (enforcement applied)", async () => {
    const resolver = await resolverFor("saas");
    for (const feature of AUTH_GATE_FEATURES) {
      expect(resolver.isEnabled(feature)).toBe(true);
    }
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
});
