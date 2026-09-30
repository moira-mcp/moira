import { describe, expect, test } from "@jest/globals";
import express, { type Application, type RequestHandler } from "express";
import request from "supertest";
import { MoiraApiServer } from "../../packages/web-backend/src/server.js";
import { requireAuth } from "../../packages/web-backend/src/middleware/auth-middleware.js";
import {
  apiLimiter,
  createRateLimiters,
} from "../../packages/web-backend/src/middleware/rate-limit-middleware.js";

interface RouteLayer {
  route?: { path: string; stack: Array<{ handle: RequestHandler }> };
}

describe("overview stream admission", () => {
  test("the production route limits anonymous reconnects before authentication", async () => {
    const server = new MoiraApiServer();
    const production = (
      server as unknown as { app: Application & { router: { stack: RouteLayer[] } } }
    ).app;
    const route = production.router.stack.find(
      (layer) => layer.route?.path === "/api/executions/overview/stream",
    )!.route!;
    const handlers = route.stack.map((layer) => layer.handle);
    expect(handlers.slice(0, 2)).toEqual([apiLimiter, requireAuth]);

    // Use the registered production order with the same limiter factory enabled under tests.
    // Refusing auth is counted, so requests blocked before auth cannot hide behind a stream cap.
    const enabledLimiter = createRateLimiters({ skipLimits: false, whitelist: [] }).apiLimiter;
    let authCalls = 0;
    const denyAuth: RequestHandler = (_req, res) => {
      authCalls += 1;
      res.status(401).json({ error: "Authentication required" });
    };
    const app = express();
    app.get(
      route.path,
      ...handlers.map((handler) =>
        handler === apiLimiter ? enabledLimiter : handler === requireAuth ? denyAuth : handler,
      ),
    );
    for (let index = 0; index < 100; index += 1) {
      const response = await request(app).get(route.path);
      expect(response.status).toBe(401);
      expect(response.headers["ratelimit-remaining"]).toBe(String(99 - index));
    }
    const blocked = await request(app).get(route.path);
    expect(blocked.status).toBe(429);
    expect(blocked.headers["ratelimit-remaining"]).toBe("0");
    expect(authCalls).toBe(100);
  });
});
