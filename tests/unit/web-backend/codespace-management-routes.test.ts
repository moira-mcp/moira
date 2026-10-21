import { describe, expect, jest, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CodespaceResourceError,
  LocalDeviceError,
  type CodespaceReadinessView,
  type CodespaceSummaryView,
} from "@mcp-moira/shared";
import { encodeReference, decodeReference } from "@mcp-moira/shared/workspace-references";
import {
  createCodespaceManagementRoutes,
  type CodespaceManagementServices,
} from "../../../packages/web-backend/src/routes/codespace-management.js";
import {
  createWorkspaceSemanticServices,
  type WorkspaceSemanticDependencies,
} from "../../../packages/web-backend/src/services/workspace-semantic-service.js";
import { setupErrorMiddleware } from "../../../packages/web-backend/src/middleware/error-middleware.js";

const CODESPACE_ID = "00000000-0000-4000-8000-000000000001",
  DEVICE = "00000000-0000-4000-8000-000000000011",
  CONNECTION = "00000000-0000-4000-8000-000000000012";
const LOCAL_TARGET = `local:${DEVICE}:${CONNECTION}`;
const SETTINGS_URL = "https://moira.example.com/settings#integrations-github";
const captured = encodeReference("workspace", {
  resourceId: CODESPACE_ID,
  provider: "github-codespaces",
  deviceId: DEVICE,
  generation: 3,
});
const controller = encodeReference("controller", { deviceId: DEVICE, connectionId: CONNECTION });
const operation = encodeReference("operation", {
  owner: { kind: "controller", deviceId: DEVICE, connectionId: CONNECTION },
  requestId: "ws1-00000000-0000-4000-8000-000000000002",
  kind: "lifecycle",
});
const target = encodeReference("target", {
  provider: "github-codespaces",
  repositoryId: "42",
  controller: { deviceId: DEVICE, connectionId: CONNECTION },
});
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
    device_id: DEVICE,
    observed_at: null,
    lifecycle_error: null,
    created_at: 10,
    updated_at: 20,
    ...overrides,
  };
}
// Exercise the actual shared presentation while controlling only the operation boundary.
const projection = createWorkspaceSemanticServices({
  devices: { getDeviceIdentity: () => ({ deviceId: DEVICE, connectionId: CONNECTION }) },
} as unknown as WorkspaceSemanticDependencies);
function services(
  overrides: Partial<CodespaceManagementServices> = {},
): CodespaceManagementServices {
  return {
    semantic: {
      ...projection,
      invoke: jest.fn<CodespaceManagementServices["semantic"]["invoke"]>(async () => ({
        operation,
        state: "completed",
        outcome: { ok: true, result: projection.project("user-a", codespace()) },
      })),
    },
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
    observability: { readiness: async () => readiness },
    resource: {
      listRepositories: () => [{ id: "42", fullName: "owner/repository", private: true }],
      listResources: async () => ({ codespaces: [codespace()], unavailable: [] }),
      refreshProviderState: jest.fn(async () => ({ stale: false })),
      getCodespace: jest.fn(async () => codespace()),
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
const prefix = "/api/integrations/github/codespaces";
describe("website codespace management routes", () => {
  test("keeps observed peers and unavailable identities without fabricating lifecycle authority", async () => {
    const base = services();
    const unavailable = {
      codespace_id: CONNECTION,
      provider: "local-sandboxes",
      repository_id: LOCAL_TARGET,
      repository: "owner/unobserved",
      requested_ref: "main",
      created_at: 10,
      error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" as const },
    };
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        listRepositories: () => [{ id: LOCAL_TARGET, fullName: "owner/repository", private: true }],
        listResources: async () => ({
          codespaces: [codespace({ provider: "local-sandboxes", repository_id: LOCAL_TARGET })],
          unavailable: [unavailable],
        }),
      },
    });
    const response = await request(appWith(services({ providers: [local] }))).get(prefix);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      codespaces: [{ codespace_id: CODESPACE_ID }],
      provider_errors: [],
      resources_stale: true,
    });
    expect(
      decodeReference(response.body.data.codespaces[0].workspace, "workspace").generation,
    ).toBe(3);
    expect(response.body.data.codespaces[0]).not.toHaveProperty("generation");
    expect(response.body.data.unavailable[0]).toMatchObject({
      codespace_id: CONNECTION,
      error: unavailable.error,
    });
    expect(response.body.data.unavailable[0]).not.toHaveProperty("workspace");
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
      ).get(prefix);
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
      expect(response.text).not.toContain("private credential diagnostic");
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
    ).get(prefix);
    expect(response.status).toBe(200);
    expect(response.body.data.codespaces).toHaveLength(1);
    expect(response.body.data.provider_errors).toEqual([
      { provider: "local-sandboxes", error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" } },
    ]);
    expect(response.text).not.toContain("private controller diagnostic");
  });
  test("one list projects both providers with independently selected computer targets", async () => {
    const base = services();
    const local = services({
      provider: "local-sandboxes",
      resource: {
        ...base.resource!,
        listRepositories: () => [{ id: LOCAL_TARGET, fullName: "owner/local", private: false }],
        listResources: async () => ({
          codespaces: [
            codespace({
              provider: "local-sandboxes",
              repository_id: LOCAL_TARGET,
              codespace_id: CONNECTION,
            }),
          ],
          unavailable: [],
        }),
      },
      observability: { readiness: async () => ({ ...readiness, provider: "local-sandboxes" }) },
    });
    const response = await request(
      appWith(
        services({
          providers: [{ ...base, provider: "github-codespaces" }, local],
          controllers: async () => [{ device_id: DEVICE, label: "Computer", available: true }],
          repositoryMetadata: () => ({ device_id: DEVICE, device_label: "Computer" }),
        }),
      ),
    ).get(prefix);
    expect(response.status).toBe(200);
    expect(response.body.data.repositories).toMatchObject([
      { repository_id: "42", provider: "github-codespaces", controller },
      {
        repository_id: LOCAL_TARGET,
        provider: "local-sandboxes",
        device_label: "Computer",
        controller,
      },
    ]);
    expect(
      response.body.data.repositories.map(
        (r: { target: string }) => decodeReference(r.target, "target").provider,
      ),
    ).toEqual(["github-codespaces", "local-sandboxes"]);
    expect(response.body.data.codespaces.map((r: { provider: string }) => r.provider)).toEqual([
      "github-codespaces",
      "local-sandboxes",
    ]);
    expect(
      response.body.data.providers.map(
        (r: { readiness: { provider: string } }) => r.readiness.provider,
      ),
    ).toEqual(["github-codespaces", "local-sandboxes"]);
  });
  test("lists current facts without exposing private provider authority or raw CAS fields", async () => {
    const base = services();
    const extra = Object.assign(codespace(), {
      operationMarker: "secret-marker",
      providerResourceName: "secret-provider",
      connectionId: "secret-connection",
      lastOutcome: "private diagnostic",
    });
    const response = await request(
      appWith(
        services({
          resource: {
            ...base.resource!,
            listResources: async () => ({ codespaces: [extra], unavailable: [] }),
          },
        }),
      ),
    ).get(prefix);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      readiness: { state: "ready" },
      connection: { state: "connected" },
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
      repositories_stale: false,
      codespaces: [{ codespace_id: CODESPACE_ID, state: "usable" }],
    });
    expect(response.body.data.codespaces[0]).not.toHaveProperty("generation");
    expect(response.text).not.toMatch(/secret-|private diagnostic/);
    expect(response.body.data).not.toHaveProperty("limits");
  });
  test.each(["CODESPACE_PROVIDER_UNAVAILABLE", null] as const)(
    "preserves safe lifecycle diagnosis %s and observation freshness",
    async (lifecycle_error) => {
      const base = services();
      const response = await request(
        appWith(
          services({
            resource: {
              ...base.resource!,
              listResources: async () => ({
                codespaces: [
                  codespace({
                    state: "stop_pending",
                    desired_state: "stopped",
                    observed_at: 15,
                    updated_at: 500,
                    lifecycle_error,
                  }),
                ],
                unavailable: [],
              }),
            },
          }),
        ),
      ).get(prefix);
      expect(response.body.data.codespaces[0]).toMatchObject({
        state: "stop_pending",
        observed_at: 15,
        updated_at: 500,
        lifecycle_error,
      });
    },
  );
  test("unconfigured capability discovery stays available without inventing workspaces", async () => {
    const disabled = services({
      resource: null,
      observability: {
        readiness: async () => ({ ...readiness, state: "disabled", reason: "NOT_CONFIGURED" }),
      },
    });
    const response = await request(appWith(disabled)).get(prefix);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ readiness: { state: "disabled" }, codespaces: [] });
  });
  test("stored grant fallback remains explicit and avoids absence reconciliation", async () => {
    const base = services();
    const dependencies = services({
      connection: {
        ...base.connection,
        refreshGrants: jest.fn(async () => ({ refreshed: false, stale: true })),
      },
    });
    const response = await request(appWith(dependencies)).post(`${prefix}/refresh`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      repositories_stale: true,
      resources_stale: true,
      codespaces: [{ codespace_id: CODESPACE_ID }],
    });
    expect(dependencies.resource!.refreshProviderState).not.toHaveBeenCalled();
  });
  test("fresh refresh reconciles managed resources only after confirmed grants", async () => {
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
    const response = await request(appWith(dependencies)).post(`${prefix}/refresh`);
    expect(response.body.data).toMatchObject({ resources_stale: false, codespaces: [] });
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith("user-a", { force: true });
    expect(dependencies.resource!.refreshProviderState).toHaveBeenCalledWith("user-a", {
      authorizationFresh: true,
    });
  });
  test.each([
    ["workspace_create", { target, branch: "feature" }],
    ["workspace_lifecycle", { workspace: captured, action: "stop" }],
    ["workspace_delete", { workspace: captured, confirm_delete: true }],
    ["workspace_observe", { workspace: captured }],
    ["workspace_adopt", { workspace: captured, controller }],
    ["workspace_adopt_external", { controller, name: "owned-vm" }],
    ["operation_get", { reference: operation }],
    ["operation_find", { owner: controller, kind: "lifecycle", query: "Workspace" }],
  ] as const)("%s delegates the exact semantic intent and current user", async (purpose, body) => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post(`${prefix}/operations/${purpose}`)
      .send(body);
    expect(response.status).toBe(200);
    expect(dependencies.semantic.invoke).toHaveBeenCalledWith(
      "user-a",
      purpose,
      body,
      undefined,
      purpose === "workspace_delete" ? { ownerConfirmed: true } : undefined,
    );
    expect(response.body.data).toMatchObject({
      operation,
      state: "completed",
      outcome: { ok: true, result: { workspace: captured, codespace_id: CODESPACE_ID } },
    });
  });
  test.each(["pending", "unconfirmed"])(
    "%s receipt stays original without a fabricated completed outcome",
    async (state) => {
      const dependencies = services();
      jest
        .mocked(dependencies.semantic.invoke)
        .mockResolvedValue({ operation, state, original: { phase: "submitted" } });
      const response = await request(appWith(dependencies))
        .post(`${prefix}/operations/workspace_lifecycle`)
        .send({ workspace: captured, action: "stop" });
      expect(response.body.data).toEqual({ operation, state, original: { phase: "submitted" } });
      expect(response.body.data).not.toHaveProperty("outcome");
    },
  );
  test.each([
    { purpose: "workspace_create", body: { repository_id: "42", ref: "main" } },
    {
      purpose: "workspace_lifecycle",
      body: { workspace: captured, action: "stop", generation: 3 },
    },
    { purpose: "workspace_delete", body: { workspace: captured } },
    { purpose: "operation_get", body: { reference: operation, request_id: "raw" } },
  ])("malformed $purpose refuses before semantic dispatch", async ({ purpose, body }) => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post(`${prefix}/operations/${purpose}`)
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CODESPACE_RESOURCE_INVALID");
    expect(dependencies.semantic.invoke).not.toHaveBeenCalled();
  });
  test.each([
    "/",
    "/00000000-0000-4000-8000-000000000001/start",
    "/00000000-0000-4000-8000-000000000001/stop",
  ])("legacy mutation path %s does not dispatch", async (path) => {
    const dependencies = services();
    const response = await request(appWith(dependencies))
      .post(`${prefix}${path}`)
      .send({ request_id: "raw", expected_generation: 3 });
    expect(response.status).toBe(404);
    expect(dependencies.semantic.invoke).not.toHaveBeenCalled();
  });
  test.each([
    ["LOCAL_UNAUTHORIZED", 401],
    ["LOCAL_CONFLICT", 409],
    ["LOCAL_UNAVAILABLE", 503],
  ] as const)("current authority failure %s uses a closed HTTP response", async (code, status) => {
    const dependencies = services();
    jest
      .mocked(dependencies.semantic.invoke)
      .mockRejectedValue(new LocalDeviceError(code, "private-controller-path secret-credential"));
    const response = await request(appWith(dependencies))
      .post(`${prefix}/operations/workspace_lifecycle`)
      .send({ workspace: captured, action: "start" });
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    expect(response.text).not.toMatch(/private-controller-path|secret-credential|request_id/);
  });
  test("confirmed domain error returns only its declared safe provider detail", async () => {
    const dependencies = services();
    const error = new CodespaceResourceError(
      "CODESPACE_CREATE_REJECTED",
      "private host diagnosis",
      "Configured provider budget prevents creation",
      true,
    );
    error.providerFailure = {
      kind: "http",
      phase: "request",
      status: 402,
      githubRequestId: "AB12:CD34",
      reason: "Configured provider budget prevents creation",
    };
    jest.mocked(dependencies.semantic.invoke).mockRejectedValue(error);
    const response = await request(appWith(dependencies))
      .post(`${prefix}/operations/workspace_create`)
      .send({ target, branch: "main" });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: "CODESPACE_CREATE_REJECTED",
      provider_failure: { status: 402 },
    });
    expect(response.body.error.message).toContain("Configured provider budget");
    expect(response.text).not.toContain("private host diagnosis");
  });
  test.each([
    ["CODESPACE_LOCAL_CREATION_UNKNOWN", 409, "do not create a replacement"],
    ["CODESPACE_LOCAL_PROTOCOL_ERROR", 409, "matching server and companion"],
    ["CODESPACE_LOCAL_RUNTIME_ERROR", 503, "runtime diagnostics"],
    ["CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED", 403, "Moira Settings > Local computers"],
  ] as const)(
    "local diagnostic %s keeps its actionable safe HTTP message",
    async (code, status, instruction) => {
      const dependencies = services();
      jest
        .mocked(dependencies.semantic.invoke)
        .mockRejectedValue(new CodespaceResourceError(code, "private-host-path secret-credential"));
      const response = await request(appWith(dependencies))
        .post(`${prefix}/operations/workspace_lifecycle`)
        .send({ workspace: captured, action: "stop" });
      expect(response.status).toBe(status);
      expect(response.body.error.code).toBe(code);
      expect(response.body.error.message).toContain(instruction);
      expect(response.text).not.toMatch(
        /private-host-path|secret-credential|data are preserved|data is preserved/,
      );
    },
  );
});
