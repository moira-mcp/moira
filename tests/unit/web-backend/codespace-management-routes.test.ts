import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CodespaceResourceError,
  evaluateCodespaceResourcePolicy,
  projectCodespaceLimits,
  type CodespaceReadinessView,
  type CodespaceResourceRecord,
} from "@mcp-moira/shared";
import {
  createCodespaceManagementRoutes,
  type CodespaceManagementServices,
} from "../../../packages/web-backend/src/routes/codespace-management.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const SETTINGS_URL = "https://moira.example.com/settings#integrations-github";

const readiness: CodespaceReadinessView = {
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
    max_transfer_live_bytes: 1024 ** 3,
  },
  checked_at: 1,
};

function codespace(overrides: Partial<CodespaceResourceRecord> = {}): CodespaceResourceRecord {
  return {
    id: CODESPACE_ID,
    userId: "user-a",
    connectionId: "secret-connection",
    authorizationGeneration: 7,
    provider: "github-codespaces",
    repositoryId: "42",
    repositoryFullName: "owner/repository",
    requestedRef: "main",
    observedRef: "feature/current",
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
    reconcileFailures: 0,
    lastActivityAt: null,
    providerLastUsedAt: null,
    lastOutcome: "provider-private-diagnostic",
    createdAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function services(
  overrides: Partial<CodespaceManagementServices> = {},
): CodespaceManagementServices {
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
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
    },
    observability: {
      readiness: async () => readiness,
      limitsWithBilling: jest.fn(async () => LIMITS),
    },
    resource: {
      listRepositories: () => [{ id: "42", fullName: "owner/repository", private: true }],
      listResources: () => [codespace()],
      refreshProviderState: jest.fn(async () => ({ stale: false })),
      getCodespace: jest.fn(() => codespace()),
      create: jest.fn(async () => ({
        resource: codespace({ state: "create_submitted" }),
        lifecycleCapability: "secret-capability",
      })),
      startCodespace: jest.fn(async () => codespace()),
      stopCodespace: jest.fn(async () =>
        codespace({ state: "stopped", desiredState: "stopped", observedState: "stopped" }),
      ),
      deleteCodespace: jest.fn(async () =>
        codespace({ state: "delete_pending", desiredState: "deleted", generation: 4 }),
      ),
    },
    operation: {
      list: () => [],
    },
    ...overrides,
  };
}

function appWith(dependencies: CodespaceManagementServices, userId = "user-a") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { userId });
    next();
  });
  app.use("/api/integrations/github/codespaces", createCodespaceManagementRoutes(dependencies));
  app.use(setupErrorMiddleware());
  return app;
}

/** A user's limits as the domain computes them, from the shipped policy and some use. */
const LIMITS = projectCodespaceLimits({
  policy: evaluateCodespaceResourcePolicy(() => undefined),
  held: 2,
  instanceHeld: 5,
  activeOperations: 1,
  transfers: { objects: 1, bytes: 2048, inflightBytes: 1024 },
  idle: { autoStopEnabled: true, idleTimeoutMinutes: 30 },
  providerIdleMaxMinutes: 240,
});

describe("website codespace management routes", () => {
  test.each(["create", "start", "stop", "delete"] as const)(
    "%s preserves the selected unconfigured provider response while another provider is available",
    async (action) => {
      const base = services();
      const selectedSettings = "https://moira.example.com/settings#selected-provider";
      const selected = services({
        provider: "github-codespaces",
        resource: null,
        operation: null,
        connection: {
          ...base.connection,
          getStatus: () => ({
            ...base.connection.getStatus("user-a"),
            state: "disabled",
            settingsUrl: selectedSettings,
          }),
        },
      });
      const local = services({ provider: "local-sandboxes" });
      const app = appWith(
        services({
          resource: null,
          operation: null,
          providers: [selected, local],
          select: () => selected,
        }),
      );
      const prefix = "/api/integrations/github/codespaces";
      const response =
        action === "create"
          ? await request(app).post(prefix).send({ repository_id: "162", ref: "main" })
          : action === "delete"
            ? await request(app)
                .delete(`${prefix}/${CODESPACE_ID}`)
                .send({ confirm_delete: true, expected_generation: 3 })
            : await request(app).post(`${prefix}/${CODESPACE_ID}/${action}`);
      expect({ status: response.status, body: response.body }).toMatchObject({
        status: 503,
        body: {
          success: false,
          error: { code: "CODESPACE_NOT_CONFIGURED" },
          settings_url: selectedSettings,
        },
      });
      expect(selected.connection.refreshGrants).not.toHaveBeenCalled();
      expect(local.resource!.create).not.toHaveBeenCalled();
    },
  );

  test("the existing website endpoint creates and stops local codespaces with GitHub disabled", async () => {
    const target =
      "local:00000000-0000-4000-8000-000000000011:00000000-0000-4000-8000-000000000012";
    const base = services();
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        create: async () => ({
          resource: codespace({ provider: "local-sandboxes", repositoryId: target }),
          lifecycleCapability: "secret-capability",
        }),
        stopCodespace: async () =>
          codespace({ provider: "local-sandboxes", state: "stopped", desiredState: "stopped" }),
      },
    });
    const app = appWith(
      services({
        resource: null,
        operation: null,
        providers: [local],
        connection: {
          ...base.connection,
          refreshGrants: async () => {
            throw new Error("GitHub must not gate local work");
          },
        },
        select: (_userId, input) => {
          if (input.repositoryId === target || input.codespaceId === CODESPACE_ID) return local;
          throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Not owned");
        },
      }),
    );
    const created = await request(app)
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: target, ref: "main" });
    expect(created.status).toBe(201);
    expect(created.body.data.codespace).toMatchObject({
      provider: "local-sandboxes",
      repository_id: target,
    });
    const stopped = await request(app).post(
      `/api/integrations/github/codespaces/${CODESPACE_ID}/stop`,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({
      data_preserved: true,
      codespace: { provider: "local-sandboxes", state: "stopped" },
    });
  });

  test("one management list presents both providers without turning local readiness into GitHub readiness", async () => {
    const base = services();
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        listRepositories: () => [{ id: "local-target", fullName: "owner/local", private: false }],
        listResources: () => [
          codespace({ provider: "local-sandboxes", id: "00000000-0000-4000-8000-000000000002" }),
        ],
      },
      observability: {
        ...base.observability,
        readiness: async () => ({ ...readiness, provider: "local-sandboxes" }),
      },
    });
    const response = await request(
      appWith(
        services({
          providers: [{ ...base, provider: "github-codespaces" }, local],
          repositoryMetadata: () => ({ device_id: "device", device_label: "Computer" }),
        }),
      ),
    ).get("/api/integrations/github/codespaces");
    expect(response.status).toBe(200);
    expect(response.body.data.repositories).toEqual([
      {
        repository_id: "42",
        name: "owner/repository",
        private: true,
        provider: "github-codespaces",
      },
      {
        repository_id: "local-target",
        name: "owner/local",
        private: false,
        provider: "local-sandboxes",
        device_id: "device",
        device_label: "Computer",
      },
    ]);
    expect(
      response.body.data.codespaces.map((entry: { provider: string }) => entry.provider),
    ).toEqual(["github-codespaces", "local-sandboxes"]);
    expect(
      response.body.data.providers.map(
        (entry: { readiness: { provider: string } }) => entry.readiness.provider,
      ),
    ).toEqual(["github-codespaces", "local-sandboxes"]);
  });

  test("lists readiness, repositories and sanitized codespaces without internal authority", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies)).get(
      "/api/integrations/github/codespaces",
    );
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
      repositories_stale: false,
      codespaces: [{ codespace_id: CODESPACE_ID, state: "usable", generation: 3 }],
      limits: LIMITS,
    });
    expect(dependencies.observability.limitsWithBilling).toHaveBeenCalledWith("user-a", {
      force: false,
    });
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a");
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
        limitsWithBilling: async () => LIMITS,
      },
    });
    const list = await request(appWith(disabled)).get("/api/integrations/github/codespaces");
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ readiness: { state: "disabled" }, codespaces: [] });

    const create = await request(appWith(disabled))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "main" });
    expect(create.status).toBe(503);
    expect(create.body).toMatchObject({
      error: { code: "CODESPACE_NOT_CONFIGURED" },
      settings_url: SETTINGS_URL,
    });
  });

  test("creates a codespace and never returns the lifecycle capability", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "feature" });
    expect(response.status).toBe(201);
    expect(response.body.data.codespace).toMatchObject({ state: "create_submitted" });
    expect(response.text).not.toContain("secret-capability");
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a");
    expect(dependencies.resource!.create).toHaveBeenCalledWith("user-a", "42", "feature");
  });

  test("serves the stored management snapshot with an explicit stale marker", async () => {
    const dependencies = services({
      connection: {
        ...services().connection,
        refreshGrants: jest.fn(async () => ({ refreshed: false, stale: true })),
      },
    });
    const response = await request(appWith(dependencies)).get(
      "/api/integrations/github/codespaces",
    );
    expect(response.status).toBe(200);
    expect(response.body.data.repositories_stale).toBe(true);
    expect(response.body.data.repositories).toEqual([
      { repository_id: "42", name: "owner/repository", private: true },
    ]);
  });

  test("refreshes GitHub grants and managed resource state before returning the list", async () => {
    const base = services();
    let present = true;
    const dependencies = services({
      connection: {
        ...base.connection,
        refreshGrants: jest.fn(async () => ({ refreshed: true, stale: false })),
      },
      resource: {
        ...base.resource!,
        refreshProviderState: jest.fn(async () => {
          present = false;
          return { stale: false };
        }),
        listResources: () => (present ? [codespace()] : []),
      },
    });

    const response = await request(appWith(dependencies)).post(
      "/api/integrations/github/codespaces/refresh",
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ resources_stale: false, codespaces: [] });
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a", { force: true });
    expect(dependencies.resource!.refreshProviderState).toHaveBeenCalledWith("user-a", {
      authorizationFresh: true,
    });
  });

  test("stale GitHub grants preserve resources and skip absence reconciliation", async () => {
    const base = services();
    const dependencies = services({
      connection: {
        ...base.connection,
        refreshGrants: jest.fn(async () => ({ refreshed: false, stale: true })),
      },
    });
    const response = await request(appWith(dependencies)).post(
      "/api/integrations/github/codespaces/refresh",
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      repositories_stale: true,
      resources_stale: true,
      codespaces: [{ codespace_id: CODESPACE_ID }],
    });
    expect(dependencies.resource!.refreshProviderState).not.toHaveBeenCalled();
  });

  test("rejects malformed create input before any service call", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "", ref: "main" });
    expect(response.status).toBe(400);
    expect(dependencies.resource!.create).not.toHaveBeenCalled();
  });

  test("stop preserves data and delete requires confirmation with the current generation", async () => {
    const dependencies = services();
    const stopped = await request(appWith(dependencies)).post(
      `/api/integrations/github/codespaces/${CODESPACE_ID}/stop`,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.data).toMatchObject({
      data_preserved: true,
      codespace: { state: "stopped" },
    });

    const unconfirmed = await request(appWith(dependencies))
      .delete(`/api/integrations/github/codespaces/${CODESPACE_ID}`)
      .send({ expected_generation: 3 });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.code).toBe("CODESPACE_DELETE_CONFIRMATION_REQUIRED");
    expect(dependencies.resource!.deleteCodespace).not.toHaveBeenCalled();

    const deleted = await request(appWith(dependencies))
      .delete(`/api/integrations/github/codespaces/${CODESPACE_ID}`)
      .send({ confirm_delete: true, expected_generation: 3 });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toMatchObject({ data_preserved: false });
    expect(dependencies.resource!.deleteCodespace).toHaveBeenCalledWith("user-a", CODESPACE_ID, 3);
  });

  test("maps bounded domain failures to status codes without provider detail", async () => {
    const base = services();
    const dependencies = services({
      resource: {
        ...base.resource!,
        getCodespace: jest.fn(() => {
          throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "foreign detail");
        }),
        startCodespace: jest.fn(async () => {
          throw new CodespaceResourceError("CODESPACE_GENERATION_CONFLICT", "generation 9 != 3");
        }),
        create: jest.fn(async () => {
          throw new CodespaceResourceError(
            "CODESPACE_POLICY_LIMIT",
            "limit detail",
            "This Moira instance is at its ceiling of 16 held codespaces; stopped ones count too.",
          );
        }),
      },
    });
    const app = appWith(dependencies);

    const foreign = await request(app).get(`/api/integrations/github/codespaces/${CODESPACE_ID}`);
    expect(foreign.status).toBe(404);
    expect(foreign.text).not.toContain("foreign detail");

    const malformed = await request(app).get("/api/integrations/github/codespaces/not-a-uuid");
    expect(malformed.status).toBe(404);
    expect(dependencies.resource!.getCodespace).toHaveBeenCalledTimes(1);

    const conflict = await request(app).post(
      `/api/integrations/github/codespaces/${CODESPACE_ID}/start`,
    );
    expect({ status: conflict.status, body: conflict.body }).toMatchObject({
      status: 409,
      body: { error: { code: "CODESPACE_GENERATION_CONFLICT" } },
    });
    expect(conflict.body.error.code).toBe("CODESPACE_GENERATION_CONFLICT");
    expect(conflict.text).not.toContain("generation 9");

    const limited = await request(app)
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "main" });
    expect(limited.status).toBe(429);
    // The operator sentence stays private; the bounded detail the refusal declared safe is shown.
    expect(limited.text).not.toContain("limit detail");
    expect(limited.body.error.message).toContain("ceiling of 16 held codespaces");
  });

  test("returns a codespace with its recent metadata-only operations", async () => {
    const dependencies = services({
      operation: {
        list: () => [
          {
            id: "00000000-0000-4000-8000-000000000002",
            userId: "user-a",
            resourceId: CODESPACE_ID,
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
      `/api/integrations/github/codespaces/${CODESPACE_ID}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.operations).toEqual([
      expect.objectContaining({ kind: "exec", state: "succeeded", exit_code: 0 }),
    ]);
    expect(response.text).not.toMatch(/secret-operation-marker|remote_result_recorded/);
  });
});
