/**
 * Integration: the REAL GET /api/features route handler reports the public-store
 * promotion gate (Step 15) — closing the gap that the e2e suite proves the
 * OFF/canonical-store cases via a mocked endpoint. This boots the actual route
 * in-process (no container) and toggles env so the handler's own getters decide:
 *
 *   - a non-store origin → publicStore.promotionEnabled true (in BOTH marketplace
 *     flag states — the gate is orthogonal to MARKETPLACE_ENABLED);
 *   - the canonical store origin (own origin == MARKETPLACE_PUBLIC_URL) → false.
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import express from "express";
import request from "supertest";

const ORIG = {
  host: process.env.MOIRA_HOST,
  storeUrl: process.env.MARKETPLACE_PUBLIC_URL,
  marketplaceEnabled: process.env.MARKETPLACE_ENABLED,
};

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function makeFeaturesApp() {
  // Import after env is set; the handler resolves the gate per request from env.
  const mod = await import("../../packages/web-backend/src/routes/features.js");
  const app = express();
  app.use(express.json());
  app.use("/api/features", mod.featuresRoutes);
  return app;
}

interface FeaturesBody {
  success: boolean;
  data: {
    features: Record<string, boolean>;
    publicStore: { promotionEnabled: boolean; url: string };
  };
}

describe("GET /api/features — public-store promotion gate (real handler)", () => {
  afterEach(() => {
    restore("MOIRA_HOST", ORIG.host);
    restore("MARKETPLACE_PUBLIC_URL", ORIG.storeUrl);
    restore("MARKETPLACE_ENABLED", ORIG.marketplaceEnabled);
  });

  it("reports promotionEnabled=true with the default store URL for a non-store origin", async () => {
    process.env.MOIRA_HOST = "selfhost.example.com";
    delete process.env.MARKETPLACE_PUBLIC_URL; // defaults to https://moira-mcp.com

    const app = await makeFeaturesApp();
    const res = await request(app).get("/api/features");
    expect(res.status).toBe(200);

    const body = res.body as FeaturesBody;
    expect(body.success).toBe(true);
    expect(body.data.publicStore).toEqual({
      promotionEnabled: true,
      url: "https://moira-mcp.com",
    });
  });

  it("keeps promotionEnabled=true in BOTH marketplace flag states (orthogonal gate)", async () => {
    process.env.MOIRA_HOST = "selfhost.example.com";
    delete process.env.MARKETPLACE_PUBLIC_URL;

    const app = await makeFeaturesApp();

    process.env.MARKETPLACE_ENABLED = "false";
    let body = (await request(app).get("/api/features")).body as FeaturesBody;
    expect(body.data.features.marketplace).toBe(false);
    expect(body.data.publicStore.promotionEnabled).toBe(true);

    process.env.MARKETPLACE_ENABLED = "true";
    body = (await request(app).get("/api/features")).body as FeaturesBody;
    expect(body.data.features.marketplace).toBe(true);
    expect(body.data.publicStore.promotionEnabled).toBe(true);
  });

  it("reports promotionEnabled=false on the canonical store (own origin == store URL)", async () => {
    process.env.MOIRA_HOST = "moira-mcp.com";
    delete process.env.MARKETPLACE_PUBLIC_URL; // store URL == own origin

    const app = await makeFeaturesApp();
    const res = await request(app).get("/api/features");
    expect(res.status).toBe(200);

    const body = res.body as FeaturesBody;
    expect(body.data.publicStore.promotionEnabled).toBe(false);
    expect(body.data.publicStore.url).toBe("https://moira-mcp.com");
  });
});
