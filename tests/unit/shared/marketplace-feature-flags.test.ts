/**
 * Unit tests for the marketplace feature gating:
 *   - `paidWorkflows` (a deployment-mode feature) is off in every mode.
 *   - `isMarketplaceEnabled()` (a config toggle) defaults by mode and honors
 *     an explicit MARKETPLACE_ENABLED override (so self-host can opt in).
 */

import { describe, it, expect, afterEach } from "@jest/globals";

const originalMode = process.env.DEPLOYMENT_MODE;
const originalMarketplace = process.env.MARKETPLACE_ENABLED;

function restore(): void {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (originalMarketplace === undefined) delete process.env.MARKETPLACE_ENABLED;
  else process.env.MARKETPLACE_ENABLED = originalMarketplace;
}

describe("marketplace feature gating", () => {
  afterEach(async () => {
    restore();
    const { resetFeatureResolver } = await import("@mcp-moira/shared");
    resetFeatureResolver();
  });

  describe("paidWorkflows feature", () => {
    it("is off in self-host mode", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      const { ModeFeatureResolver } = await import("@mcp-moira/shared/config/feature-resolver.js");
      expect(new ModeFeatureResolver().isEnabled("paidWorkflows")).toBe(false);
    });

    it("is off in saas mode too (selling not live yet)", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      const { ModeFeatureResolver } = await import("@mcp-moira/shared/config/feature-resolver.js");
      expect(new ModeFeatureResolver().isEnabled("paidWorkflows")).toBe(false);
    });
  });

  describe("isMarketplaceEnabled config toggle", () => {
    it("defaults off in self-host mode", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      delete process.env.MARKETPLACE_ENABLED;
      const { isMarketplaceEnabled } = await import("@mcp-moira/shared");
      expect(isMarketplaceEnabled()).toBe(false);
    });

    it("defaults on in saas mode", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      delete process.env.MARKETPLACE_ENABLED;
      const { isMarketplaceEnabled } = await import("@mcp-moira/shared");
      expect(isMarketplaceEnabled()).toBe(true);
    });

    it("honors an explicit opt-in in self-host (MARKETPLACE_ENABLED=true)", async () => {
      process.env.DEPLOYMENT_MODE = "self-host";
      process.env.MARKETPLACE_ENABLED = "true";
      const { isMarketplaceEnabled } = await import("@mcp-moira/shared");
      expect(isMarketplaceEnabled()).toBe(true);
    });

    it("honors an explicit opt-out in saas (MARKETPLACE_ENABLED=false)", async () => {
      process.env.DEPLOYMENT_MODE = "saas";
      process.env.MARKETPLACE_ENABLED = "false";
      const { isMarketplaceEnabled } = await import("@mcp-moira/shared");
      expect(isMarketplaceEnabled()).toBe(false);
    });
  });
});
