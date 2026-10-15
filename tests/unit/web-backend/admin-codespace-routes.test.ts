import { describe, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { CodespaceObservabilityService } from "@mcp-moira/shared";
import { createAdminCodespaceRoutes } from "../../../packages/web-backend/src/routes/admin-codespaces.js";

describe("admin codespace configuration observation", () => {
  test("reports actual configuration without a cloud mass-stop control endpoint", async () => {
    const observability = new CodespaceObservabilityService({
      providerId: "github-codespaces",
      config: () => ({ state: "available" }),
      policy: () => ({ enabled: true }),
    });
    const app = express();
    app.use(express.json());
    app.use("/api/admin/codespaces", createAdminCodespaceRoutes({ observability }));
    const response = await request(app).get("/api/admin/codespaces");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      readiness: { state: "ready" },
    });
    expect(response.body.data).not.toHaveProperty("controls");
    const obsolete = await request(app)
      .put("/api/admin/codespaces/controls/global")
      .send({ disabled: true });
    expect(obsolete.status).toBe(404);
  });
});
