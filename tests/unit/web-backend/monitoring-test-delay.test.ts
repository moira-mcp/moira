import express from "express";
import { describe, expect, test } from "@jest/globals";
import request from "supertest";

import {
  monitoringTestRoutes,
  normalizeMonitoringDelay,
} from "../../../packages/web-backend/src/routes/monitoring-test.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

describe("monitoring test delay contract", () => {
  test.each([
    [100, 100],
    [2500, 2500],
    [10000, 10000],
    [0, 100],
    [25000, 10000],
    ["2500", 2500],
  ])("normalizes %p to %p milliseconds", (input, expected) => {
    expect(normalizeMonitoringDelay(input)).toBe(expected);
  });

  test.each([null, true, "", "not-a-number", Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed or non-finite delay %p",
    (input) => {
      expect(normalizeMonitoringDelay(input)).toBeNull();
    },
  );

  test("projects malformed delay input through the production validation error contract", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/admin/monitoring-test", monitoringTestRoutes);
    app.use(setupErrorMiddleware());

    const response = await request(app)
      .post("/api/admin/monitoring-test/slow")
      .send({ delayMs: "not-a-number" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "delayMs must be a finite number",
      },
    });
  });
});
