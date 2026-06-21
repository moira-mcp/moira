import { describe, it, expect, afterEach } from "@jest/globals";

// Capture original value once, restore after each test.
const originalDeploymentMode = process.env.DEPLOYMENT_MODE;

async function importEnvModule() {
  return import("@mcp-moira/shared/config/env.js");
}

function restore(): void {
  if (originalDeploymentMode === undefined) {
    delete process.env.DEPLOYMENT_MODE;
  } else {
    process.env.DEPLOYMENT_MODE = originalDeploymentMode;
  }
}

describe("DEPLOYMENT_MODE config", () => {
  afterEach(() => {
    restore();
  });

  describe("getDeploymentMode()", () => {
    it("defaults to self-host when unset", async () => {
      delete process.env.DEPLOYMENT_MODE;
      const { getDeploymentMode, DEFAULT_DEPLOYMENT_MODE } = await importEnvModule();
      expect(getDeploymentMode()).toBe("self-host");
      expect(DEFAULT_DEPLOYMENT_MODE).toBe("self-host");
    });

    it("returns self-host when explicitly set", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { getDeploymentMode } = await importEnvModule();
      expect(getDeploymentMode()).toBe("self-host");
    });

    it("returns saas when set to saas", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { getDeploymentMode } = await importEnvModule();
      expect(getDeploymentMode()).toBe("saas");
    });

    it("normalizes case and surrounding whitespace", async () => {
      process.env.DEPLOYMENT_MODE = "  SaaS  ";
      const { getDeploymentMode } = await importEnvModule();
      expect(getDeploymentMode()).toBe("saas");
    });

    it("throws on an unrecognized value instead of silently defaulting", async () => {
      process.env.DEPLOYMENT_MODE = "enterprise";
      const { getDeploymentMode } = await importEnvModule();
      expect(() => getDeploymentMode()).toThrow(/Invalid DEPLOYMENT_MODE "enterprise"/);
    });

    it("lists allowed values in the error message", async () => {
      process.env.DEPLOYMENT_MODE = "bogus";
      const { getDeploymentMode } = await importEnvModule();
      expect(() => getDeploymentMode()).toThrow(/self-host, saas/);
    });
  });

  describe("isSelfHost() / isSaas()", () => {
    it("isSelfHost is true and isSaas is false in self-host mode", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { isSelfHost, isSaas } = await importEnvModule();
      expect(isSelfHost()).toBe(true);
      expect(isSaas()).toBe(false);
    });

    it("isSaas is true and isSelfHost is false in saas mode", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { isSelfHost, isSaas } = await importEnvModule();
      expect(isSaas()).toBe(true);
      expect(isSelfHost()).toBe(false);
    });

    it("defaults to self-host predicates when unset", async () => {
      delete process.env.DEPLOYMENT_MODE;
      const { isSelfHost, isSaas } = await importEnvModule();
      expect(isSelfHost()).toBe(true);
      expect(isSaas()).toBe(false);
    });
  });

  describe("DEPLOYMENT_MODES constant", () => {
    it("contains exactly the two supported modes", async () => {
      const { DEPLOYMENT_MODES } = await importEnvModule();
      expect([...DEPLOYMENT_MODES]).toEqual(["self-host", "saas"]);
    });
  });
});
