import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { WorkspaceResourceError, type WorkspaceReadinessView } from "@mcp-moira/shared";
import {
  createAdminWorkspaceRoutes,
  type AdminWorkspaceServices,
} from "../../../packages/web-backend/src/routes/admin-workspaces.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const readiness: WorkspaceReadinessView = {
  state: "ready",
  reason: null,
  provider: "github-codespaces",
  configuration: "available",
  resources_enabled: true,
  controls: [
    { scope: "global", disabled: false, reason: null, updated_at: null },
    { scope: "provider:github-codespaces", disabled: false, reason: null, updated_at: null },
  ],
  connector: { state: "available", reason: null },
  reconciliation: { due_resources: 0, due_operations: 0, oldest_due_age_ms: null },
  usage: {
    active_resources: 0,
    max_active_resources: 4,
    active_operations: 0,
    max_active_operations: 20,
    transfer_live_bytes: 0,
    max_transfer_live_bytes: null,
  },
  checked_at: 1,
};

function appWith(services: AdminWorkspaceServices) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { userId: "admin-user" });
    next();
  });
  app.use("/api/admin/workspaces", createAdminWorkspaceRoutes(services));
  app.use(setupErrorMiddleware());
  return app;
}

describe("admin workspace control routes", () => {
  test("returns the shared readiness decision with both controls", async () => {
    const response = await request(
      appWith({ observability: { readiness: async () => readiness }, resource: null }),
    ).get("/api/admin/workspaces");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      readiness: { state: "ready" },
      controls: [{ scope: "global" }, { scope: "provider:github-codespaces" }],
    });
  });

  test("validates the control body before touching the service", async () => {
    const setControl = jest.fn();
    const app = appWith({
      observability: { readiness: async () => readiness },
      resource: { listControls: () => [], setControl },
    });
    for (const [scope, body] of [
      ["global", { disabled: "yes" }],
      ["everything", { disabled: true }],
      ["global", { disabled: true, reason: "x".repeat(501) }],
    ] as const) {
      const response = await request(app).put(`/api/admin/workspaces/controls/${scope}`).send(body);
      expect(response.status).toBe(400);
    }
    expect(setControl).not.toHaveBeenCalled();
  });

  test("forwards a disable request with the administrator identity and trimmed reason", async () => {
    const disabledControls = [
      { scope: "global" as const, disabled: true, reason: "incident", updatedAt: 5 },
      {
        scope: "provider:github-codespaces" as const,
        disabled: false,
        reason: null,
        updatedAt: null,
      },
    ];
    const setControl = jest.fn(async () => disabledControls);
    const response = await request(
      appWith({
        observability: {
          readiness: async () => ({
            ...readiness,
            state: "control_disabled",
            reason: "global",
            controls: [
              { scope: "global", disabled: true, reason: "incident", updated_at: 5 },
              readiness.controls[1],
            ],
          }),
        },
        resource: { listControls: () => disabledControls, setControl },
      }),
    )
      .put("/api/admin/workspaces/controls/global")
      .send({ disabled: true, reason: "  incident  " });
    expect(response.status).toBe(200);
    expect(setControl).toHaveBeenCalledWith({
      scope: "global",
      disabled: true,
      reason: "incident",
      updatedBy: "admin-user",
    });
    expect(response.body.data).toMatchObject({
      readiness: { state: "control_disabled" },
      controls: [
        { scope: "global", disabled: true, reason: "incident", updated_at: 5 },
        { scope: "provider:github-codespaces", disabled: false },
      ],
    });
    expect(response.text).not.toContain("updatedAt");
  });

  test("fails closed when the provider composition is absent or the scope is foreign", async () => {
    const absent = await request(
      appWith({ observability: { readiness: async () => readiness }, resource: null }),
    )
      .put("/api/admin/workspaces/controls/global")
      .send({ disabled: true });
    expect(absent.status).toBe(503);
    expect(absent.body.error.code).toBe("WORKSPACE_NOT_CONFIGURED");

    const foreign = await request(
      appWith({
        observability: { readiness: async () => readiness },
        resource: {
          listControls: () => [],
          setControl: jest.fn(async () => {
            throw new WorkspaceResourceError("WORKSPACE_RESOURCE_INVALID", "scope not managed");
          }),
        },
      }),
    )
      .put("/api/admin/workspaces/controls/provider:other-cloud")
      .send({ disabled: true });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("WORKSPACE_RESOURCE_INVALID");
  });
});
