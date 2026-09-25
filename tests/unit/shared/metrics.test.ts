/**
 * Unit tests for the HTTP metrics middleware: the `route` label must come from the Express route
 * that handled the request, so the label set stays bounded no matter which paths clients request.
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  metricsMiddleware,
  UNMATCHED_ROUTE,
} from "@mcp-moira/shared";
import { asyncHandler } from "../../../packages/web-backend/src/middleware/error-middleware.js";

async function recordedRoutes(): Promise<string[]> {
  const { values } = await httpRequestsTotal.get();
  return values.map((value) => String(value.labels.route));
}

async function recordedSeries(): Promise<Array<Record<string, string | number>>> {
  const { values } = await httpRequestsTotal.get();
  return values.map((value) => ({ ...value.labels }));
}

async function histogramRoutes(): Promise<Set<string>> {
  const { values } = await httpRequestDurationSeconds.get();
  return new Set(values.map((value) => String(value.labels.route)));
}

function makeApp() {
  const app = express();
  app.use(metricsMiddleware());

  const workflows = express.Router();
  workflows.get("/", (_req, res) => res.json([]));
  workflows.get("/:id", (req, res) => res.json({ id: req.params.id }));
  workflows.get(
    "/:id/boom",
    asyncHandler(async () => {
      throw new Error("handler failed");
    }),
  );
  workflows.get("/:id/fall", (_req, _res, next) => next());
  app.use("/api/workflows", workflows);

  app.use("/api/*apiPath", (_req, res) => {
    res.status(404).json({ error: "ENDPOINT_NOT_FOUND" });
  });
  app.use((_req, res) => {
    res.status(404).send("not found");
  });
  app.use((_err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "INTERNAL" });
  });
  return app;
}

describe("HTTP metrics route label", () => {
  beforeEach(() => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
  });

  it("records every unknown path under one constant, so scanners cannot add series", async () => {
    const app = makeApp();
    const scannerPaths = [
      "/.well-known/about.php",
      "/api/.aws.7z",
      "/api/.aws.bz2",
      "/.well-known/pki-validation/index.php",
      "/wp-login.php",
      "/api/v1/users/12345",
    ];
    for (const path of scannerPaths) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
    }

    expect(await recordedRoutes()).toEqual([UNMATCHED_ROUTE]);
    expect(await histogramRoutes()).toEqual(new Set([UNMATCHED_ROUTE]));
  });

  it("records a parameterised route as its template, one series for every id", async () => {
    const app = makeApp();
    for (const id of ["1", "550e8400-e29b-41d4-a716-446655440000", "short", "Z0d6YnYHXwf2ieBe"]) {
      await request(app).get(`/api/workflows/${id}`).expect(200);
    }

    expect(await recordedSeries()).toEqual([
      { method: "GET", route: "/api/workflows/:id", status_code: "200" },
    ]);
  });

  it("records one template whatever letter case the client sends in the mount path", async () => {
    const app = makeApp();
    for (const path of ["/api/workflows/1", "/API/Workflows/1", "/api/WORKFLOWS/1"]) {
      await request(app).get(path).expect(200);
    }

    expect(await recordedRoutes()).toEqual(["/api/workflows/:id"]);
  });

  it("records a router's root route as the mount path", async () => {
    await request(makeApp()).get("/api/workflows").expect(200);

    expect(await recordedRoutes()).toEqual(["/api/workflows"]);
  });

  it("keeps the full mounted template when the handler fails and the app error handler responds", async () => {
    await request(makeApp()).get("/api/workflows/draft-7/boom").expect(500);

    expect(await recordedSeries()).toEqual([
      { method: "GET", route: "/api/workflows/:id/boom", status_code: "500" },
    ]);
  });

  it("never records the raw path when a matched route passes the request on to a catch-all", async () => {
    const app = makeApp();
    for (const id of ["alpha", "beta", "gamma"]) {
      await request(app).get(`/api/workflows/${id}/fall`).expect(404);
    }

    expect(await recordedSeries()).toEqual([
      { method: "GET", route: "/api/workflows/:id/fall", status_code: "404" },
    ]);
  });
});
