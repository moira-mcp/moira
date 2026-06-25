import { describe, it, expect, afterEach } from "@jest/globals";

/**
 * Public-store promotion gate (Step 15 of the marketplace build).
 *
 * The promotion gate is orthogonal to the local `MARKETPLACE_ENABLED` feature:
 * it depends ONLY on deployment topology — whether this instance's own origin
 * matches the public store's origin. A self-host install (origin != store)
 * promotes the store in BOTH marketplace-flag states; the canonical store
 * suppresses self-promotion.
 */

const ORIG = {
  host: process.env.MOIRA_HOST,
  storeUrl: process.env.MARKETPLACE_PUBLIC_URL,
  marketplaceEnabled: process.env.MARKETPLACE_ENABLED,
};

function set(name: keyof typeof ORIG, key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function importEnvModule() {
  return import("@mcp-moira/shared/config/env.js");
}

describe("public-store promotion gate", () => {
  afterEach(() => {
    set("host", "MOIRA_HOST", ORIG.host);
    set("storeUrl", "MARKETPLACE_PUBLIC_URL", ORIG.storeUrl);
    set("marketplaceEnabled", "MARKETPLACE_ENABLED", ORIG.marketplaceEnabled);
  });

  describe("getMarketplacePublicUrl()", () => {
    it("defaults to the canonical hosted store when unset", async () => {
      delete process.env.MARKETPLACE_PUBLIC_URL;
      const { getMarketplacePublicUrl, DEFAULT_MARKETPLACE_PUBLIC_URL } = await importEnvModule();
      expect(getMarketplacePublicUrl()).toBe(DEFAULT_MARKETPLACE_PUBLIC_URL);
      expect(DEFAULT_MARKETPLACE_PUBLIC_URL).toBe("https://moira-mcp.com");
    });

    it("honors the MARKETPLACE_PUBLIC_URL override (trimmed)", async () => {
      process.env.MARKETPLACE_PUBLIC_URL = "  https://store.example.com  ";
      const { getMarketplacePublicUrl } = await importEnvModule();
      expect(getMarketplacePublicUrl()).toBe("https://store.example.com");
    });
  });

  describe("isPublicStorePromotionEnabled()", () => {
    it("is true for a self-host instance whose origin differs from the store", async () => {
      process.env.MOIRA_HOST = "localhost:8078";
      delete process.env.MARKETPLACE_PUBLIC_URL; // defaults to https://moira-mcp.com
      const { isPublicStorePromotionEnabled } = await importEnvModule();
      expect(isPublicStorePromotionEnabled()).toBe(true);
    });

    it("stays true regardless of the local marketplace flag (orthogonal gates)", async () => {
      process.env.MOIRA_HOST = "my-team.example.com";
      delete process.env.MARKETPLACE_PUBLIC_URL;
      const { isPublicStorePromotionEnabled, isMarketplaceEnabled } = await importEnvModule();

      process.env.MARKETPLACE_ENABLED = "false";
      expect(isMarketplaceEnabled()).toBe(false);
      expect(isPublicStorePromotionEnabled()).toBe(true);

      process.env.MARKETPLACE_ENABLED = "true";
      expect(isMarketplaceEnabled()).toBe(true);
      expect(isPublicStorePromotionEnabled()).toBe(true);
    });

    it("is false on the canonical store itself (no self-promotion)", async () => {
      process.env.MOIRA_HOST = "moira-mcp.com";
      delete process.env.MARKETPLACE_PUBLIC_URL; // store URL == own origin
      const { isPublicStorePromotionEnabled } = await importEnvModule();
      expect(isPublicStorePromotionEnabled()).toBe(false);
    });

    it("is false when a custom store URL matches the instance's own origin", async () => {
      process.env.MOIRA_HOST = "store.example.com";
      process.env.MARKETPLACE_PUBLIC_URL = "https://store.example.com";
      const { isPublicStorePromotionEnabled } = await importEnvModule();
      expect(isPublicStorePromotionEnabled()).toBe(false);
    });

    it("compares by origin only — path, trailing slash and case are ignored", async () => {
      process.env.MOIRA_HOST = "moira-mcp.com";
      process.env.MARKETPLACE_PUBLIC_URL = "https://MOIRA-MCP.com/explore/";
      const { isPublicStorePromotionEnabled } = await importEnvModule();
      expect(isPublicStorePromotionEnabled()).toBe(false);
    });
  });
});
