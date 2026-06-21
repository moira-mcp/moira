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

// All SaaS-gated features, with expected on/off per mode.
const SAAS_FEATURES = [
  "openRegistration",
  "emailVerificationGate",
  "verificationEmailOnSignup",
  "legalConsents",
  "betaNotices",
  "multiUserAdmin",
  "socialLogin",
] as const;

describe("FeatureResolver", () => {
  afterEach(async () => {
    restore();
    const { resetFeatureResolver } = await importServices();
    resetFeatureResolver();
  });

  describe("ModeFeatureResolver default behavior", () => {
    it("disables every SaaS feature in self-host mode", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      for (const feature of SAAS_FEATURES) {
        expect(resolver.isEnabled(feature)).toBe(false);
      }
    });

    it("enables every SaaS feature in saas mode", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      for (const feature of SAAS_FEATURES) {
        expect(resolver.isEnabled(feature)).toBe(true);
      }
    });

    it("uses self-host defaults when DEPLOYMENT_MODE is unset", async () => {
      delete process.env.DEPLOYMENT_MODE;
      const { ModeFeatureResolver } = await importResolverModule();
      const resolver = new ModeFeatureResolver();
      expect(resolver.isEnabled("openRegistration")).toBe(false);
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
