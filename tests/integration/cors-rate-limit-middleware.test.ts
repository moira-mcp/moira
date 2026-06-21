/**
 * Integration tests for the network middleware: CORS origin allowlist and the
 * IPv6-safe rate-limit key generator.
 *
 * CORS: the API must reflect only allowlisted origins (own origin, localhost,
 * EXTRA_TRUSTED_ORIGINS, CORS_ALLOWED_ORIGINS) instead of reflecting any origin.
 * A request from an allowed origin receives Access-Control-Allow-Origin; a
 * request from a disallowed origin does not.
 *
 * Rate limit: the per-artifact limiter's IP fallback must run client IPs through
 * ipKeyGenerator. A raw req.ip fallback trips express-rate-limit's
 * ERR_ERL_KEY_GEN_IPV6 validation for IPv6 clients; this guards the regression.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import express from "express";
import request from "supertest";

const IPV6_CLIENT = "2001:db8:85a3:8d3:1319:8a2e:370:7348";
const ALLOWED_EXTERNAL = "https://app.allowed.example.com";
const DENIED_EXTERNAL = "https://evil.example.com";

describe("CORS origin allowlist", () => {
  const originalCorsList = process.env.CORS_ALLOWED_ORIGINS;

  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = ALLOWED_EXTERNAL;
  });

  afterAll(() => {
    if (originalCorsList === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsList;
  });

  async function makeCorsApp() {
    // Import after env is set so the allowlist is built with CORS_ALLOWED_ORIGINS.
    const mod = await import("../../packages/web-backend/src/middleware/cors-middleware.js");
    const app = express();
    app.use(mod.setupCorsMiddleware());
    app.get("/api/ping", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("reflects an allowlisted external origin", async () => {
    const app = await makeCorsApp();
    const res = await request(app).get("/api/ping").set("Origin", ALLOWED_EXTERNAL);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_EXTERNAL);
  });

  it("allows localhost origins by default", async () => {
    const app = await makeCorsApp();
    const res = await request(app).get("/api/ping").set("Origin", "http://localhost:4200");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4200");
  });

  it("does not reflect a disallowed external origin", async () => {
    const app = await makeCorsApp();
    const res = await request(app).get("/api/ping").set("Origin", DENIED_EXTERNAL);
    // The request itself still completes (CORS is enforced by the browser), but
    // no Access-Control-Allow-Origin header is emitted, so a browser blocks it.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows requests without an Origin header (non-browser clients)", async () => {
    const app = await makeCorsApp();
    const res = await request(app).get("/api/ping");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("rate-limit IPv6 key generation", () => {
  it("serves an IPv6 client without ERR_ERL_KEY_GEN_IPV6", async () => {
    const mod = await import("../../packages/web-backend/src/middleware/rate-limit-middleware.js");

    const app = express();
    app.set("trust proxy", true);
    app.use(mod.artifactViewLimiter);
    app.get("/", (req, res) => res.json({ ip: req.ip }));

    const res = await request(app).get("/").set("X-Forwarded-For", IPV6_CLIENT);
    expect(res.status).toBe(200);
    expect(res.body.ip).toBe(IPV6_CLIENT);
  });
});
