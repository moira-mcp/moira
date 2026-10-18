import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CodespaceResourceError,
  ScopedCredentialError,
  type CodespaceReadinessView,
  type CodespaceSummaryView,
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
  checked_at: 1,
};

function codespace(overrides: Partial<CodespaceSummaryView> = {}): CodespaceSummaryView {
  return {
    codespace_id: CODESPACE_ID,
    provider: "github-codespaces",
    repository_id: "42",
    repository: "owner/repository",
    requested_ref: "main",
    current_ref: "feature/current",
    machine: null,
    state: "usable",
    retention_policy: "persistent",
    desired_state: "running",
    observed_state: "running",
    generation: 3,
    observed_at: null,
    lifecycle_error: null,
    created_at: 10,
    updated_at: 20,
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
    },
    resource: {
      listRepositories: () => [{ id: "42", fullName: "owner/repository", private: true }],
      listResources: async () => ({ codespaces: [codespace()], unavailable: [] }),
      refreshProviderState: jest.fn(async () => ({ stale: false })),
      getCodespace: jest.fn(async () => codespace()),
      create: jest.fn(async () => codespace({ state: "create_submitted" })),
      startCodespace: jest.fn(async () => codespace()),
      stopCodespace: jest.fn(async () =>
        codespace({ state: "stopped", desired_state: "stopped", observed_state: "stopped" }),
      ),
      deleteCodespace: jest.fn(async () =>
        codespace({ state: "delete_pending", desired_state: "deleted", generation: 4 }),
      ),
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

describe("website codespace management routes", () => {
  test("keeps observed peers and unavailable identities without fabricating resource state", async () => {
    const base = services();
    const unavailable = {
      codespace_id: "00000000-0000-4000-8000-000000000002",
      provider: "local-sandboxes",
      repository_id: "local-target",
      repository: "owner/unobserved",
      requested_ref: "main",
      created_at: 10,
      error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" as const },
    };
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        listResources: async () => ({
          codespaces: [codespace({ provider: "local-sandboxes" })],
          unavailable: [unavailable],
        }),
      },
    });
    const response = await request(appWith(services({ providers: [local] }))).get(
      "/api/integrations/github/codespaces",
    );
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      codespaces: [{ codespace_id: CODESPACE_ID, generation: 3 }],
      unavailable: [unavailable],
      provider_errors: [],
      resources_stale: true,
    });
    expect(response.body.data.unavailable[0]).not.toHaveProperty("generation");
    expect(response.body.data.unavailable[0]).not.toHaveProperty("state");
  });

  test.each([false, true])(
    "reports all provider failures while retaining successful peers (all failed: %s)",
    async (allFailed) => {
      const failed = (provider: string) =>
        services({
          provider,
          observability: {
            readiness: async () => {
              throw new CodespaceResourceError(
                "CODESPACE_AUTHORIZATION_REQUIRED",
                "private credential diagnostic",
              );
            },
          },
        });
      const response = await request(
        appWith(
          services({
            providers: [
              allFailed ? failed("github-codespaces") : services({ provider: "github-codespaces" }),
              failed("local-sandboxes"),
            ],
          }),
        ),
      ).get("/api/integrations/github/codespaces");
      expect(response.status).toBe(200);
      expect(response.body.data.codespaces).toHaveLength(allFailed ? 0 : 1);
      expect(response.body.data.provider_errors).toEqual(
        (allFailed ? ["github-codespaces", "local-sandboxes"] : ["local-sandboxes"]).map(
          (provider) => ({ provider, error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" } }),
        ),
      );
      expect(response.body.data.providers.at(-1)).toEqual({
        provider: "local-sandboxes",
        error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" },
      });
      if (allFailed) {
        expect(response.body.data).not.toHaveProperty("readiness");
        expect(response.body.data).not.toHaveProperty("connection");
        expect(response.body.data.repositories).toEqual([]);
      }
      expect(JSON.stringify(response.body)).not.toContain("private credential diagnostic");
    },
  );

  test("a failed controller observation does not discard healthy provider resources", async () => {
    const response = await request(
      appWith(
        services({
          providers: [services({ provider: "github-codespaces" })],
          controllers: async () => {
            throw new Error("private controller diagnostic");
          },
        }),
      ),
    ).get("/api/integrations/github/codespaces");
    expect(response.status).toBe(200);
    expect(response.body.data.codespaces).toHaveLength(1);
    expect(response.body.data.provider_errors).toEqual([
      { provider: "local-sandboxes", error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" } },
    ]);
    expect(JSON.stringify(response.body)).not.toContain("private controller diagnostic");
  });

  test("a confirmed payment refusal retains safe provider evidence and its original request instead of unknown creation", async () => {
    const base = services(),
      requestId = "ws1-00000000-0000-4000-8000-000000000002",
      reason = "Codespaces usage not allowed by the configured budget";
    const create = jest.fn(async () => {
      const error = new CodespaceResourceError(
        "CODESPACE_CREATE_REJECTED",
        "Provider refused original creation",
        reason,
      );
      error.requestId = requestId;
      error.providerFailure = {
        kind: "http",
        phase: "request",
        status: 402,
        githubRequestId: "AB12:CD34",
        reason,
      };
      throw error;
    });
    const response = await request(appWith(services({ resource: { ...base.resource!, create } })))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "main", request_id: requestId });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "CODESPACE_CREATE_REJECTED",
      request_id: requestId,
      provider_failure: { kind: "http", status: 402, reason },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("unknown creation exposes only typed provider evidence and the original recovery identity", async () => {
    const base = services(),
      requestId = "ws1-00000000-0000-4000-8000-000000000002";
    const create = jest.fn(async () => {
      const error = new CodespaceResourceError(
        "WORKSPACE_OUTCOME_UNCONFIRMED",
        "private-response-body ghu_private_original",
      );
      error.requestId = requestId;
      error.providerFailure = {
        kind: "http",
        phase: "request",
        status: 503,
        githubRequestId: "AB12:CD34",
        reason: "Service unavailable",
      };
      throw error;
    });
    const response = await request(appWith(services({ resource: { ...base.resource!, create } })))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "main", request_id: requestId });
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "WORKSPACE_OUTCOME_UNCONFIRMED",
      request_id: requestId,
      provider_failure: {
        kind: "http",
        phase: "request",
        status: 503,
        githubRequestId: "AB12:CD34",
        reason: "Service unavailable",
      },
    });
    expect(response.text).not.toMatch(/private-response-body|ghu_private_original/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  test("callable stop preserves scoped disposal uncertainty and the retained lifecycle fence", async () => {
    const base = services();
    let retained = codespace();
    const stop = jest.fn<
      (
        userId: string,
        id: string,
        requestId?: string,
        generation?: number,
      ) => Promise<CodespaceSummaryView>
    >(async () => {
      retained = codespace({ state: "stop_pending", desired_state: "stopped" });
      throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
    });
    const dependencies = services({
      resource: { ...base.resource!, getCodespace: async () => retained, stopCodespace: stop },
    });
    const app = appWith(dependencies);
    const response = await request(app).post(
      `/api/integrations/github/codespaces/${CODESPACE_ID}/stop`,
    );
    expect({ status: response.status, body: response.body }).toEqual({
      status: 503,
      body: {
        success: false,
        error: {
          code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
          message: "Scoped credential operation outcome is unconfirmed",
        },
      },
    });
    expect(stop).toHaveBeenCalledWith("user-a", CODESPACE_ID, undefined, undefined);
    expect(response.text).not.toMatch(/secret-|data_preserved|settings_url/);
    const observed = await request(app).get(`/api/integrations/github/codespaces/${CODESPACE_ID}`);
    expect(observed.body.data.codespace).toMatchObject({
      state: "stop_pending",
      desired_state: "stopped",
    });
  });
  test.each([
    ["CODESPACE_LOCAL_CREATION_UNKNOWN", 409, "do not create a replacement"],
    ["CODESPACE_LOCAL_PROTOCOL_ERROR", 409, "matching server and companion"],
    ["CODESPACE_LOCAL_RUNTIME_ERROR", 503, "runtime diagnostics"],
    ["CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED", 403, "Moira Settings > Local computers"],
  ] as const)(
    "local diagnostic %s reaches the website with an actionable safe message",
    async (code, status, instruction) => {
      const base = services();
      const dependencies = services({
        resource: {
          ...base.resource!,
          stopCodespace: async () => {
            throw new CodespaceResourceError(code, "private-host-path credential-not-for-user");
          },
        },
      });
      const response = await request(appWith(dependencies)).post(
        `/api/integrations/github/codespaces/${CODESPACE_ID}/stop`,
      );
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.body.error.message).toContain(instruction);
      expect(response.text).not.toContain("private-host-path");
      expect(response.text).not.toContain("credential-not-for-user");
      expect(response.text).not.toContain("data are preserved");
      expect(response.text).not.toContain("data is preserved");
      if (code !== "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED")
        expect(response.body.error.message).toContain("physical outcome is not confirmed");
    },
  );
  test.each(["create", "start", "stop", "delete"] as const)(
    "%s preserves the selected unconfigured provider response while another provider is available",
    async (action) => {
      const base = services();
      const selectedSettings = "https://moira.example.com/settings#selected-provider";
      const selected = services({
        provider: "github-codespaces",
        resource: null,
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
    const requestId = "ws1-11111111-1111-4111-8111-111111111111";
    const target =
      "local:00000000-0000-4000-8000-000000000011:00000000-0000-4000-8000-000000000012";
    const base = services();
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        create: async () => codespace({ provider: "local-sandboxes", repository_id: target }),
        stopCodespace: async (_user, _id, originalId, generation) => {
          if (originalId !== requestId || generation !== 3)
            throw new CodespaceResourceError(
              "CODESPACE_GENERATION_CONFLICT",
              "The caller did not retain its observed generation",
            );
          return codespace({
            provider: "local-sandboxes",
            state: "stopped",
            desired_state: "stopped",
          });
        },
      },
    });
    const app = appWith(
      services({
        resource: null,
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
      .send({ repository_id: target, ref: "main", request_id: requestId });
    expect(created.status).toBe(201);
    expect(created.body.data.codespace).toMatchObject({
      provider: "local-sandboxes",
      repository_id: target,
    });
    const stopped = await request(app)
      .post(`/api/integrations/github/codespaces/${CODESPACE_ID}/stop`)
      .send({ request_id: requestId, expected_generation: 3 });
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
        listResources: async () => ({
          codespaces: [
            codespace({
              provider: "local-sandboxes",
              codespace_id: "00000000-0000-4000-8000-000000000002",
            }),
          ],
          unavailable: [],
        }),
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
    });
    expect(response.body.data).not.toHaveProperty("limits");
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a");
    expect(response.body.data.codespaces).toEqual([codespace()]);
  });

  test.each(["CODESPACE_PROVIDER_UNAVAILABLE", null] as const)(
    "projects safe lifecycle diagnostic %s with actual observation freshness",
    async (outcome) => {
      const base = services();
      const dependencies = services({
        resource: {
          ...base.resource!,
          listResources: async () => ({
            codespaces: [
              codespace({
                state: "stop_pending",
                desired_state: "stopped",
                observed_at: 15,
                updated_at: 500,
                lifecycle_error: outcome,
              }),
            ],
            unavailable: [],
          }),
        },
      });
      const response = await request(appWith(dependencies)).get(
        "/api/integrations/github/codespaces",
      );
      expect(response.status).toBe(200);
      expect(response.body.data.codespaces[0]).toMatchObject({
        state: "stop_pending",
        observed_at: 15,
        updated_at: 500,
        lifecycle_error: outcome,
      });
    },
  );

  test("fails closed with the same-origin Settings link when the feature is not configured", async () => {
    const disabled = services({
      resource: null,
      observability: {
        readiness: async () => ({ ...readiness, state: "disabled", reason: "NOT_CONFIGURED" }),
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

  test("creates a codespace and returns the owner summary with an unobserved machine", async () => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post("/api/integrations/github/codespaces")
      .send({ repository_id: "42", ref: "feature" });
    expect(response.status).toBe(201);
    expect(response.body.data.codespace).toEqual(codespace({ state: "create_submitted" }));
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a");
    expect(dependencies.resource!.create).toHaveBeenCalledWith(
      "user-a",
      "42",
      "feature",
      undefined,
    );
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
        listResources: async () => ({ codespaces: present ? [codespace()] : [], unavailable: [] }),
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
    expect(dependencies.resource!.deleteCodespace).toHaveBeenCalledWith("user-a", CODESPACE_ID, 3, {
      ownerConfirmed: true,
      requestId: undefined,
    });
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

  test("returns owned lifecycle metadata without a cloud command archive", async () => {
    const response = await request(appWith(services())).get(
      `/api/integrations/github/codespaces/${CODESPACE_ID}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.data.codespace.codespace_id).toBe(CODESPACE_ID);
    expect(response.body.data).not.toHaveProperty("operations");
    expect(response.text).not.toContain("secret-marker");
  });
});
