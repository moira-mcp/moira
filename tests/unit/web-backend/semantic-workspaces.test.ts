import { describe, expect, jest, test } from "@jest/globals";
import { z } from "zod";
import {
  CodespaceResourceError,
  LocalDeviceError,
  ScopedCredentialError,
  type CodespaceSummaryView,
} from "@mcp-moira/shared";
import { encodeReference, decodeReference } from "@mcp-moira/shared/workspace-references";
import { WORKSPACE_TOOL_SCHEMAS } from "@mcp-moira/shared/workspace-tool-schemas";
import {
  createWorkspaceSemanticServices,
  type WorkspaceSemanticDependencies,
} from "../../../packages/web-backend/src/services/workspace-semantic-service.js";

const USER = "user-a",
  RESOURCE = "00000000-0000-4000-8000-000000000001",
  DEVICE = "00000000-0000-4000-8000-000000000002",
  CONNECTION = "00000000-0000-4000-8000-000000000003",
  SPACE = "00000000-0000-4000-8000-000000000004",
  REPOSITORY = "00000000-0000-4000-8000-000000000005";
const REQUEST = "ws1-00000000-0000-4000-8000-000000000006";
const owner = { deviceId: DEVICE, connectionId: CONNECTION };
const controller = encodeReference("controller", owner);
const installation = encodeReference("installation", { controller: owner, installationId: "41" });
const workspace = (
  provider: "local-sandboxes" | "github-codespaces" = "github-codespaces",
  generation = 3,
) => encodeReference("workspace", { resourceId: RESOURCE, provider, deviceId: DEVICE, generation });
function view(overrides: Partial<CodespaceSummaryView> = {}): CodespaceSummaryView {
  return {
    codespace_id: RESOURCE,
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
function fixture(provider = "github-codespaces") {
  let identity = { userId: USER, ...owner, deviceGeneration: 1 };
  let current = view({ provider });
  const resource = {
    listRepositories: jest.fn(() => [{ id: "42", fullName: "owner/repository", private: true }]),
    listResources: jest.fn(async (..._args: unknown[]) => ({
      codespaces: [current],
      unavailable: [],
    })),
    getCodespace: jest.fn(async () => current),
    create: jest.fn(async (..._args: unknown[]) => current),
    startCodespace: jest.fn(async (..._args: unknown[]) => current),
    stopCodespace: jest.fn(
      async (..._args: unknown[]) =>
        (current = view({
          provider,
          state: "stopped",
          desired_state: "stopped",
          observed_state: "stopped",
          generation: 4,
        })),
    ),
    resumeSetup: jest.fn(
      async (..._args: unknown[]) =>
        (current = view({ provider, generation: 4, remote: { state: "unavailable" } })),
    ),
    deleteCodespace: jest.fn(
      async (..._args: unknown[]) =>
        (current = view({
          provider,
          state: "deleted",
          desired_state: "deleted",
          observed_state: "absent",
          generation: 4,
        })),
    ),
    registerExisting: jest.fn(async (..._args: unknown[]) =>
      view({ generation: 7, state: "stopped" }),
    ),
    adopt: jest.fn(async (..._args: unknown[]) => view({ generation: 8 })),
  };
  const bundle = {
    provider,
    resource,
    connection: {
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
      getStatus: jest.fn(() => ({
        state: "connected",
        settingsUrl: "https://moira.example/settings",
      })),
    },
    guidance: jest.fn((situation: string) => ({
      provider,
      situation,
      instruction: `Follow ${situation}`,
      links: [],
    })),
  };
  const devices = {
    createObservation: jest.fn((userId: string) => ({ userId })),
    repository: { getActiveDevice: jest.fn(() => identity) },
    getDeviceIdentity: jest.fn(() => identity),
    getBinding: jest.fn(() => ({ ...identity, repositoryId: REPOSITORY })),
    getOperation: jest.fn(async (..._args: unknown[]) => ({
      requestId: REQUEST,
      state: "unconfirmed",
    })),
  };
  const localBinding = {
    resourceId: RESOURCE,
    resourceGeneration: 9,
    routeGeneration: 9,
    repositoryId: REPOSITORY,
    localSpaceId: SPACE,
    localGeneration: 4,
    operationMarker: `moira-${"a".repeat(24)}`,
  };
  const transport = {
    request: jest.fn(async () => {
      throw new Error("Unexpected byte request");
    }),
    json: jest.fn(async (..._args: unknown[]) => localBinding),
  };
  const repositories = {
    listDevices: jest.fn(async () => ({
      devices: [
        { device_id: DEVICE, label: "My computer", status: "active", owner_available: true },
        { device_id: SPACE, label: "Revoked computer", status: "revoked", owner_available: false },
      ],
      installations: [{ installation_id: "41", owner: "personal" }],
    })),
    addExistingRepository: jest.fn(async (..._args: unknown[]) => ({
      status: "applied",
      request_id: REQUEST,
      local_repository_id: `local:${DEVICE}:${REPOSITORY}`,
    })),
  };
  const repositoryCreation = {
    createRepository: jest.fn(async (..._args: unknown[]) => ({
      status: "applied",
      request_id: REQUEST,
      local_repository_id: `local:${DEVICE}:${REPOSITORY}`,
      full_name: "owner/private-app",
    })),
    inspectOriginal: jest.fn((..._args: unknown[]) => ({
      requestId: REQUEST,
      state: "unconfirmed",
      descriptor: { kind: "repository", description: "Create private repository" },
      result: { preparation: "unknown" },
    })),
    getSavedAdmission: jest.fn(() => ({ state: "unknown" })),
    findOriginals: jest.fn(() => ({ operations: [], nextCursor: undefined })),
  };
  const select = jest.fn(() => bundle);
  const dependencies = {
    providers: [bundle],
    select,
    devices,
    workspace: transport,
    controller: transport,
    repositories,
    repositoryCreation,
  } as unknown as WorkspaceSemanticDependencies;
  return {
    service: createWorkspaceSemanticServices(dependencies),
    dependencies,
    bundle,
    resource,
    devices,
    transport,
    localBinding,
    repositories,
    repositoryCreation,
    select,
    setIdentity: (next: typeof identity) => {
      identity = next;
    },
    setView: (next: CodespaceSummaryView) => {
      current = next;
    },
  };
}

describe("semantic workspace backend", () => {
  test("normal Local discovery completes while the separately selected GitHub observation stays pending", async () => {
    const f = fixture();
    const local = fixture("local-sandboxes");
    f.dependencies.providers.push(
      local.bundle as unknown as WorkspaceSemanticDependencies["providers"][number],
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let githubCompleted = false;
    f.resource.listResources.mockImplementation(async () => {
      await held;
      return { codespaces: [view()], unavailable: [] };
    });
    const github = f.service
      .invoke(USER, "workspace_list", { provider: "github-codespaces" })
      .then((result) => {
        githubCompleted = true;
        return result;
      });
    try {
      const result = await f.service.invoke(USER, "workspace_list", {
        provider: "local-sandboxes",
      });
      expect(result).toMatchObject({
        workspaces: [{ provider: "local-sandboxes", state: "usable" }],
        provider_errors: [],
      });
      expect(githubCompleted).toBe(false);
      expect(local.bundle.connection.refreshGrants).not.toHaveBeenCalled();
      expect(f.bundle.connection.refreshGrants).not.toHaveBeenCalled();
    } finally {
      release();
      await github;
    }
  });
  test("explicit diagnostics keeps unavailable owned identities without inventing lifecycle authority", async () => {
    const f = fixture();
    const unavailable = {
      codespace_id: SPACE,
      provider: "github-codespaces",
      repository_id: "42",
      repository: "owner/missing",
      requested_ref: "main",
      created_at: 1,
      error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
      pending_request_ids: [REQUEST],
      device_id: DEVICE,
    };
    f.resource.listResources.mockResolvedValue({
      codespaces: [],
      unavailable: [unavailable],
      has_diagnostics: true,
    } as never);
    const result = (await f.service.invoke(USER, "workspace_list", {
      provider: "github-codespaces",
      view: "diagnostics",
    })) as {
      workspaces: Record<string, unknown>[];
      unavailable: Record<string, unknown>[];
    };
    expect(f.resource.listResources).toHaveBeenCalledWith(USER, { view: "diagnostics" });
    expect(result.workspaces).toEqual([]);
    expect(result.unavailable[0]).not.toHaveProperty("workspace");
    expect(result.unavailable[0]).not.toHaveProperty("state");
    expect(result.unavailable[0]).not.toHaveProperty("generation");
    expect(
      decodeReference(String(result.unavailable[0].identity), "workspace-identity").resourceId,
    ).toBe(SPACE);
    expect(result.unavailable[0].pending_operations).toHaveLength(1);
  });
  test("selected provider failure remains explicit and does not affect a healthy provider observation", async () => {
    const f = fixture();
    const local = fixture("local-sandboxes");
    f.dependencies.providers.push(
      local.bundle as unknown as WorkspaceSemanticDependencies["providers"][number],
    );
    f.resource.listResources.mockRejectedValue(
      new CodespaceResourceError(
        "CODESPACE_AUTHORIZATION_REQUIRED",
        "private credential diagnostic",
      ),
    );
    const failed = await f.service.invoke(USER, "workspace_list", {
      provider: "github-codespaces",
    });
    expect(failed).toMatchObject({
      workspaces: [],
      provider_errors: [
        { provider: "github-codespaces", error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" } },
      ],
    });
    expect(JSON.stringify(failed)).not.toContain("private credential diagnostic");
    expect(
      await f.service.invoke(USER, "workspace_list", { provider: "local-sandboxes" }),
    ).toMatchObject({
      workspaces: [{ state: "usable" }],
      provider_errors: [],
    });
  });
  test("observations whitelist public facts rather than exposing private provider routing", async () => {
    const f = fixture();
    f.setView(
      Object.assign(view(), {
        connectionId: "secret-connection",
        operationMarker: "secret-marker",
        providerResourceName: "secret-provider",
        claimId: "secret-claim",
        lastOutcome: "private diagnostic",
      }),
    );
    const result = await f.service.invoke(USER, "workspace_observe", { workspace: workspace() });
    expect(result).toMatchObject({ repository: "owner/repository", state: "usable" });
    expect(JSON.stringify(result)).not.toMatch(/secret-|private diagnostic/);
  });
  test.each(["start", "stop", "resume_setup"])(
    "%s consumes the reference generation without refreshing it",
    async (action) => {
      const f = fixture("local-sandboxes");
      const selected =
        action === "start"
          ? f.resource.startCodespace
          : action === "stop"
            ? f.resource.stopCodespace
            : f.resource.resumeSetup;
      selected.mockRejectedValue(
        new CodespaceResourceError("CODESPACE_GENERATION_CONFLICT", "Observed generation changed"),
      );
      const result = await f.service.invoke(
        USER,
        "workspace_lifecycle",
        { workspace: workspace("local-sandboxes", 3), action },
        REQUEST,
      );
      expect(selected).toHaveBeenCalledWith(USER, RESOURCE, REQUEST, 3);
      expect(f.resource.getCodespace).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        state: "completed",
        outcome: { ok: false, error: { code: "CODESPACE_GENERATION_CONFLICT" } },
      });
      expect(f.resource.create).not.toHaveBeenCalled();
    },
  );
  test.each(["local-sandboxes", "github-codespaces"])(
    "%s setup resume retains the same resource and separates remote failure from local readiness",
    async (provider) => {
      const f = fixture(provider);
      const state = provider === "github-codespaces" ? "start_pending" : "usable";
      f.resource.resumeSetup.mockResolvedValue(
        view({ provider, state, generation: 3, remote: { state: "unavailable" } }),
      );
      const result = await f.service.invoke(
        USER,
        "workspace_lifecycle",
        {
          workspace: workspace(provider as "local-sandboxes" | "github-codespaces"),
          action: "resume_setup",
        },
        REQUEST,
      );
      const observation = { state, remote: { state: "unavailable" } };
      expect(result).toMatchObject(
        provider === "github-codespaces"
          ? { state: "pending", original: observation }
          : { state: "completed", outcome: { ok: true, result: observation } },
      );
      expect(f.resource.resumeSetup).toHaveBeenCalledWith(USER, RESOURCE, REQUEST, 3);
      expect(f.resource.startCodespace).not.toHaveBeenCalled();
      expect(f.resource.create).not.toHaveBeenCalled();
    },
  );
  test("deletion needs confirmation and carries the captured precondition", async () => {
    const f = fixture();
    await expect(
      f.service.invoke(USER, "workspace_delete", { workspace: workspace() }, REQUEST),
    ).rejects.toThrow();
    expect(f.resource.deleteCodespace).not.toHaveBeenCalled();
    await f.service.invoke(
      USER,
      "workspace_delete",
      { workspace: workspace(), confirm_delete: true },
      REQUEST,
    );
    expect(f.resource.deleteCodespace).toHaveBeenCalledWith(USER, RESOURCE, 3, {
      requestId: REQUEST,
    });
  });
  test("scoped disposal uncertainty retains the original operation and never projects a confirmed stop", async () => {
    const f = fixture();
    f.resource.stopCodespace.mockRejectedValue(
      new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503),
    );
    const result = (await f.service.invoke(
      USER,
      "workspace_lifecycle",
      { workspace: workspace(), action: "stop" },
      REQUEST,
    )) as { operation: string };
    expect(result).toMatchObject({
      state: "unconfirmed",
      original: { error: { code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING" } },
    });
    expect(decodeReference(result.operation, "operation").requestId).toBe(REQUEST);
    expect(f.resource.getCodespace).not.toHaveBeenCalled();
  });
  test("target discovery returns selected controllers and installation references without internal authority fields", async () => {
    const f = fixture();
    const result = (await f.service.invoke(USER, "workspace_targets", {
      provider: "github-codespaces",
    })) as {
      targets: { target: string }[];
      controllers: { controller: string }[];
      installations: { installation: string }[];
    };
    expect(decodeReference(result.targets[0].target, "target")).toMatchObject({
      provider: "github-codespaces",
      repositoryId: "42",
      controller: owner,
    });
    expect(result.controllers).toEqual([{ controller, label: "My computer" }]);
    expect(decodeReference(result.installations[0].installation, "installation")).toEqual({
      controller: owner,
      installationId: "41",
    });
  });
  test("Local target discovery returns approved Local references without GitHub installation metadata", async () => {
    const f = fixture("local-sandboxes");
    f.resource.listRepositories.mockReturnValue([
      { id: `local:${DEVICE}:${REPOSITORY}`, fullName: "owner/local", private: true },
    ]);
    f.repositories.listDevices.mockResolvedValue({
      devices: [
        { device_id: DEVICE, label: "My computer", status: "active", owner_available: true },
      ],
      installations: [],
    });
    const result = (await f.service.invoke(USER, "workspace_targets", {
      provider: "local-sandboxes",
    })) as { targets: { target: string }[]; installations: unknown[] };
    expect(decodeReference(result.targets[0].target, "target")).toMatchObject({
      provider: "local-sandboxes",
      repositoryId: `local:${DEVICE}:${REPOSITORY}`,
      controller: owner,
    });
    expect(result.installations).toEqual([]);
  });
  test("lost creation replies return an original operation collectable without resubmission or provider reads", async () => {
    const f = fixture();
    f.resource.create.mockRejectedValue(
      new CodespaceResourceError("WORKSPACE_OUTCOME_UNCONFIRMED", "private internal diagnosis"),
    );
    const target = encodeReference("target", {
      provider: "github-codespaces",
      repositoryId: "42",
      controller: owner,
    });
    const result = (await f.service.invoke(
      USER,
      "workspace_create",
      { target, branch: "main" },
      REQUEST,
    )) as { operation: string };
    expect(result).toMatchObject({
      state: "unconfirmed",
      original: { error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
    });
    expect(decodeReference(result.operation, "operation")).toEqual({
      owner: { kind: "controller", ...owner },
      requestId: REQUEST,
      kind: "lifecycle",
    });
    expect(
      await f.service.invoke(USER, "operation_get", { reference: result.operation }),
    ).toMatchObject({
      operation: result.operation,
      state: "unconfirmed",
    });
    expect(f.resource.create).toHaveBeenCalledTimes(1);
    expect(f.devices.getOperation).toHaveBeenCalledWith(USER, DEVICE, REQUEST);
    expect(f.resource.getCodespace).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private internal diagnosis");
  });
  test("external adoption binds verified observed generation and selected controller without creating a replacement", async () => {
    const f = fixture();
    await f.service.invoke(
      USER,
      "workspace_adopt_external",
      { controller, name: "owned-stopped-vm" },
      REQUEST,
    );
    expect(f.resource.registerExisting).toHaveBeenCalledWith(USER, "owned-stopped-vm", {
      requestId: REQUEST,
      deviceId: DEVICE,
    });
    expect(f.resource.adopt).toHaveBeenCalledWith(USER, RESOURCE, REQUEST, 7, { deviceId: DEVICE });
    expect(f.resource.create).not.toHaveBeenCalled();
  });
  test.each([
    [422, "retention_period_minutes exceeds the maximum for this owner"],
    [402, "Codespaces usage not allowed by the configured budget"],
  ])(
    "confirmed provider HTTP%s refusal retains its safe reason and original operation",
    async (status, reason) => {
      const f = fixture();
      const refusal = new CodespaceResourceError(
        "CODESPACE_CREATE_REJECTED",
        "Codespace creation was rejected",
        String(reason),
        true,
      );
      refusal.providerFailure = {
        kind: "http",
        phase: "request",
        status: Number(status),
        githubRequestId: "AB12:CD34",
        reason: String(reason),
      };
      f.resource.create.mockRejectedValue(refusal);
      const target = encodeReference("target", {
        provider: "github-codespaces",
        repositoryId: "42",
        controller: owner,
      });
      const result = (await f.service.invoke(
        USER,
        "workspace_create",
        { target, branch: "main" },
        REQUEST,
      )) as { operation: string; outcome: { error: { message: string } } };
      expect(result).toMatchObject({
        state: "completed",
        outcome: { ok: false, error: { code: "CODESPACE_CREATE_REJECTED" } },
      });
      expect(result.outcome.error.message).toContain(reason);
      expect(decodeReference(result.operation, "operation").requestId).toBe(REQUEST);
    },
  );
  test("unassigned observed GitHub adoption uses an explicit controller and captured generation", async () => {
    const f = fixture();
    const unassigned = encodeReference("workspace", {
      resourceId: RESOURCE,
      provider: "github-codespaces",
      generation: 7,
    });
    await f.service.invoke(USER, "workspace_adopt", { workspace: unassigned, controller }, REQUEST);
    expect(f.resource.adopt).toHaveBeenCalledWith(USER, RESOURCE, REQUEST, 7, { deviceId: DEVICE });
    expect(f.resource.registerExisting).not.toHaveBeenCalled();
  });
  test("Local operation owner resolves retained records instead of requesting a native snapshot", async () => {
    const f = fixture("local-sandboxes");
    const original = {
      kind: "local" as const,
      deviceId: DEVICE,
      spaceId: SPACE,
      operationMarker: `moira-${"a".repeat(24)}`,
    };
    expect(await f.service.resolveOwner(USER, original)).toMatchObject({
      resourceId: RESOURCE,
      owner: original,
    });
    expect(f.transport.json).toHaveBeenCalledWith(USER, DEVICE, {
      method: "POST",
      path: "/v1/controller/workspaces/resolve",
      body: { deviceId: DEVICE, spaceId: SPACE, operationMarker: original.operationMarker },
    });
    expect(f.resource.getCodespace).not.toHaveBeenCalled();
    f.transport.json.mockResolvedValue({ ...f.localBinding, localSpaceId: RESOURCE });
    await expect(f.service.resolveOwner(USER, original)).rejects.toThrow();
  });
  test("reconnect during retained resolution refuses the stale reply", async () => {
    const f = fixture("local-sandboxes");
    f.transport.json.mockImplementationOnce(async () => {
      f.setIdentity({ userId: USER, deviceId: DEVICE, deviceGeneration: 1, connectionId: SPACE });
      return {} as never;
    });
    await expect(
      f.service.resolveWorkspace(USER, workspace("local-sandboxes")),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
  });
  test("foreign controller and mismatching provider references fail before effects", async () => {
    const f = fixture();
    await expect(
      f.service.invoke(
        USER,
        "repository_admit",
        {
          controller: encodeReference("controller", { deviceId: DEVICE, connectionId: SPACE }),
          repository: "42",
        },
        REQUEST,
      ),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    await expect(
      f.service.invoke(
        USER,
        "workspace_lifecycle",
        { workspace: workspace("local-sandboxes"), action: "start" },
        REQUEST,
      ),
    ).rejects.toThrow();
    expect(f.repositories.addExistingRepository).not.toHaveBeenCalled();
    expect(f.resource.startCodespace).not.toHaveBeenCalled();
  });
  test("repository admission works before provider selection and retains incomplete original identity", async () => {
    const f = fixture();
    f.select.mockImplementation(() => {
      throw new Error("Provider selection is not admission authority");
    });
    f.repositories.addExistingRepository.mockResolvedValue({
      status: "pending",
      request_id: REQUEST,
      local_repository_id: null,
    } as never);
    const result = (await f.service.invoke(
      USER,
      "repository_admit",
      { controller, repository: "42" },
      REQUEST,
    )) as { operation: string };
    expect(result).toMatchObject({ state: "pending", original: { status: "pending" } });
    expect(f.repositories.addExistingRepository).toHaveBeenCalledWith(USER, {
      deviceId: DEVICE,
      repositoryId: "42",
      requestId: REQUEST.slice(4),
    });
    expect(f.select).not.toHaveBeenCalled();
    expect(decodeReference(result.operation, "operation").requestId).toBe(REQUEST.slice(4));
  });
  test.each(["unknown", "setup_required"])(
    "private repository %s preserves original creation journal and collection",
    async (status) => {
      const f = fixture();
      f.repositoryCreation.createRepository.mockResolvedValue({
        status,
        request_id: REQUEST,
        local_repository_id: null,
      } as never);
      const result = (await f.service.invoke(
        USER,
        "repository_create",
        { controller, installation, name: "private-app" },
        REQUEST,
      )) as { operation: string };
      expect(f.repositoryCreation.createRepository).toHaveBeenCalledWith(USER, {
        deviceId: DEVICE,
        requestId: REQUEST.slice(4),
        repositoryName: "private-app",
        installationId: "41",
      });
      expect(decodeReference(result.operation, "operation")).toMatchObject({
        journal: "repository-create",
        requestId: REQUEST.slice(4),
      });
      await f.service.invoke(USER, "operation_get", { reference: result.operation });
      expect(f.repositoryCreation.inspectOriginal).toHaveBeenCalledWith(
        USER,
        DEVICE,
        CONNECTION,
        REQUEST.slice(4),
      );
      expect(f.repositoryCreation.createRepository).toHaveBeenCalledTimes(1);
      expect(f.select).not.toHaveBeenCalled();
      expect(result).toMatchObject({ state: status === "unknown" ? "unconfirmed" : "pending" });
    },
  );
  test("current repository consent refusal retains original uncertainty and installation/controller mismatch never dispatches", async () => {
    const f = fixture();
    f.repositories.addExistingRepository.mockRejectedValue(
      new LocalDeviceError("LOCAL_UNAUTHORIZED", "Apply owner delegation in Settings first."),
    );
    expect(
      await f.service.invoke(USER, "repository_admit", { controller, repository: "42" }, REQUEST),
    ).toMatchObject({ state: "unconfirmed", original: { error: { code: "LOCAL_UNAUTHORIZED" } } });
    const foreign = encodeReference("installation", {
      controller: { deviceId: DEVICE, connectionId: SPACE },
      installationId: "41",
    });
    expect(
      await f.service.invoke(
        USER,
        "repository_create",
        { controller, installation: foreign, name: "private-app" },
        REQUEST,
      ),
    ).toMatchObject({ outcome: { ok: false, error: { code: "CODESPACE_RESOURCE_INVALID" } } });
    expect(f.repositoryCreation.createRepository).not.toHaveBeenCalled();
  });
  test("repository applied receipts return reusable targets and original discovery does not resubmit", async () => {
    const f = fixture();
    const admitted = (await f.service.invoke(
      USER,
      "repository_admit",
      { controller, repository: "42" },
      REQUEST,
    )) as { outcome: { result: { target: string } } };
    expect(decodeReference(admitted.outcome.result.target, "target")).toMatchObject({
      provider: "local-sandboxes",
      repositoryId: `local:${DEVICE}:${REPOSITORY}`,
      controller: owner,
    });
    f.transport.json.mockResolvedValue({
      operations: [
        {
          requestId: REQUEST,
          state: "unconfirmed",
          kind: "lifecycle",
          descriptor: { kind: "lifecycle", description: "Workspace start", createdAt: 1 },
        },
      ],
    } as never);
    f.repositoryCreation.findOriginals.mockReturnValue({
      operations: [
        {
          requestId: REQUEST.slice(4),
          state: "unconfirmed",
          descriptor: { kind: "repository", description: "Create private repository" },
        },
      ],
      nextCursor: undefined,
    } as never);
    const found = (await f.service.invoke(USER, "operation_find", { owner: controller })) as {
      operations: { operation: string }[];
    };
    expect(found.operations).toHaveLength(2);
    expect(
      found.operations.map((row) => decodeReference(row.operation, "operation").requestId),
    ).toEqual([REQUEST, REQUEST.slice(4)]);
    expect(f.repositories.addExistingRepository).toHaveBeenCalledTimes(1);
    expect(f.repositoryCreation.createRepository).not.toHaveBeenCalled();
    expect(f.devices.getOperation).not.toHaveBeenCalled();
  });
  test.each([
    ["LOCAL_CONTROL_PENDING", "completed"],
    ["LOCAL_CREATE_UNKNOWN", "unconfirmed"],
    ["WORKSPACE_OUTCOME_UNKNOWN", "unconfirmed"],
  ])("original controller %s has the same honest state in get and find", async (code, state) => {
    const f = fixture();
    const receipt = {
      requestId: REQUEST,
      state: "completed",
      outcome: {
        ok: false,
        error: {
          code,
          message:
            code === "LOCAL_CONTROL_PENDING"
              ? "A previous physical settings effect needs owner settlement."
              : "The original physical outcome has not been proved.",
        },
      },
    };
    const retained = JSON.stringify(receipt);
    f.devices.getOperation.mockResolvedValue(receipt as never);
    f.transport.json.mockResolvedValue({
      operations: [
        {
          ...receipt,
          descriptor: { kind: "lifecycle", description: "Original workspace start", createdAt: 1 },
        },
      ],
    } as never);
    const reference = encodeReference("operation", {
      owner: { kind: "controller", ...owner },
      requestId: REQUEST,
      kind: "lifecycle",
    });
    const collected = await f.service.invoke(USER, "operation_get", { reference });
    expect(collected).toMatchObject(
      state === "completed"
        ? { operation: reference, state, outcome: receipt.outcome }
        : { operation: reference, state, original: { outcome: receipt.outcome } },
    );
    const discovered = (await f.service.invoke(USER, "operation_find", {
      owner: controller,
      kind: "lifecycle",
    })) as { operations: Record<string, unknown>[] };
    expect(discovered.operations).toEqual([
      {
        operation: reference,
        state,
        descriptor: { kind: "lifecycle", description: "Original workspace start", createdAt: 1 },
      },
    ]);
    expect(discovered.operations[0]).not.toHaveProperty("outcome");
    expect(JSON.stringify(receipt)).toBe(retained);
    expect(f.devices.getOperation).toHaveBeenCalledTimes(1);
    expect(f.transport.json).toHaveBeenCalledTimes(1);
    expect(f.resource.create).not.toHaveBeenCalled();
    expect(f.resource.startCodespace).not.toHaveBeenCalled();
    expect(f.resource.stopCodespace).not.toHaveBeenCalled();
    expect(f.repositories.addExistingRepository).not.toHaveBeenCalled();
    expect(f.repositoryCreation.createRepository).not.toHaveBeenCalled();
  });
  test("a malformed discovery cursor is an invalid request rather than an internal failure", async () => {
    const f = fixture();
    await expect(
      f.service.invoke(USER, "operation_find", {
        owner: controller,
        cursor: "not-a-returned-cursor",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(f.transport.json).not.toHaveBeenCalled();
    expect(f.repositoryCreation.findOriginals).not.toHaveBeenCalled();
  });
  test("explicit resume refuses non-repository originals without treating them as a retry command", async () => {
    const f = fixture();
    const reference = encodeReference("operation", {
      owner: { kind: "controller", ...owner },
      requestId: REQUEST,
      kind: "lifecycle",
    });
    await expect(f.service.invoke(USER, "operation_resume", { reference })).rejects.toMatchObject({
      code: "CODESPACE_RESOURCE_INVALID",
    });
    expect(f.repositoryCreation.getSavedAdmission).not.toHaveBeenCalled();
    expect(f.repositoryCreation.createRepository).not.toHaveBeenCalled();
    expect(f.resource.startCodespace).not.toHaveBeenCalled();
  });
  test("initial repository rejection is a failed outcome and repository results hide control plumbing", async () => {
    const f = fixture();
    f.repositoryCreation.createRepository.mockResolvedValue({
      status: "rejected",
      device_id: DEVICE,
      request_id: REQUEST,
      revision: 7,
      instruction: "repository_add with local_repository_id and fresh request_id",
      error: { code: "LOCAL_REPOSITORY_NAME_EXISTS", message: "private raw plumbing" },
    } as never);
    const rejected = await f.service.invoke(
      USER,
      "repository_create",
      { controller, installation, name: "private-app" },
      REQUEST,
    );
    expect(rejected).toMatchObject({
      state: "completed",
      outcome: { ok: false, error: { code: "LOCAL_REPOSITORY_NAME_EXISTS" } },
    });
    expect(JSON.stringify(rejected)).not.toMatch(
      /device_id|request_id|local_repository_id|private raw plumbing/,
    );
    f.repositoryCreation.createRepository.mockResolvedValue({
      status: "applied",
      device_id: DEVICE,
      request_id: REQUEST,
      revision: 7,
      instruction: "Use local_repository_id with codespace create",
      local_repository_id: `local:${DEVICE}:${REPOSITORY}`,
      full_name: "owner/private-app",
    } as never);
    const applied = (await f.service.invoke(
      USER,
      "repository_create",
      { controller, installation, name: "private-app" },
      REQUEST,
    )) as { outcome: { result: Record<string, unknown> } };
    expect(applied).toMatchObject({
      state: "completed",
      outcome: { ok: true, result: { status: "applied" } },
    });
    expect(decodeReference(String(applied.outcome.result.target), "target").repositoryId).toBe(
      `local:${DEVICE}:${REPOSITORY}`,
    );
    for (const key of ["request_id", "device_id", "revision", "local_repository_id"])
      expect(applied.outcome.result).not.toHaveProperty(key);
    expect(applied.outcome.result.instruction).not.toMatch(/codespace create|local_repository_id/);
  });
  test("an absent repository original cannot reconstruct or create replacement input", async () => {
    const f = fixture();
    f.repositoryCreation.getSavedAdmission.mockReturnValue(null as never);
    f.repositoryCreation.inspectOriginal.mockReturnValue({ state: "absent" } as never);
    const reference = encodeReference("operation", {
      owner: { kind: "controller", ...owner },
      requestId: REQUEST.slice(4),
      kind: "repository",
      journal: "repository-create",
    });
    const result = await f.service.invoke(USER, "operation_resume", { reference });
    expect(result).toMatchObject({ operation: reference, state: "absent" });
    expect(f.repositoryCreation.createRepository).not.toHaveBeenCalled();
    expect(f.resource.create).not.toHaveBeenCalled();
    expect(f.repositories.addExistingRepository).not.toHaveBeenCalled();
  });
  test("an exhausted discovery cursor still requires current controller authority", async () => {
    const f = fixture();
    const cursor = Buffer.from(JSON.stringify({ controller: null, repositories: null })).toString(
      "base64url",
    );
    f.setIdentity({ userId: USER, deviceId: DEVICE, connectionId: SPACE, deviceGeneration: 2 });
    await expect(
      f.service.invoke(USER, "operation_find", {
        owner: controller,
        cursor,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    expect(f.transport.json).not.toHaveBeenCalled();
    expect(f.repositoryCreation.findOriginals).not.toHaveBeenCalled();
  });
  test("public schemas accept Unicode Git branches and refuse service metadata, grants and arbitrary URLs", () => {
    expect(
      WORKSPACE_TOOL_SCHEMAS.pull_request_create.safeParse({
        workspace: workspace(),
        head: "feat/игра",
        base: "релиз",
        title: "Игра",
      }).success,
    ).toBe(true);
    for (const extra of [
      { request_id: REQUEST },
      { generation: 3 },
      { owner: "other" },
      { allowPush: true },
      { url: "https://github.test/owner/repo" },
    ])
      expect(
        WORKSPACE_TOOL_SCHEMAS.repository_admit.safeParse({
          controller,
          repository: "42",
          ...extra,
        }).success,
      ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.workspace_lifecycle.safeParse({
        workspace: workspace(),
        action: "adopt",
      }).success,
    ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.repository_create.safeParse({
        controller,
        installation,
        name: "private-app.git",
      }).success,
    ).toBe(false);
    expect(
      WORKSPACE_TOOL_SCHEMAS.command_run.safeParse({
        workspace: workspace(),
        command: { argv: ["printf", ""] },
        timeout_seconds: 5 * 24 * 3600,
        max_stdout_bytes: 16 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });
});
