/**
 * Integration: the public gallery route's filter param parsing
 * (GET /api/public/marketplace). The route's responsibility is the param → query
 * mapping for TWO independent literal-`true` booleans: ?official=true →
 * getGallery({ official: true }) (the canonical owner-based Official filter) and
 * ?verified=true → getGallery({ verified: true }) (the distinct trust filter). ANY other
 * value (absent / false / arbitrary) leaves each filter OFF (undefined).
 *
 * The FILTER LOGIC (which rows match) is covered at the service level in
 * marketplace-official-flows.test.ts; here we assert ONLY the route mapping — its
 * distinct responsibility — by mounting the real router over a stubbed marketplace
 * service that records the query it receives (no DB, fully isolated).
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

import type { GalleryQuery, GalleryPage } from "@mcp-moira/shared";

// Records the query the route passes to getGallery; returns an empty page.
const getGallery = jest.fn(
  async (query: GalleryQuery = {}): Promise<GalleryPage> => ({
    items: [],
    total: 0,
    limit: query.limit ?? 24,
    offset: query.offset ?? 0,
    sort: query.sort ?? "recent",
  }),
);

// Override ONLY getMarketplaceService while preserving every other real export
// (error-middleware and friends import AuthenticationError, etc. from the same module,
// so the mock must spread the real namespace rather than replace it wholesale).
const actualShared = await import("@mcp-moira/shared");
jest.unstable_mockModule("@mcp-moira/shared", () => ({
  __esModule: true,
  ...actualShared,
  getMarketplaceService: () => ({ getGallery }),
}));

const { marketplacePublicRoutes } =
  await import("../../packages/web-backend/src/routes/marketplace-public.js");

function makeApp(): express.Express {
  const app = express();
  app.use("/api/public/marketplace", marketplacePublicRoutes);
  return app;
}

/** The query object the route handed to getGallery on its single call. */
function lastQuery(): GalleryQuery {
  expect(getGallery).toHaveBeenCalledTimes(1);
  return getGallery.mock.calls[0][0] as GalleryQuery;
}

describe("GET /api/public/marketplace — Official/verified filter param parsing", () => {
  beforeEach(() => getGallery.mockClear());

  it("?official=true → getGallery({ official: true }) (canonical Official filter, owner-based)", async () => {
    await request(makeApp()).get("/api/public/marketplace?official=true").expect(200);
    expect(lastQuery().official).toBe(true);
    expect(lastQuery().verified).toBeUndefined();
  });

  it("?verified=true → getGallery({ verified: true }) (distinct trust filter, not the Official set)", async () => {
    await request(makeApp()).get("/api/public/marketplace?verified=true").expect(200);
    expect(lastQuery().verified).toBe(true);
    expect(lastQuery().official).toBeUndefined();
  });

  it("no filter param → both official and verified undefined (gallery unfiltered)", async () => {
    await request(makeApp()).get("/api/public/marketplace").expect(200);
    expect(lastQuery().official).toBeUndefined();
    expect(lastQuery().verified).toBeUndefined();
  });

  it("?official=false → official is undefined (only the literal 'true' enables the filter)", async () => {
    await request(makeApp()).get("/api/public/marketplace?official=false").expect(200);
    expect(lastQuery().official).toBeUndefined();
  });
});
