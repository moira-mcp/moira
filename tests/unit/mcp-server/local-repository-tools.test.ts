import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  LocalDeviceError,
  CodespaceResourceError,
  type CodespaceOperationRecord,
} from "@mcp-moira/shared";
import {
  executeCodespaceTool,
  parseCodespaceToolParams,
  type CodespaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-codespaces.js";
import { codespaceSchema } from "../../../packages/mcp-server/src/tools/tool-schemas.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
afterEach(() => {
  jest.useRealTimers();
});

/** Admission must work before a repository becomes available to provider selection. */
function services(): CodespaceToolServices {
  const unexpected = () => {
    throw new Error("Provider selection/readiness is not admission authority");
  };
  return {
    connection: { getStatus: unexpected, refreshGrants: unexpected },
    observability: { readiness: unexpected, limitsWithBilling: unexpected },
    guidance: unexpected,
    select: jest.fn(unexpected),
    resource: null,
    operation: null,
    file: null,
    localRepositories: {
      listDevices: jest.fn(() => ({ devices: [{ device_id: DEVICE_ID, delegation: null }] })),
      addExistingRepository: jest.fn(async () => ({
        status: "applied",
        device_id: DEVICE_ID,
        request_id: REQUEST_ID,
        revision: 4,
        local_repository_id: "approved-local-repository",
        error: null,
      })),
    },
  };
}

describe("local repository MCP admission", () => {
  it.each([
    ["CODESPACE_LOCAL_CREATION_UNKNOWN", "do not create a replacement"],
    ["CODESPACE_LOCAL_PROTOCOL_ERROR", "matching server and companion"],
    ["CODESPACE_LOCAL_RUNTIME_ERROR", "runtime diagnostics"],
    ["CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED", "Allow deletion"],
  ] as const)(
    "preserves actionable local diagnostic %s without private runtime output",
    async (code, instruction) => {
      const dependencies = services();
      dependencies.select = () => {
        throw new CodespaceResourceError(code, "private-runtime-path credential-not-for-agent");
      };
      const response = await executeCodespaceTool(
        parseCodespaceToolParams({ action: "get", codespace_id: DEVICE_ID }),
        "owner",
        dependencies,
      );
      expect(response.isError).toBe(true);
      expect(response.structuredContent).toMatchObject({ error: { code, retryable: false } });
      expect(JSON.stringify(response.structuredContent)).toContain(instruction);
      expect(JSON.stringify(response)).not.toContain("private-runtime-path");
      expect(JSON.stringify(response)).not.toContain("credential-not-for-agent");
      expect(JSON.stringify(response)).not.toContain("data are preserved");
      expect(JSON.stringify(response)).not.toContain("data is preserved");
      if (code !== "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED")
        expect(JSON.stringify(response)).toContain("physical outcome is not confirmed");
    },
  );
  it("preserves creation recovery state before repository-provider selection", async () => {
    const dependencies = services();
    let status = "unknown";
    dependencies.localRepositoryCreation = {
      createRepository: async (userId, input) => ({
        status,
        device_id: input.deviceId,
        request_id: input.requestId,
        github_repository_id: null,
        full_name: null,
        local_repository_id: null,
        instruction: `Resume ${userId}'s same creation request`,
      }),
    };
    const input = {
      action: "repository_create",
      device_id: DEVICE_ID,
      request_id: REQUEST_ID,
      repository_name: "private-app",
      installation_id: "41",
    };
    expect(codespaceSchema.safeParse(input).success).toBe(true);
    for (status of ["unknown", "setup_required"]) {
      const result = await executeCodespaceTool(
        parseCodespaceToolParams(input),
        "owner",
        dependencies,
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        request_id: REQUEST_ID,
        error: {
          code: "LOCAL_ADMISSION_UNCONFIRMED",
          message: "Resume owner's same creation request",
        },
      });
    }
    expect(dependencies.select).not.toHaveBeenCalled();
  });

  it("rejects creation overrides and malformed identities before dispatch", () => {
    const input = {
      action: "repository_create",
      device_id: DEVICE_ID,
      request_id: REQUEST_ID,
      repository_name: "private-app",
      installation_id: "41",
    };
    for (const invalid of [
      { owner: "other" },
      { private: false },
      { marker: "caller-owned" },
      { allowPush: true },
      { repository_name: "owner/repository" },
      { repository_name: ".." },
      { repository_name: "private-app.git" },
      { installation_id: "https://github.test/installation" },
      { request_id: undefined },
    ]) {
      expect(() => parseCodespaceToolParams({ ...input, ...invalid })).toThrow();
    }
  });

  it("waits for private repository acknowledgement while preserving the original creation identity", async () => {
    const dependencies = services();
    jest.useFakeTimers();
    const create = jest
      .fn<NonNullable<CodespaceToolServices["localRepositoryCreation"]>["createRepository"]>()
      .mockResolvedValueOnce({
        status: "pending",
        request_id: REQUEST_ID,
        local_repository_id: null,
      })
      .mockResolvedValue({
        status: "applied",
        request_id: REQUEST_ID,
        local_repository_id: "approved-private-repository",
        full_name: "owner/private-app",
      });
    dependencies.localRepositoryCreation = { createRepository: create };
    const pending = executeCodespaceTool(
      parseCodespaceToolParams({
        action: "repository_create",
        device_id: DEVICE_ID,
        request_id: REQUEST_ID,
        repository_name: "private-app",
        installation_id: "41",
      }),
      "owner",
      dependencies,
    );
    await jest.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      repository_id: "approved-private-repository",
      name: "owner/private-app",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual([
      "owner",
      {
        deviceId: DEVICE_ID,
        requestId: REQUEST_ID,
        repositoryName: "private-app",
        installationId: "41",
      },
    ]);
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(dependencies.select).not.toHaveBeenCalled();
  });

  it("discovers devices without treating disconnected cloud readiness as local authority", async () => {
    const dependencies = services();
    dependencies.localRepositories!.listDevices = async () => ({
      devices: [
        {
          device_id: DEVICE_ID,
          delegation: null,
          label: "My computer",
          status: "active",
          enabled: true,
          lease_until: 123,
          revision: 4,
        },
      ],
      installations: [
        { installation_id: "41", owner: "personal", repository_selection: "selected" },
      ],
    });
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "local_devices" }),
      "owner",
      dependencies,
    );
    expect(result.structuredContent).toEqual({
      devices: [{ device_id: DEVICE_ID, label: "My computer", status: "active", enabled: true }],
      installations: [{ installation_id: "41", owner: "personal" }],
    });
    expect(dependencies.select).not.toHaveBeenCalled();
  });

  it("waits for pending admission using the same request and returns only the approved repository", async () => {
    const dependencies = services();
    jest.useFakeTimers();
    const add = jest
      .fn<NonNullable<CodespaceToolServices["localRepositories"]>["addExistingRepository"]>()
      .mockResolvedValueOnce({
        status: "pending",
        request_id: REQUEST_ID,
        local_repository_id: null,
      })
      .mockResolvedValue({
        status: "applied",
        request_id: REQUEST_ID,
        local_repository_id: "approved-local-repository",
      });
    dependencies.localRepositories!.addExistingRepository = add;
    const request = {
      action: "repository_add",
      device_id: DEVICE_ID,
      repository_id: "42",
      request_id: REQUEST_ID,
    };
    expect(codespaceSchema.safeParse(request).success).toBe(true);
    const pending = executeCodespaceTool(parseCodespaceToolParams(request), "owner", dependencies);
    await jest.advanceTimersByTimeAsync(500);
    const result = await pending;
    expect(dependencies.localRepositories!.addExistingRepository).toHaveBeenCalledWith("owner", {
      deviceId: DEVICE_ID,
      repositoryId: "42",
      requestId: REQUEST_ID,
    });
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1]).toEqual(add.mock.calls[0]);
    expect(result.structuredContent).toEqual({ repository_id: "approved-local-repository" });
    expect(dependencies.select).not.toHaveBeenCalled();
  });

  it("returns an actionable denial without bypassing applied owner consent", async () => {
    const dependencies = services();
    dependencies.localRepositories!.addExistingRepository = jest.fn(async () => {
      throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Apply owner delegation in Settings first.");
    });
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "repository_add",
        device_id: DEVICE_ID,
        repository_id: "42",
        request_id: REQUEST_ID,
      }),
      "owner",
      dependencies,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "LOCAL_UNAUTHORIZED",
        message: "Apply owner delegation in Settings first.",
      },
    });
  });

  it("returns a creation consent denial before any repository provider is selected", async () => {
    const dependencies = services();
    dependencies.localRepositoryCreation = {
      createRepository: async () => {
        throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Apply new-repository consent first.");
      },
    };
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "repository_create",
        device_id: DEVICE_ID,
        request_id: REQUEST_ID,
        repository_name: "private-app",
        installation_id: "41",
      }),
      "owner",
      dependencies,
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "LOCAL_UNAUTHORIZED", message: "Apply new-repository consent first." },
    });
  });

  it("rejects caller-supplied grants, arbitrary URLs, owner and provider selection", () => {
    const request = {
      action: "repository_add",
      device_id: DEVICE_ID,
      repository_id: "42",
      request_id: REQUEST_ID,
    };
    for (const extra of [
      { owner: "other" },
      { domains: ["example.test"] },
      { allowPush: true },
      { provider: "local" },
    ]) {
      expect(() => parseCodespaceToolParams({ ...request, ...extra })).toThrow();
    }
    expect(() =>
      parseCodespaceToolParams({ ...request, repository_id: "https://github.test/owner/repo" }),
    ).toThrow();
    expect(() => parseCodespaceToolParams({ ...request, request_id: undefined })).toThrow();
  });

  it("image resume carries only durable operation identity", () => {
    const resume = { action: "preview_image", codespace_id: DEVICE_ID, operation_id: REQUEST_ID };
    expect(parseCodespaceToolParams(resume)).toMatchObject({
      action: "preview_image",
      request: {
        codespace_id: DEVICE_ID,
        operation_id: REQUEST_ID,
      },
    });
    expect(() => parseCodespaceToolParams({ ...resume, path: "different.png" })).toThrow();
    expect(() => parseCodespaceToolParams({ ...resume, mime_type: "image/png" })).toThrow();
  });

  it("image resume stays bound to its owned codespace and download kind without redispatch", async () => {
    const dependencies = services();
    const unexpected = () => {
      throw new Error("Unexpected new operation dispatch");
    };
    dependencies.select = undefined;
    dependencies.connection.getStatus = () => ({
      state: "connected",
      reason: null,
      settingsUrl: "https://moira.example/settings",
      installationUrl: null,
      account: null,
      installations: [],
      repositories: [],
      canConnect: false,
      canDisconnect: true,
    });
    dependencies.guidance = (situation) => ({
      provider: "local-sandboxes",
      situation,
      instruction: null,
      links: [],
    });
    dependencies.resource = {
      listRepositories: unexpected,
      setupSituation: unexpected,
      listResources: unexpected,
      refreshProviderState: unexpected,
      getCodespace: unexpected,
      create: unexpected,
      startCodespace: unexpected,
      stopCodespace: unexpected,
      deleteCodespace: unexpected,
      waitForState: unexpected,
    };
    let owned: CodespaceOperationRecord | null = {
      id: REQUEST_ID,
      userId: "owner",
      resourceId: DEVICE_ID,
      resourceGeneration: 3,
      authorizationGeneration: 7,
      provider: "local-sandboxes",
      providerResourceName: "private-runtime",
      remoteMarker: "private-marker",
      kind: "download",
      state: "running",
      inputBytes: 0,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 1,
      outputBytes: 0,
      exitCode: null,
      remoteCleanupPending: 0,
      resultExpiresAt: 500,
      deadlineAt: 400,
      claimId: null,
      claimExpiresAt: null,
      lastOutcome: "pending",
      createdAt: 100,
      updatedAt: 200,
    };
    dependencies.operation = {
      get: jest.fn(() => owned),
      execute: unexpected,
      executeNativeReference: unexpected,
      reconcile: unexpected,
      readOutput: unexpected,
      cancel: unexpected,
      waitForResult: unexpected,
    };
    dependencies.file = {
      execute: jest.fn(unexpected),
      uploadReference: unexpected,
      downloadReference: unexpected,
      reconcileDownloadReference: unexpected,
      waitForDownloadReference: unexpected,
      reconcile: unexpected,
      waitForResult: jest.fn(async () => {
        if (!owned) throw new Error("Missing owned operation");
        return { operation: owned, result: null };
      }),
    };
    const call = parseCodespaceToolParams({
      action: "preview_image",
      codespace_id: DEVICE_ID,
      operation_id: REQUEST_ID,
    });
    const unknown = await executeCodespaceTool(call, "owner", dependencies);
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({
      operation_id: REQUEST_ID,
      error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
    });
    expect(dependencies.file.waitForResult).toHaveBeenCalledWith("owner", REQUEST_ID);
    expect(dependencies.file.execute).not.toHaveBeenCalled();
    for (const changed of [{ resourceId: REQUEST_ID }, { kind: "read" as const }]) {
      owned = { ...owned!, ...changed };
      expect((await executeCodespaceTool(call, "owner", dependencies)).isError).toBe(true);
    }
    owned = null;
    expect((await executeCodespaceTool(call, "other-owner", dependencies)).isError).toBe(true);
    expect(dependencies.file.waitForResult).toHaveBeenCalledTimes(1);
  });
});
