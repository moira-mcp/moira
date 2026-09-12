import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  WorkspaceResourceError,
  type WorkspaceReadinessView,
  type WorkspaceResourceRecord,
} from "@mcp-moira/shared";
import {
  createWorkspaceManagementRoutes,
  type WorkspaceManagementServices,
} from "../../../packages/web-backend/src/routes/workspace-management.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const SETTINGS_URL = "https://moira.example.com/settings#integrations-github";

const readiness: WorkspaceReadinessView = {
  state: "ready",
  reason: null,
  provider: "github-codespaces",
  configuration: "available",
  resources_enabled: true,
  controls: [],
  connector: { state: "available", reason: null },
  reconciliation: { due_resources: 0, due_operations: 0, oldest_due_age_ms: null },
  usage: {
    active_resources: 1,
    max_active_resources: 4,
    active_operations: 0,
    max_active_operations: 20,
    transfer_live_bytes: 0,
    max_transfer_live_bytes: null,
  },
  checked_at: 1,
};

function workspace(overrides: Partial<WorkspaceResourceRecord> = {}): WorkspaceResourceRecord {
  return {
    id: WORKSPACE_ID,
    userId: "user-a",
    connectionId: "secret-connection",
    authorizationGeneration: 7,
    provider: "github-codespaces",
    repositoryId: "42",
    repositoryFullName: "owner/repository",
    requestedRef: "main",
    operationMarker: "secret-marker",
    providerResourceName: "secret-provider-name",
    externalOwnerId: "secret-owner",
    billableOwnerId: "secret-billing",
    machine: {
      name: "basicLinux32gb",
      displayName: "2 cores, 8 GB RAM",
      operatingSystem: "linux",
      cpuCores: 2,
      memoryBytes: 8 * 1024 ** 3,
      storageBytes: 32 * 1024 ** 3,
    },
    state: "usable",
    retentionPolicy: "persistent",
    desiredState: "running",
    observedState: "running",
    generation: 3,
    createDeadlineAt: 100,
    remoteExpiresAt: 200,
    cleanupDeadlineAt: null,
    claimId: "secret-claim",
    claimExpiresAt: null,
    lastOutcome: "provider-private-diagnostic",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function services(
  overrides: Partial<WorkspaceManagementServices> = {},
): WorkspaceManagementServices {
  return {
    connection: {
      getStatus: () => ({
        state: "connected",
        reason: null,
        settingsUrl: SETTINGS_URL,
        installationUrl: null,
        account: { id: "101", login: "owner" },
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      }),
    },
    observability: { readiness: async () => readiness },
    resource: {
      listRepositories: () => [{ id: "42", fullName: "owner/repository", private: true }],
      listResources: () => [workspace()],
      getWorkspace: jest.fn(() => workspace()),
      create: jest.fn(async () => ({
        resource: workspace({ state: "create_submitted" }),
        lifecycleCapability: "secret-capability",
      })),
      startWorkspace: jest.fn(async () => workspace()),
      stopWorkspace: jest.fn(async () =>
        workspace({ state: "stopped", desiredState: "stopped", observedState: "stopped" }),
      ),
      deleteWorkspace: jest.fn(async () =>
        workspace({ state: "delete_pending", desiredState: "deleted", generation: 4 }),
      ),
    },
    operation: {
      list: () => [],
    },
    ...overrides,
  };
}

function appWith(dependencies: WorkspaceManagementServices, userId = "user-a") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { userId });
    next();
  });
  app.use("/api/integrations/github/workspaces", createWorkspaceManagementRoutes(dependencies));
  app.use(setupErrorMiddleware());
  return app;
}

describe("website workspace management routes", () => {
  test("lists readiness, repositories and sanitized workspaces without internal authority", async () => {
    const response = await request(appWith(services())).get("/api/integrations/github/workspaces");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
      workspaces: [{ workspace_id: WORKSPACE_ID, state: "usable", generation: 3 }],
    });
    for (const secret of [
      "secret-connection",
      "secret-marker",
      "secret-provider-name",
      "secret-owner",
      "secret-billing",
      "secret-claim",
      "provider-private-diagnostic",
    ]) {
      expect(response.text).not.toContain(secret);
    }
  });

  test("fails closed with the same-origin Settings link when the feature is not configured", async () => {
    const disabled = services({
      resource: null,
      operation: null,
      observability: {
        readiness: async () => ({ ...readiness, state: "disabled", reason: "NOT_CONFIGURED" }),
      },
    });
    const list = await request(appWith(disabled)).get("/api/integrations/github/workspaces");
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ readiness: { state: "disabled" }, workspaces: [] });

    const create = await request(appWith(disabled))
      .post("/api/integrations/github/workspaces")
      .send({ repository_id: "42", ref: "main" });
    expect(create.status).toBe(503);
    expect(create.body).toMatchObject({
      error: { code: "WORKSPACE_NOT_CONFIGURED" },
      settings_url: SETTINGS_URL,
    });
  });

  test("creates a workspace and never returns the lifecycle capability", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post("/api/integrations/github/workspaces")
      .send({ repository_id: "42", ref: "feature" });
    expect(response.status).toBe(201);
    expect(response.body.data.workspace).toMatchObject({ state: "create_submitted" });
    expect(response.text).not.toContain("secret-capability");
    expect(dependencies.resource!.create).toHaveBeenCalledWith("user-a", "42", "feature");
  });

  test("rejects malformed create input before any service call", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post("/api/integrations/github/workspaces")
      .send({ repository_id: "", ref: "main" });
    expect(response.status).toBe(400);
    expect(dependencies.resource!.create).not.toHaveBeenCalled();
  });

  test("stop preserves data and delete requires confirmation with the current generation", async () => {
    const dependencies = services();
    const stopped = await request(appWith(dependencies)).post(
      `/api/integrations/github/workspaces/${WORKSPACE_ID}/stop`,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({
      data_preserved: true,
      workspace: { state: "stopped" },
    });

    const unconfirmed = await request(appWith(dependencies))
      .delete(`/api/integrations/github/workspaces/${WORKSPACE_ID}`)
      .send({ expected_generation: 3 });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.code).toBe("WORKSPACE_DELETE_CONFIRMATION_REQUIRED");
    expect(dependencies.resource!.deleteWorkspace).not.toHaveBeenCalled();

    const deleted = await request(appWith(dependencies))
      .delete(`/api/integrations/github/workspaces/${WORKSPACE_ID}`)
      .send({ confirm_delete: true, expected_generation: 3 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toMatchObject({ data_preserved: false });
    expect(dependencies.resource!.deleteWorkspace).toHaveBeenCalledWith("user-a", WORKSPACE_ID, 3);
  });

  test("maps bounded domain failures to status codes without provider detail", async () => {
    const base = services();
    const dependencies = services({
      resource: {
        ...base.resource!,
        getWorkspace: jest.fn(() => {
          throw new WorkspaceResourceError("WORKSPACE_NOT_FOUND", "foreign detail");
        }),
        startWorkspace: jest.fn(async () => {
          throw new WorkspaceResourceError("WORKSPACE_GENERATION_CONFLICT", "generation 9 != 3");
        }),
        create: jest.fn(async () => {
          throw new WorkspaceResourceError("WORKSPACE_POLICY_LIMIT", "limit detail");
        }),
      },
    });
    const app = appWith(dependencies);

    const foreign = await request(app).get(`/api/integrations/github/workspaces/${WORKSPACE_ID}`);
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toContain("foreign detail");

    const malformed = await request(app).get("/api/integrations/github/workspaces/not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(dependencies.resource!.getWorkspace).toHaveBeenCalledTimes(1);

    const conflict = await request(app).post(
      `/api/integrations/github/workspaces/${WORKSPACE_ID}/start`,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("WORKSPACE_GENERATION_CONFLICT");
    expect(conflict.text).not.toContain("generation 9");

    const limited = await request(app)
      .post("/api/integrations/github/workspaces")
      .send({ repository_id: "42", ref: "main" });
    expect(limited.status).toBe(429);
    expect(limited.text).not.toContain("limit detail");
  });

  test("returns a workspace with its recent metadata-only operations", async () => {
    const dependencies = services({
      operation: {
        list: () => [
          {
            id: "00000000-0000-4000-8000-000000000002",
            userId: "user-a",
            resourceId: WORKSPACE_ID,
            resourceGeneration: 3,
            authorizationGeneration: 7,
            provider: "github-codespaces",
            providerResourceName: "secret-provider-name",
            remoteMarker: "secret-operation-marker",
            kind: "exec",
            state: "succeeded",
            inputBytes: 0,
            stdoutLimitBytes: 1024,
            stderrLimitBytes: 1024,
            outputBytes: 12,
            exitCode: 0,
            remoteCleanupPending: 0,
            resultExpiresAt: 500,
            deadlineAt: 400,
            claimId: null,
            claimExpiresAt: null,
            lastOutcome: "remote_result_recorded",
            createdAt: 30,
            updatedAt: 40,
          },
        ],
      },
    });
    const response = await request(appWith(dependencies)).get(
      `/api/integrations/github/workspaces/${WORKSPACE_ID}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.operations).toEqual([
      expect.objectContaining({ kind: "exec", state: "succeeded", exit_code: 0 }),
    ]);
    expect(response.text).not.toMatch(/secret-operation-marker|remote_result_recorded/);
  });
});
