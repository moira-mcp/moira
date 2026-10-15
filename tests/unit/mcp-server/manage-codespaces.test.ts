import { describe, expect, it, jest } from "@jest/globals";
import {
  CodespaceResourceError,
  ScopedCredentialError,
  type CodespaceGuidanceSituation,
  type CodespaceSummaryView,
} from "@mcp-moira/shared";

import {
  executeCodespaceTool,
  parseCodespaceToolParams,
  codespaceToolLogContext,
  CodespaceRequestInvalidError,
  type CodespaceToolServices,
} from "../../../packages/mcp-server/src/tools/manage-codespaces.js";
import { codespaceSchema } from "../../../packages/mcp-server/src/tools/tool-schemas.js";

const USER_ID = "user-a";
const CODESPACE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "ws1-00000000-0000-4000-8000-000000000002";
const OTHER_CODESPACE_ID = "00000000-0000-4000-8000-000000000003";
const REQUEST_ID = "ws1-00000000-0000-4000-8000-000000000004";
const OTHER_REQUEST_ID = "00000000-0000-4000-8000-000000000005";

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

function services(overrides: Partial<CodespaceToolServices> = {}): CodespaceToolServices {
  let current = codespace();
  return {
    observability: {
      readiness: jest.fn(async () => ({
        state: "ready" as const,
        reason: null,
        provider: "github-codespaces",
        configuration: "available" as const,
        resources_enabled: true,
        checked_at: 50,
      })),
    },
    connection: {
      getStatus: jest.fn(() => ({
        state: "connected" as const,
        reason: null,
        settingsUrl: "https://moira.example/settings/integrations",
        installationUrl: null,
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      })),
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: false })),
    },
    guidance: (situation: CodespaceGuidanceSituation) => ({
      provider: "github-codespaces",
      situation,
      instruction: `do this for ${situation}`,
      links: [
        { id: "settings", url: "https://moira.example/settings", label: "Moira settings" },
        { id: "install", url: "https://github.test/install", label: "Install the app" },
        {
          id: "create_repository",
          url: "https://github.test/new",
          label: "New repository",
        },
      ],
    }),
    resource: {
      listRepositories: jest.fn(() => [{ id: "42", fullName: "owner/repository", private: true }]),
      setupSituation: jest.fn(async (_userId: string, _repositoryId?: string) => "ready" as const),
      listResources: jest.fn(async () => [codespace()]),
      refreshProviderState: jest.fn(async () => ({ stale: false })),
      getCodespace: jest.fn(async () => current),
      create: jest.fn(async () => codespace()),
      startCodespace: jest.fn(async () => (current = codespace())),
      stopCodespace: jest.fn(
        async () =>
          (current = codespace({
            state: "stopped",
            desired_state: "stopped",
            observed_state: "stopped",
            generation: 4,
          })),
      ),
      deleteCodespace: jest.fn(
        async () =>
          (current = codespace({
            state: "deleted",
            desired_state: "deleted",
            observed_state: "absent",
            generation: 4,
          })),
      ),
    },
    workspace: {
      request: async () => {
        throw new Error("Unexpected workspace call");
      },
      json: async () => {
        throw new Error("Unexpected workspace call");
      },
    },
    ...overrides,
  };
}

function data(result: Awaited<ReturnType<typeof executeCodespaceTool>>) {
  return result.structuredContent as Record<string, unknown>;
}

describe("codespace lifecycle and discovery adapter", () => {
  it("registers a verified existing GitHub VM and adopts the same ID and owner CAS without creating a replacement", async () => {
    const dependencies = services({ provider: "github-codespaces" });
    const existing = {
      ...codespace({ generation: 7, state: "stopped", desired_state: "stopped" }),
      machine: null,
    };
    dependencies.resource!.registerExisting = jest.fn(async () => existing);
    dependencies.resource!.adopt = jest.fn(async () => ({
      ...existing,
      state: "usable" as const,
      desired_state: "running" as const,
      generation: 8,
    }));
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "adopt",
        provider_resource_name: "owned-stopped-vm",
        request_id: REQUEST_ID,
        device_id: OTHER_CODESPACE_ID,
      }),
      USER_ID,
      dependencies,
    );
    expect(dependencies.resource!.registerExisting).toHaveBeenCalledWith(
      USER_ID,
      "owned-stopped-vm",
      { requestId: REQUEST_ID, deviceId: OTHER_CODESPACE_ID },
    );
    expect(dependencies.resource!.adopt).toHaveBeenCalledWith(
      USER_ID,
      CODESPACE_ID,
      REQUEST_ID,
      7,
      { deviceId: OTHER_CODESPACE_ID },
    );
    expect(dependencies.resource!.create).not.toHaveBeenCalled();
    expect(data(result)).toMatchObject({
      codespace_id: CODESPACE_ID,
      request_id: REQUEST_ID,
      state: "usable",
      generation: 8,
    });
  });
  it("keeps a lost GitHub creation's original request and selected controller so pure operation collection does not submit creation again", async () => {
    const dependencies = services({ provider: "github-codespaces" });
    dependencies.resource!.create = jest.fn(async () => {
      const error = new CodespaceResourceError(
        "WORKSPACE_OUTCOME_UNCONFIRMED",
        "private internal diagnosis",
      );
      error.requestId = REQUEST_ID;
      error.deviceId = OTHER_CODESPACE_ID;
      error.providerFailure = {
        kind: "http",
        phase: "request",
        status: 503,
        githubRequestId: "AB12:CD34",
        reason: "Service unavailable",
      };
      throw error;
    });
    const collect = jest.fn(async (_userId: string, _deviceId: string, _requestId: string) => ({
      requestId: REQUEST_ID,
      state: "unconfirmed",
    }));
    dependencies.localController = { getOperation: collect };
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "create",
        repository_id: "42",
        ref: "main",
        request_id: REQUEST_ID,
        device_id: OTHER_CODESPACE_ID,
      }),
      USER_ID,
      dependencies,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        request_id: REQUEST_ID,
        device_id: OTHER_CODESPACE_ID,
        error: {
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
          provider_failure: {
            kind: "http",
            phase: "request",
            status: 503,
            githubRequestId: "AB12:CD34",
            reason: "Service unavailable",
          },
        },
      },
    });
    const inspected = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "operation",
        request_id: REQUEST_ID,
        device_id: OTHER_CODESPACE_ID,
      }),
      USER_ID,
      dependencies,
    );
    expect(data(inspected)).toEqual({ requestId: REQUEST_ID, state: "unconfirmed" });
    expect(collect).toHaveBeenCalledWith(USER_ID, OTHER_CODESPACE_ID, REQUEST_ID);
    expect(dependencies.resource!.create).toHaveBeenCalledTimes(1);
    expect(dependencies.resource!.startCodespace).not.toHaveBeenCalled();
    expect(JSON.stringify([result, inspected])).not.toContain("private internal diagnosis");
  });
  it("preserves scoped disposal uncertainty from callable stop without claiming provider completion", async () => {
    const dependencies = services();
    let retained = codespace();
    dependencies.resource!.getCodespace = jest.fn(async () => retained);
    dependencies.resource!.stopCodespace = jest.fn(async () => {
      retained = codespace({ state: "stop_pending", desired_state: "stopped" });
      throw Object.assign(new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503), {
        resourceId: CODESPACE_ID,
        deviceId: OTHER_CODESPACE_ID,
        requestId: REQUEST_ID,
        securityRequestId: OPERATION_ID,
        privateDiagnosis: "secret-private-disposal-diagnosis",
      });
    });
    const result = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "stop",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        generation: 3,
      }),
      USER_ID,
      dependencies,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        request_id: REQUEST_ID,
        codespace_id: CODESPACE_ID,
        device_id: OTHER_CODESPACE_ID,
        security_request_id: OPERATION_ID,
        error: {
          code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
          message: "Scoped credential operation outcome is unconfirmed",
          retryable: false,
        },
      },
    });
    expect(dependencies.resource!.stopCodespace).toHaveBeenCalledWith(
      USER_ID,
      CODESPACE_ID,
      REQUEST_ID,
      3,
    );
    expect(dependencies.resource!.getCodespace).not.toHaveBeenCalled();
    expect(retained).toMatchObject({ state: "stop_pending", desired_state: "stopped" });
    expect(JSON.stringify(result)).not.toMatch(/secret-|state.*stopped|settings_url/);
  });
  it("Local discovery exposes live CAS and original pending identities without private routing authority", async () => {
    const deviceId = "00000000-0000-4000-8000-000000000011";
    const local = codespace({
      provider: "local-sandboxes",
      repository_id: `local:${deviceId}:00000000-0000-4000-8000-000000000012`,
      generation: 5,
      pending_request_ids: [REQUEST_ID],
    });
    const dependencies = services({ provider: "local-sandboxes" });
    dependencies.resource!.getCodespace = jest.fn(async () => local);
    dependencies.resource!.listResources = jest.fn(async () => [local]);
    dependencies.resource!.create = jest.fn(async () => local);
    const expected = {
      codespace_id: CODESPACE_ID,
      repository: "owner/repository",
      ref: "feature/current",
      state: "usable",
      provider: "local-sandboxes",
      device_id: deviceId,
      generation: 5,
      pending_request_ids: [REQUEST_ID],
    };
    const fetched = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "get", codespace_id: CODESPACE_ID }),
      USER_ID,
      dependencies,
    );
    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list" }),
      USER_ID,
      dependencies,
    );
    const created = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "create",
        repository_id: local.repository_id,
        ref: "main",
        request_id: OPERATION_ID,
      }),
      USER_ID,
      dependencies,
    );
    expect(data(fetched)).toEqual(expected);
    expect(data(listed)).toEqual({ codespaces: [expected] });
    expect(data(created)).toEqual({ ...expected, request_id: OPERATION_ID });
    expect(JSON.stringify([fetched, listed, created])).not.toMatch(
      /secret-(connection|capability|marker|claim)|authorizationGeneration/,
    );
  });
  it.each(["start", "stop", "delete"] as const)(
    "Local %s keeps caller observed CAS rather than refreshing it before dispatch",
    async (action) => {
      const dependencies = services({ provider: "local-sandboxes" });
      dependencies.resource!.getCodespace = jest.fn(async () => codespace({ generation: 5 }));
      const check = async (generation: number | undefined) => {
        if (generation !== 5)
          throw new CodespaceResourceError("CODESPACE_GENERATION_CONFLICT", "Changed owner CAS");
        return codespace();
      };
      dependencies.resource!.startCodespace = async (_user, _id, _request, generation) =>
        check(generation);
      dependencies.resource!.stopCodespace = async (_user, _id, _request, generation) =>
        check(generation);
      dependencies.resource!.deleteCodespace = async (
        _user: string,
        _id: string,
        generation?: number,
      ) => check(generation);
      const result = await executeCodespaceTool(
        parseCodespaceToolParams({
          action,
          codespace_id: CODESPACE_ID,
          request_id: REQUEST_ID,
          generation: 3,
          ...(action === "delete" ? { confirm_delete: true } : {}),
        }),
        USER_ID,
        dependencies,
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "CODESPACE_GENERATION_CONFLICT" } },
      });
    },
  );
  it("publishes and accepts the same Unicode PR branches as Git", () => {
    const input = {
      action: "pull_request_create",
      codespace_id: CODESPACE_ID,
      request_id: REQUEST_ID,
      head: "feat/игра",
      base: "релиз",
      title: "Игра",
    };
    expect(codespaceSchema.safeParse(input).success).toBe(true);
    expect(parseCodespaceToolParams(input)).toMatchObject({
      action: "pull_request_create",
      request: { head: "feat/игра", base: "релиз" },
    });
    expect(
      parseCodespaceToolParams({
        action: "pull_request_find",
        codespace_id: CODESPACE_ID,
        head: "feat/игра",
        base: "релиз",
      }),
    ).toMatchObject({ action: "pull_request_find", request: { head: "feat/игра", base: "релиз" } });
  });
  it("routes PR submission, original collection and reads to the owner without cloud provider readiness", async () => {
    const saved = {
      number: 7,
      url: "https://github.com/owner/repository/pull/7",
      head: "feature/change",
      base: "main",
      title: "Change",
      body: "",
      draft: false,
    };
    const selected = services({ provider: "local-sandboxes" });
    selected.connection.getStatus = jest.fn(() => {
      throw new Error("Cloud provider readiness must not gate owner actions");
    });
    const dispatch = jest.fn(
      async (
        userId: string,
        id: string,
        request: { method: string; path: string; body?: unknown },
      ) => {
        if (userId !== USER_ID || id !== CODESPACE_ID)
          throw Object.assign(new Error("Owner refused the request"), {
            details: { error: { code: "LOCAL_UNAUTHORIZED" } },
          });
        expect(request.path).toBe("/v1/tools");
        const call = request.body as { action: string };
        const result =
          call.action === "pull_request_find"
            ? { pull_requests: [saved] }
            : { pull_request: saved };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      },
    );
    const dependencies = services({
      select: () => selected,
      workspace: {
        json: dispatch,
        request: async () => {
          throw new Error("Unexpected byte route");
        },
      },
    });
    const created = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_create",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        head: "feature/change",
        base: "main",
        title: "Change",
      }),
      USER_ID,
      dependencies,
    );
    const read = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_get",
        codespace_id: CODESPACE_ID,
        pull_request_number: 7,
      }),
      USER_ID,
      dependencies,
    );
    expect(data(created)).toEqual({
      pull_request: {
        number: 7,
        url: "https://github.com/owner/repository/pull/7",
        head: "feature/change",
        base: "main",
        title: "Change",
        body: "",
        draft: false,
      },
    });
    expect(data(read)).toEqual(data(created));
    const collected = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_create",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
      }),
      USER_ID,
      dependencies,
    );
    expect(data(collected)).toEqual(data(created));
    expect(dispatch).toHaveBeenCalledWith(USER_ID, CODESPACE_ID, {
      method: "POST",
      path: "/v1/tools",
      body: {
        action: "pull_request_create",
        request: { codespace_id: CODESPACE_ID, request_id: REQUEST_ID },
      },
    });
    expect(selected.connection.getStatus).not.toHaveBeenCalled();
    const found = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_find",
        codespace_id: CODESPACE_ID,
        head: "feature/change",
        base: "main",
      }),
      USER_ID,
      dependencies,
    );
    expect(data(found)).toEqual({ pull_requests: [saved] });
    const denied = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "pull_request_get",
        codespace_id: OTHER_CODESPACE_ID,
        pull_request_number: 7,
      }),
      USER_ID,
      dependencies,
    );
    expect(denied).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "LOCAL_UNAUTHORIZED", message: "The workspace refused this request." },
      },
    });
  });
  it.each([
    {
      action: "pull_request_create",
      codespace_id: CODESPACE_ID,
      head: "feature",
      base: "main",
      title: "Change",
      url: "https://api.github.com/user",
    },
    {
      action: "pull_request_get",
      codespace_id: CODESPACE_ID,
      pull_request_number: 7,
      head: "feature",
    },
  ])("refuses mixed and arbitrary GitHub API fields", (input) => {
    expect(() => parseCodespaceToolParams(input)).toThrow(CodespaceRequestInvalidError);
  });
  it.each(["private-token", "x".repeat(10000), `${CODESPACE_ID}\nprivate-source`, 42, null])(
    "omits malformed identifiers from pre-validation logging (%#)",
    (identifier) => {
      expect(
        codespaceToolLogContext({
          action: "exec",
          codespace_id: identifier,
          request_id: identifier,
        }),
      ).toEqual({ inputData: { codespace_action: "exec" }, resourceIds: {} });
    },
  );

  it("logs only opaque codespace/operation identity and never codespace input", () => {
    const projected = codespaceToolLogContext({
      action: "upload",
      codespace_id: CODESPACE_ID,
      request_id: OPERATION_ID,
      path: "private/source.ts",
      query: "secret query",
      text: "secret source",
      argv: ["print-secret"],
      file: {
        file_id: "sediment://file_private",
        download_url: "https://oaiusercontent.com/private-token",
        file_name: "private.txt",
      },
    });

    expect(projected).toEqual({
      inputData: { codespace_action: "upload" },
      resourceIds: { codespaceId: CODESPACE_ID, requestId: OPERATION_ID },
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /secret query|secret source|print-secret|private-token|private\.txt|sediment/,
    );
  });

  it("lists and gets reusable codespace state without internal authority fields", async () => {
    const dependencies = services();
    const ownerView = Object.assign(codespace(), {
      connectionId: "secret-connection",
      operationMarker: "secret-marker",
      providerResourceName: "secret-provider-name",
      externalOwnerId: "secret-owner",
      billableOwnerId: "secret-billing",
      claimId: "secret-claim",
      lastOutcome: "provider-private-diagnostic",
    });
    dependencies.resource!.getCodespace = jest.fn(async () => ownerView);
    dependencies.resource!.listResources = jest.fn(async () => [ownerView]);
    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list" }),
      USER_ID,
      dependencies,
    );
    const fetched = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "get", codespace_id: CODESPACE_ID }),
      USER_ID,
      dependencies,
    );

    const brief = {
      codespace_id: CODESPACE_ID,
      repository: "owner/repository",
      ref: "feature/current",
      state: "usable",
      provider: "github-codespaces",
      generation: 3,
      pending_request_ids: [],
    };
    expect(data(listed)).toEqual({ codespaces: [brief] });
    expect(data(fetched)).toEqual(brief);
    const repositories = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "repositories" }),
      USER_ID,
      dependencies,
    );
    expect(data(repositories)).toEqual({
      repositories: [{ repository_id: "42", name: "owner/repository", private: true }],
    });
    const serialized = JSON.stringify([listed, fetched]);
    for (const secret of [
      "secret-connection",
      "secret-marker",
      "secret-provider-name",
      "secret-owner",
      "secret-billing",
      "secret-claim",
      "provider-private-diagnostic",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("refreshes grants before projecting list status and marks provider fallback as stale", async () => {
    const dependencies = services();
    const getStatus = jest
      .fn<CodespaceToolServices["connection"]["getStatus"]>()
      .mockReturnValueOnce({
        state: "installation_required" as const,
        reason: "INSTALLATION_REQUIRED" as const,
        settingsUrl: "https://moira.example/settings",
        installationUrl: "https://github.test/install",
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      })
      .mockReturnValue({
        state: "connected" as const,
        reason: null,
        settingsUrl: "https://moira.example/settings",
        installationUrl: null,
        account: null,
        installations: [],
        repositories: [],
        canConnect: false,
        canDisconnect: true,
      });
    dependencies.connection = {
      getStatus,
      refreshGrants: jest.fn(async () => ({ refreshed: false, stale: true })),
    };

    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list", refresh: true }),
      USER_ID,
      dependencies,
    );
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID, { force: true });
    expect(data(listed)).toMatchObject({
      warning: "The provider could not refresh this view; the last confirmed entries are shown.",
      codespaces: [expect.objectContaining({ codespace_id: CODESPACE_ID })],
    });
    expect(dependencies.resource!.refreshProviderState).not.toHaveBeenCalled();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("refreshes managed provider state when list requests a fresh GitHub view", async () => {
    const dependencies = services();
    const listed = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "list", refresh: true }),
      USER_ID,
      dependencies,
    );
    expect(data(listed)).toHaveProperty("codespaces");
    expect(data(listed)).not.toHaveProperty("warning");
    expect(dependencies.resource!.refreshProviderState).toHaveBeenCalledWith(USER_ID, {
      authorizationFresh: true,
    });
  });

  it("returns provider-owned setup instructions and exact links for the current missing condition", async () => {
    const dependencies = services();
    dependencies.resource!.setupSituation = jest.fn(
      async (_userId: string, _repositoryId?: string): Promise<CodespaceGuidanceSituation> =>
        "repository_not_approved",
    );
    const helped = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "setup_help", repository_id: "missing-repository" }),
      USER_ID,
      dependencies,
    );

    expect(dependencies.resource!.setupSituation).toHaveBeenCalledWith(
      USER_ID,
      "missing-repository",
    );
    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID);
    expect(data(helped)).toEqual({
      situation: "repository_not_approved",
      provider: "github-codespaces",
      reason: null,
      instruction: "do this for repository_not_approved",
      repositories_stale: false,
      links: [
        { id: "settings", url: "https://moira.example/settings", label: "Moira settings" },
        { id: "install", url: "https://github.test/install", label: "Install the app" },
        {
          id: "create_repository",
          url: "https://github.test/new",
          label: "New repository",
        },
      ],
    });
  });

  it("keeps provider guidance available when runtime codespace services are not configured", async () => {
    const dependencies = services({ resource: null });
    const helped = await executeCodespaceTool(
      parseCodespaceToolParams({ action: "setup_help" }),
      USER_ID,
      dependencies,
    );
    expect(data(helped)).toMatchObject({
      situation: "not_configured",
      provider: "github-codespaces",
      instruction: "do this for not_configured",
      links: expect.arrayContaining([
        expect.objectContaining({ id: "settings", url: "https://moira.example/settings" }),
        expect.objectContaining({ id: "create_repository", url: "https://github.test/new" }),
      ]),
    });
  });

  it("returns the owner creation summary and distinguishes stop from confirmed delete", async () => {
    const dependencies = services();
    const created = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "create",
        repository_id: "42",
        ref: "main",
        request_id: REQUEST_ID,
      }),
      USER_ID,
      dependencies,
    );
    const stopped = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "stop",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        generation: 3,
      }),
      USER_ID,
      dependencies,
    );
    const deleted = await executeCodespaceTool(
      parseCodespaceToolParams({
        action: "delete",
        codespace_id: CODESPACE_ID,
        confirm_delete: true,
        request_id: REQUEST_ID,
        generation: 3,
      }),
      USER_ID,
      dependencies,
    );

    expect(dependencies.connection.refreshGrants).toHaveBeenCalledWith(USER_ID);
    expect(data(created)).toMatchObject({ codespace_id: CODESPACE_ID, state: "usable" });
    expect(data(stopped)).toMatchObject({ codespace_id: CODESPACE_ID, state: "stopped" });
    expect(data(deleted)).toMatchObject({ codespace_id: CODESPACE_ID, state: "deleted" });
    expect(dependencies.resource?.deleteCodespace).toHaveBeenCalledWith(USER_ID, CODESPACE_ID, 3, {
      requestId: REQUEST_ID,
    });
  });

  it.each([
    [422, "retention_period_minutes exceeds the maximum for this owner"],
    [402, "Codespaces usage not allowed by the configured budget"],
  ])(
    "hands the caller the confirmed HTTP%s creation refusal and original identity",
    async (status, reason) => {
      // The end of the path #219 is about: the provider named a constraint, the client redacted and
      // bounded it, the service raised it as the refusal's detail, and the agent that asked for the
      // codespace can read it here instead of being told only that creation was rejected.
      const base = services();
      const refusing = services({
        resource: {
          ...base.resource!,
          create: jest.fn(async () => {
            const error = new CodespaceResourceError(
              "CODESPACE_CREATE_REJECTED",
              "Codespace creation was rejected",
              reason,
            );
            error.requestId = REQUEST_ID;
            error.deviceId = OTHER_CODESPACE_ID;
            error.providerFailure = {
              kind: "http",
              phase: "request",
              status,
              githubRequestId: "AB12:CD34",
              reason,
            };
            throw error;
          }),
        },
      });

      const refused = await executeCodespaceTool(
        parseCodespaceToolParams({
          action: "create",
          repository_id: "42",
          ref: "main",
          request_id: REQUEST_ID,
        }),
        USER_ID,
        refusing,
      );

      const error = (
        data(refused) as { error: { code: string; message: string; retryable: boolean } }
      ).error;
      expect(error.code).toBe("CODESPACE_CREATE_REJECTED");
      expect(error.message).toContain(reason);
      expect(data(refused)).toMatchObject({
        request_id: REQUEST_ID,
        device_id: OTHER_CODESPACE_ID,
        error: { provider_failure: { kind: "http", status, reason } },
      });
      // A refusal the provider will repeat is not something to retry.
      expect(error.retryable).toBe(false);
    },
  );

  it("requires a stable identity for file mutations and rejects mixed command fields on inspection", () => {
    expect(() =>
      parseCodespaceToolParams({
        action: "write",
        codespace_id: CODESPACE_ID,
        path: "source.ts",
        text: "private",
        expected: { exists: false },
      }),
    ).toThrow(CodespaceRequestInvalidError);
    expect(() =>
      parseCodespaceToolParams({
        action: "exec",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        env: { PRIVATE: "secret" },
      }),
    ).toThrow(CodespaceRequestInvalidError);
    expect(
      codespaceSchema.safeParse({
        action: "exec",
        codespace_id: CODESPACE_ID,
        request_id: REQUEST_ID,
        argv: ["printf", ""],
        timeout_seconds: 5 * 24 * 3600,
        max_stdout_bytes: 16 * 1024 * 1024,
      }).success,
    ).toBe(true);
  });
});
