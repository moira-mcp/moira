/**
 * Integration: the SERVER-side feature gate on POST /api/marketplace/import (Step 16).
 * Mounts the real authed marketplace router (with a stub auth + the real error
 * middleware) and posts a valid workflow file with MARKETPLACE_ENABLED=false — the
 * endpoint must reject it at the HTTP layer (the local-feature flag governs import),
 * complementing the service-level gate in marketplace-import.test.ts.
 */

import { describe, it, expect, afterAll } from "@jest/globals";
import express from "express";
import request from "supertest";

import { marketplaceAuthedRoutes } from "../../packages/web-backend/src/routes/marketplace-authed.js";
import { setupErrorMiddleware } from "../../packages/web-backend/src/middleware/error-middleware.js";

const ORIG = process.env.MARKETPLACE_ENABLED;

const VALID_FLOW = JSON.stringify({
  metadata: { name: "Gate Flow", version: "1.0.0", description: "d" },
  nodes: [
    { id: "start", type: "start", connections: { default: "end" } },
    { id: "end", type: "end" },
  ],
});

function makeApp() {
  const app = express();
  // Stub the auth middleware that /api/marketplace sits behind in production.
  app.use((req, _res, next) => {
    (req as unknown as { userId: string }).userId = "gate-user";
    next();
  });
  app.use("/api/marketplace", marketplaceAuthedRoutes);
  app.use(setupErrorMiddleware());
  return app;
}

describe("POST /api/marketplace/import — server-side feature gate", () => {
  afterAll(() => {
    if (ORIG === undefined) delete process.env.MARKETPLACE_ENABLED;
    else process.env.MARKETPLACE_ENABLED = ORIG;
  });

  it("returns 404 when the local marketplace feature is disabled (gate enforced server-side)", async () => {
    process.env.MARKETPLACE_ENABLED = "false";
    const res = await request(makeApp())
      .post("/api/marketplace/import")
      .attach("workflow", Buffer.from(VALID_FLOW), {
        filename: "flow.moira.json",
        contentType: "application/json",
      });
    // The route checks the gate first → MarketplaceDisabledError → HTTP 404.
    expect(res.status).toBe(404);
  });

  it("refuses with 404 BEFORE validating the upload — an invalid file when disabled is still 404, not 400", async () => {
    process.env.MARKETPLACE_ENABLED = "false";
    const res = await request(makeApp())
      .post("/api/marketplace/import")
      .attach("workflow", Buffer.from("not json"), {
        filename: "bad.json",
        contentType: "application/json",
      });
    // Gate precedes parse/validation, so the disabled instance never reaches the 400 path.
    expect(res.status).toBe(404);
  });
});
