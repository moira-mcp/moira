import express from "express";
import request from "supertest";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { resetFeatureResolver, setFeatureResolver, type Feature } from "@mcp-moira/shared";
import {
  requireCapability,
  requireSelectedCapability,
} from "../../../packages/web-backend/src/middleware/capability-middleware";
import { selectAnalyticsSurfaceCapability } from "../../../packages/web-backend/src/middleware/admin-route-capability";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware";
import { featuresRoutes } from "../../../packages/web-backend/src/routes/features";

afterEach(() => {
  resetFeatureResolver();
  jest.restoreAllMocks();
});

function createApp() {
  const app = express();
  let sideEffects = 0;

  app.use((req, _res, next) => {
    (req as typeof req & { userId: string }).userId = "capability-user";
    next();
  });
  app.use("/api/features", featuresRoutes);
  app.post("/protected", requireCapability("adminAnalytics"), (_req, res) => {
    sideEffects += 1;
    res.status(204).end();
  });
  app.post(
    "/selected/:surface",
    requireSelectedCapability((req) =>
      req.params.surface === "ops" ? "adminOperations" : "operationsDevelopment",
    ),
    (_req, res) => {
      sideEffects += 1;
      res.status(204).end();
    },
  );
  app.use(
    "/api/admin/analytics",
    requireSelectedCapability(selectAnalyticsSurfaceCapability),
    (_req, res) => {
      sideEffects += 1;
      res.status(204).end();
    },
  );
  app.post("/unknown", requireCapability("unknownCapability" as Feature), (_req, res) => {
    sideEffects += 1;
    res.status(204).end();
  });
  app.use(setupErrorMiddleware());

  return { app, sideEffects: () => sideEffects };
}

describe("deployment capability middleware", () => {
  test("one resolver override controls public exposure and authorization", async () => {
    const isEnabled = jest.fn((feature: Feature) => feature === "adminAnalytics");
    setFeatureResolver({ isEnabled });
    const { app, sideEffects } = createApp();

    const features = await request(app).get("/api/features").expect(200);
    expect(features.body.data.features.adminAnalytics).toBe(true);
    expect(features.body.data.features.adminOperations).toBe(false);

    await request(app).post("/protected").expect(204);
    const denied = await request(app).post("/selected/ops").expect(403);
    expect(denied.body.error).toMatchObject({
      code: "ACCESS_DENIED",
      details: { capability: "adminOperations" },
    });
    expect(sideEffects()).toBe(1);
    expect(isEnabled).toHaveBeenCalledWith("adminAnalytics", {
      userId: "capability-user",
    });
  });

  test("disabled, unknown, and resolver-error decisions fail closed before side effects", async () => {
    const { app, sideEffects } = createApp();

    setFeatureResolver({ isEnabled: () => false });
    await request(app).post("/protected").expect(403);
    await request(app).post("/unknown").expect(403);

    setFeatureResolver({
      isEnabled: () => {
        throw new Error("resolver unavailable");
      },
    });
    await request(app).post("/selected/dev").expect(403);
    expect(sideEffects()).toBe(0);
  });

  test("a mixed override permits selected operations and development handlers independently", async () => {
    setFeatureResolver({
      isEnabled: (feature) => feature === "adminOperations" || feature === "operationsDevelopment",
    });
    const { app, sideEffects } = createApp();

    await request(app).post("/protected").expect(403);
    await request(app).post("/selected/ops").expect(204);
    await request(app).post("/selected/dev").expect(204);
    expect(sideEffects()).toBe(2);
  });

  test("case-insensitive analytics routing cannot substitute analytics for operations", async () => {
    const isEnabled = jest.fn((feature: Feature) => feature === "adminAnalytics");
    setFeatureResolver({ isEnabled });
    const { app, sideEffects } = createApp();

    const denied = await request(app).get("/api/admin/analytics/OPERATIONAL").expect(403);
    expect(denied.body.error).toMatchObject({
      code: "ACCESS_DENIED",
      details: { capability: "adminOperations" },
    });
    expect(sideEffects()).toBe(0);
    expect(isEnabled).toHaveBeenCalledWith("adminOperations", {
      userId: "capability-user",
    });
  });
});
