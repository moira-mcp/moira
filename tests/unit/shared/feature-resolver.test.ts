import { describe, it, expect, afterEach } from "@jest/globals";

const originalDeploymentMode = process.env.DEPLOYMENT_MODE;

async function importResolverModule() {
  return import("@mcp-moira/shared/config/feature-resolver.js");
}

async function importServices() {
  return import("@mcp-moira/shared");
}

function restore(): void {
  if (originalDeploymentMode === undefined) {
    delete process.env.DEPLOYMENT_MODE;
  } else {
    process.env.DEPLOYMENT_MODE = originalDeploymentMode;
  }
}

const FEATURE_EXPECTATIONS = {
  openRegistration: { "self-host": true, saas: true },
  accountApproval: { "self-host": true, saas: false },
  emailVerificationGate: { "self-host": false, saas: true },
  verificationEmailOnSignup: { "self-host": false, saas: true },
  legalConsents: { "self-host": false, saas: true },
  betaNotices: { "self-host": false, saas: true },
  multiUserAdmin: { "self-host": false, saas: true },
  userManagement: { "self-host": true, saas: true },
  socialLogin: { "self-host": false, saas: true },
} as const;

describe("FeatureResolver", () => {
  afterEach(async () => {
    restore();
    const { resetFeatureResolver } = await importServices();
    resetFeatureResolver();
  });

  describe("ModeFeatureResolver default behavior", () => {
    it("resolves the complete self-host feature set", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      for (const [feature, expected] of Object.entries(FEATURE_EXPECTATIONS)) {
        expect(resolver.isEnabled(feature as keyof typeof FEATURE_EXPECTATIONS)).toBe(
          expected["self-host"],
        );
      }
    });

    it("resolves the complete saas feature set", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      for (const [feature, expected] of Object.entries(FEATURE_EXPECTATIONS)) {
        expect(resolver.isEnabled(feature as keyof typeof FEATURE_EXPECTATIONS)).toBe(
          expected.saas,
        );
      }
    });

    it("uses self-host defaults when DEPLOYMENT_MODE is unset", async () => {
      delete process.env.DEPLOYMENT_MODE;
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      expect(resolver.isEnabled("openRegistration")).toBe(true);
      expect(resolver.isEnabled("accountApproval")).toBe(true);
      expect(resolver.isEnabled("emailVerificationGate")).toBe(false);
    });

    it("returns false for an unknown feature (safe default)", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      // Cast: deliberately probing an out-of-type value.
      expect(resolver.isEnabled("nonexistentFeature" as never)).toBe(false);
    });

    it("re-reads the mode on each call (no stale caching)", async () => {
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();

      process.env.DEPLOYMENT_MODE = "self-host";
      expect(resolver.isEnabled("multiUserAdmin")).toBe(false);

      process.env.DEPLOYMENT_MODE = "saas";
      expect(resolver.isEnabled("multiUserAdmin")).toBe(true);
    });
  });

  describe("getFeatureResolver singleton", () => {
    it("returns a ModeFeatureResolver by default", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { getFeatureResolver, ModeFeatureResolver } = await importServices();
      const resolver = getFeatureResolver();
      expect(resolver).toBeInstanceOf(ModeFeatureResolver);
      expect(resolver.isEnabled("legalConsents")).toBe(false);
    });

    it("returns the same cached instance across calls", async () => {
      const { getFeatureResolver } = await importServices();
      expect(getFeatureResolver()).toBe(getFeatureResolver());
    });
  });

  describe("setFeatureResolver override", () => {
    it("swaps in a custom resolver for all subsequent calls", async () => {
      const { getFeatureResolver, setFeatureResolver } = await importServices();
      setFeatureResolver({
        isEnabled: (feature) => feature === "betaNotices",
      });
      const resolver = getFeatureResolver();
      expect(resolver.isEnabled("betaNotices")).toBe(true);
      expect(resolver.isEnabled("openRegistration")).toBe(false);
    });
  });

  describe("resetFeatureResolver", () => {
    it("restores the default resolver after an override", async () => {
      const { getFeatureResolver, setFeatureResolver, resetFeatureResolver, ModeFeatureResolver } =
        await importServices();
      setFeatureResolver({ isEnabled: () => true });
      expect(getFeatureResolver().isEnabled("openRegistration")).toBe(true);

      resetFeatureResolver();
      expect(getFeatureResolver()).toBeInstanceOf(ModeFeatureResolver);
    });
  });
});
